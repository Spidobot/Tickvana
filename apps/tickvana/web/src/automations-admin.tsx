// Admin: automation rules with their trigger, conditions and actions, the
// run log, and a dry run against one ticket.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  Field as FormField,
  IconButton,
  Input,
  Select,
  Textarea,
  useToast,
} from "@tvn/ui";
import { Plus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AdminFrame } from "./admin.js";
import {
  api,
  unwrap,
  useFields,
  useMeta,
  useProjects,
  useUsers,
} from "./api.js";
import { useFieldLabel } from "./forms.js";

/** Shown literally in the hint: the server replaces them per ticket. */
const PLACEHOLDERS = { replace: { key: "{{key}}", summary: "{{summary}}" } };
const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

type Obj = Record<string, unknown>;
interface Rule {
  id?: string;
  projectKey: string | null;
  name: string;
  trigger: Obj;
  conditions: Obj[];
  actions: Obj[];
  enabled: boolean;
}

const EVENTS = [
  "issue.*",
  "issue.created",
  "issue.updated",
  "issue.transitioned",
  "issue.commented",
  "issue.assigned",
];
const OPS = ["=", "!=", "contains", "empty", "not_empty"];
const ACTIONS: Record<string, Obj> = {
  setFields: { kind: "setFields", fields: {} },
  transition: { kind: "transition", toStatusId: "" },
  comment: { kind: "comment", text: "", visibility: "internal" },
  assign: { kind: "assign", to: "author" },
  createIssue: {
    kind: "createIssue",
    projectKey: "",
    typeId: "",
    fields: { summary: "" },
  },
  mail: {
    kind: "mail",
    to: "assignee",
    subject: "{{key}}: {{summary}}",
    body: "",
  },
  webhook: { kind: "webhook", event: "" },
};

// ponytail: the rule shapes are checked by the server's schema; the editor works on plain objects.
type Call = (path: string, init?: object) => Promise<never>;
const call = <T,>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: object,
) =>
  unwrap<T>((api[method] as unknown as Call)(`/tickvana/api${path}`, { body }));

const useSavedQueries = () =>
  useQuery({
    queryKey: ["saved-queries"],
    queryFn: () => call<{ id: string; name: string }[]>("GET", "/core/queries"),
  });

export function AutomationsAdminPage() {
  const { t } = useTranslation();
  const projects = useProjects().data ?? [];
  const [scope, setScope] = useState("-");
  const [editing, setEditing] = useState<Rule | null>(null);
  const projectKey = scope === "-" ? null : scope;
  const path = `/automations${projectKey ? `?project=${projectKey}` : ""}`;
  const rules = useQuery({
    queryKey: ["automations", scope],
    queryFn: () => call<(Rule & { id: string })[]>("GET", path),
  }).data;
  const blank = (): Rule => ({
    projectKey,
    name: "",
    trigger: { kind: "event", types: ["issue.created"] },
    conditions: [],
    actions: [{ ...ACTIONS.comment }],
    enabled: true,
  });

  return (
    <AdminFrame title={t("app.admin.pages.automations")}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-56">
            <Select
              aria-label={t("app.auto.scope")}
              value={scope}
              onValueChange={(v) => {
                setScope(v);
                setEditing(null);
              }}
              options={[
                { value: "-", label: t("app.auto.global") },
                ...projects.map((p) => ({ value: p.key, label: p.name })),
              ]}
            />
          </div>
          <Button size="sm" onClick={() => setEditing(blank())}>
            <Plus {...icon} />
            {t("app.auto.new")}
          </Button>
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <Card>
            <ul className="divide-y divide-line">
              {rules?.length === 0 && (
                <li className="px-4 py-3 text-sm text-fg-3">
                  {t("app.auto.none")}
                </li>
              )}
              {rules?.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-current={editing?.id === r.id}
                    onClick={() => setEditing(r)}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-raised aria-[current=true]:bg-raised"
                  >
                    <span
                      className={
                        r.enabled ? "flex-1 text-fg" : "flex-1 text-fg-3"
                      }
                    >
                      {r.name}
                    </span>
                    <span className="text-sm text-fg-3">
                      {t(`app.auto.triggers.${String(r.trigger.kind)}`)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {editing && (
            <RuleEditor
              key={editing.id ?? "new"}
              rule={editing}
              onSaved={setEditing}
              onDeleted={() => setEditing(null)}
            />
          )}
        </div>
      </div>
    </AdminFrame>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-fg-2">{title}</h3>
      {children}
    </section>
  );
}

function RuleEditor({
  rule,
  onSaved,
  onDeleted,
}: {
  rule: Rule;
  onSaved: (rule: Rule) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const queries = useSavedQueries().data ?? [];
  const [r, setR] = useState<Rule>(rule);
  const [testKey, setTestKey] = useState("");
  const [result, setResult] = useState<{ state: string; log: string[] } | null>(
    null,
  );
  const trigger = r.trigger;
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["automations"] });
  const fail = (e: Error) => toast({ title: e.message, tone: "negative" });
  const save = () => {
    const { id, projectKey, ...body } = r;
    void (
      id
        ? call<Rule>("PUT", `/automations/${id}`, body)
        : call<Rule>("POST", "/automations", { ...body, projectKey })
    )
      .then((saved) => {
        void refresh();
        onSaved(saved);
        toast({ title: t("app.admin.saved") });
      })
      .catch(fail);
  };

  return (
    <Card className="flex flex-col gap-5 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <FormField label={t("app.admin.columns.name")}>
            {(p) => (
              <Input
                {...p}
                required
                maxLength={200}
                value={r.name}
                onChange={(e) => setR({ ...r, name: e.target.value })}
              />
            )}
          </FormField>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-fg">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={r.enabled}
            onChange={(e) => setR({ ...r, enabled: e.target.checked })}
          />
          {t("app.auto.enabled")}
        </label>
      </div>

      <Section title={t("app.auto.trigger")}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-48">
            <Select
              aria-label={t("app.auto.trigger")}
              value={String(trigger.kind)}
              onValueChange={(kind) =>
                setR({
                  ...r,
                  trigger:
                    kind === "event"
                      ? { kind, types: ["issue.created"] }
                      : kind === "schedule"
                        ? {
                            kind,
                            everyMinutes: 60,
                            queryId: queries[0]?.id ?? "",
                          }
                        : { kind },
                })
              }
              options={["event", "schedule", "manual"].map((k) => ({
                value: k,
                label: t(`app.auto.triggers.${k}`),
              }))}
            />
          </div>
          {trigger.kind === "event" && (
            <div className="w-56">
              <Select
                aria-label={t("app.auto.event")}
                value={(trigger.types as string[])[0]}
                onValueChange={(v) =>
                  setR({ ...r, trigger: { ...trigger, types: [v] } })
                }
                options={EVENTS.map((e) => ({
                  value: e,
                  label: t(`app.auto.events.${e}`),
                }))}
              />
            </div>
          )}
          {trigger.kind === "schedule" && (
            <>
              <div className="w-56">
                <Select
                  aria-label={t("app.auto.query")}
                  placeholder={t("app.auto.query")}
                  value={String(trigger.queryId) || undefined}
                  onValueChange={(v) =>
                    setR({ ...r, trigger: { ...trigger, queryId: v } })
                  }
                  options={queries.map((q) => ({ value: q.id, label: q.name }))}
                />
              </div>
              <div className="w-28">
                <Input
                  type="number"
                  min={5}
                  aria-label={t("app.auto.everyMinutes")}
                  value={String(trigger.everyMinutes)}
                  onChange={(e) =>
                    setR({
                      ...r,
                      trigger: {
                        ...trigger,
                        everyMinutes: Number(e.target.value),
                      },
                    })
                  }
                />
              </div>
              <span className="text-sm text-fg-2">{t("app.auto.minutes")}</span>
            </>
          )}
        </div>
      </Section>

      <Section title={t("app.auto.conditions")}>
        {r.conditions.map((c, i) => (
          <ConditionRow
            key={i}
            value={c}
            onChange={(next) =>
              setR({
                ...r,
                conditions: r.conditions.map((x, j) => (j === i ? next : x)),
              })
            }
            onRemove={() =>
              setR({ ...r, conditions: r.conditions.filter((_, j) => j !== i) })
            }
          />
        ))}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setR({
                ...r,
                conditions: [
                  ...r.conditions,
                  {
                    kind: "field",
                    field: "summary",
                    op: "contains",
                    value: "",
                  },
                ],
              })
            }
          >
            <Plus {...icon} />
            {t("app.auto.fieldCondition")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setR({
                ...r,
                conditions: [
                  ...r.conditions,
                  { kind: "query", queryId: queries[0]?.id ?? "" },
                ],
              })
            }
          >
            <Plus {...icon} />
            {t("app.auto.queryCondition")}
          </Button>
        </div>
      </Section>

      <Section title={t("app.auto.actions")}>
        {r.actions.map((a, i) => (
          <ActionRow
            key={i}
            value={a}
            onChange={(next) =>
              setR({
                ...r,
                actions: r.actions.map((x, j) => (j === i ? next : x)),
              })
            }
            onRemove={() =>
              setR({ ...r, actions: r.actions.filter((_, j) => j !== i) })
            }
          />
        ))}
        <div className="w-56">
          <Select
            aria-label={t("app.auto.addAction")}
            placeholder={t("app.auto.addAction")}
            value={undefined}
            onValueChange={(kind) =>
              setR({ ...r, actions: [...r.actions, { ...ACTIONS[kind]! }] })
            }
            options={Object.keys(ACTIONS).map((k) => ({
              value: k,
              label: t(`app.auto.actionKinds.${k}`),
            }))}
          />
        </div>
      </Section>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={save}>
          {t("app.save")}
        </Button>
        {r.id && (
          <Button
            variant="ghost"
            onClick={() =>
              void call("DELETE", `/automations/${r.id}`)
                .then(() => {
                  void refresh();
                  onDeleted();
                })
                .catch(fail)
            }
          >
            {t("app.admin.delete")}
          </Button>
        )}
      </div>

      {r.id && (
        <Section title={t("app.auto.test")}>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void call<{ state: string; log: string[] }>(
                "POST",
                `/automations/${r.id}/test`,
                {
                  issueKey: testKey,
                },
              )
                .then(setResult)
                .catch(fail);
            }}
          >
            <div className="w-40">
              <Input
                aria-label={t("app.auto.ticket")}
                placeholder="WIT-12"
                required
                value={testKey}
                onChange={(e) => setTestKey(e.target.value)}
              />
            </div>
            <Button type="submit" size="sm">
              {t("app.auto.runTest")}
            </Button>
          </form>
          {result && (
            <p className="text-sm text-fg-2" role="status">
              {t(`app.auto.states.${result.state}`)}: {result.log.join(" · ")}
            </p>
          )}
        </Section>
      )}

      {r.id && <RunLog ruleId={r.id} />}
    </Card>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <IconButton label={t("app.admin.fields.remove")} onClick={onClick}>
      <X {...icon} />
    </IconButton>
  );
}

function ConditionRow({
  value,
  onChange,
  onRemove,
}: {
  value: Obj;
  onChange: (v: Obj) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const label = useFieldLabel();
  const fields = useFields().data ?? [];
  const queries = useSavedQueries().data ?? [];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {value.kind === "field" ? (
        <>
          <div className="w-44">
            <Select
              aria-label={t("app.auto.field")}
              value={String(value.field)}
              onValueChange={(field) => onChange({ ...value, field })}
              options={fields.map((f) => ({ value: f.key, label: label(f) }))}
            />
          </div>
          <div className="w-36">
            <Select
              aria-label={t("app.auto.op")}
              value={String(value.op)}
              onValueChange={(op) => onChange({ ...value, op })}
              options={OPS.map((o) => ({
                value: o,
                label: t(`app.auto.ops.${o}`),
              }))}
            />
          </div>
          {!["empty", "not_empty"].includes(String(value.op)) && (
            <div className="w-48">
              <Input
                aria-label={t("app.auto.value")}
                value={String(value.value ?? "")}
                onChange={(e) => onChange({ ...value, value: e.target.value })}
              />
            </div>
          )}
        </>
      ) : (
        <div className="w-64">
          <Select
            aria-label={t("app.auto.query")}
            value={String(value.queryId) || undefined}
            onValueChange={(queryId) => onChange({ ...value, queryId })}
            options={queries.map((q) => ({
              value: q.id,
              label: `${t("app.auto.inQuery")} ${q.name}`,
            }))}
          />
        </div>
      )}
      <RemoveButton onClick={onRemove} />
    </div>
  );
}

function ActionRow({
  value: a,
  onChange,
  onRemove,
}: {
  value: Obj;
  onChange: (v: Obj) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const label = useFieldLabel();
  const meta = useMeta().data;
  const users = useUsers().data ?? [];
  const projects = useProjects().data ?? [];
  const fields = (useFields().data ?? []).filter(
    (f) => !["status", "type", "resolution"].includes(f.key),
  );
  const set = (patch: Obj) => onChange({ ...a, ...patch });
  const text = (key: string, wide = false) => (
    <div className={wide ? "min-w-64 flex-1" : "w-48"}>
      <Input
        aria-label={t(`app.auto.params.${key}`)}
        placeholder={t(`app.auto.params.${key}`)}
        value={String(a[key] ?? "")}
        onChange={(e) => set({ [key]: e.target.value })}
      />
    </div>
  );
  const pick = (key: string, options: { value: string; label: string }[]) => (
    <div className="w-48">
      <Select
        aria-label={t(`app.auto.params.${key}`)}
        placeholder={t(`app.auto.params.${key}`)}
        value={a[key] === null ? "-" : String(a[key] ?? "") || undefined}
        onValueChange={(v) => set({ [key]: v === "-" ? null : v })}
        options={options}
      />
    </div>
  );
  const [fieldKey, fieldValue] = Object.entries(
    (a.fields as Obj | undefined) ?? {},
  )[0] ?? ["", ""];

  return (
    <div className="flex flex-wrap items-start gap-2 rounded-md border border-line p-2">
      <span className="w-32 pt-2 text-sm font-medium text-fg">
        {t(`app.auto.actionKinds.${String(a.kind)}`)}
      </span>
      {a.kind === "setFields" && (
        <>
          <div className="w-44">
            <Select
              aria-label={t("app.auto.field")}
              placeholder={t("app.auto.field")}
              value={fieldKey || undefined}
              onValueChange={(k) => set({ fields: { [k]: fieldValue } })}
              options={fields.map((f) => ({ value: f.key, label: label(f) }))}
            />
          </div>
          <div className="w-48">
            <Input
              aria-label={t("app.auto.value")}
              placeholder={t("app.auto.valueHint")}
              value={
                Array.isArray(fieldValue)
                  ? fieldValue.join(" ")
                  : String(fieldValue ?? "")
              }
              onChange={(e) =>
                set({
                  fields: {
                    [fieldKey]:
                      fieldKey === "labels"
                        ? e.target.value.split(/\s+/).filter(Boolean)
                        : e.target.value,
                  },
                })
              }
            />
          </div>
        </>
      )}
      {a.kind === "transition" &&
        pick(
          "toStatusId",
          (meta?.statuses ?? []).map((s) => ({ value: s.id, label: s.name })),
        )}
      {a.kind === "assign" &&
        pick("to", [
          { value: "author", label: t("app.auto.ruleAuthor") },
          { value: "reporter", label: t("app.reporter") },
          { value: "-", label: t("app.nobody") },
          ...users.map((u) => ({ value: u.id, label: u.displayName })),
        ])}
      {a.kind === "comment" && (
        <>
          <div className="min-w-64 flex-1">
            <Textarea
              aria-label={t("app.auto.params.text", PLACEHOLDERS)}
              placeholder={t("app.auto.params.text", PLACEHOLDERS)}
              rows={2}
              value={String(a.text)}
              onChange={(e) => set({ text: e.target.value })}
            />
          </div>
          {pick(
            "visibility",
            ["internal", "public"].map((v) => ({
              value: v,
              label: t(`app.auto.visibility.${v}`),
            })),
          )}
        </>
      )}
      {a.kind === "createIssue" && (
        <>
          {pick(
            "projectKey",
            projects.map((p) => ({ value: p.key, label: p.name })),
          )}
          {pick(
            "typeId",
            (meta?.issueTypes ?? []).map((x) => ({
              value: x.id,
              label: x.name,
            })),
          )}
          <div className="min-w-64 flex-1">
            <Input
              aria-label={t("app.summary")}
              placeholder={t("app.summary")}
              value={String((a.fields as Obj).summary ?? "")}
              onChange={(e) => set({ fields: { summary: e.target.value } })}
            />
          </div>
        </>
      )}
      {a.kind === "mail" && (
        <>
          {pick(
            "to",
            ["assignee", "reporter", "watchers"].map((v) => ({
              value: v,
              label: t(`app.auto.recipients.${v}`),
            })),
          )}
          {text("subject", true)}
          <div className="w-full">
            <Textarea
              aria-label={t("app.auto.params.body")}
              placeholder={t("app.auto.params.body")}
              rows={3}
              value={String(a.body)}
              onChange={(e) => set({ body: e.target.value })}
            />
          </div>
        </>
      )}
      {a.kind === "webhook" && text("event")}
      <RemoveButton onClick={onRemove} />
    </div>
  );
}

function RunLog({ ruleId }: { ruleId: string }) {
  const { t } = useTranslation();
  const runs = useQuery({
    queryKey: ["automations", "runs", ruleId],
    queryFn: () =>
      call<{ id: string; state: string; log: string[]; createdAt: string }[]>(
        "GET",
        `/automations/${ruleId}/runs`,
      ),
  }).data;
  return (
    <Section title={t("app.auto.log")}>
      {runs?.length === 0 && (
        <p className="text-sm text-fg-3">{t("app.auto.noRuns")}</p>
      )}
      <ul className="flex flex-col gap-1 text-sm">
        {runs?.map((x) => (
          <li key={x.id} className="flex flex-wrap gap-3">
            <span className="w-44 text-fg-3">
              {new Date(x.createdAt).toLocaleString()}
            </span>
            <span
              className={
                x.state === "failed" ? "w-28 text-negative" : "w-28 text-fg"
              }
            >
              {t(`app.auto.states.${x.state}`)}
            </span>
            <span className="flex-1 text-fg-2">{x.log.join(" · ")}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
