// Rich text is stored as Tiptap JSON and never as HTML (CONCEPT.md §10).
// This file is the fixed schema: what a document may contain, how it becomes
// HTML for mails and exports, and how it becomes plain text for search.
// Pure TypeScript without Node APIs, so the web editor can share the lists.

export interface RichMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface RichNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichNode[];
  marks?: RichMark[];
  text?: string;
}
export type RichDoc = RichNode & { type: "doc" };

type Attr = (value: unknown) => unknown;
const oneOf =
  <T>(values: readonly T[], fallback: T): Attr =>
  (v) =>
    values.includes(v as T) ? v : fallback;
const text =
  (max: number): Attr =>
  (v) =>
    typeof v === "string" ? v.slice(0, max) : "";
const int =
  (min: number, max: number, fallback: number): Attr =>
  (v) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max
      ? v
      : fallback;
const bool: Attr = (v) => v === true;

/** http(s), mailto, or a path on this installation. Everything else (javascript: …) is dropped. */
export function safeHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  if (/^\/(?![/\\])/.test(value)) return value;
  return /^(https?:\/\/|mailto:)/i.test(value) ? value : null;
}
/** Images load from this installation only: no tracking pixels, no mixed content. */
const localSrc: Attr = (v) =>
  typeof v === "string" && v.length <= 2000 && /^\/(?![/\\])/.test(v)
    ? v
    : null;

const CALLOUTS = ["info", "success", "warning", "danger"] as const;
/** A ticket key like "IT-42". */
export const ISSUE_KEY = /^[A-Z][A-Z0-9]{1,9}-[1-9]\d{0,9}$/;
const issueKey: Attr = (v) =>
  typeof v === "string" && ISSUE_KEY.test(v) ? v : "";
const STATUS = ["todo", "in_progress", "done"] as const;
export const QUERY_APPS = ["tickvana", "nuvenna"] as const;
export const QUERY_VIEWS = ["table", "number", "bar"] as const;

/** Every node type a document may contain, with its attributes and their sanitizers. */
export const NODES: Record<string, Record<string, Attr>> = {
  doc: {},
  paragraph: {},
  text: {},
  heading: { level: int(1, 4, 2) },
  bulletList: {},
  orderedList: { start: int(1, 100000, 1) },
  listItem: {},
  taskList: {},
  taskItem: { checked: bool },
  blockquote: {},
  codeBlock: {
    language: (v) =>
      typeof v === "string" && /^[a-z0-9+#-]{1,30}$/i.test(v) ? v : null,
  },
  horizontalRule: {},
  hardBreak: {},
  table: {},
  tableRow: {},
  tableHeader: { colspan: int(1, 50, 1), rowspan: int(1, 200, 1) },
  tableCell: { colspan: int(1, 50, 1), rowspan: int(1, 200, 1) },
  image: { src: localSrc, alt: text(500), title: text(500) },
  attachment: {
    href: localSrc,
    name: text(500),
    size: int(0, Number.MAX_SAFE_INTEGER, 0),
  },
  mention: { id: text(36), label: text(200) },
  callout: { kind: oneOf(CALLOUTS, "info") },
  details: {},
  detailsSummary: {},
  detailsContent: {},
  status: { label: text(60), category: oneOf(STATUS, "todo") },
  date: {
    value: (v) =>
      typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null,
  },
  // Blocks filled in by the app that shows the document (Nuvenna): a table of
  // contents, the list of sub-pages, another page shown inline.
  toc: {},
  childPages: {},
  pageInclude: { pageId: text(36) },
  // A ticket from Tickvana, by key. Title and status are fetched when shown,
  // with the reader's rights; only the key is stored.
  issue: { key: issueKey },
  // A query, saved (queryId) or written in place (sql), run with the
  // reader's rights by the app that owns the tables, shown as table,
  // number or bars.
  query: {
    app: oneOf(QUERY_APPS, "tickvana"),
    queryId: text(36),
    sql: text(20_000),
    view: oneOf(QUERY_VIEWS, "table"),
  },
};

export const MARKS: Record<string, Record<string, Attr>> = {
  bold: {},
  italic: {},
  strike: {},
  underline: {},
  code: {},
  link: { href: safeHref },
};

const MAX_NODES = 20_000;
const MAX_DEPTH = 40;

export class RichTextError extends Error {}

/**
 * Checks a document from a client and returns a clean copy: unknown node or
 * mark types are an error, unknown attributes are dropped, known ones are
 * forced into range. Call at the API boundary before storing.
 */
export function sanitizeDoc(input: unknown): RichDoc {
  let count = 0;
  const node = (raw: unknown, depth: number): RichNode => {
    if (++count > MAX_NODES) throw new RichTextError("Document is too large");
    if (depth > MAX_DEPTH)
      throw new RichTextError("Document is nested too deeply");
    if (typeof raw !== "object" || raw === null)
      throw new RichTextError("Node must be an object");
    const {
      type,
      attrs,
      content,
      marks,
      text: value,
    } = raw as Record<string, unknown>;
    const spec =
      typeof type === "string" && Object.hasOwn(NODES, type)
        ? NODES[type]
        : undefined;
    if (!spec) throw new RichTextError(`Unknown node type "${String(type)}"`);

    const out: RichNode = { type: type as string };
    const given =
      typeof attrs === "object" && attrs !== null
        ? (attrs as Record<string, unknown>)
        : {};
    const clean = Object.fromEntries(
      Object.entries(spec).map(([key, fix]) => [key, fix(given[key])]),
    );
    if (Object.keys(clean).length > 0) out.attrs = clean;

    if (type === "text") {
      if (typeof value !== "string" || value === "")
        throw new RichTextError("Text node needs text");
      out.text = value;
      if (Array.isArray(marks)) {
        out.marks = marks.flatMap((m): RichMark[] => {
          const markType = (m as RichMark | null)?.type;
          const markSpec =
            typeof markType === "string" && Object.hasOwn(MARKS, markType)
              ? MARKS[markType]
              : undefined;
          if (!markSpec)
            throw new RichTextError(`Unknown mark type "${String(markType)}"`);
          const markAttrs = Object.fromEntries(
            Object.entries(markSpec).map(([key, fix]) => [
              key,
              fix((m as RichMark).attrs?.[key]),
            ]),
          );
          // A link without a usable target is plain text.
          if (markType === "link" && markAttrs.href === null) return [];
          return [
            Object.keys(markAttrs).length > 0
              ? { type: markType as string, attrs: markAttrs }
              : { type: markType as string },
          ];
        });
        if (out.marks.length === 0) delete out.marks;
      }
    } else if (Array.isArray(content)) {
      out.content = content.map((child) => node(child, depth + 1));
    }
    return out;
  };

  const doc = node(input, 0);
  if (doc.type !== "doc")
    throw new RichTextError('Root node must be of type "doc"');
  return doc as RichDoc;
}

/** An empty document. */
export const emptyDoc = (): RichDoc => ({
  type: "doc",
  content: [{ type: "paragraph" }],
});

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const BLOCK_TAGS: Record<string, string> = {
  paragraph: "p",
  bulletList: "ul",
  listItem: "li",
  blockquote: "blockquote",
  table: "table",
  tableRow: "tr",
  detailsSummary: "summary",
  detailsContent: "div",
};
const MARK_TAGS: Record<string, string> = {
  bold: "strong",
  italic: "em",
  strike: "s",
  underline: "u",
  code: "code",
};

/**
 * Renders a document to HTML for mails and exports. Only this function turns
 * rich text into markup: every value is escaped, every URL re-checked, unknown
 * nodes render nothing.
 */
export function renderHtml(doc: RichNode): string {
  const children = (n: RichNode) => (n.content ?? []).map(render).join("");
  const span = (n: RichNode) => {
    const attrs = [n.attrs?.colspan, n.attrs?.rowspan].map((v, i) =>
      typeof v === "number" && v > 1
        ? ` ${i ? "rowspan" : "colspan"}="${v}"`
        : "",
    );
    return attrs.join("");
  };

  function render(n: RichNode): string {
    const a = n.attrs ?? {};
    switch (n.type) {
      case "doc":
        return children(n);
      case "text": {
        let html = escapeHtml(n.text ?? "");
        for (const mark of n.marks ?? []) {
          if (mark.type === "link") {
            const href = safeHref(mark.attrs?.href);
            if (href)
              html = `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${html}</a>`;
          } else if (MARK_TAGS[mark.type]) {
            html = `<${MARK_TAGS[mark.type]}>${html}</${MARK_TAGS[mark.type]}>`;
          }
        }
        return html;
      }
      case "heading": {
        const level = int(1, 4, 2)(a.level);
        return `<h${level}>${children(n)}</h${level}>`;
      }
      case "orderedList":
        return `<ol start="${int(1, 100000, 1)(a.start)}">${children(n)}</ol>`;
      case "taskList":
        return `<ul data-type="taskList">${children(n)}</ul>`;
      case "taskItem":
        return `<li data-checked="${a.checked === true}">${a.checked === true ? "☑" : "☐"} ${children(n)}</li>`;
      case "codeBlock":
        return `<pre><code>${children(n)}</code></pre>`;
      case "horizontalRule":
        return "<hr>";
      case "hardBreak":
        return "<br>";
      case "tableHeader":
        return `<th${span(n)}>${children(n)}</th>`;
      case "tableCell":
        return `<td${span(n)}>${children(n)}</td>`;
      case "image": {
        const src = localSrc(a.src);
        return src
          ? `<img src="${escapeHtml(src as string)}" alt="${escapeHtml(text(500)(a.alt) as string)}">`
          : "";
      }
      case "attachment": {
        const href = localSrc(a.href);
        const name = escapeHtml(text(500)(a.name) as string);
        return href
          ? `<p><a href="${escapeHtml(href as string)}">${name}</a></p>`
          : "";
      }
      case "mention":
        return `<span data-mention="${escapeHtml(text(36)(a.id) as string)}">@${escapeHtml(text(200)(a.label) as string)}</span>`;
      case "callout":
        return `<div role="note" data-callout="${oneOf(CALLOUTS, "info")(a.kind)}">${children(n)}</div>`;
      case "details":
        return `<details>${children(n)}</details>`;
      case "status":
        return `<span data-status="${oneOf(STATUS, "todo")(a.category)}">${escapeHtml(text(60)(a.label) as string)}</span>`;
      case "date": {
        const value = NODES.date!.value!(a.value);
        return value ? `<time datetime="${value}">${value}</time>` : "";
      }
      // Placeholders: only the app that shows the page can fill them.
      case "toc":
        return "<nav data-toc></nav>";
      case "childPages":
        return "<div data-child-pages></div>";
      case "pageInclude":
        return `<div data-page-include="${escapeHtml(text(36)(a.pageId) as string)}"></div>`;
      case "query":
        return "<div data-query></div>";
      case "issue": {
        const key = issueKey(a.key) as string;
        return key
          ? `<p data-issue="${key}"><a href="/tickvana/issues/${key}">${key}</a></p>`
          : "";
      }
      default: {
        const tag = BLOCK_TAGS[n.type];
        return tag ? `<${tag}>${children(n)}</${tag}>` : "";
      }
    }
  }
  return render(doc);
}

const INLINE = new Set(["text", "hardBreak", "mention", "status", "date"]);
const CELLS = new Set(["tableCell", "tableHeader"]);

/** The text of a document, one block per line. For search, previews and plain-text mail. */
export function renderText(doc: RichNode): string {
  const lines: string[] = [];
  let line = "";
  const flush = () => {
    if (line.trim()) lines.push(line.trim().replace(/\s+/g, " "));
    line = "";
  };
  const walk = (n: RichNode, inCell: boolean) => {
    const a = n.attrs ?? {};
    if (n.type === "text") line += n.text ?? "";
    else if (n.type === "hardBreak") line += " ";
    else if (n.type === "mention") line += `@${text(200)(a.label)}`;
    else if (n.type === "status") line += text(60)(a.label);
    else if (n.type === "date")
      line += typeof a.value === "string" ? a.value : "";
    else if (n.type === "image") line += text(500)(a.alt);
    else if (n.type === "attachment") line += text(500)(a.name);
    else if (n.type === "issue") line += issueKey(a.key);

    const cell = inCell || CELLS.has(n.type);
    for (const child of n.content ?? []) walk(child, cell);
    if (INLINE.has(n.type)) return;
    // Blocks end a line. Inside a table the row does: its cells share one line.
    if (cell) line += " ";
    else flush();
  };
  walk(doc, false);
  flush();
  return lines.join("\n");
}
