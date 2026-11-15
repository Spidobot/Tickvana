import { beforeAll, beforeEach, expect, it } from "vitest";
import { createDb } from "../db/index.js";
import { migrateCore } from "../migrations/index.js";
import type { CoreDb } from "../schema.js";
import { describeEachDb } from "../testing/index.js";
import { createQueue, type StoredEvent } from "./index.js";

describeEachDb<CoreDb>("events and jobs", (t) => {
  beforeAll(() => migrateCore(t));
  beforeEach(async () => {
    await t.db.deleteFrom("core_job").execute();
    await t.db.deleteFrom("core_event").execute();
  });

  const event = (type: string, payload?: unknown) => ({
    type,
    actorId: null,
    entityType: "issue",
    entityId: "00000000-0000-7000-8000-000000000001",
    payload,
  });
  const jobs = () =>
    t.db.selectFrom("core_job").selectAll().orderBy("id").execute();

  it("delivers events to matching subscribers only", async () => {
    const q = createQueue(t.db);
    const got: Record<string, StoredEvent[]> = {
      exact: [],
      prefix: [],
      all: [],
    };
    q.on("exact", ["issue.created"], async (e) => void got.exact!.push(e));
    q.on("prefix", ["issue.*"], async (e) => void got.prefix!.push(e));
    q.on("all", ["*"], async (e) => void got.all!.push(e));

    const id = await q.emit(
      t.db,
      event("issue.created", { summary: "Tür klemmt" }),
    );
    await q.emit(t.db, event("issue.updated"));
    await q.emit(t.db, event("page.created"));
    while ((await q.runDue()) > 0);

    expect(got.exact!.map((e) => e.type)).toEqual(["issue.created"]);
    expect(got.prefix!.map((e) => e.type).sort()).toEqual([
      "issue.created",
      "issue.updated",
    ]);
    expect(got.all).toHaveLength(3);
    expect(got.exact![0]).toMatchObject({
      id,
      entityType: "issue",
      payload: { summary: "Tür klemmt" },
    });
    expect((await jobs()).every((j) => j.state === "done")).toBe(true);
  });

  it("writes nothing when the surrounding transaction rolls back", async () => {
    const q = createQueue(t.db);
    q.on("sub", ["*"], async () => {});
    await expect(
      t.db.transaction().execute(async (trx) => {
        await q.emit(trx, event("issue.created"));
        await q.enqueue(trx, "mail", {});
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await t.db.selectFrom("core_event").selectAll().execute()).toEqual(
      [],
    );
    expect(await jobs()).toEqual([]);
  });

  it("runs 1000 jobs exactly once across two workers", async () => {
    const other = createDb<CoreDb>(t.url);
    const runs = new Map<number, number>();
    const workerErrors: unknown[] = [];
    const workers = [t.db, other.db].map((db, i) => {
      const q = createQueue(db, {
        workerId: `w${i}`,
        pollMs: 5,
        onError: (e) => workerErrors.push(e),
      });
      q.job("count", async (payload) => {
        const n = (payload as { n: number }).n;
        runs.set(n, (runs.get(n) ?? 0) + 1);
      });
      return q;
    });
    try {
      const now = new Date();
      await t.db
        .insertInto("core_job")
        .values(
          Array.from({ length: 1000 }, (_, n) => ({
            id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
            type: "count",
            payload_json: JSON.stringify({ n }),
            run_at: now,
            state: "pending" as const,
            attempts: 0,
            locked_by: null,
            locked_at: null,
            last_error: null,
            created_at: now,
          })),
        )
        .execute();

      await Promise.all(workers.map((w) => w.start()));
      await expect
        .poll(
          async () => (await jobs()).filter((j) => j.state === "done").length,
          { timeout: 150_000, interval: 200 },
        )
        .toBe(1000);
    } finally {
      await Promise.all(workers.map((w) => w.stop()));
      await other.db.destroy();
    }
    // Deadlock victims may be reported, but must never cause a second run.
    if (workerErrors.length) {
      console.warn(
        `queue test: ${workerErrors.length} recovered errors`,
        String(workerErrors[0]),
      );
    }
    expect(runs.size).toBe(1000);
    expect([...runs.values()].every((count) => count === 1)).toBe(true);
  }, 180_000);

  it("retries with backoff and gives up after the last attempt", async () => {
    const errors: unknown[] = [];
    const q = createQueue(t.db, {
      maxAttempts: 3,
      backoffMs: (n) => n * 60_000,
      onError: (e) => errors.push(e),
    });
    let calls = 0;
    q.job("flaky", async () => {
      if (++calls < 3) throw new Error(`boom ${calls}`);
    });
    q.job("broken", async () => {
      throw new Error("always");
    });
    await q.enqueue(t.db, "flaky", {});
    await q.enqueue(t.db, "broken", {});

    await q.runDue();
    let [flaky] = await jobs();
    expect(flaky).toMatchObject({ state: "pending", attempts: 1 });
    expect(flaky!.last_error).toContain("boom 1");
    expect(flaky!.run_at.getTime()).toBeGreaterThan(Date.now() + 50_000);

    // Not due yet: nothing runs.
    expect(await q.runDue()).toBe(0);

    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    await q.runDue(later(2));
    await q.runDue(later(10));
    const after = await jobs();
    flaky = after[0];
    const broken = after[1];
    expect(flaky).toMatchObject({ state: "done", attempts: 2 });
    expect(broken).toMatchObject({ state: "failed", attempts: 3 });
    expect(broken!.last_error).toContain("always");
    expect(errors).toHaveLength(5);

    expect(await q.runDue(later(999))).toBe(0);
  });

  it("recovers jobs of a dead worker and leaves foreign job types alone", async () => {
    const q = createQueue(t.db, { staleLockMs: 60_000 });
    let ran = 0;
    q.job("mine", async () => void ran++);
    const stuck = await q.enqueue(t.db, "mine", {});
    await q.enqueue(t.db, "pages-only", {});
    await t.db
      .updateTable("core_job")
      .set({
        state: "running",
        locked_by: "dead",
        locked_at: new Date(Date.now() - 30_000),
      })
      .where("id", "=", stuck)
      .execute();

    expect(await q.runDue()).toBe(0); // lock still fresh
    await t.db
      .updateTable("core_job")
      .set({ locked_at: new Date(Date.now() - 120_000) })
      .where("id", "=", stuck)
      .execute();
    expect(await q.runDue()).toBe(1);
    expect(ran).toBe(1);
    expect((await jobs()).map((j) => j.state).sort()).toEqual([
      "done",
      "pending",
    ]);
  });

  it("keeps one row per recurring job and re-arms it, even after errors", async () => {
    let ticks = 0;
    const make = () => {
      const q = createQueue(t.db, { pollMs: 5 });
      q.every("cleanup", 60_000, async () => {
        if (++ticks === 2) throw new Error("hiccup");
      });
      return q;
    };
    const a = make();
    const b = make();
    await Promise.all([a.start(), b.start()]);
    await expect.poll(() => ticks, { timeout: 10_000 }).toBe(1);
    await Promise.all([a.stop(), b.stop()]);

    let rows = await jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "every:cleanup", state: "pending" });
    expect(rows[0]!.run_at.getTime()).toBeGreaterThan(Date.now() + 50_000);

    const later = new Date(Date.now() + 61_000);
    expect(await a.runDue(later)).toBe(1); // throws inside, must stay alive
    rows = await jobs();
    expect(rows[0]).toMatchObject({ state: "pending", attempts: 0 });
    expect(rows[0]!.last_error).toContain("hiccup");
    expect(ticks).toBe(2);
  });
});
