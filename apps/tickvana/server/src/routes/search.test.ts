import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<TrackDb>("ticket search", (t) => {
  let app: TestApp;
  const keys: Record<string, string> = {};

  const search = async (who: string, q: string) =>
    (
      await app.call("GET", `/search?q=${encodeURIComponent(q)}`, who)
    ).json() as { key: string; summary: string; excerpt: string }[];

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["mira", "gast", "fremd"]) await app.addUser(name);
    await app.call("POST", "/projects", "root", { key: "WIT", name: "IT" });
    const roles = Object.fromEntries(
      (await app.db.selectFrom("track_project_role").selectAll().execute()).map(
        (r) => [r.name, r.id],
      ),
    );
    for (const [who, role] of [
      ["mira", "Members"],
      ["gast", "Viewers"],
    ] as const)
      await app.call("PUT", "/projects/WIT/members", "root", {
        roleId: roles[role],
        principalType: "user",
        principalId: app.ids[who],
      });
    const wit = (
      await app.db
        .selectFrom("track_project")
        .select("id")
        .where("key", "=", "WIT")
        .executeTakeFirstOrThrow()
    ).id;
    await app.db
      .insertInto("track_security_level")
      .values({ id: "lvl", project_id: wit, name: "Personal" })
      .execute();
    await app.db
      .insertInto("track_security_level_member")
      .values({
        id: "m",
        level_id: "lvl",
        grantee_type: "reporter",
        grantee_id: null,
      })
      .execute();
    const type = (
      await app.db
        .selectFrom("track_issue_type")
        .select("id")
        .executeTakeFirstOrThrow()
    ).id;
    const create = async (summary: string, fields: object = {}) =>
      (keys[summary] = (
        await app.call("POST", "/issues", "mira", {
          projectKey: "WIT",
          type,
          fields: { summary, ...fields },
        })
      ).json().key);
    await create("Drucker streikt");
    await create("VPN langsam", {
      description: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Seit dem Drucker-Update hakt es." },
            ],
          },
        ],
      },
    });
    await create("Drucker Gehaltsliste", { securityLevel: "lvl" });
  }, 180_000);
  afterAll(() => app?.close());

  it("finds summary and description hits with an excerpt, and keys", async () => {
    const hits = await search("mira", "drucker");
    expect(hits.map((h) => h.summary).sort()).toEqual([
      "Drucker Gehaltsliste",
      "Drucker streikt",
      "VPN langsam",
    ]);
    expect(hits.at(-1)).toMatchObject({ summary: "VPN langsam" });
    expect(hits.at(-1)!.excerpt).toMatch(/Drucker-Update/);
    expect(
      (await search("mira", keys["VPN langsam"]!.toLowerCase()))[0]!.summary,
    ).toBe("VPN langsam");
  });

  it("leaves out tickets behind a security level and foreign projects", async () => {
    expect(
      (await search("gast", "drucker")).map((h) => h.summary).sort(),
    ).toEqual(["Drucker streikt", "VPN langsam"]);
    expect(await search("fremd", "drucker")).toEqual([]);
  });
});
