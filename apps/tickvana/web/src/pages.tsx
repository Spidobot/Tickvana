import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ApiError,
  Button,
  Card,
  EmptyState,
  Frame,
  IssueKey,
  RichTextEditor,
  RichTextView,
  Status,
  Table,
  Tabs,
  Td,
  Th,
  useApp,
  useToast,
  type EditorLabels,
  DashboardView,
  useDashboards,
  type NavSection,
  type RichTextEditorProps,
} from "@tvn/ui";
import {
  Columns3,
  Filter,
  FolderKanban,
  Inbox,
  LayoutDashboard,
  Pencil,
  Plus,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  keys,
  unwrap,
  useFields,
  useIssue,
  useIssues,
  useMeta,
  useProject,
  useProjects,
  useUsers,
  type Issue,
  type Project,
} from "./api.js";
import { CreateProjectDialog, IssueDialog, useFieldLabel } from "./forms.js";
import { CannedPicker } from "./queues.js";
import { SlaClocks } from "./sla-ui.js";
import { Approvals } from "./portal.js";
import {
  ProjectComponents,
  ProjectOverview,
  ProjectSettings,
  ProjectVersions,
} from "./project-parts.js";
import {
  Attachments,
  InlineField,
  IssueRef,
  MentionedOnPages,
  Relations,
  TransitionButtons,
  WatchVote,
  Worklogs,
} from "./issue-parts.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;
const PREFIX = "/tickvana";

/** Sidebar: all projects, the open one marked. */
export function useNav(activeKey?: string): NavSection[] {
  const { t } = useTranslation();
  const projects = useProjects().data ?? [];
  return [
    {
      items: [
        {
          label: t("app.projects"),
          href: `${PREFIX}/`,
          icon: <FolderKanban {...icon} />,
          active: !activeKey && window.location.pathname === `${PREFIX}/`,
        },
        {
          label: t("dashboard.heading"),
          href: `${PREFIX}/dashboards`,
          icon: <LayoutDashboard {...icon} />,
          active: window.location.pathname.startsWith(`${PREFIX}/dashboards`),
        },
        {
          label: t("query.title"),
          href: `${PREFIX}/queries`,
          icon: <Filter {...icon} />,
          active: window.location.pathname.startsWith(`${PREFIX}/queries`),
        },
      ],
    },
    ...(projects.length
      ? [
          {
            label: t("app.projects"),
            items: projects.map((p) => ({
              label: p.name,
              href: `${PREFIX}/projects/${p.key}`,
              icon: (
                <span className="font-mono text-xs text-fg-3">
                  {p.key.slice(0, 2)}
                </span>
              ),
              active: p.key === activeKey,
            })),
          },
        ]
      : []),
  ];
}

/** Lookup helpers for ids that tickets carry. */
function useNames() {
  const { t } = useTranslation();
  const meta = useMeta().data;
  const users = useUsers().data ?? [];
  return {
    user: (id: unknown) =>
      users.find((u) => u.id === id)?.displayName ??
      (id ? "…" : t("app.nobody")),
    status: (id: unknown) => meta?.statuses.find((s) => s.id === id),
    priority: (id: unknown) =>
      meta?.priorities.find((p) => p.id === id)?.name ?? "",
    type: (id: unknown) =>
      meta?.issueTypes.find((i) => i.id === id)?.name ?? "",
    resolution: (id: unknown) =>
      meta?.resolutions.find((r) => r.id === id)?.name ?? "",
  };
}

function useDate() {
  const { i18n } = useTranslation();
  const format = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (iso: string) => format.format(new Date(iso));
}

/** Pressing C opens "create", unless the user is typing somewhere. */
function useCreateShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key.toLowerCase() !== "c" || e.metaKey || e.ctrlKey || e.altKey)
        return;
      if (
        target.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
        document.querySelector("[role=dialog]")
      )
        return;
      e.preventDefault();
      open();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}

function NotFound({ sections }: { sections: NavSection[] }) {
  const { t } = useTranslation();
  return (
    <Frame title={t("app.notFoundTitle")} sections={sections}>
      <EmptyState
        title={t("app.notFoundTitle")}
        text={t("app.notFoundText")}
        action={<Link to="/">{t("app.backToProjects")}</Link>}
      />
    </Frame>
  );
}

const Loading = () => {
  const { t } = useTranslation();
  return (
    <p role="status" className="text-fg-3">
      {t("state.loading")}
    </p>
  );
};

export function ProjectsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const projects = useProjects();
  const meta = useMeta().data;
  const [creating, setCreating] = useState(false);
  const home = useDashboards().data?.find((d) => d.home);
  const mayCreate = meta?.canCreateProject ?? false;
  const createButton = mayCreate && (
    <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
      <Plus {...icon} />
      {t("app.newProject")}
    </Button>
  );

  return (
    <Frame
      title={t("app.projects")}
      sections={useNav()}
      headerEnd={createButton}
    >
      {home && (
        <div className="mb-8">
          <DashboardView id={home.id} />
        </div>
      )}
      {projects.isLoading ? (
        <Loading />
      ) : projects.data?.length ? (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th className="w-32">{t("app.projectKey")}</Th>
                <Th>{t("app.projectName")}</Th>
                <Th className="w-48">{t("app.projectKind")}</Th>
              </tr>
            </thead>
            <tbody>
              {projects.data.map((p) => (
                <tr key={p.id} className="transition-colors hover:bg-raised">
                  <Td className="font-mono text-sm text-fg-2">{p.key}</Td>
                  <Td>
                    <Link
                      to="/projects/$key"
                      params={{ key: p.key }}
                      className="text-fg underline-offset-4 hover:underline"
                    >
                      {p.name}
                    </Link>
                  </Td>
                  <Td className="text-fg-2">{t(`app.kind.${p.kind}`)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : (
        <EmptyState
          title={t("app.noProjectsTitle")}
          text={
            mayCreate ? t("app.noProjectsText") : t("app.noProjectsNoRight")
          }
          action={createButton || undefined}
        />
      )}
      <CreateProjectDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(key) =>
          void navigate({ to: "/projects/$key", params: { key } })
        }
      />
    </Frame>
  );
}

export function ProjectPage() {
  const { t } = useTranslation();
  const { key } = useParams({ from: "/projects/$key" });
  const navigate = useNavigate();
  const project = useProject(key);
  const issues = useIssues(key);
  const names = useNames();
  const nav = useNav(key);
  const [creating, setCreating] = useState(false);
  useCreateShortcut(() => setCreating(true));
  const toast = useToast();
  const { me, isAdmin } = useApp();
  // ponytail: system admins and the project lead; role-based administrators see the button once a board exists.
  const canAdminister = isAdmin || project.data?.leadId === me.id;
  const boards = useQuery({
    queryKey: ["boards", key],
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/projects/{key}/boards", {
          params: { path: { key } },
        }),
      ),
  });
  // Opens the project's first board, or creates one (administrators only).
  const openBoard = useMutation({
    mutationFn: async () =>
      boards.data?.[0] ??
      unwrap(
        api.POST("/tickvana/api/projects/{key}/boards", {
          params: { path: { key } },
          // Software teams plan in sprints, everyone else works in a flow.
          body: {
            name: t("app.board"),
            kind: project.data?.kind === "software" ? "scrum" : "kanban",
          },
        }),
      ),
    onSuccess: (board) =>
      void navigate({ to: "/boards/$id", params: { id: board.id } }),
    onError: (e) =>
      toast({
        title: t("state.errorTitle"),
        text: (e as Error).message,
        tone: "negative",
      }),
  });

  if (project.error instanceof ApiError && project.error.status === 404)
    return <NotFound sections={nav} />;
  const createButton = (
    <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
      <Plus {...icon} />
      {t("app.create")}
    </Button>
  );

  return (
    <Frame
      title={project.data?.name ?? ""}
      sections={nav}
      headerEnd={
        <>
          {(boards.data?.length ?? 0) > 0 || canAdminister ? (
            <Button
              size="sm"
              disabled={openBoard.isPending}
              onClick={() => openBoard.mutate()}
            >
              <Columns3 {...icon} />
              {boards.data?.length ? t("app.board") : t("app.newBoard")}
            </Button>
          ) : null}
          {project.data?.kind === "service" && (
            <Link
              to="/projects/$key/queues"
              params={{ key }}
              className="inline-flex h-8 items-center gap-2 rounded-md border border-line px-3 text-sm font-medium text-fg transition-colors hover:bg-raised"
            >
              <Inbox {...icon} />
              {t("app.queues.title")}
            </Link>
          )}
          {createButton}
        </>
      }
    >
      <Tabs
        label={project.data?.name ?? key}
        tabs={[
          {
            value: "tickets",
            label: t("app.tickets"),
            content: (
              <>
                {issues.isLoading || !project.data ? (
                  <Loading />
                ) : issues.data?.length ? (
                  <Card>
                    <Table>
                      <thead>
                        <tr>
                          <Th className="w-28">{t("app.key")}</Th>
                          <Th>{t("app.summary")}</Th>
                          <Th className="w-28">{t("app.type")}</Th>
                          <Th className="w-48">{t("app.status")}</Th>
                          <Th className="w-28">{t("app.priority")}</Th>
                          <Th className="w-44">{t("app.assignee")}</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {issues.data.map((i) => {
                          const status = names.status(i.fields.status);
                          return (
                            <tr
                              key={i.id}
                              className="transition-colors hover:bg-raised"
                            >
                              <Td>
                                <IssueKey
                                  href={`${PREFIX}/issues/${i.key}`}
                                  done={status?.category === "done"}
                                >
                                  {i.key}
                                </IssueKey>
                              </Td>
                              <Td>
                                <Link
                                  to="/issues/$key"
                                  params={{ key: i.key }}
                                  className="text-fg underline-offset-4 hover:underline"
                                >
                                  {i.fields.summary as string}
                                </Link>
                              </Td>
                              <Td className="text-fg-2">
                                {names.type(i.fields.type)}
                              </Td>
                              <Td>
                                {status && (
                                  <Status category={status.category}>
                                    {status.name}
                                  </Status>
                                )}
                              </Td>
                              <Td className="text-fg-2">
                                {names.priority(i.fields.priority)}
                              </Td>
                              <Td className="text-fg-2">
                                {names.user(i.fields.assignee)}
                              </Td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </Table>
                  </Card>
                ) : (
                  <EmptyState
                    title={t("app.noTicketsTitle")}
                    text={t("app.noTicketsText")}
                    action={createButton}
                  />
                )}
              </>
            ),
          },
          {
            value: "overview",
            label: t("app.overview"),
            content: <ProjectOverview projectKey={key} />,
          },
          {
            value: "components",
            label: t("app.components"),
            content: <ProjectComponents projectKey={key} />,
          },
          {
            value: "versions",
            label: t("app.versions"),
            content: <ProjectVersions projectKey={key} />,
          },
          {
            value: "settings",
            label: t("app.settings"),
            content: <ProjectSettings projectKey={key} />,
          },
        ]}
      />
      {project.data && (
        <IssueDialog
          open={creating}
          onOpenChange={setCreating}
          project={project.data}
          onSaved={(issue) =>
            void navigate({ to: "/issues/$key", params: { key: issue.key } })
          }
        />
      )}
    </Frame>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-start gap-2 py-1">
      <dt className="text-sm text-fg-2">{label}</dt>
      <dd className="text-base text-fg">{children}</dd>
    </div>
  );
}

function Comments({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const names = useNames();
  const date = useDate();
  const queryKey = keys.issuePart(issue.key, "comments");
  const comments = useQuery({
    queryKey,
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/issues/{key}/comments", {
          params: { path: { key: issue.key } },
        }),
      ),
  });
  const [draft, setDraft] = useState<RichTextEditorProps["value"]>(null);
  const [internal, setInternal] = useState(false);
  // A new key empties the editor after posting, or fills it with a canned response.
  const [round, setRound] = useState(0);
  const [seed, setSeed] = useState<RichTextEditorProps["value"]>(null);

  const post = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/tickvana/api/issues/{key}/comments", {
          params: { path: { key: issue.key } },
          body: { body: draft, visibility: internal ? "internal" : "public" },
        }),
      ),
    onSuccess: () => {
      setDraft(null);
      setSeed(null);
      setRound((n) => n + 1);
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (e) =>
      toast({
        title: t("state.errorTitle"),
        text: (e as Error).message,
        tone: "negative",
      }),
  });

  return (
    <div className="flex flex-col gap-4">
      {comments.data?.length === 0 && (
        <p className="text-fg-3">{t("app.noComments")}</p>
      )}
      <ul className="flex flex-col gap-4">
        {comments.data?.map((c) => (
          <li key={c.id} className="flex flex-col gap-1">
            <p className="flex items-center gap-2 text-sm text-fg-2">
              <span className="font-medium text-fg">
                {names.user(c.authorId)}
              </span>
              <time dateTime={c.createdAt}>{date(c.createdAt)}</time>
              {c.visibility === "internal" && (
                <span className="rounded-sm bg-raised px-2 text-xs text-fg-2">
                  {t("app.internalTag")}
                </span>
              )}
            </p>
            <RichTextView
              doc={c.body as NonNullable<RichTextEditorProps["value"]>}
            />
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft) post.mutate();
        }}
      >
        <RichTextEditor
          key={round}
          compact
          label={t("app.comment")}
          labels={t("editor", { returnObjects: true }) as EditorLabels}
          value={seed}
          onChange={setDraft}
        />
        <div className="flex items-center gap-4">
          <Button
            variant="primary"
            size="sm"
            type="submit"
            disabled={!draft || post.isPending}
          >
            {t("app.addComment")}
          </Button>
          <label className="flex items-center gap-2 text-sm text-fg-2">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              checked={internal}
              onChange={(e) => setInternal(e.target.checked)}
            />
            {t("app.internal")}
          </label>
          <CannedPicker
            projectKey={issue.key.split("-")[0]!}
            onPick={(doc) => {
              setSeed(doc);
              setDraft(doc);
              setRound((n) => n + 1);
            }}
          />
        </div>
      </form>
    </div>
  );
}

function History({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const names = useNames();
  const date = useDate();
  const fields = useFields().data ?? [];
  const label = useFieldLabel();
  const history = useQuery({
    queryKey: keys.issuePart(issue.key, "history"),
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/issues/{key}/history", {
          params: { path: { key: issue.key } },
        }),
      ),
  });
  const fieldName = (key: string) => {
    const field = fields.find((f) => f.key === key);
    return field ? label(field) : key;
  };
  if (history.data?.length === 0)
    return <p className="text-fg-3">{t("app.noHistory")}</p>;
  return (
    <ul className="flex flex-col gap-3">
      {history.data?.map((h) => (
        <li key={h.id} className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-sm text-fg-2">
            <span className="font-medium text-fg">
              {t("app.changed", { who: names.user(h.actorId) })}
            </span>
            <time dateTime={h.createdAt}>{date(h.createdAt)}</time>
          </p>
          {h.items.map((item) => (
            <p key={item.field} className="text-base text-fg">
              {t("app.fromTo", {
                field: fieldName(item.field),
                from: item.from || t("app.empty"),
                to: item.to || t("app.empty"),
              })}
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

/** Fields shown in the details column, in this order; custom fields follow. */
const DETAIL_KEYS = [
  "assignee",
  "reporter",
  "priority",
  "labels",
  "dueDate",
  "estimate",
  "components",
  "fixVersions",
  "affectsVersions",
  "parent",
];

/** Names of a project's components or versions by id. */
function usePartNames(projectKey: string) {
  const get = (part: string) =>
    unwrap(
      (api.GET as unknown as (p: string, i: object) => Promise<never>)(
        `/tickvana/api/projects/{key}/${part}`,
        { params: { path: { key: projectKey } } },
      ),
    ) as Promise<{ id: string; name: string }[]>;
  const components = useQuery({
    queryKey: ["project-part", projectKey, "components"],
    queryFn: () => get("components"),
  }).data;
  const versions = useQuery({
    queryKey: ["project-part", projectKey, "versions"],
    queryFn: () => get("versions"),
  }).data;
  return (id: string) =>
    [...(components ?? []), ...(versions ?? [])].find((x) => x.id === id)
      ?.name ?? id;
}

export function IssuePage() {
  const { t } = useTranslation();
  const { key } = useParams({ from: "/issues/$key" });
  const queryClient = useQueryClient();
  const issue = useIssue(key);
  const projects = useProjects().data ?? [];
  const projectKey =
    projects.find((p) => p.id === issue.data?.projectId)?.key ??
    key.split("-")[0]!;
  const project = useProject(projectKey);
  const names = useNames();
  const part = usePartNames(projectKey);
  const date = useDate();
  const fields = useFields().data ?? [];
  const label = useFieldLabel();
  const nav = useNav(projectKey);
  const [editing, setEditing] = useState(false);

  if (issue.error instanceof ApiError && issue.error.status === 404)
    return <NotFound sections={nav} />;
  if (!issue.data) {
    return (
      <Frame title={key} sections={nav}>
        <Loading />
      </Frame>
    );
  }

  const i = issue.data;
  const f = i.fields;
  const status = names.status(f.status);
  const details = [
    ...DETAIL_KEYS.flatMap((k) =>
      fields.filter((x) => x.system && x.key === k),
    ),
    ...fields.filter((x) => !x.system),
  ];
  const show = (field: (typeof fields)[number]): ReactNode => {
    const value = f[field.key];
    if (
      value === null ||
      value === undefined ||
      (Array.isArray(value) && value.length === 0)
    )
      return <span className="text-fg-3">–</span>;
    const list = [value].flat() as string[];
    switch (field.system ? field.key : field.type) {
      case "select":
      case "multiselect":
      case "cascade":
        return list
          .map((id) => field.options.find((o) => o.id === id)?.value ?? id)
          .join(field.type === "cascade" ? " › " : ", ");
      case "assignee":
      case "reporter":
      case "user":
      case "multiuser":
        return list.map((id) => names.user(id)).join(", ");
      case "priority":
        return names.priority(value);
      case "components":
      case "fixVersions":
      case "affectsVersions":
        return list.map(part).join(", ");
      case "parent":
      case "issue":
        return <IssueRef id={value as string} />;
      case "estimate":
        return `${Math.round(((value as number) / 3600) * 100) / 100} h`;
      case "checkbox":
        return value ? "✓" : "–";
      case "richtext":
        return "…";
      default:
        return list.join(", ");
    }
  };

  return (
    <Frame
      title={project.data?.name ?? projectKey}
      sections={nav}
      headerEnd={
        <Button size="sm" onClick={() => setEditing(true)}>
          <Pencil {...icon} />
          {t("app.edit")}
        </Button>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)_320px] items-start gap-6 max-lg:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col gap-2">
            <p className="flex flex-wrap items-center gap-2">
              <IssueKey done={status?.category === "done"}>{i.key}</IssueKey>
              <span className="flex-1 text-sm text-fg-2">
                {names.type(f.type)}
              </span>
              <WatchVote issue={i} />
            </p>
            <h2 className="text-2xl font-medium text-fg">
              {f.summary as string}
            </h2>
          </div>
          <section aria-label={t("app.description")}>
            {f.description ? (
              <RichTextView
                doc={f.description as NonNullable<RichTextEditorProps["value"]>}
              />
            ) : (
              <p className="text-fg-3">{t("app.noDescription")}</p>
            )}
          </section>
          <section aria-label={t("app.attachments")}>
            <Attachments issue={i} />
          </section>
          <section aria-label={t("app.links")}>
            <Relations issue={i} />
            <MentionedOnPages issue={i} />
          </section>
          <section aria-label={t("app.activity")}>
            <Tabs
              label={t("app.activity")}
              tabs={[
                {
                  value: "comments",
                  label: t("app.comments"),
                  content: <Comments issue={i} />,
                },
                {
                  value: "worklog",
                  label: t("app.worklog"),
                  content: <Worklogs issue={i} />,
                },
                {
                  value: "history",
                  label: t("app.history"),
                  content: <History issue={i} />,
                },
              ]}
            />
          </section>
        </div>

        <Card className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {status && (
              <Status category={status.category}>{status.name}</Status>
            )}
            <TransitionButtons issue={i} projectKey={projectKey} />
          </div>
          <dl aria-label={t("app.details")}>
            {details.map((field) => (
              <InlineField
                key={field.id}
                issue={i}
                field={field}
                label={label(field)}
                projectKey={projectKey}
              >
                {show(field)}
              </InlineField>
            ))}
            {Boolean(f.resolution) && (
              <Row label={t("app.resolution")}>
                {names.resolution(f.resolution)}
              </Row>
            )}
            <Row label={t("app.created")}>
              <time dateTime={i.createdAt}>{date(i.createdAt)}</time>
            </Row>
            <Row label={t("app.updated")}>
              <time dateTime={i.updatedAt}>{date(i.updatedAt)}</time>
            </Row>
          </dl>
          <SlaClocks issueKey={i.key} />
          <Approvals issueKey={i.key} />
        </Card>
      </div>
      {project.data && (
        <IssueDialog
          open={editing}
          onOpenChange={setEditing}
          project={project.data as Project}
          issue={i}
          onSaved={() =>
            void queryClient.invalidateQueries({
              predicate: (q) =>
                q.queryKey[0] === "issue" && q.queryKey[1] === key,
            })
          }
        />
      )}
    </Frame>
  );
}
