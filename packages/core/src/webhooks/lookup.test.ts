import { describe, expect, it } from "vitest";
import { guardedLookup, resolvePublicHost } from "./index.js";

const look = (allowPrivate: boolean, host: string) =>
  new Promise<string>((resolve, reject) =>
    guardedLookup(allowPrivate)(host, {}, (err, address) =>
      err ? reject(err) : resolve(String(address)),
    ),
  );

describe("connecting only to checked addresses (S-1)", () => {
  it("refuses names that resolve into the private network at connect time", async () => {
    await expect(look(false, "localhost")).rejects.toThrow(/private network/);
    expect(await look(true, "localhost")).toMatch(/^(127\.0\.0\.1|::1)$/);
  });

  it("hands out the address it checked", async () => {
    await expect(resolvePublicHost("127.0.0.1", false)).rejects.toThrow(
      /private network/,
    );
    await expect(resolvePublicHost("localhost", false)).rejects.toThrow(
      /private network/,
    );
    expect(await resolvePublicHost("10.1.2.3", true)).toBe("10.1.2.3");
    expect(await resolvePublicHost("93.184.215.14", false)).toBe(
      "93.184.215.14",
    );
  });
});
