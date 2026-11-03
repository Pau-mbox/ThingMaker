// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
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
    expect(html).toContain('title="Open https://example.com in your browser"');
    expect(html).not.toContain("<img");
    expect(html).toContain("image: img");
  });

  it("links a bare address, leaving the sentence's punctuation out of it", () => {
    const opened = vi.fn();
    render(<Markdown onLink={opened} source={"Docs are at https://example.com/a_b_c (see https://en.wikipedia.org/wiki/Foo_(bar)). Done."} />);
    fireEvent.click(screen.getByText("https://example.com/a_b_c"));
    fireEvent.click(screen.getByText("https://en.wikipedia.org/wiki/Foo_(bar)"));
    expect(opened.mock.calls).toEqual([["https://example.com/a_b_c"], ["https://en.wikipedia.org/wiki/Foo_(bar)"]]);
    expect(document.body.textContent).toContain("). Done.");
  });

  it("shows an artifact's link as a named pill that opens in the browser", () => {
    const opened = vi.fn();
    const url = "https://claude.ai/artifact/95s9H5VykZDRXsZSGfz3z4";
    render(<Markdown onLink={opened} source={`The page is ready, but at a new link: ${url}. Or [the evolutions page](${url}).`} />);
    const pills = document.querySelectorAll(".artifact-link");
    expect(pills).toHaveLength(2);
    expect(pills[0]?.textContent).toBe("Artifact95s9H5Vy");
    expect(pills[1]?.textContent).toBe("the evolutions page");
    expect(pills[0]?.getAttribute("title")).toBe(`Open ${url} in your browser`);
    fireEvent.click(pills[0] as Element);
    expect(opened).toHaveBeenCalledWith(url);
    // The address is not printed out alongside its pill.
    expect(document.body.textContent).not.toContain("claude.ai");
  });
});
