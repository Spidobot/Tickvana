// Admin: custom fields with their options, and field layouts per operation.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  Dialog,
  Field as FormField,
  IconButton,
  Input,
  Menu,
  Select,
  Table,
  Tabs,
  Td,
  Th,
  useToast,
} from "@tvn/ui";
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  MoreHorizontal,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AdminFrame } from "./admin.js";
import {
  api,
  keys,
  unwrap,
  useFields,
  useLayout,
  type Field,
  type Layout,
} from "./api.js";
import { useFieldLabel, useSubmit } from "./forms.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

const TYPES = [
  "text",
  "textarea",
  "url",
  "richtext",
  "number",
  "checkbox",
  "date",
  "datetime",
  "select",
  "multiselect",
  "cascade",
  "user",
  "multiuser",
  "group",
  "issue",
  "labels",
] as const;
const WITH_OPTIONS = new Set(["select", "multiselect", "cascade"]);
const OPERATIONS = ["create", "edit", "view", "transition", "portal"] as const;
type Operation = (typeof OPERATIONS)[number];
type Item = Layout["items"]["create"][number];

export function FieldsAdminPage() {
  const { t } = useTranslation();
  return (
    <AdminFrame title={t("app.admin.pages.fields")}>
      <Tabs
        label={t("app.admin.pages.fields")}
        tabs={[
          {
            value: "fields",
            label: t("app.admin.fields.fields"),
            content: <FieldList />,
          },
          {
            value: "layouts",
            label: t("app.admin.fields.layouts"),
            content: <LayoutEditor />,
          },
        ]}
      />
    </AdminFrame>
  );
}

// --- Fields ---------------------------------------------------------------------------

function FieldList() {
  const { t } = useTranslation();
  const toast = useToast();
  const label = useFieldLabel();
  const queryClient = useQueryClient();
  const fields = useFields().data ?? [];
  const [editing, setEditing] = useState<Field | "new" | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: keys.fields });
  const remove = (f: Field) =>
    unwrap(
      api.DELETE("/tickvana/api/fields/{id}", {
        params: { path: { id: f.id } },
      }),
    )
      .then(refresh)
      .catch((e: Error) => toast({ title: e.message, tone: "negative" }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus {...icon} />
          {t("app.admin.fields.add")}
        </Button>
      </div>
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>{t("app.admin.columns.name")}</Th>
              <Th>{t("app.admin.fields.key")}</Th>
              <Th>{t("app.admin.fields.type")}</Th>
              <Th className="w-12">
                <span className="sr-only">{t("app.admin.actions")}</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.id}>
                <Td className="text-fg">
                  {label(f)}
                  {f.system && (
                    <span className="ml-2 text-sm text-fg-3">
                      {t("app.admin.fields.system")}
                    </span>
                  )}
                </Td>
                <Td className="font-mono text-sm text-fg-2">{f.key}</Td>
                <Td className="text-fg-2">
                  {t(`app.admin.fieldTypes.${f.type}`, f.type)}
                </Td>
                <Td>
                  {!f.system && (
                    <Menu
                      trigger={
                        <IconButton label={t("app.admin.actions")}>
                          <MoreHorizontal {...icon} />
                        </IconButton>
                      }
                      items={[
                        { label: t("app.edit"), onSelect: () => setEditing(f) },
                        {
                          label: t("app.admin.delete"),
                          onSelect: () => void remove(f),
                        },
                      ]}
                    />
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {editing && (
        <FieldDialog
          field={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => void refresh()}
        />
      )}
    </div>
  );
}

function FieldDialog({
  field,
  onClose,
  onSaved,
}: {
  field: Field | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    name: field?.name ?? "",
    key: field?.key ?? "",
    type: field?.type ?? "text",
    min: field?.config.min?.toString() ?? "",
    max: field?.config.max?.toString() ?? "",
  });
  const config = () => ({
    ...field?.config,
    ...(form.type === "number" && {
      ...(form.min !== "" && { min: Number(form.min) }),
      ...(form.max !== "" && { max: Number(form.max) }),
    }),
  });
  const save = useSubmit(
    () =>
      field
        ? unwrap(
            api.PATCH("/tickvana/api/fields/{id}", {
              params: { path: { id: field.id } },
              body: { name: form.name, config: config() },
            }),
          )
        : unwrap(
            api.POST("/tickvana/api/fields", {
              body: {
                name: form.name,
                key: form.key,
                type: form.type,
                config: config(),
              },
            }),
          ),
    () => {
      onSaved();
      // New select fields stay open to add options right away.
      if (field || !WITH_OPTIONS.has(form.type)) onClose();
    },
  );
  const fields = useFields().data ?? [];
  const current = field && fields.find((f) => f.id === field.id);
  const created =
    !field && save.data ? fields.find((f) => f.id === save.data.id) : undefined;
  const withOptions = current ?? created;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={field ? field.name : t("app.admin.fields.add")}
      closeLabel={t("shell.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("app.cancel")}</Button>
          {!created && (
            <Button
              variant="primary"
              type="submit"
              form="field-form"
              disabled={save.isPending}
            >
              {t("app.save")}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-6 pb-2">
        {!created && (
          <form
            id="field-form"
            className="flex flex-col gap-4"
            onSubmit={save.submit}
          >
            <FormField
              label={t("app.admin.columns.name")}
              error={save.problems.name}
            >
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
            {!field && (
              <>
                <FormField
                  label={t("app.admin.fields.key")}
                  hint={t("app.admin.fields.keyHint")}
                  error={save.problems.key}
                >
                  {(p) => (
                    <Input
                      {...p}
                      required
                      pattern="[a-z][a-z0-9_]{1,39}"
                      maxLength={40}
                      value={form.key}
                      onChange={(e) =>
                        setForm({ ...form, key: e.target.value })
                      }
                    />
                  )}
                </FormField>
                <FormField label={t("app.admin.fields.type")}>
                  {(p) => (
                    <Select
                      {...p}
                      value={form.type}
                      onValueChange={(type) => setForm({ ...form, type })}
                      options={TYPES.map((x) => ({
                        value: x,
                        label: t(`app.admin.fieldTypes.${x}`),
                      }))}
                    />
                  )}
                </FormField>
              </>
            )}
            {form.type === "number" && (
              <div className="grid grid-cols-2 gap-4">
                {(["min", "max"] as const).map((k) => (
                  <FormField key={k} label={t(`app.admin.fields.${k}`)}>
                    {(p) => (
                      <Input
                        {...p}
                        type="number"
                        value={form[k]}
                        onChange={(e) =>
                          setForm({ ...form, [k]: e.target.value })
                        }
                      />
                    )}
                  </FormField>
                ))}
              </div>
            )}
            {save.message && (
              <p role="alert" className="text-sm text-negative">
                {save.message}
              </p>
            )}
          </form>
        )}
        {withOptions && WITH_OPTIONS.has(withOptions.type) && (
          <OptionEditor field={withOptions} />
        )}
      </div>
    </Dialog>
  );
}

function OptionEditor({ field }: { field: Field }) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [parentId, setParentId] = useState<string>("");
  const cascade = field.type === "cascade";
  const top = field.options.filter((o) => o.parentId === null);
  const run = (call: Promise<unknown>) =>
    call
      .then(() => queryClient.invalidateQueries({ queryKey: keys.fields }))
      .catch((e: Error) => toast({ title: e.message, tone: "negative" }));
  const patch = (optionId: string, body: object) =>
    run(
      unwrap(
        api.PATCH("/tickvana/api/fields/{id}/options/{optionId}", {
          params: { path: { id: field.id, optionId } },
          body,
        }),
      ),
    );
  const ordered = (parent: string | null) =>
    field.options
      .filter((o) => o.parentId === parent)
      .sort((a, b) => a.position - b.position);
  const swap = (parent: string | null, index: number, by: number) => {
    const list = ordered(parent);
    const a = list[index];
    const b = list[index + by];
    if (!a || !b) return;
    void patch(a.id, { position: b.position });
    void patch(b.id, { position: a.position });
  };

  const rows = (parent: string | null, depth: number) =>
    ordered(parent).map((o, i, list) => (
      <li key={o.id} className="flex flex-col gap-1">
        <div
          className={
            depth ? "flex items-center gap-2 pl-6" : "flex items-center gap-2"
          }
        >
          <span
            className={
              o.disabled ? "flex-1 text-fg-3 line-through" : "flex-1 text-fg"
            }
          >
            {o.value}
          </span>
          <IconButton
            label={t("app.admin.up")}
            disabled={i === 0}
            onClick={() => swap(parent, i, -1)}
          >
            <ArrowUp {...icon} />
          </IconButton>
          <IconButton
            label={t("app.admin.down")}
            disabled={i === list.length - 1}
            onClick={() => swap(parent, i, 1)}
          >
            <ArrowDown {...icon} />
          </IconButton>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void patch(o.id, { disabled: !o.disabled })}
          >
            {o.disabled
              ? t("app.admin.fields.enable")
              : t("app.admin.fields.disable")}
          </Button>
        </div>
        {cascade && depth === 0 && <ul>{rows(o.id, 1)}</ul>}
      </li>
    ));

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-base font-medium text-fg">
        {t("app.admin.fields.options")}
      </h3>
      <ul className="flex flex-col gap-1">{rows(null, 0)}</ul>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            unwrap(
              api.POST("/tickvana/api/fields/{id}/options", {
                params: { path: { id: field.id } },
                body: { value, parentId: parentId || null },
              }),
            ),
          ).then(() => setValue(""));
        }}
      >
        {cascade && (
          <div className="w-40">
            <Select
              aria-label={t("app.admin.fields.parent")}
              value={parentId || "-"}
              onValueChange={(v) => setParentId(v === "-" ? "" : v)}
              options={[
                { value: "-", label: t("app.admin.fields.topLevel") },
                ...top.map((o) => ({ value: o.id, label: o.value })),
              ]}
            />
          </div>
        )}
        <Input
          aria-label={t("app.admin.fields.newOption")}
          placeholder={t("app.admin.fields.newOption")}
          required
          maxLength={500}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button type="submit">{t("app.admin.add")}</Button>
      </form>
    </section>
  );
}

// --- Layouts --------------------------------------------------------------------------

function LayoutEditor() {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const layouts = useQuery({
    queryKey: ["field-layouts"],
    queryFn: () => unwrap(api.GET("/tickvana/api/field-layouts")),
  }).data;
  const [layoutId, setLayoutId] = useState<string>();
  const [operation, setOperation] = useState<Operation>("create");
  const [creating, setCreating] = useState(false);
  const selected = layoutId ?? layouts?.[0]?.id;
  const layout = useLayout(selected).data;
  const [items, setItems] = useState<Item[]>([]);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (layout) setItems(layout.items[operation] ?? []);
    setDirty(false);
  }, [layout, operation]);
  const change = (next: Item[]) => {
    setItems(next);
    setDirty(true);
  };

  const save = () =>
    unwrap(
      api.PUT("/tickvana/api/field-layouts/{id}/{operation}", {
        params: { path: { id: selected!, operation } },
        body: items,
      }),
    )
      .then(() => {
        void queryClient.invalidateQueries({
          queryKey: keys.layout(selected!),
        });
        toast({ title: t("app.admin.saved") });
      })
      .catch((e: Error) => toast({ title: e.message, tone: "negative" }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-64">
          <Select
            aria-label={t("app.admin.fields.layout")}
            value={selected}
            onValueChange={setLayoutId}
            options={(layouts ?? []).map((l) => ({
              value: l.id,
              label: l.name,
            }))}
          />
        </div>
        <div className="w-48">
          <Select
            aria-label={t("app.admin.fields.operation")}
            value={operation}
            onValueChange={(v) => setOperation(v as Operation)}
            options={OPERATIONS.map((o) => ({
              value: o,
              label: t(`app.admin.operations.${o}`),
            }))}
          />
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus {...icon} />
          {t("app.admin.fields.newLayout")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty}
          onClick={() => void save()}
        >
          {t("app.save")}
        </Button>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ItemList items={items} onChange={change} />
        <Preview items={items} />
      </div>
      {creating && (
        <NewLayoutDialog
          copyFrom={selected}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            void queryClient.invalidateQueries({ queryKey: ["field-layouts"] });
            setLayoutId(id);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

function ItemList({
  items,
  onChange,
}: {
  items: Item[];
  onChange: (items: Item[]) => void;
}) {
  const { t } = useTranslation();
  const label = useFieldLabel();
  const fields = useFields().data ?? [];
  const [dragging, setDragging] = useState<number | null>(null);
  const byId = new Map(fields.map((f) => [f.id, f]));
  const missing = fields.filter((f) => !items.some((i) => i.fieldId === f.id));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
  };
  const set = (index: number, patch: Partial<Item>) =>
    onChange(items.map((x, i) => (i === index ? { ...x, ...patch } : x)));

  return (
    <Card className="flex flex-col gap-3 p-4">
      <ol className="flex flex-col gap-1">
        {items.map((item, i) => {
          const field = byId.get(item.fieldId);
          return (
            <li
              key={item.fieldId}
              draggable
              onDragStart={() => setDragging(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragging !== null) move(dragging, i);
                setDragging(null);
              }}
              className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-2 py-1"
            >
              <GripVertical {...icon} className="cursor-grab text-fg-3" />
              <span className="min-w-32 flex-1 text-fg">
                {field ? label(field) : item.fieldId}
              </span>
              <div className="w-32">
                <Input
                  aria-label={t("app.admin.fields.tab")}
                  placeholder={t("app.admin.fields.tab")}
                  maxLength={100}
                  value={item.tab}
                  onChange={(e) => set(i, { tab: e.target.value })}
                />
              </div>
              {(["required", "hidden"] as const).map((k) => (
                <label
                  key={k}
                  className="flex items-center gap-1 text-sm text-fg-2"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-accent"
                    checked={item[k]}
                    onChange={(e) => set(i, { [k]: e.target.checked })}
                  />
                  {t(`app.admin.fields.${k}`)}
                </label>
              ))}
              <IconButton
                label={t("app.admin.up")}
                disabled={i === 0}
                onClick={() => move(i, i - 1)}
              >
                <ArrowUp {...icon} />
              </IconButton>
              <IconButton
                label={t("app.admin.down")}
                disabled={i === items.length - 1}
                onClick={() => move(i, i + 1)}
              >
                <ArrowDown {...icon} />
              </IconButton>
              <IconButton
                label={t("app.admin.fields.remove")}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                <X {...icon} />
              </IconButton>
            </li>
          );
        })}
      </ol>
      {missing.length > 0 && (
        <div className="w-64">
          <Select
            aria-label={t("app.admin.fields.addToLayout")}
            placeholder={t("app.admin.fields.addToLayout")}
            value={undefined}
            onValueChange={(fieldId) =>
              onChange([
                ...items,
                { fieldId, required: false, hidden: false, tab: "" },
              ])
            }
            options={missing.map((f) => ({ value: f.id, label: label(f) }))}
          />
        </div>
      )}
    </Card>
  );
}

/** The form as people will see it: visible fields, grouped by tab. */
function Preview({ items }: { items: Item[] }) {
  const { t } = useTranslation();
  const label = useFieldLabel();
  const fields = useFields().data ?? [];
  const visible = items.filter((i) => !i.hidden);
  const tabs = [...new Set(visible.map((i) => i.tab))];
  return (
    <section aria-label={t("app.admin.fields.preview")}>
      <h3 className="mb-3 text-sm font-medium text-fg-3">
        {t("app.admin.fields.preview")}
      </h3>
      <Card className="flex flex-col gap-4 p-4">
        {tabs.map((tab) => (
          <div key={tab} className="flex flex-col gap-3">
            {tab && (
              <p className="border-b border-line pb-1 text-sm font-medium text-fg-2">
                {tab}
              </p>
            )}
            {visible
              .filter((i) => i.tab === tab)
              .map((i) => {
                const f = fields.find((x) => x.id === i.fieldId);
                return (
                  <div key={i.fieldId} className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-fg">
                      {f ? label(f) : i.fieldId}
                      {i.required && <span className="text-negative"> *</span>}
                    </span>
                    <div className="h-8 rounded-md border border-line bg-raised" />
                  </div>
                );
              })}
          </div>
        ))}
      </Card>
    </section>
  );
}

function NewLayoutDialog({
  copyFrom,
  onClose,
  onCreated,
}: {
  copyFrom?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const save = useSubmit(
    () =>
      unwrap(
        api.POST("/tickvana/api/field-layouts", {
          body: { name, ...(copyFrom && { copyFrom }) },
        }),
      ),
    (layout) => onCreated(layout.id),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("app.admin.fields.newLayout")}
      description={t("app.admin.fields.newLayoutHint")}
      closeLabel={t("shell.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("app.cancel")}</Button>
          <Button
            variant="primary"
            type="submit"
            form="layout-form"
            disabled={save.isPending}
          >
            {t("app.create")}
          </Button>
        </>
      }
    >
      <form id="layout-form" className="pb-2" onSubmit={save.submit}>
        <FormField label={t("app.admin.columns.name")} error={save.message}>
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
      </form>
    </Dialog>
  );
}
