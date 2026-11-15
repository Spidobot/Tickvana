import {
  AppError,
  getSetting,
  type AppContext,
  type AuthUser,
  type CoreDb,
  type NewEvent,
  type Permissions,
  type Queue,
} from "@tvn/core";
import type { Kysely } from "kysely";
import { z } from "zod";
import {
  installTrackAccess,
  type ProjectPermission,
  type TrackAccess,
} from "./access.js";
import {
  DEFAULTS_SETTING,
  type TrackDefaults,
} from "./db/migrations/0002_seed.js";
import type { TrackDb } from "./db/schema.js";

/** What Tickvana's routes and services work with. Built once per process. */
export interface TrackContext {
  db: Kysely<TrackDb>;
  access: TrackAccess;
  permissions: Permissions;
  queue: Queue;
  /** Records an event in the transaction of the change it describes. */
  emit(trx: Kysely<TrackDb>, event: NewEvent): Promise<string>;
  /** Ids of the seeded workflow, layout, schemes and roles. */
  defaults(): Promise<TrackDefaults>;
  /**
   * Loads a project by key for a request. Unknown projects and projects the
   * user may not browse both answer 404, so keys cannot be probed. A missing
   * `permission` on a visible project answers 403.
   */
  project(
    user: AuthUser | null,
    key: string,
    permission?: ProjectPermission,
  ): Promise<TrackDb["track_project"]>;
}

const defaultsSchema = z.custom<TrackDefaults>(
  (v) => typeof v === "object" && v !== null && "workflowId" in v,
);

export function createTrackContext(app: AppContext): TrackContext {
  // Same connection, seen with Tickvana's tables as well.
  const db = app.database.db as unknown as Kysely<TrackDb>;
  const access = installTrackAccess(app.permissions, db);
  let cached: TrackDefaults | undefined;

  return {
    db,
    access,
    permissions: app.permissions,
    queue: app.queue,
    emit: (trx, event) =>
      app.queue.emit(trx as unknown as Kysely<CoreDb>, event),
    async defaults() {
      cached ??= await getSetting(db, DEFAULTS_SETTING, defaultsSchema);
      return cached;
    },
    async project(user, key, permission) {
      const project = await db
        .selectFrom("track_project")
        .selectAll()
        .where("key", "=", key.toUpperCase())
        .executeTakeFirst();
      if (
        !project ||
        !(await access.can(user, "project.browse", { projectId: project.id }))
      ) {
        throw user
          ? new AppError(404, "not_found", "Not found")
          : new AppError(401, "unauthenticated", "Sign in required");
      }
      if (permission)
        await access.require(user, permission, { projectId: project.id });
      return project;
    },
  };
}
