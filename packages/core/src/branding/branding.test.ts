import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrateCore } from "../migrations/index.js";
import type { CoreDb } from "../schema.js";
import { startApp, openApiSpec, type RunningApp } from "../server/start.js";
import { describeEachDb } from "../testing/index.js";
import { accentColors, brandingCss, contrast } from "./index.js";

const ORIGIN = "http://localhost";
const def = {
  name: "track",
  version: "0",
  prefix: "/tickvana",
  routes: () => async () => {},
};

it("keeps text readable for any accent", () => {
  expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
  for (const accent of [
    "#1f4fd8",
    "#ffe600",
    "#ffffff",
    "#000000",
    "#ff7a00",
    "#7fffd4",
    "#c2185b",
  ]) {
    const c = accentColors(accent);
    expect(
      contrast(c.accent, c.onAccent),
      `${accent} on-accent`,
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(c.inkLight, "#ffffff"),
      `${accent} ink light`,
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(c.inkDark, "#19191b"),
      `${accent} ink dark`,
    ).toBeGreaterThanOrEqual(4.5);
  }
  // A colour that already works is left alone.
  expect(accentColors("#1f4fd8")).toMatchObject({
    onAccent: "#ffffff",
    inkLight: "#1f4fd8",
  });
  expect(accentColors("#ffe600").onAccent).toBe("#171717");
});

it("renders the stylesheet with custom CSS last", () => {
  const css = brandingCss({
    productName: "x",
    accent: "#ffe600",
    loginText: "",
    footerText: "",
    customCss: ".x{color:red}",
  });
  expect(css).toContain("--brand-accent:#ffe600");
  expect(css).toContain("--brand-on-accent:#171717");
  expect(css.trimEnd().endsWith(".x{color:red}")).toBe(true);
});

it("describes the whole API without a database", async () => {
  const spec = (await openApiSpec(def)) as { paths: Record<string, unknown> };
  for (const path of [
    "/core/auth/login",
    "/core/users",
    "/core/branding",
    "/core/setup",
    "/core/attachments/",
    "/health",
  ]) {
    expect(Object.keys(spec.paths), path).toContain(`/tickvana/api${path}`);
  }
});

describeEachDb<CoreDb>("branding and setup", (t) => {
  let running: RunningApp;
  let app: FastifyInstance;
  let cookie = "";

  beforeAll(async () => {
    await migrateCore(t);
    running = await startApp(def, {
      DB_URL: t.url,
      PORT: 0,
      BASE_URL: ORIGIN,
      SECRET_KEY: "b".repeat(32),
      TRUST_PROXY: false,
      ROLE: "web",
      STORAGE_PATH: (await import("node:fs")).mkdtempSync(
        (await import("node:os")).tmpdir() + "/tw-brand-",
      ),
      MAX_UPLOAD_MB: 1,
    });
    app = running.server;
  });
  afterAll(() => running?.close());

  const call = (
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: object,
    signedIn = true,
  ) =>
    app.inject({
      method,
      url: `/tickvana/api/core${url}`,
      payload,
      headers: { origin: ORIGIN, ...(signedIn && cookie ? { cookie } : {}) },
    });

  it("sets up the first admin once, signed in, with branding", async () => {
    expect((await call("GET", "/setup")).json()).toEqual({ needed: true });
    const body = {
      email: "Chef@Example.org",
      displayName: "Chefin",
      password: "ein langes passwort",
      locale: "de",
      productName: "Werkbank",
      accent: "#ff7a00",
    };
    expect(
      (await call("POST", "/setup", { ...body, password: "kurz" })).statusCode,
    ).toBe(400);

    const done = await call("POST", "/setup", body);
    expect(done.statusCode).toBe(201);
    cookie = [done.headers["set-cookie"] ?? []]
      .flat()
      .find((c) => c.startsWith("tvn_session="))!
      .split(";")[0]!;
    expect((await call("GET", "/auth/me")).json()).toMatchObject({
      email: "chef@example.org",
      locale: "de",
    });
    expect((await call("GET", "/permissions/global")).statusCode).toBe(200);
    expect((await call("GET", "/branding")).json()).toMatchObject({
      productName: "Werkbank",
      accent: "#ff7a00",
    });

    expect((await call("GET", "/setup")).json()).toEqual({ needed: false });
    expect(
      (await call("POST", "/setup", { ...body, email: "zweiter@example.org" }))
        .statusCode,
    ).toBe(409);
    expect(
      await t.db.selectFrom("core_user").select("id").execute(),
    ).toHaveLength(1);
  });

  it("serves branding to everyone and lets only admins change it", async () => {
    const anon = await call("GET", "/branding", undefined, false);
    expect(anon.statusCode).toBe(200);
    expect(anon.json()).not.toHaveProperty("customCss");
    expect(
      (await call("PUT", "/branding", { productName: "Nein" }, false))
        .statusCode,
    ).toBe(401);
    expect(
      (await call("GET", "/branding/custom-css", undefined, false)).statusCode,
    ).toBe(401);

    const put = await call("PUT", "/branding", {
      footerText: "Intern",
      customCss: ".logo{height:20px}",
    });
    expect(put.json()).toMatchObject({
      productName: "Werkbank",
      accent: "#ff7a00",
      footerText: "Intern",
    });
    expect(
      (await call("PUT", "/branding", { accent: "orange" })).statusCode,
    ).toBe(400);

    const css = await call("GET", "/branding.css", undefined, false);
    expect(css.headers["content-type"]).toContain("text/css");
    expect(css.body).toContain("--brand-accent:#ff7a00");
    expect(css.body).toContain(".logo{height:20px}");
    expect((await call("GET", "/branding/custom-css")).json().customCss).toBe(
      ".logo{height:20px}",
    );
  });

  it("takes a logo upload from admins and shows it to everyone", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const upload = async (slot: string, signedIn = true) => {
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(png)], { type: "image/png" }),
        "logo.png",
      );
      const body = new Response(form);
      return app.inject({
        method: "POST",
        url: `/tickvana/api/core/attachments?ownerType=branding&ownerId=${slot}`,
        payload: Buffer.from(await body.arrayBuffer()),
        headers: {
          "content-type": body.headers.get("content-type")!,
          origin: ORIGIN,
          ...(signedIn ? { cookie } : {}),
        },
      });
    };
    expect((await upload("logo-light", false)).statusCode).toBe(401);
    expect((await upload("something-else")).statusCode).toBe(403);
    const first = (await upload("logo-light")).json();
    const second = (await upload("logo-light")).json();
    expect(first.id).not.toBe(second.id);

    const branding = (await call("GET", "/branding", undefined, false)).json();
    expect(branding.logoLightUrl).toBe(
      `/tickvana/api/core/attachments/${second.id}`,
    );
    expect(branding.logoDarkUrl).toBeNull();
    const image = await app.inject(branding.logoLightUrl);
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
  });
});
