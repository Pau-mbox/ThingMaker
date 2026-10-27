/** A person's own images for the wall screen and the picture frame. */
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { OFFICE_WIDTH, clampOfficeWidth, setOfficeImage, setOfficeWidth, useOfficeImage, useOfficeWidth } from "./officePrefs";

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

describe("the office's width", () => {
  it("stays between what its room needs and 45% of the window", () => {
    expect(clampOfficeWidth(100, 1600)).toBe(OFFICE_WIDTH.min);
    expect(clampOfficeWidth(900, 2400)).toBe(OFFICE_WIDTH.max);
    expect(clampOfficeWidth(600, 1000)).toBe(450);
    expect(clampOfficeWidth(400, 1000)).toBe(400);
    expect(clampOfficeWidth(400, 400)).toBe(OFFICE_WIDTH.min);
  });

  it("is remembered", () => {
    const { result } = renderHook(() => useOfficeWidth());
    act(() => setOfficeWidth(412.4));
    expect(result.current).toBe(412);
    expect(localStorage.getItem("thingmaker.office.width")).toBe("412");
  });
});
