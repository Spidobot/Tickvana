import { describe, expect, it } from "vitest";
import { markdownToDoc, renderMarkdown } from "./markdown.js";

const md = `# Drucker

Toner liegt im **Lager**, _Regal 3_. Siehe [Liste](https://example.org) und \`lpstat -t\`.

## Schritte

1. Einschalten
2. Warten

- [x] Treiber
- [ ] Test

> Achtung: heiß

\`\`\`sh
echo "a*b"
\`\`\`

| Raum | Gerät |
| --- | --- |
| 1.04 | HP |

---
`;

describe("markdown", () => {
  it("survives a round trip", () => {
    const { title, doc } = markdownToDoc(md);
    expect(title).toBe("Drucker");
    expect(doc.content!.map((n) => n.type)).toEqual([
      "paragraph",
      "heading",
      "orderedList",
      "taskList",
      "blockquote",
      "codeBlock",
      "table",
      "horizontalRule",
    ]);
    const out = renderMarkdown(doc);
    expect(out).toContain("Toner liegt im **Lager**, _Regal 3_.");
    expect(out).toContain("[Liste](https://example.org)");
    expect(out).toContain("`lpstat -t`");
    expect(out).toContain("1. Einschalten\n2. Warten");
    expect(out).toContain("- [x] Treiber\n- [ ] Test");
    expect(out).toContain('```sh\necho "a*b"\n```');
    expect(out).toContain("| Raum | Gerät |\n| --- | --- |\n| 1.04 | HP |");
    expect(markdownToDoc(out).doc).toEqual(doc);
  });

  it("keeps HTML and bad links out", () => {
    const { doc } = markdownToDoc(
      "<script>alert(1)</script>\n\n[x](javascript:alert(1)) <img src=x onerror=y>",
    );
    const json = JSON.stringify(doc);
    expect(json).not.toContain('"link"');
    // HTML stays visible as text; renderers escape it.
    expect(json).toContain("<script>");
    expect(renderMarkdown(doc)).toContain("\\<script\\>");
  });

  it("escapes what would turn into markup", () => {
    expect(
      renderMarkdown({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "a*b_[c]" }] },
        ],
      }),
    ).toBe("a\\*b\\_\\[c\\]\n");
  });
});
