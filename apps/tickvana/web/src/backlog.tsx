// Backlog of a scrum board: open sprints on top, the backlog below. Tickets
// move between them with a menu (keyboard) or by dragging; dragging inside a
// list reorders it.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  Button,
  Card,
  Frame,
  IconButton,
  IssueKey,
  Menu,
  useToast,
} from "@tvn/ui";
import { Ellipsis, Play, Plus } from "lucide-react";
import { useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, unwrap, useUsers } from "./api.js";
import { useNav } from "./pages.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;
type Backlog = Awaited<ReturnType<typeof load>>;
type Entry = Backlog["backlog"][number];

const load = (id: string) =>
  unwrap(
    api.GET("/tickvana/api/boards/{id}/backlog", { params: { path: { id } } }),
  );
const hours = (sec: number) => `${Math.round((sec / 3600) * 10) / 10} h`;

export function BacklogPage() {
  const { t, i18n } = useTranslation();
  const { id } = useParams({ from: "/boards/$id/backlog" });
  const toast = useToast();
  const queryClient = useQueryClient();
  const users = useUsers().data ?? [];
  const queryKey = ["board", id, "backlog"];
  const board = useQuery({
    queryKey: ["board", id],
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/boards/{id}", { params: { path: { id } } }),
      ),
  });
  const data = useQuery({ queryKey, queryFn: () => load(id) });
  const nav = useNav(board.data?.projectKey ?? undefined);
  const [dragging, setDragging] = useState<string>();

  const run = useMutation({
    mutationFn: (call: () => Promise<unknown>) => call(),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["board", id] }),
    onError: (e) =>
      toast({
        title: t("state.errorTitle"),
        text: (e as Error).message,
        tone: "negative",
      }),
  });
  const intoSprint = (sprint: string, key: string) => () =>
    unwrap(
      api.PUT("/tickvana/api/sprints/{id}/issues/{key}", {
        params: { path: { id: sprint, key } },
      }),
    );
  const outOfSprint = (sprint: string, key: string) => () =>
    unwrap(
      api.DELETE("/tickvana/api/sprints/{id}/issues/{key}", {
        params: { path: { id: sprint, key } },
      }),
    );
  const rank = (key: string, afterKey?: string, beforeKey?: string) => () =>
    unwrap(
      api.POST("/tickvana/api/issues/{key}/rank", {
        params: { path: { key } },
        body: { afterKey, beforeKey },
      }),
    );
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" });

  /** Dropped onto a list: join that sprint (or the backlog) and take the position under the pointer. */
  const drop = (
    e: DragEvent<HTMLElement>,
    target: string | null,
    from: string | null,
  ) => {
    e.preventDefault();
    const key = e.dataTransfer.getData("text/plain");
    setDragging(undefined);
    if (!key) return;
    const rows = [
      ...e.currentTarget.querySelectorAll<HTMLElement>("li[data-key]"),
    ].filter((el) => el.dataset.key !== key);
    const next = rows.find(
      (el) =>
        e.clientY <
        el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2,
    );
    const index = next ? rows.indexOf(next) : rows.length;
    run.mutate(async () => {
      if (target !== from) {
        if (target) await intoSprint(target, key)();
        else if (from) await outOfSprint(from, key)();
      }
      if (rows.length)
        await rank(
          key,
          index > 0 ? rows[index - 1]!.dataset.key : undefined,
          next?.dataset.key,
        )();
    });
  };

  const projectKey = board.data?.projectKey ?? undefined;
  const epics = useQuery({
    queryKey: ["epics", projectKey],
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/projects/{key}/epics", {
          params: { path: { key: projectKey! } },
        }),
      ),
    enabled: !!projectKey,
  });
  const [epic, setEpic] = useState<string | null>(null);
  const byEpic = (entries: Entry[]) =>
    epic ? entries.filter((e) => e.parentId === epic) : entries;
  const sprints = data.data?.sprints ?? [];
  const row = (entry: Entry, from: string | null) => (
    <li
      key={entry.key}
      data-key={entry.key}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", entry.key);
        setDragging(entry.key);
      }}
      className="flex h-10 cursor-grab items-center gap-3 border-b border-line px-3 last:border-b-0 hover:bg-raised"
    >
      <IssueKey done={entry.done}>{entry.key}</IssueKey>
      <Link
        to="/issues/$key"
        params={{ key: entry.key }}
        className="flex-1 truncate text-fg underline-offset-4 hover:underline"
      >
        {entry.summary}
      </Link>
      <span className="w-32 truncate text-sm text-fg-2">
        {users.find((u) => u.id === entry.assigneeId)?.displayName ?? ""}
      </span>
      <span className="w-14 text-right font-mono text-xs tabular-nums text-fg-3">
        {entry.estimateSec !== null ? hours(entry.estimateSec) : "–"}
      </span>
      <Menu
        trigger={
          <IconButton label={t("app.cardMenu", { key: entry.key })}>
            <Ellipsis {...icon} />
          </IconButton>
        }
        items={[
          ...sprints
            .filter((s) => s.id !== from)
            .map((s) => ({
              label: t("app.moveToSprint", { name: s.name }),
              onSelect: () => run.mutate(intoSprint(s.id, entry.key)),
            })),
          ...(from
            ? [
                {
                  label: t("app.moveToBacklog"),
                  onSelect: () => run.mutate(outOfSprint(from, entry.key)),
                },
              ]
            : []),
        ]}
      />
    </li>
  );
  const list = (entries: Entry[], sprint: string | null) => (
    <ul
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const from =
          sprints.find((s) => s.issues.some((i) => i.key === dragging))?.id ??
          null;
        drop(e, sprint, from);
      }}
      className="min-h-10"
    >
      {entries.map((entry) => row(entry, sprint))}
      {entries.length === 0 && (
        <li className="flex h-10 items-center px-3 text-sm text-fg-3">
          {t("app.emptyList")}
        </li>
      )}
    </ul>
  );

  const active = sprints.some((s) => s.state === "active");
  return (
    <Frame
      title={board.data ? `${board.data.name} · ${t("app.backlog")}` : ""}
      sections={nav}
      headerEnd={
        <Button
          size="sm"
          onClick={() =>
            run.mutate(() =>
              unwrap(
                api.POST("/tickvana/api/boards/{id}/sprints", {
                  params: { path: { id } },
                  body: {},
                }),
              ),
            )
          }
        >
          <Plus {...icon} />
          {t("app.newSprint")}
        </Button>
      }
    >
      <div className="grid grid-cols-[240px_minmax(0,1fr)] items-start gap-6 max-lg:grid-cols-1">
        <aside aria-label={t("app.epics")} className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-fg-2">{t("app.epics")}</h2>
          <button
            type="button"
            aria-pressed={epic === null}
            onClick={() => setEpic(null)}
            className={`flex h-8 items-center rounded-md px-2 text-left text-base transition-colors ${epic === null ? "bg-raised text-fg" : "text-fg-2 hover:bg-raised hover:text-fg"}`}
          >
            {t("app.allEpics")}
          </button>
          {epics.data?.length === 0 && (
            <p className="px-2 text-sm text-fg-3">{t("app.noEpics")}</p>
          )}
          {epics.data?.map((e) => (
            <button
              key={e.id}
              type="button"
              aria-pressed={epic === e.id}
              onClick={() => setEpic(epic === e.id ? null : e.id)}
              className={`flex flex-col gap-1 rounded-md px-2 py-2 text-left transition-colors ${epic === e.id ? "bg-raised" : "hover:bg-raised"}`}
            >
              <span className="truncate text-base text-fg">{e.summary}</span>
              {/* Progress by count: a thin bar, accent for what is done. */}
              <span
                className="h-1 overflow-hidden rounded-full bg-line"
                aria-hidden
              >
                <span
                  className="block h-full bg-accent-ink"
                  style={{
                    width: `${e.total ? (e.doneCount / e.total) * 100 : 0}%`,
                  }}
                />
              </span>
              <span className="font-mono text-xs tabular-nums text-fg-3">
                {e.key} ·{" "}
                {t("app.progress", { done: e.doneCount, total: e.total })}
              </span>
            </button>
          ))}
        </aside>
        <div className="flex flex-col gap-6">
          {sprints.map((s) => (
            <Card key={s.id} aria-label={s.name}>
              <header className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2">
                <h2 className="font-medium text-fg">{s.name}</h2>
                {s.goal && <span className="text-sm text-fg-2">{s.goal}</span>}
                {s.endAt && s.state === "active" && (
                  <span className="text-sm text-fg-3">
                    {t("app.endsOn", { date: date.format(new Date(s.endAt)) })}
                  </span>
                )}
                <span className="flex-1" />
                <span className="font-mono text-xs tabular-nums text-fg-3">
                  {s.issues.length} · {hours(s.estimateSec)}
                </span>
                {s.state === "future" && !active && (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() =>
                      run.mutate(() =>
                        unwrap(
                          api.POST("/tickvana/api/sprints/{id}/start", {
                            params: { path: { id: s.id } },
                            body: {
                              endAt: new Date(
                                Date.now() + 14 * 86_400_000,
                              ).toISOString(),
                            },
                          }),
                        ),
                      )
                    }
                  >
                    <Play {...icon} />
                    {t("app.startSprint")}
                  </Button>
                )}
                {s.state === "active" && (
                  <Button
                    size="sm"
                    onClick={() =>
                      run.mutate(() =>
                        unwrap(
                          api.POST("/tickvana/api/sprints/{id}/complete", {
                            params: { path: { id: s.id } },
                            // Unfinished tickets go to the next planned sprint, or back to the backlog.
                            body: {
                              moveTo:
                                sprints.find((x) => x.state === "future")?.id ??
                                null,
                            },
                          }),
                        ),
                      )
                    }
                  >
                    {t("app.completeSprint")}
                  </Button>
                )}
              </header>
              {list(byEpic(s.issues), s.id)}
            </Card>
          ))}
          <Card aria-label={t("app.backlog")}>
            <header className="flex items-center gap-3 border-b border-line px-3 py-2">
              <h2 className="font-medium text-fg">{t("app.backlog")}</h2>
              <span className="flex-1" />
              <span className="font-mono text-xs tabular-nums text-fg-3">
                {data.data?.backlog.length ?? 0}
              </span>
            </header>
            {list(byEpic(data.data?.backlog ?? []), null)}
          </Card>
        </div>
      </div>
    </Frame>
  );
}
