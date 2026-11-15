// The agent view: a project's queues with their counters and tickets, and
// canned responses for replies.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  Button,
  Card,
  EmptyState,
  Field as FormField,
  Frame,
  IconButton,
  Input,
  IssueKey,
  RichTextEditor,
  Select,
  Status,
  Table,
  Td,
  Th,
  useToast,
  type EditorLabels,
  type RichTextEditorProps,
} from "@tvn/ui";
import { X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, unwrap, useMeta, useProject, useUsers } from "./api.js";
import { useNav } from "./pages.js";
import { SlaCell } from "./sla-ui.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;
type Doc = RichTextEditorProps["value"];

// ponytail: queue paths are built at runtime, which openapi-fetch cannot type; the server validates every body.
type Call = (path: string, init?: object) => Promise<never>;
const call = <T,>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: object,
) =>
  unwrap<T>((api[method] as unknown as Call)(`/tickvana/api${path}`, { body }));

interface Queue {
  id: string;
  name: string;
  queryId: string;
  count: number | null;
}

export function QueuesPage() {
  const { t } = useTranslation();
  const { key } = useParams({ from: "/projects/$key/queues" });
  const project = useProject(key).data;
  const queues = useQuery({
    queryKey: ["queues", key],
    queryFn: () => call<Queue[]>("GET", `/projects/${key}/queues`),
    refetchInterval: 60_000,
  });
  const [selected, setSelected] = useState<string>();
  const current = selected ?? queues.data?.[0]?.id;
  return (
    <Frame
      title={`${project?.name ?? key} · ${t("app.queues.title")}`}
      sections={useNav(key)}
    >
      <div className="grid items-start gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <Card>
          <nav aria-label={t("app.queues.title")}>
            <ul className="flex flex-col p-1">
              {queues.data?.map((q) => (
                <li key={q.id}>
                  <button
                    type="button"
                    aria-current={q.id === current}
                    onClick={() => setSelected(q.id)}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-fg transition-colors hover:bg-raised aria-[current=true]:bg-raised"
                  >
                    <span className="flex-1">{q.name}</span>
                    <span className="text-sm text-fg-2">
                      {q.count === null
                        ? "–"
                        : q.count >= 1000
                          ? "1000+"
                          : q.count}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          {queues.data?.length === 0 && (
            <p className="p-3 text-sm text-fg-3">{t("app.queues.none")}</p>
          )}
          <QueueAdmin projectKey={key} queues={queues.data ?? []} />
        </Card>
        {current ? (
          <QueueIssues id={current} />
        ) : (
          <EmptyState
            title={t("app.queues.none")}
            text={t("app.queues.noneText")}
          />
        )}
      </div>
    </Frame>
  );
}

function QueueIssues({ id }: { id: string }) {
  const { t } = useTranslation();
  const meta = useMeta().data;
  const users = useUsers().data ?? [];
  const issues = useQuery({
    queryKey: ["queue-issues", id],
    queryFn: () =>
      call<
        {
          key: string;
          summary: string;
          statusId: string;
          priorityId: string;
          assigneeId: string | null;
          updatedAt: string;
          slaDueAt: string | null;
          slaBreached: boolean;
        }[]
      >("GET", `/queues/${id}/issues`),
    refetchInterval: 60_000,
  }).data;
  if (issues?.length === 0)
    return <EmptyState title={t("app.queues.empty")} text="" />;
  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <Th className="w-28">{t("app.key")}</Th>
            <Th>{t("app.summary")}</Th>
            <Th className="w-40">{t("app.status")}</Th>
            <Th className="w-28">{t("app.priority")}</Th>
            <Th className="w-40">{t("app.assignee")}</Th>
            <Th className="w-36">{t("app.sla.title")}</Th>
          </tr>
        </thead>
        <tbody>
          {issues?.map((i) => {
            const status = meta?.statuses.find((s) => s.id === i.statusId);
            return (
              <tr key={i.key} className="transition-colors hover:bg-raised">
                <Td>
                  <IssueKey done={status?.category === "done"}>
                    {i.key}
                  </IssueKey>
                </Td>
                <Td>
                  <Link
                    to="/issues/$key"
                    params={{ key: i.key }}
                    className="text-fg underline-offset-4 hover:underline"
                  >
                    {i.summary}
                  </Link>
                </Td>
                <Td>
                  {status && (
                    <Status category={status.category}>{status.name}</Status>
                  )}
                </Td>
                <Td className="text-fg-2">
                  {meta?.priorities.find((p) => p.id === i.priorityId)?.name}
                </Td>
                <Td className="text-fg-2">
                  {i.assigneeId
                    ? users.find((u) => u.id === i.assigneeId)?.displayName
                    : t("app.nobody")}
                </Td>
                <Td>
                  <SlaCell dueAt={i.slaDueAt} breached={i.slaBreached} />
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}

/** Adding and removing queues; the server refuses it to anyone but project administrators. */
function QueueAdmin({
  projectKey,
  queues,
}: {
  projectKey: string;
  queues: Queue[];
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const saved = useQuery({
    queryKey: ["saved-queries"],
    queryFn: () => call<{ id: string; name: string }[]>("GET", "/core/queries"),
  }).data;
  const [form, setForm] = useState({ name: "", queryId: "" });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["queues", projectKey] });
  const fail = (e: Error) => toast({ title: e.message, tone: "negative" });
  return (
    <details className="border-t border-line p-3">
      <summary className="cursor-pointer text-sm text-fg-2">
        {t("app.queues.manage")}
      </summary>
      <ul className="mt-2 flex flex-col gap-1">
        {queues.map((q) => (
          <li key={q.id} className="flex items-center gap-2 text-sm">
            <span className="flex-1 text-fg">{q.name}</span>
            <IconButton
              label={`${t("app.delete")}: ${q.name}`}
              onClick={() =>
                void call("DELETE", `/queues/${q.id}`).then(refresh).catch(fail)
              }
            >
              <X {...icon} />
            </IconButton>
          </li>
        ))}
      </ul>
      <form
        className="mt-2 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void call("POST", `/projects/${projectKey}/queues`, form)
            .then(() => {
              setForm({ name: "", queryId: "" });
              return refresh();
            })
            .catch(fail);
        }}
      >
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
        <Select
          aria-label={t("app.auto.query")}
          placeholder={t("app.auto.query")}
          value={form.queryId || undefined}
          onValueChange={(queryId) => setForm({ ...form, queryId })}
          options={(saved ?? []).map((q) => ({ value: q.id, label: q.name }))}
        />
        <Button type="submit" size="sm" disabled={!form.queryId}>
          {t("app.admin.add")}
        </Button>
      </form>
    </details>
  );
}

/** Picks a canned response for the reply box. */
export function CannedPicker({
  projectKey,
  onPick,
}: {
  projectKey: string;
  onPick: (doc: Doc) => void;
}) {
  const { t } = useTranslation();
  const list = useQuery({
    queryKey: ["canned", projectKey],
    queryFn: () =>
      call<{ id: string; name: string; body: Doc }[]>(
        "GET",
        `/projects/${projectKey}/canned-responses`,
      ),
    retry: false,
  }).data;
  if (!list?.length) return null;
  return (
    <div className="w-48">
      <Select
        aria-label={t("app.queues.canned")}
        placeholder={t("app.queues.canned")}
        value={undefined}
        onValueChange={(id) => onPick(list.find((c) => c.id === id)!.body)}
        options={list.map((c) => ({ value: c.id, label: c.name }))}
      />
    </div>
  );
}

/** Project settings: canned responses of the project. */
export function CannedResponses({ projectKey }: { projectKey: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ["canned", projectKey];
  const list = useQuery({
    queryKey: key,
    queryFn: () =>
      call<{ id: string; name: string; projectKey: string | null }[]>(
        "GET",
        `/projects/${projectKey}/canned-responses`,
      ),
  }).data;
  const [name, setName] = useState("");
  const [body, setBody] = useState<Doc>(null);
  const [round, setRound] = useState(0);
  const fail = (e: Error) => toast({ title: e.message, tone: "negative" });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h3 className="text-base font-medium text-fg">
        {t("app.queues.cannedTitle")}
      </h3>
      <ul className="flex flex-col gap-1">
        {list?.map((c) => (
          <li key={c.id} className="flex items-center gap-2 text-sm">
            <span className="flex-1 text-fg">{c.name}</span>
            {c.projectKey === null && (
              <span className="text-fg-3">{t("app.auto.global")}</span>
            )}
            <IconButton
              label={`${t("app.delete")}: ${c.name}`}
              onClick={() =>
                void call("DELETE", `/canned-responses/${c.id}`)
                  .then(refresh)
                  .catch(fail)
              }
            >
              <X {...icon} />
            </IconButton>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void call("POST", `/projects/${projectKey}/canned-responses`, {
            name,
            body,
          })
            .then(() => {
              setName("");
              setBody(null);
              setRound((n) => n + 1);
              return refresh();
            })
            .catch(fail);
        }}
      >
        <FormField label={t("app.admin.columns.name")}>
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
        <RichTextEditor
          key={round}
          compact
          label={t("app.queues.cannedText")}
          labels={t("editor", { returnObjects: true }) as EditorLabels}
          value={null}
          onChange={setBody}
        />
        <div>
          <Button type="submit" size="sm" disabled={!body}>
            {t("app.admin.add")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
