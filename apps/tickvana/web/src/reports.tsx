// Board reports as plain SVG: one main chart at a time, quiet grid, one
// accent for the line that matters, neutral steps for the rest.
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Card, EmptyState, Frame, Table, Tabs, Td, Th } from "@tvn/ui";
import { useTranslation } from "react-i18next";
import { api, unwrap } from "./api.js";
import { useNav } from "./pages.js";

const W = 720;
const H = 280;
const PAD = { top: 16, right: 16, bottom: 28, left: 48 };
const hours = (sec: number) => Math.round((sec / 3600) * 10) / 10;

/** Axes, grid and labels for a chart with `n` points on x and values up to `max`. */
function Frame2D({
  max,
  labels,
  unit,
  children,
}: {
  max: number;
  labels: string[];
  unit: string;
  children: (
    x: (i: number) => number,
    y: (v: number) => number,
  ) => React.ReactNode;
}) {
  const top = max > 0 ? max : 1;
  const x = (i: number) =>
    PAD.left +
    (labels.length <= 1
      ? 0
      : (i / (labels.length - 1)) * (W - PAD.left - PAD.right));
  const y = (v: number) => PAD.top + (1 - v / top) * (H - PAD.top - PAD.bottom);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const every = Math.max(1, Math.ceil(labels.length / 8));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img">
      {ticks.map((v) => (
        <g key={v}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(v)}
            y2={y(v)}
            stroke="var(--line)"
          />
          <text
            x={PAD.left - 8}
            y={y(v) + 4}
            textAnchor="end"
            fontSize="11"
            fill="var(--fg-3)"
            fontFamily="var(--font-mono)"
          >
            {Math.round(v * 10) / 10}
            {unit}
          </text>
        </g>
      ))}
      {labels.map((label, i) =>
        i % every === 0 ? (
          <text
            key={label + i}
            x={x(i)}
            y={H - 8}
            textAnchor="middle"
            fontSize="11"
            fill="var(--fg-3)"
            fontFamily="var(--font-mono)"
          >
            {label}
          </text>
        ) : null,
      )}
      {children(x, y)}
    </svg>
  );
}

const path = (points: [number, number][]) =>
  points
    .map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`)
    .join(" ");
const short = (day: string) => day.slice(5).replace("-", ".");

function Burndown({ id }: { id: string }) {
  const { t } = useTranslation();
  const data = useQuery({
    queryKey: ["report", id, "burndown"],
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/boards/{id}/reports/burndown", {
          params: { path: { id }, query: {} },
        }),
      ),
    retry: false,
  });
  if (data.isError) return <EmptyState title={t("app.noSprintYet")} />;
  if (!data.data) return null;
  const points = data.data.points;
  const max = Math.max(
    ...points.map((p) => hours(Math.max(p.idealSec, p.remainingSec ?? 0))),
  );
  return (
    <Card className="p-4">
      <p className="pb-2 text-sm text-fg-2">{data.data.sprint.name}</p>
      <Frame2D max={max} labels={points.map((p) => short(p.day))} unit="h">
        {(x, y) => (
          <>
            <path
              d={path(points.map((p, i) => [x(i), y(hours(p.idealSec))]))}
              fill="none"
              stroke="var(--line-strong)"
              strokeDasharray="4 4"
            />
            <path
              d={path(
                points.flatMap((p, i) =>
                  p.remainingSec === null
                    ? []
                    : [[x(i), y(hours(p.remainingSec))] as [number, number]],
                ),
              )}
              fill="none"
              stroke="var(--brand-accent-ink)"
              strokeWidth="2"
            />
            {/* Dots too: on a sprint's first day the line is a single point. */}
            {points.map((p, i) =>
              p.remainingSec === null ? null : (
                <circle
                  key={p.day}
                  cx={x(i)}
                  cy={y(hours(p.remainingSec))}
                  r="3"
                  fill="var(--brand-accent-ink)"
                />
              ),
            )}
          </>
        )}
      </Frame2D>
      <p className="flex gap-4 pt-2 text-sm text-fg-2">
        <span className="flex items-center gap-2">
          <span className="h-0.5 w-4 bg-accent-ink" />
          {t("app.remaining")}
        </span>
        <span className="flex items-center gap-2">
          <span className="h-0 w-4 border-t border-dashed border-line-strong" />
          {t("app.ideal")}
        </span>
      </p>
    </Card>
  );
}

function Velocity({ id }: { id: string }) {
  const { t } = useTranslation();
  const data = useQuery({
    queryKey: ["report", id, "velocity"],
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/boards/{id}/reports/velocity", {
          params: { path: { id } },
        }),
      ),
  });
  if (!data.data) return null;
  if (data.data.length === 0)
    return <EmptyState title={t("app.noClosedSprint")} />;
  const rows = data.data;
  const max = Math.max(
    ...rows.flatMap((r) => [hours(r.committedSec), hours(r.completedSec)]),
  );
  const band = (W - PAD.left - PAD.right) / rows.length;
  return (
    <Card className="p-4">
      <Frame2D max={max} labels={[]} unit="h">
        {(_x, y) =>
          rows.map((r, i) => {
            const left = PAD.left + i * band + band * 0.2;
            const bar = band * 0.28;
            return (
              <g key={r.sprintId}>
                <rect
                  x={left}
                  y={y(hours(r.committedSec))}
                  width={bar}
                  height={y(0) - y(hours(r.committedSec))}
                  rx="2"
                  fill="var(--line-strong)"
                />
                <rect
                  x={left + bar + 4}
                  y={y(hours(r.completedSec))}
                  width={bar}
                  height={y(0) - y(hours(r.completedSec))}
                  rx="2"
                  fill="var(--brand-accent-ink)"
                />
                <text
                  x={left + bar}
                  y={H - 8}
                  textAnchor="middle"
                  fontSize="11"
                  fill="var(--fg-3)"
                >
                  {r.name}
                </text>
              </g>
            );
          })
        }
      </Frame2D>
      <p className="flex gap-4 pt-2 text-sm text-fg-2">
        <span className="flex items-center gap-2">
          <span className="size-3 rounded-sm bg-line-strong" />
          {t("app.committed")}
        </span>
        <span className="flex items-center gap-2">
          <span className="size-3 rounded-sm bg-accent-ink" />
          {t("app.completed")}
        </span>
      </p>
    </Card>
  );
}

function Flow({ id }: { id: string }) {
  const { t } = useTranslation();
  const data = useQuery({
    queryKey: ["report", id, "flow"],
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/boards/{id}/reports/flow", {
          params: { path: { id }, query: { days: 30 } },
        }),
      ),
  });
  if (!data.data) return null;
  const rows = data.data;
  const max = Math.max(1, ...rows.map((r) => r.todo + r.inProgress + r.done));
  // Stacked bands from the bottom: done, in progress, to do.
  const layers = [
    {
      key: "done",
      label: t("app.categoryDone"),
      color: "var(--line-strong)",
      value: (r: (typeof rows)[number]) => r.done,
    },
    {
      key: "inProgress",
      label: t("app.categoryInProgress"),
      color: "var(--brand-accent-ink)",
      value: (r: (typeof rows)[number]) => r.done + r.inProgress,
    },
    {
      key: "todo",
      label: t("app.categoryTodo"),
      color: "var(--raised)",
      value: (r: (typeof rows)[number]) => r.done + r.inProgress + r.todo,
    },
  ];
  return (
    <Card className="p-4">
      <Frame2D max={max} labels={rows.map((r) => short(r.day))} unit="">
        {(x, y) =>
          [...layers]
            .reverse()
            .map((layer) => (
              <path
                key={layer.key}
                d={`${path(rows.map((r, i) => [x(i), y(layer.value(r))]))} L${x(rows.length - 1)},${y(0)} L${x(0)},${y(0)} Z`}
                fill={layer.color}
                fillOpacity={layer.key === "inProgress" ? 0.7 : 1}
              />
            ))
        }
      </Frame2D>
      <p className="flex gap-4 pt-2 text-sm text-fg-2">
        {layers.map((l) => (
          <span key={l.key} className="flex items-center gap-2">
            <span
              className="size-3 rounded-sm border border-line"
              style={{ background: l.color }}
            />
            {l.label}
          </span>
        ))}
      </p>
    </Card>
  );
}

function CycleTime({ id }: { id: string }) {
  const { t } = useTranslation();
  const data = useQuery({
    queryKey: ["report", id, "cycle"],
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/boards/{id}/reports/cycle-time", {
          params: { path: { id } },
        }),
      ),
  });
  if (!data.data) return null;
  if (data.data.issues.length === 0)
    return <EmptyState title={t("app.nothingDoneYet")} />;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
        {[
          [t("app.average"), data.data.averageHours],
          [t("app.median"), data.data.medianHours],
        ].map(([label, value]) => (
          <Card key={label as string} className="flex flex-col gap-1 p-4">
            <span className="text-sm text-fg-2">{label}</span>
            <span className="font-mono text-2xl tabular-nums text-fg">
              {value} h
            </span>
          </Card>
        ))}
      </div>
      <Card>
        <Table>
          <thead>
            <tr>
              <Th className="w-28">{t("app.key")}</Th>
              <Th>{t("app.doneOn")}</Th>
              <Th className="w-28 text-right">{t("app.hours")}</Th>
            </tr>
          </thead>
          <tbody>
            {data.data.issues.map((i) => (
              <tr key={i.key}>
                <Td>
                  <Link
                    to="/issues/$key"
                    params={{ key: i.key }}
                    className="font-mono text-sm text-fg underline-offset-4 hover:underline"
                  >
                    {i.key}
                  </Link>
                </Td>
                <Td className="text-fg-2">{i.doneAt.slice(0, 10)}</Td>
                <Td className="text-right font-mono text-sm tabular-nums">
                  {i.hours}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

export function ReportsPage() {
  const { t } = useTranslation();
  const { id } = useParams({ from: "/boards/$id/reports" });
  const board = useQuery({
    queryKey: ["board", id],
    queryFn: () =>
      unwrap(
        api.GET("/tickvana/api/boards/{id}", { params: { path: { id } } }),
      ),
  });
  const nav = useNav(board.data?.projectKey ?? undefined);
  const scrum = board.data?.kind === "scrum";
  return (
    <Frame
      title={board.data ? `${board.data.name} · ${t("app.reports")}` : ""}
      sections={nav}
    >
      {board.data && (
        <Tabs
          label={t("app.reports")}
          tabs={[
            ...(scrum
              ? [
                  {
                    value: "burndown",
                    label: t("app.burndown"),
                    content: <Burndown id={id} />,
                  },
                  {
                    value: "velocity",
                    label: t("app.velocity"),
                    content: <Velocity id={id} />,
                  },
                ]
              : []),
            { value: "flow", label: t("app.flow"), content: <Flow id={id} /> },
            {
              value: "cycle",
              label: t("app.cycleTime"),
              content: <CycleTime id={id} />,
            },
          ]}
        />
      )}
    </Frame>
  );
}
