/**
 * Uncertain submissions (REC-01, V08). Entries whose acceptance could not be
 * established are listed for the user to resend or discard explicitly.
 * Nothing is resent automatically.
 */
import { useEffect } from "react";
import { useStore } from "../store";

export function OutboxPanel({ workspaceId }: { workspaceId: string }) {
  const entries = useStore((s) => s.outbox[workspaceId]);
  const loadOutbox = useStore((s) => s.loadOutbox);
  const discardOutbox = useStore((s) => s.discardOutbox);
  const resendOutbox = useStore((s) => s.resendOutbox);
  const sessions = useStore((s) => s.sessions);

  useEffect(() => {
    void loadOutbox(workspaceId);
  }, [workspaceId, loadOutbox]);

  if (!entries || entries.length === 0) return null;
  return (
    <section className="outbox">
      <h3>Submissions with unknown outcome</h3>
      <p className="small muted">
        These prompts were being sent when the agent or the desktop stopped before acceptance was confirmed. The agent may or may not have received them; check the
        transcript before resending. Nothing is resent automatically.
      </p>
      <ul className="call-list">
        {entries.map((entry) => {
          const attached = Object.values(sessions).some((s) => s.workspaceId === workspaceId && s.snapshot.agentSessionId === entry.agentSessionId);
          return (
            <li className="card" key={entry.record.requestId}>
              <div className="row wrap">
                <span className="chip small chip-warn">{entry.record.state.replace("_", " ")}</span>
                <span className="mono small muted">session {entry.agentSessionId ?? "?"}</span>
                <span className="small muted">{new Date(entry.record.createdAt).toLocaleString()}</span>
                {entry.record.message && <span className="small muted">{entry.record.message}</span>}
              </div>
              <pre className="text">{entry.text ?? "(payload unavailable)"}</pre>
              <div className="row wrap">
                <button
                  className="button button-primary"
                  disabled={!attached || entry.text === null}
                  onClick={() => void resendOutbox(workspaceId, entry)}
                  title={attached ? "Send again as a new request" : "Resume this session first"}
                  type="button"
                >
                  Resend
                </button>
                <button className="button" onClick={() => void discardOutbox(workspaceId, entry.record.requestId)} type="button">
                  Discard
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
