/** `@tauri-apps/api/webview` for the phone build: nothing is dropped onto a phone. */
type DragDropEvent = { payload: { type: "enter" | "over" | "leave" | "drop"; paths?: string[] } };

export function getCurrentWebview() {
  return {
    onDragDropEvent: async (_handler: (event: DragDropEvent) => void) => () => undefined,
  };
}
