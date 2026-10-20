import { t } from "../i18n";
import { useStore, sessionTitle, type AttentionKind } from "../store";

/** Why a session wants a look, in words. */
function attentionWord(attention: AttentionKind): string {
  switch (attention) {
    case "completed":
      return t("completed");
    case "failed":
      return t("failed");
    case "needs_input":
      return t("needs input");
    default:
      return attention;
  }
}

/** Sessions the user is not viewing that finished, failed or need input. */
export function AttentionBanner() {
  const sessions = useStore((s) => s.sessions);
  const sessionOrder = useStore((s) => s.sessionOrder);
  const selectSession = useStore((s) => s.selectSession);
  const records = useStore((s) => s.records);
  const jobs = useStore((s) => s.jobs);
  // Workers report to their orchestrator; they are never listed here.
  const workerHandles = new Set(Object.values(jobs).flatMap((list) => list.map((job) => job.workerSession).filter((handle): handle is string => !!handle)));
  const isWorker = (session: NonNullable<(typeof sessions)[string]>) =>
    workerHandles.has(session.handle.id) ||
    !!(records[session.workspaceId] ?? []).find((record) => record.agentSessionId === session.snapshot.agentSessionId)?.parentSessionId;
  const pending = sessionOrder.map((id) => sessions[id]).filter((s): s is NonNullable<typeof s> => !!s && s.attention !== "none" && !isWorker(s));
  if (pending.length === 0) return null;
  return (
    <div className="banner banner-attention" role="status">
      <strong>{pending.length === 1 ? t("{n} session needs attention", { n: 1 }) : t("{n} sessions need attention", { n: pending.length })}:</strong>{" "}
      {pending.map((session) => (
        <button className="link" key={session.handle.id} onClick={() => selectSession(session.handle.id)} type="button">
          {sessionTitle(session, records[session.workspaceId])} ({attentionWord(session.attention)})
        </button>
      ))}
    </div>
  );
}

/**
 * A resume refused by a session lock (REC-03). A stale lock can be recovered
 * with `--force` only after the user confirms no live Kit owns it; a live
 * owner is never overridden.
 */
export function LockedResumeDialog() {
  const locked = useStore((s) => s.lockedResume);
  const dismiss = useStore((s) => s.dismissLockedResume);
  const openSession = useStore((s) => s.openSession);
  if (!locked) return null;
  const stale = locked.error.retry === "user_action";
  const live = locked.error.retry === "read_only";
  return (
    <div aria-modal="true" className="modal-backdrop" role="dialog">
      <div className="modal">
        <h2>{t("Session {id} is locked", { id: locked.sessionId.slice(0, 8) })}</h2>
        <p>{locked.error.message}</p>
        {stale && (
          <p className="small muted">
            {t("Recovery takes over the lock left behind by an exited process. If another terminal or desktop is actually using this session, both would write the same transcript. Check first.")}
          </p>
        )}
        {live && (
          <p className="small muted">
            {t("Another process holds this session right now (for example a terminal running the same agent). Stop it and resume again, or leave it be. This release does not open locked sessions read-only.")}
          </p>
        )}
        <div className="row wrap">
          {stale && (
            <button
              className="button button-warn"
              onClick={() => void openSession(locked.workspaceId, { mode: "resume", session_id: locked.sessionId })}
              type="button"
            >
              {t("I checked: recover the stale lock")}
            </button>
          )}
          {!stale && !live && (
            <button
              className="button button-primary"
              onClick={() => void openSession(locked.workspaceId, { mode: "resume", session_id: locked.sessionId })}
              type="button"
            >
              {t("Retry resume")}
            </button>
          )}
          <button className="button" onClick={dismiss} type="button">
            {t("Close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Explicit choice when the last window is closed (ARCH-02). */
export function CloseRequestDialog() {
  const closeRequest = useStore((s) => s.closeRequest);
  const dismiss = useStore((s) => s.dismissCloseRequest);
  const hideToTray = useStore((s) => s.hideToTray);
  const quitAndStop = useStore((s) => s.quitAndStop);
  if (!closeRequest) return null;
  const active = closeRequest.activity.filter((a) => a.active || a.detachedCalls > 0);
  return (
    <div aria-modal="true" className="modal-backdrop" role="dialog">
      <div className="modal">
        <h2>{t("Close ThingMaker?")}</h2>
        <p>
          {closeRequest.activity.length === 0
            ? t("No sessions are attached.")
            : active.length > 0
              ? t("{n} session(s) are attached, {active} with work in progress.", { n: closeRequest.activity.length, active: active.length })
              : t("{n} session(s) are attached.", { n: closeRequest.activity.length })}
        </p>
        <p className="small muted">
          {t("Keeping the app in the tray leaves local sessions running. Quitting asks each agent to cancel and close, then stops it; detached work does not survive quitting in this release.")}
        </p>
        <div className="row wrap">
          <button className="button button-primary" onClick={() => void hideToTray()} type="button">
            {t("Keep running in tray")}
          </button>
          <button className="button button-warn" onClick={() => void quitAndStop()} type="button">
            {t("Quit and stop local tasks")}
          </button>
          <button className="button" onClick={dismiss} type="button">
            {t("Cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
