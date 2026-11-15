// System administration shared by every app: people, groups, single sign-on,
// mail, API tokens, webhooks, audit log and background jobs.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, Field, Input, Table, Td, Th } from "../components.js";
import { Select, Tabs, useToast } from "../overlays.js";
import { useApp } from "./app.js";

interface User {
  id: string;
  email: string;
  displayName: string;
  kind: "internal" | "customer" | "service";
  active: boolean;
}
interface Group {
  id: string;
  name: string;
}

/** Runs a change, refreshes the given queries, reports errors as a toast. */
function useRun() {
  const toast = useToast();
  const queryClient = useQueryClient();
  return (promise: Promise<unknown>, ...queryKeys: string[][]) =>
    promise
      .then(() =>
        Promise.all(
          queryKeys.map((queryKey) =>
            queryClient.invalidateQueries({ queryKey }),
          ),
        ),
      )
      .catch((e: Error) => {
        toast({ title: e.message, tone: "negative" });
        throw e;
      });
}

function useGet<T>(path: string, enabled = true) {
  const { api } = useApp();
  return useQuery({
    queryKey: ["system", path],
    queryFn: () => api.call<T>("GET", path),
    enabled,
  });
}

const Check = ({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) => (
  <label className="flex items-center gap-2 text-sm text-fg">
    <input
      type="checkbox"
      className="size-4 accent-accent"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
    {label}
  </label>
);

const Row = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-wrap items-end gap-2">{children}</div>
);

export function SystemSettings() {
  const { t } = useTranslation();
  const tabs = [
    ["users", <Users />],
    ["groups", <Groups />],
    ["sso", <Settings kind="oidc" />],
    ["mail", <Settings kind="mail" />],
    ["tokens", <Tokens />],
    ["webhooks", <Webhooks />],
    ["audit", <Audit />],
    ["jobs", <Jobs />],
  ] as const;
  return (
    <Tabs
      label={t("system.title")}
      tabs={tabs.map(([value, content]) => ({
        value,
        label: t(`system.tabs.${value}`),
        content,
      }))}
    />
  );
}

// --- People and groups ----------------------------------------------------------------

function Users() {
  const { t } = useTranslation();
  const { api } = useApp();
  const run = useRun();
  const [q, setQ] = useState("");
  const path = `/core/users?includeInactive=true&limit=100&q=${encodeURIComponent(q)}`;
  const users = useGet<User[]>(path).data ?? [];
  const [form, setForm] = useState({
    email: "",
    displayName: "",
    kind: "internal",
  });
  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(api.call("POST", "/core/users", { ...form, invite: true }), [
      "system",
      path,
    ]).then(() => setForm({ email: "", displayName: "", kind: "internal" }));
  };
  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={add}>
        <Row>
          <Field label={t("system.displayName")}>
            {(p) => (
              <Input
                {...p}
                required
                value={form.displayName}
                onChange={(e) =>
                  setForm({ ...form, displayName: e.target.value })
                }
              />
            )}
          </Field>
          <Field label={t("auth.email")}>
            {(p) => (
              <Input
                {...p}
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            )}
          </Field>
          <div className="w-40">
            <Select
              aria-label={t("system.kind")}
              value={form.kind}
              onValueChange={(kind) => setForm({ ...form, kind })}
              options={["internal", "customer", "service"].map((k) => ({
                value: k,
                label: t(`system.kinds.${k}`),
              }))}
            />
          </div>
          <Button type="submit">{t("system.invite")}</Button>
        </Row>
      </form>
      <div className="max-w-sm">
        <Input
          type="search"
          aria-label={t("system.search")}
          placeholder={t("system.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>{t("system.displayName")}</Th>
              <Th>{t("auth.email")}</Th>
              <Th>{t("system.kind")}</Th>
              <Th className="w-36">
                <span className="sr-only">{t("system.status")}</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <Td className={u.active ? "text-fg" : "text-fg-3"}>
                  {u.displayName}
                </Td>
                <Td className="text-fg-2">{u.email}</Td>
                <Td className="text-fg-2">{t(`system.kinds.${u.kind}`)}</Td>
                <Td>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void run(
                        api.call("PATCH", `/core/users/${u.id}`, {
                          active: !u.active,
                        }),
                        ["system", path],
                      )
                    }
                  >
                    {u.active ? t("system.deactivate") : t("system.activate")}
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

function Groups() {
  const { t } = useTranslation();
  const { api } = useApp();
  const run = useRun();
  const groups = useGet<Group[]>("/core/groups").data ?? [];
  const [name, setName] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(api.call("POST", "/core/groups", { name }), [
            "system",
            "/core/groups",
          ]).then(() => setName(""));
        }}
      >
        <Row>
          <Field label={t("system.newGroup")}>
            {(p) => (
              <Input
                {...p}
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit">{t("system.add")}</Button>
        </Row>
      </form>
      <Card>
        <ul className="divide-y divide-line">
          {groups.map((g) => (
            <li key={g.id} className="flex flex-col gap-2 px-4 py-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-expanded={open === g.id}
                  className="flex-1 text-left text-fg underline-offset-4 hover:underline"
                  onClick={() => setOpen(open === g.id ? null : g.id)}
                >
                  {g.name}
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run(api.call("DELETE", `/core/groups/${g.id}`), [
                      "system",
                      "/core/groups",
                    ])
                  }
                >
                  {t("system.delete")}
                </Button>
              </div>
              {open === g.id && <Members group={g} />}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Members({ group }: { group: Group }) {
  const { t } = useTranslation();
  const { api } = useApp();
  const run = useRun();
  const path = `/core/groups/${group.id}/members`;
  const members = useGet<User[]>(path).data ?? [];
  const users = useGet<User[]>("/core/users?limit=100").data ?? [];
  const others = users.filter((u) => !members.some((m) => m.id === u.id));
  return (
    <div className="flex flex-col gap-2 pl-4">
      <ul className="flex flex-wrap gap-1">
        {members.map((m) => (
          <li
            key={m.id}
            className="inline-flex items-center gap-2 rounded-md border border-line px-2 text-sm text-fg"
          >
            {m.displayName}
            <button
              type="button"
              className="text-fg-3 hover:text-fg"
              aria-label={`${t("system.remove")}: ${m.displayName}`}
              onClick={() =>
                void run(api.call("DELETE", `${path}/${m.id}`), [
                  "system",
                  path,
                ])
              }
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {others.length > 0 && (
        <div className="w-64">
          <Select
            aria-label={t("system.addMember")}
            placeholder={t("system.addMember")}
            value={undefined}
            onValueChange={(id) =>
              void run(api.call("PUT", `${path}/${id}`, {}), ["system", path])
            }
            options={others.map((u) => ({ value: u.id, label: u.displayName }))}
          />
        </div>
      )}
    </div>
  );
}

// --- Sign-in and mail settings --------------------------------------------------------

type SettingField = [key: string, type: "text" | "number" | "bool" | "secret"];
const SETTINGS: Record<
  "oidc" | "mail",
  { path: string; fields: SettingField[] }
> = {
  oidc: {
    path: "/core/settings/oidc",
    fields: [
      ["enabled", "bool"],
      ["issuer", "text"],
      ["clientId", "text"],
      ["clientSecret", "secret"],
      ["scopes", "text"],
      ["label", "text"],
      ["groupsClaim", "text"],
      ["createUsers", "bool"],
      ["autoRedirect", "bool"],
      ["trustEmail", "bool"],
    ],
  },
  mail: {
    path: "/core/settings/mail",
    fields: [
      ["enabled", "bool"],
      ["host", "text"],
      ["port", "number"],
      ["secure", "bool"],
      ["user", "text"],
      ["password", "secret"],
      ["from", "text"],
    ],
  },
};

function Settings({ kind }: { kind: "oidc" | "mail" }) {
  const { path } = SETTINGS[kind];
  const stored = useGet<Record<string, unknown>>(path).data;
  // Remount with the loaded values so the form starts from them.
  return stored ? <SettingsForm kind={kind} stored={stored} /> : null;
}

function SettingsForm({
  kind,
  stored,
}: {
  kind: "oidc" | "mail";
  stored: Record<string, unknown>;
}) {
  const { t } = useTranslation();
  const { api, me } = useApp();
  const toast = useToast();
  const run = useRun();
  const { path, fields } = SETTINGS[kind];
  const [form, setForm] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      fields
        .filter(([, type]) => type !== "secret")
        .map(([key]) => [key, stored[key]]),
    ),
  );
  const hasSecret = Boolean(stored.hasSecret ?? stored.hasPassword);
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(api.call("PUT", path, form), ["system", path]).then(() =>
      toast({ title: t("system.saved") }),
    );
  };
  return (
    <Card className="max-w-2xl p-4">
      <form className="flex flex-col gap-4" onSubmit={save}>
        {kind === "oidc" && (
          <p className="text-sm text-fg-2">
            {t("system.oidcHint", {
              url: `${window.location.origin}${api.base}/core/auth/oidc/callback`,
            })}
          </p>
        )}
        {fields.map(([key, type]) =>
          type === "bool" ? (
            <div key={key} className="flex flex-col gap-1">
              <Check
                label={t(`system.${kind}.${key}`)}
                checked={Boolean(form[key])}
                onChange={(v) => setForm({ ...form, [key]: v })}
              />
              {t(`system.${kind}.${key}Hint`, "") && (
                <p className="pl-6 text-sm text-fg-3">
                  {t(`system.${kind}.${key}Hint`)}
                </p>
              )}
            </div>
          ) : (
            <Field
              key={key}
              label={t(`system.${kind}.${key}`)}
              hint={
                type === "secret" && hasSecret
                  ? t("system.secretKept")
                  : t(`system.${kind}.${key}Hint`, "") || undefined
              }
            >
              {(p) => (
                <Input
                  {...p}
                  type={
                    type === "secret"
                      ? "password"
                      : type === "number"
                        ? "number"
                        : "text"
                  }
                  autoComplete="off"
                  value={String(form[key] ?? "")}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      [key]:
                        type === "number"
                          ? Number(e.target.value)
                          : e.target.value,
                    })
                  }
                />
              )}
            </Field>
          ),
        )}
        <Row>
          <Button variant="primary" type="submit">
            {t("system.save")}
          </Button>
          {kind === "mail" && (
            <Button
              onClick={() =>
                void run(
                  api.call("POST", "/core/settings/mail/test", {
                    to: me.email,
                  }),
                ).then(() =>
                  toast({ title: t("system.mail.sent", { to: me.email }) }),
                )
              }
            >
              {t("system.mail.test")}
            </Button>
          )}
        </Row>
      </form>
    </Card>
  );
}

// --- API tokens and webhooks ----------------------------------------------------------

function Tokens() {
  const { t } = useTranslation();
  const { api } = useApp();
  const run = useRun();
  const path = "/core/auth/tokens";
  const tokens =
    useGet<
      {
        id: string;
        name: string;
        lastUsedAt: string | null;
        createdAt: string;
      }[]
    >(path).data ?? [];
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose text-sm text-fg-2">{t("system.tokensHint")}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void api.call<{ token: string }>("POST", path, { name }).then((r) => {
            setCreated(r.token);
            setName("");
            return run(Promise.resolve(), ["system", path]);
          });
        }}
      >
        <Row>
          <Field label={t("system.tokenName")}>
            {(p) => (
              <Input
                {...p}
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit">{t("system.add")}</Button>
        </Row>
      </form>
      {created && (
        <Card className="flex flex-col gap-2 p-4">
          <p className="text-sm text-fg-2">{t("system.tokenOnce")}</p>
          <code className="break-all font-mono text-sm text-fg">{created}</code>
        </Card>
      )}
      <Card>
        <ul className="divide-y divide-line">
          {tokens.map((tk) => (
            <li key={tk.id} className="flex items-center gap-2 px-4 py-2">
              <span className="flex-1 text-fg">{tk.name}</span>
              <span className="text-sm text-fg-3">
                {tk.lastUsedAt
                  ? t("system.lastUsed", {
                      date: new Date(tk.lastUsedAt).toLocaleDateString(),
                    })
                  : t("system.neverUsed")}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void run(api.call("DELETE", `${path}/${tk.id}`), [
                    "system",
                    path,
                  ])
                }
              >
                {t("system.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Webhooks() {
  const { t } = useTranslation();
  const { api } = useApp();
  const toast = useToast();
  const run = useRun();
  const path = "/core/webhooks";
  const data = useGet<{
    allowPrivateTargets: boolean;
    webhooks: {
      id: string;
      name: string;
      url: string;
      events: string[];
      active: boolean;
    }[];
  }>(path).data;
  const [form, setForm] = useState({ name: "", url: "", events: "issue.*" });
  const [secret, setSecret] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const deliveries = useGet<
    {
      id: string;
      eventType: string;
      attempt: number;
      statusCode: number | null;
      error: string | null;
      createdAt: string;
    }[]
  >(`${path}/${log}/deliveries`, !!log).data;
  const refresh = ["system", path];
  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void api
            .call<{ secret: string }>("POST", path, {
              ...form,
              events: form.events.split(/[\s,]+/).filter(Boolean),
            })
            .then((r) => {
              setSecret(r.secret);
              setForm({ name: "", url: "", events: "issue.*" });
              return run(Promise.resolve(), refresh);
            })
            .catch((err: Error) =>
              toast({ title: err.message, tone: "negative" }),
            );
        }}
      >
        <Row>
          <Field label={t("system.webhookName")}>
            {(p) => (
              <Input
                {...p}
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            )}
          </Field>
          <Field label={t("system.webhookUrl")}>
            {(p) => (
              <Input
                {...p}
                type="url"
                required
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
              />
            )}
          </Field>
          <Field label={t("system.webhookEvents")}>
            {(p) => (
              <Input
                {...p}
                required
                value={form.events}
                onChange={(e) => setForm({ ...form, events: e.target.value })}
              />
            )}
          </Field>
          <Button type="submit">{t("system.add")}</Button>
        </Row>
      </form>
      {secret && (
        <Card className="flex flex-col gap-2 p-4">
          <p className="text-sm text-fg-2">{t("system.webhookSecret")}</p>
          <code className="break-all font-mono text-sm text-fg">{secret}</code>
        </Card>
      )}
      {data && (
        <Check
          label={t("system.allowPrivate")}
          checked={data.allowPrivateTargets}
          onChange={(v) =>
            void run(
              api.call("PUT", `${path}/settings`, { allowPrivateTargets: v }),
              refresh,
            )
          }
        />
      )}
      <Card>
        <ul className="divide-y divide-line">
          {data?.webhooks.map((h) => (
            <li key={h.id} className="flex flex-col gap-2 px-4 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={h.active ? "text-fg" : "text-fg-3"}>
                  {h.name}
                </span>
                <span className="flex-1 truncate font-mono text-sm text-fg-3">
                  {h.url} · {h.events.join(", ")}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setLog(log === h.id ? null : h.id)}
                >
                  {t("system.deliveries")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void api
                      .call<{
                        statusCode: number | null;
                        error: string | null;
                      }>("POST", `${path}/${h.id}/test`)
                      .then((r) =>
                        toast({
                          title: r.error ?? `HTTP ${r.statusCode}`,
                          tone: r.error ? "negative" : "neutral",
                        }),
                      )
                  }
                >
                  {t("system.test")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run(
                      api.call("PATCH", `${path}/${h.id}`, {
                        active: !h.active,
                      }),
                      refresh,
                    )
                  }
                >
                  {h.active ? t("system.deactivate") : t("system.activate")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run(api.call("DELETE", `${path}/${h.id}`), refresh)
                  }
                >
                  {t("system.delete")}
                </Button>
              </div>
              {log === h.id && (
                <ul className="flex flex-col gap-1 pl-4 text-sm">
                  {deliveries?.map((d) => (
                    <li key={d.id} className="flex gap-3 text-fg-2">
                      <span className="w-44 text-fg-3">
                        {new Date(d.createdAt).toLocaleString()}
                      </span>
                      <span className="w-40">{d.eventType}</span>
                      <span className={d.error ? "text-negative" : "text-fg"}>
                        {d.error ?? `HTTP ${d.statusCode}`} · #{d.attempt}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

// --- Audit log and jobs ---------------------------------------------------------------

interface AuditEvent {
  id: string;
  type: string;
  actorId: string | null;
  entityType: string;
  entityId: string;
  payload: unknown;
  createdAt: string;
}

function Audit() {
  const { t } = useTranslation();
  const { api } = useApp();
  const users =
    useGet<User[]>("/core/users?includeInactive=true&limit=100").data ?? [];
  const [filter, setFilter] = useState({ type: "", actorId: "", entityId: "" });
  const [pages, setPages] = useState<AuditEvent[][]>([]);
  const query = (before?: string) =>
    "/core/audit?" +
    new URLSearchParams(
      Object.entries({
        ...filter,
        limit: "50",
        ...(before && { before }),
      }).filter(([, v]) => v),
    ).toString();
  const first = useGet<AuditEvent[]>(query()).data ?? [];
  const events = [first, ...pages].flat();
  const name = (id: string | null) =>
    id
      ? (users.find((u) => u.id === id)?.displayName ?? id)
      : t("system.systemActor");
  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPages([]);
        }}
      >
        <Row>
          <Field label={t("system.eventType")} hint={t("system.eventTypeHint")}>
            {(p) => (
              <Input
                {...p}
                value={filter.type}
                onChange={(e) => {
                  setPages([]);
                  setFilter({ ...filter, type: e.target.value });
                }}
              />
            )}
          </Field>
          <div className="w-48">
            <Select
              aria-label={t("system.actor")}
              placeholder={t("system.actor")}
              value={filter.actorId || "-"}
              onValueChange={(v) => {
                setPages([]);
                setFilter({ ...filter, actorId: v === "-" ? "" : v });
              }}
              options={[
                { value: "-", label: t("system.everyone") },
                ...users.map((u) => ({ value: u.id, label: u.displayName })),
              ]}
            />
          </div>
          <Field label={t("system.entityId")}>
            {(p) => (
              <Input
                {...p}
                value={filter.entityId}
                onChange={(e) => {
                  setPages([]);
                  setFilter({ ...filter, entityId: e.target.value });
                }}
              />
            )}
          </Field>
        </Row>
      </form>
      <Card>
        <Table>
          <thead>
            <tr>
              <Th className="w-48">{t("system.when")}</Th>
              <Th>{t("system.eventType")}</Th>
              <Th>{t("system.actor")}</Th>
              <Th>{t("system.entity")}</Th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <Td className="text-fg-3">
                  {new Date(e.createdAt).toLocaleString()}
                </Td>
                <Td className="font-mono text-sm text-fg">{e.type}</Td>
                <Td className="text-fg-2">{name(e.actorId)}</Td>
                <Td className="font-mono text-sm text-fg-2">
                  {e.entityType}{" "}
                  {(e.payload as { key?: string } | null)?.key ?? e.entityId}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {events.length > 0 && events.length % 50 === 0 && (
        <div>
          <Button
            onClick={() =>
              void api
                .call<AuditEvent[]>("GET", query(events.at(-1)!.id))
                .then((page) => setPages([...pages, page]))
            }
          >
            {t("system.more")}
          </Button>
        </div>
      )}
    </div>
  );
}

function Jobs() {
  const { t } = useTranslation();
  const { api } = useApp();
  const run = useRun();
  const [state, setState] = useState<string>("failed");
  const path = `/core/jobs?state=${state}`;
  const data = useGet<{
    counts: Record<string, number>;
    jobs: {
      id: string;
      type: string;
      attempts: number;
      runAt: string;
      lastError: string | null;
    }[];
  }>(path).data;
  return (
    <div className="flex flex-col gap-4">
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={t("system.status")}
      >
        {["failed", "pending", "running", "done"].map((s) => (
          <Button
            key={s}
            size="sm"
            variant={s === state ? "primary" : "secondary"}
            aria-pressed={s === state}
            onClick={() => setState(s)}
          >
            {t(`system.jobStates.${s}`)} · {data?.counts[s] ?? 0}
          </Button>
        ))}
      </div>
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>{t("system.jobType")}</Th>
              <Th className="w-24">{t("system.attempts")}</Th>
              <Th className="w-48">{t("system.runAt")}</Th>
              <Th>{t("system.error")}</Th>
              <Th className="w-28">
                <span className="sr-only">{t("system.retry")}</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {data?.jobs.map((j) => (
              <tr key={j.id}>
                <Td className="font-mono text-sm text-fg">{j.type}</Td>
                <Td className="text-fg-2">{j.attempts}</Td>
                <Td className="text-fg-3">
                  {new Date(j.runAt).toLocaleString()}
                </Td>
                <Td className="text-sm text-negative">{j.lastError}</Td>
                <Td>
                  {state === "failed" && (
                    <Button
                      size="sm"
                      onClick={() =>
                        void run(api.call("POST", `/core/jobs/${j.id}/retry`), [
                          "system",
                          path,
                        ])
                      }
                    >
                      {t("system.retry")}
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
