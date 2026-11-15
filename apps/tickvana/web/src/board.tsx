// The board: columns of cards, dragged with the browser's own drag and drop.
// Every card also has a keyboard path: a menu that moves it left or right.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  ApiError,
  Card,
  cx,
  EmptyState,
  Frame,
  IconButton,
  Input,
  IssueKey,
  Menu,
  useApp,
  useToast,
} from "@tvn/ui";
import { ArrowLeft, ArrowRight, Ellipsis } from "lucide-react";
import { useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, unwrap, useMeta, useUsers } from "./api.js";
import { useNav } from "./pages.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

type Cards = Awaited<ReturnType<typeof loadCards>>;
type CardData = Cards["columns"][number]["cards"][number];

const loadCards = (id: string) =>
  unwrap(
    api.GET("/tickvana/api/boards/{id}/cards", { params: { path: { id } } }),
  );

function BoardCard({
  card,
  column,
  columns,
  onMove,
  onDragStart,
}: {
  card: CardData;
  column: number;
  columns: number;
  onMove: (to: number) => void;
  onDragStart: () => void;
}) {
  const { t } = useTranslation();
  const users = useUsers().data ?? [];
  const meta = useMeta().data;
  const assignee = users.find((u) => u.id === card.assigneeId)?.displayName;
  const type = meta?.issueTypes.find((i) => i.id === card.typeId)?.name;
  const initials = assignee
    ?.split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2);
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", card.key);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      data-key={card.key}
      className="group flex cursor-grab flex-col gap-3 rounded-md border border-line bg-surface p-3 transition-colors hover:border-line-strong active:cursor-grabbing"
    >
      <div className="flex items-start gap-2">
        <Link
          to="/issues/$key"
          params={{ key: card.key }}
          className="flex-1 text-base text-fg underline-offset-4 hover:underline"
        >
          {card.summary}
        </Link>
        <Menu
          trigger={
            <IconButton
              label={t("app.cardMenu", { key: card.key })}
              className="-mt-1 -mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <Ellipsis {...icon} />
            </IconButton>
          }
          items={[
            {
              label: t("app.moveLeft"),
              icon: <ArrowLeft {...icon} />,
              disabled: column === 0,
              onSelect: () => onMove(column - 1),
            },
            {
              label: t("app.moveRight"),
              icon: <ArrowRight {...icon} />,
              disabled: column === columns - 1,
              onSelect: () => onMove(column + 1),
            },
          ]}
        />
      </div>
      <div className="flex items-center gap-2">
        <IssueKey>{card.key}</IssueKey>
        {type && <span className="text-sm text-fg-3">{type}</span>}
        <span className="flex-1" />
        {card.estimateSec !== null && (
          <span className="font-mono text-xs tabular-nums text-fg-3">
            {Math.round((card.estimateSec / 3600) * 10) / 10} h
          </span>
        )}
        {assignee && (
          <span
            title={assignee}
            className="flex size-6 items-center justify-center rounded-full bg-raised text-xs font-medium text-fg-2"
          >
            {initials}
          </span>
        )}
      </div>
    </li>
  );
}

export function BoardPage() {
  const { t } = useTranslation();
  const { id } = useParams({ from: "/boards/$id" });
  const { me } = useApp();
  const toast = useToast();
  const queryClient = useQueryClient();
  const queryKey = ["board", id, "cards"];
  const board = useQuery({
    queryKey: ["board", id],
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/boards/{id}", { params: { path: { id } } }),
      ),
  });
  const cards = useQuery({ queryKey, queryFn: () => loadCards(id) });
  const nav = useNav(board.data?.projectKey ?? undefined);
  const [dragging, setDragging] = useState<string>();
  const [over, setOver] = useState<number>();
  const [text, setText] = useState("");
  const [mine, setMine] = useState(false);

  const move = useMutation({
    mutationFn: (body: {
      key: string;
      column: number;
      afterKey?: string;
      beforeKey?: string;
    }) =>
      unwrap(
        api.POST("/tickvana/api/boards/{id}/move", {
          params: { path: { id } },
          body,
        }),
      ),
    // Show the card in its new place at once; the server answer confirms or undoes it.
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey });
      const before = queryClient.getQueryData<Cards>(queryKey);
      if (before) {
        const card = before.columns
          .flatMap((c) => c.cards)
          .find((c) => c.key === body.key);
        if (card) {
          const columns = before.columns.map((c) => ({
            ...c,
            cards: c.cards.filter((x) => x.key !== body.key),
          }));
          const target = columns[body.column]!;
          const at = body.afterKey
            ? target.cards.findIndex((c) => c.key === body.afterKey) + 1
            : body.beforeKey
              ? target.cards.findIndex((c) => c.key === body.beforeKey)
              : target.cards.length;
          target.cards.splice(Math.max(0, at), 0, card);
          queryClient.setQueryData(queryKey, { ...before, columns });
        }
      }
      return { before };
    },
    onError: (e, _body, context) => {
      if (context?.before) queryClient.setQueryData(queryKey, context.before);
      toast({
        title: t("state.errorTitle"),
        text: (e as Error).message,
        tone: "negative",
      });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey }),
  });

  const visible = (card: CardData) =>
    (!mine || card.assigneeId === me.id) &&
    (!text.trim() ||
      `${card.key} ${card.summary} ${card.labels.join(" ")}`
        .toLowerCase()
        .includes(text.trim().toLowerCase()));

  const columns = cards.data?.columns ?? [];
  // A few hundred cards at most: filtering on every render is cheap.
  const filtered = columns.map((c) => ({
    ...c,
    cards: c.cards.filter(visible),
  }));

  /** Drop position from the pointer: before the first card whose middle is below it. */
  const drop = (e: DragEvent<HTMLElement>, column: number) => {
    e.preventDefault();
    setOver(undefined);
    const key = e.dataTransfer.getData("text/plain");
    if (!key) return;
    const list = [
      ...e.currentTarget.querySelectorAll<HTMLElement>("li[data-key]"),
    ].filter((el) => el.dataset.key !== key);
    const next = list.find((el) => {
      const box = el.getBoundingClientRect();
      return e.clientY < box.top + box.height / 2;
    });
    const index = next ? list.indexOf(next) : list.length;
    move.mutate({
      key,
      column,
      afterKey: index > 0 ? list[index - 1]!.dataset.key : undefined,
      beforeKey: next?.dataset.key,
    });
    setDragging(undefined);
  };

  if (board.error instanceof ApiError && board.error.status === 404) {
    return (
      <Frame title={t("app.notFoundTitle")} sections={nav}>
        <EmptyState
          title={t("app.notFoundTitle")}
          text={t("app.notFoundText")}
        />
      </Frame>
    );
  }

  return (
    <Frame
      title={board.data?.name ?? ""}
      sections={nav}
      headerEnd={
        <>
          {board.data?.kind === "scrum" && (
            <Link
              to="/boards/$id/backlog"
              params={{ id }}
              className="inline-flex h-8 items-center rounded-md px-3 text-sm text-fg-2 transition-colors hover:bg-raised hover:text-fg"
            >
              {t("app.backlog")}
            </Link>
          )}
          <Link
            to="/boards/$id/reports"
            params={{ id }}
            className="inline-flex h-8 items-center rounded-md px-3 text-sm text-fg-2 transition-colors hover:bg-raised hover:text-fg"
          >
            {t("app.reports")}
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="w-64">
            <Input
              aria-label={t("app.boardSearch")}
              placeholder={t("app.boardSearch")}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-fg-2">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              checked={mine}
              onChange={(e) => setMine(e.target.checked)}
            />
            {t("app.onlyMine")}
          </label>
          {cards.data?.unmapped ? (
            <span className="text-sm text-fg-3">
              {t("app.unmapped", { count: cards.data.unmapped })}
            </span>
          ) : null}
        </div>
        <div className="grid auto-cols-[minmax(260px,1fr)] grid-flow-col gap-4 overflow-x-auto pb-2">
          {filtered.map((column, i) => (
            <section
              key={column.name}
              aria-label={column.name}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(i);
              }}
              onDragLeave={() => setOver((o) => (o === i ? undefined : o))}
              onDrop={(e) => drop(e, i)}
              className={cx(
                "flex min-h-40 flex-col gap-2 rounded-lg bg-sunken p-2 transition-colors",
                over === i &&
                  dragging &&
                  "outline-2 outline-dashed outline-line-strong",
              )}
            >
              <header className="flex h-8 items-center gap-2 px-2">
                <span className="text-sm font-medium text-fg">
                  {column.name}
                </span>
                <span
                  className={cx(
                    "font-mono text-xs tabular-nums",
                    column.overLimit ? "text-negative" : "text-fg-3",
                  )}
                >
                  {column.cards.length}
                  {column.wipLimit !== null && ` / ${column.wipLimit}`}
                </span>
              </header>
              <ul className="flex flex-col gap-2">
                {column.cards.map((card) => (
                  <BoardCard
                    key={card.key}
                    card={card}
                    column={i}
                    columns={filtered.length}
                    onDragStart={() => setDragging(card.key)}
                    onMove={(to) => move.mutate({ key: card.key, column: to })}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
        {cards.data?.truncated && (
          <Card className="p-4 text-sm text-fg-2">
            {t("app.boardTruncated")}
          </Card>
        )}
      </div>
    </Frame>
  );
}
