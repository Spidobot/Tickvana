// Sample screen for checking tokens and components. Not shipped.
import {
  Bell,
  BookOpen,
  CircleDot,
  Columns3,
  Ellipsis,
  Filter,
  Inbox,
  LayoutList,
  Plus,
  Rocket,
  Settings,
  Timer,
} from "lucide-react";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AppShell,
  Button,
  Card,
  Dialog,
  Field,
  IconButton,
  Input,
  IssueKey,
  Kbd,
  Menu,
  RichTextEditor,
  RichTextView,
  type RichTextEditorProps,
  Select,
  Status,
  Table,
  Tabs,
  Td,
  Textarea,
  Th,
  ToastProvider,
  useToast,
} from "../src/index.js";
import "../src/styles.css";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

type Category = "todo" | "in_progress" | "done";
interface Ticket {
  key: string;
  summary: string;
  who: string;
  status: string;
  category: Category;
  type: string;
  estimate?: string;
}

const tickets: Ticket[] = [
  {
    key: "WIT-214",
    summary: "Etikettendrucker in Halle 2 druckt versetzt",
    who: "Mira Aksoy",
    status: "Offen",
    category: "todo",
    type: "Störung",
    estimate: "2 h",
  },
  {
    key: "WIT-209",
    summary: "VPN-Zugang für neue Auszubildende",
    who: "Jonas Reiter",
    status: "Offen",
    category: "todo",
    type: "Anfrage",
  },
  {
    key: "WIT-198",
    summary: "Lagerscanner auf Firmware 4.2 bringen",
    who: "Mira Aksoy",
    status: "Offen",
    category: "todo",
    type: "Aufgabe",
    estimate: "1 T",
  },
  {
    key: "WIT-211",
    summary: "Backup des Zeichnungsservers läuft in Timeout",
    who: "Tarek Brandl",
    status: "In Arbeit",
    category: "in_progress",
    type: "Störung",
    estimate: "4 h",
  },
  {
    key: "WIT-205",
    summary: "Monitorarm für Arbeitsplatz Konstruktion 3",
    who: "Jonas Reiter",
    status: "Warten auf Lieferung",
    category: "in_progress",
    type: "Anfrage",
  },
  {
    key: "WIT-190",
    summary: "WLAN im Versand bricht bei Schichtwechsel ab",
    who: "Tarek Brandl",
    status: "Erledigt",
    category: "done",
    type: "Störung",
    estimate: "6 h",
  },
  {
    key: "WIT-187",
    summary: "Lizenz CAD-Viewer verlängern",
    who: "Mira Aksoy",
    status: "Erledigt",
    category: "done",
    type: "Aufgabe",
  },
];

const columns: { category: Category; title: string }[] = [
  { category: "todo", title: "Offen" },
  { category: "in_progress", title: "In Arbeit" },
  { category: "done", title: "Erledigt" },
];

const initials = (name: string) =>
  name
    .split(" ")
    .map((part) => part[0])
    .join("");

function TicketCard({ ticket }: { ticket: Ticket }) {
  return (
    <li>
      <a
        href={`#${ticket.key}`}
        className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3 transition-colors hover:border-line-strong"
      >
        <span className="text-base text-fg">{ticket.summary}</span>
        <span className="flex items-center gap-2">
          <IssueKey done={ticket.category === "done"}>{ticket.key}</IssueKey>
          <span className="text-sm text-fg-3">{ticket.type}</span>
          <span className="flex-1" />
          {ticket.estimate && (
            <span className="font-mono text-xs tabular-nums text-fg-3">
              {ticket.estimate}
            </span>
          )}
          <span
            title={ticket.who}
            className="flex size-6 items-center justify-center rounded-full bg-raised text-xs font-medium text-fg-2"
          >
            {initials(ticket.who)}
          </span>
        </span>
      </a>
    </li>
  );
}

function Board() {
  return (
    <div className="grid grid-cols-3 gap-4 max-lg:grid-cols-1">
      {columns.map((column) => {
        const cards = tickets.filter((t) => t.category === column.category);
        return (
          <section
            key={column.category}
            aria-label={column.title}
            className="flex flex-col gap-2 rounded-lg bg-sunken p-2"
          >
            <header className="flex h-8 items-center gap-2 px-2">
              <Status category={column.category}>{column.title}</Status>
              <span className="font-mono text-xs tabular-nums text-fg-3">
                {cards.length}
              </span>
            </header>
            <ul className="flex flex-col gap-2">
              {cards.map((t) => (
                <TicketCard key={t.key} ticket={t} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function List() {
  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <Th className="w-28">Schlüssel</Th>
            <Th>Zusammenfassung</Th>
            <Th className="w-56">Status</Th>
            <Th className="w-40">Bearbeiter</Th>
            <Th className="w-20 text-right">Schätzung</Th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((t) => (
            <tr key={t.key} className="transition-colors hover:bg-raised">
              <Td>
                <IssueKey href={`#${t.key}`} done={t.category === "done"}>
                  {t.key}
                </IssueKey>
              </Td>
              <Td>{t.summary}</Td>
              <Td>
                <Status category={t.category}>{t.status}</Status>
              </Td>
              <Td className="text-fg-2">{t.who}</Td>
              <Td className="text-right font-mono text-sm tabular-nums text-fg-2">
                {t.estimate ?? "–"}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function CreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const [type, setType] = useState<string>();
  const [summary, setSummary] = useState("");
  const [tried, setTried] = useState(false);
  const missing = tried && !summary.trim();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Ticket anlegen"
      description="Projekt Werkstatt-IT"
      closeLabel="Schließen"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Abbrechen</Button>
          <Button
            variant="primary"
            onClick={() => {
              setTried(true);
              if (!summary.trim()) return;
              onOpenChange(false);
              toast({ title: "WIT-215 angelegt", text: summary });
              setSummary("");
              setTried(false);
            }}
          >
            Anlegen
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4 pb-2"
        onSubmit={(e) => e.preventDefault()}
      >
        <Field label="Typ">
          {(props) => (
            <Select
              {...props}
              value={type}
              onValueChange={setType}
              placeholder="Typ wählen"
              options={["Störung", "Anfrage", "Aufgabe"].map((v) => ({
                value: v,
                label: v,
              }))}
            />
          )}
        </Field>
        <Field
          label="Zusammenfassung"
          error={missing ? "Bitte kurz beschreiben, worum es geht" : undefined}
        >
          {(props) => (
            <Input
              {...props}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Beschreibung"
          hint="Was ist passiert, was hast du erwartet"
        >
          {(props) => <Textarea {...props} rows={4} />}
        </Field>
      </form>
    </Dialog>
  );
}

const editorLabels: RichTextEditorProps["labels"] = {
  toolbar: "Formatierung",
  bold: "Fett",
  italic: "Kursiv",
  strike: "Durchgestrichen",
  code: "Code",
  heading2: "Überschrift",
  heading3: "Zwischenüberschrift",
  bulletList: "Liste",
  orderedList: "Nummerierte Liste",
  taskList: "Aufgabenliste",
  quote: "Zitat",
  codeBlock: "Codeblock",
  callout: "Hinweisbox",
  details: "Ausklappbereich",
  table: "Tabelle einfügen",
  link: "Link",
  linkPrompt: "Adresse des Links",
  attach: "Datei anhängen",
  image: "Bild",
  undo: "Rückgängig",
  redo: "Wiederholen",
};

type Doc = NonNullable<RichTextEditorProps["value"]>;
const people = ["Mira Aksoy", "Jonas Reiter", "Tarek Brandl"].map(
  (label, i) => ({ id: `u${i}`, label }),
);

function EditorDemo() {
  const [doc, setDoc] = useState<Doc>({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Übergabe Spätschicht" }],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Der Etikettendrucker in Halle 2 druckt seit dem Rollenwechsel versetzt.",
          },
        ],
      },
    ],
  });
  return (
    <div className="grid grid-cols-2 gap-6 max-lg:grid-cols-1">
      <RichTextEditor
        label="Beschreibung"
        labels={editorLabels}
        value={doc}
        onChange={setDoc}
        searchUsers={async (q) =>
          people.filter((p) => p.label.toLowerCase().includes(q.toLowerCase()))
        }
      />
      <Card className="p-4">
        <RichTextView doc={doc} />
      </Card>
    </div>
  );
}

function App() {
  const [creating, setCreating] = useState(false);
  const toast = useToast();
  return (
    <AppShell
      brand="Tickvana"
      title="Werkstatt-IT"
      labels={{
        navigation: "Hauptnavigation",
        search: "Suchen",
        searchPlaceholder: "Tickets, Seiten, Befehle",
        noResults: "Nichts gefunden",
        skipToContent: "Zum Inhalt springen",
        menu: "Navigation öffnen",
      }}
      sections={[
        {
          items: [
            {
              label: "Mir zugewiesen",
              href: "#mine",
              icon: <Inbox {...icon} />,
              count: 4,
            },
            { label: "Abfragen", href: "#queries", icon: <Filter {...icon} /> },
          ],
        },
        {
          label: "Werkstatt-IT",
          items: [
            {
              label: "Board",
              href: "#board",
              icon: <Columns3 {...icon} />,
              active: true,
            },
            {
              label: "Backlog",
              href: "#backlog",
              icon: <LayoutList {...icon} />,
              count: 23,
            },
            { label: "Sprints", href: "#sprints", icon: <Timer {...icon} /> },
            {
              label: "Versionen",
              href: "#releases",
              icon: <Rocket {...icon} />,
            },
            {
              label: "Einstellungen",
              href: "#settings",
              icon: <Settings {...icon} />,
            },
          ],
        },
        {
          label: "Wissen",
          items: [
            {
              label: "Handbuch Werkstatt-IT",
              href: "#pages",
              icon: <BookOpen {...icon} />,
            },
          ],
        },
      ]}
      commands={[
        {
          id: "create",
          group: "Befehle",
          label: "Ticket anlegen",
          icon: <Plus {...icon} />,
          hint: <Kbd>C</Kbd>,
          onSelect: () => setCreating(true),
        },
        ...tickets.map((t) => ({
          id: t.key,
          group: "Tickets",
          label: t.summary,
          icon: <CircleDot {...icon} />,
          hint: <IssueKey>{t.key}</IssueKey>,
          onSelect: () => toast({ title: t.key, text: t.summary }),
        })),
      ]}
      headerEnd={
        <>
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus {...icon} />
            Anlegen
          </Button>
          <IconButton label="Benachrichtigungen">
            <Bell {...icon} />
          </IconButton>
          <Menu
            trigger={
              <IconButton label="Weitere Aktionen">
                <Ellipsis {...icon} />
              </IconButton>
            }
            items={[
              { label: "Board einrichten", onSelect: () => {} },
              {
                label: "Als CSV exportieren",
                onSelect: () => toast({ title: "Export gestartet" }),
              },
              {
                label: "Fehler zeigen",
                onSelect: () =>
                  toast({
                    title: "Speichern fehlgeschlagen",
                    text: "Verbindung prüfen und erneut versuchen",
                    tone: "negative",
                  }),
              },
            ]}
          />
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <p className="text-fg-2">
          Sprint 31 · endet am 27. November · 7 Tickets
        </p>
        <Tabs
          label="Ansicht"
          tabs={[
            { value: "board", label: "Board", content: <Board /> },
            { value: "list", label: "Liste", content: <List /> },
            { value: "editor", label: "Editor", content: <EditorDemo /> },
          ]}
        />
      </div>
      <CreateDialog open={creating} onOpenChange={setCreating} />
    </AppShell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider closeLabel="Schließen">
      <App />
    </ToastProvider>
  </StrictMode>,
);

// For the accessibility check: `await runAxe()` in the console.
Object.assign(window, {
  runAxe: async () => {
    const axe = await import("axe-core");
    const { violations } = await axe.default.run(document);
    return violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target.join(" ")),
    }));
  },
});
