import { existsSync, readFileSync } from "node:fs";
import { AppError, type AppDefinition } from "@tvn/core";
import { issueTarget } from "./access.js";
import { createTrackContext } from "./context.js";
import { migrateTrack } from "./db/migrations/index.js";
import { automationRoutes, createAutomation } from "./automation.js";
import { createIssueService } from "./issues.js";
import { installTrackNotifications } from "./notifications.js";
import { installTrackQueryTables } from "./query-tables.js";
import { boardRoutes } from "./routes/boards.js";
import { installBulk } from "./routes/bulk.js";
import { fieldRoutes } from "./routes/fields.js";
import { importExportRoutes } from "./routes/import-export.js";
import { issuePartRoutes } from "./routes/issue-parts.js";
import { masterDataRoutes } from "./routes/master-data.js";
import { portalRoutes } from "./routes/portal.js";
import { queueRoutes } from "./routes/queues.js";
import { createSla, slaRoutes } from "./sla.js";
import { slaAdminRoutes } from "./routes/sla-admin.js";
import { createMailInbox, mailChannelRoutes } from "./mail-inbox.js";
import { installApprovals } from "./approvals.js";
import { customerRoutes } from "./routes/customers.js";
import { installSatisfaction } from "./satisfaction.js";
import { requestTypeRoutes } from "./routes/request-types.js";
import { schemeRoutes } from "./routes/schemes.js";
import { workflowEditorRoutes } from "./routes/workflow-editor.js";
import { issueRoutes } from "./routes/issues.js";
import { metaRoutes } from "./routes/meta.js";
import { projectRoutes } from "./routes/projects.js";
import { rankRoutes } from "./routes/rank.js";
import { sprintRoutes } from "./routes/sprints.js";
import { reportRoutes } from "./routes/reports.js";
import { epicRoutes } from "./routes/epics.js";
import { searchRoutes } from "./routes/search.js";
import { backlinkRoutes } from "./routes/backlinks.js";
import { workflowRoutes } from "./routes/workflows.js";
import { createWorkflowService } from "./workflow.js";

// The app's package.json: next to dist/ when built (and in the image), two
// levels up from server/src when tests run the sources.
const { version } = JSON.parse(
  readFileSync(
    ["../package.json", "../../package.json"]
      .map((p) => new URL(p, import.meta.url))
      .find((u) => existsSync(u))!,
    "utf8",
  ),
) as { version: string };

/** What makes this app: name, path and routes. Used by the server and by the API client generator. */
export const definition: AppDefinition = {
  name: "tickvana",
  brand: { productName: "Tickvana", accent: "#4f6bff" },
  version,
  prefix: "/tickvana",
  migrate: migrateTrack,
  routes: (app) => {
    const ctx = createTrackContext(app);
    const issues = createIssueService(ctx);
    const workflows = createWorkflowService(ctx, issues);
    const automation = createAutomation(ctx, app, issues, workflows);
    const sla = createSla(ctx, app);
    createMailInbox(ctx, app, issues);
    installTrackNotifications(ctx, app);
    installTrackQueryTables(ctx, app);
    // Files on a ticket follow the ticket: who may see it may read them,
    // who may attach may add and remove them.
    const ticket = (id: string) =>
      ctx.db
        .selectFrom("track_issue")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
    app.attachments.registerOwner("issue", {
      canRead: async (user, id) => {
        const issue = await ticket(id);
        return (
          issue !== undefined &&
          ctx.access.can(user, "project.browse", issueTarget(issue))
        );
      },
      canWrite: async (user, id) => {
        const issue = await ticket(id);
        return (
          issue !== undefined &&
          ctx.access.can(user, "issue.attach", issueTarget(issue))
        );
      },
    });
    return async (scope) => {
      // Customers reach only routes marked for them (CONCEPT.md §5: "Kunden sehen nur das Portal").
      scope.addHook("onRequest", async (req) => {
        if (req.user?.kind === "customer" && !req.routeOptions.config.customers)
          throw new AppError(404, "not_found", "Not found");
      });
      await metaRoutes(scope, ctx);
      await masterDataRoutes(scope, ctx);
      await schemeRoutes(scope, ctx);
      await requestTypeRoutes(scope, ctx);
      await portalRoutes(scope, ctx, app, issues);
      await queueRoutes(scope, ctx, app);
      await slaRoutes(scope, issues, sla);
      await slaAdminRoutes(scope, ctx);
      await mailChannelRoutes(scope, ctx, app);
      installApprovals(scope, ctx, app, issues);
      await customerRoutes(scope, ctx);
      installSatisfaction(scope, ctx, app, issues);
      await projectRoutes(scope, ctx);
      await fieldRoutes(scope, ctx);
      await issueRoutes(scope, issues);
      await backlinkRoutes(scope, ctx, issues);
      await workflowRoutes(scope, ctx, workflows);
      await workflowEditorRoutes(scope, ctx, workflows);
      await issuePartRoutes(scope, ctx, issues);
      await rankRoutes(scope, ctx, issues);
      await boardRoutes(scope, ctx, app, issues, workflows);
      await sprintRoutes(scope, ctx, app, issues);
      await reportRoutes(scope, ctx, app);
      await epicRoutes(scope, ctx);
      await searchRoutes(scope, ctx);
      await automationRoutes(scope, ctx, app, issues, automation);
      await importExportRoutes(scope, ctx, issues);
      installBulk(scope, ctx, issues, workflows);
    };
  },
};
