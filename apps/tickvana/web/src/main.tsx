import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import {
  BrandingSettings,
  Dashboards,
  Frame,
  mountApp,
  SystemSettings,
  useApp,
} from "@tvn/ui";
import "@tvn/ui/styles.css";
import { useTranslation } from "react-i18next";
import { IssuePage, ProjectPage, ProjectsPage, useNav } from "./pages.js";
import { QueriesPage } from "./queries.js";
import { BoardPage } from "./board.js";
import { BacklogPage } from "./backlog.js";
import { ReportsPage } from "./reports.js";
import * as texts from "./texts.js";
import { AdminFrame, MasterDataPage } from "./admin.js";
import { FieldsAdminPage } from "./fields-admin.js";
import { PermissionsAdminPage } from "./permissions-admin.js";
import { AutomationsAdminPage } from "./automations-admin.js";
import { WorkflowsAdminPage } from "./workflows-admin.js";
import { QueuesPage } from "./queues.js";
import { CustomersAdminPage } from "./customers-admin.js";
import {
  PortalHome,
  PortalNew,
  PortalRequest,
  PortalRequests,
  PortalSignup,
  PortalSignupLink,
  PortalArticle,
} from "./portal.js";

function BrandingPage() {
  const { t } = useTranslation();
  return (
    <AdminFrame title={t("branding.title")}>
      <BrandingSettings />
    </AdminFrame>
  );
}

function SystemPage() {
  const { t } = useTranslation();
  return (
    <AdminFrame title={t("system.title")}>
      <SystemSettings />
    </AdminFrame>
  );
}

function DashboardsRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { id?: string };
  return (
    <Frame title={t("dashboard.heading")} sections={useNav()}>
      <Dashboards
        selected={params.id}
        onOpen={(id) =>
          void navigate({ to: "/dashboards/$id", params: { id } })
        }
      />
    </Frame>
  );
}

function Queries() {
  return <QueriesPage sections={useNav()} />;
}

/** Customers only ever see the portal. */
function Root() {
  const { me } = useApp();
  if (
    me.kind === "customer" &&
    !window.location.pathname.startsWith("/tickvana/portal")
  )
    return <Navigate to="/portal" />;
  return <Outlet />;
}

const root = createRootRoute({ component: Root });
const routeTree = root.addChildren([
  createRoute({
    getParentRoute: () => root,
    path: "/boards/$id/reports",
    component: ReportsPage,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/boards/$id/backlog",
    component: BacklogPage,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/boards/$id",
    component: BoardPage,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/dashboards",
    component: DashboardsRoute,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/dashboards/$id",
    component: DashboardsRoute,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/queries",
    component: Queries,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/queries/$id",
    component: Queries,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/",
    component: ProjectsPage,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/projects/$key",
    component: ProjectPage,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/projects/$key/queues",
    component: QueuesPage,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/issues/$key",
    component: IssuePage,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/admin/branding",
    component: BrandingPage,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/admin/master-data",
    component: MasterDataPage,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/admin/fields",
    component: FieldsAdminPage,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/admin/permissions",
    component: PermissionsAdminPage,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/admin/system",
    component: SystemPage,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/admin/automations",
    component: AutomationsAdminPage,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/admin/workflows",
    component: WorkflowsAdminPage,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/admin/customers",
    component: CustomersAdminPage,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/portal",
    component: PortalHome,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/portal/new/$id",
    component: PortalNew,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/portal/requests",
    component: PortalRequests,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/portal/requests/$key",
    component: PortalRequest,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/portal/kb/$space/$id",
    component: PortalArticle,
  }),
]);
const router = createRouter({ routeTree, basepath: "/tickvana" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

mountApp({
  prefix: "/tickvana",
  texts,
  app: <RouterProvider router={router} />,
  adminPath: "/admin/master-data",
  publicPages: { "/portal/signup": <PortalSignup /> },
  loginExtra: <PortalSignupLink />,
});
