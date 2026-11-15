// Parts of the ticket page besides fields and comments: transitions with
// their screen, editing a field in place, time tracking, links and
// sub-tasks, attachments, watching and voting.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ApiError,
  Button,
  Dialog,
  Field as FormField,
  IconButton,
  Input,
  IssueKey,
  Select,
  useApp,
  useToast,
} from "@tvn/ui";
import { Eye, Paperclip, Pencil, ThumbsUp, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  keys,
  unwrap,
  useMeta,
  useUsers,
  type Field,
  type Issue,
  type Transition,
} from "./api.js";
import { FieldInput, LayoutFields } from "./forms.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

// ponytail: a few of these paths take runtime parts openapi-fetch cannot type; the server validates every body.
type Call = (path: string, init?: object) => Promise<never>;
const call = <T,>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: object,
) =>
  unwrap<T>((api[method] as unknown as Call)(`/tickvana/api${path}`, { body }));

/** Refreshes the ticket and everything hanging on it. */
function useRefresh(key: string) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "issue" && q.queryKey[1] === key,
    });
}

/** Problems the server reports per field, by field key. */
const problemsOf = (e: unknown) =>
  Object.fromEntries(
    (e instanceof ApiError && Array.isArray(e.details)
      ? (e.details as { field?: string; message?: string }[])
      : []
    )
      .filter((d) => d.field)
      .map((d) => [d.field!, d.message ?? ""]),
  );

// --- Transitions ----------------------------------------------------------------------

export function TransitionButtons({
  issue,
  projectKey,
}: {
  issue: Issue;
  projectKey: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const refresh = useRefresh(issue.key);
  const transitions = useQuery({
    queryKey: keys.issuePart(issue.key, "transitions"),
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/issues/{key}/transitions", {
          params: { path: { key: issue.key } },
        }),
      ),
  }).data;
  const [screen, setScreen] = useState<Transition | null>(null);
  const run = useMutation({
    mutationFn: ({
      id,
      fields,
    }: {
      id: string;
      fields: Record<string, unknown>;
    }) =>
      unwrap(
        api.POST("/tickvana/api/issues/{key}/transitions", {
          params: { path: { key: issue.key } },
          body: { transitionId: id, fields },
        }),
      ),
    onSuccess: () => {
      setScreen(null);
      void refresh();
    },
    onError: (e, vars) => {
      // A transition without its own screen that still lacks a value: show it as a screen.
      const tr = transitions?.find((x) => x.id === vars.id);
      if (tr?.fieldLayoutId && !screen) setScreen(tr);
      else if (!screen)
        toast({
          title: t("state.errorTitle"),
          text: (e as Error).message,
          tone: "negative",
        });
    },
  });
  return (
    <>
      {transitions?.map((tr) => (
        <Button
          key={tr.id}
          size="sm"
          disabled={run.isPending}
          onClick={() =>
            tr.fieldLayoutId
              ? setScreen(tr)
              : run.mutate({ id: tr.id, fields: {} })
          }
        >
          {tr.name}
        </Button>
      ))}
      {screen && (
        <TransitionScreen
          issue={issue}
          projectKey={projectKey}
          transition={screen}
          pending={run.isPending}
          error={run.error}
          onClose={() => {
            setScreen(null);
            run.reset();
          }}
          onSubmit={(fields) => run.mutate({ id: screen.id, fields })}
        />
      )}
    </>
  );
}

function TransitionScreen({
  issue,
  projectKey,
  transition,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  issue: Issue;
  projectKey: string;
  transition: Transition;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (fields: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, unknown>>(issue.fields);
  const [touched, setTouched] = useState<Record<string, unknown>>({});
  const problems = problemsOf(error);
  const message =
    error && Object.keys(problems).length === 0
      ? (error as Error).message
      : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={transition.name}
      closeLabel={t("shell.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("app.cancel")}</Button>
          <Button
            variant="primary"
            type="submit"
            form="transition-form"
            disabled={pending}
          >
            {transition.name}
          </Button>
        </>
      }
    >
      <form
        id="transition-form"
        className="flex flex-col gap-4 pb-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onSubmit(touched);
        }}
      >
        <LayoutFields
          layoutId={transition.fieldLayoutId ?? undefined}
          operation="transition"
          values={values}
          projectKey={projectKey}
          onChange={(k, v) => {
            setValues({ ...values, [k]: v });
            setTouched({ ...touched, [k]: v });
          }}
          problems={problems}
        />
        {message && (
          <p role="alert" className="text-sm text-negative">
            {message}
          </p>
        )}
      </form>
    </Dialog>
  );
}

// --- Editing in place -----------------------------------------------------------------

/** A detail row that turns into an input on click and saves just this field. */
export function InlineField({
  issue,
  field,
  label,
  projectKey,
  children,
}: {
  issue: Issue;
  field: Field;
  label: string;
  projectKey: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const refresh = useRefresh(issue.key);
  const [value, setValue] = useState<unknown>(undefined);
  const editing = value !== undefined;
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (editing)
      form.current
        ?.querySelector<HTMLElement>(
          "input, textarea, button, [contenteditable]",
        )
        ?.focus();
  }, [editing]);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/tickvana/api/issues/{key}", {
          params: { path: { key: issue.key } },
          body: { fields: { [field.key]: value } },
        }),
      ),
    onSuccess: () => {
      setValue(undefined);
      void refresh();
    },
  });
  const problem =
    problemsOf(save.error)[field.key] ?? (save.error as Error | null)?.message;
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-start gap-2 py-1">
      <dt className="pt-1 text-sm text-fg-2">{label}</dt>
      <dd className="min-w-0">
        {editing ? (
          <form
            ref={form}
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <FormField label={label} error={problem}>
              {(a11y) => (
                <FieldInput
                  field={field}
                  value={value}
                  onChange={setValue}
                  a11y={a11y}
                  projectKey={projectKey}
                />
              )}
            </FormField>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                type="submit"
                disabled={save.isPending}
              >
                {t("app.save")}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setValue(undefined);
                  save.reset();
                }}
              >
                {t("app.cancel")}
              </Button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            aria-label={`${label} ${t("app.edit")}`}
            onClick={() => setValue(issue.fields[field.key] ?? null)}
            className="group flex w-full items-start gap-2 rounded-sm px-1 text-left text-base text-fg transition-colors hover:bg-raised"
          >
            <span className="min-w-0 flex-1 break-words">{children}</span>
            <Pencil
              {...icon}
              className="mt-1 text-fg-3 opacity-0 group-hover:opacity-100"
            />
          </button>
        )}
      </dd>
    </div>
  );
}

/** The key of a ticket referenced by id, as a link. */
export function IssueRef({ id }: { id: string }) {
  const ref = useQuery({
    queryKey: ["issue-ref", id],
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/issues/{key}", {
          params: { path: { key: id } },
        }),
      ),
    staleTime: 60_000,
  }).data;
  if (!ref) return <span className="text-fg-3">…</span>;
  return (
    <Link
      to="/issues/$key"
      params={{ key: ref.key }}
      className="underline-offset-4 hover:underline"
      onClick={(e) => e.stopPropagation()}
    >
      {ref.key} {ref.fields.summary as string}
    </Link>
  );
}

// --- Watching and voting --------------------------------------------------------------

export function WatchVote({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const { me } = useApp();
  const toast = useToast();
  const queryClient = useQueryClient();
  const watchers = useQuery({
    queryKey: keys.issuePart(issue.key, "watchers"),
    queryFn: () => call<string[]>("GET", `/issues/${issue.key}/watchers`),
  }).data;
  const votes = useQuery({
    queryKey: keys.issuePart(issue.key, "votes"),
    queryFn: () =>
      call<{ count: number; voted: boolean }>(
        "GET",
        `/issues/${issue.key}/votes`,
      ),
  }).data;
  const watching = watchers?.includes(me.id) ?? false;
  const toggle = (part: "watchers" | "votes", on: boolean) =>
    call(
      on ? "DELETE" : "PUT",
      part === "watchers"
        ? `/issues/${issue.key}/watchers/${me.id}`
        : `/issues/${issue.key}/votes`,
    )
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: keys.issuePart(issue.key, part),
        }),
      )
      .catch((e: Error) => toast({ title: e.message, tone: "negative" }));
  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        aria-pressed={watching}
        onClick={() => void toggle("watchers", watching)}
      >
        <Eye {...icon} />
        {watching ? t("app.unwatch") : t("app.watch")} · {watchers?.length ?? 0}
      </Button>
      <Button
        size="sm"
        aria-pressed={votes?.voted ?? false}
        onClick={() => void toggle("votes", votes?.voted ?? false)}
      >
        <ThumbsUp {...icon} />
        {t("app.vote")} · {votes?.count ?? 0}
      </Button>
    </div>
  );
}

// --- Time tracking --------------------------------------------------------------------

export function Worklogs({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const users = useUsers().data ?? [];
  const refresh = useRefresh(issue.key);
  const toast = useToast();
  const list = useQuery({
    queryKey: keys.issuePart(issue.key, "worklogs"),
    queryFn: () =>
      call<
        {
          id: string;
          authorId: string;
          startedAt: string;
          seconds: number;
          note: string;
        }[]
      >("GET", `/issues/${issue.key}/worklogs`),
  }).data;
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ hours: "", day: today, note: "" });
  const hours = (s: number) => `${Math.round((s / 3600) * 100) / 100} h`;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg-2">
        {t("app.spent")}: {hours(issue.spentSec)}
        {typeof issue.fields.remaining === "number" &&
          ` · ${t("app.remaining")}: ${hours(issue.fields.remaining)}`}
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void call("POST", `/issues/${issue.key}/worklogs`, {
            seconds: Math.round(Number(form.hours.replace(",", ".")) * 3600),
            startedAt: new Date(`${form.day}T09:00:00`).toISOString(),
            note: form.note,
          })
            .then(() => {
              setForm({ hours: "", day: today, note: "" });
              return refresh();
            })
            .catch((err: Error) =>
              toast({ title: err.message, tone: "negative" }),
            );
        }}
      >
        <div className="w-28">
          <FormField label={t("app.hours")}>
            {(p) => (
              <Input
                {...p}
                required
                inputMode="decimal"
                value={form.hours}
                onChange={(e) => setForm({ ...form, hours: e.target.value })}
              />
            )}
          </FormField>
        </div>
        <div className="w-40">
          <FormField label={t("app.day")}>
            {(p) => (
              <Input
                {...p}
                type="date"
                required
                value={form.day}
                onChange={(e) => setForm({ ...form, day: e.target.value })}
              />
            )}
          </FormField>
        </div>
        <div className="min-w-48 flex-1">
          <FormField label={t("app.note")}>
            {(p) => (
              <Input
                {...p}
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            )}
          </FormField>
        </div>
        <Button type="submit">{t("app.logTime")}</Button>
      </form>
      <ul className="flex flex-col gap-2">
        {list?.map((w) => (
          <li key={w.id} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="w-28 text-fg-3">
              {new Date(w.startedAt).toLocaleDateString()}
            </span>
            <span className="w-32 text-fg">
              {users.find((u) => u.id === w.authorId)?.displayName ?? "…"}
            </span>
            <span className="w-16 text-fg">{hours(w.seconds)}</span>
            <span className="flex-1 text-fg-2">{w.note}</span>
            <IconButton
              label={t("app.delete")}
              onClick={() =>
                void call("DELETE", `/worklogs/${w.id}`)
                  .then(refresh)
                  .catch((err: Error) =>
                    toast({ title: err.message, tone: "negative" }),
                  )
              }
            >
              <X {...icon} />
            </IconButton>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Links and sub-tasks --------------------------------------------------------------

export function Relations({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const toast = useToast();
  const meta = useMeta().data;
  const refresh = useRefresh(issue.key);
  const status = (id: string) => meta?.statuses.find((s) => s.id === id);
  const children = useQuery({
    queryKey: keys.issuePart(issue.key, "children"),
    queryFn: () =>
      call<{ id: string; key: string; summary: string; statusId: string }[]>(
        "GET",
        `/issues/${issue.key}/children`,
      ),
  }).data;
  const links = useQuery({
    queryKey: keys.issuePart(issue.key, "links"),
    queryFn: () =>
      call<
        {
          id: string;
          relation: string;
          issue: { key: string; summary: string; statusId: string };
        }[]
      >("GET", `/issues/${issue.key}/links`),
  }).data;
  const types = useQuery({
    queryKey: ["link-types"],
    queryFn: () => unwrap(api.GET("/tickvana/api/link-types")),
  }).data;
  const [form, setForm] = useState({ typeId: "", toKey: "" });
  const typeId = form.typeId || types?.[0]?.id;
  const row = (
    key: string,
    summary: string,
    statusId: string,
    end?: ReactNode,
  ) => (
    <li key={key} className="flex items-center gap-2 text-sm">
      <IssueKey done={status(statusId)?.category === "done"}>{key}</IssueKey>
      <Link
        to="/issues/$key"
        params={{ key }}
        className="flex-1 truncate text-fg underline-offset-4 hover:underline"
      >
        {summary}
      </Link>
      <span className="text-fg-3">{status(statusId)?.name}</span>
      {end}
    </li>
  );
  return (
    <div className="flex flex-col gap-4">
      {children && children.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-fg-2">{t("app.children")}</h3>
          <ul className="flex flex-col gap-1">
            {children.map((c) => row(c.key, c.summary, c.statusId))}
          </ul>
        </section>
      )}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-fg-2">{t("app.links")}</h3>
        <ul className="flex flex-col gap-1">
          {links?.map((l) =>
            row(
              l.issue.key,
              `${l.relation}: ${l.issue.summary}`,
              l.issue.statusId,
              <IconButton
                label={t("app.delete")}
                onClick={() =>
                  void call("DELETE", `/links/${l.id}`)
                    .then(refresh)
                    .catch((e: Error) =>
                      toast({ title: e.message, tone: "negative" }),
                    )
                }
              >
                <X {...icon} />
              </IconButton>,
            ),
          )}
        </ul>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void call("POST", `/issues/${issue.key}/links`, {
              typeId,
              toKey: form.toKey,
            })
              .then(() => {
                setForm({ ...form, toKey: "" });
                return refresh();
              })
              .catch((err: Error) =>
                toast({ title: err.message, tone: "negative" }),
              );
          }}
        >
          <div className="w-48">
            <Select
              aria-label={t("app.linkType")}
              value={typeId}
              onValueChange={(v) => setForm({ ...form, typeId: v })}
              options={(types ?? []).map((x) => ({
                value: x.id,
                label: x.outward,
              }))}
            />
          </div>
          <div className="w-32">
            <Input
              aria-label={t("app.linkTo")}
              placeholder="ABC-12"
              required
              value={form.toKey}
              onChange={(e) => setForm({ ...form, toKey: e.target.value })}
            />
          </div>
          <Button type="submit" size="sm">
            {t("app.link")}
          </Button>
        </form>
      </section>
    </div>
  );
}

// --- Attachments ----------------------------------------------------------------------

export function Attachments({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const { api: core } = useApp();
  const toast = useToast();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const owner = `ownerType=issue&ownerId=${issue.id}`;
  const queryKey = keys.issuePart(issue.key, "attachments");
  const files = useQuery({
    queryKey,
    queryFn: () =>
      core.call<{ id: string; filename: string; size: number }[]>(
        "GET",
        `/core/attachments?${owner}`,
      ),
  }).data;
  const upload = async (list: FileList | null) => {
    for (const file of list ?? []) {
      const form = new FormData();
      form.append("file", file);
      await core
        .call("POST", `/core/attachments?${owner}`, form)
        .catch((e: Error) =>
          toast({ title: `${file.name}: ${e.message}`, tone: "negative" }),
        );
    }
    void queryClient.invalidateQueries({ queryKey });
  };
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void upload(e.dataTransfer.files);
      }}
      className={`flex flex-col gap-2 rounded-md border border-dashed p-3 transition-colors ${
        over ? "border-accent bg-raised" : "border-line"
      }`}
    >
      <div className="flex items-center gap-2">
        <Paperclip {...icon} className="text-fg-3" />
        <span className="flex-1 text-sm text-fg-2">{t("app.dropFiles")}</span>
        <Button size="sm" onClick={() => input.current?.click()}>
          {t("app.chooseFiles")}
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => void upload(e.target.files)}
        />
      </div>
      <ul className="flex flex-col gap-1">
        {files?.map((f) => (
          <li key={f.id} className="flex items-center gap-2 text-sm">
            <a
              href={`${core.base}/core/attachments/${f.id}`}
              className="flex-1 truncate text-fg underline-offset-4 hover:underline"
            >
              {f.filename}
            </a>
            <span className="text-fg-3">{Math.ceil(f.size / 1024)} KB</span>
            <IconButton
              label={`${t("app.delete")}: ${f.filename}`}
              onClick={() =>
                void core
                  .call("DELETE", `/core/attachments/${f.id}`)
                  .then(() => queryClient.invalidateQueries({ queryKey }))
                  .catch((e: Error) =>
                    toast({ title: e.message, tone: "negative" }),
                  )
              }
            >
              <X {...icon} />
            </IconButton>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Mentioned on pages ---------------------------------------------------------------

/** One page by id, titled by Nuvenna itself; nothing if Nuvenna is missing or the page hidden. */
function PageLink({ id }: { id: string }) {
  const page = useQuery({
    queryKey: ["pages-ref", id],
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch(`/nuvenna/api/pages/${id}`, {
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as { title: string; spaceKey: string };
    },
  }).data;
  if (!page) return null;
  return (
    <li>
      <a
        href={`/nuvenna/spaces/${page.spaceKey}/pages/${id}`}
        className="text-fg underline-offset-4 hover:underline"
      >
        {page.title}
      </a>
      <span className="ml-2 font-mono text-xs text-fg-3">{page.spaceKey}</span>
    </li>
  );
}

/** Pages the reader may write in; empty when Nuvenna is not installed. */
function useWritableSpaces() {
  return (
    useQuery({
      queryKey: ["pages-spaces"],
      retry: false,
      staleTime: 60_000,
      queryFn: async () => {
        const res = await fetch("/nuvenna/api/spaces", {
          credentials: "same-origin",
        });
        if (!res.ok) return [];
        const spaces = (await res.json()) as {
          key: string;
          name: string;
          rights: string[];
        }[];
        return spaces.filter((sp) => sp.rights.includes("space.edit"));
      },
    }).data ?? []
  );
}

/** Makes a page in Nuvenna that starts with this ticket, and opens it. */
function NewPageDialog({
  issue,
  spaces,
  onClose,
}: {
  issue: Issue;
  spaces: { key: string; name: string }[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [space, setSpace] = useState(spaces[0]!.key);
  const [title, setTitle] = useState(
    `${issue.key} ${String(issue.fields.summary ?? "")}`.slice(0, 500),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("app.newPage")}
      closeLabel={t("shell.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("app.cancel")}</Button>
          <Button variant="primary" type="submit" form="new-page-form">
            {t("app.create")}
          </Button>
        </>
      }
    >
      <form
        id="new-page-form"
        className="flex flex-col gap-4 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          void fetch(`/nuvenna/api/spaces/${space}/pages`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title,
              content: {
                type: "doc",
                content: [
                  { type: "issue", attrs: { key: issue.key } },
                  { type: "paragraph" },
                ],
              },
            }),
          })
            .then(async (res) => {
              if (!res.ok) throw new Error(String(res.status));
              const page = (await res.json()) as { id: string };
              window.location.assign(
                `/nuvenna/spaces/${space}/pages/${page.id}`,
              );
            })
            .catch((err: Error) =>
              toast({ title: err.message, tone: "negative" }),
            );
        }}
      >
        <FormField label={t("app.space")}>
          {(p) => (
            <Select
              id={p.id}
              value={space}
              onValueChange={setSpace}
              options={spaces.map((sp) => ({ value: sp.key, label: sp.name }))}
            />
          )}
        </FormField>
        <FormField label={t("app.title")}>
          {(p) => (
            <Input
              {...p}
              required
              maxLength={500}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          )}
        </FormField>
      </form>
    </Dialog>
  );
}

export function MentionedOnPages({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const spaces = useWritableSpaces();
  const [creating, setCreating] = useState(false);
  const ids = useQuery({
    queryKey: keys.issuePart(issue.key, "pages"),
    queryFn: () =>
      call<{ pageIds: string[] }>("GET", `/issues/${issue.key}/pages`),
  }).data?.pageIds;
  if (!ids?.length && !spaces.length) return null;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-medium text-fg-2">
          {t("app.onPages")}
        </h3>
        {spaces.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>
            {t("app.newPage")}
          </Button>
        )}
      </div>
      <ul className="flex flex-col gap-1 text-sm">
        {ids?.map((id) => (
          <PageLink key={id} id={id} />
        ))}
      </ul>
      {creating && (
        <NewPageDialog
          issue={issue}
          spaces={spaces}
          onClose={() => setCreating(false)}
        />
      )}
    </section>
  );
}
