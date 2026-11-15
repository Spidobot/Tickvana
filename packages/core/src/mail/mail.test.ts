import type { FastifyInstance } from "fastify";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { installAuth } from "../auth/routes.js";
import { createApiToken } from "../auth/store.js";
import { uuidv7 } from "../db/index.js";
import { migrateCore } from "../migrations/index.js";
import {
  createPermissions,
  grantGlobal,
  SYSTEM_ADMIN,
} from "../permissions/index.js";
import { createQueue, type Queue } from "../queue/index.js";
import type { CoreDb } from "../schema.js";
import { createServer } from "../server/index.js";
import { setSetting } from "../settings.js";
import { describeEachDb } from "../testing/index.js";
import {
  createMailer,
  getMailConfig,
  installMailRoutes,
  renderMail,
  setMailConfig,
  type Mailer,
} from "./index.js";

const SECRET_KEY = "m".repeat(32);
let mailpit: StartedTestContainer;
let api: string;

beforeAll(async () => {
  mailpit = await new GenericContainer("axllent/mailpit:v1.21")
    .withExposedPorts(1025, 8025)
    .withEnvironment({
      MP_SMTP_AUTH: "ada:smtp-secret",
      MP_SMTP_AUTH_ALLOW_INSECURE: "true",
    })
    .withWaitStrategy(Wait.forHttp("/readyz", 8025))
    .start();
  api = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}/api/v1`;
}, 180_000);

afterAll(() => mailpit?.stop());

const inbox = async () =>
  (
    (await (await fetch(`${api}/messages`)).json()) as {
      messages: { ID: string; Subject: string; To: { Address: string }[] }[];
    }
  ).messages;

it("renders text and escaped HTML", () => {
  const { text, html } = renderMail(
    {
      to: "x@example.org",
      subject: "s",
      body: ["<b>Hallo</b> & willkommen"],
      action: { label: "Öffnen", url: "https://x.test/?a=1&b=2" },
    },
    { productName: "Werk <1>", accent: "#aa3300" },
  );
  expect(text).toContain("<b>Hallo</b> & willkommen");
  expect(text).toContain("Öffnen: https://x.test/?a=1&b=2");
  expect(html).not.toContain("<b>Hallo</b>");
  expect(html).toContain("&#60;b&#62;Hallo");
  expect(html).toContain('href="https://x.test/?a=1&#38;b=2"');
  expect(html).toContain("Werk &#60;1&#62;");
  expect(html).toContain("#aa3300");
});

describeEachDb<CoreDb>("mail", (t) => {
  let app: FastifyInstance;
  let queue: Queue;
  let mailer: Mailer;
  let admin: { authorization: string };
  let plain: { authorization: string };
  const URL = "/t/api/core/settings/mail";

  beforeAll(async () => {
    await migrateCore(t);
    const tokens: { authorization: string }[] = [];
    for (const name of ["admin", "plain"]) {
      const now = new Date();
      const id = uuidv7();
      await t.db
        .insertInto("core_user")
        .values({
          id,
          email: `${name}@example.org`,
          display_name: name,
          password_hash: null,
          kind: "internal",
          active: true,
          locale: "de",
          timezone: "UTC",
          created_at: now,
          updated_at: now,
        })
        .execute();
      if (name === "admin") await grantGlobal(t.db, SYSTEM_ADMIN, "user", id);
      tokens.push({
        authorization: `Bearer ${(await createApiToken(t.db, id, "t", null)).token}`,
      });
    }
    [admin, plain] = tokens as [typeof admin, typeof plain];

    queue = createQueue(t.db, { backoffMs: () => 0, maxAttempts: 2 });
    mailer = createMailer(t.db, SECRET_KEY, queue);
    const permissions = createPermissions(t.db);
    app = await createServer({
      name: "t",
      version: "0",
      prefix: "/t",
      routes: async (scope) => {
        await installAuth(scope, {
          db: t.db,
          permissions,
          baseUrl: "http://localhost",
          secretKey: SECRET_KEY,
          sendPasswordReset: async () => {},
        });
        await installMailRoutes(scope, t.db, SECRET_KEY, mailer);
      },
    });
  });

  afterAll(() => app?.close());

  beforeEach(async () => {
    await fetch(`${api}/messages`, { method: "DELETE" });
    await t.db.deleteFrom("core_job").execute();
    await setMailConfig(t.db, SECRET_KEY, {
      enabled: true,
      host: mailpit.getHost(),
      port: mailpit.getMappedPort(1025),
      secure: false,
      user: "ada",
      password: "smtp-secret",
      from: "Tickvana <no-reply@example.org>",
    });
  });

  it("delivers queued mail with branding, after commit only", async () => {
    await setSetting(t.db, "branding", { productName: "Werkbank" });
    await expect(
      t.db.transaction().execute(async (trx) => {
        await mailer.send(trx, {
          to: "nie@example.org",
          subject: "Verworfen",
          body: ["x"],
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow();
    await mailer.send(t.db, {
      to: "bea@example.org",
      subject: "Größe geändert",
      body: ["Zeile eins"],
      action: { label: "Ansehen", url: "http://localhost/tickvana/x" },
    });
    expect(await inbox()).toHaveLength(0);

    expect(await queue.runDue()).toBe(1);
    const [message] = await inbox();
    expect(message).toMatchObject({
      Subject: "Größe geändert",
      To: [{ Address: "bea@example.org" }],
    });
    const full = (await (
      await fetch(`${api}/message/${message!.ID}`)
    ).json()) as { Text: string; HTML: string; From: { Address: string } };
    expect(full.From.Address).toBe("no-reply@example.org");
    expect(full.Text).toContain("Zeile eins");
    expect(full.Text).toContain("Werkbank");
    expect(full.HTML).toContain("Ansehen");
  });

  it("retries on SMTP errors and drops mail quietly when switched off", async () => {
    await setMailConfig(t.db, SECRET_KEY, { password: "wrong" });
    await mailer.send(t.db, {
      to: "bea@example.org",
      subject: "A",
      body: ["a"],
    });
    await queue.runDue();
    let [job] = await t.db.selectFrom("core_job").selectAll().execute();
    expect(job).toMatchObject({ state: "pending", attempts: 1 });

    await setMailConfig(t.db, SECRET_KEY, { password: "smtp-secret" });
    await queue.runDue(new Date(Date.now() + 1000));
    expect(await inbox()).toHaveLength(1);

    await setMailConfig(t.db, SECRET_KEY, { enabled: false });
    await mailer.send(t.db, {
      to: "bea@example.org",
      subject: "B",
      body: ["b"],
    });
    await queue.runDue(new Date(Date.now() + 1000));
    expect(await inbox()).toHaveLength(1);
    [job] = await t.db
      .selectFrom("core_job")
      .selectAll()
      .orderBy("id", "desc")
      .execute();
    expect(job!.state).toBe("done");
  });

  it("keeps the password write-only and encrypted, for admins only", async () => {
    expect((await app.inject({ url: URL, headers: plain })).statusCode).toBe(
      403,
    );
    const shown = await app.inject({ url: URL, headers: admin });
    expect(shown.json()).toMatchObject({
      enabled: true,
      user: "ada",
      hasPassword: true,
    });
    expect(shown.body).not.toContain("smtp-secret");
    expect((await getMailConfig(t.db)).password).not.toContain("smtp-secret");

    const put = (payload: object) =>
      app.inject({ method: "PUT", url: URL, payload, headers: admin });
    expect((await put({ from: "Neu <neu@example.org>" })).json()).toMatchObject(
      { from: "Neu <neu@example.org>", hasPassword: true },
    );
    expect((await put({ password: "" })).json().hasPassword).toBe(false);
    expect((await put({ host: "" })).statusCode).toBe(400);
  });

  it("sends a test mail and reports the server's answer on failure", async () => {
    const test = () =>
      app.inject({
        method: "POST",
        url: `${URL}/test`,
        payload: { to: "probe@example.org" },
        headers: admin,
      });
    expect((await test()).statusCode).toBe(204);
    expect((await inbox()).map((m) => m.To[0]!.Address)).toEqual([
      "probe@example.org",
    ]);

    await setMailConfig(t.db, SECRET_KEY, { password: "wrong" });
    const failed = await test();
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.code).toBe("mail_failed");
    expect(failed.json().error.message).toMatch(/auth|535|credentials/i);

    await setMailConfig(t.db, SECRET_KEY, { enabled: false });
    expect((await test()).statusCode).toBe(409);
  });
});
