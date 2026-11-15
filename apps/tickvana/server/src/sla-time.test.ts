import { describe, expect, it } from "vitest";
import {
  addBusinessTime,
  businessTimeBetween,
  zoned,
  type Calendar,
} from "./sla-time.js";

const week: [string, string][] = [["09:00", "17:00"]];
const berlin: Calendar = {
  timezone: "Europe/Berlin",
  hours: { mon: week, tue: week, wed: week, thu: week, fri: week },
  holidays: ["2026-12-24", "2026-12-25"],
};
const h = 3600_000;
const at = (iso: string) => new Date(iso);

describe("business time", () => {
  it("finds local wall-clock instants in summer and winter", () => {
    expect(zoned(2026, 7, 1, 9 * 60, "Europe/Berlin").toISOString()).toBe(
      "2026-07-01T07:00:00.000Z",
    );
    expect(zoned(2026, 12, 1, 9 * 60, "Europe/Berlin").toISOString()).toBe(
      "2026-12-01T08:00:00.000Z",
    );
  });

  it("counts within one day and stops at closing time", () => {
    // Monday 2026-11-16, 10:00 Berlin = 09:00 UTC; four hours later: 14:00.
    expect(
      addBusinessTime(berlin, at("2026-11-16T09:00:00Z"), 4 * h).toISOString(),
    ).toBe("2026-11-16T13:00:00.000Z");
    // Six hours from 15:00 run into Tuesday: two today, four from 09:00.
    expect(
      addBusinessTime(berlin, at("2026-11-16T14:00:00Z"), 6 * h).toISOString(),
    ).toBe("2026-11-17T12:00:00.000Z");
  });

  it("skips the weekend", () => {
    // Friday 16:00 + 2 h: one hour Friday, one hour Monday from 09:00.
    expect(
      addBusinessTime(berlin, at("2026-11-20T15:00:00Z"), 2 * h).toISOString(),
    ).toBe("2026-11-23T09:00:00.000Z");
    // Started on Saturday: the clock begins Monday 09:00.
    expect(
      addBusinessTime(berlin, at("2026-11-21T10:00:00Z"), 1 * h).toISOString(),
    ).toBe("2026-11-23T09:00:00.000Z");
    expect(
      businessTimeBetween(
        berlin,
        at("2026-11-20T15:00:00Z"),
        at("2026-11-23T09:00:00Z"),
      ),
    ).toBe(2 * h);
  });

  it("skips holidays", () => {
    // Wednesday 23 Dec 16:00 + 2 h: one hour that day, 24th and 25th are holidays, weekend, Monday 28th.
    expect(
      addBusinessTime(berlin, at("2026-12-23T15:00:00Z"), 2 * h).toISOString(),
    ).toBe("2026-12-28T09:00:00.000Z");
  });

  it("keeps working hours in local time across daylight saving changes", () => {
    // Friday 23 Oct 2026, 16:00 CEST (14:00 UTC) + 2 h: clocks go back on Sunday 25 Oct.
    // Monday 26 Oct 09:00 is CET, i.e. 08:00 UTC; one hour later 09:00 UTC.
    expect(
      addBusinessTime(berlin, at("2026-10-23T14:00:00Z"), 2 * h).toISOString(),
    ).toBe("2026-10-26T09:00:00.000Z");
    // Spring: Friday 27 Mar 2026 16:00 CET (15:00 UTC); Monday 30 Mar 09:00 CEST = 07:00 UTC.
    expect(
      addBusinessTime(berlin, at("2026-03-27T15:00:00Z"), 2 * h).toISOString(),
    ).toBe("2026-03-30T08:00:00.000Z");
    // A full working week is 40 h, also in the week the clocks change.
    expect(
      businessTimeBetween(
        berlin,
        at("2026-10-24T00:00:00Z"),
        at("2026-10-31T00:00:00Z"),
      ),
    ).toBe(40 * h);
  });

  it("works in other zones and round the clock", () => {
    const tokyo: Calendar = {
      timezone: "Asia/Tokyo",
      hours: Object.fromEntries(
        ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [
          d,
          [["00:00", "24:00"]],
        ]),
      ),
      holidays: [],
    };
    expect(
      addBusinessTime(tokyo, at("2026-11-21T10:00:00Z"), 30 * h).toISOString(),
    ).toBe("2026-11-22T16:00:00.000Z");
    expect(() =>
      addBusinessTime(
        { timezone: "UTC", hours: {}, holidays: [] },
        at("2026-01-01T00:00:00Z"),
        h,
      ),
    ).toThrow(/no working time/);
  });
});
