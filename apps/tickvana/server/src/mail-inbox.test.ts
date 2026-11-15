import type { CoreDb } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "./db/schema.js";
import { MAIL_JOB, textToDoc } from "./mail-inbox.js";
import { startTestApp, type TestApp } from "./testing.js";

/** A raw mail as an IMAP server hands it out. */
function mime(
  headers: Record<string, string>,
  text: string,
  attachment?: { name: string; data: string },
) {
  const head = Object.entries({
    "Message-ID": `<${Math.random().toString(36).slice(2)}@extern.example>`,
    Date: new Date().toUTCString(),
    "MIME-Version": "1.0",
    ...headers,
  })
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  if (!attachment)
    return `${head}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;
  const b = "grenze";
  return [
    `${head}\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n`,
    `--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`,
    `--${b}\r\nContent-Type: text/plain; name="${attachment.name}"\r\nContent-Disposition: attachment; filename="${attachment.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(attachment.data).toString("base64")}\r\n`,
    `--${b}--\r\n`,
  ].join("\r\n");
}

it("cuts quoted earlier mails from replies", () => {
  const doc = textToDoc(
    "Danke!\n\nGeht wieder.\n\nAm Mo., 16. Nov. schrieb Support:\n> alt",
    true,
  );
  expect(doc.content.map((p) => p.content[0]!.text)).toEqual([
    "Danke!",
    "Geht wieder.",
  ]);
});

describeEachDb<TrackDb>("mail inbox", (t) => {
  let app: TestApp;
  let channelId: string;

  const receive = async (raw: string) => {
    await app.running.queue.enqueue(
      app.db as unknown as Kysely<CoreDb>,
      MAIL_JOB,
      {
        channelId,
        source: Buffer.from(raw).toString("base64"),
      },
    );
    while ((await app.running.queue.runDue()) > 0);
  };
  const issues = () =>
    app.db
      .selectFrom("track_issue")
      .select(["key", "summary", "reporter_id"])
      .orderBy("number")
      .execute();

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    await app.call("POST", "/projects", "root", {
      key: "SD",
      name: "Support",
      kind: "service",
    });
    const project = (await app.call("GET", "/projects/SD", "root")).json();
    const layout = (await app.call("GET", "/field-layouts", "root")).json()[0];
    const rt = (
      await app.call("POST", "/projects/SD/request-types", "root", {
        name: "Per Mail",
        issueTypeId: project.issueTypes[0].id,
        fieldLayoutId: layout.id,
      })
    ).json();
    const channel = await app.call(
      "POST",
      "/projects/SD/mail-channels",
      "root",
      {
        requestTypeId: rt.id,
        imap: {
          host: "imap.example.org",
          user: "support",
          password: "geheim-imap",
        },
        active: false,
      },
    );
    expect(channel.statusCode).toBe(201);
    expect(channel.json().imap).toMatchObject({
      hasPassword: true,
      port: 993,
      folder: "INBOX",
    });
    expect(channel.body).not.toContain("geheim");
    channelId = channel.json().id;
    // Like webhooks: no mail servers inside the private network.
    expect(
      (
        await app.call("POST", "/projects/SD/mail-channels", "root", {
          requestTypeId: rt.id,
          imap: { host: "127.0.0.1", user: "x", password: "y" },
          active: false,
        })
      ).statusCode,
    ).toBe(400);
    await app.call("PUT", "/core/settings/mail", "root", {
      from: "Support <support@example.org>",
    });
  }, 180_000);
  afterAll(() => app?.close());

  it("turns a new mail into a request of a new customer, with attachments", async () => {
    await receive(
      mime(
        {
          From: "Kim Kunde <kim@extern.example>",
          To: "support@example.org",
          Subject: "Drucker kaputt",
        },
        "Der Drucker im Lager druckt nichts.\n\nGrüße, Kim",
        { name: "fehler.txt", data: "Fehler 42" },
      ),
    );
    const [issue] = await issues();
    expect(issue).toMatchObject({ key: "SD-1", summary: "Drucker kaputt" });
    const kim = await app.db
      .selectFrom("core_user")
      .select(["id", "kind", "display_name"])
      .where("email", "=", "kim@extern.example")
      .executeTakeFirstOrThrow();
    expect(kim).toMatchObject({ kind: "customer", display_name: "Kim Kunde" });
    expect(issue!.reporter_id).toBe(kim.id);
    const full = (await app.call("GET", "/issues/SD-1", "root")).json();
    expect(JSON.stringify(full.fields.description)).toContain("druckt nichts");
    const files = await app.db
      .selectFrom("core_attachment")
      .select(["filename", "owner_id"])
      .execute();
    expect(files).toEqual([{ filename: "fehler.txt", owner_id: full.id }]);
  });

  it("adds replies naming the ticket as public comments", async () => {
    await receive(
      mime(
        { From: "kim@extern.example", Subject: "Re: [SD-1] Drucker kaputt" },
        "Geht wieder, danke!\n\nAm Montag schrieb Support:\n> Wir haben den Toner getauscht",
      ),
    );
    expect(await issues()).toHaveLength(1);
    const comments = (
      await app.call("GET", "/issues/SD-1/comments", "root")
    ).json();
    expect(comments).toHaveLength(1);
    expect(comments[0].visibility).toBe("public");
    expect(JSON.stringify(comments[0].body)).toContain("Geht wieder");
    expect(JSON.stringify(comments[0].body)).not.toContain("Toner");
  });

  it("ignores automatic replies, lists and its own mails", async () => {
    for (const headers of <Record<string, string>[]>[
      {
        From: "kim@extern.example",
        Subject: "Abwesend",
        "Auto-Submitted": "auto-replied",
      },
      { From: "kim@extern.example", Subject: "Newsletter", Precedence: "bulk" },
      {
        From: "kim@extern.example",
        Subject: "Liste",
        "List-Id": "<team.extern.example>",
      },
      { From: "MAILER-DAEMON@extern.example", Subject: "Undelivered" },
      {
        From: "Support <support@example.org>",
        Subject: "[SD-1] Neue Antwort",
      },
    ])
      await receive(mime(headers, "automatisch"));
    expect((await issues()).map((i) => i.summary)).toEqual(["Drucker kaputt"]);
    expect(
      (await app.call("GET", "/issues/SD-1/comments", "root")).json(),
    ).toHaveLength(1);
  });

  it("opens a new request when the named ticket belongs elsewhere", async () => {
    await receive(
      mime(
        { From: "ole@extern.example", Subject: "Frage zu [SD-1]" },
        "Was ist mit SD-1?",
      ),
    );
    // Ole may not comment on Kim's ticket: his mail becomes a request of its own.
    expect((await issues()).map((i) => i.key)).toEqual(["SD-1", "SD-2"]);
  });
});
