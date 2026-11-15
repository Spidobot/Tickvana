// Admin: the graphical workflow editor. Statuses are nodes, transitions are
// edges. Everything edits a draft; publishing replaces the live workflow and
// asks where tickets of dropped statuses go.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  Dialog,
  Field as FormField,
  IconButton,
  Input,
  Select,
  useToast,
} from "@tvn/ui";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AdminFrame } from "./admin.js";
import { api, unwrap, useFields, useMeta } from "./api.js";
import { useFieldLabel } from "./forms.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

type Rule = { fn: string } & Record<string, string>;
interface Transition {
  id?: string;
  name: string;
  fromStatusId: string | null;
  toStatusId: string;
  fieldLayoutId: string | null;
  rules: { conditions: Rule[]; validators: Rule[]; postFunctions: Rule[] };
}
interface Draft {
  name: string;
  statuses: { statusId: string; x: number; y: number }[];
  transitions: Transition[];
  saved: boolean;
  problems: { statusId: string; problem: string }[];
  displaced: { statusId: string; tickets: number }[];
}
type RuleList = keyof Transition["rules"];

// ponytail: these admin paths are not in the generated client's literal types; the server validates every body.
type Call = (path: string, init?: object) => Promise<never>;
const call = <T,>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: object,
) =>
  unwrap<T>((api[method] as unknown as Call)(`/tickvana/api${path}`, { body }));

/** A status on the canvas, coloured by its category. */
function StatusNode({
  data,
}: NodeProps<Node<{ label: string; category: string; problem?: string }>>) {
  const tone =
    data.category === "done"
      ? "border-positive"
      : data.category === "in_progress"
        ? "border-accent"
        : "border-line-strong";
  return (
    <div
      className={`rounded-md border-2 bg-surface px-4 py-2 text-sm text-fg ${tone}`}
    >
      <Handle type="target" position={Position.Left} />
      {data.label}
      {data.problem && <span className="ml-2 text-negative">!</span>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { status: StatusNode };

export function WorkflowsAdminPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const workflows = useQuery({
    queryKey: ["workflows"],
    queryFn: () => call<{ id: string; name: string }[]>("GET", "/workflows"),
  }).data;
  const [selected, setSelected] = useState<string>();
  const id = selected ?? workflows?.[0]?.id;
  const fail = (e: Error) => toast({ title: e.message, tone: "negative" });

  return (
    <AdminFrame title={t("app.admin.pages.workflows")}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-64">
            <Select
              aria-label={t("app.wf.workflow")}
              value={id}
              onValueChange={setSelected}
              options={(workflows ?? []).map((w) => ({
                value: w.id,
                label: w.name,
              }))}
            />
          </div>
          <Button
            size="sm"
            onClick={() =>
              void call<{ id: string }>("POST", "/workflows", {
                name: t("app.wf.copyName"),
                copyFrom: id,
              })
                .then((made) => {
                  void queryClient.invalidateQueries({
                    queryKey: ["workflows"],
                  });
                  setSelected(made.id);
                })
                .catch(fail)
            }
          >
            <Plus {...icon} />
            {t("app.wf.copy")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void call("DELETE", `/workflows/${id}`)
                .then(() => {
                  setSelected(undefined);
                  void queryClient.invalidateQueries({
                    queryKey: ["workflows"],
                  });
                })
                .catch(fail)
            }
          >
            {t("app.admin.delete")}
          </Button>
        </div>
        {id && <Editor key={id} workflowId={id} />}
      </div>
    </AdminFrame>
  );
}

function Editor({ workflowId }: { workflowId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const meta = useMeta().data;
  const loaded = useQuery({
    queryKey: ["workflow-draft", workflowId],
    queryFn: () => call<Draft>("GET", `/workflows/${workflowId}/draft`),
  }).data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [picked, setPicked] = useState<
    { kind: "edge"; index: number } | { kind: "node"; id: string } | null
  >(null);
  const [publishing, setPublishing] = useState(false);
  useEffect(() => {
    if (loaded) setDraft(loaded);
  }, [loaded]);
  const change = (d: Draft) => {
    setDraft(d);
    setDirty(true);
  };
  const statusName = (id: string | null) =>
    id === null
      ? t("app.wf.anywhere")
      : (meta?.statuses.find((s) => s.id === id)?.name ?? id);
  const category = (id: string) =>
    meta?.statuses.find((s) => s.id === id)?.category ?? "todo";

  const nodes = useMemo<Node[]>(
    () =>
      (draft?.statuses ?? []).map((s) => ({
        id: s.statusId,
        type: "status",
        position: { x: s.x, y: s.y },
        data: {
          label: statusName(s.statusId),
          category: category(s.statusId),
          problem: draft?.problems.find((p) => p.statusId === s.statusId)
            ?.problem,
        },
      })),
    [draft, meta],
  );
  const edges = useMemo<Edge[]>(
    () =>
      (draft?.transitions ?? []).flatMap((tr, index) =>
        tr.fromStatusId
          ? [
              {
                id: String(index),
                source: tr.fromStatusId,
                target: tr.toStatusId,
                label: tr.name,
                markerEnd: { type: MarkerType.ArrowClosed },
                selected: picked?.kind === "edge" && picked.index === index,
              },
            ]
          : [],
      ),
    [draft, picked],
  );

  if (!draft || !meta) return null;
  const free = meta.statuses.filter(
    (s) => !draft.statuses.some((d) => d.statusId === s.id),
  );

  const save = () =>
    call<Draft>("PUT", `/workflows/${workflowId}/draft`, {
      name: draft.name,
      statuses: draft.statuses,
      transitions: draft.transitions,
    })
      .then((d) => {
        setDraft(d);
        setDirty(false);
        void queryClient.setQueryData(["workflow-draft", workflowId], d);
        return d;
      })
      .catch((e: Error) => {
        toast({ title: e.message, tone: "negative" });
        throw e;
      });

  const onConnect = (c: Connection) =>
    change({
      ...draft,
      transitions: [
        ...draft.transitions,
        {
          name: statusName(c.target),
          fromStatusId: c.source,
          toStatusId: c.target,
          fieldLayoutId: null,
          rules: { conditions: [], validators: [], postFunctions: [] },
        },
      ],
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-64">
          <FormField label={t("app.admin.columns.name")}>
            {(p) => (
              <Input
                {...p}
                value={draft.name}
                onChange={(e) => change({ ...draft, name: e.target.value })}
              />
            )}
          </FormField>
        </div>
        {free.length > 0 && (
          <div className="w-56">
            <Select
              aria-label={t("app.wf.addStatus")}
              placeholder={t("app.wf.addStatus")}
              value={undefined}
              onValueChange={(statusId) =>
                change({
                  ...draft,
                  statuses: [
                    ...draft.statuses,
                    {
                      statusId,
                      x: Math.max(0, ...draft.statuses.map((s) => s.x)) + 220,
                      y: 0,
                    },
                  ],
                })
              }
              options={free.map((s) => ({ value: s.id, label: s.name }))}
            />
          </div>
        )}
        <Button variant="primary" disabled={!dirty} onClick={() => void save()}>
          {t("app.wf.saveDraft")}
        </Button>
        <Button
          disabled={!draft.saved && !dirty}
          onClick={() =>
            void (dirty ? save() : Promise.resolve(draft)).then(() =>
              setPublishing(true),
            )
          }
        >
          {t("app.wf.publish")}
        </Button>
        {draft.saved && (
          <Button
            variant="ghost"
            onClick={() =>
              void call("DELETE", `/workflows/${workflowId}/draft`).then(() => {
                setDirty(false);
                void queryClient.invalidateQueries({
                  queryKey: ["workflow-draft", workflowId],
                });
              })
            }
          >
            {t("app.wf.discard")}
          </Button>
        )}
        <span className="text-sm text-fg-3">
          {dirty
            ? t("app.wf.unsaved")
            : draft.saved
              ? t("app.wf.draftSaved")
              : t("app.wf.live")}
        </span>
      </div>

      {draft.problems.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-negative" role="status">
          {draft.problems.map((p) => (
            <li key={p.statusId + p.problem}>
              {statusName(p.statusId)}: {t(`app.wf.problems.${p.problem}`)}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="h-128 overflow-hidden">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode="system"
            fitView
            onConnect={onConnect}
            onNodeDragStop={(_e, node) =>
              change({
                ...draft,
                statuses: draft.statuses.map((s) =>
                  s.statusId === node.id
                    ? {
                        ...s,
                        x: Math.round(node.position.x),
                        y: Math.round(node.position.y),
                      }
                    : s,
                ),
              })
            }
            onEdgeClick={(_e, edge) =>
              setPicked({ kind: "edge", index: Number(edge.id) })
            }
            onNodeClick={(_e, node) => setPicked({ kind: "node", id: node.id })}
            onPaneClick={() => setPicked(null)}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </Card>

        <div className="flex flex-col gap-4">
          {picked?.kind === "edge" && draft.transitions[picked.index] && (
            <TransitionPanel
              transition={draft.transitions[picked.index]!}
              statuses={draft.statuses.map((s) => ({
                value: s.statusId,
                label: statusName(s.statusId),
              }))}
              onChange={(tr) =>
                change({
                  ...draft,
                  transitions: draft.transitions.map((x, i) =>
                    i === picked.index ? tr : x,
                  ),
                })
              }
              onRemove={() => {
                change({
                  ...draft,
                  transitions: draft.transitions.filter(
                    (_, i) => i !== picked.index,
                  ),
                });
                setPicked(null);
              }}
            />
          )}
          {picked?.kind === "node" && (
            <Card className="flex flex-col gap-3 p-4">
              <h3 className="text-base font-medium text-fg">
                {statusName(picked.id)}
              </h3>
              <Button
                variant="ghost"
                onClick={() => {
                  change({
                    ...draft,
                    statuses: draft.statuses.filter(
                      (s) => s.statusId !== picked.id,
                    ),
                    transitions: draft.transitions.filter(
                      (x) =>
                        x.fromStatusId !== picked.id &&
                        x.toStatusId !== picked.id,
                    ),
                  });
                  setPicked(null);
                }}
              >
                {t("app.wf.removeStatus")}
              </Button>
            </Card>
          )}
          <Card className="flex flex-col gap-2 p-4">
            <h3 className="text-sm font-medium text-fg-2">
              {t("app.wf.global")}
            </h3>
            <p className="text-sm text-fg-3">{t("app.wf.globalHint")}</p>
            <ul className="flex flex-col gap-1">
              {draft.transitions.map((tr, i) =>
                tr.fromStatusId === null ? (
                  <li key={i}>
                    <button
                      type="button"
                      className="text-sm text-fg underline-offset-4 hover:underline"
                      onClick={() => setPicked({ kind: "edge", index: i })}
                    >
                      {tr.name} → {statusName(tr.toStatusId)}
                    </button>
                  </li>
                ) : null,
              )}
            </ul>
            <p className="text-sm text-fg-3">{t("app.wf.connectHint")}</p>
          </Card>
        </div>
      </div>

      {publishing && (
        <PublishDialog
          workflowId={workflowId}
          displaced={draft.displaced}
          statuses={draft.statuses.map((s) => ({
            value: s.statusId,
            label: statusName(s.statusId),
          }))}
          name={statusName}
          onClose={() => setPublishing(false)}
          onDone={(moved) => {
            setPublishing(false);
            setDirty(false);
            toast({ title: t("app.wf.published", { count: moved }) });
            void queryClient.invalidateQueries({
              queryKey: ["workflow-draft", workflowId],
            });
            void queryClient.invalidateQueries({ queryKey: ["workflows"] });
          }}
        />
      )}
    </div>
  );
}

function TransitionPanel({
  transition: tr,
  statuses,
  onChange,
  onRemove,
}: {
  transition: Transition;
  statuses: { value: string; label: string }[];
  onChange: (t: Transition) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const catalogue = useQuery({
    queryKey: ["workflow-rules"],
    queryFn: () =>
      call<Record<RuleList, Record<string, string[]>>>(
        "GET",
        "/workflow-rules",
      ),
    staleTime: Infinity,
  }).data;
  const layouts = useQuery({
    queryKey: ["field-layouts"],
    queryFn: () => unwrap(api.GET("/tickvana/api/field-layouts")),
  }).data;
  const setRules = (list: RuleList, rules: Rule[]) =>
    onChange({ ...tr, rules: { ...tr.rules, [list]: rules } });

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-base font-medium text-fg">
          {t("app.wf.transition")}
        </h3>
        <IconButton label={t("app.wf.removeTransition")} onClick={onRemove}>
          <X {...icon} />
        </IconButton>
      </div>
      <FormField label={t("app.admin.columns.name")}>
        {(p) => (
          <Input
            {...p}
            value={tr.name}
            onChange={(e) => onChange({ ...tr, name: e.target.value })}
          />
        )}
      </FormField>
      <div className="grid grid-cols-2 gap-2">
        <Select
          aria-label={t("app.wf.from")}
          value={tr.fromStatusId ?? "-"}
          onValueChange={(v) =>
            onChange({ ...tr, fromStatusId: v === "-" ? null : v })
          }
          options={[{ value: "-", label: t("app.wf.anywhere") }, ...statuses]}
        />
        <Select
          aria-label={t("app.wf.to")}
          value={tr.toStatusId}
          onValueChange={(v) => onChange({ ...tr, toStatusId: v })}
          options={statuses}
        />
      </div>
      <Select
        aria-label={t("app.wf.screen")}
        value={tr.fieldLayoutId ?? "-"}
        onValueChange={(v) =>
          onChange({ ...tr, fieldLayoutId: v === "-" ? null : v })
        }
        options={[
          { value: "-", label: t("app.wf.noScreen") },
          ...(layouts ?? []).map((l) => ({
            value: l.id,
            label: `${t("app.wf.screen")}: ${l.name}`,
          })),
        ]}
      />
      {catalogue &&
        (["conditions", "validators", "postFunctions"] as const).map((list) => (
          <RuleEditor
            key={list}
            list={list}
            rules={tr.rules[list] ?? []}
            catalogue={catalogue[list]}
            onChange={(rules) => setRules(list, rules)}
          />
        ))}
    </Card>
  );
}

function RuleEditor({
  list,
  rules,
  catalogue,
  onChange,
}: {
  list: RuleList;
  rules: Rule[];
  catalogue: Record<string, string[]>;
  onChange: (rules: Rule[]) => void;
}) {
  const { t } = useTranslation();
  const meta = useMeta().data;
  const label = useFieldLabel();
  const fields = useFields().data ?? [];
  // Parameters with a fixed set of values get a select, the rest a text box.
  const choices: Record<string, { value: string; label: string }[]> = {
    field: fields.map((f) => ({ value: f.key, label: label(f) })),
    resolutionId: (meta?.resolutions ?? []).map((r) => ({
      value: r.id,
      label: r.name,
    })),
  };
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-sm font-medium text-fg-2">
        {t(`app.wf.lists.${list}`)}
      </h4>
      {rules.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-fg">
            {t(`app.wf.rules.${r.fn}`, r.fn)}
          </span>
          {(catalogue[r.fn] ?? []).map((param) =>
            choices[param] ? (
              <div key={param} className="w-40">
                <Select
                  aria-label={t(`app.wf.params.${param}`)}
                  placeholder={t(`app.wf.params.${param}`)}
                  value={r[param] || undefined}
                  onValueChange={(v) =>
                    onChange(
                      rules.map((x, j) => (j === i ? { ...x, [param]: v } : x)),
                    )
                  }
                  options={choices[param]!}
                />
              </div>
            ) : (
              <div key={param} className="w-40">
                <Input
                  aria-label={t(`app.wf.params.${param}`)}
                  placeholder={t(`app.wf.params.${param}`)}
                  value={r[param] ?? ""}
                  onChange={(e) =>
                    onChange(
                      rules.map((x, j) =>
                        j === i ? { ...x, [param]: e.target.value } : x,
                      ),
                    )
                  }
                />
              </div>
            ),
          )}
          <IconButton
            label={t("app.admin.fields.remove")}
            onClick={() => onChange(rules.filter((_, j) => j !== i))}
          >
            <X {...icon} />
          </IconButton>
        </div>
      ))}
      <div className="w-56">
        <Select
          aria-label={t("app.wf.addRule")}
          placeholder={t("app.wf.addRule")}
          value={undefined}
          onValueChange={(fn) => onChange([...rules, { fn } as Rule])}
          options={Object.keys(catalogue).map((fn) => ({
            value: fn,
            label: t(`app.wf.rules.${fn}`, fn),
          }))}
        />
      </div>
    </section>
  );
}

function PublishDialog({
  workflowId,
  displaced,
  statuses,
  name,
  onClose,
  onDone,
}: {
  workflowId: string;
  displaced: Draft["displaced"];
  statuses: { value: string; label: string }[];
  name: (id: string) => string;
  onClose: () => void;
  onDone: (moved: number) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const ready = displaced.every((d) => mapping[d.statusId]);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("app.wf.publish")}
      description={
        displaced.length ? t("app.wf.mapHint") : t("app.wf.publishHint")
      }
      closeLabel={t("shell.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("app.cancel")}</Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() =>
              void call<{ moved: number }>(
                "POST",
                `/workflows/${workflowId}/publish`,
                { mapping },
              )
                .then((r) => onDone(r.moved))
                .catch((e: Error) =>
                  toast({ title: e.message, tone: "negative" }),
                )
            }
          >
            {t("app.wf.publish")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 pb-2">
        {displaced.map((d) => (
          <FormField
            key={d.statusId}
            label={t("app.wf.mapLabel", {
              status: name(d.statusId),
              count: d.tickets,
            })}
          >
            {(p) => (
              <Select
                {...p}
                placeholder={t("app.perm.choose")}
                value={mapping[d.statusId]}
                onValueChange={(v) =>
                  setMapping({ ...mapping, [d.statusId]: v })
                }
                options={statuses}
              />
            )}
          </FormField>
        ))}
      </div>
    </Dialog>
  );
}
