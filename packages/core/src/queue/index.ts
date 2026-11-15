// Events and background jobs. See CONCEPT.md §2 "Ein Mechanismus für alles Nachgelagerte".
//
// emit() writes the event and one job per interested subscriber in the caller's
// transaction, so follow-up work exists exactly when the change is committed.
// Workers claim jobs with a conditional UPDATE that works on every database.
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { uuidv7 } from "../db/id.js";
import type { CoreDb } from "../schema.js";

export interface NewEvent {
  /** Dotted name, e.g. "issue.created". */
  type: string;
  actorId: string | null;
  entityType: string;
  entityId: string;
  payload?: unknown;
}

export interface StoredEvent extends Required<NewEvent> {
  id: string;
  createdAt: Date;
}

type JobHandler = (payload: unknown) => Promise<void>;
type EventHandler = (event: StoredEvent) => Promise<void>;

export interface QueueOptions {
  /** Shown in core_job.locked_by. */
  workerId?: string;
  pollMs?: number;
  /** Jobs run at the same time by this worker. */
  concurrency?: number;
  /** Attempts before a job is marked failed. */
  maxAttempts?: number;
  /** A running job whose worker has been silent this long is handed out again. */
  staleLockMs?: number;
  /** Delay before attempt n+1. */
  backoffMs?: (attempts: number) => number;
  onError?: (error: unknown, job: { id: string; type: string }) => void;
}

export interface Queue {
  /** Records an event. Pass the transaction of the change it describes. */
  emit(trx: Kysely<CoreDb>, event: NewEvent): Promise<string>;
  /** Subscribes to events. `types`: exact names, "issue.*" prefixes, or "*". `name` must be stable and unique. */
  on(name: string, types: string[], handler: EventHandler): void;
  /** Registers the handler for a job type. */
  job(type: string, handler: JobHandler): void;
  enqueue(
    trx: Kysely<CoreDb>,
    type: string,
    payload: unknown,
    runAt?: Date,
  ): Promise<string>;
  /** Runs `handler` about every `everyMs`, on one worker at a time across all containers. */
  every(name: string, everyMs: number, handler: () => Promise<void>): void;
  /** Claims and runs due jobs once. Returns how many ran. `start()` calls this in a loop. */
  runDue(now?: Date): Promise<number>;
  start(): Promise<void>;
  /** Stops polling and waits for running jobs. */
  stop(): Promise<void>;
}

const matches = (pattern: string, type: string) =>
  pattern === "*" ||
  pattern === type ||
  (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1)));

export function createQueue(
  db: Kysely<CoreDb>,
  options: QueueOptions = {},
): Queue {
  const workerId = options.workerId ?? randomUUID();
  const pollMs = options.pollMs ?? 1000;
  const concurrency = options.concurrency ?? 5;
  const maxAttempts = options.maxAttempts ?? 5;
  const staleLockMs = options.staleLockMs ?? 10 * 60_000;
  const backoffMs =
    options.backoffMs ?? ((attempts) => 10_000 * 2 ** (attempts - 1));
  const onError = options.onError ?? (() => {});

  const handlers = new Map<string, JobHandler>();
  const subscribers: { jobType: string; types: string[] }[] = [];
  const recurring = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  const self: Queue = {
    async emit(trx, event) {
      const id = uuidv7();
      const now = new Date();
      await trx
        .insertInto("core_event")
        .values({
          id,
          type: event.type,
          actor_id: event.actorId,
          entity_type: event.entityType,
          entity_id: event.entityId,
          payload_json: JSON.stringify(event.payload ?? null),
          created_at: now,
        })
        .execute();
      // ponytail: only subscribers of the emitting app get a job. If Nuvenna ever
      // has to react to Tickvana events, fan out from a dispatcher job instead.
      const interested = subscribers.filter((s) =>
        s.types.some((p) => matches(p, event.type)),
      );
      if (interested.length > 0) {
        await trx
          .insertInto("core_job")
          .values(
            interested.map((s) => ({
              id: uuidv7(),
              type: s.jobType,
              payload_json: JSON.stringify({ eventId: id }),
              run_at: now,
              state: "pending" as const,
              attempts: 0,
              locked_by: null,
              locked_at: null,
              last_error: null,
              created_at: now,
            })),
          )
          .execute();
      }
      return id;
    },

    on(name, types, handler) {
      const jobType = `event:${name}`;
      self.job(jobType, async (payload) => {
        const { eventId } = payload as { eventId: string };
        const e = await db
          .selectFrom("core_event")
          .selectAll()
          .where("id", "=", eventId)
          .executeTakeFirst();
        if (!e) return; // event purged before delivery
        await handler({
          id: e.id,
          type: e.type,
          actorId: e.actor_id,
          entityType: e.entity_type,
          entityId: e.entity_id,
          payload: JSON.parse(e.payload_json),
          createdAt: e.created_at,
        });
      });
      subscribers.push({ jobType, types });
    },

    job(type, handler) {
      if (handlers.has(type))
        throw new Error(`Job type "${type}" already has a handler`);
      handlers.set(type, handler);
    },

    async enqueue(trx, type, payload, runAt) {
      const id = uuidv7();
      const now = new Date();
      await trx
        .insertInto("core_job")
        .values({
          id,
          type,
          payload_json: JSON.stringify(payload ?? null),
          run_at: runAt ?? now,
          state: "pending",
          attempts: 0,
          locked_by: null,
          locked_at: null,
          last_error: null,
          created_at: now,
        })
        .execute();
      return id;
    },

    every(name, everyMs, handler) {
      // The job row's id is derived from the name, so the primary key keeps it single.
      const id = `every:${name}`;
      if (id.length > 36)
        throw new Error(`Recurring job name "${name}" is too long`);
      self.job(id, handler);
      recurring.set(id, everyMs);
    },

    async runDue(now = new Date()) {
      const types = [...handlers.keys()];
      if (types.length === 0) return 0;

      // Bookkeeping must not fail just because the database picked this
      // statement as a deadlock victim: a lost "done" would run the job again.
      const persist = async (
        jobId: string,
        values: Partial<CoreDb["core_job"]>,
      ) => {
        for (let attempt = 1; ; attempt++) {
          try {
            await db
              .updateTable("core_job")
              .set(values)
              .where("id", "=", jobId)
              .execute();
            return;
          } catch (error) {
            if (attempt === 5) throw error;
            await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
          }
        }
      };

      // Hand out jobs again whose worker died mid-run. Read first, then update
      // by primary key: a range UPDATE would take gap locks on MariaDB and
      // deadlock with the single-row updates of running workers.
      const stale = await db
        .selectFrom("core_job")
        .select("id")
        .where("state", "=", "running")
        .where("locked_at", "<", new Date(now.getTime() - staleLockMs))
        .execute();
      for (const { id } of stale) {
        await db
          .updateTable("core_job")
          .set({ state: "pending", locked_by: null, locked_at: null })
          .where("id", "=", id)
          .where("state", "=", "running")
          .where("locked_at", "<", new Date(now.getTime() - staleLockMs))
          .execute();
      }

      const due = await db
        .selectFrom("core_job")
        .select(["id", "type", "payload_json", "attempts"])
        .where("state", "=", "pending")
        .where("run_at", "<=", now)
        .where("type", "in", types)
        .orderBy("run_at")
        .limit(concurrency * 4)
        .execute();

      let ran = 0;
      const runOne = async (job: (typeof due)[number]) => {
        // The claim: only one worker's UPDATE finds the row still pending.
        // If the claim itself errors, the job stays pending for the next poll.
        const claim = await db
          .updateTable("core_job")
          .set({ state: "running", locked_by: workerId, locked_at: now })
          .where("id", "=", job.id)
          .where("state", "=", "pending")
          .executeTakeFirst()
          .catch((error: unknown) => {
            onError(error, job);
            return undefined;
          });
        if (claim?.numUpdatedRows !== 1n) return;
        ran++;

        const everyMs = recurring.get(job.type);
        let failure: { error: unknown } | undefined;
        try {
          await handlers.get(job.type)!(JSON.parse(job.payload_json));
        } catch (error) {
          failure = { error };
          onError(error, job);
        }

        // Handler outcome and bookkeeping are separate: a bookkeeping error
        // never turns a finished job into a retry.
        try {
          if (!failure) {
            await persist(
              job.id,
              everyMs
                ? {
                    state: "pending",
                    run_at: new Date(Date.now() + everyMs),
                    attempts: 0,
                    last_error: null,
                    locked_by: null,
                    locked_at: null,
                  }
                : { state: "done", locked_by: null, locked_at: null },
            );
            return;
          }
          const { error } = failure;
          const attempts = job.attempts + 1;
          // A recurring job never dies: it simply runs again at its next slot.
          const retry = everyMs !== undefined || attempts < maxAttempts;
          await persist(job.id, {
            state: retry ? "pending" : "failed",
            attempts: everyMs ? 0 : attempts,
            run_at: new Date(Date.now() + (everyMs ?? backoffMs(attempts))),
            last_error: String(
              error instanceof Error ? (error.stack ?? error.message) : error,
            ).slice(0, 4000),
            locked_by: null,
            locked_at: null,
          });
        } catch (error) {
          // Still "running" in the table: the stale-lock recovery picks it up.
          onError(error, job);
        }
      };

      const pending = [...due];
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          for (let job = pending.shift(); job; job = pending.shift())
            await runOne(job);
        }),
      );
      return ran;
    },

    async start() {
      const now = new Date();
      for (const id of recurring.keys()) {
        const exists = await db
          .selectFrom("core_job")
          .select("id")
          .where("id", "=", id)
          .executeTakeFirst();
        if (exists) continue;
        await db
          .insertInto("core_job")
          .values({
            id,
            type: id,
            payload_json: "null",
            run_at: now,
            state: "pending",
            attempts: 0,
            locked_by: null,
            locked_at: null,
            last_error: null,
            created_at: now,
          })
          .execute()
          .catch(() => {}); // another container inserted it first
      }

      running = true;
      const tick = () => {
        if (!running) return;
        inFlight = self
          .runDue()
          .catch((error) => onError(error, { id: "", type: "poll" }))
          // Keep draining while there is work, otherwise wait for the next poll.
          .then((ran) => {
            if (running) timer = setTimeout(tick, ran ? 0 : pollMs);
          });
      };
      tick();
    },

    async stop() {
      running = false;
      clearTimeout(timer);
      await inFlight;
    },
  };
  return self;
}
