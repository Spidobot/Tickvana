// Forms for projects and tickets. Which fields a ticket form shows comes from
// the field layout of the issue type, so custom fields appear without code.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  Button,
  Dialog,
  Field as FormField,
  Input,
  RichTextEditor,
  Select,
  Textarea,
  useApp,
  type EditorLabels,
  type RichTextEditorProps,
} from "@tvn/ui";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  keys,
  unwrap,
  useFields,
  useLayout,
  useMeta,
  useUsers,
  type Field,
  type Issue,
  type Project,
} from "./api.js";

type Values = Record<string, unknown>;
const NONE = "__none";

/** System fields whose name is translated. Custom fields show the name an admin gave them. */
const SYSTEM_LABELS = new Set([
  "summary",
  "description",
  "priority",
  "assignee",
  "reporter",
  "labels",
  "dueDate",
  "estimate",
  "components",
  "fixVersions",
  "affectsVersions",
  "parent",
  "remaining",
]);

/** Field keys (system) and types (custom) that FieldInput can render. */
const HAS_INPUT = new Set([
  "summary",
  "text",
  "url",
  "textarea",
  "description",
  "richtext",
  "priority",
  "assignee",
  "user",
  "reporter",
  "labels",
  "dueDate",
  "date",
  "datetime",
  "number",
  "estimate",
  "checkbox",
  "select",
  "multiselect",
  "components",
  "fixVersions",
  "affectsVersions",
  "parent",
  "issue",
  "cascade",
  "multiuser",
  "group",
]);

/** Checkboxes for a set of ids. */
function Checks({
  a11y,
  options,
  value,
  onChange,
}: {
  a11y: { id: string };
  options: { value: string; label: string }[];
  value: unknown;
  onChange: (v: string[]) => void;
}) {
  const chosen = new Set((value as string[] | null) ?? []);
  return (
    <div
      role="group"
      aria-labelledby={a11y.id}
      className="flex flex-wrap gap-x-4 gap-y-2"
    >
      {options.map((o) => (
        <label
          key={o.value}
          className="flex items-center gap-2 text-base text-fg"
        >
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={chosen.has(o.value)}
            onChange={(e) => {
              const next = new Set(chosen);
              if (e.target.checked) next.add(o.value);
              else next.delete(o.value);
              onChange([...next]);
            }}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** A ticket by key. Stores the ticket's id, shows its key. */
function IssuePicker({
  a11y,
  value,
  onChange,
}: {
  a11y: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean };
  value: unknown;
  onChange: (v: string | null) => void;
}) {
  const { t } = useTranslation();
  const id = (value as string | null) ?? null;
  const current = useQuery({
    queryKey: ["issue-ref", id],
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/issues/{key}", {
          params: { path: { key: id! } },
        }),
      ),
    enabled: !!id,
    staleTime: 60_000,
  }).data;
  const [text, setText] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const shown = text ?? current?.key ?? "";
  const resolve = () => {
    if (text === null) return;
    if (text.trim() === "") {
      setText(null);
      return onChange(null);
    }
    void unwrap(
      api.GET("/tickvana/api/issues/{key}", {
        params: { path: { key: text.trim() } },
      }),
    ).then(
      (found) => {
        setMissing(false);
        setText(null);
        onChange(found.id);
      },
      () => setMissing(true),
    );
  };
  return (
    <div className="flex flex-col gap-1">
      <Input
        {...a11y}
        placeholder="ABC-12"
        value={shown}
        aria-invalid={missing || a11y["aria-invalid"]}
        onChange={(e) => setText(e.target.value)}
        onBlur={resolve}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            resolve();
          }
        }}
      />
      {current && text === null && (
        <span className="text-sm text-fg-3">
          {current.fields.summary as string}
        </span>
      )}
      {missing && (
        <span className="text-sm text-negative">{t("app.ticketNotFound")}</span>
      )}
    </div>
  );
}

export function useFieldLabel() {
  const { t } = useTranslation();
  return (field: Pick<Field, "key" | "name" | "system">) =>
    field.system && SYSTEM_LABELS.has(field.key)
      ? t(`app.${field.key}`)
      : field.name;
}

export function FieldInput({
  field,
  value,
  onChange,
  a11y,
  upload,
  projectKey,
}: {
  field: Field;
  value: unknown;
  onChange: (v: unknown) => void;
  a11y: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean };
  upload?: RichTextEditorProps["onUpload"];
  /** Needed for components and versions. */
  projectKey?: string;
}): ReactNode {
  const { t } = useTranslation();
  const meta = useMeta().data;
  const users = useUsers().data ?? [];
  const label = useFieldLabel()(field);
  const editorLabels = t("editor", { returnObjects: true }) as EditorLabels;

  const text = (type = "text") => (
    <Input
      {...a11y}
      type={type}
      value={(value as string | null) ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
    />
  );
  const pick = (
    options: { value: string; label: string }[],
    clearable: string | null,
  ) => (
    <Select
      {...a11y}
      value={(value as string | null) ?? (clearable ? NONE : undefined)}
      onValueChange={(v) => onChange(v === NONE ? null : v)}
      options={
        clearable ? [{ value: NONE, label: clearable }, ...options] : options
      }
    />
  );
  const people = users.map((u) => ({ value: u.id, label: u.displayName }));
  const sysKey = field.system ? field.key : field.type;
  const part = sysKey === "components" ? "components" : "versions";
  // ponytail: the path is built from the part, which openapi-fetch cannot type.
  const projectParts = useQuery({
    queryKey: ["project-part", projectKey, part],
    queryFn: () =>
      unwrap(
        (api.GET as unknown as (p: string, i: object) => Promise<never>)(
          `/tickvana/api/projects/{key}/${part}`,
          { params: { path: { key: projectKey } } },
        ),
      ) as Promise<{ id: string; name: string }[]>,
    enabled:
      !!projectKey &&
      ["components", "fixVersions", "affectsVersions"].includes(sysKey),
  }).data;
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: () =>
      unwrap(api.GET("/tickvana/api/core/groups")) as Promise<
        { id: string; name: string }[]
      >,
    enabled: sysKey === "group",
  }).data;
  const words = () => (
    <Input
      {...a11y}
      value={((value as string[] | null) ?? []).join(" ")}
      onChange={(e) => onChange(e.target.value.split(/\s+/).filter(Boolean))}
    />
  );
  const editor = () => (
    <RichTextEditor
      label={label}
      labels={editorLabels}
      value={(value as RichTextEditorProps["value"]) ?? null}
      onChange={onChange}
      onUpload={upload}
      compact
    />
  );

  switch (field.system ? field.key : field.type) {
    case "summary":
    case "text":
    case "url":
      return text();
    case "textarea":
      return (
        <Textarea
          {...a11y}
          rows={3}
          value={(value as string | null) ?? ""}
          onChange={(e) =>
            onChange(e.target.value === "" ? null : e.target.value)
          }
        />
      );
    case "description":
    case "richtext":
      return editor();
    case "priority":
      return pick(
        (meta?.priorities ?? []).map((p) => ({ value: p.id, label: p.name })),
        null,
      );
    case "assignee":
    case "user":
      return pick(people, t("app.nobody"));
    case "reporter":
      return pick(people, null);
    case "labels":
      return words();
    case "dueDate":
    case "date":
      return text("date");
    case "datetime":
      return (
        <Input
          {...a11y}
          type="datetime-local"
          value={
            value ? new Date(value as string).toISOString().slice(0, 16) : ""
          }
          onChange={(e) =>
            onChange(
              e.target.value
                ? new Date(`${e.target.value}Z`).toISOString()
                : null,
            )
          }
        />
      );
    case "number":
      return (
        <Input
          {...a11y}
          type="number"
          step="any"
          value={(value as number | null) ?? ""}
          onChange={(e) =>
            onChange(e.target.value === "" ? null : Number(e.target.value))
          }
        />
      );
    case "estimate":
      return (
        <Input
          {...a11y}
          type="number"
          min={0}
          step={0.25}
          value={value == null ? "" : (value as number) / 3600}
          onChange={(e) =>
            onChange(
              e.target.value === ""
                ? null
                : Math.round(Number(e.target.value) * 3600),
            )
          }
        />
      );
    case "checkbox":
      return (
        <input
          {...a11y}
          type="checkbox"
          className="size-4 self-start accent-accent"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case "select":
      return pick(
        field.options
          .filter((o) => !o.disabled)
          .map((o) => ({ value: o.id, label: o.value })),
        t("app.none"),
      );
    case "multiselect": {
      const chosen = new Set((value as string[] | null) ?? []);
      return (
        <div
          role="group"
          aria-labelledby={a11y.id}
          className="flex flex-wrap gap-x-4 gap-y-2"
        >
          {field.options
            .filter((o) => !o.disabled)
            .map((o) => (
              <label
                key={o.id}
                className="flex items-center gap-2 text-base text-fg"
              >
                <input
                  type="checkbox"
                  className="size-4 accent-accent"
                  checked={chosen.has(o.id)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(o.id);
                    else next.delete(o.id);
                    onChange([...next]);
                  }}
                />
                {o.value}
              </label>
            ))}
        </div>
      );
    }
    case "components":
    case "fixVersions":
    case "affectsVersions":
      return (
        <Checks
          a11y={a11y}
          value={value}
          onChange={onChange}
          options={(projectParts ?? []).map((x) => ({
            value: x.id,
            label: x.name,
          }))}
        />
      );
    case "multiuser":
      return (
        <Checks
          a11y={a11y}
          value={value}
          onChange={onChange}
          options={people}
        />
      );
    case "group":
      return pick(
        (groups ?? []).map((g) => ({ value: g.id, label: g.name })),
        t("app.none"),
      );
    case "parent":
    case "issue":
      return <IssuePicker a11y={a11y} value={value} onChange={onChange} />;
    case "cascade": {
      const [parent, child] = (value as string[] | null) ?? [];
      const top = field.options.filter(
        (o) => !o.disabled && o.parentId === null,
      );
      const below = field.options.filter(
        (o) => !o.disabled && o.parentId === parent,
      );
      return (
        <div className="grid grid-cols-2 gap-2">
          <Select
            {...a11y}
            value={parent ?? NONE}
            onValueChange={(v) => onChange(v === NONE ? [] : [v])}
            options={[
              { value: NONE, label: t("app.none") },
              ...top.map((o) => ({ value: o.id, label: o.value })),
            ]}
          />
          {parent && below.length > 0 && (
            <Select
              aria-label={label}
              value={child ?? NONE}
              onValueChange={(v) =>
                onChange(v === NONE ? [parent] : [parent, v])
              }
              options={[
                { value: NONE, label: t("app.none") },
                ...below.map((o) => ({ value: o.id, label: o.value })),
              ]}
            />
          )}
        </div>
      );
    }
    default:
      return null;
  }
}

/** The fields of a layout for one operation, as inputs. */
export function LayoutFields({
  layoutId,
  operation,
  values,
  onChange,
  problems,
  upload,
  projectKey,
}: {
  layoutId: string | undefined;
  operation: "create" | "edit" | "transition";
  projectKey?: string;
  values: Values;
  onChange: (key: string, v: unknown) => void;
  problems: Record<string, string>;
  upload?: RichTextEditorProps["onUpload"];
}) {
  const fields = useFields().data;
  const layout = useLayout(layoutId).data;
  const label = useFieldLabel();
  if (!fields || !layout) return null;
  return (
    <>
      {layout.items[operation]
        ?.filter((item) => !item.hidden)
        .map((item) => {
          const field = fields.find((f) => f.id === item.fieldId);
          if (!field) return null;
          const input = (a11y: Parameters<typeof FieldInput>[0]["a11y"]) => (
            <FieldInput
              field={field}
              value={values[field.key]}
              onChange={(v) => onChange(field.key, v)}
              a11y={a11y}
              upload={upload}
              projectKey={projectKey}
            />
          );
          // Fields without an input yet are left out rather than shown as empty labels.
          if (!HAS_INPUT.has(field.system ? field.key : field.type))
            return null;
          return (
            <FormField
              key={field.id}
              label={`${label(field)}${item.required ? " *" : ""}`}
              error={problems[field.key]}
            >
              {input}
            </FormField>
          );
        })}
    </>
  );
}

export function useSubmit<T>(
  action: () => Promise<T>,
  onDone: (result: T) => void,
) {
  const { t } = useTranslation();
  const required = t("app.required");
  const [problems, setProblems] = useState<Record<string, string>>({});
  const mutation = useMutation({
    mutationFn: action,
    onSuccess: (result) => {
      setProblems({});
      onDone(result);
    },
    onError: (error) => {
      const details =
        error instanceof ApiError && Array.isArray(error.details)
          ? (error.details as { field?: string; message?: string }[])
          : [];
      setProblems(
        Object.fromEntries(
          details
            .filter((d) => d.field && d.message)
            // "… is required" comes from the server in English: say it in the reader's language.
            .map((d) => [
              d.field!,
              / is required$/.test(d.message!) ? required : d.message!,
            ]),
        ),
      );
    },
  });
  const message =
    mutation.error && Object.keys(problems).length === 0
      ? (mutation.error as Error).message
      : undefined;
  return {
    ...mutation,
    problems,
    message,
    submit: (e: FormEvent) => (e.preventDefault(), mutation.mutate()),
  };
}

const FormError = ({ children }: { children?: string }) =>
  children ? (
    <p role="alert" className="text-sm text-negative">
      {children}
    </p>
  ) : null;

export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (key: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: "",
    key: "",
    kind: "software" as "software" | "business" | "service",
  });
  const [keyTouched, setKeyTouched] = useState(false);
  // Suggest a key from the name until the user types their own.
  const suggested = form.name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 4);
  const key = keyTouched ? form.key : suggested;

  const save = useSubmit(
    () =>
      unwrap(
        api.POST("/tickvana/api/projects", {
          body: { name: form.name, key, kind: form.kind },
        }),
      ),
    (project) => {
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      onOpenChange(false);
      onCreated(project.key);
    },
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("app.newProject")}
      closeLabel={t("shell.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("app.cancel")}</Button>
          <Button
            variant="primary"
            type="submit"
            form="project-form"
            disabled={save.isPending}
          >
            {t("app.create")}
          </Button>
        </>
      }
    >
      <form
        id="project-form"
        className="flex flex-col gap-4 pb-2"
        onSubmit={save.submit}
      >
        <FormField label={t("app.projectName")}>
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
        <FormField label={t("app.projectKey")} hint={t("app.projectKeyHint")}>
          {(p) => (
            <Input
              {...p}
              required
              className="font-mono uppercase"
              maxLength={10}
              value={key}
              onChange={(e) => {
                setKeyTouched(true);
                setForm({ ...form, key: e.target.value.toUpperCase() });
              }}
            />
          )}
        </FormField>
        <FormField label={t("app.projectKind")}>
          {(p) => (
            <Select
              {...p}
              value={form.kind}
              onValueChange={(kind) =>
                setForm({ ...form, kind: kind as typeof form.kind })
              }
              options={(["software", "business", "service"] as const).map(
                (k) => ({ value: k, label: t(`app.kind.${k}`) }),
              )}
            />
          )}
        </FormField>
        <FormError>{save.message}</FormError>
      </form>
    </Dialog>
  );
}

/** Create a ticket in a project, or edit an existing one. */
export function IssueDialog({
  open,
  onOpenChange,
  project,
  issue,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  issue?: Issue;
  onSaved: (issue: Issue) => void;
}) {
  const { t } = useTranslation();
  const { api: core } = useApp();
  const queryClient = useQueryClient();
  // Start with the plainest type: "Task" where it exists, else the first ordinary one.
  const standard =
    project.issueTypes.find((i) => i.name === "Task") ??
    project.issueTypes.find((i) => i.level === 0) ??
    project.issueTypes[0];
  const [typeId, setTypeId] = useState(
    issue ? (issue.fields.type as string) : standard?.id,
  );
  const [values, setValues] = useState<Values>({});
  // Start every opening from the ticket's current values (or empty for a new one).
  useEffect(() => {
    if (open) {
      setValues(issue ? { ...issue.fields } : {});
      setTypeId(issue ? (issue.fields.type as string) : standard?.id);
    }
  }, [open]);

  const type = project.issueTypes.find((i) => i.id === typeId);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const change = (key: string, v: unknown) => {
    setValues((all) => ({ ...all, [key]: v }));
    setChanged((keys) => new Set(keys).add(key));
  };

  const save = useSubmit(
    () =>
      issue
        ? // Send only what was touched, so parallel edits of other fields survive.
          unwrap(
            api.PATCH("/tickvana/api/issues/{key}", {
              params: { path: { key: issue.key } },
              body: {
                fields: Object.fromEntries(
                  [...changed].map((k) => [k, values[k]]),
                ),
              },
            }),
          )
        : unwrap(
            api.POST("/tickvana/api/issues", {
              body: { projectKey: project.key, type: typeId!, fields: values },
            }),
          ),
    (saved) => {
      void queryClient.invalidateQueries({
        queryKey: keys.issues(project.key),
      });
      void queryClient.invalidateQueries({ queryKey: keys.issue(saved.key) });
      setChanged(new Set());
      onOpenChange(false);
      onSaved(saved);
    },
  );

  const upload: RichTextEditorProps["onUpload"] | undefined = issue
    ? async (file) => {
        const form = new FormData();
        form.append("file", file);
        const stored = await core.call<{
          id: string;
          filename: string;
          size: number;
          mime: string;
        }>(
          "POST",
          `/core/attachments?ownerType=issue&ownerId=${issue.id}`,
          form,
        );
        return {
          href: `${core.base}/core/attachments/${stored.id}`,
          name: stored.filename,
          size: stored.size,
          isImage: stored.mime.startsWith("image/"),
        };
      }
    : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={issue ? `${t("app.editTicket")} ${issue.key}` : t("app.newTicket")}
      description={project.name}
      closeLabel={t("shell.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("app.cancel")}</Button>
          <Button
            variant="primary"
            type="submit"
            form="issue-form"
            disabled={save.isPending}
          >
            {issue ? t("app.save") : t("app.create")}
          </Button>
        </>
      }
    >
      <form
        id="issue-form"
        className="flex flex-col gap-4 pb-2"
        onSubmit={save.submit}
      >
        {!issue && (
          <FormField label={t("app.type")}>
            {(p) => (
              <Select
                {...p}
                value={typeId}
                onValueChange={setTypeId}
                options={project.issueTypes.map((i) => ({
                  value: i.id,
                  label: i.name,
                }))}
              />
            )}
          </FormField>
        )}
        <LayoutFields
          layoutId={type?.fieldLayoutId}
          operation={issue ? "edit" : "create"}
          values={values}
          onChange={change}
          problems={save.problems}
          upload={upload}
          projectKey={project.key}
        />
        <FormError>{save.message}</FormError>
      </form>
    </Dialog>
  );
}
