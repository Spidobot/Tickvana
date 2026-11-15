import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "./db/schema.js";
import { startTestApp, type TestApp } from "./testing.js";

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const MIN = 60_000;

describeEachDb<TrackDb>("notifications", (t) => {
  let app: TestApp;
  let task: string;
  let key: string;
  const roles: Record<string, string> = {};

  /** Runs the event subscribers (the test app has no background worker). */
  const deliver = async () => {
    while ((await app.running.queue.runDue()) > 0);
  };
  const inbox = async (as: string, query = "") =>
    (await app.call("GET", `/core/notifications${query}`, as)).json();
  const texts = async (as: string) =>
    (await inbox(as)).items.map((i: { text: string }) => i.text);
  const mails = async () =>
    (
      await app.db
        .selectFrom("core_job")
        .select("payload_json")
        .where("type", "=", "mail.send")
        .orderBy("id")
        .execute()
    ).map(
      (j) =>
        JSON.parse(j.payload_json) as {
          to: string;
          subject: string;
          body: string[];
          action: { url: string };
        },
    );
  const member = (
    role: string,
    user: string,
    method: "PUT" | "DELETE" = "PUT",
  ) =>
    app.call(method, "/projects/WIT/members", "root", {
      roleId: roles[role],
      principalType: "user",
      principalId: app.ids[user],
    });

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["mira", "jonas", "gast"]) await app.addUser(name);
    await app.db
      .updateTable("core_user")
      .set({ locale: "en" })
      .where("id", "=", app.ids.gast!)
      .execute();
    await app.call("POST", "/projects", "root", {
      key: "WIT",
      name: "Werkstatt-IT",
    });
    for (const role of await app.db
      .selectFrom("track_project_role")
      .selectAll()
      .execute())
      roles[role.name] = role.id;
    await member("Members", "mira");
    await member("Members", "jonas");
    await member("Viewers", "gast");
    task = (
      await app.db
        .selectFrom("track_issue_type")
        .select("id")
        .where("name", "=", "Task")
        .executeTakeFirstOrThrow()
    ).id;
    await deliver();
  });
  afterAll(() => app?.close());

  it("tells assignee, reporter and watchers, but never the person who acted", async () => {
    const made = await app.call("POST", "/issues", "mira", {
      projectKey: "WIT",
      type: task,
      fields: { summary: "Drucker druckt versetzt", assignee: app.ids.jonas },
    });
    key = made.json().key;
    await deliver();
    // Watching starts now: what happened before is not sent after the fact.
    await app.call("PUT", `/issues/${key}/watchers/${app.ids.gast}`, "gast");
    expect(await texts("jonas")).toEqual(["mira hat das Ticket angelegt"]);
    expect(await texts("mira")).toEqual([]);
    expect(await texts("gast")).toEqual([]);

    const high = (
      await app.db
        .selectFrom("track_priority")
        .select("id")
        .where("name", "=", "High")
        .executeTakeFirstOrThrow()
    ).id;
    await app.call("PATCH", `/issues/${key}`, "jonas", {
      fields: { priority: high, dueDate: "2026-11-27" },
    });
    const start = (await app.call("GET", `/issues/${key}/transitions`, "jonas"))
      .json()
      .find((x: { name: string }) => x.name === "Start").id;
    await app.call("POST", `/issues/${key}/transitions`, "jonas", {
      transitionId: start,
    });
    await app.call("POST", `/issues/${key}/comments`, "jonas", {
      body: doc("Rolle gewechselt"),
    });
    await deliver();

    expect(await texts("jonas")).toEqual(["mira hat das Ticket angelegt"]);
    expect(await texts("mira")).toEqual([
      "jonas hat kommentiert",
      "jonas: To Do → In Progress",
      "jonas hat geändert: Priority, Due date",
    ]);
    // gast reads English.
    expect(await texts("gast")).toEqual([
      "jonas commented",
      "jonas: To Do → In Progress",
      "jonas changed: Priority, Due date",
    ]);
    const first = (await inbox("mira")).items[0];
    expect(first).toMatchObject({
      title: `${key} Drucker druckt versetzt`,
      url: `/tickvana/issues/${key}`,
      actorId: app.ids.jonas,
      read: false,
    });
  });

  it("keeps internal comments from people who may not read them", async () => {
    await app.call("POST", `/issues/${key}/comments`, "jonas", {
      body: doc("Lieferant ist insolvent"),
      visibility: "internal",
    });
    await deliver();
    expect((await texts("mira"))[0]).toBe("jonas hat kommentiert");
    expect(await texts("mira")).toHaveLength(4);
    // The viewer role holds no comment.internal.
    expect(await texts("gast")).toHaveLength(3);
  });

  it("counts unread and marks read", async () => {
    const before = await inbox("mira");
    expect(before.unreadCount).toBe(4);
    await app.call("POST", "/core/notifications/read", "mira", {
      ids: [before.items[0].id],
    });
    const after = await inbox("mira", "?unread=true");
    expect(after.unreadCount).toBe(3);
    expect(after.items).toHaveLength(3);
    // Other people's notifications cannot be marked.
    await app.call("POST", "/core/notifications/read", "gast", {
      ids: [before.items[1].id],
    });
    expect((await inbox("mira")).unreadCount).toBe(3);
    expect(
      (await app.call("GET", "/core/notifications", null)).statusCode,
    ).toBe(401);
  });

  it("mails one digest per person after things went quiet, skipping what was read", async () => {
    const now = Date.now();
    expect(await app.running.notifier.sendDigests(new Date(now))).toBe(0);
    expect(await mails()).toEqual([]);

    expect(
      await app.running.notifier.sendDigests(new Date(now + 3 * MIN)),
    ).toBe(3);
    const sent = await mails();
    const to = (name: string) =>
      sent.find((m) => m.to === `${name}@example.org`)!;

    // One ticket, so its title is the subject and the lines are the changes.
    expect(to("mira").subject).toBe(`${key} Drucker druckt versetzt`);
    expect(to("mira").body.slice(0, 3)).toEqual([
      "jonas hat geändert: Priority, Due date",
      "jonas: To Do → In Progress",
      "jonas hat kommentiert",
    ]);
    expect(to("mira").body.at(-1)).toMatch(
      /^Diese Mails abbestellen: http:\/\/localhost\/tickvana\/api\/core\/notifications\/unsubscribe\?token=/,
    );
    expect(to("mira").action.url).toBe(
      `http://localhost/tickvana/issues/${key}`,
    );
    expect(to("jonas").body[0]).toBe("mira hat das Ticket angelegt");
    expect(to("gast").body.at(-1)).toMatch(/^Stop these mails: /);

    // Nothing is mailed twice.
    expect(
      await app.running.notifier.sendDigests(new Date(now + 10 * MIN)),
    ).toBe(0);
    expect(await mails()).toHaveLength(3);
  });

  it("summarises several tickets, and stops mailing after unsubscribe", async () => {
    const other = (
      await app.call("POST", "/issues", "jonas", {
        projectKey: "WIT",
        type: task,
        fields: { summary: "Scanner", assignee: app.ids.mira },
      })
    ).json();
    await app.call("POST", `/issues/${key}/comments`, "jonas", {
      body: doc("Erledigt?"),
    });
    await app.call(
      "PUT",
      `/issues/${other.key}/watchers/${app.ids.gast}`,
      "gast",
    );
    await app.call("POST", `/issues/${other.key}/comments`, "jonas", {
      body: doc("Bitte prüfen"),
    });
    await deliver();

    // gast follows the link in the earlier mail.
    const link = (await mails())
      .find((m) => m.to === "gast@example.org")!
      .body.at(-1)!
      .split(": ")
      .slice(1)
      .join(": ");
    const path = new URL(link).pathname + new URL(link).search;
    expect(
      (
        await app.running.server.inject(
          path.replace(/token=.*/, "token=forged.x"),
        )
      ).statusCode,
    ).toBe(400);
    expect((await app.running.server.inject(path)).statusCode).toBe(200);
    expect(
      (await app.call("GET", "/core/notifications/preferences", "gast")).json(),
    ).toEqual({ mail: false });

    const count = (await mails()).length;
    expect(
      await app.running.notifier.sendDigests(new Date(Date.now() + 3 * MIN)),
    ).toBe(1);
    const latest = (await mails()).slice(count);
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({
      to: "mira@example.org",
      subject: "3 Neuigkeiten",
    });
    expect(latest[0]!.body[0]).toBe(
      "WIT-2 Scanner: jonas hat das Ticket angelegt",
    );
    // gast still sees everything in the app, and can switch mail back on.
    expect((await inbox("gast")).unreadCount).toBeGreaterThan(0);
    expect(
      (
        await app.call("PUT", "/core/notifications/preferences", "gast", {
          mail: true,
        })
      ).json(),
    ).toEqual({ mail: true });
  });

  it("hides notifications once access is gone", async () => {
    expect((await inbox("gast")).items.length).toBeGreaterThan(0);
    await member("Viewers", "gast", "DELETE");
    expect((await inbox("gast")).items).toEqual([]);
    await member("Viewers", "gast");
    expect((await inbox("gast")).items.length).toBeGreaterThan(0);
  });
});
