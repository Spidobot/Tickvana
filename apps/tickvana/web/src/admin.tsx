// Administration: the frame with its own navigation, and the master data page.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  Dialog,
  Field as FormField,
  Frame,
  Input,
  Menu,
  Select,
  Table,
  Tabs,
  Td,
  Th,
  useApp,
  useToast,
  type NavSection,
} from "@tvn/ui";
import {
  Bot,
  Users,
  Database,
  MoreHorizontal,
  Palette,
  Plus,
  Shield,
  SlidersHorizontal,
  Workflow,
  Wrench,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, keys, unwrap, useMeta } from "./api.js";
import { useSubmit } from "./forms.js";
import { CalendarsAdmin } from "./sla-ui.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;
const PREFIX = "/tickvana";

const ADMIN_PAGES = [
  ["master-data", Database],
  ["fields", SlidersHorizontal],
  ["workflows", Workflow],
  ["permissions", Shield],
  ["system", Wrench],
  ["automations", Bot],
  ["customers", Users],
  ["branding", Palette],
] as const;

export function useAdminNav(): NavSection[] {
  const { t } = useTranslation();
  return [
    {
      label: t("app.admin.title"),
      items: ADMIN_PAGES.map(([page, Icon]) => ({
        label: t(`app.admin.pages.${page}`),
        href: `${PREFIX}/admin/${page}`,
        icon: <Icon {...icon} />,
        active: window.location.pathname.startsWith(`${PREFIX}/admin/${page}`),
      })),
    },
  ];
}

/** Admin pages: only for system administrators. */
export function AdminFrame({
  title,
  headerEnd,
  children,
}: {
  title: string;
  headerEnd?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { isAdmin } = useApp();
  return (
    <Frame title={title} sections={useAdminNav()} headerEnd={headerEnd}>
      {isAdmin ? (
        children
      ) : (
        <p className="text-fg-2">{t("app.admin.forbidden")}</p>
      )}
    </Frame>
  );
}

// --- Master data ----------------------------------------------------------------------

type Kind =
  "issue-types" | "statuses" | "priorities" | "resolutions" | "link-types";
type Row = { id: string; name: string } & Record<string, unknown>;
type Column =
  | { key: string; type: "text" | "color" | "number" }
  | { key: string; type: "select"; options: (string | number)[] };

const KINDS: {
  kind: Kind;
  columns: Column[];
  blank: Record<string, unknown>;
}[] = [
  {
    kind: "issue-types",
    columns: [
      { key: "name", type: "text" },
      { key: "icon", type: "text" },
      { key: "level", type: "select", options: [1, 0, -1] },
    ],
    blank: { name: "", icon: "square", level: 0 },
  },
  {
    kind: "statuses",
    columns: [
      { key: "name", type: "text" },
      {
        key: "category",
        type: "select",
        options: ["todo", "in_progress", "done"],
      },
    ],
    blank: { name: "", category: "todo" },
  },
  {
    kind: "priorities",
    columns: [
      { key: "name", type: "text" },
      { key: "color", type: "color" },
      { key: "position", type: "number" },
    ],
    blank: { name: "", color: "#6b6b6b", position: 10 },
  },
  {
    kind: "resolutions",
    columns: [{ key: "name", type: "text" }],
    blank: { name: "" },
  },
  {
    kind: "link-types",
    columns: [
      { key: "name", type: "text" },
      { key: "outward", type: "text" },
      { key: "inward", type: "text" },
    ],
    blank: { name: "", outward: "", inward: "" },
  },
];

// ponytail: the admin paths are built from the kind, which openapi-fetch cannot type; the server checks every body.
const adminCall = (
  method: "POST" | "PATCH" | "DELETE",
  kind: Kind,
  id?: string,
  body?: object,
) =>
  unwrap(
    (api[method] as (path: string, init: object) => Promise<never>)(
      `/tickvana/api/admin/${kind}${id ? "/{id}" : ""}`,
      { params: { path: { id } }, body },
    ),
  );

export function MasterDataPage() {
  const { t } = useTranslation();
  const meta = useMeta().data;
  const linkTypes = useQuery({
    queryKey: ["link-types"],
    queryFn: () => unwrap(api.GET("/tickvana/api/link-types")),
  }).data;
  const rows: Record<Kind, Row[] | undefined> = {
    "issue-types": meta?.issueTypes,
    statuses: meta?.statuses,
    priorities: meta?.priorities,
    resolutions: meta?.resolutions,
    "link-types": linkTypes,
  };
  return (
    <AdminFrame title={t("app.admin.pages.master-data")}>
      <Tabs
        label={t("app.admin.pages.master-data")}
        tabs={[
          ...KINDS.map((k) => ({
            value: k.kind as string,
            label: t(`app.admin.kinds.${k.kind}`),
            content: <KindTable {...k} rows={rows[k.kind] ?? []} />,
          })),
          {
            value: "calendars",
            label: t("app.sla.calendars"),
            content: <CalendarsAdmin />,
          },
        ]}
      />
    </AdminFrame>
  );
}

function KindTable({
  kind,
  columns,
  blank,
  rows,
}: {
  kind: Kind;
  columns: Column[];
  blank: Record<string, unknown>;
  rows: Row[];
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: kind === "link-types" ? ["link-types"] : keys.meta,
    });
  const show = (c: Column, value: unknown) =>
    c.type === "color" ? (
      <span className="inline-flex items-center gap-2">
        {/* The swatch shows the stored value, which is data, not styling. */}
        <span
          className="size-3 rounded-full border border-line"
          style={{ backgroundColor: String(value) }}
        />
        <span className="font-mono text-sm">{String(value)}</span>
      </span>
    ) : c.type === "select" ? (
      t(`app.admin.values.${c.key}.${value}`)
    ) : (
      String(value ?? "")
    );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus {...icon} />
          {t("app.admin.add")}
        </Button>
      </div>
      <Card>
        <Table>
          <thead>
            <tr>
              {columns.map((c) => (
                <Th key={c.key}>{t(`app.admin.columns.${c.key}`)}</Th>
              ))}
              <Th className="w-12">
                <span className="sr-only">{t("app.admin.actions")}</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                {columns.map((c) => (
                  <Td
                    key={c.key}
                    className={c.key === "name" ? "text-fg" : "text-fg-2"}
                  >
                    {show(c, row[c.key])}
                  </Td>
                ))}
                <Td>
                  <Menu
                    trigger={
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t("app.admin.actions")}
                      >
                        <MoreHorizontal {...icon} />
                      </Button>
                    }
                    items={[
                      { label: t("app.edit"), onSelect: () => setEditing(row) },
                      {
                        label: t("app.admin.delete"),
                        onSelect: () =>
                          void adminCall("DELETE", kind, row.id)
                            .then(refresh)
                            .catch((e: Error) =>
                              toast({ title: e.message, tone: "negative" }),
                            ),
                      },
                    ]}
                  />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {editing && (
        <KindDialog
          kind={kind}
          columns={columns}
          row={editing === "new" ? null : editing}
          initial={editing === "new" ? blank : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void refresh();
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function KindDialog({
  kind,
  columns,
  row,
  initial,
  onClose,
  onSaved,
}: {
  kind: Kind;
  columns: Column[];
  row: Row | null;
  initial: Record<string, unknown>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState(() =>
    Object.fromEntries(columns.map((c) => [c.key, initial[c.key]])),
  );
  const save = useSubmit(
    () =>
      row
        ? adminCall("PATCH", kind, row.id, form)
        : adminCall("POST", kind, undefined, form),
    onSaved,
  );
  const formId = `kind-${kind}`;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t(row ? "app.admin.editTitle" : "app.admin.addTitle", {
        kind: t(`app.admin.kinds.${kind}`),
      })}
      closeLabel={t("shell.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("app.cancel")}</Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            disabled={save.isPending}
          >
            {t("app.save")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4 pb-2"
        onSubmit={save.submit}
      >
        {columns.map((c) => (
          <FormField
            key={c.key}
            label={t(`app.admin.columns.${c.key}`)}
            error={save.problems[c.key]}
          >
            {(p) =>
              c.type === "select" ? (
                <Select
                  {...p}
                  value={String(form[c.key])}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      [c.key]: typeof c.options[0] === "number" ? Number(v) : v,
                    })
                  }
                  options={c.options.map((o) => ({
                    value: String(o),
                    label: t(`app.admin.values.${c.key}.${o}`),
                  }))}
                />
              ) : (
                <Input
                  {...p}
                  required={c.key === "name"}
                  type={c.type}
                  value={String(form[c.key] ?? "")}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      [c.key]:
                        c.type === "number"
                          ? Number(e.target.value)
                          : e.target.value,
                    })
                  }
                />
              )
            }
          </FormField>
        ))}
        {save.message && (
          <p role="alert" className="text-sm text-negative">
            {save.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}
