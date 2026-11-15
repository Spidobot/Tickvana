import { expect, it } from "vitest";
import {
  emptyDoc,
  renderHtml,
  renderText,
  RichTextError,
  sanitizeDoc,
  type RichNode,
} from "./index.js";

const p = (...content: RichNode[]): RichNode => ({
  type: "paragraph",
  content,
});
const t = (text: string, ...marks: RichNode["marks"] & object): RichNode => ({
  type: "text",
  text,
  ...(marks.length && { marks }),
});
const doc = (...content: RichNode[]) => ({ type: "doc", content });

it("accepts a full document and keeps it intact", () => {
  const input = doc(
    { type: "heading", attrs: { level: 2 }, content: [t("Übergabe")] },
    p(
      t("Hallo "),
      { type: "mention", attrs: { id: "u1", label: "Mira" } },
      t(" siehe "),
      t("Doku", { type: "link", attrs: { href: "https://example.org/a?b=1" } }),
    ),
    {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: true },
          content: [p(t("Drucker prüfen"))],
        },
      ],
    },
    {
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [t("const a = 1 < 2;")],
    },
    {
      type: "callout",
      attrs: { kind: "warning" },
      content: [p(t("Vorsicht"))],
    },
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              attrs: { colspan: 2, rowspan: 1 },
              content: [p(t("Kopf"))],
            },
          ],
        },
      ],
    },
    {
      type: "image",
      attrs: {
        src: "/tickvana/api/core/attachments/abc",
        alt: "Foto",
        title: "",
      },
    },
    p(
      {
        type: "status",
        attrs: { label: "In Arbeit", category: "in_progress" },
      },
      t(" bis "),
      { type: "date", attrs: { value: "2026-11-27" } },
    ),
  );
  expect(sanitizeDoc(input)).toEqual(input);
  expect(sanitizeDoc(emptyDoc())).toEqual(emptyDoc());
});

it("rejects what the schema does not know", () => {
  expect(() => sanitizeDoc(doc({ type: "iframe" }))).toThrow(RichTextError);
  expect(() => sanitizeDoc(doc({ type: "__proto__" }))).toThrow(
    /Unknown node type/,
  );
  expect(() =>
    sanitizeDoc(
      doc(p({ type: "text", text: "x", marks: [{ type: "style" }] })),
    ),
  ).toThrow(/Unknown mark type/);
  expect(() => sanitizeDoc(p(t("x")))).toThrow(/Root node/);
  expect(() => sanitizeDoc("<p>html</p>")).toThrow(RichTextError);
  expect(() => sanitizeDoc(doc(p({ type: "text", text: "" })))).toThrow(
    /needs text/,
  );
});

it("drops unknown attributes and forces known ones into range", () => {
  const clean = sanitizeDoc(
    doc(
      {
        type: "heading",
        attrs: { level: 9, onclick: "alert(1)", style: "x" },
        content: [t("a")],
      },
      {
        type: "image",
        attrs: {
          src: "https://tracker.example/pixel.gif",
          alt: 7,
          onerror: "x",
        },
      },
      { type: "image", attrs: { src: "//evil.example/x.png" } },
      { type: "callout", attrs: { kind: "<script>" }, content: [p(t("b"))] },
      {
        type: "codeBlock",
        attrs: { language: 'x" onload="y' },
        content: [t("c")],
      },
    ),
  );
  expect(clean.content![0]!.attrs).toEqual({ level: 2 });
  expect(clean.content![1]!.attrs).toEqual({ src: null, alt: "", title: "" });
  expect(clean.content![2]!.attrs!.src).toBeNull();
  expect(clean.content![3]!.attrs).toEqual({ kind: "info" });
  expect(clean.content![4]!.attrs).toEqual({ language: null });
});

it("removes links with dangerous targets but keeps the text", () => {
  for (const href of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>",
    "vbscript:x",
    " javascript:x",
    "//evil.example",
  ]) {
    const clean = sanitizeDoc(
      doc(p(t("klick", { type: "link", attrs: { href } }))),
    );
    expect(clean.content![0]!.content![0], href).toEqual({
      type: "text",
      text: "klick",
    });
  }
  for (const href of [
    "https://example.org",
    "mailto:a@example.org",
    "/pages/space/1",
  ]) {
    const clean = sanitizeDoc(
      doc(p(t("ok", { type: "link", attrs: { href } }))),
    );
    expect(clean.content![0]!.content![0]!.marks, href).toEqual([
      { type: "link", attrs: { href } },
    ]);
  }
});

it("limits size and depth", () => {
  let deep: RichNode = p(t("x"));
  for (let i = 0; i < 60; i++) deep = { type: "blockquote", content: [deep] };
  expect(() => sanitizeDoc(doc(deep))).toThrow(/nested too deeply/);
  expect(() =>
    sanitizeDoc(
      doc(...Array.from({ length: 20_001 }, () => ({ type: "paragraph" }))),
    ),
  ).toThrow(/too large/);
});

it("renders escaped HTML", () => {
  const html = renderHtml(
    doc(
      { type: "heading", attrs: { level: 3 }, content: [t("A & B")] },
      p(
        t(
          "<script>alert(1)</script>",
          { type: "bold" },
          { type: "link", attrs: { href: "https://example.org/?a=1&b=2" } },
        ),
      ),
      p(t("x", { type: "link", attrs: { href: "javascript:alert(1)" } })),
      { type: "codeBlock", attrs: { language: "html" }, content: [t("<b>")] },
      { type: "image", attrs: { src: "/a/b", alt: '"><img src=x onerror=1>' } },
      { type: "image", attrs: { src: "https://evil.example/x.png" } },
      { type: "mention", attrs: { id: "u1", label: "<Mira>" } },
      { type: "unknownThing", content: [t("weg")] },
    ),
  );
  expect(html).toContain("<h3>A &#38; B</h3>");
  expect(html).toContain(
    '<a href="https://example.org/?a=1&#38;b=2" rel="noopener noreferrer"><strong>&#60;script&#62;alert(1)&#60;/script&#62;</strong></a>',
  );
  expect(html).toContain("<p>x</p>");
  expect(html).toContain("<pre><code>&#60;b&#62;</code></pre>");
  expect(html).toContain(
    '<img src="/a/b" alt="&#34;&#62;&#60;img src=x onerror=1&#62;">',
  );
  expect(html).not.toContain("evil.example");
  expect(html).not.toContain("javascript:");
  expect(html).toContain("@&#60;Mira&#62;");
  expect(html).not.toContain("weg");
  expect(html).not.toMatch(/<script|onerror=1>"/);
});

it("extracts searchable text, one block per line", () => {
  const text = renderText(
    doc(
      { type: "heading", attrs: { level: 1 }, content: [t("Übergabe")] },
      p(
        t("Hallo "),
        { type: "mention", attrs: { id: "u1", label: "Mira" } },
        { type: "hardBreak" },
        t("zweite Zeile"),
      ),
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [p(t("eins"))] },
          { type: "listItem", content: [p(t("zwei"))] },
        ],
      },
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [p(t("A"))] },
              { type: "tableCell", content: [p(t("B"))] },
            ],
          },
        ],
      },
      p({ type: "status", attrs: { label: "Erledigt", category: "done" } }),
    ),
  );
  expect(text.split("\n")).toEqual([
    "Übergabe",
    "Hallo @Mira zweite Zeile",
    "eins",
    "zwei",
    "A B",
    "Erledigt",
  ]);
});
