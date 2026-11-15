import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  Button,
  Card,
  Frame,
  IconButton,
  Input,
  QueryWorkbench,
  Select,
  useApp,
  type NavSection,
} from "@tvn/ui";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  emptyFilter,
  fromSql,
  OPERATORS,
  toSql,
  type Condition,
  type Filter,
  type Operator,
} from "./filter.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;
const NONE = "__none";

/** Conditions on tickets by pointing and clicking. Writes SQL into the editor below. */
function FilterBuilder({
  sql,
  setSql,
}: {
  sql: string;
  setSql: (sql: string) => void;
}) {
  const { t } = useTranslation();
  const { api } = useApp();
  const catalog = useQuery({
    queryKey: ["core", "query-catalog"],
    queryFn: () =>
      api.call<{ tables: { name: string; columns: { name: string }[] }[] }>(
        "GET",
        "/core/query/catalog",
      ),
    staleTime: 60_000,
  });
  const columns =
    catalog.data?.tables
      .find((table) => table.name === "issues")
      ?.columns.map((c) => c.name) ?? [];
  const filter = fromSql(sql);

  if (!filter) {
    return (
      <Card className="flex items-center justify-between gap-4 p-4">
        <p className="text-fg-2">{t("app.filterHandWritten")}</p>
        <Button size="sm" onClick={() => setSql(toSql(emptyFilter))}>
          {t("app.filterReset")}
        </Button>
      </Card>
    );
  }

  const update = (next: Filter) => setSql(toSql(next));
  // Conditions without a value are not written to SQL, so new rows start with one that is always complete.
  const setCondition = (index: number, patch: Partial<Condition>) =>
    update({
      ...filter,
      conditions: filter.conditions.map((c, i) =>
        i === index ? { ...c, ...patch } : c,
      ),
    });
  const columnOptions = columns.map((c) => ({ value: c, label: c }));

  return (
    <Card className="flex flex-col gap-2 p-4">
      {filter.conditions.map((c, i) => (
        <div
          key={i}
          className="grid grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)_32px] items-center gap-2 max-md:grid-cols-1"
        >
          <Select
            aria-label={t("app.filterColumn")}
            value={c.column}
            onValueChange={(column) => setCondition(i, { column })}
            options={columnOptions}
          />
          <Select
            aria-label={t("app.filterOperator")}
            value={c.op}
            onValueChange={(op) => setCondition(i, { op: op as Operator })}
            options={OPERATORS.map((op) => ({
              value: op,
              label: t(`app.op.${op.replaceAll(" ", "_")}`),
            }))}
          />
          {c.op === "is null" || c.op === "is not null" ? (
            <span />
          ) : (
            <Input
              aria-label={t("app.filterValue")}
              value={c.value}
              onChange={(e) => setCondition(i, { value: e.target.value })}
            />
          )}
          <IconButton
            label={t("app.filterRemove")}
            onClick={() =>
              update({
                ...filter,
                conditions: filter.conditions.filter((_, j) => j !== i),
              })
            }
          >
            <X {...icon} />
          </IconButton>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={columns.length === 0}
          onClick={() =>
            update({
              ...filter,
              conditions: [
                ...filter.conditions,
                { column: "status_category", op: "<>", value: "done" },
              ],
            })
          }
        >
          <Plus {...icon} />
          {t("app.filterAdd")}
        </Button>
        <span className="flex-1" />
        <span className="text-sm text-fg-2">{t("app.filterSort")}</span>
        <div className="w-48">
          <Select
            aria-label={t("app.filterSort")}
            value={filter.orderBy || NONE}
            onValueChange={(v) =>
              update({ ...filter, orderBy: v === NONE ? "" : v })
            }
            options={[{ value: NONE, label: t("app.none") }, ...columnOptions]}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-fg-2">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={filter.descending}
            disabled={!filter.orderBy}
            onChange={(e) =>
              update({ ...filter, descending: e.target.checked })
            }
          />
          {t("app.filterDescending")}
        </label>
      </div>
    </Card>
  );
}

export function QueriesPage({ sections }: { sections: NavSection[] }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id } = useParams({ strict: false }) as { id?: string };
  return (
    <Frame title={t("query.title")} sections={sections}>
      <QueryWorkbench
        queryId={id}
        starter={toSql({
          conditions: [{ column: "status_category", op: "<>", value: "done" }],
          orderBy: "updated_at",
          descending: true,
        })}
        onOpen={(next) =>
          void (next
            ? navigate({ to: "/queries/$id", params: { id: next } })
            : navigate({ to: "/queries" }))
        }
        builder={(sql, setSql) => <FilterBuilder sql={sql} setSql={setSql} />}
      />
    </Frame>
  );
}
