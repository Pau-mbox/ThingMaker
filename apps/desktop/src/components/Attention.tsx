import { useStore, sessionTitle } from "../store";

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
      <strong>{pending.length === 1 ? "1 session needs attention" : `${pending.length} sessions need attention`}:</strong>{" "}
      {pending.map((session) => (
        <button className="link" key={session.handle.id} onClick={() => selectSession(session.handle.id)} type="button">
          {sessionTitle(session, records[session.workspaceId])} ({session.attention.replace("_", " ")})
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
        <h2>Session {locked.sessionId.slice(0, 8)} is locked</h2>
        <p>{locked.error.message}</p>
        {stale && (
          <p className="small muted">
            Recovery takes over the lock left behind by an exited process. If another terminal or desktop is actually
            using this session, both would write the same transcript. Check first.
          </p>
        )}
        {live && (
          <p className="small muted">
            Another process holds this session right now (for example a terminal running the same agent). Stop it and resume again, or leave it be. This
            release does not open locked sessions read-only.
          </p>
        )}
        <div className="row wrap">
          {stale && (
            <button
              className="button button-warn"
              onClick={() => void openSession(locked.workspaceId, { mode: "resume", session_id: locked.sessionId })}
              type="button"
            >
              I checked: recover the stale lock
            </button>
          )}
          {!stale && !live && (
            <button
              className="button button-primary"
              onClick={() => void openSession(locked.workspaceId, { mode: "resume", session_id: locked.sessionId })}
              type="button"
            >
              Retry resume
            </button>
          )}
          <button className="button" onClick={dismiss} type="button">
            Close
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
        <h2>Close ThingMaker?</h2>
        <p>
          {closeRequest.activity.length === 0
            ? "No sessions are attached."
            : `${closeRequest.activity.length} session(s) are attached${active.length > 0 ? `, ${active.length} with work in progress` : ""}.`}
        </p>
        <p className="small muted">
          Keeping the app in the tray leaves local sessions running. Quitting asks each agent to cancel and close, then stops it;
          detached work does not survive quitting in this release.
        </p>
        <div className="row wrap">
          <button className="button button-primary" onClick={() => void hideToTray()} type="button">
            Keep running in tray
          </button>
          <button className="button button-warn" onClick={() => void quitAndStop()} type="button">
            Quit and stop local tasks
          </button>
          <button className="button" onClick={dismiss} type="button">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
