import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { isPrivateAddress, signature } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "./db/schema.js";
import { startTestApp, type TestApp } from "./testing.js";

it("recognises private addresses", () => {
  for (const a of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.43",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ]) {
    expect(isPrivateAddress(a), a).toBe(true);
  }
  for (const a of ["1.1.1.1", "172.32.0.1", "8.8.8.8", "2606:4700:4700::1111"])
    expect(isPrivateAddress(a), a).toBe(false);
});

describeEachDb<TrackDb>("webhooks", (t) => {
  let app: TestApp;
  let target: ReturnType<typeof createServer>;
  let url: string;
  let answer = 200;
  const received: { headers: IncomingMessage["headers"]; body: string }[] = [];

  /** Runs event subscribers and delivery jobs, retries included. */
  const drain = async () => {
    for (let round = 0; round < 10; round++) {
      while (
        (await app.running.queue.runDue(
          new Date(Date.now() + round * 3_600_000),
        )) > 0
      );
    }
  };

  beforeAll(async () => {
    target = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.statusCode = answer;
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve),
    );
    url = `http://127.0.0.1:${(target.address() as AddressInfo).port}/hook`;
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    await app.addUser("mira");
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    target?.close();
  });

  let hook: { id: string; secret: string };

  it("lets only system administrators manage webhooks, showing the secret once", async () => {
    const body = { name: "CI", url, events: ["issue.*", "project.created"] };
    expect(
      (await app.call("POST", "/core/webhooks", "mira", body)).statusCode,
    ).toBe(403);
    expect(
      (
        await app.call("POST", "/core/webhooks", "root", {
          ...body,
          url: "ftp://example.org",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("POST", "/core/webhooks", "root", {
          ...body,
          events: ["DROP TABLE"],
        })
      ).statusCode,
    ).toBe(400);
    const made = await app.call("POST", "/core/webhooks", "root", body);
    expect(made.statusCode).toBe(201);
    hook = made.json();
    expect(hook.secret.length).toBeGreaterThan(20);
    const listed = (await app.call("GET", "/core/webhooks", "root")).json();
    expect(listed.webhooks[0]).toMatchObject({
      name: "CI",
      url,
      events: ["issue.*", "project.created"],
      active: true,
    });
    expect(JSON.stringify(listed)).not.toContain(hook.secret);
  });

  it("refuses private targets until an admin allows them", async () => {
    await app.call("POST", "/projects", "root", {
      key: "WIT",
      name: "Werkstatt-IT",
    });
    await drain();
    expect(received).toHaveLength(0);
    const log = (
      await app.call("GET", `/core/webhooks/${hook.id}/deliveries`, "root")
    ).json();
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].error).toMatch(/private network/);
    expect(
      (await app.call("POST", `/core/webhooks/${hook.id}/test`, "root")).json()
        .error,
    ).toMatch(/private network/);
  });

  it("delivers signed events that match the filter", async () => {
    await app.call("PUT", "/core/webhooks/settings", "root", {
      allowPrivateTargets: true,
    });
    await app.call("POST", "/projects", "root", { key: "LAG", name: "Lager" });
    const task = (
      await app.db
        .selectFrom("track_issue_type")
        .select("id")
        .where("name", "=", "Task")
        .executeTakeFirstOrThrow()
    ).id;
    await app.call("POST", "/issues", "root", {
      projectKey: "LAG",
      type: task,
      fields: { summary: "Regal" },
    });
    await app.call("POST", "/core/groups", "root", { name: "nicht im Filter" });
    await drain();

    const types = received.map((r) => r.headers["x-webhook-event"]);
    expect(types).toContain("project.created");
    expect(types).toContain("issue.created");
    expect(types).not.toContain("group.created");
    const delivery = received.find(
      (r) => r.headers["x-webhook-event"] === "issue.created",
    )!;
    const body = JSON.parse(delivery.body);
    expect(body).toMatchObject({
      type: "issue.created",
      entityType: "issue",
      payload: { key: "LAG-1" },
    });
    // The receiver can check where it came from.
    const timestamp = delivery.headers["x-webhook-timestamp"] as string;
    expect(delivery.headers["x-webhook-signature"]).toBe(
      signature(hook.secret, timestamp, delivery.body),
    );
    expect(delivery.headers["x-webhook-signature"]).not.toBe(
      signature("wrong", timestamp, delivery.body),
    );
  });

  it("retries failures and logs every attempt", async () => {
    received.length = 0;
    answer = 500;
    await app.call("POST", "/projects", "root", { key: "FEH", name: "Fehler" });
    await drain();
    // Five attempts, then the job gives up.
    expect(
      received.filter(
        (r) => r.headers["x-webhook-event"] === "project.created",
      ),
    ).toHaveLength(5);
    const log = (
      await app.call("GET", `/core/webhooks/${hook.id}/deliveries`, "root")
    )
      .json()
      .filter(
        (d: { eventType: string; statusCode: number }) => d.statusCode === 500,
      );
    expect(log.map((d: { attempt: number }) => d.attempt).sort()).toEqual([
      1, 2, 3, 4, 5,
    ]);
    answer = 200;
    const test = (
      await app.call("POST", `/core/webhooks/${hook.id}/test`, "root")
    ).json();
    expect(test).toEqual({ statusCode: 200, error: null });
  });

  it("stops delivering when switched off or deleted", async () => {
    received.length = 0;
    await app.call("PATCH", `/core/webhooks/${hook.id}`, "root", {
      active: false,
    });
    await app.call("POST", "/projects", "root", { key: "AUS", name: "Aus" });
    await drain();
    expect(received).toHaveLength(0);
    expect(
      (await app.call("DELETE", `/core/webhooks/${hook.id}`, "root"))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.call("GET", "/core/webhooks", "root")).json().webhooks,
    ).toEqual([]);
  });
});
