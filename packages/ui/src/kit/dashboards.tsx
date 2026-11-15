// Dashboards: a grid of saved queries shown as table, number or bars. Each
// widget runs with the viewer's rights through the app that owns its tables.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Home, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  IconButton,
  Input,
} from "../components.js";
import { QueryView, type QueryBlockAttrs } from "../editor.js";
import { Dialog, Select, useToast } from "../overlays.js";
import { useApp } from "./app.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

interface Dashboard {
  id: string;
  name: string;
  visibility: "private" | "group" | "global";
  groupId: string | null;
  mine: boolean;
  home: boolean;
}
interface Widget {
  id: string;
  queryId: string;
  app: QueryBlockAttrs["app"];
  title: string;
  view: QueryBlockAttrs["view"];
  width: 1 | 2;
}

function useDashboardApi() {
  const { api } = useApp();
  const queryClient = useQueryClient();
  const toast = useToast();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["dashboards"] });
  const run = <T,>(p: Promise<T>) =>
    p.then(
      (v) => refresh().then(() => v),
      (e: Error) => {
        toast({ title: e.message, tone: "negative" });
        throw e;
      },
    );
  return { call: api.call, run };
}

export function useDashboards() {
  const { api } = useApp();
  return useQuery({
    queryKey: ["dashboards"],
    queryFn: () => api.call<Dashboard[]>("GET", "/core/dashboards"),
  });
}

/** The widgets of one dashboard, in a two-column grid. */
export function DashboardView({ id }: { id: string }) {
  const { t } = useTranslation();
  const { call, run } = useDashboardApi();
  const board = useQuery({
    queryKey: ["dashboards", id],
    queryFn: () =>
      call<Dashboard & { widgets: Widget[] }>("GET", `/core/dashboards/${id}`),
  });
  const [adding, setAdding] = useState(false);
  if (board.isError) return <EmptyState title={t("dashboard.gone")} text="" />;
  if (!board.data) return null;
  const d = board.data;
  const move = (i: number, by: number) => {
    const order = d.widgets.map((w) => w.id);
    [order[i], order[i + by]] = [order[i + by]!, order[i]!];
    void run(call("PATCH", `/core/dashboards/${id}`, { order })).catch(
      () => undefined,
    );
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-xl font-medium text-fg">{d.name}</h2>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={d.home}
          onClick={() =>
            void run(
              call("PUT", "/core/me/home-dashboard", {
                dashboardId: d.home ? null : d.id,
              }),
            ).catch(() => undefined)
          }
        >
          <Home {...icon} className={d.home ? "text-accent" : ""} />
          {d.home ? t("dashboard.isHome") : t("dashboard.makeHome")}
        </Button>
        {d.mine && (
          <>
            <ShareSelect board={d} />
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus {...icon} />
              {t("dashboard.addWidget")}
            </Button>
          </>
        )}
      </div>
      {d.widgets.length === 0 ? (
        <EmptyState
          title={t("dashboard.empty")}
          text={t("dashboard.emptyText")}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {d.widgets.map((w, i) => (
            <Card
              key={w.id}
              className={cx(
                "flex min-w-0 flex-col",
                w.width === 2 && "lg:col-span-2",
              )}
            >
              <div className="flex items-center gap-1 border-b border-line px-3 py-2">
                <h3 className="flex-1 truncate text-sm font-medium text-fg-2">
                  {w.title || t(`dashboard.views.${w.view}`)}
                </h3>
                {d.mine && (
                  <>
                    <IconButton
                      label={t("dashboard.earlier")}
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      <ArrowLeft {...icon} />
                    </IconButton>
                    <IconButton
                      label={t("dashboard.later")}
                      disabled={i === d.widgets.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowRight {...icon} />
                    </IconButton>
                    <IconButton
                      label={t("dashboard.removeWidget")}
                      onClick={() =>
                        void run(
                          call(
                            "DELETE",
                            `/core/dashboards/${id}/widgets/${w.id}`,
                          ),
                        ).catch(() => undefined)
                      }
                    >
                      <X {...icon} />
                    </IconButton>
                  </>
                )}
              </div>
              <div className="overflow-x-auto">
                <QueryView
                  app={w.app}
                  queryId={w.queryId}
                  sql=""
                  view={w.view}
                />
              </div>
            </Card>
          ))}
        </div>
      )}
      {adding && (
        <WidgetDialog dashboardId={id} onClose={() => setAdding(false)} />
      )}
    </div>
  );
}

function ShareSelect({ board }: { board: Dashboard }) {
  const { t } = useTranslation();
  const { call, run } = useDashboardApi();
  const groups =
    useQuery({
      queryKey: ["dashboard-groups"],
      queryFn: () =>
        call<{ id: string; name: string }[]>("GET", "/core/groups"),
    }).data ?? [];
  const value =
    board.visibility === "group" ? `group:${board.groupId}` : board.visibility;
  return (
    <div className="w-44">
      <Select
        aria-label={t("dashboard.share")}
        value={value}
        onValueChange={(v) =>
          void run(
            call(
              "PATCH",
              `/core/dashboards/${board.id}`,
              v.startsWith("group:")
                ? { visibility: "group", groupId: v.slice(6) }
                : { visibility: v },
            ),
          ).catch(() => undefined)
        }
        options={[
          { value: "private", label: t("query.private") },
          ...groups.map((g) => ({ value: `group:${g.id}`, label: g.name })),
          { value: "global", label: t("query.global") },
        ]}
      />
    </div>
  );
}

function WidgetDialog({
  dashboardId,
  onClose,
}: {
  dashboardId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { prefix } = useApp();
  const { call, run } = useDashboardApi();
  const queries =
    useQuery({
      queryKey: ["core", "queries"],
      queryFn: () =>
        call<{ id: string; name: string }[]>("GET", "/core/queries"),
    }).data ?? [];
  const [w, setW] = useState({
    queryId: "",
    title: "",
    view: "table" as Widget["view"],
    width: 1 as 1 | 2,
  });
  // The query runs against the tables of the app it was saved in.
  const app = prefix === "/nuvenna" ? "nuvenna" : "tickvana";
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("dashboard.addWidget")}
      closeLabel={t("shell.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("dashboard.cancel")}</Button>
          <Button
            variant="primary"
            disabled={!w.queryId}
            onClick={() =>
              void run(
                call("POST", `/core/dashboards/${dashboardId}/widgets`, {
                  ...w,
                  app,
                }),
              )
                .then(onClose)
                .catch(() => undefined)
            }
          >
            {t("dashboard.addWidget")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pb-2">
        <Field label={t("query.saved")}>
          {(p) => (
            <Select
              id={p.id}
              value={w.queryId || undefined}
              placeholder={t("dashboard.choose")}
              onValueChange={(queryId) => setW({ ...w, queryId })}
              options={queries.map((q) => ({ value: q.id, label: q.name }))}
            />
          )}
        </Field>
        <Field label={t("dashboard.title")}>
          {(p) => (
            <Input
              {...p}
              maxLength={200}
              value={w.title}
              onChange={(e) => setW({ ...w, title: e.target.value })}
            />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t("dashboard.view")}>
            {(p) => (
              <Select
                id={p.id}
                value={w.view}
                onValueChange={(v) => setW({ ...w, view: v as Widget["view"] })}
                options={(["table", "number", "bar"] as const).map((v) => ({
                  value: v,
                  label: t(`dashboard.views.${v}`),
                }))}
              />
            )}
          </Field>
          <Field label={t("dashboard.width")}>
            {(p) => (
              <Select
                id={p.id}
                value={String(w.width)}
                onValueChange={(v) => setW({ ...w, width: v === "2" ? 2 : 1 })}
                options={[
                  { value: "1", label: t("dashboard.half") },
                  { value: "2", label: t("dashboard.full") },
                ]}
              />
            )}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

/** List of dashboards on the left, the chosen one on the right. */
export function Dashboards({
  selected,
  onOpen,
}: {
  selected?: string;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { call, run } = useDashboardApi();
  const list = useDashboards().data;
  const [name, setName] = useState("");
  const current = selected ?? list?.find((d) => d.home)?.id ?? list?.[0]?.id;
  const chosen = list?.find((d) => d.id === current);
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <nav aria-label={t("dashboard.list")} className="flex flex-col gap-2">
        <ul className="flex flex-col gap-0.5">
          {list?.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                onClick={() => onOpen(d.id)}
                aria-current={d.id === current ? "page" : undefined}
                className={cx(
                  "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-base transition-colors",
                  d.id === current
                    ? "bg-raised text-fg"
                    : "text-fg-2 hover:bg-raised hover:text-fg",
                )}
              >
                <span className="flex-1 truncate">{d.name}</span>
                {d.home && <Home {...icon} className="text-fg-3" />}
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(call<Dashboard>("POST", "/core/dashboards", { name }))
              .then((d) => {
                setName("");
                onOpen(d.id);
              })
              .catch(() => undefined);
          }}
        >
          <Input
            aria-label={t("dashboard.newName")}
            placeholder={t("dashboard.newName")}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <IconButton label={t("dashboard.create")} type="submit">
            <Plus {...icon} />
          </IconButton>
        </form>
        {chosen?.mine && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void run(call("DELETE", `/core/dashboards/${chosen.id}`)).catch(
                () => undefined,
              )
            }
          >
            <Trash2 {...icon} />
            {t("dashboard.delete")}
          </Button>
        )}
      </nav>
      {current ? (
        <DashboardView id={current} />
      ) : (
        <EmptyState
          title={t("dashboard.none")}
          text={t("dashboard.noneText")}
        />
      )}
    </div>
  );
}
