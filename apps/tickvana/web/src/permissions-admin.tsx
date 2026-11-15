// Admin: roles, permission and notification schemes, security levels of a
// project and global permissions. Every list edits in place; the server
// checks every change.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  IconButton,
  Input,
  Menu,
  Select,
  Tabs,
  useToast,
} from "@tvn/ui";
import { MoreHorizontal, Plus, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { AdminFrame } from "./admin.js";
import { api, keys, unwrap, useProjects, useUsers } from "./api.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

const GRANTEES = [
  "role",
  "group",
  "user",
  "reporter",
  "assignee",
  "customer",
  "logged_in",
  "anyone",
];
const RECIPIENTS = [
  "assignee",
  "reporter",
  "watchers",
  "project_lead",
  "role",
  "group",
  "user",
];
const NAMED = new Set(["role", "group", "user"]);

// ponytail: these admin paths are built at runtime, which openapi-fetch cannot type; the server validates everything.
type Call = (path: string, init?: object) => Promise<never>;
const call = <T,>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: object,
) =>
  unwrap<T>((api[method] as unknown as Call)(`/tickvana/api${path}`, { body }));

function useRun() {
  const toast = useToast();
  const queryClient = useQueryClient();
  return (promise: Promise<unknown>, ...invalidate: (readonly string[])[]) =>
    promise
      .then(() =>
        Promise.all(
          invalidate.map((queryKey) =>
            queryClient.invalidateQueries({ queryKey }),
          ),
        ),
      )
      .catch((e: Error) => toast({ title: e.message, tone: "negative" }));
}

const useRoles = () =>
  useQuery({
    queryKey: ["admin", "roles"],
    queryFn: () => call<{ id: string; name: string }[]>("GET", "/admin/roles"),
  });
const useGroups = () =>
  useQuery({
    queryKey: ["admin", "groups"],
    queryFn: () => call<{ id: string; name: string }[]>("GET", "/core/groups"),
  });

/** "Role Members", "Group Support", "Reporter": a grantee in words. */
function useWho() {
  const { t } = useTranslation();
  const roles = useRoles().data ?? [];
  const groups = useGroups().data ?? [];
  const users = useUsers().data ?? [];
  return (type: string, id: string | null) => {
    const name =
      id &&
      ([...roles, ...groups].find((x) => x.id === id)?.name ??
        users.find((u) => u.id === id)?.displayName ??
        id);
    return name
      ? `${t(`app.perm.grantees.${type}`)}: ${name}`
      : t(`app.perm.grantees.${type}`);
  };
}

/** Grantee type plus, for roles, groups and users, who exactly. */
function WhoPicker({
  types,
  value,
  onChange,
}: {
  types: string[];
  value: { type: string; id: string | null };
  onChange: (value: { type: string; id: string | null }) => void;
}) {
  const { t } = useTranslation();
  const roles = useRoles().data ?? [];
  const groups = useGroups().data ?? [];
  const users = useUsers().data ?? [];
  const choices =
    value.type === "role"
      ? roles
      : value.type === "group"
        ? groups
        : users.map((u) => ({ id: u.id, name: u.displayName }));
  return (
    <>
      <div className="w-44">
        <Select
          aria-label={t("app.perm.who")}
          value={value.type}
          onValueChange={(type) => onChange({ type, id: null })}
          options={types.map((x) => ({
            value: x,
            label: t(`app.perm.grantees.${x}`),
          }))}
        />
      </div>
      {NAMED.has(value.type) && (
        <div className="w-48">
          <Select
            aria-label={t(`app.perm.grantees.${value.type}`)}
            placeholder={t("app.perm.choose")}
            value={value.id ?? undefined}
            onValueChange={(id) => onChange({ ...value, id })}
            options={choices.map((c) => ({ value: c.id, label: c.name }))}
          />
        </div>
      )}
    </>
  );
}

export function PermissionsAdminPage() {
  const { t } = useTranslation();
  return (
    <AdminFrame title={t("app.admin.pages.permissions")}>
      <Tabs
        label={t("app.admin.pages.permissions")}
        tabs={[
          { value: "roles", label: t("app.perm.roles"), content: <Roles /> },
          {
            value: "permission",
            label: t("app.perm.permissionSchemes"),
            content: <Schemes kind="permission" />,
          },
          {
            value: "notification",
            label: t("app.perm.notificationSchemes"),
            content: <Schemes kind="notification" />,
          },
          {
            value: "levels",
            label: t("app.perm.securityLevels"),
            content: <SecurityLevels />,
          },
          {
            value: "global",
            label: t("app.perm.global"),
            content: <GlobalGrants />,
          },
        ]}
      />
    </AdminFrame>
  );
}

/** A one-line form: a text input and an add button. */
function AddName({
  label,
  onAdd,
}: {
  label: string;
  onAdd: (name: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  return (
    <form
      className="flex max-w-md gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void onAdd(name).then(() => setName(""));
      }}
    >
      <Input
        aria-label={label}
        placeholder={label}
        required
        maxLength={200}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Button type="submit">
        <Plus {...icon} />
        {t("app.admin.add")}
      </Button>
    </form>
  );
}

function Roles() {
  const { t } = useTranslation();
  const run = useRun();
  const roles = useRoles().data ?? [];
  const key = ["admin", "roles"];
  return (
    <div className="flex flex-col gap-4">
      <AddName
        label={t("app.perm.newRole")}
        onAdd={(name) => run(call("POST", "/admin/roles", { name }), key)}
      />
      <Card>
        <ul className="divide-y divide-line">
          {roles.map((r) => (
            <li key={r.id} className="flex items-center gap-2 px-4 py-2">
              <span className="flex-1 text-fg">{r.name}</span>
              <Menu
                trigger={
                  <IconButton label={t("app.admin.actions")}>
                    <MoreHorizontal {...icon} />
                  </IconButton>
                }
                items={[
                  {
                    label: t("app.perm.rename"),
                    // ponytail: the browser's prompt for a one-word rename; a dialog when renaming needs more.
                    onSelect: () => {
                      const name = window.prompt(t("app.perm.rename"), r.name);
                      if (name)
                        void run(
                          call("PATCH", `/admin/roles/${r.id}`, { name }),
                          key,
                        );
                    },
                  },
                  {
                    label: t("app.admin.delete"),
                    onSelect: () =>
                      void run(call("DELETE", `/admin/roles/${r.id}`), key),
                  },
                ]}
              />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

interface Scheme {
  id: string;
  name: string;
  projects: string[];
  entries: ({ id: string } & Record<string, string | null>)[];
}

function Schemes({ kind }: { kind: "permission" | "notification" }) {
  const { t } = useTranslation();
  const run = useRun();
  const path = `/admin/${kind}-schemes`;
  const key = ["admin", kind];
  const schemes = useQuery({
    queryKey: key,
    queryFn: () => call<Scheme[]>("GET", path),
  }).data;
  return (
    <div className="flex flex-col gap-4">
      <AddName
        label={t("app.perm.newScheme")}
        onAdd={(name) =>
          run(call("POST", path, { name, copyFrom: schemes?.[0]?.id }), key)
        }
      />
      {schemes?.map((s) => (
        <SchemeCard key={s.id} kind={kind} scheme={s} path={path} />
      ))}
    </div>
  );
}

function SchemeCard({
  kind,
  scheme,
  path,
}: {
  kind: "permission" | "notification";
  scheme: Scheme;
  path: string;
}) {
  const { t } = useTranslation();
  const run = useRun();
  const who = useWho();
  const projects = useProjects().data ?? [];
  const key = ["admin", kind];
  const what = kind === "permission" ? "permission" : "eventType";
  const typeKey = kind === "permission" ? "granteeType" : "recipientType";
  const idKey = kind === "permission" ? "granteeId" : "recipientId";
  const whats =
    kind === "permission"
      ? [
          "project.browse",
          "project.administer",
          "issue.create",
          "issue.edit",
          "issue.delete",
          "issue.assign",
          "issue.transition",
          "issue.comment",
          "issue.attach",
          "issue.worklog",
          "comment.internal",
        ]
      : [
          "issue.created",
          "issue.updated",
          "issue.transitioned",
          "issue.commented",
          "issue.assigned",
          "issue.deleted",
        ];
  const types = kind === "permission" ? GRANTEES : RECIPIENTS;
  const [adding, setAdding] = useState({
    what: whats[0]!,
    who: { type: types[0]!, id: null as string | null },
  });
  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(
      call("POST", `${path}/${scheme.id}/entries`, {
        [what]: adding.what,
        [typeKey]: adding.who.type,
        [idKey]: adding.who.id,
      }),
      key,
    );
  };
  const others = projects.filter((p) => !scheme.projects.includes(p.key));

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex-1 text-base font-medium text-fg">{scheme.name}</h3>
        <span className="text-sm text-fg-3">
          {scheme.projects.length
            ? scheme.projects.join(", ")
            : t("app.perm.noProjects")}
        </span>
        {others.length > 0 && (
          <div className="w-44">
            <Select
              aria-label={t("app.perm.assign")}
              placeholder={t("app.perm.assign")}
              value={undefined}
              onValueChange={(projectKey) =>
                void run(
                  call("PATCH", `/projects/${projectKey}`, {
                    [`${kind}SchemeId`]: scheme.id,
                  }),
                  ["admin", "permission"],
                  ["admin", "notification"],
                  keys.projects,
                )
              }
              options={others.map((p) => ({ value: p.key, label: p.name }))}
            />
          </div>
        )}
        <Menu
          trigger={
            <IconButton label={t("app.admin.actions")}>
              <MoreHorizontal {...icon} />
            </IconButton>
          }
          items={[
            {
              label: t("app.perm.rename"),
              onSelect: () => {
                const name = window.prompt(t("app.perm.rename"), scheme.name);
                if (name)
                  void run(
                    call("PATCH", `${path}/${scheme.id}`, { name }),
                    key,
                  );
              },
            },
            {
              label: t("app.perm.copy"),
              onSelect: () =>
                void run(
                  call("POST", path, {
                    name: `${scheme.name} (2)`,
                    copyFrom: scheme.id,
                  }),
                  key,
                ),
            },
            {
              label: t("app.admin.delete"),
              onSelect: () =>
                void run(call("DELETE", `${path}/${scheme.id}`), key),
            },
          ]}
        />
      </div>
      <dl className="flex flex-col gap-2">
        {whats.map((w) => {
          const entries = scheme.entries.filter((e) => e[what] === w);
          return (
            <div key={w} className="flex flex-wrap items-baseline gap-2">
              <dt className="w-56 text-sm text-fg-2">
                {t(
                  `app.perm.${kind === "permission" ? "permissions" : "events"}.${w}`,
                )}
              </dt>
              <dd className="flex flex-1 flex-wrap gap-1">
                {entries.length === 0 && (
                  <span className="text-sm text-fg-3">—</span>
                )}
                {entries.map((e) => (
                  <span
                    key={e.id}
                    className="inline-flex items-center gap-1 rounded-md border border-line px-2 text-sm text-fg"
                  >
                    {who(e[typeKey]!, e[idKey] ?? null)}
                    <IconButton
                      label={t("app.perm.remove")}
                      onClick={() =>
                        void run(
                          call(
                            "DELETE",
                            `${path}/${scheme.id}/entries/${e.id}`,
                          ),
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
          );
        })}
      </dl>
      <form className="flex flex-wrap items-center gap-2" onSubmit={add}>
        <div className="w-56">
          <Select
            aria-label={t(
              kind === "permission" ? "app.perm.permission" : "app.perm.event",
            )}
            value={adding.what}
            onValueChange={(v) => setAdding({ ...adding, what: v })}
            options={whats.map((w) => ({
              value: w,
              label: t(
                `app.perm.${kind === "permission" ? "permissions" : "events"}.${w}`,
              ),
            }))}
          />
        </div>
        <WhoPicker
          types={types}
          value={adding.who}
          onChange={(v) => setAdding({ ...adding, who: v })}
        />
        <Button type="submit" size="sm">
          {t("app.admin.add")}
        </Button>
      </form>
    </Card>
  );
}

function SecurityLevels() {
  const { t } = useTranslation();
  const run = useRun();
  const who = useWho();
  const projects = useProjects().data ?? [];
  const [project, setProject] = useState<string>();
  const selected = project ?? projects[0]?.key;
  const key = ["admin", "levels", selected ?? ""];
  const levels = useQuery({
    queryKey: key,
    queryFn: () =>
      call<
        {
          id: string;
          name: string;
          members: {
            id: string;
            granteeType: string;
            granteeId: string | null;
          }[];
        }[]
      >("GET", `/projects/${selected}/security-levels`),
    enabled: !!selected,
  }).data;
  const [adding, setAdding] = useState<
    Record<string, { type: string; id: string | null }>
  >({});
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose text-sm text-fg-2">
        {t("app.perm.levelsHint")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-56">
          <Select
            aria-label={t("app.projects")}
            value={selected}
            onValueChange={setProject}
            options={projects.map((p) => ({ value: p.key, label: p.name }))}
          />
        </div>
      </div>
      {selected && (
        <AddName
          label={t("app.perm.newLevel")}
          onAdd={(name) =>
            run(
              call("POST", `/projects/${selected}/security-levels`, { name }),
              key,
            )
          }
        />
      )}
      {levels?.map((l) => {
        const value = adding[l.id] ?? { type: "reporter", id: null };
        return (
          <Card key={l.id} className="flex flex-col gap-3 p-4">
            <div className="flex items-center gap-2">
              <h3 className="flex-1 text-base font-medium text-fg">{l.name}</h3>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void run(call("DELETE", `/security-levels/${l.id}`), key)
                }
              >
                {t("app.admin.delete")}
              </Button>
            </div>
            <div className="flex flex-wrap gap-1">
              {l.members.map((m) => (
                <span
                  key={m.id}
                  className="inline-flex items-center gap-1 rounded-md border border-line px-2 text-sm text-fg"
                >
                  {who(m.granteeType, m.granteeId)}
                  <IconButton
                    label={t("app.perm.remove")}
                    onClick={() =>
                      void run(
                        call(
                          "DELETE",
                          `/security-levels/${l.id}/members/${m.id}`,
                        ),
                        key,
                      )
                    }
                  >
                    <X {...icon} />
                  </IconButton>
                </span>
              ))}
            </div>
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  call("POST", `/security-levels/${l.id}/members`, {
                    granteeType: value.type,
                    granteeId: value.id,
                  }),
                  key,
                );
              }}
            >
              <WhoPicker
                types={GRANTEES}
                value={value}
                onChange={(v) => setAdding({ ...adding, [l.id]: v })}
              />
              <Button type="submit" size="sm">
                {t("app.admin.add")}
              </Button>
            </form>
          </Card>
        );
      })}
    </div>
  );
}

function GlobalGrants() {
  const { t } = useTranslation();
  const run = useRun();
  const who = useWho();
  const key = ["admin", "global"];
  const data = useQuery({
    queryKey: key,
    queryFn: () =>
      call<{
        permissions: string[];
        grants: {
          id: string;
          permission: string;
          granteeType: string;
          granteeId: string | null;
        }[];
      }>("GET", "/core/permissions/global"),
  }).data;
  const [adding, setAdding] = useState({
    permission: "",
    who: { type: "group", id: null as string | null },
  });
  if (!data) return null;
  const permission = adding.permission || data.permissions[0]!;
  return (
    <Card className="flex flex-col gap-3 p-4">
      <dl className="flex flex-col gap-2">
        {data.permissions.map((p) => (
          <div key={p} className="flex flex-wrap items-baseline gap-2">
            <dt className="w-56 text-sm text-fg-2">
              {t(`app.perm.globalKeys.${p}`, p)}
            </dt>
            <dd className="flex flex-1 flex-wrap gap-1">
              {data.grants
                .filter((g) => g.permission === p)
                .map((g) => (
                  <span
                    key={g.id}
                    className="inline-flex items-center gap-1 rounded-md border border-line px-2 text-sm text-fg"
                  >
                    {who(g.granteeType, g.granteeId)}
                    <IconButton
                      label={t("app.perm.remove")}
                      onClick={() =>
                        void run(
                          call("DELETE", `/core/permissions/global/${g.id}`),
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
          void run(
            call("POST", "/core/permissions/global", {
              permission,
              granteeType: adding.who.type,
              granteeId: adding.who.id,
            }),
            key,
          );
        }}
      >
        <div className="w-56">
          <Select
            aria-label={t("app.perm.permission")}
            value={permission}
            onValueChange={(v) => setAdding({ ...adding, permission: v })}
            options={data.permissions.map((p) => ({
              value: p,
              label: t(`app.perm.globalKeys.${p}`, p),
            }))}
          />
        </div>
        <WhoPicker
          types={["group", "user", "logged_in", "anyone"]}
          value={adding.who}
          onChange={(v) => setAdding({ ...adding, who: v })}
        />
        <Button type="submit" size="sm">
          {t("app.admin.add")}
        </Button>
      </form>
    </Card>
  );
}
