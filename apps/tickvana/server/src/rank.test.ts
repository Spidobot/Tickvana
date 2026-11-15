import { expect, it } from "vitest";
import { rankAfter, rankBetween, spreadRanks } from "./rank.js";

it("finds a rank between two others", () => {
  expect(rankBetween("", null)).toBe("i");
  for (const [a, b] of [
    ["", "1"],
    ["a", "b"],
    ["a", "a1"],
    ["az", "b"],
    ["5", null],
    ["zzz", null],
    ["", "00001"],
    ["m", "n"],
  ] as const) {
    const mid = rankBetween(a, b)!;
    expect(mid, `${a}..${b}`).not.toBeNull();
    expect(mid > a, `${mid} > ${a}`).toBe(true);
    if (b !== null) expect(mid < b, `${mid} < ${b}`).toBe(true);
  }
});

it("says when nothing fits", () => {
  expect(rankBetween("m", "m")).toBeNull();
  expect(rankBetween("n", "m")).toBeNull();
  expect(rankBetween("m", "m0")).toBeNull();
  expect(rankBetween("", "0")).toBeNull();
});

it("survives a thousand moves into the same gap, staying ordered", () => {
  // The worst case: always insert right after the first item.
  const low = "";
  let high: string | null = "i";
  const seen: string[] = [];
  for (let i = 0; i < 1000; i++) {
    const mid: string = rankBetween(low, high)!;
    expect(mid > low && mid < high!).toBe(true);
    seen.push(mid);
    high = mid;
  }
  // Lengths grow slowly (about one character per five moves into one gap).
  expect(Math.max(...seen.map((s) => s.length))).toBeLessThan(250);
  // And appending at the end stays short forever.
  let end = "";
  for (let i = 0; i < 10_000; i++) {
    const next = rankAfter(end);
    expect(next > end).toBe(true);
    end = next;
  }
  expect(end.length).toBeLessThan(10);
});

it("counts up for appending, growing only after the last digit", () => {
  expect(rankAfter("")).toBe("i00000");
  expect(rankAfter("a")).toBe("b");
  expect(rankAfter("az")).toBe("b0");
  expect(rankAfter("zz")).toBe("zzi00000");
  // There is still room before the next one.
  expect(rankBetween("a", rankAfter("a"))).not.toBeNull();
});

it("spreads ranks evenly, same length, in order", () => {
  for (const n of [0, 1, 7, 1000, 50_000]) {
    const ranks = spreadRanks(n);
    expect(ranks).toHaveLength(n);
    expect([...ranks].sort()).toEqual(ranks);
    expect(new Set(ranks.map((r) => r.length)).size).toBeLessThanOrEqual(1);
    expect(new Set(ranks).size).toBe(n);
  }
  // Room in every gap afterwards.
  const [a, b] = spreadRanks(2);
  expect(rankBetween(a!, b!)).not.toBeNull();
  expect(rankBetween("", a!)).not.toBeNull();
});
