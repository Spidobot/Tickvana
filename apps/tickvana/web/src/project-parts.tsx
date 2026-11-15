// Tabs of a project page besides the ticket list: overview, components,
// versions with progress, and settings (details, ticket types, members,
// CSV import and export).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  Field as FormField,
  IconButton,
  Input,
  Select,
  Status,
  Table,
  Td,
  Th,
  useToast,
} from "@tvn/ui";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  keys,
  unwrap,
  useFields,
  useIssues,
  useMeta,
  useUsers,
} from "./api.js";
import { useFieldLabel } from "./forms.js";
import { CannedResponses } from "./queues.js";
import { SlaPolicies } from "./sla-ui.js";
import { ProjectCustomers } from "./customers-admin.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

// ponytail: several project paths are built at runtime, which openapi-fetch cannot type; the server validates every body.
type Call = (path: string, init?: object) => Promise<never>;
const call = <T,>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: object,
) =>
  unwrap<T>((api[method] as unknown as Call)(`/tickvana/api${path}`, { body }));

function useRun() {
  const toast = useToast();
  const queryClient = useQueryClient();
  return (promise: Promise<unknown>, ...queryKeys: (readonly unknown[])[]) =>
    promise
      .then(() =>
        Promise.all(
          queryKeys.map((queryKey) =>
            queryClient.invalidateQueries({ queryKey }),
          ),
        ),
      )
      .catch((e: Error) => toast({ title: e.message, tone: "negative" }));
}

/** A thin bar: done out of total. */
function Progress({ done, total }: { done: number; total: number }) {
  const { t } = useTranslation();
  const share = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-valuenow={share}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t("app.progressLabel")}
        className="h-2 w-32 overflow-hidden rounded-full bg-sunken"
      >
        {/* The width is the data being shown. */}
        <div className="h-full bg-positive" style={{ width: `${share}%` }} />
      </div>
      <span className="text-sm text-fg-2">
        {done}/{total}
      </span>
    </div>
  );
}

// --- Overview -------------------------------------------------------------------------

export function ProjectOverview({ projectKey }: { projectKey: string }) {
  const { t } = useTranslation();
  const meta = useMeta().data;
  const users = useUsers().data ?? [];
  const issues = useIssues(projectKey).data ?? [];
  const epics = useQuery({
    queryKey: ["epics", projectKey],
    queryFn: () =>
      call<
        {
          id: string;
          key: string;
          summary: string;
          total: number;
          doneCount: number;
        }[]
      >("GET", `/projects/${projectKey}/epics`),
  }).data;
  const category = (i: (typeof issues)[number]) =>
    meta?.statuses.find((s) => s.id === i.fields.status)?.category ?? "todo";
  const open = issues.filter((i) => category(i) !== "done");
  const byAssignee = new Map<string, number>();
  for (const i of open) {
    const who = (i.fields.assignee as string | null) ?? "";
    byAssignee.set(who, (byAssignee.get(who) ?? 0) + 1);
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Satisfaction projectKey={projectKey} />
      <Card className="flex flex-col gap-3 p-4">
        <h3 className="text-sm font-medium text-fg-2">{t("app.byStatus")}</h3>
        <ul className="flex flex-col gap-2">
          {(["todo", "in_progress", "done"] as const).map((c) => (
            <li key={c} className="flex items-center gap-2">
              <Status category={c}>
                {t(`app.admin.values.category.${c}`)}
              </Status>
              <span className="text-fg">
                {issues.filter((i) => category(i) === c).length}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="flex flex-col gap-3 p-4">
        <h3 className="text-sm font-medium text-fg-2">
          {t("app.openByAssignee")}
        </h3>
        <ul className="flex flex-col gap-1">
          {[...byAssignee]
            .sort((a, b) => b[1] - a[1])
            .map(([id, n]) => (
              <li key={id} className="flex justify-between text-sm">
                <span className="text-fg">
                  {id
                    ? (users.find((u) => u.id === id)?.displayName ?? "…")
                    : t("app.nobody")}
                </span>
                <span className="text-fg-2">{n}</span>
              </li>
            ))}
        </ul>
      </Card>
      {epics && epics.length > 0 && (
        <Card className="flex flex-col gap-3 p-4 lg:col-span-2">
          <h3 className="text-sm font-medium text-fg-2">{t("app.epics")}</h3>
          <ul className="flex flex-col gap-2">
            {epics.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3">
                <span className="w-24 font-mono text-sm text-fg-2">
                  {e.key}
                </span>
                <span className="min-w-48 flex-1 text-fg">{e.summary}</span>
                <Progress done={e.doneCount} total={e.total} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** Ratings of finished requests; hidden until there is one. */
function Satisfaction({ projectKey }: { projectKey: string }) {
  const { t } = useTranslation();
  const data = useQuery({
    queryKey: ["satisfaction", projectKey],
    queryFn: () =>
      call<{ count: number; average: number | null; distribution: number[] }>(
        "GET",
        `/projects/${projectKey}/satisfaction`,
      ),
  }).data;
  if (!data?.count) return null;
  const most = Math.max(...data.distribution, 1);
  return (
    <Card className="flex flex-col gap-3 p-4 lg:col-span-2">
      <h3 className="text-sm font-medium text-fg-2">{t("app.rating.title")}</h3>
      <p className="text-fg">
        {t("app.rating.average", { average: data.average, count: data.count })}
      </p>
      <ul className="flex flex-col gap-1">
        {data.distribution.map((n, i) => (
          <li key={i} className="flex items-center gap-2 text-sm">
            <span className="w-4 text-fg-2">{i + 1}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-sunken">
              {/* The width is the data being shown. */}
              <div
                className="h-full bg-accent"
                style={{ width: `${(n / most) * 100}%` }}
              />
            </div>
            <span className="w-8 text-right text-fg-2">{n}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// --- Components and versions ----------------------------------------------------------

export function ProjectComponents({ projectKey }: { projectKey: string }) {
  const { t } = useTranslation();
  const run = useRun();
  const users = useUsers().data ?? [];
  const key = ["project-part", projectKey, "components"];
  const list = useQuery({
    queryKey: key,
    queryFn: () =>
      call<{ id: string; name: string; leadId: string | null }[]>(
        "GET",
        `/projects/${projectKey}/components`,
      ),
  }).data;
  const [name, setName] = useState("");
  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex max-w-md items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            call("POST", `/projects/${projectKey}/components`, { name }),
            key,
          ).then(() => setName(""));
        }}
      >
        <FormField label={t("app.newComponent")}>
          {(p) => (
            <Input
              {...p}
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </FormField>
        <Button type="submit">{t("app.admin.add")}</Button>
      </form>
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>{t("app.admin.columns.name")}</Th>
              <Th className="w-56">{t("app.lead")}</Th>
              <Th className="w-12">
                <span className="sr-only">{t("app.admin.actions")}</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {list?.map((c) => (
              <tr key={c.id}>
                <Td className="text-fg">{c.name}</Td>
                <Td>
                  <Select
                    aria-label={`${t("app.lead")}: ${c.name}`}
                    value={c.leadId ?? "-"}
                    onValueChange={(v) =>
                      void run(
                        call("PATCH", `/components/${c.id}`, {
                          leadId: v === "-" ? null : v,
                        }),
                        key,
                      )
                    }
                    options={[
                      { value: "-", label: t("app.nobody") },
                      ...users.map((u) => ({
                        value: u.id,
                        label: u.displayName,
                      })),
                    ]}
                  />
                </Td>
                <Td>
                  <IconButton
                    label={`${t("app.delete")}: ${c.name}`}
                    onClick={() =>
                      void run(call("DELETE", `/components/${c.id}`), key)
                    }
                  >
                    <X {...icon} />
                  </IconButton>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

export function ProjectVersions({ projectKey }: { projectKey: string }) {
  const { t } = useTranslation();
  const run = useRun();
  const key = ["project-part", projectKey, "versions"];
  const list = useQuery({
    queryKey: key,
    queryFn: () =>
      call<
        {
          id: string;
          name: string;
          startDate: string | null;
          releaseDate: string | null;
          released: boolean;
        }[]
      >("GET", `/projects/${projectKey}/versions`),
  }).data;
  const progress = useQuery({
    queryKey: [...key, "progress"],
    queryFn: () =>
      call<{ versionId: string; total: number; done: number }[]>(
        "GET",
        `/projects/${projectKey}/versions/progress`,
      ),
  }).data;
  const [form, setForm] = useState({ name: "", releaseDate: "" });
  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            call("POST", `/projects/${projectKey}/versions`, {
              name: form.name,
              releaseDate: form.releaseDate || null,
            }),
            key,
          ).then(() => setForm({ name: "", releaseDate: "" }));
        }}
      >
        <FormField label={t("app.newVersion")}>
          {(p) => (
            <Input
              {...p}
              required
              maxLength={200}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          )}
        </FormField>
        <FormField label={t("app.releaseDate")}>
          {(p) => (
            <Input
              {...p}
              type="date"
              value={form.releaseDate}
              onChange={(e) =>
                setForm({ ...form, releaseDate: e.target.value })
              }
            />
          )}
        </FormField>
        <Button type="submit">{t("app.admin.add")}</Button>
      </form>
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>{t("app.admin.columns.name")}</Th>
              <Th className="w-36">{t("app.releaseDate")}</Th>
              <Th className="w-56">{t("app.progressLabel")}</Th>
              <Th className="w-40">
                <span className="sr-only">{t("app.admin.actions")}</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {list?.map((v) => {
              const p = progress?.find((x) => x.versionId === v.id) ?? {
                done: 0,
                total: 0,
              };
              return (
                <tr key={v.id}>
                  <Td className="text-fg">
                    {v.name}
                    {v.released && (
                      <span className="ml-2 text-sm text-positive">
                        {t("app.released")}
                      </span>
                    )}
                  </Td>
                  <Td className="text-fg-2">{v.releaseDate ?? "–"}</Td>
                  <Td>
                    <Progress done={p.done} total={p.total} />
                  </Td>
                  <Td>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void run(
                            call("PATCH", `/versions/${v.id}`, {
                              released: !v.released,
                            }),
                            key,
                          )
                        }
                      >
                        {v.released ? t("app.unrelease") : t("app.release")}
                      </Button>
                      <IconButton
                        label={`${t("app.delete")}: ${v.name}`}
                        onClick={() =>
                          void run(call("DELETE", `/versions/${v.id}`), key)
                        }
                      >
                        <X {...icon} />
                      </IconButton>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

// --- Settings -------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h3 className="text-base font-medium text-fg">{title}</h3>
      {children}
    </Card>
  );
}

export function ProjectSettings({ projectKey }: { projectKey: string }) {
  return (
    <div className="flex flex-col gap-4">
      <Details projectKey={projectKey} />
      <IssueTypes projectKey={projectKey} />
      <Members projectKey={projectKey} />
      <ProjectCustomers projectKey={projectKey} />
      <RequestTypes projectKey={projectKey} />
      <CannedResponses projectKey={projectKey} />
      <SlaPolicies projectKey={projectKey} />
      <MailChannels projectKey={projectKey} />
      <KnowledgeSpace projectKey={projectKey} />
      <ImportExport projectKey={projectKey} />
    </div>
  );
}

interface ProjectData {
  name: string;
  leadId: string;
  archived: boolean;
  issueTypes: {
    id: string;
    name: string;
    workflowId: string;
    fieldLayoutId: string;
  }[];
}

function useProjectData(projectKey: string) {
  return useQuery({
    queryKey: keys.project(projectKey),
    queryFn: () => call<ProjectData>("GET", `/projects/${projectKey}`),
  }).data;
}

function Details({ projectKey }: { projectKey: string }) {
  const { t } = useTranslation();
  const run = useRun();
  const users = useUsers().data ?? [];
  const project = useProjectData(projectKey);
  const [name, setName] = useState<string | null>(null);
  if (!project) return null;
  const patch = (body: object) =>
    run(
      call("PATCH", `/projects/${projectKey}`, body),
      keys.project(projectKey),
      keys.projects,
    );
  return (
    <Section title={t("app.projectDetails")}>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name) void patch({ name }).then(() => setName(null));
        }}
      >
        <div className="w-64">
          <FormField label={t("app.projectName")}>
            {(p) => (
              <Input
                {...p}
                required
                value={name ?? project.name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </FormField>
        </div>
        <Button type="submit" disabled={name === null}>
          {t("app.save")}
        </Button>
      </form>
      <div className="flex flex-wrap items-end gap-4">
        <div className="w-64">
          <FormField label={t("app.lead")}>
            {(p) => (
              <Select
                {...p}
                value={project.leadId}
                onValueChange={(leadId) => void patch({ leadId })}
                options={users.map((u) => ({
                  value: u.id,
                  label: u.displayName,
                }))}
              />
            )}
          </FormField>
        </div>
        <Button onClick={() => void patch({ archived: !project.archived })}>
          {project.archived ? t("app.restore") : t("app.archive")}
        </Button>
      </div>
    </Section>
  );
}

function IssueTypes({ projectKey }: { projectKey: string }) {
  const { t } = useTranslation();
  const run = useRun();
  const meta = useMeta().data;
  const project = useProjectData(projectKey);
  const workflows = useQuery({
    queryKey: ["workflows"],
    queryFn: () => call<{ id: string; name: string }[]>("GET", "/workflows"),
  }).data;
  const layouts = useQuery({
    queryKey: ["field-layouts"],
    queryFn: () => unwrap(api.GET("/tickvana/api/field-layouts")),
  }).data;
  if (!project) return null;
  const used = new Set(project.issueTypes.map((x) => x.id));
  const put = (typeId: string, body: object) =>
    run(
      call("PUT", `/projects/${projectKey}/issue-types/${typeId}`, body),
      keys.project(projectKey),
    );
  return (
    <Section title={t("app.issueTypes")}>
      <ul className="flex flex-col gap-2">
        {project.issueTypes.map((it) => (
          <li key={it.id} className="flex flex-wrap items-center gap-2">
            <span className="w-32 text-fg">{it.name}</span>
            <div className="w-48">
              <Select
                aria-label={`${t("app.wf.workflow")}: ${it.name}`}
                value={it.workflowId}
                onValueChange={(workflowId) => void put(it.id, { workflowId })}
                options={(workflows ?? []).map((w) => ({
                  value: w.id,
                  label: w.name,
                }))}
              />
            </div>
            <div className="w-48">
              <Select
                aria-label={`${t("app.admin.fields.layout")}: ${it.name}`}
                value={it.fieldLayoutId}
                onValueChange={(fieldLayoutId) =>
                  void put(it.id, { fieldLayoutId })
                }
                options={(layouts ?? []).map((l) => ({
                  value: l.id,
                  label: l.name,
                }))}
              />
            </div>
            <IconButton
              label={`${t("app.delete")}: ${it.name}`}
              onClick={() =>
                void run(
                  call(
                    "DELETE",
                    `/projects/${projectKey}/issue-types/${it.id}`,
                  ),
                  keys.project(projectKey),
                )
              }
            >
              <X {...icon} />
            </IconButton>
          </li>
        ))}
      </ul>
      {meta && meta.issueTypes.some((x) => !used.has(x.id)) && (
        <div className="w-56">
          <Select
            aria-label={t("app.addIssueType")}
            placeholder={t("app.addIssueType")}
            value={undefined}
            onValueChange={(typeId) => void put(typeId, {})}
            options={meta.issueTypes
              .filter((x) => !used.has(x.id))
              .map((x) => ({ value: x.id, label: x.name }))}
          />
        </div>
      )}
    </Section>
  );
}

function Members({ projectKey }: { projectKey: string }) {
  const { t } = useTranslation();
  const run = useRun();
  const users = useUsers().data ?? [];
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: () =>
      unwrap(api.GET("/tickvana/api/core/groups")) as Promise<
        { id: string; name: string }[]
      >,
  }).data;
  const key = ["members", projectKey];
  const data = useQuery({
    queryKey: key,
    queryFn: () =>
      call<{
        roles: { id: string; name: string }[];
        members: {
          roleId: string;
          principalType: "user" | "group";
          principalId: string;
        }[];
      }>("GET", `/projects/${projectKey}/members`),
  }).data;
  const [form, setForm] = useState({ roleId: "", who: "" });
  if (!data) return null;
  const name = (type: string, id: string) =>
    type === "user"
      ? (users.find((u) => u.id === id)?.displayName ?? id)
      : `${t("app.perm.grantees.group")}: ${groups?.find((g) => g.id === id)?.name ?? id}`;
  const roleId = form.roleId || data.roles[0]?.id;
  return (
    <Section title={t("app.members")}>
      <dl className="flex flex-col gap-2">
        {data.roles.map((r) => (
          <div key={r.id} className="flex flex-wrap items-baseline gap-2">
            <dt className="w-36 text-sm text-fg-2">{r.name}</dt>
            <dd className="flex flex-1 flex-wrap gap-1">
              {data.members
                .filter((m) => m.roleId === r.id)
                .map((m) => (
                  <span
                    key={m.principalType + m.principalId}
                    className="inline-flex items-center gap-1 rounded-md border border-line px-2 text-sm text-fg"
                  >
                    {name(m.principalType, m.principalId)}
                    <IconButton
                      label={t("app.perm.remove")}
                      onClick={() =>
                        void run(
                          call("DELETE", `/projects/${projectKey}/members`, m),
                          key,
                        )
                      }
                    >
                      <X {...icon} />
                    </IconButton>
                  </span>
                ))}
            </dd>
          </div>
        ))}
      </dl>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const [principalType, principalId] = form.who.split(":");
          void run(
            call("PUT", `/projects/${projectKey}/members`, {
              roleId,
              principalType,
              principalId,
            }),
            key,
          );
        }}
      >
        <div className="w-44">
          <Select
            aria-label={t("app.perm.roles")}
            value={roleId}
            onValueChange={(v) => setForm({ ...form, roleId: v })}
            options={data.roles.map((r) => ({ value: r.id, label: r.name }))}
          />
        </div>
        <div className="w-56">
          <Select
            aria-label={t("app.perm.who")}
            placeholder={t("app.perm.choose")}
            value={form.who || undefined}
            onValueChange={(v) => setForm({ ...form, who: v })}
            options={[
              ...users.map((u) => ({
                value: `user:${u.id}`,
                label: u.displayName,
              })),
              ...(groups ?? []).map((g) => ({
                value: `group:${g.id}`,
                label: `${t("app.perm.grantees.group")}: ${g.name}`,
              })),
            ]}
          />
        </div>
        <Button type="submit" size="sm" disabled={!form.who}>
          {t("app.admin.add")}
        </Button>
      </form>
    </Section>
  );
}

// --- Request types --------------------------------------------------------------------

interface RequestType {
  id: string;
  name: string;
  description: string;
  icon: string;
  groupName: string;
  issueTypeId: string;
  fieldLayoutId: string;
  defaults: Record<string, unknown>;
  position: number;
}

function RequestTypes({ projectKey }: { projectKey: string }) {
  const { t } = useTranslation();
  const run = useRun();
  const fields = useFields().data ?? [];
  const label = useFieldLabel();
  const project = useProjectData(projectKey);
  const layouts = useQuery({
    queryKey: ["field-layouts"],
    queryFn: () => unwrap(api.GET("/tickvana/api/field-layouts")),
  }).data;
  const key = ["request-types", projectKey];
  const list = useQuery({
    queryKey: key,
    queryFn: () =>
      call<RequestType[]>("GET", `/projects/${projectKey}/request-types`),
  }).data;
  const blank = {
    name: "",
    description: "",
    groupName: "",
    issueTypeId: "",
    fieldLayoutId: "",
    defaults: {} as Record<string, unknown>,
  };
  const [form, setForm] = useState<typeof blank & { id?: string }>(blank);
  const [defaultKey, setDefaultKey] = useState<string>();
  if (!project) return null;
  const issueTypeId = form.issueTypeId || project.issueTypes[0]?.id;
  const fieldLayoutId = form.fieldLayoutId || layouts?.[0]?.id;
  const save = (e: FormEvent) => {
    e.preventDefault();
    const { id, ...rest } = form;
    const b = { ...rest, issueTypeId, fieldLayoutId };
    void run(
      id
        ? call("PUT", `/request-types/${id}`, b)
        : call("POST", `/projects/${projectKey}/request-types`, b),
      key,
    ).then(() => setForm(blank));
  };
  const move = (rt: RequestType, by: number) => {
    const other = list?.[list.indexOf(rt) + by];
    if (!other) return;
    const put = (x: RequestType, position: number) =>
      call("PUT", `/request-types/${x.id}`, { ...x, position });
    void run(
      Promise.all([put(rt, other.position), put(other, rt.position)]),
      key,
    );
  };
  const settable = fields.filter(
    (f) =>
      !["status", "type", "resolution", "reporter", "summary"].includes(f.key),
  );

  return (
    <Section title={t("app.requestTypes")}>
      <p className="text-sm text-fg-2">{t("app.requestTypesHint")}</p>
      <ul className="flex flex-col gap-1">
        {list?.map((rt, i) => (
          <li key={rt.id} className="flex flex-wrap items-center gap-2">
            <span className="w-28 text-sm text-fg-3">
              {rt.groupName || "–"}
            </span>
            <button
              type="button"
              className="flex-1 text-left text-fg underline-offset-4 hover:underline"
              onClick={() => setForm({ ...rt })}
            >
              {rt.name}
            </button>
            <IconButton
              label={t("app.admin.up")}
              disabled={i === 0}
              onClick={() => move(rt, -1)}
            >
              <ArrowUp {...icon} />
            </IconButton>
            <IconButton
              label={t("app.admin.down")}
              disabled={i === list.length - 1}
              onClick={() => move(rt, 1)}
            >
              <ArrowDown {...icon} />
            </IconButton>
            <IconButton
              label={`${t("app.delete")}: ${rt.name}`}
              onClick={() =>
                void run(call("DELETE", `/request-types/${rt.id}`), key)
              }
            >
              <X {...icon} />
            </IconButton>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-3 border-t border-line pt-3"
        onSubmit={save}
      >
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-64">
            <FormField label={t("app.admin.columns.name")}>
              {(p) => (
                <Input
                  {...p}
                  required
                  maxLength={200}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              )}
            </FormField>
          </div>
          <div className="w-48">
            <FormField label={t("app.portalGroup")}>
              {(p) => (
                <Input
                  {...p}
                  maxLength={100}
                  value={form.groupName}
                  onChange={(e) =>
                    setForm({ ...form, groupName: e.target.value })
                  }
                />
              )}
            </FormField>
          </div>
          <div className="w-44">
            <Select
              aria-label={t("app.type")}
              value={issueTypeId}
              onValueChange={(v) => setForm({ ...form, issueTypeId: v })}
              options={project.issueTypes.map((x) => ({
                value: x.id,
                label: x.name,
              }))}
            />
          </div>
          <div className="w-48">
            <Select
              aria-label={t("app.portalForm")}
              value={fieldLayoutId}
              onValueChange={(v) => setForm({ ...form, fieldLayoutId: v })}
              options={(layouts ?? []).map((l) => ({
                value: l.id,
                label: `${t("app.portalForm")}: ${l.name}`,
              }))}
            />
          </div>
        </div>
        <FormField label={t("app.description")}>
          {(p) => (
            <Input
              {...p}
              maxLength={2000}
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          )}
        </FormField>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-fg">
            {t("app.fixedValues")}
          </span>
          {Object.entries(form.defaults).map(([k, v]) => {
            const field = fields.find((f) => f.key === k);
            return (
              <div key={k} className="flex items-center gap-2">
                <span className="w-40 text-sm text-fg-2">
                  {field ? label(field) : k}
                </span>
                <div className="w-56">
                  <Input
                    aria-label={field ? label(field) : k}
                    value={Array.isArray(v) ? v.join(" ") : String(v ?? "")}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        defaults: {
                          ...form.defaults,
                          [k]:
                            k === "labels"
                              ? e.target.value.split(/\s+/).filter(Boolean)
                              : e.target.value,
                        },
                      })
                    }
                  />
                </div>
                <IconButton
                  label={t("app.admin.fields.remove")}
                  onClick={() => {
                    const next = { ...form.defaults };
                    delete next[k];
                    setForm({ ...form, defaults: next });
                  }}
                >
                  <X {...icon} />
                </IconButton>
              </div>
            );
          })}
          <div className="w-56">
            <Select
              aria-label={t("app.addFixedValue")}
              placeholder={t("app.addFixedValue")}
              value={defaultKey}
              onValueChange={(k) => {
                setDefaultKey(undefined);
                setForm({ ...form, defaults: { ...form.defaults, [k]: "" } });
              }}
              options={settable
                .filter((f) => !(f.key in form.defaults))
                .map((f) => ({ value: f.key, label: label(f) }))}
            />
          </div>
          <p className="text-sm text-fg-3">{t("app.fixedValuesHint")}</p>
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="primary">
            {form.id ? t("app.save") : t("app.admin.add")}
          </Button>
          {form.id && (
            <Button onClick={() => setForm(blank)}>{t("app.cancel")}</Button>
          )}
        </div>
      </form>
    </Section>
  );
}

// --- Mail channels --------------------------------------------------------------------

interface MailChannel {
  id: string;
  requestTypeId: string;
  imap: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    folder: string;
    hasPassword: boolean;
  };
  active: boolean;
}

function MailChannels({ projectKey }: { projectKey: string }) {
  const { t } = useTranslation();
  const run = useRun();
  const key = ["mail-channels", projectKey];
  const channels = useQuery({
    queryKey: key,
    queryFn: () =>
      call<MailChannel[]>("GET", `/projects/${projectKey}/mail-channels`),
    retry: false,
  }).data;
  const types = useQuery({
    queryKey: ["request-types", projectKey],
    queryFn: () =>
      call<{ id: string; name: string }[]>(
        "GET",
        `/projects/${projectKey}/request-types`,
      ),
  }).data;
  const blank = {
    host: "",
    port: "993",
    user: "",
    password: "",
    folder: "INBOX",
    requestTypeId: "",
  };
  const [form, setForm] = useState(blank);
  if (!channels) return null;
  const typeName = (id: string) => types?.find((x) => x.id === id)?.name ?? id;
  return (
    <Section title={t("app.mail.title")}>
      <p className="text-sm text-fg-2">{t("app.mail.hint")}</p>
      <ul className="flex flex-col gap-1">
        {channels.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="flex-1 text-fg">
              {c.imap.user}@{c.imap.host} · {c.imap.folder} →{" "}
              {typeName(c.requestTypeId)}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void run(
                  call("PUT", `/mail-channels/${c.id}`, {
                    requestTypeId: c.requestTypeId,
                    imap: { ...c.imap, password: "" },
                    active: !c.active,
                  }),
                  key,
                )
              }
            >
              {c.active ? t("system.deactivate") : t("system.activate")}
            </Button>
            <IconButton
              label={`${t("app.delete")}: ${c.imap.user}`}
              onClick={() =>
                void run(call("DELETE", `/mail-channels/${c.id}`), key)
              }
            >
              <X {...icon} />
            </IconButton>
          </li>
        ))}
      </ul>
      {types && types.length === 0 ? (
        <p className="text-sm text-fg-3">{t("app.mail.needsType")}</p>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2 border-t border-line pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              call("POST", `/projects/${projectKey}/mail-channels`, {
                requestTypeId: form.requestTypeId || types?.[0]?.id,
                imap: {
                  host: form.host,
                  port: Number(form.port),
                  user: form.user,
                  password: form.password,
                  folder: form.folder,
                },
              }),
              key,
            ).then(() => setForm(blank));
          }}
        >
          {(["host", "port", "user", "password", "folder"] as const).map(
            (k) => (
              <div key={k} className={k === "port" ? "w-24" : "w-44"}>
                <FormField label={t(`app.mail.${k}`)}>
                  {(p) => (
                    <Input
                      {...p}
                      required={k !== "folder"}
                      type={
                        k === "password"
                          ? "password"
                          : k === "port"
                            ? "number"
                            : "text"
                      }
                      autoComplete="off"
                      value={form[k]}
                      onChange={(e) =>
                        setForm({ ...form, [k]: e.target.value })
                      }
                    />
                  )}
                </FormField>
              </div>
            ),
          )}
          <div className="w-48">
            <Select
              aria-label={t("app.requestTypes")}
              value={form.requestTypeId || types?.[0]?.id}
              onValueChange={(v) => setForm({ ...form, requestTypeId: v })}
              options={(types ?? []).map((x) => ({
                value: x.id,
                label: x.name,
              }))}
            />
          </div>
          <Button type="submit">{t("app.admin.add")}</Button>
        </form>
      )}
    </Section>
  );
}

// --- CSV ------------------------------------------------------------------------------

/** Header row of a CSV file, with "," or ";" like the server reads it. */
const headerOf = (text: string) => {
  const line = text.replace(/^\uFEFF/, "").split(/\r?\n/)[0] ?? "";
  const sep =
    (line.match(/;/g)?.length ?? 0) > (line.match(/,/g)?.length ?? 0)
      ? ";"
      : ",";
  return line.split(sep).map((h) => h.replace(/^"|"$/g, "").trim());
};

function ImportExport({ projectKey }: { projectKey: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const fields = useFields().data ?? [];
  const label = useFieldLabel();
  const meta = useMeta().data;
  const [csv, setCsv] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [typeId, setTypeId] = useState<string>();
  const [check, setCheck] = useState<{
    rows: number;
    errors: { key: string; message: string }[];
  } | null>(null);
  const [job, setJob] = useState<{
    id: string;
    state: string;
    done: number;
    total: number;
    errors: { key: string; message: string }[];
  } | null>(null);
  const targets = [
    { value: "type", label: t("app.type") },
    ...fields
      .filter((f) => !["status", "resolution", "type"].includes(f.key))
      .map((f) => ({ value: f.key, label: label(f) })),
  ];
  const type =
    typeId ??
    meta?.issueTypes.find((x) => x.name === "Task")?.id ??
    meta?.issueTypes[0]?.id;
  const send = (dryRun: boolean) =>
    call<
      typeof check & {
        id: string;
        state: string;
        done: number;
        total: number;
        errors: [];
      }
    >("POST", `/projects/${projectKey}/import`, {
      csv,
      typeId: type,
      dryRun,
      mapping: Object.fromEntries(
        Object.entries(mapping).filter(([, v]) => v !== "-"),
      ),
    });
  const poll = (id: string) => {
    void call<NonNullable<typeof job>>("GET", `/bulk/${id}`).then((s) => {
      setJob(s);
      if (s.state === "running") setTimeout(() => poll(id), 1000);
      else
        void queryClient.invalidateQueries({
          queryKey: keys.issues(projectKey),
        });
    });
  };
  const header = csv ? headerOf(csv) : [];
  return (
    <Section title={t("app.csv")}>
      <div>
        <a
          href={`/tickvana/api/projects/${projectKey}/export.csv`}
          className="text-fg underline-offset-4 hover:underline"
        >
          {t("app.exportCsv")}
        </a>
      </div>
      <FormField label={t("app.importCsv")} hint={t("app.importHint")}>
        {(p) => (
          <input
            {...p}
            type="file"
            accept=".csv,text/csv"
            className="text-sm text-fg"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              void file.text().then((text) => {
                setCsv(text);
                setCheck(null);
                setJob(null);
                // Columns named like a field key map to it by default.
                setMapping(
                  Object.fromEntries(
                    headerOf(text).map((h) => [
                      h,
                      targets.some((x) => x.value === h) ? h : "-",
                    ]),
                  ),
                );
              });
            }}
          />
        )}
      </FormField>
      {header.length > 0 && (
        <>
          <div className="w-56">
            <Select
              aria-label={t("app.defaultType")}
              value={type}
              onValueChange={setTypeId}
              options={(meta?.issueTypes ?? []).map((x) => ({
                value: x.id,
                label: `${t("app.defaultType")}: ${x.name}`,
              }))}
            />
          </div>
          <ul className="flex flex-col gap-1">
            {header.map((h) => (
              <li key={h} className="flex items-center gap-2">
                <span className="w-48 truncate text-sm text-fg">{h}</span>
                <div className="w-56">
                  <Select
                    aria-label={`${t("app.column")}: ${h}`}
                    value={mapping[h] ?? "-"}
                    onValueChange={(v) => setMapping({ ...mapping, [h]: v })}
                    options={[{ value: "-", label: t("app.skip") }, ...targets]}
                  />
                </div>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              onClick={() =>
                void send(true)
                  .then((r) => setCheck(r))
                  .catch((e: Error) =>
                    toast({ title: e.message, tone: "negative" }),
                  )
              }
            >
              {t("app.dryRun")}
            </Button>
            <Button
              variant="primary"
              disabled={!check || check.errors.length > 0}
              onClick={() =>
                void send(false)
                  .then((r) => poll(r.id))
                  .catch((e: Error) =>
                    toast({ title: e.message, tone: "negative" }),
                  )
              }
            >
              {t("app.import")}
            </Button>
          </div>
          {check && (
            <div role="status" className="flex flex-col gap-1 text-sm">
              <p className="text-fg-2">
                {t("app.rowsChecked", { count: check.rows })}
              </p>
              {check.errors.map((e, i) => (
                <p key={i} className="text-negative">
                  {e.key}: {e.message}
                </p>
              ))}
            </div>
          )}
          {job && (
            <div role="status" className="flex flex-col gap-1 text-sm">
              <Progress done={job.done} total={job.total} />
              {job.errors.map((e, i) => (
                <p key={i} className="text-negative">
                  {e.key}: {e.message}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// --- Knowledge base --------------------------------------------------------------------

/** Which Nuvenna space the portal searches before a request is sent. */
function KnowledgeSpace({ projectKey }: { projectKey: string }) {
  const { t } = useTranslation();
  const run = useRun();
  const key = ["knowledge-space", projectKey];
  const current = useQuery({
    queryKey: key,
    queryFn: () =>
      call<{ spaceKey: string | null }>(
        "GET",
        `/projects/${projectKey}/knowledge-space`,
      ),
  }).data;
  const [value, setValue] = useState<string | null>(null);
  if (!current) return null;
  const shown = value ?? current.spaceKey ?? "";
  return (
    <Section title={t("app.knowledge.title")}>
      <p className="text-sm text-fg-2">{t("app.knowledge.hint")}</p>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            call("PUT", `/projects/${projectKey}/knowledge-space`, {
              spaceKey: shown.trim().toUpperCase() || null,
            }),
            key,
          ).then(() => setValue(null));
        }}
      >
        <div className="w-48">
          <FormField label={t("app.knowledge.space")}>
            {(p) => (
              <Input
                {...p}
                pattern="[A-Za-z][A-Za-z0-9]{1,19}"
                value={shown}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </FormField>
        </div>
        <Button type="submit">{t("app.save")}</Button>
      </form>
    </Section>
  );
}
