/**
 * Attention notifications (UX-10).
 *
 * Bodies never contain prompt or code content: only the kind of event and the
 * workspace folder name. OS permission is requested contextually, the first
 * time a notification would actually be shown. Quiet hours and muted
 * workspaces are honoured before any OS call.
 */
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { NotificationSettings } from "@thingmaker/contracts";
import type { AttentionKind } from "./store";

export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** True when `now` (minutes since midnight) falls in the quiet window. Wraps midnight; equal bounds disable it. */
export function inQuietHours(settings: Pick<NotificationSettings, "quietHoursStart" | "quietHoursEnd">, now: number): boolean {
  const start = parseClock(settings.quietHoursStart);
  const end = parseClock(settings.quietHoursEnd);
  if (start === null || end === null || start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function shouldNotify(
  settings: NotificationSettings,
  kind: AttentionKind,
  workspaceId: string,
  now: number = new Date().getHours() * 60 + new Date().getMinutes(),
): boolean {
  if (!settings.enabled || kind === "none") return false;
  if (settings.mutedWorkspaceIds.includes(workspaceId)) return false;
  if (inQuietHours(settings, now)) return false;
  if (kind === "completed") return settings.notifyCompleted;
  if (kind === "failed") return settings.notifyFailed;
  return settings.notifyNeedsInput;
}

export function notificationText(kind: AttentionKind, workspaceName: string): { title: string; body: string } {
  switch (kind) {
    case "completed":
      return { title: "An agent finished a turn", body: `A session in ${workspaceName} is idle and ready for review.` };
    case "failed":
      return { title: "A session needs attention", body: `A session in ${workspaceName} failed or exited.` };
    case "needs_input":
      return { title: "An agent is waiting for you", body: `A session in ${workspaceName} asked for a decision.` };
    default:
      return { title: "ThingMaker", body: workspaceName };
  }
}

let permissionState: "unknown" | "granted" | "denied" = "unknown";

/** Requests OS permission the first time it is needed; returns whether granted. */
export async function ensurePermission(): Promise<boolean> {
  if (permissionState === "granted") return true;
  if (permissionState === "denied") return false;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    permissionState = granted ? "granted" : "denied";
    return granted;
  } catch {
    permissionState = "denied";
    return false;
  }
}

export async function notify(kind: AttentionKind, workspaceName: string): Promise<boolean> {
  if (!(await ensurePermission())) return false;
  const { title, body } = notificationText(kind, workspaceName);
  try {
    sendNotification({ title, body });
    return true;
  } catch {
    return false;
  }
}
