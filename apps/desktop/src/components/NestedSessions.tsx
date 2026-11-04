/**
 * Nested sessions in a session's view: in a fork, which session it is nested
 * under and whether it reports back; in a parent, what its forks reported,
 * waiting for your next message; in the transcript, the reports a message
 * carried.
 */
import { useState } from "react";
import type { NestedReport } from "@thingmaker/contracts";
import { useStore, sessionTitle } from "../store";
import type { ShownReport } from "../fork";
import { t } from "../i18n";

/** Opens a session of the workspace by its agent id: the live one, or a resume. */
function useOpenByAgentId() {
  const selectSession = useStore((s) => s.selectSession);
  const openSession = useStore((s) => s.openSession);
  return (workspaceId: string, agentSessionId: string) => {
    const live = Object.values(useStore.getState().sessions).find((session) => session.snapshot.agentSessionId === agentSessionId);
    if (live) selectSession(live.handle.id);
    else void openSession(workspaceId, { mode: "resume", session_id: agentSessionId });
  };
}

/** In a fork: the session it is nested under, and the switch for reporting back. */
export function NestedBanner({ sessionId }: { sessionId: string }) {
  const workspaceId = useStore((s) => s.sessions[sessionId]?.workspaceId);
  const agentSessionId = useStore((s) => s.sessions[sessionId]?.snapshot.agentSessionId ?? null);
  // Two plain values, so a store update elsewhere does not redraw it.
  const parentRow = useStore((s) => {
    if (!workspaceId || !agentSessionId) return null;
    const records = s.records[workspaceId] ?? [];
    const own = records.find((record) => record.agentSessionId === agentSessionId);
    if (own?.origin !== "fork" || !own.parentSessionId) return null;
    return records.find((record) => record.id === own.parentSessionId) ?? null;
  });
  const parentTitle = useStore((s) => {
    if (!parentRow || !workspaceId) return null;
    const live = Object.values(s.sessions).find((session) => session.snapshot.agentSessionId === parentRow.agentSessionId);
    return live ? sessionTitle(live, s.records[workspaceId]) : parentRow.titleOverlay || parentRow.autoTitle || t("its parent session");
  });
  const parent = parentRow && parentTitle ? { agentSessionId: parentRow.agentSessionId, title: parentTitle } : null;
  const reporting = useStore((s) => (agentSessionId ? s.reporting[agentSessionId] : undefined) ?? true);
  const setReporting = useStore((s) => s.setReporting);
  const open = useOpenByAgentId();
  if (!parent || !workspaceId || !agentSessionId) return null;
  return (
    <div className="nested-banner small">
      <span aria-hidden="true">↳</span>
      <span>
        {t("Nested in")}{" "}
        <button className="link" onClick={() => open(workspaceId, parent.agentSessionId)} type="button">
          {parent.title}
        </button>
      </span>
      <span className="composer-spacer" />
      <label className="nested-reporting" title={t("At the end of each turn, its answer is passed to “{name}” as context for its next message. It never starts work there.", { name: parent.title })}>
        <input checked={reporting} onChange={(event) => void setReporting(workspaceId, agentSessionId, event.target.checked)} type="checkbox" />
        {t("Reports back")}
      </label>
    </div>
  );
}

const NO_REPORTS: NestedReport[] = [];

/** In a parent: what its forks reported, waiting to go with your next message. */
export function NestedReportsStrip({ sessionId }: { sessionId: string }) {
  const workspaceId = useStore((s) => s.sessions[sessionId]?.workspaceId);
  const reports = useStore((s) => {
    const id = s.sessions[sessionId]?.snapshot.agentSessionId;
    return (id ? s.nestedReports[id] : undefined) ?? NO_REPORTS;
  });
  const [open, setOpen] = useState(false);
  const openSession = useOpenByAgentId();
  if (reports.length === 0 || !workspaceId) return null;
  return (
    <div className="nested-strip">
      <button aria-expanded={open} className="nested-strip-head small" onClick={() => setOpen(!open)} type="button">
        <span aria-hidden="true">↲</span>
        <span>
          {reports.length === 1
            ? t("“{name}” reported back", { name: reports[0]!.title })
            : t("{count} nested sessions reported back", { count: reports.length })}
        </span>
        <span className="muted">{t("· goes with your next message, as context")}</span>
      </button>
      {open && (
        <ul className="nested-strip-list">
          {reports.map((report) => (
            <li key={report.forkAgentSessionId}>
              <button className="link small" onClick={() => openSession(workspaceId, report.forkAgentSessionId)} type="button">
                {report.title}
              </button>
              <p className="small">{report.text}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** In the transcript: the reports a message to this session carried. */
export function NestedReportsCard({ reports, own }: { reports: ShownReport[]; own: string }) {
  return (
    <>
      <details className="card card-bigthing-turn card-side-note">
        <summary title={t("Passed on by sessions nested under this one, not written by you.")}>
          <span className="bigthing-turn-mark" aria-hidden="true">
            ↲
          </span>
          <span className="bigthing-turn-text">
            {reports.length === 1 ? t("“{name}” reported back", { name: reports[0]!.from }) : t("{count} nested sessions reported back", { count: reports.length })}
          </span>
        </summary>
        <ul className="bigthing-turn-prompt">
          {reports.map((report, index) => (
            <li key={index}>
              <strong>{report.from}</strong>: {report.text}
            </li>
          ))}
        </ul>
      </details>
      {own && (
        <article className="card card-user">
          <header className="small muted">{t("You")}</header>
          <pre className="text">{own}</pre>
        </article>
      )}
    </>
  );
}
