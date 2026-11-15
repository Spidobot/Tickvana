import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "./db/schema.js";
import { startTestApp, type TestApp } from "./testing.js";

describeEachDb<TrackDb>("approvals", (t) => {
  let app: TestApp;
  const status: Record<string, string> = {};
  let key: string;

  const drain = async () => {
    while ((await app.running.queue.runDue()) > 0);
  };
  const transition = async (to: string, as = "mira") => {
    const tr = (await app.call("GET", `/issues/${key}/transitions`, as))
      .json()
      .find((x: { toStatusId: string }) => x.toStatusId === status[to]);
    return app.call("POST", `/issues/${key}/transitions`, as, {
      transitionId: tr.id,
    });
  };

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["mira", "chef"]) await app.addUser(name);
    await app.call("POST", "/projects", "root", { key: "IT", name: "IT" });
    const roles = (await app.call("GET", "/admin/roles", "root")).json();
    for (const user of ["mira", "chef"])
      await app.call("PUT", "/projects/IT/members", "root", {
        roleId: roles.find((r: { name: string }) => r.name === "Members").id,
        principalType: "user",
        principalId: app.ids[user],
      });
    for (const s of (await app.call("GET", "/meta", "root")).json().statuses)
      status[s.name] = s.id;
    // "Start" asks the assignee for approval, "Done" needs it.
    const wf = (await app.call("GET", "/workflows", "root")).json()[0].id;
    const draft = (
      await app.call("GET", `/workflows/${wf}/draft`, "root")
    ).json();
    draft.transitions = draft.transitions.map(
      (x: { toStatusId: string; rules: Record<string, unknown[]> }) =>
        x.toStatusId === status["In Progress"]
          ? {
              ...x,
              rules: {
                ...x.rules,
                postFunctions: [{ fn: "requestApproval", field: "assignee" }],
              },
            }
          : x.toStatusId === status.Done
            ? { ...x, rules: { ...x.rules, validators: [{ fn: "approved" }] } }
            : x,
    );
    const { name, statuses, transitions } = draft;
    expect(
      (
        await app.call("PUT", `/workflows/${wf}/draft`, "root", {
          name,
          statuses,
          transitions,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.call("POST", `/workflows/${wf}/publish`, "root", {}))
        .statusCode,
    ).toBe(200);
    const task = (await app.call("GET", "/projects/IT", "root"))
      .json()
      .issueTypes.find((x: { name: string }) => x.name === "Task").id;
    key = (
      await app.call("POST", "/issues", "mira", {
        projectKey: "IT",
        type: task,
        fields: { summary: "Neuer Laptop", assignee: app.ids.chef },
      })
    ).json().key;
  }, 180_000);
  afterAll(() => app?.close());

  it("asks the people in the field and blocks the step until they agree", async () => {
    expect((await transition("Done")).json().error.message).toMatch(
      /not been requested/,
    );
    expect((await transition("In Progress")).statusCode).toBe(200);
    await drain();
    const [approval] = (
      await app.call("GET", `/issues/${key}/approvals`, "mira")
    ).json();
    expect(approval).toMatchObject({
      approverId: app.ids.chef,
      decision: null,
    });
    expect((await transition("Done")).json().error.message).toMatch(
      /Waiting for approval/,
    );
    expect((await app.call("GET", "/portal/approvals", "chef")).json()).toEqual(
      [{ id: approval.id, key, summary: "Neuer Laptop" }],
    );
    // Only the approver decides.
    expect(
      (
        await app.call("POST", `/approvals/${approval.id}/decision`, "mira", {
          decision: "approved",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.call("POST", `/approvals/${approval.id}/decision`, "chef", {
          decision: "approved",
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.call("POST", `/approvals/${approval.id}/decision`, "chef", {
          decision: "declined",
        })
      ).statusCode,
    ).toBe(409);
    expect((await transition("Done")).statusCode).toBe(200);
  });

  it("takes the decision from the signed link in the mail", async () => {
    await transition("To Do");
    await transition("In Progress");
    await drain();
    const mails = await app.db
      .selectFrom("core_job")
      .select("payload_json")
      .where("type", "=", "mail.send")
      .execute();
    const last = JSON.parse(mails.at(-1)!.payload_json);
    expect(last.subject).toContain(key);
    const approve = new URL(last.action.url);
    const path = approve.pathname.replace("/tickvana/api", "") + approve.search;
    // A changed decision with the same signature is refused.
    expect(
      (
        await app.call(
          "GET",
          path.replace("decision=approved", "decision=declined"),
          null,
        )
      ).statusCode,
    ).toBe(403);
    const res = await app.call("GET", path, null);
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toContain(`/portal/requests/${key}`);
    const [approval] = (
      await app.call("GET", `/issues/${key}/approvals`, "mira")
    ).json();
    expect(approval.decision).toBe("approved");
  });
});
