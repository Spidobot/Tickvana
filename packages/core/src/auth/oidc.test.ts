import type { FastifyInstance } from "fastify";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { uuidv7 } from "../db/index.js";
import { migrateCore } from "../migrations/index.js";
import type { CoreDb } from "../schema.js";
import { createServer } from "../server/index.js";
import { decryptSecret, encryptSecret } from "../settings.js";
import { describeEachDb } from "../testing/index.js";
import { createPermissions } from "../permissions/index.js";
import { getOidcConfig, provisionOidcUser, setOidcConfig } from "./oidc.js";
import { installAuth } from "./routes.js";

const ORIGIN = "http://work.test";
const SECRET_KEY = "k".repeat(32);
const CLIENT_SECRET = "keycloak-client-secret";
const BASE = "/tickvana/api/core/auth";

const kcUser = (
  username: string,
  emailVerified: boolean,
  groups: string[] = [],
) => ({
  username,
  email: `${username}@example.org`,
  emailVerified,
  firstName: username,
  lastName: "Test",
  enabled: true,
  credentials: [{ type: "password", value: "pw", temporary: false }],
  groups,
});

const realm = {
  realm: "tw",
  enabled: true,
  clients: [
    {
      clientId: "tickvana",
      secret: CLIENT_SECRET,
      redirectUris: ["*"],
      publicClient: false,
      standardFlowEnabled: true,
      protocolMappers: [
        {
          name: "groups",
          protocol: "openid-connect",
          protocolMapper: "oidc-group-membership-mapper",
          config: {
            "claim.name": "groups",
            "full.path": "false",
            "id.token.claim": "true",
          },
        },
      ],
    },
  ],
  groups: [{ name: "devs" }, { name: "ops" }],
  users: [
    kcUser("ada", true, ["/devs", "/ops"]),
    kcUser("bob", false),
    kcUser("carl", true),
  ],
};

let keycloak: StartedTestContainer;
let issuer: string;

beforeAll(async () => {
  keycloak = await new GenericContainer("quay.io/keycloak/keycloak:26.0")
    .withExposedPorts(8080)
    .withCommand(["start-dev", "--import-realm"])
    .withCopyContentToContainer([
      {
        content: JSON.stringify(realm),
        target: "/opt/keycloak/data/import/realm.json",
      },
    ])
    .withWaitStrategy(
      Wait.forHttp("/realms/tw/.well-known/openid-configuration", 8080),
    )
    .withStartupTimeout(240_000)
    .start();
  issuer = `http://${keycloak.getHost()}:${keycloak.getMappedPort(8080)}/realms/tw`;
}, 300_000);

afterAll(() => keycloak?.stop());

it("encrypts secrets and detects tampering", () => {
  const sealed = encryptSecret(SECRET_KEY, "hunter2");
  expect(sealed).not.toContain("hunter2");
  expect(decryptSecret(SECRET_KEY, sealed)).toBe("hunter2");
  expect(encryptSecret(SECRET_KEY, "hunter2")).not.toBe(sealed);
  expect(() => decryptSecret("x".repeat(32), sealed)).toThrow();
  expect(() =>
    decryptSecret(SECRET_KEY, sealed.slice(0, -3) + "AAA"),
  ).toThrow();
});

describeEachDb<CoreDb>("OIDC sign-in", (t) => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await migrateCore(t);
    app = await createServer({
      name: "track",
      version: "0",
      prefix: "/tickvana",
      routes: async (scope) => {
        await installAuth(scope, {
          db: t.db,
          permissions: createPermissions(t.db),
          baseUrl: ORIGIN,
          secretKey: SECRET_KEY,
          sendPasswordReset: async () => {},
        });
      },
    });
    await setOidcConfig(t.db, SECRET_KEY, {
      enabled: true,
      issuer,
      clientId: "tickvana",
      clientSecret: CLIENT_SECRET,
      label: "Keycloak",
      groupsClaim: "groups",
    });
  });

  afterAll(() => app?.close());

  const addLocalUser = async (email: string, active = true) => {
    const now = new Date();
    const id = uuidv7();
    await t.db
      .insertInto("core_user")
      .values({
        id,
        email,
        display_name: "Local",
        password_hash: null,
        kind: "internal",
        active,
        locale: "de",
        timezone: "UTC",
        created_at: now,
        updated_at: now,
      })
      .execute();
    return id;
  };

  const cookiePair = (header: string | string[] | undefined, name: string) =>
    [header ?? []]
      .flat()
      .find((c) => c.startsWith(`${name}=`))
      ?.split(";")[0];

  /** Walks the whole redirect dance like a browser and returns the callback response. */
  async function signIn(
    username: string,
    opts: { returnTo?: string; breakState?: boolean } = {},
  ) {
    const query = opts.returnTo
      ? `?returnTo=${encodeURIComponent(opts.returnTo)}`
      : "";
    const start = await app.inject(`${BASE}/oidc/login${query}`);
    expect(start.statusCode).toBe(302);
    const flow = cookiePair(start.headers["set-cookie"], "tvn_oidc")!;

    const page = await fetch(start.headers.location as string, {
      redirect: "manual",
    });
    const kcCookies = page.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const action = /<form[^>]*action="([^"]+)"/
      .exec(await page.text())![1]!
      .replaceAll("&amp;", "&");

    const submitted = await fetch(action, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: kcCookies,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ username, password: "pw" }),
    });
    expect(submitted.status, "Keycloak accepted the credentials").toBe(302);
    const back = new URL(submitted.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(`${ORIGIN}${BASE}/oidc/callback`);
    if (opts.breakState) back.searchParams.set("state", "forged");

    return app.inject({
      url: back.pathname + back.search,
      headers: { cookie: flow },
    });
  }

  const me = async (callback: Awaited<ReturnType<typeof signIn>>) => {
    const session = cookiePair(callback.headers["set-cookie"], "tvn_session");
    const res = await app.inject({
      url: `${BASE}/me`,
      headers: { cookie: session ?? "" },
    });
    return res.json();
  };

  it("stores the client secret encrypted and advertises the provider", async () => {
    const stored = await getOidcConfig(t.db);
    expect(stored.clientSecret).not.toContain(CLIENT_SECRET);
    expect(decryptSecret(SECRET_KEY, stored.clientSecret)).toBe(CLIENT_SECRET);
    const providers = await app.inject(`${BASE}/providers`);
    expect(providers.json()).toEqual({
      password: true,
      oidc: { label: "Keycloak", autoRedirect: false },
    });
  });

  it("links a verified address to the existing account and takes groups from the claim", async () => {
    const localId = await addLocalUser("ada@example.org");
    const stale = uuidv7();
    await t.db
      .insertInto("core_group")
      .values({ id: stale, name: "stale", created_at: new Date() })
      .execute();
    await t.db
      .insertInto("core_group_member")
      .values({ group_id: stale, user_id: localId })
      .execute();

    const callback = await signIn("ada", {
      returnTo: "/tickvana/projects?x=1",
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/tickvana/projects?x=1");
    expect(await me(callback)).toMatchObject({
      id: localId,
      email: "ada@example.org",
    });

    const groups = await t.db
      .selectFrom("core_group_member")
      .innerJoin("core_group", "core_group.id", "core_group_member.group_id")
      .select("core_group.name")
      .where("user_id", "=", localId)
      .execute();
    expect(groups.map((g) => g.name).sort()).toEqual(["devs", "ops"]);

    // Second sign-in resolves through the stored identity, no second account.
    expect((await me(await signIn("ada"))).id).toBe(localId);
    const users = await t.db
      .selectFrom("core_user")
      .select("id")
      .where("email", "=", "ada@example.org")
      .execute();
    expect(users).toHaveLength(1);
  });

  it("refuses to link an unverified address to an existing account", async () => {
    await addLocalUser("bob@example.org");
    const callback = await signIn("bob");
    expect(callback.statusCode).toBe(403);
    expect(callback.json().error.code).toBe("sso_denied");
    expect(callback.headers["set-cookie"]?.toString() ?? "").not.toContain(
      "tvn_session=",
    );
  });

  it("links unverified addresses only when the admin trusts the provider (Entra ID)", async () => {
    await setOidcConfig(t.db, SECRET_KEY, {
      trustEmail: true,
      autoRedirect: true,
    });
    const callback = await signIn("bob");
    expect(callback.statusCode).toBe(302);
    expect((await me(callback)).email).toBe("bob@example.org");
    expect(
      (await app.inject(`${BASE}/providers`)).json().oidc.autoRedirect,
    ).toBe(true);
    await setOidcConfig(t.db, SECRET_KEY, {
      trustEmail: false,
      autoRedirect: false,
    });
  });

  it("takes the UPN as address when trusted and no e-mail claim is sent", async () => {
    const claims = {
      sub: "entra-1",
      preferred_username: "Grace@Contoso.example",
      name: "Grace",
    };
    const base = await getOidcConfig(t.db);
    await expect(
      provisionOidcUser(t.db, { ...base, trustEmail: false }, claims),
    ).rejects.toMatchObject({ status: 403 });
    const id = await provisionOidcUser(
      t.db,
      { ...base, trustEmail: true, groupsClaim: "" },
      claims,
    );
    const user = await t.db
      .selectFrom("core_user")
      .select("email")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(user.email).toBe("grace@contoso.example");
  });

  it("creates accounts only when allowed, and never signs in deactivated ones", async () => {
    await setOidcConfig(t.db, SECRET_KEY, { createUsers: false });
    expect((await signIn("carl")).statusCode).toBe(403);

    await setOidcConfig(t.db, SECRET_KEY, { createUsers: true });
    const created = await me(await signIn("carl"));
    expect(created).toMatchObject({
      email: "carl@example.org",
      displayName: "carl Test",
      kind: "internal",
    });
    // Saving without a secret kept the stored one.
    expect(
      decryptSecret(SECRET_KEY, (await getOidcConfig(t.db)).clientSecret),
    ).toBe(CLIENT_SECRET);

    await t.db
      .updateTable("core_user")
      .set({ active: false })
      .where("id", "=", created.id)
      .execute();
    expect((await signIn("carl")).statusCode).toBe(403);
  });

  it("rejects a forged state, a missing flow cookie and open redirects", async () => {
    expect((await signIn("ada", { breakState: true })).statusCode).toBe(400);
    expect(
      (await app.inject(`${BASE}/oidc/callback?code=x&state=y`)).statusCode,
    ).toBe(400);
    for (const returnTo of [
      "https://evil.example/",
      "//evil.example",
      "/\\evil.example",
    ]) {
      expect(
        (await signIn("ada", { returnTo })).headers.location,
        returnTo,
      ).toBe("/");
    }
  });

  it("is gone when disabled", async () => {
    await setOidcConfig(t.db, SECRET_KEY, { enabled: false });
    expect((await app.inject(`${BASE}/oidc/login`)).statusCode).toBe(404);
    expect((await app.inject(`${BASE}/providers`)).json().oidc).toBeNull();
    await setOidcConfig(t.db, SECRET_KEY, { enabled: true });
  });
});
