// The query workbench, shared by Tickvana and Nuvenna: write SQL against the
// virtual tables, see the result, save and share the query.
import { sql as sqlLanguage, StandardSQL } from "@codemirror/lang-sql";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CodeMirror from "@uiw/react-codemirror";
import { ChevronRight, Download, Play, Save, Star, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  IconButton,
  Input,
  Table,
  Td,
  Th,
} from "../components.js";
import { Dialog, Select, useToast } from "../overlays.js";
import { useApp } from "./app.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

export interface SavedQuery {
  id: string;
  ownerId: string;
  name: string;
  sql: string;
  params: Record<string, string | number | boolean | null>;
  visibility: "private" | "group" | "global";
  groupId: string | null;
  favorite: boolean;
  mine: boolean;
}
export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}
interface Catalog {
  mayWrite: boolean;
  tables: {
    name: string;
    description: string;
    columns: { name: string; type: string; description: string }[];
  }[];
}

/** The editor wears the design tokens, light and dark. */
const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--surface)",
    color: "var(--fg)",
    fontSize: "13px",
  },
  ".cm-content": { fontFamily: "var(--font-mono)", padding: "12px 0" },
  ".cm-gutters": {
    backgroundColor: "var(--surface)",
    color: "var(--fg-3)",
    border: "none",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--raised)" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--brand-accent) 24%, transparent)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--surface)",
    border: "1px solid var(--line)",
    borderRadius: "8px",
    color: "var(--fg)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--raised)",
    color: "var(--fg)",
  },
});

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function ResultTable({ result }: { result: QueryResult }) {
  const { t } = useTranslation();
  if (result.rows.length === 0)
    return <p className="p-4 text-fg-3">{t("query.noRows")}</p>;
  return (
    <>
      <Table>
        <thead>
          <tr>
            {result.columns.map((c) => (
              <Th key={c} className="font-mono">
                {c}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i} className="transition-colors hover:bg-raised">
              {result.columns.map((c) => (
                <Td
                  key={c}
                  className={cx(
                    "max-w-96 truncate",
                    typeof row[c] === "number" &&
                      "text-right font-mono tabular-nums",
                  )}
                  title={cell(row[c])}
                >
                  {cell(row[c])}
                </Td>
              ))}
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="border-t border-line px-3 py-2 text-sm text-fg-2">
        {result.truncated
          ? t("query.rowsMore", { count: result.rows.length })
          : t("query.rows", { count: result.rows.length })}
      </p>
    </>
  );
}

export interface QueryWorkbenchProps {
  /** Open this saved query. */
  queryId?: string;
  /** Called after saving or opening, so the app can put the id in the address. */
  onOpen?: (id: string | undefined) => void;
  /** Statement shown when nothing is open yet. */
  starter?: string;
  /** A point-and-click filter above the editor. It reads the current SQL and replaces it. */
  builder?: (sql: string, setSql: (sql: string) => void) => ReactNode;
}

export function QueryWorkbench({
  queryId,
  onOpen,
  starter = "",
  builder,
}: QueryWorkbenchProps) {
  const { t } = useTranslation();
  const { api } = useApp();
  const toast = useToast();
  const queryClient = useQueryClient();

  const catalog = useQuery({
    queryKey: ["core", "query-catalog"],
    queryFn: () => api.call<Catalog>("GET", "/core/query/catalog"),
    staleTime: 60_000,
  });
  const saved = useQuery({
    queryKey: ["core", "queries"],
    queryFn: () => api.call<SavedQuery[]>("GET", "/core/queries"),
  });
  const open = saved.data?.find((q) => q.id === queryId);

  const [sql, setSql] = useState(starter);
  const [result, setResult] = useState<QueryResult>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [visibility, setVisibility] =
    useState<SavedQuery["visibility"]>("private");
  const mayWrite = catalog.data?.mayWrite ?? false;

  const run = useMutation({
    mutationFn: (statement: string) =>
      // Someone without the SQL permission can still run a shared query as it is.
      open && statement === open.sql
        ? api.call<QueryResult>("POST", `/core/queries/${open.id}/run`, {})
        : api.call<QueryResult>("POST", "/core/query/run", {
            sql: statement,
            params: open?.params ?? {},
          }),
    onSuccess: (data) => {
      setResult(data);
      setError(undefined);
    },
    onError: (e) => {
      setResult(undefined);
      setError((e as Error).message);
    },
  });

  // Opening a saved query loads and runs it.
  useEffect(() => {
    if (!open) return;
    setSql(open.sql);
    setName(open.name);
    setVisibility(open.visibility === "group" ? "private" : open.visibility);
    run.mutate(open.sql);
  }, [open?.id]);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["core", "queries"] });
  const failed = (e: unknown) =>
    toast({
      title: t("state.errorTitle"),
      text: (e as Error).message,
      tone: "negative",
    });

  const save = useMutation({
    mutationFn: () =>
      open?.mine
        ? api.call<SavedQuery>("PATCH", `/core/queries/${open.id}`, {
            name,
            sql,
            visibility,
          })
        : api.call<SavedQuery>("POST", "/core/queries", {
            name,
            sql,
            visibility,
          }),
    onSuccess: async (q) => {
      await refresh();
      setSaving(false);
      toast({ title: t("state.saved") });
      onOpen?.(q.id);
    },
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.call<void>("DELETE", `/core/queries/${id}`),
    onSuccess: async () => {
      await refresh();
      onOpen?.(undefined);
    },
    onError: failed,
  });
  const favorite = useMutation({
    mutationFn: (q: SavedQuery) =>
      api.call<void>(
        q.favorite ? "DELETE" : "PUT",
        `/core/queries/${q.id}/favorite`,
      ),
    onSuccess: refresh,
    onError: failed,
  });

  const extensions = useMemo(
    () => [
      sqlLanguage({
        dialect: StandardSQL,
        schema: Object.fromEntries(
          (catalog.data?.tables ?? []).map((table) => [
            table.name,
            table.columns.map((c) => c.name),
          ]),
        ),
      }),
      editorTheme,
      EditorView.lineWrapping,
      // The editable area is a textbox for assistive technology; give it a name.
      EditorView.contentAttributes.of({ "aria-label": t("query.editor") }),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: (view) => (run.mutate(view.state.doc.toString()), true),
          },
        ]),
      ),
    ],

    [catalog.data, t],
  );

  const sorted = [...(saved.data ?? [])].sort(
    (a, b) =>
      Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name),
  );

  return (
    <div className="grid grid-cols-[280px_minmax(0,1fr)] items-start gap-6 max-lg:grid-cols-1">
      <aside className="flex flex-col gap-6">
        <section aria-label={t("query.saved")} className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-fg-2">{t("query.saved")}</h2>
          {sorted.length === 0 && (
            <p className="text-sm text-fg-3">{t("query.noSaved")}</p>
          )}
          <ul className="flex flex-col gap-0.5">
            {sorted.map((q) => (
              <li key={q.id} className="flex items-center gap-1">
                <button
                  type="button"
                  aria-current={q.id === queryId ? "true" : undefined}
                  onClick={() => onOpen?.(q.id)}
                  className={cx(
                    "flex h-8 min-w-0 flex-1 items-center rounded-md px-2 text-left text-base transition-colors",
                    q.id === queryId
                      ? "bg-raised text-fg"
                      : "text-fg-2 hover:bg-raised hover:text-fg",
                  )}
                >
                  <span className="truncate">{q.name}</span>
                </button>
                <IconButton
                  label={
                    q.favorite
                      ? t("query.unfavorite", { name: q.name })
                      : t("query.favorite", { name: q.name })
                  }
                  aria-pressed={q.favorite}
                  onClick={() => favorite.mutate(q)}
                >
                  <Star {...icon} fill={q.favorite ? "currentColor" : "none"} />
                </IconButton>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label={t("query.tables")} className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-fg-2">{t("query.tables")}</h2>
          {catalog.data?.tables.map((table) => (
            <details key={table.name} className="group">
              <summary className="flex h-8 cursor-default list-none items-center gap-1 rounded-md px-1 font-mono text-sm text-fg transition-colors hover:bg-raised">
                <ChevronRight
                  {...icon}
                  className="text-fg-3 transition-transform group-open:rotate-90"
                />
                {table.name}
              </summary>
              <p className="px-6 pb-1 text-sm text-fg-2">{table.description}</p>
              <ul className="px-6 pb-2">
                {table.columns.map((c) => (
                  <li
                    key={c.name}
                    className="flex justify-between gap-2 py-0.5 text-sm"
                    title={c.description}
                  >
                    <span className="truncate font-mono text-fg">{c.name}</span>
                    <span className="text-fg-3">{c.type}</span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </section>
      </aside>

      <div className="flex min-w-0 flex-col gap-4">
        {builder?.(sql, setSql)}
        <Card className="overflow-hidden">
          <div aria-label={t("query.editor")} role="group">
            <CodeMirror
              value={sql}
              onChange={setSql}
              extensions={extensions}
              editable={mayWrite}
              basicSetup={{
                foldGutter: false,
                highlightActiveLineGutter: false,
              }}
              minHeight="120px"
              maxHeight="360px"
              theme="none"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-line p-2">
            <Button
              variant="primary"
              size="sm"
              disabled={run.isPending || !sql.trim()}
              onClick={() => run.mutate(sql)}
            >
              <Play {...icon} />
              {t("query.run")}
            </Button>
            {mayWrite && (
              <Button
                size="sm"
                disabled={!sql.trim()}
                onClick={() => setSaving(true)}
              >
                <Save {...icon} />
                {open?.mine ? t("query.save") : t("query.saveAs")}
              </Button>
            )}
            {open && (
              <>
                <a
                  className="inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm text-fg-2 transition-colors hover:bg-raised hover:text-fg"
                  href={`${api.base}/core/queries/${open.id}/export?format=csv`}
                >
                  <Download {...icon} />
                  CSV
                </a>
                <a
                  className="inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm text-fg-2 transition-colors hover:bg-raised hover:text-fg"
                  href={`${api.base}/core/queries/${open.id}/export?format=json`}
                >
                  <Download {...icon} />
                  JSON
                </a>
              </>
            )}
            <span className="flex-1" />
            {open?.mine && (
              <IconButton
                label={t("query.delete")}
                onClick={() => remove.mutate(open.id)}
              >
                <Trash2 {...icon} />
              </IconButton>
            )}
          </div>
        </Card>

        {error && (
          <p
            role="alert"
            className="rounded-lg border border-line bg-surface p-4 font-mono text-sm text-negative"
          >
            {error}
          </p>
        )}
        {result ? (
          <Card>
            <ResultTable result={result} />
          </Card>
        ) : (
          !error && (
            <EmptyState
              title={t("query.startTitle")}
              text={
                mayWrite ? t("query.startText") : t("query.startTextReadOnly")
              }
            />
          )
        )}
      </div>

      <Dialog
        open={saving}
        onOpenChange={setSaving}
        title={open?.mine ? t("query.save") : t("query.saveAs")}
        closeLabel={t("shell.close")}
        footer={
          <Button
            variant="primary"
            type="submit"
            form="query-save"
            disabled={save.isPending}
          >
            {t("query.save")}
          </Button>
        }
      >
        <form
          id="query-save"
          className="flex flex-col gap-4 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label={t("query.name")}>
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
          <Field label={t("query.visibility")}>
            {(p) => (
              <Select
                {...p}
                value={visibility}
                onValueChange={(v) =>
                  setVisibility(v as SavedQuery["visibility"])
                }
                options={[
                  { value: "private", label: t("query.private") },
                  { value: "global", label: t("query.global") },
                ]}
              />
            )}
          </Field>
        </form>
      </Dialog>
    </div>
  );
}
