// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, parseBlocks } from "./markdown";

describe("markdown blocks", () => {
  it("parses headings, fenced code, lists, quotes and tables", () => {
    const blocks = parseBlocks("# Title\n\ntext *em*\n\n```rust\nfn main() {}\n```\n- a\n- b\n\n> quote\n\n| h1 | h2 |\n| --- | --- |\n| 1 | 2 |\n");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "code", "list", "quote", "table"]);
    expect(blocks[2]).toMatchObject({ language: "rust", code: "fn main() {}" });
    expect(blocks[5]).toMatchObject({ header: ["h1", "h2"], rows: [["1", "2"]] });
  });

  it("never emits raw HTML and only allows http(s) or mailto links", () => {
    const html = renderToStaticMarkup(<Markdown source={'<script>alert(1)</script> [x](javascript:alert(1)) [ok](https://example.com) ![img](http://evil/i.png)'} />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('title="https://example.com"');
    expect(html).not.toContain("<img");
    expect(html).toContain("image: img");
  });
});
