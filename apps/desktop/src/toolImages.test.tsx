import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolPatch } from "@thingmaker/contracts";
import { toolImages } from "./toolImages";
import { ToolPayloads } from "./components/ToolPayloads";

const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const image = { type: "image", data, mimeType: "image/png" };
const patch = (fields: Partial<ToolPatch>): ToolPatch => ({ toolCallId: "read", title: "Read test.png", status: "completed", toolKind: "read", content: null, rawInput: { file_path: "test.png" }, rawOutput: null, name: null, locations: null, meta: null, present: [], cleared: [], ...fields });
afterEach(() => { cleanup(); delete document.documentElement.dataset.platform; });

describe("tool image results", () => {
  it("extracts ACP wrappers and MCP results without changing the stored payload", () => {
    const value = [{ type: "content", content: image }, { type: "content", content: { type: "text", text: "Image read successfully" } }];
    const result = toolImages(value);
    expect(result.images).toEqual([{ data, mimeType: "image/png" }]);
    expect(JSON.stringify(result.detail)).not.toContain(data);
    expect(JSON.stringify(result.detail)).toContain("Image read successfully");
    expect(value[0]?.content).toEqual(image);
  });

  it("recognizes Claude base64 sources, data URLs and image resources", () => {
    const result = toolImages([
      { type: "image", source: { type: "base64", media_type: "image/png", data } },
      { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } },
      { type: "resource", resource: { mimeType: "image/png", blob: data } },
    ]);
    expect(result.images).toHaveLength(3);
    expect(JSON.stringify(result.detail)).not.toContain(data);
  });

  it("handles JSON tool results embedded in text and preserves ordinary results", () => {
    expect(toolImages({ type: "text", text: JSON.stringify({ content: [image] }) }).images).toHaveLength(1);
    const value = { content: [{ type: "text", text: "ordinary read" }], exitCode: 0 };
    expect(toolImages(value)).toEqual({ detail: value, images: [] });
  });

  it.each(["windows", "android"])("renders an image instead of base64 on %s, once across output and content", (platform) => {
    document.documentElement.dataset.platform = platform;
    const { container } = render(<ToolPayloads patch={patch({ rawOutput: { content: [image, { type: "text", text: "Read OK" }] }, content: [{ type: "content", content: image }] })} workspaceId="w" />);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByRole("img").getAttribute("src")).toBe(`data:image/png;base64,${data}`);
    expect(container.textContent).toContain("Read OK");
    expect(container.textContent).toContain("test.png");
    expect(container.textContent).not.toContain(data);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByText("image could not be displayed")).toBeTruthy();
    expect(container.textContent).not.toContain(data);
  });
});
