// The self-service portal: a calm layout without sidebar. Start page with
// search and request types in groups, the request form, "my requests",
// and a request with its public conversation.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  Button,
  Card,
  EmptyState,
  Field as FormField,
  Input,
  IssueKey,
  RichTextEditor,
  RichTextView,
  Select,
  Status,
  Tabs,
  Textarea,
  useApp,
  type EditorLabels,
  type RichTextEditorProps,
} from "@tvn/ui";
import { ChevronRight, LogOut, Search } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, unwrap, useMeta } from "./api.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;
type Doc = NonNullable<RichTextEditorProps["value"]>;

// ponytail: portal paths with runtime parts; the server validates every body.
type Call = (path: string, init?: object) => Promise<never>;
const call = <T,>(method: "GET" | "POST", path: string, body?: object) =>
  unwrap<T>((api[method] as unknown as Call)(`/tickvana/api${path}`, { body }));

interface Home {
  key: string;
  name: string;
  requestTypes: {
    id: string;
    name: string;
    description: string;
    groupName: string;
  }[];
}
interface PortalField {
  key: string;
  name: string;
  type: string;
  system: boolean;
  required: boolean;
  options: { id: string; parentId: string | null; value: string }[];
}
interface Request {
  key: string;
  summary: string;
  statusId: string;
  requestType: string | null;
  updatedAt: string;
}

function PortalLayout({
  title,
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { branding, me, signOut } = useApp();
  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-4xl items-center gap-4 px-4 py-3">
          <Link to="/portal" className="flex-1 text-base font-medium text-fg">
            {branding.logoLightUrl ? (
              <img
                src={branding.logoLightUrl}
                alt={branding.productName}
                className="h-6"
              />
            ) : (
              branding.productName
            )}
          </Link>
          <Link
            to="/portal/requests"
            className="text-sm text-fg-2 hover:text-fg"
          >
            {t("app.portal.myRequests")}
          </Link>
          <span className="text-sm text-fg-3">{me.displayName}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={signOut}
            aria-label={t("shell.signOut")}
          >
            <LogOut {...icon} />
          </Button>
        </div>
      </header>
      <main className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8">
        {title && <h1 className="text-2xl font-medium text-fg">{title}</h1>}
        {children}
      </main>
    </div>
  );
}

export function PortalHome() {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const home = useQuery({
    queryKey: ["portal", "home"],
    queryFn: () => call<Home[]>("GET", "/portal/home"),
  });
  const match = (s: string) => s.toLowerCase().includes(q.trim().toLowerCase());
  const projects = (home.data ?? [])
    .map((p) => ({
      ...p,
      requestTypes: p.requestTypes.filter(
        (r) => match(r.name) || match(r.description),
      ),
    }))
    .filter((p) => p.requestTypes.length);
  return (
    <PortalLayout title={t("app.portal.welcome")}>
      <PendingApprovals />
      <div className="relative">
        <Search
          {...icon}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-3"
        />
        <Input
          type="search"
          aria-label={t("app.portal.search")}
          placeholder={t("app.portal.search")}
          className="pl-9"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {home.data && projects.length === 0 && (
        <EmptyState
          title={
            home.data.length
              ? t("app.portal.noMatch")
              : t("app.portal.nothingTitle")
          }
          text={home.data.length ? "" : t("app.portal.nothingText")}
        />
      )}
      {projects.map((p) => {
        const groups = [...new Set(p.requestTypes.map((r) => r.groupName))];
        return (
          <section key={p.key} className="flex flex-col gap-4">
            {home.data!.length > 1 && (
              <h2 className="text-lg font-medium text-fg">{p.name}</h2>
            )}
            {groups.map((g) => (
              <div key={g} className="flex flex-col gap-2">
                {g && <h3 className="text-sm font-medium text-fg-2">{g}</h3>}
                <Card>
                  <ul className="divide-y divide-line">
                    {p.requestTypes
                      .filter((r) => r.groupName === g)
                      .map((r) => (
                        <li key={r.id}>
                          <Link
                            to="/portal/new/$id"
                            params={{ id: r.id }}
                            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised"
                          >
                            <span className="flex flex-1 flex-col">
                              <span className="text-fg">{r.name}</span>
                              {r.description && (
                                <span className="text-sm text-fg-2">
                                  {r.description}
                                </span>
                              )}
                            </span>
                            <ChevronRight {...icon} className="text-fg-3" />
                          </Link>
                        </li>
                      ))}
                  </ul>
                </Card>
              </div>
            ))}
          </section>
        );
      })}
    </PortalLayout>
  );
}

function PortalInput({
  field,
  value,
  onChange,
  a11y,
}: {
  field: PortalField;
  value: unknown;
  onChange: (v: unknown) => void;
  a11y: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean };
}) {
  const { t } = useTranslation();
  const type = field.system ? field.key : field.type;
  if (type === "description" || type === "richtext")
    return (
      <RichTextEditor
        label={field.name}
        labels={t("editor", { returnObjects: true }) as EditorLabels}
        value={(value as Doc | null) ?? null}
        onChange={onChange}
        compact
      />
    );
  if (type === "textarea")
    return (
      <Textarea
        {...a11y}
        rows={4}
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  if (type === "select")
    return (
      <Select
        {...a11y}
        value={(value as string) ?? undefined}
        placeholder={t("app.perm.choose")}
        onValueChange={onChange}
        options={field.options.map((o) => ({ value: o.id, label: o.value }))}
      />
    );
  if (type === "checkbox")
    return (
      <input
        {...a11y}
        type="checkbox"
        className="size-4 self-start accent-accent"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  return (
    <Input
      {...a11y}
      required={field.required}
      type={
        type === "number"
          ? "number"
          : type === "date" || type === "dueDate"
            ? "date"
            : "text"
      }
      value={(value as string) ?? ""}
      onChange={(e) =>
        onChange(
          type === "number" ? Number(e.target.value) : e.target.value || null,
        )
      }
    />
  );
}

export function PortalNew() {
  const { t } = useTranslation();
  const { id } = useParams({ from: "/portal/new/$id" });
  const navigate = useNavigate();
  const form = useQuery({
    queryKey: ["portal", "form", id],
    queryFn: () =>
      call<{
        name: string;
        description: string;
        fields: PortalField[];
        knowledgeSpace: string | null;
      }>("GET", `/portal/request-types/${id}`),
  }).data;
  const [values, setValues] = useState<Record<string, unknown>>({});
  const send = useMutation({
    mutationFn: () =>
      call<{ key: string }>("POST", "/portal/requests", {
        requestTypeId: id,
        fields: values,
      }),
    onSuccess: (made) =>
      void navigate({ to: "/portal/requests/$key", params: { key: made.key } }),
  });
  if (!form) return <PortalLayout />;
  const fields = form.fields.some((f) => f.key === "summary")
    ? form.fields
    : [
        {
          key: "summary",
          name: t("app.summary"),
          type: "text",
          system: true,
          required: true,
          options: [],
        },
        ...form.fields,
      ];
  return (
    <PortalLayout title={form.name}>
      {form.description && <p className="text-fg-2">{form.description}</p>}
      <Card className="p-4">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          {fields.map((f) => (
            <FormField
              key={f.key}
              label={`${f.system && f.key === "summary" ? t("app.portal.summary") : f.system && f.key === "description" ? t("app.description") : f.name}${f.required ? " *" : ""}`}
            >
              {(a11y) => (
                <PortalInput
                  field={f}
                  value={values[f.key]}
                  a11y={a11y}
                  onChange={(v) => setValues({ ...values, [f.key]: v })}
                />
              )}
            </FormField>
          ))}
          {form.knowledgeSpace && (
            <Suggestions
              space={form.knowledgeSpace}
              text={String(values.summary ?? "")}
            />
          )}
          {send.error && (
            <p role="alert" className="text-sm text-negative">
              {(send.error as Error).message}
            </p>
          )}
          <div>
            <Button variant="primary" type="submit" disabled={send.isPending}>
              {t("app.portal.send")}
            </Button>
          </div>
        </form>
      </Card>
    </PortalLayout>
  );
}

/** Pages from the knowledge base that match what is being asked. */
function Suggestions({ space, text }: { space: string; text: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 400);
    return () => clearTimeout(timer);
  }, [text]);
  const hits =
    useQuery({
      queryKey: ["kb", space, q],
      enabled: q.length >= 3,
      retry: false,
      queryFn: async () => {
        const res = await fetch(
          `/nuvenna/api/kb/${space}/search?q=${encodeURIComponent(q)}`,
          { credentials: "same-origin" },
        );
        return res.ok
          ? ((await res.json()) as {
              id: string;
              title: string;
              excerpt: string;
            }[])
          : [];
      },
    }).data ?? [];
  if (!hits.length) return null;
  return (
    <section
      aria-live="polite"
      className="flex flex-col gap-2 rounded-md border border-line p-3"
    >
      <h2 className="text-sm font-medium text-fg-2">
        {t("app.knowledge.suggestions")}
      </h2>
      <ul className="flex flex-col gap-2">
        {hits.map((h) => (
          <li key={h.id} className="flex flex-col">
            <a
              href={`/tickvana/portal/kb/${space}/${h.id}`}
              target="_blank"
              rel="noopener"
              className="text-fg underline-offset-4 hover:underline"
            >
              {h.title}
            </a>
            {h.excerpt && (
              <span className="truncate text-sm text-fg-3">{h.excerpt}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One knowledge-base page, shown inside the portal. */
export function PortalArticle() {
  const { t } = useTranslation();
  const { space, id } = useParams({ from: "/portal/kb/$space/$id" });
  const page = useQuery({
    queryKey: ["kb-page", space, id],
    retry: false,
    queryFn: async () => {
      const res = await fetch(`/nuvenna/api/kb/${space}/pages/${id}`, {
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as { title: string; content: unknown };
    },
  });
  if (page.isError)
    return (
      <PortalLayout>
        <EmptyState title={t("app.notFoundTitle")} text="" />
      </PortalLayout>
    );
  if (!page.data) return <PortalLayout />;
  return (
    <PortalLayout title={page.data.title}>
      <RichTextView doc={page.data.content as never} />
    </PortalLayout>
  );
}

function RequestList({ scope }: { scope: "mine" | "organization" }) {
  const { t } = useTranslation();
  const meta = useMeta().data;
  const [q, setQ] = useState("");
  const list = useQuery({
    queryKey: ["portal", "requests", scope, q],
    queryFn: () =>
      call<Request[]>(
        "GET",
        `/portal/requests?scope=${scope}&q=${encodeURIComponent(q)}`,
      ),
  }).data;
  return (
    <div className="flex flex-col gap-3">
      <Input
        type="search"
        aria-label={t("app.portal.searchRequests")}
        placeholder={t("app.portal.searchRequests")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {list?.length === 0 && (
        <p className="text-fg-3">{t("app.portal.noRequests")}</p>
      )}
      <Card>
        <ul className="divide-y divide-line">
          {list?.map((r) => {
            const status = meta?.statuses.find((s) => s.id === r.statusId);
            return (
              <li key={r.key}>
                <Link
                  to="/portal/requests/$key"
                  params={{ key: r.key }}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-raised"
                >
                  <IssueKey done={status?.category === "done"}>
                    {r.key}
                  </IssueKey>
                  <span className="min-w-48 flex-1 text-fg">{r.summary}</span>
                  <span className="text-sm text-fg-3">{r.requestType}</span>
                  {status && (
                    <Status category={status.category}>{status.name}</Status>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

export function PortalRequests() {
  const { t } = useTranslation();
  return (
    <PortalLayout title={t("app.portal.myRequests")}>
      <Tabs
        label={t("app.portal.myRequests")}
        tabs={[
          {
            value: "mine",
            label: t("app.portal.mine"),
            content: <RequestList scope="mine" />,
          },
          {
            value: "org",
            label: t("app.portal.organization"),
            content: <RequestList scope="organization" />,
          },
        ]}
      />
    </PortalLayout>
  );
}

export function PortalRequest() {
  const { t } = useTranslation();
  const { key } = useParams({ from: "/portal/requests/$key" });
  const meta = useMeta().data;
  const queryClient = useQueryClient();
  const issue = useQuery({
    queryKey: ["portal", "request", key],
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/issues/{key}", { params: { path: { key } } }),
      ),
  });
  const comments = useQuery({
    queryKey: ["portal", "comments", key],
    queryFn: () =>
      call<{ id: string; authorId: string; body: Doc; createdAt: string }[]>(
        "GET",
        `/issues/${key}/comments`,
      ),
  }).data;
  const [reply, setReply] = useState<Doc | null>(null);
  const send = useMutation({
    mutationFn: () =>
      call("POST", `/issues/${key}/comments`, {
        body: reply,
        visibility: "public",
      }),
    onSuccess: () => {
      setReply(null);
      void queryClient.invalidateQueries({
        queryKey: ["portal", "comments", key],
      });
    },
  });
  const { me } = useApp();
  if (issue.isError)
    return (
      <PortalLayout>
        <EmptyState title={t("app.portal.notFound")} text="" />
      </PortalLayout>
    );
  if (!issue.data) return <PortalLayout />;
  const f = issue.data.fields;
  const status = meta?.statuses.find((s) => s.id === f.status);
  return (
    <PortalLayout>
      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-2">
          <IssueKey done={status?.category === "done"}>
            {issue.data.key}
          </IssueKey>
          {status && <Status category={status.category}>{status.name}</Status>}
        </p>
        <h1 className="text-2xl font-medium text-fg">{f.summary as string}</h1>
      </div>
      {Boolean(f.description) && <RichTextView doc={f.description as Doc} />}
      <Approvals issueKey={issue.data.key} />
      <Rating issueKey={issue.data.key} />
      <section aria-label={t("app.comments")} className="flex flex-col gap-4">
        <h2 className="text-lg font-medium text-fg">
          {t("app.portal.conversation")}
        </h2>
        {comments?.length === 0 && (
          <p className="text-fg-3">{t("app.portal.noAnswers")}</p>
        )}
        {comments?.map((c) => (
          <Card key={c.id} className="flex flex-col gap-2 p-4">
            <p className="text-sm text-fg-3">
              {c.authorId === me.id
                ? t("app.portal.you")
                : t("app.portal.team")}{" "}
              · {new Date(c.createdAt).toLocaleString()}
            </p>
            <RichTextView doc={c.body} />
          </Card>
        ))}
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <RichTextEditor
            label={t("app.portal.reply")}
            labels={t("editor", { returnObjects: true }) as EditorLabels}
            value={reply}
            onChange={setReply}
            compact
          />
          <div>
            <Button
              variant="primary"
              type="submit"
              disabled={!reply || send.isPending}
            >
              {t("app.portal.sendReply")}
            </Button>
          </div>
        </form>
      </section>
    </PortalLayout>
  );
}

/** Approvals of a ticket; the approver can decide right here. */
export function Approvals({ issueKey }: { issueKey: string }) {
  const { t } = useTranslation();
  const { me } = useApp();
  const queryClient = useQueryClient();
  const users = useQuery({
    queryKey: ["approval-users", issueKey],
    queryFn: () =>
      call<{ id: string; displayName: string }[]>(
        "GET",
        "/core/users?limit=100",
      ),
    retry: false,
  }).data;
  const list = useQuery({
    queryKey: ["issue", issueKey, "approvals"],
    queryFn: () =>
      call<
        {
          id: string;
          approverId: string;
          decision: "approved" | "declined" | null;
        }[]
      >("GET", `/issues/${issueKey}/approvals`),
  }).data;
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: string }) =>
      call("POST", `/approvals/${id}/decision`, { decision }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["issue", issueKey] });
      void queryClient.invalidateQueries({ queryKey: ["portal"] });
    },
  });
  if (!list?.length) return null;
  return (
    <section
      aria-label={t("app.approval.title")}
      className="flex flex-col gap-2"
    >
      <h2 className="text-sm font-medium text-fg-2">
        {t("app.approval.title")}
      </h2>
      {list.map((a) => (
        <div key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="flex-1 text-fg">
            {a.approverId === me.id
              ? t("app.portal.you")
              : (users?.find((u) => u.id === a.approverId)?.displayName ?? "…")}
          </span>
          {a.decision ? (
            <span
              className={
                a.decision === "approved" ? "text-positive" : "text-negative"
              }
            >
              {t(`app.approval.${a.decision}`)}
            </span>
          ) : a.approverId === me.id ? (
            <>
              <Button
                size="sm"
                variant="primary"
                disabled={decide.isPending}
                onClick={() =>
                  decide.mutate({ id: a.id, decision: "approved" })
                }
              >
                {t("app.approval.approve")}
              </Button>
              <Button
                size="sm"
                disabled={decide.isPending}
                onClick={() =>
                  decide.mutate({ id: a.id, decision: "declined" })
                }
              >
                {t("app.approval.decline")}
              </Button>
            </>
          ) : (
            <span className="text-fg-3">{t("app.approval.pending")}</span>
          )}
        </div>
      ))}
    </section>
  );
}

/** "Waiting for your approval" on the portal start page. */
function PendingApprovals() {
  const { t } = useTranslation();
  const list = useQuery({
    queryKey: ["portal", "approvals"],
    queryFn: () =>
      call<{ id: string; key: string; summary: string }[]>(
        "GET",
        "/portal/approvals",
      ),
  }).data;
  if (!list?.length) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-fg-2">
        {t("app.approval.waiting")}
      </h2>
      <Card>
        <ul className="divide-y divide-line">
          {list.map((a) => (
            <li key={a.id}>
              <Link
                to="/portal/requests/$key"
                params={{ key: a.key }}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised"
              >
                <IssueKey>{a.key}</IssueKey>
                <span className="flex-1 text-fg">{a.summary}</span>
                <ChevronRight {...icon} className="text-fg-3" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

/** After a request is done, its reporter rates it once. */
function Rating({ issueKey }: { issueKey: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ["portal", "rating", issueKey],
    queryFn: () =>
      call<{ canRate: boolean; score: number | null }>(
        "GET",
        `/portal/requests/${issueKey}/rating`,
      ),
  }).data;
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const send = useMutation({
    mutationFn: () =>
      call("POST", `/portal/requests/${issueKey}/rating`, { score, comment }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["portal"] }),
  });
  if (state?.score)
    return (
      <p className="text-sm text-fg-2">
        {t("app.rating.thanks", { score: state.score })}
      </p>
    );
  if (!state?.canRate) return null;
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-base font-medium text-fg">
        {t("app.rating.question")}
      </h2>
      <div
        role="radiogroup"
        aria-label={t("app.rating.question")}
        className="flex gap-2"
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <Button
            key={n}
            size="sm"
            role="radio"
            aria-checked={score === n}
            variant={score === n ? "primary" : "secondary"}
            onClick={() => setScore(n)}
          >
            {n}
          </Button>
        ))}
      </div>
      <p className="text-sm text-fg-3">{t("app.rating.scale")}</p>
      <Textarea
        aria-label={t("app.rating.comment")}
        placeholder={t("app.rating.comment")}
        rows={2}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <div>
        <Button
          variant="primary"
          disabled={!score || send.isPending}
          onClick={() => send.mutate()}
        >
          {t("app.rating.send")}
        </Button>
      </div>
    </Card>
  );
}

/** Sign-up, shown without being signed in when the administrator allows it. */
export function PortalSignup() {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    displayName: "",
    email: "",
    password: "",
  });
  const settings = useQuery({
    queryKey: ["portal", "settings"],
    queryFn: () => call<{ signup: boolean }>("GET", "/portal/settings"),
  }).data;
  const send = useMutation({
    mutationFn: () =>
      call("POST", "/portal/signup", {
        ...form,
        locale: navigator.language.slice(0, 2),
      }),
    onSuccess: () => window.location.assign("/tickvana/portal"),
  });
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg p-6">
      <Card className="flex w-full max-w-sm flex-col gap-4 p-6">
        <h1 className="text-xl font-medium text-fg">
          {t("app.portal.signupTitle")}
        </h1>
        {settings && !settings.signup ? (
          <p className="text-fg-2">{t("app.portal.signupClosed")}</p>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              send.mutate();
            }}
          >
            {(["displayName", "email", "password"] as const).map((k) => (
              <FormField key={k} label={t(`app.portal.${k}`)}>
                {(p) => (
                  <Input
                    {...p}
                    required
                    type={
                      k === "email"
                        ? "email"
                        : k === "password"
                          ? "password"
                          : "text"
                    }
                    minLength={k === "password" ? 10 : undefined}
                    autoComplete={
                      k === "password"
                        ? "new-password"
                        : k === "email"
                          ? "email"
                          : "name"
                    }
                    value={form[k]}
                    onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                  />
                )}
              </FormField>
            ))}
            {send.error && (
              <p role="alert" className="text-sm text-negative">
                {(send.error as Error).message}
              </p>
            )}
            <Button variant="primary" type="submit" disabled={send.isPending}>
              {t("app.portal.signup")}
            </Button>
          </form>
        )}
        <a
          href="/tickvana/portal"
          className="text-sm text-fg-2 underline-offset-4 hover:underline"
        >
          {t("app.portal.toSignIn")}
        </a>
      </Card>
    </div>
  );
}

/** Under the sign-in form on portal pages, when sign-up is open. */
export function PortalSignupLink() {
  const { t } = useTranslation();
  const settings = useQuery({
    queryKey: ["portal", "settings"],
    queryFn: () => call<{ signup: boolean }>("GET", "/portal/settings"),
    enabled: window.location.pathname.startsWith("/tickvana/portal"),
  }).data;
  if (!settings?.signup) return null;
  return (
    <a
      href="/tickvana/portal/signup"
      className="text-sm text-fg-2 underline-offset-4 hover:underline"
    >
      {t("app.portal.signupLink")}
    </a>
  );
}
