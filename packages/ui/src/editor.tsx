// The rich-text editor for ticket descriptions, comments and wiki pages.
// Its schema mirrors packages/core/src/richtext: a test keeps the two in step.
import { mergeAttributes, Node, type Extensions } from "@tiptap/core";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import {
  Details,
  DetailsContent,
  DetailsSummary,
} from "@tiptap/extension-details";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Mention from "@tiptap/extension-mention";
import {
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from "@tiptap/extension-table";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  useEditorState,
  type Editor,
  type NodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useQuery } from "@tanstack/react-query";
import { ISSUE_KEY, renderHtml, type RichDoc } from "@tvn/core/richtext";
import {
  Bold,
  ChevronsUpDown,
  Code,
  Heading2,
  Heading3,
  Info,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Paperclip,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Table as TableIcon,
  Undo2,
} from "lucide-react";
import { common, createLowlight } from "lowlight";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { cx, IssueKey, Status as StatusBadge } from "./components.js";
import { ResultTable, type QueryResult } from "./kit/query.js";

const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

/** An info, success, warning or danger box around blocks. */
const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes: () => ({ kind: { default: "info" } }),
  parseHTML: () => [
    {
      tag: "div[data-callout]",
      getAttrs: (el) => ({ kind: el.getAttribute("data-callout") }),
    },
  ],
  renderHTML: ({ node, HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, {
      role: "note",
      "data-callout": node.attrs.kind,
    }),
    0,
  ],
});

/** A small status lozenge inside text. */
const Status = Node.create({
  name: "status",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes: () => ({
    label: { default: "" },
    category: { default: "todo" },
  }),
  parseHTML: () => [
    {
      tag: "span[data-status]",
      getAttrs: (el) => ({
        category: el.getAttribute("data-status"),
        label: el.textContent,
      }),
    },
  ],
  renderHTML: ({ node }) => [
    "span",
    { "data-status": node.attrs.category },
    node.attrs.label,
  ],
});

/** A date inside text, stored as YYYY-MM-DD. */
const DateNode = Node.create({
  name: "date",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes: () => ({ value: { default: null } }),
  parseHTML: () => [
    {
      tag: "time[datetime]",
      getAttrs: (el) => ({ value: el.getAttribute("datetime") }),
    },
  ],
  renderHTML: ({ node }) => [
    "time",
    { datetime: node.attrs.value },
    node.attrs.value ?? "",
  ],
});

/** A file that is not an image: a link to the attachment. */
const Attachment = Node.create({
  name: "attachment",
  group: "block",
  atom: true,
  addAttributes: () => ({
    href: { default: null },
    name: { default: "" },
    size: { default: 0 },
  }),
  parseHTML: () => [{ tag: "p[data-attachment]" }],
  renderHTML: ({ node }) => [
    "p",
    { "data-attachment": "" },
    ["a", { href: node.attrs.href }, node.attrs.name],
  ],
});

/**
 * How the page blocks look. The app that shows pages (Nuvenna) fills them in;
 * elsewhere they show a quiet placeholder.
 */
export interface PageBlocks {
  toc?: () => ReactNode;
  childPages?: () => ReactNode;
  pageInclude?: (pageId: string, setPageId: (id: string) => void) => ReactNode;
}
export const PageBlocksContext = createContext<PageBlocks>({});

function PageBlockView({ node, updateAttributes }: NodeViewProps) {
  const blocks = useContext(PageBlocksContext);
  const content =
    node.type.name === "toc"
      ? blocks.toc?.()
      : node.type.name === "childPages"
        ? blocks.childPages?.()
        : blocks.pageInclude?.(node.attrs.pageId as string, (pageId) =>
            updateAttributes({ pageId }),
          );
  return (
    <NodeViewWrapper
      className="my-3 rounded-md border border-line bg-sunken p-3"
      data-block={node.type.name}
      contentEditable={false}
    >
      {content ?? <span className="text-sm text-fg-3">{node.type.name}</span>}
    </NodeViewWrapper>
  );
}

const pageBlock = (
  name: string,
  attrs: Record<string, { default: unknown }> = {},
) =>
  Node.create({
    name,
    group: "block",
    atom: true,
    selectable: true,
    addAttributes: () => attrs,
    parseHTML: () => [{ tag: `div[data-block="${name}"]` }],
    renderHTML: ({ HTMLAttributes }) => [
      "div",
      mergeAttributes(HTMLAttributes, { "data-block": name }),
    ],
    addNodeView: () => ReactNodeViewRenderer(PageBlockView),
  });
const Toc = pageBlock("toc");
const ChildPages = pageBlock("childPages");
const PageInclude = pageBlock("pageInclude", { pageId: { default: "" } });

/** "IT-42", "it-42" or a link to the ticket: the key, or null. */
export function issueKeyFrom(input: string): string | null {
  const key = (
    input.trim().match(/([A-Za-z][A-Za-z0-9]{1,9}-\d+)\/?$/)?.[1] ?? ""
  ).toUpperCase();
  return ISSUE_KEY.test(key) ? key : null;
}

/**
 * A ticket in a page. Title and status come from Tickvana with the reader's own
 * cookie; without Tickvana or without the right to see it, only the key shows.
 */
export function IssueCard({ issueKey: key }: { issueKey: string }) {
  const get = async <T,>(path: string): Promise<T> => {
    const res = await fetch(`/tickvana/api${path}`, {
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as T;
  };
  const issue = useQuery({
    queryKey: ["issue-block", key],
    enabled: !!key,
    retry: false,
    staleTime: 60_000,
    queryFn: () =>
      get<{ fields: { summary?: string; status?: string } }>(
        `/issues/${encodeURIComponent(key)}`,
      ),
  }).data;
  const statuses = useQuery({
    queryKey: ["issue-block-statuses"],
    enabled: !!issue,
    retry: false,
    staleTime: 300_000,
    queryFn: () =>
      get<{ id: string; name: string; category: string }[]>("/statuses"),
  }).data;
  const status = statuses?.find((x) => x.id === issue?.fields.status);
  return (
    <div className="flex items-center gap-3 rounded-md border border-line px-3 py-2 text-sm">
      <IssueKey
        href={`/tickvana/issues/${key}`}
        done={status?.category === "done"}
      >
        {key}
      </IssueKey>
      <span className="flex-1 truncate text-fg">{issue?.fields.summary}</span>
      {status && (
        <StatusBadge
          category={status.category as "todo" | "in_progress" | "done"}
        >
          {status.name}
        </StatusBadge>
      )}
    </div>
  );
}
function IssueBlockView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper
      className="my-2"
      data-block="issue"
      contentEditable={false}
    >
      <IssueCard issueKey={node.attrs.key as string} />
    </NodeViewWrapper>
  );
}
export interface QueryBlockAttrs {
  app: "tickvana" | "nuvenna";
  queryId: string;
  sql: string;
  view: "table" | "number" | "bar";
}

/** Bars for the first text column against the first number column. */
function Bars({ result }: { result: QueryResult }) {
  const sample = result.rows[0] ?? {};
  // Counts may arrive as text (bigint on PostgreSQL): any numeric value will do.
  const numeric = (v: unknown) =>
    v !== null && v !== "" && Number.isFinite(Number(v));
  const value = [...result.columns].reverse().find((c) => numeric(sample[c]));
  const label = result.columns.find((c) => c !== value) ?? value;
  if (!value || !label) return <ResultTable result={result} />;
  const max = Math.max(1, ...result.rows.map((r) => Number(r[value]) || 0));
  return (
    <ul className="flex flex-col gap-1 p-3 text-sm">
      {result.rows.slice(0, 50).map((r, i) => (
        <li
          key={i}
          className="grid grid-cols-[10rem_1fr_4rem] items-center gap-2"
        >
          <span className="truncate text-fg-2">{String(r[label] ?? "")}</span>
          <span className="h-3 rounded-sm bg-raised">
            <span
              className="block h-full rounded-sm bg-accent"
              style={{ width: `${((Number(r[value]) || 0) / max) * 100}%` }}
            />
          </span>
          <span className="text-right font-mono tabular-nums text-fg">
            {String(r[value])}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A query in a page, run by the app that owns its tables with the reader's
 * cookie: every reader sees only what they may see.
 */
export function QueryView({ app, queryId, sql, view }: QueryBlockAttrs) {
  const result = useQuery({
    queryKey: ["query-block", app, queryId, sql],
    enabled: !!(queryId || sql),
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch(
        queryId
          ? `/${app}/api/core/queries/${encodeURIComponent(queryId)}/run`
          : `/${app}/api/core/query/run`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(queryId ? { limit: 200 } : { sql, limit: 200 }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        (QueryResult & { error?: { message: string } }) | null;
      if (!res.ok) throw new Error(body?.error?.message ?? String(res.status));
      return body as QueryResult;
    },
  });
  if (result.isError)
    return <p className="p-3 text-sm text-fg-3">{result.error.message}</p>;
  if (!result.data) return <p className="p-3 text-sm text-fg-3">…</p>;
  if (view === "number") {
    const first = result.data.rows[0];
    const c = result.data.columns[0];
    return (
      <p className="p-3 text-2xl font-medium tabular-nums text-fg">
        {first && c ? String(first[c] ?? "") : "–"}
      </p>
    );
  }
  return view === "bar" ? (
    <Bars result={result.data} />
  ) : (
    <ResultTable result={result.data} />
  );
}
function QueryBlockView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper
      className="my-3 overflow-x-auto rounded-md border border-line"
      data-block="query"
      contentEditable={false}
    >
      <QueryView {...(node.attrs as QueryBlockAttrs)} />
    </NodeViewWrapper>
  );
}
const QueryBlock = Node.create({
  name: "query",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes: () => ({
    app: { default: "tickvana" },
    queryId: { default: "" },
    sql: { default: "" },
    view: { default: "table" },
  }),
  parseHTML: () => [{ tag: 'div[data-block="query"]' }],
  renderHTML: ({ HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, { "data-block": "query" }),
  ],
  addNodeView: () => ReactNodeViewRenderer(QueryBlockView),
});

const IssueBlock = Node.create({
  name: "issue",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes: () => ({ key: { default: "" } }),
  parseHTML: () => [
    {
      tag: "p[data-issue]",
      getAttrs: (el) => ({ key: (el as HTMLElement).dataset.issue ?? "" }),
    },
  ],
  renderHTML: ({ node }) => [
    "p",
    { "data-issue": node.attrs.key as string },
    node.attrs.key as string,
  ],
  addNodeView: () => ReactNodeViewRenderer(IssueBlockView),
});

export interface MentionCandidate {
  id: string;
  label: string;
}

/** The popup under "@…": a plain listbox, no framework inside the editor's event loop. */
function mentionSuggestion(
  search: (query: string) => Promise<MentionCandidate[]>,
) {
  return {
    items: ({ query }: { query: string }) => search(query).catch(() => []),
    render: () => {
      let box: HTMLDivElement | undefined;
      let items: MentionCandidate[] = [];
      let selected = 0;
      let pick: (item: MentionCandidate) => void = () => {};

      const draw = () => {
        if (!box) return;
        box.replaceChildren(
          ...items.map((entry, i) => {
            const option = document.createElement("div");
            option.setAttribute("role", "option");
            option.setAttribute("aria-selected", String(i === selected));
            option.className = "tw-mention-option";
            option.textContent = entry.label;
            option.addEventListener("mousedown", (e) => {
              e.preventDefault();
              pick(entry);
            });
            return option;
          }),
        );
        box.hidden = items.length === 0;
      };
      const update = (props: {
        items: MentionCandidate[];
        command: typeof pick;
        clientRect?: (() => DOMRect | null) | null;
      }) => {
        items = props.items;
        pick = props.command;
        selected = Math.min(selected, Math.max(0, items.length - 1));
        const rect = props.clientRect?.();
        if (box && rect) {
          box.style.left = `${rect.left}px`;
          box.style.top = `${rect.bottom + 4}px`;
        }
        draw();
      };

      return {
        onStart: (props: Parameters<typeof update>[0]) => {
          box = document.createElement("div");
          box.setAttribute("role", "listbox");
          box.className = "tw-mention-list";
          document.body.appendChild(box);
          update(props);
        },
        onUpdate: update,
        onKeyDown: ({ event }: { event: KeyboardEvent }) => {
          if (items.length === 0) return false;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            selected =
              (selected + (event.key === "ArrowDown" ? 1 : items.length - 1)) %
              items.length;
            draw();
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            pick(items[selected]!);
            return true;
          }
          return false;
        },
        onExit: () => {
          box?.remove();
          box = undefined;
        },
      };
    },
  };
}

export interface EditorSchemaOptions {
  /** Finds people for @mentions. Without it, mentions are display-only. */
  searchUsers?: (query: string) => Promise<MentionCandidate[]>;
  /** True when a collaboration extension brings its own undo history. */
  collaborative?: boolean;
}

/** All extensions of the fixed schema. Collaboration adds to this list, it never replaces it. */
export function editorExtensions({
  searchUsers,
  collaborative,
}: EditorSchemaOptions = {}): Extensions {
  return [
    StarterKit.configure({
      codeBlock: false,
      heading: { levels: [1, 2, 3, 4] },
      link: { openOnClick: false, protocols: ["http", "https", "mailto"] },
      undoRedo: collaborative ? false : {},
    }),
    CodeBlockLowlight.configure({ lowlight: createLowlight(common) }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Image.configure({ allowBase64: false }),
    Details,
    DetailsSummary,
    DetailsContent,
    Mention.configure({
      renderHTML: ({ node }) => [
        "span",
        { "data-mention": node.attrs.id },
        `@${node.attrs.label}`,
      ],
      ...(searchUsers && { suggestion: mentionSuggestion(searchUsers) }),
    }),
    Callout,
    Status,
    DateNode,
    Attachment,
    Toc,
    ChildPages,
    PageInclude,
    IssueBlock,
    QueryBlock,
  ];
}

export interface UploadedFile {
  /** Path of the stored file on this installation. */
  href: string;
  name: string;
  size: number;
  isImage: boolean;
}

/** Accessible names of the toolbar buttons. */
export interface EditorLabels {
  toolbar: string;
  bold: string;
  italic: string;
  strike: string;
  code: string;
  heading2: string;
  heading3: string;
  bulletList: string;
  orderedList: string;
  taskList: string;
  quote: string;
  codeBlock: string;
  callout: string;
  details: string;
  table: string;
  link: string;
  linkPrompt: string;
  attach: string;
  image: string;
  undo: string;
  redo: string;
}

function Tool({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      // Keep the selection in the document while clicking the toolbar.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cx(
        "inline-flex size-8 items-center justify-center rounded-md transition-colors disabled:opacity-40",
        active
          ? "bg-raised text-fg"
          : "text-fg-2 hover:bg-raised hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function Toolbar({
  editor,
  labels,
  onUpload,
  collaborative,
}: {
  editor: Editor;
  labels: EditorLabels;
  onUpload?: RichTextEditorProps["onUpload"];
  collaborative?: boolean;
}) {
  const file = useRef<HTMLInputElement>(null);
  // Re-render the toolbar when the selection moves, not on every keystroke elsewhere.
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      taskList: e.isActive("taskList"),
      quote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      callout: e.isActive("callout"),
      details: e.isActive("details"),
      link: e.isActive("link"),
    }),
  });
  const chain = () => editor.chain().focus();
  const sep = <span aria-hidden className="mx-1 h-5 w-px bg-line" />;

  const setLink = () => {
    // ponytail: native prompt. Replace with a popover when link editing needs more than a URL.
    const href = window.prompt(
      labels.linkPrompt,
      editor.getAttributes("link").href ?? "https://",
    );
    if (href === null) return;
    if (href.trim() === "") chain().unsetLink().run();
    else chain().extendMarkRange("link").setLink({ href: href.trim() }).run();
  };

  const upload = async (files: FileList | null) => {
    for (const f of files ?? []) {
      const stored = await onUpload!(f);
      if (stored.isImage)
        chain().setImage({ src: stored.href, alt: stored.name }).run();
      else
        chain()
          .insertContent({
            type: "attachment",
            attrs: { href: stored.href, name: stored.name, size: stored.size },
          })
          .run();
    }
  };

  return (
    <div
      role="toolbar"
      aria-label={labels.toolbar}
      className="flex flex-wrap items-center gap-0.5 border-b border-line p-1"
    >
      <Tool
        label={labels.bold}
        active={on.bold}
        onClick={() => chain().toggleBold().run()}
      >
        <Bold {...icon} />
      </Tool>
      <Tool
        label={labels.italic}
        active={on.italic}
        onClick={() => chain().toggleItalic().run()}
      >
        <Italic {...icon} />
      </Tool>
      <Tool
        label={labels.strike}
        active={on.strike}
        onClick={() => chain().toggleStrike().run()}
      >
        <Strikethrough {...icon} />
      </Tool>
      <Tool
        label={labels.code}
        active={on.code}
        onClick={() => chain().toggleCode().run()}
      >
        <Code {...icon} />
      </Tool>
      <Tool label={labels.link} active={on.link} onClick={setLink}>
        <LinkIcon {...icon} />
      </Tool>
      {sep}
      <Tool
        label={labels.heading2}
        active={on.h2}
        onClick={() => chain().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 {...icon} />
      </Tool>
      <Tool
        label={labels.heading3}
        active={on.h3}
        onClick={() => chain().toggleHeading({ level: 3 }).run()}
      >
        <Heading3 {...icon} />
      </Tool>
      <Tool
        label={labels.bulletList}
        active={on.bulletList}
        onClick={() => chain().toggleBulletList().run()}
      >
        <List {...icon} />
      </Tool>
      <Tool
        label={labels.orderedList}
        active={on.orderedList}
        onClick={() => chain().toggleOrderedList().run()}
      >
        <ListOrdered {...icon} />
      </Tool>
      <Tool
        label={labels.taskList}
        active={on.taskList}
        onClick={() => chain().toggleTaskList().run()}
      >
        <ListChecks {...icon} />
      </Tool>
      {sep}
      <Tool
        label={labels.quote}
        active={on.quote}
        onClick={() => chain().toggleBlockquote().run()}
      >
        <Quote {...icon} />
      </Tool>
      <Tool
        label={labels.codeBlock}
        active={on.codeBlock}
        onClick={() => chain().toggleCodeBlock().run()}
      >
        <SquareCode {...icon} />
      </Tool>
      <Tool
        label={labels.callout}
        active={on.callout}
        onClick={() =>
          on.callout
            ? chain().lift("callout").run()
            : chain().wrapIn("callout").run()
        }
      >
        <Info {...icon} />
      </Tool>
      <Tool
        label={labels.details}
        active={on.details}
        onClick={() =>
          on.details ? chain().unsetDetails().run() : chain().setDetails().run()
        }
      >
        <ChevronsUpDown {...icon} />
      </Tool>
      <Tool
        label={labels.table}
        onClick={() =>
          chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
        }
      >
        <TableIcon {...icon} />
      </Tool>
      {onUpload && (
        <>
          <Tool label={labels.attach} onClick={() => file.current?.click()}>
            <Paperclip {...icon} />
          </Tool>
          <input
            ref={file}
            type="file"
            multiple
            hidden
            aria-label={labels.attach}
            onChange={(e) =>
              void upload(e.target.files).finally(() => (e.target.value = ""))
            }
          />
        </>
      )}
      {!collaborative && (
        <>
          {sep}
          <Tool label={labels.undo} onClick={() => chain().undo().run()}>
            <Undo2 {...icon} />
          </Tool>
          <Tool label={labels.redo} onClick={() => chain().redo().run()}>
            <Redo2 {...icon} />
          </Tool>
        </>
      )}
    </div>
  );
}

export interface RichTextEditorProps extends EditorSchemaOptions {
  /** Initial document. Later changes come from the editor itself (or from collaboration). */
  value: RichDoc | null;
  onChange?: (doc: RichDoc) => void;
  labels: EditorLabels;
  /** Accessible name of the text area, e.g. "Description". */
  label: string;
  /** Stores a pasted, dropped or picked file and says where it lives. */
  onUpload?: (file: File) => Promise<UploadedFile>;
  /** Extra extensions, e.g. Yjs collaboration and cursors. */
  extensions?: Extensions;
  /** Smaller minimum height, for comments. */
  compact?: boolean;
  /** false: a reader's view of the same document, without toolbar. */
  editable?: boolean;
  /** Without border and toolbar padding: the page itself is the editor. */
  bare?: boolean;
  /** Gets the editor once it exists, e.g. to read headings for a table of contents. */
  onReady?: (editor: Editor) => void;
}

export function RichTextEditor({
  value,
  onChange,
  labels,
  label,
  onUpload,
  extensions,
  compact,
  searchUsers,
  collaborative,
  editable = true,
  bare,
  onReady,
}: RichTextEditorProps) {
  const all = useMemo(
    () => [
      ...editorExtensions({ searchUsers, collaborative }),
      ...(extensions ?? []),
    ],
    // The schema is fixed for the lifetime of one editor.
    [],
  );
  const upload = useRef(onUpload);
  useEffect(() => {
    upload.current = onUpload;
  }, [onUpload]);

  const editor = useEditor({
    extensions: all,
    editable,
    // With collaboration the content comes from the shared document.
    content: collaborative ? undefined : (value ?? undefined),
    editorProps: {
      attributes: {
        class: cx(
          "tw-prose outline-none p-3",
          compact ? "min-h-20" : "min-h-40",
        ),
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
      },
      handlePaste: (_view, event) => insertFiles(event.clipboardData?.files),
      handleDrop: (_view, event) =>
        insertFiles((event as DragEvent).dataTransfer?.files),
    },
    onUpdate: ({ editor: e }) => onChange?.(e.getJSON() as RichDoc),
  });

  function insertFiles(files: FileList | null | undefined): boolean {
    if (!upload.current || !files || files.length === 0) return false;
    void (async () => {
      for (const f of files) {
        const stored = await upload.current!(f);
        if (stored.isImage)
          editor
            ?.chain()
            .focus()
            .setImage({ src: stored.href, alt: stored.name })
            .run();
        else
          editor
            ?.chain()
            .focus()
            .insertContent({
              type: "attachment",
              attrs: {
                href: stored.href,
                name: stored.name,
                size: stored.size,
              },
            })
            .run();
      }
    })();
    return true;
  }

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);
  useEffect(() => {
    if (editor) onReady?.(editor);
    // Once per editor.
  }, [editor]);

  if (!editor) return null;
  return (
    <div
      className={
        bare
          ? "flex flex-col gap-2"
          : "rounded-md border border-line-strong bg-surface transition-colors focus-within:border-accent-ink"
      }
    >
      {editable && (
        <Toolbar
          editor={editor}
          labels={labels}
          onUpload={onUpload}
          collaborative={collaborative}
        />
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

/**
 * Shows a stored document. Goes through the same renderer as mails and
 * exports, which escapes every value, so the markup is safe to insert.
 */
export function RichTextView({
  doc,
  className,
}: {
  doc: RichDoc;
  className?: string;
}) {
  const html = useMemo(() => renderHtml(doc), [doc]);
  return (
    <div
      className={cx("tw-prose", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
