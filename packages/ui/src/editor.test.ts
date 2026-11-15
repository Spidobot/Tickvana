import { getSchema } from "@tiptap/core";
import { MARKS, NODES } from "@tvn/core/richtext";
import { expect, it } from "vitest";
import { editorExtensions } from "./editor.js";

// The server rejects node types it does not know, and the editor cannot show
// types it does not know. So the two lists must be the same.
it("has exactly the nodes, marks and attributes of the server schema", () => {
  const schema = getSchema(editorExtensions());
  expect(Object.keys(schema.nodes).sort()).toEqual(Object.keys(NODES).sort());
  expect(Object.keys(schema.marks).sort()).toEqual(Object.keys(MARKS).sort());

  for (const [name, attrs] of Object.entries(NODES)) {
    const known = Object.keys(schema.nodes[name]!.spec.attrs ?? {});
    for (const attr of Object.keys(attrs))
      expect(known, `${name}.${attr}`).toContain(attr);
  }
  expect(Object.keys(schema.marks.link!.spec.attrs ?? {})).toContain("href");
});
