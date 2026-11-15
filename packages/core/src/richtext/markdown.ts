// Markdown in and out, for page export and import. Out is our own code over
// the fixed schema; in goes through marked's lexer and ends in sanitizeDoc,
// so imported files can carry nothing the editor could not.
import { marked, type Token, type Tokens } from "marked";
import {
  sanitizeDoc,
  type RichDoc,
  type RichMark,
  type RichNode,
} from "./index.js";

// --- Out ------------------------------------------------------------------------------

const escapeMd = (s: string) => s.replace(/[\\`*_[\]<>|~]/g, "\\$&");

function inline(nodes: RichNode[] = []): string {
  return nodes
    .map((n) => {
      const a = n.attrs ?? {};
      if (n.type === "hardBreak") return "  \n";
      if (n.type === "mention") return `@${String(a.label ?? "")}`;
      if (n.type === "status") return `[${String(a.label ?? "")}]`;
      if (n.type === "date") return String(a.value ?? "");
      if (n.type !== "text") return inline(n.content);
      const marks = new Set((n.marks ?? []).map((m) => m.type));
      if (marks.has("code")) return `\`${(n.text ?? "").replace(/`/g, "")}\``;
      let s = escapeMd(n.text ?? "");
      if (marks.has("bold")) s = `**${s}**`;
      if (marks.has("italic")) s = `_${s}_`;
      if (marks.has("strike")) s = `~~${s}~~`;
      const link = n.marks?.find((m) => m.type === "link");
      if (link) s = `[${s}](${String(link.attrs?.href ?? "")})`;
      return s;
    })
    .join("");
}

/** Lines of one block; nested blocks are indented by their parent. */
function block(n: RichNode): string[] {
  const a = n.attrs ?? {};
  const kids = () =>
    (n.content ?? []).flatMap((c, i) => (i ? ["", ...block(c)] : block(c)));
  const items = (marker: (i: number, item: RichNode) => string) =>
    (n.content ?? []).flatMap((item, i) => {
      const lines = (item.content ?? []).flatMap(block);
      const m = marker(i, item);
      return lines.map((l, j) => (j ? " ".repeat(m.length) + l : m + l));
    });
  switch (n.type) {
    case "paragraph":
      return [inline(n.content)];
    case "heading":
      return [`${"#".repeat(Number(a.level) || 2)} ${inline(n.content)}`];
    case "bulletList":
      return items(() => "- ");
    case "orderedList":
      return items((i) => `${(Number(a.start) || 1) + i}. `);
    case "taskList":
      return items((_, item) => (item.attrs?.checked ? "- [x] " : "- [ ] "));
    case "blockquote":
    case "callout":
      return kids().map((l) => `> ${l}`.trimEnd());
    case "codeBlock":
      return [
        "```" + (typeof a.language === "string" ? a.language : ""),
        ...inline(n.content).replace(/\\(.)/g, "$1").split("\n"),
        "```",
      ];
    case "horizontalRule":
      return ["---"];
    case "image":
      return [`![${escapeMd(String(a.alt ?? ""))}](${String(a.src ?? "")})`];
    case "attachment":
      return [`[${escapeMd(String(a.name ?? ""))}](${String(a.href ?? "")})`];
    case "query":
      return typeof a.sql === "string" && a.sql
        ? ["```sql", ...a.sql.split("\n"), "```"]
        : [];
    case "issue":
      return a.key ? [String(a.key)] : [];
    case "detailsSummary":
      return [
        `**${inline((n.content ?? []).flatMap((c) => c.content ?? []))}**`,
      ];
    case "table": {
      const rows = (n.content ?? []).map((r) =>
        (r.content ?? []).map((c) =>
          (c.content ?? [])
            .map((p) => inline(p.content))
            .join(" ")
            .replace(/\n/g, " "),
        ),
      );
      if (!rows.length) return [];
      const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
      return [
        line(rows[0]!),
        line(rows[0]!.map(() => "---")),
        ...rows.slice(1).map(line),
      ];
    }
    // Blocks only the app can fill have no Markdown form.
    case "toc":
    case "childPages":
    case "pageInclude":
      return [];
    default:
      return kids();
  }
}

/** A document as Markdown (GitHub flavour). */
export function renderMarkdown(doc: RichNode): string {
  const out = (doc.content ?? [])
    .map(block)
    .filter((lines) => lines.length)
    .map((lines) => lines.join("\n"))
    .join("\n\n");
  return out ? `${out}\n` : "";
}

// --- In -------------------------------------------------------------------------------

function inlineIn(tokens: Token[] = [], marks: RichMark[] = []): RichNode[] {
  return tokens.flatMap((t): RichNode[] => {
    const add = (mark: RichMark) =>
      inlineIn((t as Tokens.Strong).tokens, [...marks, mark]);
    switch (t.type) {
      case "strong":
        return add({ type: "bold" });
      case "em":
        return add({ type: "italic" });
      case "del":
        return add({ type: "strike" });
      case "link":
        return add({ type: "link", attrs: { href: (t as Tokens.Link).href } });
      case "codespan":
        return text((t as Tokens.Codespan).text, [...marks, { type: "code" }]);
      case "br":
        return [{ type: "hardBreak" }];
      case "image":
        return text((t as Tokens.Image).text, marks);
      case "text":
        return (t as Tokens.Text).tokens
          ? inlineIn((t as Tokens.Text).tokens, marks)
          : text((t as Tokens.Text).text, marks);
      default:
        return text("text" in t ? String(t.text) : t.raw, marks);
    }
  });
}
const text = (value: string, marks: RichMark[]): RichNode[] =>
  value ? [{ type: "text", text: value, ...(marks.length && { marks }) }] : [];
const para = (tokens?: Token[]): RichNode => {
  const content = inlineIn(tokens);
  return content.length
    ? { type: "paragraph", content }
    : { type: "paragraph" };
};

function blocks(tokens: Token[]): RichNode[] {
  return tokens.flatMap((t): RichNode[] => {
    switch (t.type) {
      case "heading": {
        const h = t as Tokens.Heading;
        return [
          {
            type: "heading",
            attrs: { level: Math.min(h.depth, 4) },
            content: inlineIn(h.tokens),
          },
        ];
      }
      case "paragraph":
      case "text":
        return [
          para(
            (t as Tokens.Paragraph).tokens ?? [
              { type: "text", raw: t.raw, text: t.raw } as Token,
            ],
          ),
        ];
      case "list": {
        const l = t as Tokens.List;
        const task = l.items.some((i) => i.task);
        return [
          {
            type: task ? "taskList" : l.ordered ? "orderedList" : "bulletList",
            ...(l.ordered &&
              !task && { attrs: { start: Number(l.start) || 1 } }),
            content: l.items.map((i) => {
              const content = blocks(
                i.tokens.filter((x) => x.type !== "checkbox"),
              );
              return {
                type: task ? "taskItem" : "listItem",
                ...(task && { attrs: { checked: !!i.checked } }),
                content: content.length ? content : [{ type: "paragraph" }],
              };
            }),
          },
        ];
      }
      case "blockquote":
        return [
          {
            type: "blockquote",
            content: blocks((t as Tokens.Blockquote).tokens),
          },
        ];
      case "code": {
        const c = t as Tokens.Code;
        return [
          {
            type: "codeBlock",
            attrs: { language: c.lang || null },
            content: text(c.text, []),
          },
        ];
      }
      case "hr":
        return [{ type: "horizontalRule" }];
      case "table": {
        const tb = t as Tokens.Table;
        const row = (cells: Tokens.TableCell[], type: string): RichNode => ({
          type: "tableRow",
          content: cells.map((c) => ({ type, content: [para(c.tokens)] })),
        });
        return [
          {
            type: "table",
            content: [
              row(tb.header, "tableHeader"),
              ...tb.rows.map((r) => row(r, "tableCell")),
            ],
          },
        ];
      }
      case "space":
        return [];
      default:
        // Raw HTML and anything unknown stays as visible text, never as markup.
        return t.raw.trim()
          ? [{ type: "paragraph", content: text(t.raw.trim(), []) }]
          : [];
    }
  });
}

/** Markdown as a clean document. A leading "# Title" is returned separately. */
export function markdownToDoc(md: string): {
  title: string | null;
  doc: RichDoc;
} {
  const tokens = marked.lexer(md.replace(/^\uFEFF/, ""));
  let title: string | null = null;
  const first = tokens.find((t) => t.type !== "space");
  if (first?.type === "heading" && (first as Tokens.Heading).depth === 1) {
    title = (first as Tokens.Heading).text.trim() || null;
    tokens.splice(tokens.indexOf(first), 1);
  }
  const content = blocks(tokens);
  return {
    title,
    doc: sanitizeDoc({
      type: "doc",
      content: content.length ? content : [{ type: "paragraph" }],
    }),
  };
}
