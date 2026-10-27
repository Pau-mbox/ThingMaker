/**
 * What a person chose for the office pane: whether it is open beside the
 * conversation, and their own images for the big wall screen and the framed
 * picture. Per-device conveniences, so they live in localStorage rather than
 * the app's saved preferences; every pane listening here follows a change at
 * once.
 */
import { useSyncExternalStore } from "react";

const KEY = "thingmaker.office.open";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

let current = read();

export function setOfficeOpen(open: boolean): void {
  current = open;
  try {
    localStorage.setItem(KEY, open ? "1" : "0");
  } catch {
    // Storage can be unavailable; the choice still holds until reload.
  }
  listeners.forEach((listener) => listener());
}

export function useOfficeOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => true,
  );
}

/* ---------- Their own images ---------- */

export type OfficeSlot = "wall" | "logo";

/** The size each image is fitted to, in pixels: the slot's shape at 8 pixels to a pixel of the room. */
export const SLOT_PIXELS: Record<OfficeSlot, { w: number; h: number }> = {
  wall: { w: 400, h: 176 },
  logo: { w: 96, h: 96 },
};

const IMAGE_KEYS: Record<OfficeSlot, string> = { wall: "thingmaker.office.wall", logo: "thingmaker.office.logo" };

/** Only an image data URL is ever drawn: whatever else was stored is ignored. */
function readImage(slot: OfficeSlot): string | null {
  try {
    const value = localStorage.getItem(IMAGE_KEYS[slot]);
    return value && value.startsWith("data:image/") ? value : null;
  } catch {
    return null;
  }
}

const images: Record<OfficeSlot, string | null> = { wall: readImage("wall"), logo: readImage("logo") };

/** Sets a slot's image (an image data URL), or clears it with null. */
export function setOfficeImage(slot: OfficeSlot, dataUrl: string | null): void {
  images[slot] = dataUrl && dataUrl.startsWith("data:image/") ? dataUrl : null;
  try {
    if (images[slot]) localStorage.setItem(IMAGE_KEYS[slot], images[slot] as string);
    else localStorage.removeItem(IMAGE_KEYS[slot]);
  } catch {
    // Storage can be unavailable or full; the image still holds until reload.
  }
  listeners.forEach((listener) => listener());
}

export function useOfficeImage(slot: OfficeSlot): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => images[slot],
    () => null,
  );
}

/** Reads a picked file and fits it to a slot: scaled to cover it and cropped from the middle, as a PNG data URL. */
export async function fitImage(file: File, slot: OfficeSlot): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("not an image");
  const { w, h } = SLOT_PIXELS[slot];
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no canvas");
    const scale = Math.max(w / bitmap.width, h / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(bitmap, (w - width) / 2, (h - height) / 2, width, height);
    return canvas.toDataURL("image/png");
  } finally {
    bitmap.close();
  }
}
