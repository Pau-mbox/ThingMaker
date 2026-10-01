import { useEffect, useState } from "react";
import { PROVIDERS, PROVIDER_LABELS } from "@thingmaker/contracts";
import { useStore } from "../store";
import { WorktreesSection } from "./WorktreesSection";
import { OutboxPanel } from "./OutboxPanel";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function WorkspaceView({ workspaceId }: { workspaceId: string }) {
  const inspection = useStore((s) => s.inspections[workspaceId]);
  const openSession = useStore((s) => s.openSession);
  const inspectWorkspace = useStore((s) => s.inspectWorkspace);
  const loadRecords = useStore((s) => s.loadRecords);
  const records = useStore((s) => s.records[workspaceId]);
  const providers = useStore((s) => s.providers);
  const presets = useStore((s) => s.teamPresets);
  const defaultPresetId = useStore((s) => s.defaultPresetId);
  const openSessionWithPreset = useStore((s) => s.openSessionWithPreset);
  const setView = useStore((s) => s.setView);
  const addWorkspaceByPath = useStore((s) => s.addWorkspaceByPath);
  const [manualPath, setManualPath] = useState("");

  useEffect(() => {
    if (!inspection) void inspectWorkspace(workspaceId);
    else if (!records) void loadRecords(workspaceId);
  }, [inspection, workspaceId, inspectWorkspace, loadRecords, records]);

  if (!inspection) {
    return (
      <div className="panel">
        <p className="muted">Inspecting workspace…</p>
      </div>
    );
  }

  const trusted = inspection.record.trustState === "trusted_local" && !inspection.trustStale;
  // Workers a delegation opened belong to their orchestrator: they are under
  // it in the sidebar and in its Agents tab, not in the workspace's list.
  const listed = (records ?? []).filter((record) => record.archiveState !== "unavailable" && !record.parentSessionId);
  const sessionLabel = (id: string, title?: string) => (title && title !== id ? title : `Session ${id.replace(/^(cx|tm)-/, "").slice(0, 8)}`);

  return (
    <div className="panel workspace-view">
      <section>
        <h3>Identity</h3>
        <dl className="facts">
          <dt>Canonical root</dt>
          <dd className="mono">{inspection.identity.canonicalRoot}</dd>
          <dt>Workspace id</dt>
          <dd className="mono">{inspection.identity.workspaceHash.slice(0, 18)}</dd>
          <dt>Kind</dt>
          <dd>
            {inspection.isGitRepository ? "Git repository" : "Folder (non-Git)"}
            {inspection.isUnityProject ? ", Unity project" : ""}
          </dd>
        </dl>
      </section>

      <OutboxPanel workspaceId={workspaceId} />

      <section>
        <h3>Agent configuration in this workspace</h3>
        <p className="small muted">What an agent started here reads and may run. Agents run with your user account's authority.</p>
        <ul className="sources">
          {inspection.sources.map((source) => (
            <li className={source.present ? "" : "muted"} key={source.path}>
              <span className="mono">{source.path}</span>{" "}
              {source.present ? (
                <>
                  <span className="small">({formatBytes(source.bytes)})</span>
                  {source.executable && <span className="chip chip-warn small">runs when an agent starts</span>}
                  {source.summary.length > 0 && (
                    <ul className="small">
                      {source.summary.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <span className="small">absent</span>
              )}
            </li>
          ))}
        </ul>
        <p className="small muted mono">fingerprint {inspection.trustDigest.slice(0, 16)}</p>
      </section>


      <section>
        <h3>Sessions</h3>
        <div className="row wrap">
          {PROVIDERS.map((provider) => {
            const info = providers?.find((entry) => entry.provider === provider);
            const available = !!info?.resolved;
            return (
              <button
                className={`button ${provider === PROVIDERS[0] ? "button-primary" : ""}`}
                disabled={!trusted || !available}
                key={provider}
                onClick={() => void openSession(workspaceId, { mode: "new" }, provider)}
                title={available ? `Start a ${PROVIDER_LABELS[provider]} session` : (info?.problem ?? `${PROVIDER_LABELS[provider]} is not set up; see Providers`)}
                type="button"
              >
                New {PROVIDER_LABELS[provider]} session
              </button>
            );
          })}
          <button className="button" onClick={() => void loadRecords(workspaceId)} type="button">
            Refresh
          </button>
        </div>
        <div className="row wrap">
          <span className="small muted">Start with a team:</span>
          {presets.map((preset) => {
            const available = !!providers?.find((entry) => entry.provider === preset.orchestrator.provider)?.resolved;
            return (
              <button
                className="button button-small"
                disabled={!trusted || !available}
                key={preset.id}
                onClick={() => void openSessionWithPreset(workspaceId, preset)}
                title={`${PROVIDER_LABELS[preset.orchestrator.provider]}${preset.orchestrator.model ? ` · ${preset.orchestrator.model}` : ""} leads; ${preset.combo.workers.map((worker) => worker.name).join(", ") || "no workers"}`}
                type="button"
              >
                {preset.name}
                {preset.id === defaultPresetId ? " (default)" : ""}
              </button>
            );
          })}
          <button className="link small" onClick={() => setView({ kind: "teams" })} type="button">
            {presets.length === 0 ? "Make a team preset…" : "Edit teams…"}
          </button>
        </div>
        {listed.length > 0 ? (
          <ul className="sessions">
            {listed.map((record) => (
              <li className="row wrap" key={record.id}>
                <span className="sidebar-title">{sessionLabel(record.agentSessionId, record.titleOverlay)}</span>
                <span className="chip small">{PROVIDER_LABELS[record.provider]}</span>
                {record.lastSeen && <span className="small muted">{new Date(record.lastSeen).toLocaleString()}</span>}
                <span className="mono small muted" title={record.agentSessionId}>
                  {record.agentSessionId.slice(0, 14)}…
                </span>
                <button className="button button-small" disabled={!trusted} onClick={() => void openSession(workspaceId, { mode: "resume", session_id: record.agentSessionId })} type="button">
                  Resume
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">No sessions in this workspace yet.</p>
        )}
      </section>

      {inspection.isGitRepository && trusted && <WorktreesSection workspaceId={workspaceId} />}

      <section>
        <h3>Add another workspace by path</h3>
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            void addWorkspaceByPath(manualPath);
            setManualPath("");
          }}
        >
          <input aria-label="Workspace path" className="input" onChange={(e) => setManualPath(e.target.value)} placeholder="/path/to/project" value={manualPath} />
          <button className="button" type="submit">
            Inspect
          </button>
        </form>
      </section>
    </div>
  );
}
