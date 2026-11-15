// Business time: working hours per weekday in a calendar's time zone, minus
// holidays. Pure functions, so the SLA engine can be tested by travelling
// through time (weekends, holidays, daylight saving changes).

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof DAYS)[number];

export interface Calendar {
  /** IANA name, e.g. "Europe/Berlin". */
  timezone: string;
  /** Working intervals per weekday as "HH:MM" pairs in local time. */
  hours: Partial<Record<Weekday, [string, string][]>>;
  /** Local dates ("YYYY-MM-DD") without working time. */
  holidays: string[];
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string) {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a time zone. */
function local(at: Date, timezone: string) {
  const p = Object.fromEntries(
    formatter(timezone)
      .formatToParts(at)
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return {
    y: p.year!,
    m: p.month!,
    d: p.day!,
    h: p.hour!,
    min: p.minute!,
    s: p.second!,
  };
}

/** Milliseconds the zone is ahead of UTC at an instant. */
function offset(at: Date, timezone: string) {
  const l = local(at, timezone);
  return (
    Date.UTC(l.y, l.m - 1, l.d, l.h, l.min, l.s) -
    Math.floor(at.getTime() / 1000) * 1000
  );
}

/** The instant at which the zone's clock shows this local date and minute of the day. */
export function zoned(
  y: number,
  m: number,
  d: number,
  minuteOfDay: number,
  timezone: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  let at = guess - offset(new Date(guess), timezone);
  // Around a daylight saving change the offset at the result can differ from the guess.
  at = guess - offset(new Date(at), timezone);
  return new Date(at);
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};
const dateKey = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Working intervals of one local day, as instants. */
function intervals(
  cal: Calendar,
  y: number,
  m: number,
  d: number,
): [Date, Date][] {
  if (cal.holidays.includes(dateKey(y, m, d))) return [];
  const weekday = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
  return (cal.hours[weekday] ?? []).map(([from, to]) => [
    zoned(y, m, d, minutes(from), cal.timezone),
    zoned(y, m, d, minutes(to), cal.timezone),
  ]);
}

/** Local days from the one containing `from`, one after another. */
function* days(cal: Calendar, from: Date) {
  const l = local(from, cal.timezone);
  const day = new Date(Date.UTC(l.y, l.m - 1, l.d));
  // ten years without a single working minute ends the search
  for (let i = 0; i < 3660; i++) {
    yield [
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
    ] as const;
    day.setUTCDate(day.getUTCDate() + 1);
  }
}

/** The instant after `ms` of working time from `start`. */
export function addBusinessTime(cal: Calendar, start: Date, ms: number): Date {
  let left = ms;
  for (const [y, m, d] of days(cal, start)) {
    for (const [a, b] of intervals(cal, y, m, d)) {
      const from = Math.max(a.getTime(), start.getTime());
      if (from >= b.getTime()) continue;
      if (from + left <= b.getTime()) return new Date(from + left);
      left -= b.getTime() - from;
    }
  }
  throw new Error("The calendar has no working time");
}

/** Working time between two instants, in milliseconds. */
export function businessTimeBetween(cal: Calendar, a: Date, b: Date): number {
  if (b <= a) return 0;
  let total = 0;
  for (const [y, m, d] of days(cal, a)) {
    const list = intervals(cal, y, m, d);
    if (list.length && list[0]![0] >= b) break;
    for (const [from, to] of list) {
      const s = Math.max(from.getTime(), a.getTime());
      const e = Math.min(to.getTime(), b.getTime());
      if (e > s) total += e - s;
    }
    if (zoned(y, m, d, 24 * 60, cal.timezone) >= b) break;
  }
  return total;
}
