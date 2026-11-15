import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";
import { CONDITIONS, POST_FUNCTIONS, VALIDATORS } from "../workflow.js";
import { RULE_PARAMS } from "./workflow-editor.js";

it("describes the parameters of every workflow rule", () => {
  for (const registry of [CONDITIONS, VALIDATORS, POST_FUNCTIONS])
    for (const fn of Object.keys(registry))
      expect(RULE_PARAMS, fn).toHaveProperty(fn);
});

describeEachDb<TrackDb>("workflow editor", (t) => {
  let app: TestApp;
  let workflowId: string;
  const status: Record<string, string> = {};

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    await app.addUser("mira");
    await app.call("POST", "/projects", "root", { key: "WIT", name: "WIT" });
    for (const s of await app.db
      .selectFrom("track_status")
      .selectAll()
      .execute())
      status[s.name] = s.id;
    workflowId = (await app.call("GET", "/workflows", "root")).json()[0].id;
  }, 180_000);
  afterAll(() => app?.close());

  it("starts a draft from the live workflow", async () => {
    expect(
      (await app.call("GET", `/workflows/${workflowId}/draft`, "mira"))
        .statusCode,
    ).toBe(403);
    const draft = (
      await app.call("GET", `/workflows/${workflowId}/draft`, "root")
    ).json();
    expect(draft.saved).toBe(false);
    expect(draft.statuses).toHaveLength(3);
    expect(draft.problems).toEqual([]);
    expect(draft.displaced).toEqual([]);
  });

  it("publishes a draft and moves tickets out of dropped statuses", async () => {
    const task = (
      await app.db
        .selectFrom("track_issue_type")
        .select("id")
        .where("name", "=", "Task")
        .executeTakeFirstOrThrow()
    ).id;
    const made = (
      await app.call("POST", "/issues", "root", {
        projectKey: "WIT",
        type: task,
        fields: { summary: "Läuft" },
      })
    ).json();
    const start = (
      await app.call("GET", `/issues/${made.key}/transitions`, "root")
    )
      .json()
      .find(
        (x: { toStatusId: string }) => x.toStatusId === status["In Progress"],
      );
    await app.call("POST", `/issues/${made.key}/transitions`, "root", {
      transitionId: start.id,
    });

    const live = (
      await app.call("GET", `/workflows/${workflowId}/draft`, "root")
    ).json();
    const keep = live.transitions.find(
      (x: { toStatusId: string }) => x.toStatusId === status.Done,
    );
    // Drop "In Progress"; tickets in it must go somewhere.
    const draft = {
      name: "Einfach",
      statuses: live.statuses.filter(
        (s: { statusId: string }) => s.statusId !== status["In Progress"],
      ),
      transitions: [
        { ...keep, fromStatusId: status["To Do"] },
        {
          name: "Wieder öffnen",
          fromStatusId: status.Done,
          toStatusId: status["To Do"],
          rules: { postFunctions: [{ fn: "clearResolution" }] },
        },
      ],
    };
    expect(
      (
        await app.call("PUT", `/workflows/${workflowId}/draft`, "root", {
          ...draft,
          transitions: [
            { ...draft.transitions[1], rules: { conditions: [{ fn: "rm" }] } },
          ],
        })
      ).statusCode,
    ).toBe(400);
    const saved = (
      await app.call("PUT", `/workflows/${workflowId}/draft`, "root", draft)
    ).json();
    expect(saved.saved).toBe(true);
    expect(saved.displaced).toEqual([
      { statusId: status["In Progress"], tickets: 1 },
    ]);
    // The live workflow is untouched until publishing.
    expect(
      (await app.call("GET", `/workflows/${workflowId}`, "root")).json()
        .statuses,
    ).toHaveLength(3);

    expect(
      (await app.call("POST", `/workflows/${workflowId}/publish`, "root", {}))
        .statusCode,
    ).toBe(400);
    const published = await app.call(
      "POST",
      `/workflows/${workflowId}/publish`,
      "root",
      { mapping: { [status["In Progress"]!]: status["To Do"] } },
    );
    expect(published.json()).toEqual({ moved: 1 });

    const after = (
      await app.call("GET", `/workflows/${workflowId}`, "root")
    ).json();
    expect(after.name).toBe("Einfach");
    expect(after.statuses.map((s: { id: string }) => s.id).sort()).toEqual(
      [status["To Do"], status.Done].sort(),
    );
    expect(after.transitions.map((x: { id: string }) => x.id)).toContain(
      keep.id,
    );
    expect(
      (await app.call("GET", `/issues/${made.key}`, "root")).json().fields
        .status,
    ).toBe(status["To Do"]);
    expect(
      (await app.call("GET", `/workflows/${workflowId}/draft`, "root")).json()
        .saved,
    ).toBe(false);
  });

  it("creates copies and deletes only unused workflows", async () => {
    const copy = (
      await app.call("POST", "/workflows", "root", {
        name: "Kopie",
        copyFrom: workflowId,
      })
    ).json();
    expect(
      (await app.call("GET", `/workflows/${copy.id}`, "root")).json()
        .transitions,
    ).toHaveLength(2);
    expect(
      (await app.call("DELETE", `/workflows/${workflowId}`, "root")).statusCode,
    ).toBe(409);
    expect(
      (await app.call("DELETE", `/workflows/${copy.id}`, "root")).statusCode,
    ).toBe(204);
  });
});
