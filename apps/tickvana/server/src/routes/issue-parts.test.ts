import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describeEachDb<TrackDb>(
  "comments, work logs, watchers, links, components, versions",
  (t) => {
    let app: TestApp;
    let task: string;
    const key: Record<string, string> = {};

    const create = async (
      summary: string,
      extra: object = {},
      projectKey = "WIT",
    ) =>
      (
        await app.call("POST", "/issues", "mira", {
          projectKey,
          type: task,
          fields: { summary, ...extra },
        })
      ).json();

    beforeAll(async () => {
      app = await startTestApp(t.url);
      await app.addUser("root", { admin: true });
      for (const name of ["mira", "jonas", "gast", "fremd"])
        await app.addUser(name);
      await app.call("POST", "/projects", "root", {
        key: "WIT",
        name: "Werkstatt-IT",
      });
      await app.call("POST", "/projects", "root", {
        key: "GEH",
        name: "Geheim",
      });
      const roles = Object.fromEntries(
        (
          await app.db.selectFrom("track_project_role").selectAll().execute()
        ).map((r) => [r.name, r.id]),
      );
      const member = (project: string, role: string, user: string) =>
        app.call("PUT", `/projects/${project}/members`, "root", {
          roleId: roles[role],
          principalType: "user",
          principalId: app.ids[user],
        });
      await member("WIT", "Members", "mira");
      await member("WIT", "Members", "jonas");
      await member("WIT", "Viewers", "gast");
      await member("GEH", "Members", "mira");
      task = (
        await app.db
          .selectFrom("track_issue_type")
          .select("id")
          .where("name", "=", "Task")
          .executeTakeFirstOrThrow()
      ).id;
      key.a = (await create("Drucker", { estimate: 7200 })).key;
      key.b = (await create("Scanner")).key;
      key.secret = (await create("Verdeckt", {}, "GEH")).key;
    });
    afterAll(() => app?.close());

    it("handles public and internal comments", async () => {
      const post = (as: string, body: unknown, visibility?: string) =>
        app.call("POST", `/issues/${key.a}/comments`, as, { body, visibility });
      const pub = await post("mira", doc("Rolle gewechselt"));
      expect(pub.statusCode).toBe(201);
      expect(pub.json()).toMatchObject({
        authorId: app.ids.mira,
        visibility: "public",
        body: doc("Rolle gewechselt"),
      });
      const internal = (
        await post("jonas", doc("Lieferant anrufen"), "internal")
      ).json();

      expect((await post("gast", doc("x"))).statusCode).toBe(403);
      expect((await post("fremd", doc("x"))).statusCode).toBe(404);
      expect((await post("mira", doc("   "))).statusCode).toBe(400);
      expect((await post("mira", "<p>html</p>")).statusCode).toBe(400);
      expect(
        (await post("mira", { type: "doc", content: [{ type: "script" }] }))
          .statusCode,
      ).toBe(400);

      const texts = async (as: string) =>
        (await app.call("GET", `/issues/${key.a}/comments`, as))
          .json()
          .map(
            (c: { body: { content: { content: { text: string }[] }[] } }) =>
              c.body.content[0]!.content[0]!.text,
          );
      expect(await texts("mira")).toEqual([
        "Rolle gewechselt",
        "Lieferant anrufen",
      ]);
      // Viewers hold no comment.internal in the default scheme.
      expect(await texts("gast")).toEqual(["Rolle gewechselt"]);

      expect(
        (
          await app.call("PATCH", `/comments/${pub.json().id}`, "jonas", {
            body: doc("Gekapert"),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.call("PATCH", `/comments/${internal.id}`, "gast", {
            body: doc("x"),
          })
        ).statusCode,
      ).toBe(404);
      const edited = await app.call(
        "PATCH",
        `/comments/${pub.json().id}`,
        "mira",
        { body: doc("Rolle und Farbband gewechselt") },
      );
      expect(edited.json().body).toEqual(doc("Rolle und Farbband gewechselt"));
      // The project administrator may remove anyone's comment.
      expect(
        (await app.call("DELETE", `/comments/${internal.id}`, "root"))
          .statusCode,
      ).toBe(204);
      expect(await texts("mira")).toEqual(["Rolle und Farbband gewechselt"]);

      const issue = (await app.call("GET", `/issues/${key.a}`, "mira")).json();
      const events = await app.db
        .selectFrom("core_event")
        .select("type")
        .where("entity_id", "=", issue.id)
        .where("type", "=", "issue.commented")
        .execute();
      expect(events).toHaveLength(2);
      expect(new Date(issue.updatedAt).getTime()).toBeGreaterThan(
        new Date(issue.createdAt).getTime() - 1,
      );
    });

    it("logs work and keeps spent and remaining time right", async () => {
      const log = (as: string, body: object) =>
        app.call("POST", `/issues/${key.a}/worklogs`, as, body);
      const time = async () => {
        const i = (await app.call("GET", `/issues/${key.a}`, "mira")).json();
        return [i.spentSec, i.fields.remaining];
      };
      expect(await time()).toEqual([0, 7200]);
      const first = await log("mira", {
        seconds: 1800,
        note: "Rolle getauscht",
        startedAt: "2026-11-13T08:00:00.000Z",
      });
      expect(first.statusCode).toBe(201);
      expect(await time()).toEqual([1800, 5400]);
      await log("jonas", { seconds: 3600, remaining: "keep" });
      expect(await time()).toEqual([5400, 5400]);
      await log("jonas", { seconds: 600, remaining: 900 });
      expect(await time()).toEqual([6000, 900]);
      // Never below zero.
      await log("mira", { seconds: 3600 });
      expect(await time()).toEqual([9600, 0]);

      expect((await log("gast", { seconds: 600 })).statusCode).toBe(403);
      expect((await log("mira", { seconds: 10 })).statusCode).toBe(400);

      // Ten people log at the same moment: nothing is lost.
      const parallel = await Promise.all(
        Array.from({ length: 10 }, () =>
          log("mira", { seconds: 60, remaining: "keep" }),
        ),
      );
      expect(parallel.map((p) => p.statusCode)).toEqual(Array(10).fill(201));
      const comments = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          app.call("POST", `/issues/${key.b}/comments`, "mira", {
            body: doc(`Parallel ${i}`),
          }),
        ),
      );
      expect(comments.map((c) => c.statusCode)).toEqual(Array(10).fill(201));
      expect((await time())[0]).toBe(10200);

      const listed = (
        await app.call("GET", `/issues/${key.a}/worklogs`, "gast")
      ).json();
      expect(listed).toHaveLength(14);
      expect(listed[0]).toMatchObject({
        authorId: app.ids.mira,
        seconds: 1800,
        note: "Rolle getauscht",
        startedAt: "2026-11-13T08:00:00.000Z",
      });
      expect(
        (await app.call("DELETE", `/worklogs/${first.json().id}`, "jonas"))
          .statusCode,
      ).toBe(403);
      expect(
        (await app.call("DELETE", `/worklogs/${first.json().id}`, "mira"))
          .statusCode,
      ).toBe(204);
      expect((await time())[0]).toBe(8400);

      // Without an estimate, remaining stays empty.
      await app.call("POST", `/issues/${key.b}/worklogs`, "mira", {
        seconds: 600,
      });
      expect(
        (await app.call("GET", `/issues/${key.b}`, "mira")).json().fields
          .remaining,
      ).toBeNull();
    });

    it("manages watchers and votes", async () => {
      const watch = (
        as: string,
        user: string,
        method: "PUT" | "DELETE" = "PUT",
      ) => app.call(method, `/issues/${key.a}/watchers/${app.ids[user]}`, as);
      expect((await watch("gast", "gast")).statusCode).toBe(204);
      expect((await watch("gast", "gast")).statusCode).toBe(204);
      expect((await watch("gast", "jonas")).statusCode).toBe(403);
      expect((await watch("mira", "jonas")).statusCode).toBe(204);
      // Someone who cannot see the ticket cannot be made to watch it.
      expect((await watch("mira", "fremd")).statusCode).toBe(400);
      expect(
        (await app.call("GET", `/issues/${key.a}/watchers`, "mira"))
          .json()
          .sort(),
      ).toEqual([app.ids.gast, app.ids.jonas].sort());
      expect((await watch("gast", "gast", "DELETE")).statusCode).toBe(204);
      expect(
        (await app.call("GET", `/issues/${key.a}/watchers`, "mira")).json(),
      ).toEqual([app.ids.jonas]);

      expect(
        (await app.call("PUT", `/issues/${key.a}/votes`, "mira")).statusCode,
      ).toBe(409);
      expect(
        (await app.call("PUT", `/issues/${key.a}/votes`, "jonas")).json(),
      ).toEqual({ count: 1, voted: true });
      expect(
        (await app.call("PUT", `/issues/${key.a}/votes`, "jonas")).json(),
      ).toEqual({ count: 1, voted: true });
      expect(
        (await app.call("PUT", `/issues/${key.a}/votes`, "gast")).json(),
      ).toEqual({ count: 2, voted: true });
      expect(
        (await app.call("GET", `/issues/${key.a}/votes`, "mira")).json(),
      ).toEqual({ count: 2, voted: false });
      expect(
        (await app.call("DELETE", `/issues/${key.a}/votes`, "jonas")).json(),
      ).toEqual({ count: 1, voted: false });
      expect(
        (await app.call("PUT", `/issues/${key.a}/votes`, "fremd")).statusCode,
      ).toBe(404);
    });

    it("links tickets and hides links to tickets the reader may not see", async () => {
      const types = (await app.call("GET", "/link-types", "gast")).json();
      const blocks = types.find(
        (x: { name: string }) => x.name === "Blocks",
      ).id;
      const link = (as: string, toKey: string, typeId = blocks) =>
        app.call("POST", `/issues/${key.a}/links`, as, { typeId, toKey });

      const made = await link("mira", key.b!);
      expect(made.statusCode).toBe(201);
      expect((await link("mira", key.b!)).statusCode).toBe(409);
      expect((await link("mira", key.a!)).statusCode).toBe(400);
      expect((await link("mira", key.b!, "nope")).statusCode).toBe(400);
      expect((await link("gast", key.b!)).statusCode).toBe(403);
      expect((await link("jonas", key.secret!)).statusCode).toBe(404);
      expect((await link("mira", key.secret!)).statusCode).toBe(201);

      const from = (
        await app.call("GET", `/issues/${key.a}/links`, "mira")
      ).json();
      expect(
        from.map((l: { relation: string; issue: { key: string } }) => [
          l.relation,
          l.issue.key,
        ]),
      ).toEqual([
        ["blocks", key.b],
        ["blocks", key.secret],
      ]);
      const back = (
        await app.call("GET", `/issues/${key.b}/links`, "gast")
      ).json();
      expect(back).toMatchObject([
        {
          relation: "is blocked by",
          direction: "inward",
          issue: { key: key.a, summary: "Drucker" },
        },
      ]);
      // jonas is not in the secret project: that link does not exist for him.
      const forJonas = (
        await app.call("GET", `/issues/${key.a}/links`, "jonas")
      ).json();
      expect(
        forJonas.map((l: { issue: { key: string } }) => l.issue.key),
      ).toEqual([key.b]);

      expect(
        (await app.call("DELETE", `/links/${made.json().id}`, "gast"))
          .statusCode,
      ).toBe(403);
      expect(
        (await app.call("DELETE", `/links/${made.json().id}`, "jonas"))
          .statusCode,
      ).toBe(204);
      expect(
        (await app.call("GET", `/issues/${key.b}/links`, "gast")).json(),
      ).toEqual([]);
    });

    it("lists children", async () => {
      const sub = (
        await app.db
          .selectFrom("track_issue_type")
          .select("id")
          .where("name", "=", "Sub-task")
          .executeTakeFirstOrThrow()
      ).id;
      const parent = (await app.call("GET", `/issues/${key.b}`, "mira")).json();
      for (const summary of ["Akku tauschen", "Firmware"]) {
        await app.call("POST", "/issues", "mira", {
          projectKey: "WIT",
          type: sub,
          fields: { summary, parent: parent.id },
        });
      }
      const children = (
        await app.call("GET", `/issues/${key.b}/children`, "gast")
      ).json();
      expect(children.map((c: { summary: string }) => c.summary)).toEqual([
        "Akku tauschen",
        "Firmware",
      ]);
      expect(children[0]).toMatchObject({ typeId: sub, assigneeId: null });
    });

    it("manages components and versions per project", async () => {
      const add = (as: string, kind: string, body: object, project = "WIT") =>
        app.call("POST", `/projects/${project}/${kind}`, as, body);
      expect(
        (await add("mira", "components", { name: "Drucker" })).statusCode,
      ).toBe(403);
      const component = (
        await add("root", "components", {
          name: "Drucker",
          leadId: app.ids.mira,
        })
      ).json();
      expect(
        (await add("root", "components", { name: "Drucker" })).statusCode,
      ).toBe(409);
      expect(
        (await add("root", "components", { name: "Drucker" }, "GEH"))
          .statusCode,
      ).toBe(201);
      expect(
        (await app.call("GET", "/projects/WIT/components", "gast")).json(),
      ).toEqual([{ id: component.id, name: "Drucker", leadId: app.ids.mira }]);
      expect(
        (await app.call("GET", "/projects/WIT/components", "fremd")).statusCode,
      ).toBe(404);

      await app.call("PATCH", `/issues/${key.a}`, "mira", {
        fields: { components: [component.id] },
      });
      expect(
        (
          await app.call("PATCH", `/components/${component.id}`, "mira", {
            name: "x",
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.call("PATCH", `/components/${component.id}`, "root", {
            name: "Etikettendrucker",
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (await app.call("DELETE", `/components/${component.id}`, "root"))
          .statusCode,
      ).toBe(204);
      expect(
        (await app.call("GET", `/issues/${key.a}`, "mira")).json().fields
          .components,
      ).toEqual([]);

      const version = (
        await add("root", "versions", {
          name: "2026.12",
          releaseDate: "2026-12-15",
        })
      ).json();
      expect(version).toMatchObject({
        name: "2026.12",
        startDate: null,
        releaseDate: "2026-12-15",
        released: false,
      });
      expect(
        (await add("root", "versions", { name: "2026.12" })).statusCode,
      ).toBe(409);
      expect(
        (
          await add("root", "versions", {
            name: "x",
            releaseDate: "15.12.2026",
          })
        ).statusCode,
      ).toBe(400);
      await app.call("PATCH", `/issues/${key.a}`, "mira", {
        fields: { fixVersions: [version.id] },
      });
      const released = await app.call(
        "PATCH",
        `/versions/${version.id}`,
        "root",
        { released: true },
      );
      expect(released.json()).toMatchObject({
        released: true,
        releaseDate: "2026-12-15",
      });
      expect(
        (await app.call("GET", "/projects/WIT/versions", "gast")).json(),
      ).toHaveLength(1);
      expect(
        (
          await app.call("GET", "/projects/WIT/versions/progress", "gast")
        ).json(),
      ).toEqual([{ versionId: version.id, total: 1, done: 0 }]);
      expect(
        (await app.call("DELETE", `/versions/${version.id}`, "mira"))
          .statusCode,
      ).toBe(403);
      expect(
        (await app.call("DELETE", `/versions/${version.id}`, "root"))
          .statusCode,
      ).toBe(204);
      expect(
        (await app.call("GET", `/issues/${key.a}`, "mira")).json().fields
          .fixVersions,
      ).toEqual([]);
    });
  },
);
