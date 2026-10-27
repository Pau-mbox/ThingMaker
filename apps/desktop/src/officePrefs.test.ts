/** A person's own images for the wall screen and the picture frame. */
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { setOfficeImage, useOfficeImage } from "./officePrefs";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

beforeEach(() => {
  setOfficeImage("wall", null);
  setOfficeImage("logo", null);
});

describe("office images", () => {
  it("keep what was chosen for each spot, and follow a change at once", () => {
    const { result } = renderHook(() => ({ wall: useOfficeImage("wall"), logo: useOfficeImage("logo") }));
    expect(result.current).toEqual({ wall: null, logo: null });
    act(() => setOfficeImage("wall", PNG));
    expect(result.current).toEqual({ wall: PNG, logo: null });
    expect(localStorage.getItem("thingmaker.office.wall")).toBe(PNG);
    act(() => setOfficeImage("wall", null));
    expect(result.current.wall).toBeNull();
    expect(localStorage.getItem("thingmaker.office.wall")).toBeNull();
  });

  it("only ever draw an image data URL", () => {
    setOfficeImage("logo", "https://example.com/logo.png");
    expect(localStorage.getItem("thingmaker.office.logo")).toBeNull();
    const { result } = renderHook(() => useOfficeImage("logo"));
    expect(result.current).toBeNull();
  });
});
