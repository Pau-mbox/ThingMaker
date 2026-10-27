/**
 * Whether the office pane is open beside the conversation. A per-device
 * convenience, so it lives in localStorage rather than the app's saved
 * preferences; every pane listening here follows a change at once.
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
