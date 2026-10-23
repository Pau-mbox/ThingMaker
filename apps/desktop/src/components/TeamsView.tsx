/**
 * Teams: saved teams — an orchestrator and its workers — to start a session
 * with or apply to one. One can be the default a new session starts from.
 * The list and the editor take the screen; the retry policy waits behind
 * Advanced at the bottom.
 */
import { useEffect, useState } from "react";
import { type JobRetryPolicy, type TeamPreset } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore } from "../store";
import { newPreset, teamSummary } from "../team";
import { STARTERS, modelName, starterCombo, starterLead, usableProviders, type Catalogs, type StarterId } from "../teamRoles";
import { tidyCombo } from "./TeamEditor";
import { TeamChart, roleNames, useCatalogs } from "./TeamChart";
import { ProviderBadge } from "./ProviderMark";
import { t } from "../i18n";

/** `Opus 5.5 leads · 2 helpers`, under a team's name in the list. */
function describe(preset: TeamPreset, catalogs: Catalogs): string {
  const lead = modelName(catalogs, preset.orchestrator.provider, preset.orchestrator.model) ?? t("Account default");
  const count = preset.combo.workers.length;
  return count === 0 ? t("{lead} leads, on its own", { lead }) : count === 1 ? t("{lead} leads · 1 helper", { lead }) : t("{lead} leads · {count} helpers", { lead, count });
}

/** The providers on a team, lead first, as a row of faces. */
function Faces({ preset }: { preset: TeamPreset }) {
  const providers = [preset.orchestrator.provider, ...preset.combo.workers.map((worker) => worker.provider)].slice(0, 6);
  return (
    <span className="teams-faces">
      {providers.map((provider, index) => (
        <ProviderBadge key={index} provider={provider} />
      ))}
    </span>
  );
}

function starterLabel(starter: StarterId): string {
  switch (starter) {
    case "solo":
      return t("Solo");
    case "reviewed":
      return t("Lead and reviewer");
    case "studio":
      return t("Lead, artist and reviewer");
    case "coders":
      return t("Lead and three coders");
  }
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
      <div className="row wrap teams-head">
        <input aria-label={t("Team name")} className="teams-name" onChange={(e) => setDraft({ ...draft, name: e.target.value })} value={draft.name} />
        <label className="small row">
          <input checked={isDefault} onChange={(e) => void setDefaultPreset(e.target.checked ? preset.id : null)} type="checkbox" />
          {t("New sessions start with this team")}
        </label>
      </div>

      <TeamChart combo={draft.combo} onChange={(orchestrator, combo) => setDraft({ ...draft, orchestrator, combo })} orchestrator={draft.orchestrator} />

      <div className="row wrap team-footer">
        <button className="button button-primary" disabled={!dirty} onClick={() => void saveTeamPreset({ ...draft, combo: tidyCombo(draft.combo) })} type="button">
          {t("Save team")}
        </button>
        {dirty && (
          <button className="button" onClick={() => setDraft(preset)} type="button">
            {t("Discard changes")}
          </button>
        )}
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
  const providers = useStore((s) => s.providers);
  const catalogs = useCatalogs();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    void loadTeamPresets();
  }, [loadTeamPresets]);
  const selected = presets.find((preset) => preset.id === selectedId) ?? presets[0];

  const create = async (starter: StarterId) => {
    const usable = usableProviders(providers);
    const orchestrator = starterLead(catalogs, usable);
    const preset = {
      ...newPreset(starterLabel(starter), presets.map((entry) => entry.name)),
      orchestrator,
      combo: starterCombo(starter, catalogs, usable, orchestrator.provider, roleNames()),
    };
    await saveTeamPreset(preset);
    setSelectedId(preset.id);
    setStarting(false);
  };
  const starters = (
    <div className="teams-starters" role="group" aria-label={t("Start from")}>
      <span className="small muted">{t("Start from")}</span>
      {(Object.keys(STARTERS) as StarterId[]).map((starter) => (
        <button className="teams-starter" key={starter} onClick={() => void create(starter)} type="button">
          {starterLabel(starter)}
          <span className="small muted">{STARTERS[starter].length === 0 ? t("one lead") : STARTERS[starter].length === 1 ? t("1 helper") : t("{count} helpers", { count: STARTERS[starter].length })}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="panel teams-view">
      <header className="teams-header">
        <h2>{t("Teams")}</h2>
      </header>
      <div className="teams-layout">
        <nav aria-label={t("Teams")} className="teams-list">
          <button aria-expanded={starting} className="button button-primary" onClick={() => setStarting(!starting)} type="button">
            {t("+ New team")}
          </button>
          {starting && starters}
          {presets.length === 0 && <p className="small muted">{t("No teams yet.")}</p>}
          <ul>
            {presets.map((preset) => (
              <li key={preset.id}>
                <button className={`teams-item ${selected?.id === preset.id ? "selected" : ""}`} onClick={() => setSelectedId(preset.id)} title={teamSummary(preset.combo)} type="button">
                  <span className="teams-item-name">
                    {preset.name}
                    {preset.id === defaultPresetId && <span className="chip small">{t("default")}</span>}
                  </span>
                  <Faces preset={preset} />
                  <span className="small muted">{describe(preset, catalogs)}</span>
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
              <p>{t("Make your first team: someone who leads, and helpers it can hand work to.")}</p>
              {starters}
            </div>
          )}
        </div>
      </div>
      <details className="teams-advanced">
        <summary>{t("Advanced")}</summary>
        <RetrySettings />
      </details>
    </div>
  );
}
