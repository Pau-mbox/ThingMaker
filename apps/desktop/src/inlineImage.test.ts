import { describe, expect, it } from "vitest";
import { imageSource } from "./components/InlineImage";

describe("image block source", () => {
  it("builds a data URL from bare base64", () => {
    expect(imageSource("iVBORw0KGgo=", "image/png")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("leaves an existing data URL alone", () => {
    // Double-prefixing this is what rendered attached images as broken icons.
    const url = "data:image/jpeg;base64,/9j/4AAQ";
    expect(imageSource(url, "image/png")).toBe(url);
    expect(imageSource(`  ${url}  `, null)).toBe(url);
  });

  it("drops whitespace that a wrapped payload may carry", () => {
    expect(imageSource("iVBO\nRw0K\n Ggo=", "image/png")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("falls back to png when no mime type was supplied", () => {
    expect(imageSource("iVBORw0KGgo=", undefined)).toBe("data:image/png;base64,iVBORw0KGgo=");
  });
});
