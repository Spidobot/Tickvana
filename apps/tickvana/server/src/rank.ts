// Manual order of tickets (backlog, board columns) as strings: moving one
// ticket writes one row. A new rank lies between its neighbours'.
// Alphabet 0-9a-z: byte order and every database collation agree on it.
import type { Kysely } from "kysely";
import type { TrackDb } from "./db/schema.js";

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
/** Ranks longer than this trigger a rebalance. */
export const MAX_RANK_LENGTH = 48;

/**
 * A string strictly between `a` and `b` in byte order. `a` = "" is the start,
 * `b` = null the end. Returns null when nothing fits between them (equal
 * ranks, or `b` extends `a` by zeros only): then rebalance.
 */
export function rankBetween(a: string, b: string | null): string | null {
  if (b !== null && a >= b) return null;
  let prefix = "";
  let upper = b;
  for (let i = 0; ; i++) {
    const low = i < a.length ? DIGITS.indexOf(a[i]!) : 0;
    if (upper !== null && i >= upper.length) return null;
    const high = upper === null ? BASE : DIGITS.indexOf(upper[i]!);
    if (high - low > 1) return prefix + DIGITS[Math.floor((low + high) / 2)];
    prefix += DIGITS[low];
    // The prefix is now below `upper`: from here on there is no upper bound.
    if (high - low === 1) upper = null;
  }
}

/**
 * The next rank after `a` for appending: counts up at the same length, so a
 * long backlog of new tickets stays short. Only after "zzz…" does it grow.
 */
export function rankAfter(a: string): string {
  const digits = [...a].map((c) => DIGITS.indexOf(c));
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i]! < BASE - 1) {
      digits[i]! += 1;
      return digits.map((d) => DIGITS[d]).join("");
    }
    digits[i] = 0;
  }
  return a + "i00000";
}

/** Evenly spaced ranks of one length, for a fresh start. */
export function spreadRanks(count: number): string[] {
  const width = Math.max(
    4,
    Math.ceil(Math.log(count + 2) / Math.log(BASE)) + 2,
  );
  const step = Math.floor(BASE ** width / (count + 1));
  return Array.from({ length: count }, (_, i) =>
    ((i + 1) * step).toString(BASE).padStart(width, "0"),
  );
}

/**
 * Gives every ticket a fresh rank, keeping the current order. Rare: only
 * after many moves into the same gap.
 */
export async function rebalance(db: Kysely<TrackDb>): Promise<void> {
  // ponytail: one UPDATE per ticket across the installation. Fine for tens of thousands; batch with CASE if it gets slow.
  await db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom("track_issue")
      .select("id")
      .orderBy("rank")
      .orderBy("id")
      .execute();
    const ranks = spreadRanks(rows.length);
    for (const [i, row] of rows.entries()) {
      await trx
        .updateTable("track_issue")
        .set({ rank: ranks[i]! })
        .where("id", "=", row.id)
        .execute();
    }
  });
}

/** Rank for a new ticket: after every existing one. */
export async function rankAtEnd(db: Kysely<TrackDb>): Promise<string> {
  const last = await db
    .selectFrom("track_issue")
    .select("rank")
    .orderBy("rank", "desc")
    .limit(1)
    .executeTakeFirst();
  return rankAfter(last?.rank ?? "");
}

/**
 * Puts a ticket between two others (ids; either may be missing at the start
 * or end of the list). Rebalances once when the gap is used up. Returns the
 * new rank, or null when the neighbours are in the wrong order (stale view).
 */
export async function placeBetween(
  db: Kysely<TrackDb>,
  issueId: string,
  afterId?: string,
  beforeId?: string,
): Promise<string | null> {
  const rankOf = async (id: string | undefined) =>
    id
      ? (
          await db
            .selectFrom("track_issue")
            .select("rank")
            .where("id", "=", id)
            .executeTakeFirstOrThrow()
        ).rank
      : undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const low = (await rankOf(afterId)) ?? "";
    const high = (await rankOf(beforeId)) ?? null;
    if (high !== null && low > high) return null;
    const rank = rankBetween(low, high);
    if (rank && rank.length <= MAX_RANK_LENGTH) {
      await db
        .updateTable("track_issue")
        .set({ rank })
        .where("id", "=", issueId)
        .execute();
      return rank;
    }
    await rebalance(db);
  }
  return null;
}
