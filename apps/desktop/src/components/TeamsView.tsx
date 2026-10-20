/**
 * Teams: saved team presets — an orchestrator and its workers — to start a
 * session with or apply to one. One preset can be the default a new session
 * starts from.
 */
import { useEffect, useState } from "react";
import { PROVIDER_LABELS, type JobRetryPolicy, type TeamPreset } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore } from "../store";
import { newPreset, teamSummary } from "../team";
import { OrchestratorFields, WorkersEditor, tidyCombo } from "./TeamEditor";
import { t } from "../i18n";

function describe(preset: TeamPreset): string {
  const lead = [PROVIDER_LABELS[preset.orchestrator.provider], preset.orchestrator.model, preset.orchestrator.effort].filter(Boolean).join(" · ");
  return t("{lead} leads; {workers}", { lead, workers: preset.combo.workers.length === 0 ? t("no workers") : teamSummary(preset.combo) });
}

function PresetEditor({ preset, isDefault }: { preset: TeamPreset; isDefault: boolean }) {
  const saveTeamPreset = useStore((s) => s.saveTeamPreset);
  const deleteTeamPreset = useStore((s) => s.deleteTeamPreset);
  const setDefaultPreset = useStore((s) => s.setDefaultPreset);
  const presets = useStore((s) => s.teamPresets);
  const [draft, setDraft] = useState(preset);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setDraft(preset);
    setConfirmDelete(false);
  }, [preset]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(preset);
  return (
    <div className="teams-editor">
      <label className="field">
        {t("Preset name")}
        <input aria-label={t("Preset name")} className="input teams-name" onChange={(e) => setDraft({ ...draft, name: e.target.value })} value={draft.name} />
      </label>

      <section className="team-section">
        <h3>{t("Orchestrator")}</h3>
        <OrchestratorFields onChange={(orchestrator) => setDraft({ ...draft, orchestrator })} value={draft.orchestrator} />
      </section>

      <section className="team-section">
        <h3>{t("Workers")}</h3>
        <WorkersEditor combo={draft.combo} onChange={(combo) => setDraft({ ...draft, combo })} orchestrator={draft.orchestrator.provider} />
      </section>

      <div className="row wrap team-footer">
        <button className="button button-primary" disabled={!dirty} onClick={() => void saveTeamPreset({ ...draft, combo: tidyCombo(draft.combo) })} type="button">
          {t("Save preset")}
        </button>
        {dirty && (
          <button className="button" onClick={() => setDraft(preset)} type="button">
            {t("Discard changes")}
          </button>
        )}
        <label className="small row">
          <input checked={isDefault} onChange={(e) => void setDefaultPreset(e.target.checked ? preset.id : null)} type="checkbox" />
          {t("New sessions start with this team")}
        </label>
        <span className="composer-spacer" />
        <button
          className="button"
          onClick={() => void saveTeamPreset({ ...newPreset(t("{name} copy", { name: draft.name }), presets.map((entry) => entry.name)), orchestrator: draft.orchestrator, combo: tidyCombo(draft.combo) })}
          type="button"
        >
          {t("Duplicate")}
        </button>
        {confirmDelete ? (
          <button className="button button-warn" onClick={() => void deleteTeamPreset(preset.id)} type="button">
            {t("Delete “{name}”", { name: preset.name })}
          </button>
        ) : (
          <button className="button" onClick={() => setConfirmDelete(true)} type="button">
            {t("Delete…")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * What a job does when its worker hits a temporary limit: Codex's image
 * limit, an account's window, an overloaded server. Shown in minutes; kept
 * in seconds.
 */
function RetrySettings() {
  const [policy, setPolicy] = useState<JobRetryPolicy | null>(null);
  const [saved, setSaved] = useState<JobRetryPolicy | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    api
      .delegationRetryPolicyGet()
      .then((value) => {
        setPolicy(value);
        setSaved(value);
      })
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error)));
  }, []);
  if (problem) return <p className="small muted">{t("Retry settings are unavailable: {problem}", { problem })}</p>;
  if (!policy) return null;
  const minutes = (secs: number) => Math.round(secs / 60);
  const field = (label: string, key: "firstDelaySecs" | "stepSecs" | "maxDelaySecs" | "maxWaitSecs", hint: string) => (
    <label className="field" title={hint}>
      {label}
      <input
        className="input"
        min={1}
        onChange={(e) => setPolicy({ ...policy, [key]: Math.max(1, Number(e.target.value) || 1) * 60 })}
        type="number"
        value={minutes(policy[key])}
      />
    </label>
  );
  const dirty = JSON.stringify(policy) !== JSON.stringify(saved);
  return (
    <section className="team-section">
      <h3>{t("When a worker hits a temporary limit")}</h3>
      <p className="small muted">
        {t(
          "Codex's image generation limit, an account's usage window or an overloaded server stop a job for a while, not for good. The job waits — until the provider's own reset when it names one — then the same worker session carries on, so it keeps its context. Image jobs started meanwhile wait too. The orchestrator sees the job as waiting and can carry on with other work.",
        )}
      </p>
      <label className="small row">
        <input checked={policy.enabled} onChange={(e) => setPolicy({ ...policy, enabled: e.target.checked })} type="checkbox" />
        {t("Wait and retry")}
      </label>
      {policy.enabled && (
        <div className="team-grid team-grid-worker">
          {field(t("First wait (min)"), "firstDelaySecs", t("When the provider names no reset time"))}
          {field(t("Longer each time by (min)"), "stepSecs", t("Added to the wait on each retry"))}
          {field(t("Longest wait (min)"), "maxDelaySecs", t("No single wait is longer than this"))}
          <label className="field">
            {t("Retries")}
            <input className="input" min={0} onChange={(e) => setPolicy({ ...policy, maxAttempts: Math.max(0, Number(e.target.value) || 0) })} type="number" value={policy.maxAttempts} />
          </label>
          {field(t("Give up after (min)"), "maxWaitSecs", t("From when the job started; a reset later than this fails the job at once"))}
        </div>
      )}
      <div className="row">
        <button
          className="button button-small button-primary"
          disabled={!dirty}
          onClick={() =>
            void api
              .delegationRetryPolicySet(policy)
              .then((value) => {
                setPolicy(value);
                setSaved(value);
              })
              .catch((error: unknown) => setProblem(String((error as { message?: string })?.message ?? error)))
          }
          type="button"
        >
          {t("Save")}
        </button>
        <span className="small muted">
          {policy.enabled
            ? t("Waits {first}, then up to {longest} min between tries; {retries} retries, {total} min at most.", {
                first: minutes(policy.firstDelaySecs),
                longest: minutes(policy.maxDelaySecs),
                retries: policy.maxAttempts,
                total: minutes(policy.maxWaitSecs),
              })
            : t("Off: a job stopped by a limit fails, and the orchestrator decides.")}
        </span>
      </div>
    </section>
  );
}

export function TeamsView() {
  const presets = useStore((s) => s.teamPresets);
  const defaultPresetId = useStore((s) => s.defaultPresetId);
  const saveTeamPreset = useStore((s) => s.saveTeamPreset);
  const loadTeamPresets = useStore((s) => s.loadTeamPresets);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    void loadTeamPresets();
  }, [loadTeamPresets]);
  const selected = presets.find((preset) => preset.id === selectedId) ?? presets[0];

  const create = async () => {
    const preset = newPreset(t("New team"), presets.map((entry) => entry.name));
    await saveTeamPreset(preset);
    setSelectedId(preset.id);
  };

  return (
    <div className="panel teams-view">
      <header className="teams-header">
        <h2>{t("Teams")}</h2>
        <p className="small muted">
          {t(
            "A team is an orchestrator and the workers it may delegate to, on any provider and model. Save the combinations you use as presets, then start a session with one or apply one from a session's team button. Workers run on your subscriptions through each provider's own program.",
          )}
        </p>
      </header>
      <RetrySettings />
      <div className="teams-layout">
        <nav aria-label={t("Team presets")} className="teams-list">
          <button className="button button-primary" onClick={() => void create()} type="button">
            {t("+ New preset")}
          </button>
          {presets.length === 0 && <p className="small muted">{t("No presets yet.")}</p>}
          <ul>
            {presets.map((preset) => (
              <li key={preset.id}>
                <button className={`teams-item ${selected?.id === preset.id ? "selected" : ""}`} onClick={() => setSelectedId(preset.id)} title={describe(preset)} type="button">
                  <span className="teams-item-name">
                    {preset.name}
                    {preset.id === defaultPresetId && <span className="chip small">{t("default")}</span>}
                  </span>
                  <span className="small muted">{describe(preset)}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="teams-detail">
          {selected ? (
            <PresetEditor isDefault={selected.id === defaultPresetId} key={selected.id} preset={selected} />
          ) : (
            <div className="teams-empty">
              <p>{t("Make your first team: for example Claude Opus leading, with a Codex worker for images and quick edits and a Sonnet worker for reviews.")}</p>
              <button className="button button-primary" onClick={() => void create()} type="button">
                {t("+ New preset")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
