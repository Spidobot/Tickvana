// SLA in the interface: clocks on a ticket, the time left in queues,
// policies in the project settings and calendars in the master data.
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
import { X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, unwrap, useMeta } from "./api.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

// ponytail: SLA paths take runtime parts openapi-fetch cannot type; the server validates every body.
type Call = (path: string, init?: object) => Promise<never>;
const call = <T,>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: object,
) =>
  unwrap<T>((api[method] as unknown as Call)(`/tickvana/api${path}`, { body }));

/** "3 h 20 min", "45 min". */
export function useDuration() {
  const { t } = useTranslation();
  return (ms: number) => {
    const total = Math.round(Math.abs(ms) / 60_000);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h ? t("app.sla.hm", { h, m }) : t("app.sla.m", { m });
  };
}

interface Clock {
  policy: string;
  dueAt: string;
  stoppedAt: string | null;
  paused: boolean;
  breached: boolean;
  remainingMs: number | null;
}

/** The ticket's SLA clocks, for its sidebar. Hidden when there are none. */
export function SlaClocks({ issueKey }: { issueKey: string }) {
  const { t } = useTranslation();
  const duration = useDuration();
  const clocks = useQuery({
    queryKey: ["issue", issueKey, "sla"],
    queryFn: () => call<Clock[]>("GET", `/issues/${issueKey}/sla`),
    refetchInterval: 60_000,
    retry: false,
  }).data;
  if (!clocks?.length) return null;
  return (
    <section
      aria-label={t("app.sla.title")}
      className="flex flex-col gap-2 border-t border-line pt-3"
    >
      {clocks.map((c, i) => {
        const late =
          c.breached || (c.remainingMs !== null && c.remainingMs < 0);
        const text = c.stoppedAt
          ? c.breached
            ? t("app.sla.missed")
            : t("app.sla.met")
          : c.paused
            ? t("app.sla.paused", { left: duration(c.remainingMs ?? 0) })
            : late
              ? t("app.sla.overdue", { by: duration(c.remainingMs ?? 0) })
              : t("app.sla.left", { left: duration(c.remainingMs ?? 0) });
        return (
          <div
            key={i}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <span className="text-fg-2">{c.policy}</span>
            <span
              className={
                late
                  ? "font-medium text-negative"
                  : c.stoppedAt
                    ? "text-positive"
                    : "text-fg"
              }
            >
              {text}
            </span>
          </div>
        );
      })}
    </section>
  );
}

/** Time to the due time, for a queue row. */
export function SlaCell({
  dueAt,
  breached,
}: {
  dueAt: string | null;
  breached: boolean;
}) {
  const { t } = useTranslation();
  const duration = useDuration();
  if (!dueAt)
    return breached ? (
      <span className="text-negative">{t("app.sla.missed")}</span>
    ) : (
      <span className="text-fg-3">–</span>
    );
  // Wall-clock time to the due instant; the ticket page shows working time.
  const left = Date.parse(dueAt) - Date.now();
  return left < 0 || breached ? (
    <span className="font-medium text-negative">
      {t("app.sla.overdue", { by: duration(left) })}
    </span>
  ) : (
    <span className="text-fg">{duration(left)}</span>
  );
}

// --- Policies -------------------------------------------------------------------------

interface Goal {
  priorityIds: string[];
  requestTypeIds: string[];
  minutes: number;
}
interface Policy {
  id?: string;
  name: string;
  calendarId: string;
  start: { events: string[] };
  pause: { statusIds: string[] };
  stop: { events: string[]; statusIds: string[]; statusCategories: string[] };
  goals: Goal[];
}

export function SlaPolicies({ projectKey }: { projectKey: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const meta = useMeta().data;
  const key = ["sla-policies", projectKey];
  const policies = useQuery({
    queryKey: key,
    queryFn: () =>
      call<Policy[]>("GET", `/projects/${projectKey}/sla-policies`),
  }).data;
  const calendars = useQuery({
    queryKey: ["calendars"],
    queryFn: () => call<{ id: string; name: string }[]>("GET", "/calendars"),
  }).data;
  const blank = (): Policy => ({
    name: "",
    calendarId: calendars?.[0]?.id ?? "",
    start: { events: ["issue.created"] },
    pause: { statusIds: [] },
    stop: {
      events: ["first_response"],
      statusIds: [],
      statusCategories: ["done"],
    },
    goals: [{ priorityIds: [], requestTypeIds: [], minutes: 480 }],
  });
  const [form, setForm] = useState<Policy | null>(null);
  const fail = (e: Error) => toast({ title: e.message, tone: "negative" });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h3 className="text-base font-medium text-fg">{t("app.sla.policies")}</h3>
      {calendars?.length === 0 && (
        <p className="text-sm text-fg-2">{t("app.sla.noCalendar")}</p>
      )}
      <ul className="flex flex-col gap-1">
        {policies?.map((p) => (
          <li key={p.id} className="flex items-center gap-2">
            <button
              type="button"
              className="flex-1 text-left text-fg underline-offset-4 hover:underline"
              onClick={() => setForm(p)}
            >
              {p.name}
            </button>
            <IconButton
              label={`${t("app.delete")}: ${p.name}`}
              onClick={() =>
                void call("DELETE", `/sla-policies/${p.id}`)
                  .then(refresh)
                  .catch(fail)
              }
            >
              <X {...icon} />
            </IconButton>
          </li>
        ))}
      </ul>
      {!form ? (
        <div>
          <Button
            size="sm"
            disabled={!calendars?.length}
            onClick={() => setForm(blank())}
          >
            {t("app.sla.newPolicy")}
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3 border-t border-line pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            const { id, ...body } = form;
            void (
              id
                ? call("PUT", `/sla-policies/${id}`, body)
                : call("POST", `/projects/${projectKey}/sla-policies`, body)
            )
              .then(() => {
                setForm(null);
                return refresh();
              })
              .catch(fail);
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-64">
              <FormField label={t("app.admin.columns.name")}>
                {(p) => (
                  <Input
                    {...p}
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                )}
              </FormField>
            </div>
            <div className="w-56">
              <Select
                aria-label={t("app.sla.calendar")}
                value={form.calendarId}
                onValueChange={(calendarId) => setForm({ ...form, calendarId })}
                options={(calendars ?? []).map((c) => ({
                  value: c.id,
                  label: `${t("app.sla.calendar")}: ${c.name}`,
                }))}
              />
            </div>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-fg">
              {t("app.sla.goals")}
            </legend>
            {form.goals.map((g, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <div className="w-44">
                  <Select
                    aria-label={t("app.priority")}
                    value={g.priorityIds[0] ?? "-"}
                    onValueChange={(v) =>
                      setForm({
                        ...form,
                        goals: form.goals.map((x, j) =>
                          j === i
                            ? { ...x, priorityIds: v === "-" ? [] : [v] }
                            : x,
                        ),
                      })
                    }
                    options={[
                      { value: "-", label: t("app.sla.anyPriority") },
                      ...(meta?.priorities ?? []).map((p) => ({
                        value: p.id,
                        label: p.name,
                      })),
                    ]}
                  />
                </div>
                <div className="w-28">
                  <Input
                    type="number"
                    min={0.25}
                    step={0.25}
                    aria-label={t("app.sla.hours")}
                    value={g.minutes / 60}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        goals: form.goals.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                minutes: Math.max(
                                  1,
                                  Math.round(Number(e.target.value) * 60),
                                ),
                              }
                            : x,
                        ),
                      })
                    }
                  />
                </div>
                <span className="text-sm text-fg-2">
                  {t("app.sla.workingHours")}
                </span>
                {form.goals.length > 1 && (
                  <IconButton
                    label={t("app.admin.fields.remove")}
                    onClick={() =>
                      setForm({
                        ...form,
                        goals: form.goals.filter((_, j) => j !== i),
                      })
                    }
                  >
                    <X {...icon} />
                  </IconButton>
                )}
              </div>
            ))}
            <p className="text-sm text-fg-3">{t("app.sla.goalsHint")}</p>
            <div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setForm({
                    ...form,
                    goals: [
                      { priorityIds: [], requestTypeIds: [], minutes: 240 },
                      ...form.goals,
                    ],
                  })
                }
              >
                {t("app.sla.addGoal")}
              </Button>
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium text-fg">
              {t("app.sla.pauseIn")}
            </legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {(meta?.statuses ?? []).map((s) => (
                <label
                  key={s.id}
                  className="flex items-center gap-2 text-sm text-fg"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-accent"
                    checked={form.pause.statusIds.includes(s.id)}
                    onChange={() =>
                      setForm({
                        ...form,
                        pause: {
                          statusIds: toggle(form.pause.statusIds, s.id),
                        },
                      })
                    }
                  />
                  {s.name}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium text-fg">
              {t("app.sla.stopWhen")}
            </legend>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={form.stop.events.includes("first_response")}
                onChange={() =>
                  setForm({
                    ...form,
                    stop: {
                      ...form.stop,
                      events: toggle(form.stop.events, "first_response"),
                    },
                  })
                }
              />
              {t("app.sla.firstResponse")}
            </label>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={form.stop.statusCategories.includes("done")}
                onChange={() =>
                  setForm({
                    ...form,
                    stop: {
                      ...form.stop,
                      statusCategories: toggle(
                        form.stop.statusCategories,
                        "done",
                      ),
                    },
                  })
                }
              />
              {t("app.sla.resolved")}
            </label>
          </fieldset>
          <div className="flex gap-2">
            <Button type="submit" variant="primary">
              {t("app.save")}
            </Button>
            <Button onClick={() => setForm(null)}>{t("app.cancel")}</Button>
          </div>
        </form>
      )}
    </Card>
  );
}

// --- Calendars ------------------------------------------------------------------------

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
interface CalendarData {
  id?: string;
  name: string;
  timezone: string;
  hours: Partial<Record<(typeof DAYS)[number], [string, string][]>>;
  holidays: string[];
}

export function CalendarsAdmin() {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const calendars = useQuery({
    queryKey: ["calendars"],
    queryFn: () => call<CalendarData[]>("GET", "/calendars"),
  }).data;
  const week: [string, string][] = [["09:00", "17:00"]];
  const blank: CalendarData = {
    name: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hours: { mon: week, tue: week, wed: week, thu: week, fri: week },
    holidays: [],
  };
  const [form, setForm] = useState<CalendarData>(blank);
  const [holidays, setHolidays] = useState("");
  const fail = (e: Error) => toast({ title: e.message, tone: "negative" });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["calendars"] });
  const edit = (c: CalendarData) => {
    setForm(c);
    setHolidays(c.holidays.join("\n"));
  };
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <ul className="divide-y divide-line">
          {calendars?.map((c) => (
            <li key={c.id} className="flex items-center gap-2 px-4 py-2">
              <button
                type="button"
                className="flex-1 text-left text-fg underline-offset-4 hover:underline"
                onClick={() => edit(c)}
              >
                {c.name}
              </button>
              <span className="text-sm text-fg-3">{c.timezone}</span>
              <IconButton
                label={`${t("app.delete")}: ${c.name}`}
                onClick={() =>
                  void call("DELETE", `/admin/calendars/${c.id}`)
                    .then(refresh)
                    .catch(fail)
                }
              >
                <X {...icon} />
              </IconButton>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="p-4">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const { id, ...rest } = form;
            const body = {
              ...rest,
              holidays: holidays.split(/\s+/).filter(Boolean),
            };
            void (
              id
                ? call("PUT", `/admin/calendars/${id}`, body)
                : call("POST", "/admin/calendars", body)
            )
              .then(() => {
                setForm(blank);
                setHolidays("");
                return refresh();
              })
              .catch(fail);
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-56">
              <FormField label={t("app.admin.columns.name")}>
                {(p) => (
                  <Input
                    {...p}
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                )}
              </FormField>
            </div>
            <div className="w-56">
              <FormField label={t("app.sla.timezone")}>
                {(p) => (
                  <Input
                    {...p}
                    required
                    value={form.timezone}
                    onChange={(e) =>
                      setForm({ ...form, timezone: e.target.value })
                    }
                  />
                )}
              </FormField>
            </div>
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium text-fg">
              {t("app.sla.workingTime")}
            </legend>
            {DAYS.map((d) => {
              const span = form.hours[d]?.[0];
              const set = (v: [string, string] | null) =>
                setForm({
                  ...form,
                  hours: { ...form.hours, [d]: v ? [v] : [] },
                });
              return (
                <div key={d} className="flex items-center gap-2">
                  <label className="flex w-32 items-center gap-2 text-sm text-fg">
                    <input
                      type="checkbox"
                      className="size-4 accent-accent"
                      checked={!!span}
                      onChange={(e) =>
                        set(e.target.checked ? ["09:00", "17:00"] : null)
                      }
                    />
                    {t(`app.sla.days.${d}`)}
                  </label>
                  {span && (
                    <>
                      <div className="w-28">
                        <Input
                          type="time"
                          aria-label={`${t(`app.sla.days.${d}`)} ${t("app.sla.from")}`}
                          value={span[0]}
                          onChange={(e) => set([e.target.value, span[1]])}
                        />
                      </div>
                      <span className="text-fg-3">–</span>
                      <div className="w-28">
                        <Input
                          type="time"
                          aria-label={`${t(`app.sla.days.${d}`)} ${t("app.sla.to")}`}
                          value={span[1]}
                          onChange={(e) => set([span[0], e.target.value])}
                        />
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </fieldset>
          <FormField
            label={t("app.sla.holidays")}
            hint={t("app.sla.holidaysHint")}
          >
            {(p) => (
              <Textarea
                {...p}
                rows={3}
                value={holidays}
                onChange={(e) => setHolidays(e.target.value)}
              />
            )}
          </FormField>
          <div className="flex gap-2">
            <Button type="submit" variant="primary">
              {form.id ? t("app.save") : t("app.admin.add")}
            </Button>
            {form.id && (
              <Button onClick={() => edit(blank)}>{t("app.cancel")}</Button>
            )}
          </div>
        </form>
      </Card>
    </div>
  );
}
