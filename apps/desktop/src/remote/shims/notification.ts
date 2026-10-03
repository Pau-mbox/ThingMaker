/**
 * `@tauri-apps/plugin-notification` for the phone build. The Android app's
 * own service posts the notifications that matter while the app is closed;
 * these are the ones the screens raise while it is open.
 */
export async function isPermissionGranted(): Promise<boolean> {
  return Boolean(window.ThingMakerNative?.notify);
}

export async function requestPermission(): Promise<"granted" | "denied"> {
  return window.ThingMakerNative?.notify ? "granted" : "denied";
}

export function sendNotification(options: { title: string; body?: string } | string): void {
  const { title, body } = typeof options === "string" ? { title: options, body: "" } : { title: options.title, body: options.body ?? "" };
  window.ThingMakerNative?.notify?.(title, body);
}
