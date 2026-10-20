import { useEffect, useState } from "react";
import { PROVIDERS, PROVIDER_LABELS } from "@thingmaker/contracts";
import { useStore } from "../store";
import { WorktreesSection } from "./WorktreesSection";
import { OutboxPanel } from "./OutboxPanel";
import { t } from "../i18n";

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
        <p className="muted">{t("Inspecting workspace…")}</p>
      </div>
    );
  }

  const trusted = inspection.record.trustState === "trusted_local" && !inspection.trustStale;
  // Workers a delegation opened belong to their orchestrator: they are under
  // it in the sidebar and in its Agents tab, not in the workspace's list.
  const listed = (records ?? []).filter((record) => record.archiveState !== "unavailable" && !record.parentSessionId);
  const sessionLabel = (id: string, title?: string) => (title && title !== id ? title : t("Session {id}", { id: id.replace(/^(cx|tm)-/, "").slice(0, 8) }));

  return (
    <div className="panel workspace-view">
      <section>
        <h3>{t("Identity")}</h3>
        <dl className="facts">
          <dt>{t("Canonical root")}</dt>
          <dd className="mono">{inspection.identity.canonicalRoot}</dd>
          <dt>{t("Workspace id")}</dt>
          <dd className="mono">{inspection.identity.workspaceHash.slice(0, 18)}</dd>
          <dt>{t("Kind")}</dt>
          <dd>
            {inspection.isGitRepository
              ? inspection.isUnityProject
                ? t("Git repository, Unity project")
                : t("Git repository")
              : inspection.isUnityProject
                ? t("Folder (non-Git), Unity project")
                : t("Folder (non-Git)")}
          </dd>
        </dl>
      </section>

      <OutboxPanel workspaceId={workspaceId} />

      <section>
        <h3>{t("Agent configuration in this workspace")}</h3>
        <p className="small muted">{t("What an agent started here reads and may run. Agents run with your user account's authority.")}</p>
        <ul className="sources">
          {inspection.sources.map((source) => (
            <li className={source.present ? "" : "muted"} key={source.path}>
              <span className="mono">{source.path}</span>{" "}
              {source.present ? (
                <>
                  <span className="small">({formatBytes(source.bytes)})</span>
                  {source.executable && <span className="chip chip-warn small">{t("runs when an agent starts")}</span>}
                  {source.summary.length > 0 && (
                    <ul className="small">
                      {source.summary.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <span className="small">{t("absent")}</span>
              )}
            </li>
          ))}
        </ul>
        <p className="small muted mono">{t("fingerprint {digest}", { digest: inspection.trustDigest.slice(0, 16) })}</p>
      </section>


      <section>
        <h3>{t("Sessions")}</h3>
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
                title={available ? t("Start a {provider} session", { provider: PROVIDER_LABELS[provider] }) : (info?.problem ?? t("{provider} is not set up; see Providers", { provider: PROVIDER_LABELS[provider] }))}
                type="button"
              >
                {t("New {provider} session", { provider: PROVIDER_LABELS[provider] })}
              </button>
            );
          })}
          <button className="button" onClick={() => void loadRecords(workspaceId)} type="button">
            {t("Refresh")}
          </button>
        </div>
        <div className="row wrap">
          <span className="small muted">{t("Start with a team:")}</span>
          {presets.map((preset) => {
            const available = !!providers?.find((entry) => entry.provider === preset.orchestrator.provider)?.resolved;
            return (
              <button
                className="button button-small"
                disabled={!trusted || !available}
                key={preset.id}
                onClick={() => void openSessionWithPreset(workspaceId, preset)}
                title={t("{lead} leads; {workers}", {
                  lead: `${PROVIDER_LABELS[preset.orchestrator.provider]}${preset.orchestrator.model ? ` · ${preset.orchestrator.model}` : ""}`,
                  workers: preset.combo.workers.map((worker) => worker.name).join(", ") || t("no workers"),
                })}
                type="button"
              >
                {preset.name}
                {preset.id === defaultPresetId ? ` ${t("(default)")}` : ""}
              </button>
            );
          })}
          <button className="link small" onClick={() => setView({ kind: "teams" })} type="button">
            {presets.length === 0 ? t("Make a team preset…") : t("Edit teams…")}
          </button>
        </div>
        {listed.length > 0 ? (
          <ul className="sessions">
            {listed.map((record) => (
              <li className="row wrap" key={record.id}>
                <span className="sidebar-title">{sessionLabel(record.agentSessionId, record.titleOverlay || record.autoTitle || undefined)}</span>
                <span className="chip small">{PROVIDER_LABELS[record.provider]}</span>
                {record.lastSeen && <span className="small muted">{new Date(record.lastSeen).toLocaleString()}</span>}
                <span className="mono small muted" title={record.agentSessionId}>
                  {record.agentSessionId.slice(0, 14)}…
                </span>
                <button className="button button-small" disabled={!trusted} onClick={() => void openSession(workspaceId, { mode: "resume", session_id: record.agentSessionId })} type="button">
                  {t("Resume")}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">{t("No sessions in this workspace yet.")}</p>
        )}
      </section>

      {inspection.isGitRepository && trusted && <WorktreesSection workspaceId={workspaceId} />}

      <section>
        <h3>{t("Add another workspace by path")}</h3>
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            void addWorkspaceByPath(manualPath);
            setManualPath("");
          }}
        >
          <input aria-label={t("Workspace path")} className="input" onChange={(e) => setManualPath(e.target.value)} placeholder="/path/to/project" value={manualPath} />
          <button className="button" type="submit">
            {t("Inspect")}
          </button>
        </form>
      </section>
    </div>
  );
}
