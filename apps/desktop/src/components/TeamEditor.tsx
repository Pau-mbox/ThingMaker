/**
 * Teams: who leads a session and who it may delegate to
 * (docs/research/multi-provider-viability.md §2.2).
 *
 * - `OrchestratorFields` and `WorkersEditor` are controlled editors shared by
 *   the session's team panel and the Teams view's presets.
 * - `TeamPanel` is the session's own: pick a preset or edit freely, then
 *   apply. Workers change at once (the next `delegate` uses them); the
 *   orchestrator's model and effort go through its own options; another
 *   provider is a handoff, labelled as one.
 * - `TeamChip` opens it from the composer.
 *
 * Model lists come from each provider's own catalog; nothing is hardcoded.
 */
import { useEffect, useMemo, useState } from "react";
import {
  ORCHESTRATOR_PROVIDERS,
  PROVIDERS,
  PROVIDER_LABELS,
  WORKER_CAPABILITIES,
  asConfigOptions,
  isEffortOption,
  type Combo,
  type OrchestratorChoice,
  type Provider,
  type ProviderModel,
  type QuotaSnapshot,
  type TeamPreset,
  type WorkerSlot,
} from "@thingmaker/contracts";
import { useStore } from "../store";
import { newPreset, presetMatches, presetWorker, teamSummary, uniqueName } from "../team";
import { ProviderBadge } from "./ProviderMark";
import { fill } from "./BigThingTeam";
import { t } from "../i18n";

function quotaLine(quota: QuotaSnapshot | undefined): string | null {
  if (!quota) return null;
  if (quota.status === "rejected") return t("out of quota");
  const used = quota.windows.map((window) => window.usedPercent).filter((value): value is number => value !== undefined);
  return used.length > 0 ? t("{percent}% of its tightest window used", { percent: Math.round(Math.max(...used)) }) : null;
}

/** Loads both providers' catalogs once for any editor on screen. */
function useCatalogs(): Partial<Record<Provider, ProviderModel[]>> {
  const loadProviderModels = useStore((s) => s.loadProviderModels);
  const providerModels = useStore((s) => s.providerModels);
  useEffect(() => {
    for (const provider of PROVIDERS) void loadProviderModels(provider);
  }, [loadProviderModels]);
  return providerModels;
}

function ModelSelect({ models, value, onChange, label }: { models: ProviderModel[] | undefined; value: string | undefined; onChange: (id: string | undefined) => void; label: string }) {
  const known = models?.some((model) => model.id === value);
  return (
    <select aria-label={label} className="input select" onChange={(e) => onChange(e.target.value || undefined)} value={value ?? ""}>
      <option value="">{t("Account default")}</option>
      {value && !known && <option value={value}>{value}</option>}
      {(models ?? []).map((model) => (
        <option key={model.id} value={model.id} title={model.description}>
          {model.name}
          {model.needsCredits ? ` ${t("(usage credits)")}` : ""}
        </option>
      ))}
    </select>
  );
}

function EffortSelect({ efforts, value, onChange, label }: { efforts: string[]; value: string | undefined; onChange: (effort: string | undefined) => void; label: string }) {
  return (
    <select aria-label={label} className="input select" disabled={efforts.length === 0 && !value} onChange={(e) => onChange(e.target.value || undefined)} value={value ?? ""}>
      <option value="">{t("Default")}</option>
      {value && !efforts.includes(value) && <option value={value}>{value}</option>}
      {efforts.map((effort) => (
        <option key={effort} value={effort}>
          {effort}
        </option>
      ))}
    </select>
  );
}

function effortsFor(models: ProviderModel[] | undefined, model: string | undefined): string[] {
  const chosen = models?.find((entry) => entry.id === model) ?? models?.find((entry) => entry.isDefault) ?? models?.[0];
  return chosen?.efforts ?? [];
}

/** The orchestrator's provider, model and effort. */
export function OrchestratorFields({ value, onChange }: { value: OrchestratorChoice; onChange: (value: OrchestratorChoice) => void }) {
  const catalogs = useCatalogs();
  const models = catalogs[value.provider];
  return (
    <div className="team-grid team-grid-orchestrator">
      <label className="field">
        {t("Provider")}
        <select
          aria-label={t("Orchestrator provider")}
          className="input select"
          onChange={(e) => onChange({ provider: e.target.value as Provider })}
          value={value.provider}
        >
          {ORCHESTRATOR_PROVIDERS.map((provider) => (
            <option key={provider} value={provider}>
              {PROVIDER_LABELS[provider]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        {t("Model")}
        <ModelSelect
          label={t("Orchestrator model")}
          models={models}
          onChange={(model) => {
            const { model: _model, effort: _effort, ...rest } = value;
            onChange({ ...rest, ...(model ? { model } : {}), ...(value.effort && effortsFor(models, model).includes(value.effort) ? { effort: value.effort } : {}) });
          }}
          value={value.model}
        />
      </label>
      <label className="field">
        {t("Effort")}
        <EffortSelect
          efforts={effortsFor(models, value.model)}
          label={t("Orchestrator effort")}
          onChange={(effort) => {
            const { effort: _effort, ...rest } = value;
            onChange({ ...rest, ...(effort ? { effort } : {}) });
          }}
          value={value.effort}
        />
      </label>
    </div>
  );
}

function WorkerCard({ worker, models, quota, onChange, onRemove }: { worker: WorkerSlot; models: ProviderModel[] | undefined; quota: QuotaSnapshot | undefined; onChange: (worker: WorkerSlot) => void; onRemove: () => void }) {
  const toggle = (capability: string) =>
    onChange({
      ...worker,
      capabilities: worker.capabilities.includes(capability) ? worker.capabilities.filter((own) => own !== capability) : [...worker.capabilities, capability],
    });
  const status = quotaLine(quota);
  return (
    <li className="team-worker">
      <div className="team-worker-head">
        <strong>{worker.name.trim() || t("Unnamed worker")}</strong>
        <ProviderBadge provider={worker.provider} />
        <span className="composer-spacer" />
        <button aria-label={t("Remove {name}", { name: worker.name || t("worker") })} className="button button-small" onClick={onRemove} type="button">
          {t("Remove")}
        </button>
      </div>
      <div className="team-grid team-grid-worker">
        <label className="field">
          {t("Name")}
          <input
            aria-label={t("Worker name")}
            className="input"
            onChange={(e) => onChange({ ...worker, name: e.target.value })}
            placeholder={t("what the orchestrator calls it")}
            value={worker.name}
          />
        </label>
        <label className="field">
          {t("Provider")}
          <select
            aria-label={t("Worker provider")}
            className="input select"
            onChange={(e) => {
              const { model: _model, effort: _effort, ...rest } = worker;
              onChange({ ...rest, provider: e.target.value as Provider });
            }}
            value={worker.provider}
          >
            {PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {PROVIDER_LABELS[provider]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t("Model")}
          <ModelSelect
            label={t("Worker model")}
            models={models}
            onChange={(model) => {
              const { model: _model, effort: _effort, ...rest } = worker;
              const next = models?.find((entry) => entry.id === model);
              onChange({ ...rest, ...(model ? { model } : {}), ...(next?.defaultEffort ? { effort: next.defaultEffort } : {}) });
            }}
            value={worker.model}
          />
        </label>
        <label className="field">
          {t("Effort")}
          <EffortSelect
            efforts={effortsFor(models, worker.model)}
            label={t("Worker effort")}
            onChange={(effort) => {
              const { effort: _effort, ...rest } = worker;
              onChange({ ...rest, ...(effort ? { effort } : {}) });
            }}
            value={worker.effort}
          />
        </label>
      </div>
      <div className="field">
        {t("Good at")}
        <div className="row wrap">
          {WORKER_CAPABILITIES.map((capability) => (
            <button
              aria-pressed={worker.capabilities.includes(capability)}
              className={`chip chip-button small ${worker.capabilities.includes(capability) ? "chip-on" : ""}`}
              key={capability}
              onClick={() => toggle(capability)}
              type="button"
            >
              {capability}
            </button>
          ))}
          {status && <span className={`small ${quota?.status === "rejected" ? "chip-warn-text" : "muted"}`}>{PROVIDER_LABELS[worker.provider]}: {status}</span>}
        </div>
      </div>
      <label className="field">
        {t("When to use it")}
        <input
          aria-label={t("When to use this worker")}
          className="input"
          onChange={(e) => {
            const { note: _note, ...rest } = worker;
            onChange({ ...rest, ...(e.target.value ? { note: e.target.value } : {}) });
          }}
          placeholder={t("Optional, read by the orchestrator: e.g. “all image and icon work”, “quick refactors and test runs”")}
          value={worker.note ?? ""}
        />
      </label>
    </li>
  );
}

/** The workers of a team, and whether the orchestrator keeps its own subagents. */
export function WorkersEditor({ combo, onChange, orchestrator }: { combo: Combo; onChange: (combo: Combo) => void; orchestrator: Provider }) {
  const catalogs = useCatalogs();
  const quotas = useStore((s) => s.quotas);
  const names = combo.workers.map((worker) => worker.name);
  const duplicate = names.find((name, index) => name.trim() !== "" && names.findIndex((other) => other.trim().toLowerCase() === name.trim().toLowerCase()) !== index);
  return (
    <div className="team-editor">
      {combo.workers.length === 0 ? (
        <p className="small muted">
          {fill(
            t(
              "No workers: the orchestrator works alone. Add one and the orchestrator can hand it tasks through its {tools} tools — for example a Codex worker for images and quick edits under a Claude orchestrator.",
            ),
            { tools: <code>team</code> },
          )}
        </p>
      ) : (
        <ul className="team-workers">
          {combo.workers.map((worker, index) => (
            <WorkerCard
              key={index}
              models={catalogs[worker.provider]}
              onChange={(next) => onChange({ ...combo, workers: combo.workers.map((existing, at) => (at === index ? next : existing)) })}
              onRemove={() => onChange({ ...combo, workers: combo.workers.filter((_, at) => at !== index) })}
              quota={quotas[worker.provider]}
              worker={worker}
            />
          ))}
        </ul>
      )}
      <div className="row wrap">
        {PROVIDERS.map((provider) => (
          <button className="button button-small" key={provider} onClick={() => onChange({ ...combo, workers: [...combo.workers, presetWorker(provider, catalogs[provider], names)] })} type="button">
            {t("+ {provider} worker", { provider: PROVIDER_LABELS[provider] })}
          </button>
        ))}
      </div>
      {duplicate && <p className="small chip-warn-text">{t("Two workers are called “{name}”; the second will be renamed.", { name: duplicate })}</p>}
      <label className="small row">
        <input checked={combo.nativeSubagents} onChange={(e) => onChange({ ...combo, nativeSubagents: e.target.checked })} type="checkbox" />
        {t("Also let the orchestrator start its own {provider} subagents", { provider: PROVIDER_LABELS[orchestrator] })}
        <span className="muted">{t("— read when a session starts")}</span>
      </label>
    </div>
  );
}

/** Names filled in, so what is saved is what the orchestrator will read. */
export function tidyCombo(combo: Combo): Combo {
  const names = combo.workers.map((worker) => worker.name);
  return {
    ...combo,
    workers: combo.workers.map((worker, index) => ({ ...worker, name: worker.name.trim() || uniqueName(worker.model ?? worker.provider, names.filter((_, at) => at !== index)) })),
  };
}

type Draft = { orchestrator: OrchestratorChoice; combo: Combo };

/** The session's team, in full: preset, orchestrator, workers. */
export function TeamPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const team = useStore((s) => s.teams[sessionId]);
  const presets = useStore((s) => s.teamPresets);
  const saveTeam = useStore((s) => s.saveTeam);
  const setConfigOption = useStore((s) => s.setConfigOption);
  const saveTeamPreset = useStore((s) => s.saveTeamPreset);
  const handOff = useStore((s) => s.handOff);
  const provider = session?.snapshot.provider ?? "claude";
  const options = asConfigOptions(session?.snapshot.configOptions);
  const modelOption = options.find((option) => option.configId === "model");
  const effortOption = options.find((option) => isEffortOption(option.configId));
  const current: Draft = useMemo(() => {
    const model = typeof modelOption?.currentValue === "string" && modelOption.currentValue !== "default" ? modelOption.currentValue : undefined;
    const effort = typeof effortOption?.currentValue === "string" && effortOption.currentValue !== "default" ? effortOption.currentValue : undefined;
    return { orchestrator: { provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, combo: team ?? { workers: [], nativeSubagents: false } };
  }, [provider, modelOption?.currentValue, effortOption?.currentValue, team]);
  const [draft, setDraft] = useState<Draft>(current);
  const [presetId, setPresetId] = useState<string>(() => presets.find((preset) => presetMatches(preset, provider, team))?.id ?? "");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!session) return null;

  const selected = presets.find((preset) => preset.id === presetId);
  const crossProvider = draft.orchestrator.provider !== provider;
  const dirty = JSON.stringify(draft) !== JSON.stringify(current);

  const pickPreset = (id: string) => {
    setPresetId(id);
    const preset = presets.find((entry) => entry.id === id);
    if (preset) setDraft({ orchestrator: preset.orchestrator, combo: preset.combo });
  };

  const apply = async () => {
    setBusy(true);
    try {
      const combo = tidyCombo(draft.combo);
      if (crossProvider) {
        onClose();
        await handOff(sessionId, draft.orchestrator.provider, { id: "draft", name: "draft", orchestrator: draft.orchestrator, combo, updatedAt: Date.now() });
        return;
      }
      await saveTeam(sessionId, combo);
      if (modelOption && draft.orchestrator.model && draft.orchestrator.model !== current.orchestrator.model) await setConfigOption(sessionId, modelOption.configId, draft.orchestrator.model);
      if (effortOption && draft.orchestrator.effort && draft.orchestrator.effort !== current.orchestrator.effort) await setConfigOption(sessionId, effortOption.configId, draft.orchestrator.effort);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const saveAsNew = async () => {
    const preset: TeamPreset = { ...newPreset(newName, presets.map((entry) => entry.name)), orchestrator: draft.orchestrator, combo: tidyCombo(draft.combo) };
    await saveTeamPreset(preset);
    setPresetId(preset.id);
    setNewName("");
  };

  return (
    <div aria-modal="true" className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()} role="dialog">
      <div aria-label={t("Team")} className="modal team-modal">
        <div className="row">
          <h2>{t("Team")}</h2>
          <span className="small muted">{teamSummary(current.combo)}</span>
          <span className="composer-spacer" />
          <button aria-label={t("Close")} className="button button-small" onClick={onClose} type="button">
            {t("Close")}
          </button>
        </div>

        <section className="team-section">
          <h3>{t("Preset")}</h3>
          <div className="row wrap">
            <select aria-label={t("Team preset")} className="input select team-preset-select" onChange={(e) => pickPreset(e.target.value)} value={presetId}>
              <option value="">{presets.length === 0 ? t("No presets yet") : t("Custom (this session's own)")}</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.combo.workers.length === 1
                    ? t("{name} — {provider}, {count} worker", { name: preset.name, provider: PROVIDER_LABELS[preset.orchestrator.provider], count: 1 })
                    : t("{name} — {provider}, {count} workers", { name: preset.name, provider: PROVIDER_LABELS[preset.orchestrator.provider], count: preset.combo.workers.length })}
                </option>
              ))}
            </select>
            {selected && (
              <button className="button button-small" disabled={busy} onClick={() => void saveTeamPreset({ ...selected, orchestrator: draft.orchestrator, combo: tidyCombo(draft.combo) })} type="button">
                {t("Update “{name}”", { name: selected.name })}
              </button>
            )}
            <input aria-label={t("New preset name")} className="input team-preset-name" onChange={(e) => setNewName(e.target.value)} placeholder={t("New preset name")} value={newName} />
            <button className="button button-small" disabled={busy} onClick={() => void saveAsNew()} type="button">
              {t("Save as new preset")}
            </button>
          </div>
          <p className="small muted">{t("Picking a preset fills the fields below; nothing changes until you apply. Presets are managed in Teams, beside Settings.")}</p>
        </section>

        <section className="team-section">
          <h3>{t("Orchestrator")}</h3>
          <OrchestratorFields onChange={(orchestrator) => setDraft({ ...draft, orchestrator })} value={draft.orchestrator} />
          {crossProvider ? (
            <p className="small chip-warn-text">
              {t(
                "A {provider} orchestrator is a new session: applying hands off, with this team and a brief of the conversation in its composer. The new orchestrator re-reads the context, which costs tokens.",
                { provider: PROVIDER_LABELS[draft.orchestrator.provider] },
              )}
            </p>
          ) : (
            <p className="small muted">{t("Model and effort change in place; the conversation is kept.")}</p>
          )}
        </section>

        <section className="team-section">
          <h3>{t("Workers")}</h3>
          <WorkersEditor combo={draft.combo} onChange={(combo) => setDraft({ ...draft, combo })} orchestrator={draft.orchestrator.provider} />
        </section>

        <div className="row team-footer">
          <button className="button button-primary" disabled={busy || !dirty} onClick={() => void apply()} type="button">
            {crossProvider ? t("Hand off to {provider}", { provider: PROVIDER_LABELS[draft.orchestrator.provider] }) : t("Apply to this session")}
          </button>
          {dirty && (
            <button className="button" onClick={() => setDraft(current)} type="button">
              {t("Discard changes")}
            </button>
          )}
          <span className="small muted">{t("Workers apply to the next delegation; running jobs keep the worker they have.")}</span>
        </div>
      </div>
    </div>
  );
}

/** The composer's team button: what the session's team is, one click from the panel. */
export function TeamChip({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const team = useStore((s) => s.teams[sessionId]);
  const running = useStore((s) => (s.jobs[sessionId] ?? []).filter((job) => job.status === "starting" || job.status === "running").length);
  const [open, setOpen] = useState(false);
  if (!team) return null;
  const label = team.workers.length === 0 ? t("solo") : team.workers.map((worker) => worker.name).join(" + ");
  return (
    <>
      <button className={`chip chip-button ${running > 0 ? "chip-active" : ""}`} disabled={disabled} onClick={() => setOpen(true)} title={t("Team: {summary}", { summary: teamSummary(team) })} type="button">
        {t("team: {label}", { label })}
        {running > 0 ? ` · ${t("{count} working", { count: running })}` : ""}
      </button>
      {open && <TeamPanel onClose={() => setOpen(false)} sessionId={sessionId} />}
    </>
  );
}
