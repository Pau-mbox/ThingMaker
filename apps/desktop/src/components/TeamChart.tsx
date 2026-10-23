/**
 * A team as an org chart: who leads on top, the helpers it may hand work to
 * underneath, joined by lines. "Add a helper" and a node's model open one
 * picker with every model, grouped by provider; a node opens its editor
 * below the chart. Controlled: it edits an orchestrator and a combo and
 * hands both back.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ORCHESTRATOR_PROVIDERS, PROVIDERS, PROVIDER_LABELS, WORKER_CAPABILITIES, type Combo, type OrchestratorChoice, type Provider, type ProviderModel, type WorkerSlot } from "@thingmaker/contracts";
import { useStore } from "../store";
import { ROLE_IDS, modelName, roleEffort, roleOf, roleWorker, suggestModel, usableProviders, withRole, type Catalogs, type RoleId } from "../teamRoles";
import { ProviderLogo } from "./ProviderLogo";
import { IconAgents, IconBolt, IconCode, IconDoc, IconEyeCheck, IconPalette, IconPlus, IconSearch } from "./icons";
import { t } from "../i18n";

export function roleLabel(role: RoleId | null): string {
  switch (role) {
    case "coder":
      return t("Coder");
    case "artist":
      return t("Artist");
    case "reviewer":
      return t("Reviewer");
    case "researcher":
      return t("Researcher");
    case "quick":
      return t("Quick helper");
    default:
      return t("Custom");
  }
}

function roleDoes(role: RoleId | null, worker: WorkerSlot): string {
  switch (role) {
    case "coder":
      return t("writes code");
    case "artist":
      return t("makes images and UI");
    case "reviewer":
      return t("reviews the work");
    case "researcher":
      return t("researches");
    case "quick":
      return t("takes quick edits");
    default:
      return worker.capabilities.length > 0 ? t("helps with {tags}", { tags: worker.capabilities.join(", ") }) : t("helps");
  }
}

export function RoleIcon({ role, size = 13 }: { role: RoleId | null; size?: number }) {
  switch (role) {
    case "coder":
      return <IconCode size={size} />;
    case "artist":
      return <IconPalette size={size} />;
    case "reviewer":
      return <IconEyeCheck size={size} />;
    case "researcher":
      return <IconSearch size={size} />;
    case "quick":
      return <IconBolt size={size} />;
    default:
      return <IconAgents size={size} />;
  }
}

/** The role names a new helper takes, in the interface language. */
export function roleNames(): Record<RoleId, string> {
  return { coder: roleLabel("coder"), artist: roleLabel("artist"), reviewer: roleLabel("reviewer"), researcher: roleLabel("researcher"), quick: roleLabel("quick") };
}

/** Loads every provider's catalog once for any editor on screen. */
export function useCatalogs(): Catalogs {
  const loadProviderModels = useStore((s) => s.loadProviderModels);
  const providerModels = useStore((s) => s.providerModels);
  useEffect(() => {
    for (const provider of PROVIDERS) void loadProviderModels(provider);
  }, [loadProviderModels]);
  return providerModels;
}

function findModel(catalogs: Catalogs, provider: Provider, id: string | undefined): ProviderModel | undefined {
  const catalog = catalogs[provider];
  return id ? catalog?.find((model) => model.id === id) : (catalog?.find((model) => model.isDefault) ?? undefined);
}

function EffortBar({ model, effort }: { model: ProviderModel | undefined; effort: string | undefined }) {
  const efforts = model?.efforts ?? [];
  const index = effort ? efforts.indexOf(effort) : -1;
  return (
    <span className="chart-effort" title={t("Effort")}>
      {efforts.map((level, at) => (
        <i className={at <= index ? "on" : ""} key={level} />
      ))}
      <em>{effort ?? t("default")}</em>
    </span>
  );
}

function EffortSwitch({ model, value, onChange }: { model: ProviderModel | undefined; value: string | undefined; onChange: (effort: string | undefined) => void }) {
  const efforts = model?.efforts ?? [];
  if (!model) return <span className="small muted">{value ? t("{effort}, kept as it was: the provider does not list this model now.", { effort: value }) : t("The provider does not list this model now.")}</span>;
  if (efforts.length === 0) return <span className="small muted">{t("This model has one effort.")}</span>;
  return (
    <div aria-label={t("Effort")} className="chart-seg" role="group">
      <button aria-pressed={!value} className={!value ? "on" : ""} onClick={() => onChange(undefined)} type="button">
        {t("Default")}
      </button>
      {efforts.map((effort) => (
        <button aria-pressed={value === effort} className={value === effort ? "on" : ""} key={effort} onClick={() => onChange(effort)} type="button">
          {effort}
        </button>
      ))}
    </div>
  );
}

type Picking = { kind: "add" } | { kind: "lead" } | { kind: "worker"; index: number };

function ModelPicker({
  picking,
  catalogs,
  usable,
  lead,
  current,
  role,
  onRole,
  onPick,
  onCancel,
}: {
  picking: Picking;
  catalogs: Catalogs;
  usable: Provider[];
  lead: Provider;
  current: { provider: Provider; model?: string } | null;
  role: RoleId | null;
  onRole: (role: RoleId) => void;
  onPick: (provider: Provider, model: ProviderModel | undefined) => void;
  onCancel: () => void;
}) {
  const providers = picking.kind === "lead" ? ORCHESTRATOR_PROVIDERS : PROVIDERS;
  const suggested = role ? suggestModel(role, catalogs, usable, lead) : null;
  const title = picking.kind === "add" ? t("Add a helper") : picking.kind === "lead" ? t("Who leads this team") : t("Pick its model");
  return (
    <section aria-label={title} className="chart-picker">
      <header className="row wrap">
        <strong>{title}</strong>
        <span className="small muted">{picking.kind === "add" ? t("Pick what it does, then who does it.") : t("Its provider comes with the model.")}</span>
        <span className="composer-spacer" />
        <button className="button button-small" onClick={onCancel} type="button">
          {t("Cancel")}
        </button>
      </header>
      {picking.kind === "add" && (
        <div aria-label={t("What it does")} className="chart-roles" role="group">
          {ROLE_IDS.map((id) => (
            <button aria-pressed={role === id} className={`chart-role ${role === id ? "on" : ""}`} key={id} onClick={() => onRole(id)} type="button">
              <RoleIcon role={id} />
              {roleLabel(id)}
            </button>
          ))}
        </div>
      )}
      <div className="chart-picker-grid">
        {providers.map((provider) => {
          const ready = usable.includes(provider);
          const catalog = catalogs[provider] ?? [];
          const options: Array<ProviderModel | undefined> = catalog.length > 0 ? catalog : [undefined];
          return (
            <div className="chart-picker-col" key={provider}>
              <div className="chart-picker-provider">
                <ProviderLogo provider={provider} size={18} />
                {PROVIDER_LABELS[provider]}
                {!ready && <span className="chip small chip-warn">{t("not signed in")}</span>}
              </div>
              {options.map((model) => {
                const isCurrent = current?.provider === provider && (current.model ?? undefined) === model?.id;
                const isSuggested = !isCurrent && suggested?.provider === provider && suggested.model?.id === model?.id;
                const efforts = model?.efforts ?? [];
                return (
                  <button
                    aria-disabled={!ready}
                    className={`chart-pick ${isCurrent ? "current" : ""} ${ready ? "" : "off"}`}
                    key={model?.id ?? "default"}
                    onClick={() => ready && onPick(provider, model)}
                    title={model?.description}
                    type="button"
                  >
                    <span className="chart-pick-name">
                      {model?.name ?? t("Account default")}
                      {isCurrent && <span className="chart-badge current">{t("current")}</span>}
                      {isSuggested && <span className="chart-badge suggested">{t("suggested")}</span>}
                      {model?.needsCredits && <span className="chart-badge credits">{t("credits")}</span>}
                    </span>
                    <span className="small muted">{efforts.length > 1 ? t("effort {low} to {high}", { low: efforts[0] ?? "", high: efforts[efforts.length - 1] ?? "" }) : t("the account's choice")}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ModelButton({ provider, name, onClick }: { provider: Provider; name: string; onClick: () => void }) {
  return (
    <button className="chart-model-button" onClick={onClick} type="button">
      <ProviderLogo provider={provider} size={18} />
      <span className="chart-grow">
        {name} <span className="muted">· {PROVIDER_LABELS[provider]}</span>
      </span>
      <span className="small muted">{t("Change")}</span>
    </button>
  );
}

export function TeamChart({ orchestrator, combo, onChange }: { orchestrator: OrchestratorChoice; combo: Combo; onChange: (orchestrator: OrchestratorChoice, combo: Combo) => void }) {
  const catalogs = useCatalogs();
  const providers = useStore((s) => s.providers);
  const quotas = useStore((s) => s.quotas);
  const usable = usableProviders(providers);
  const [selected, setSelected] = useState<"lead" | number | null>(null);
  const [picking, setPicking] = useState<Picking | null>(null);
  const [pickRole, setPickRole] = useState<RoleId>("coder");
  const canvas = useRef<HTMLDivElement>(null);
  const [wires, setWires] = useState<string[]>([]);

  const leadModel = findModel(catalogs, orchestrator.provider, orchestrator.model);
  const leadName = modelName(catalogs, orchestrator.provider, orchestrator.model) ?? leadModel?.name ?? t("Account default");
  const workers = combo.workers;
  const setWorkers = (next: WorkerSlot[]) => onChange(orchestrator, { ...combo, workers: next });
  const setWorker = (index: number, next: WorkerSlot) => setWorkers(workers.map((worker, at) => (at === index ? next : worker)));

  // The lines from the lead to each helper, drawn from where the nodes are.
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const draw = () => {
      const box = element.getBoundingClientRect();
      const lead = element.querySelector<HTMLElement>("[data-chart='lead']");
      if (!lead) return;
      const from = lead.getBoundingClientRect();
      const x0 = from.left + from.width / 2 - box.left;
      const y0 = from.bottom - box.top;
      setWires(
        Array.from(element.querySelectorAll<HTMLElement>("[data-chart='helper']")).map((node) => {
          const to = node.getBoundingClientRect();
          const x1 = to.left + to.width / 2 - box.left;
          const y1 = to.top - box.top;
          const bend = y0 + Math.min(26, (y1 - y0) / 2);
          return `M${x0} ${y0} V${bend} H${x1} V${y1}`;
        }),
      );
    };
    draw();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(draw);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [workers.length, orchestrator.provider, orchestrator.model]);

  const hintFor = (worker: WorkerSlot): string | null => {
    if (!usable.includes(worker.provider)) return t("{provider} is not signed in", { provider: PROVIDER_LABELS[worker.provider] });
    if (quotas[worker.provider]?.status === "rejected") return t("{provider} is out of quota", { provider: PROVIDER_LABELS[worker.provider] });
    if (worker.model && (catalogs[worker.provider]?.length ?? 0) > 0 && !findModel(catalogs, worker.provider, worker.model)) return t("Not in {provider}'s model list now", { provider: PROVIDER_LABELS[worker.provider] });
    if (findModel(catalogs, worker.provider, worker.model)?.needsCredits) return t("Uses credits beyond the plan");
    if (roleOf(worker) === "reviewer") {
      const others = [orchestrator.provider, ...workers.filter((other) => other !== worker).map((other) => other.provider)];
      if (others.every((provider) => provider === worker.provider)) return t("Reviews best on another provider");
    }
    return null;
  };

  const pick = (provider: Provider, model: ProviderModel | undefined) => {
    if (!picking) return;
    if (picking.kind === "lead") {
      const effort = orchestrator.effort && model?.efforts.includes(orchestrator.effort) ? orchestrator.effort : roleEffort(null, model);
      onChange({ provider, ...(model ? { model: model.id } : {}), ...(effort ? { effort } : {}) }, combo);
      setSelected("lead");
    } else if (picking.kind === "add") {
      const worker = roleWorker(pickRole, provider, model, workers.map((entry) => entry.name), roleLabel(pickRole));
      setWorkers([...workers, worker]);
      setSelected(workers.length);
    } else {
      const worker = workers[picking.index];
      if (worker) {
        const { model: _model, effort: _effort, ...rest } = worker;
        const effort = worker.effort && model?.efforts.includes(worker.effort) ? worker.effort : roleEffort(roleOf(worker), model);
        setWorker(picking.index, { ...rest, provider, ...(model ? { model: model.id } : {}), ...(effort ? { effort } : {}) });
      }
      setSelected(picking.index);
    }
    setPicking(null);
  };

  const sentence: ReactNode[] = [];
  sentence.push(<b key="lead">{leadName}</b>, " ", combo.nativeSubagents ? t("leads, and may start its own subagents") : t("leads"));
  if (workers.length === 0) sentence.push(t(", on its own."));
  else {
    sentence.push(". ");
    workers.forEach((worker, index) => {
      if (index > 0) sentence.push(index === workers.length - 1 ? t(" and ") : ", ");
      sentence.push(<b key={`w${index}`}>{worker.name || roleLabel(roleOf(worker))}</b>, ` ${roleDoes(roleOf(worker), worker)}`);
    });
    sentence.push(".");
  }

  const selectedWorker = typeof selected === "number" ? workers[selected] : undefined;
  const pickingCurrent =
    picking?.kind === "lead" ? { provider: orchestrator.provider, ...(orchestrator.model ? { model: orchestrator.model } : {}) } : picking?.kind === "worker" && workers[picking.index] ? { provider: workers[picking.index]!.provider, ...(workers[picking.index]!.model ? { model: workers[picking.index]!.model } : {}) } : null;

  return (
    <div className="team-chart">
      <p className="team-readout">{sentence}</p>
      <div className="chart-canvas" ref={canvas}>
        <svg aria-hidden="true" className="chart-wires">
          {wires.map((path, index) => (
            <path d={path} key={index} strokeDasharray={index === wires.length - 1 ? "4 4" : undefined} />
          ))}
        </svg>
        <div className="chart-lead-row">
          <button
            aria-pressed={selected === "lead"}
            className={`chart-node chart-lead ${selected === "lead" ? "selected" : ""}`}
            data-chart="lead"
            onClick={() => {
              setPicking(null);
              setSelected(selected === "lead" ? null : "lead");
            }}
            type="button"
          >
            <span className="chart-kicker">{t("Leads")}</span>
            <span className="chart-who">
              <ProviderLogo provider={orchestrator.provider} size={34} />
              <span className="chart-text">
                <span className="chart-name">{leadName}</span>
                <span className="chart-sub">{PROVIDER_LABELS[orchestrator.provider]}{combo.nativeSubagents ? ` · ${t("own subagents")}` : ""}</span>
              </span>
            </span>
            <EffortBar effort={orchestrator.effort} model={leadModel} />
            {!usable.includes(orchestrator.provider) && <span className="chart-hint">{t("{provider} is not signed in", { provider: PROVIDER_LABELS[orchestrator.provider] })}</span>}
            {leadModel?.needsCredits && <span className="chart-hint">{t("Uses credits beyond the plan")}</span>}
          </button>
        </div>
        <div className="chart-helpers">
          {workers.map((worker, index) => {
            const role = roleOf(worker);
            const model = findModel(catalogs, worker.provider, worker.model);
            const hint = hintFor(worker);
            return (
              <button
                aria-pressed={selected === index}
                className={`chart-node ${selected === index ? "selected" : ""}`}
                data-chart="helper"
                key={index}
                onClick={() => {
                  setPicking(null);
                  setSelected(selected === index ? null : index);
                }}
                type="button"
              >
                <span className="chart-who">
                  <ProviderLogo provider={worker.provider} size={28} />
                  <span className="chart-text">
                    <span className="chart-name">{worker.name || roleLabel(role)}</span>
                    <span className="chart-sub">{modelName(catalogs, worker.provider, worker.model) ?? t("Account default")}</span>
                  </span>
                </span>
                <span className="chart-tags-row">
                  <span className="chart-role-tag">
                    <RoleIcon role={role} size={12} />
                    {roleLabel(role)}
                  </span>
                  {worker.prompt && (
                    <span className="chart-role-tag" title={worker.prompt}>
                      <IconDoc size={12} />
                      {t("instructions")}
                    </span>
                  )}
                </span>
                <EffortBar effort={worker.effort} model={model} />
                {hint && <span className="chart-hint">{hint}</span>}
              </button>
            );
          })}
          <button
            className={`chart-slot ${picking?.kind === "add" ? "selected" : ""}`}
            data-chart="helper"
            onClick={() => {
              setSelected(null);
              setPickRole("coder");
              setPicking({ kind: "add" });
            }}
            type="button"
          >
            <IconPlus size={18} />
            {t("Add a helper")}
          </button>
        </div>
      </div>

      {picking ? (
        <ModelPicker
          catalogs={catalogs}
          current={pickingCurrent}
          lead={orchestrator.provider}
          onCancel={() => setPicking(null)}
          onPick={pick}
          onRole={setPickRole}
          picking={picking}
          role={picking.kind === "add" ? pickRole : picking.kind === "worker" ? roleOf(workers[picking.index] ?? { capabilities: [] }) : null}
          usable={usable}
        />
      ) : selected === "lead" ? (
        <section aria-label={t("Who leads")} className="chart-inspector">
          <div className="chart-inspector-grid">
            <div className="field">
              {t("Model")}
              <ModelButton name={leadName} onClick={() => setPicking({ kind: "lead" })} provider={orchestrator.provider} />
            </div>
            <div className="field">
              {t("Effort")}
              <EffortSwitch
                model={leadModel}
                onChange={(effort) => {
                  const { effort: _effort, ...rest } = orchestrator;
                  onChange({ ...rest, ...(effort ? { effort } : {}) }, combo);
                }}
                value={orchestrator.effort}
              />
            </div>
          </div>
          <label className="small row">
            <input checked={combo.nativeSubagents} onChange={(event) => onChange(orchestrator, { ...combo, nativeSubagents: event.target.checked })} type="checkbox" />
            {t("It may also start its own {provider} subagents", { provider: PROVIDER_LABELS[orchestrator.provider] })}
          </label>
        </section>
      ) : selectedWorker && typeof selected === "number" ? (
        <section aria-label={selectedWorker.name} className="chart-inspector">
          <div className="row">
            <input aria-label={t("Helper name")} className="input chart-name-input" onChange={(event) => setWorker(selected, { ...selectedWorker, name: event.target.value })} value={selectedWorker.name} />
            <span className="composer-spacer" />
            <button
              className="button button-small"
              onClick={() => {
                setWorkers(workers.filter((_, at) => at !== selected));
                setSelected(null);
              }}
              type="button"
            >
              {t("Remove helper")}
            </button>
          </div>
          <div className="chart-inspector-grid">
            <div className="field">
              {t("Model")}
              <ModelButton name={modelName(catalogs, selectedWorker.provider, selectedWorker.model) ?? t("Account default")} onClick={() => setPicking({ kind: "worker", index: selected })} provider={selectedWorker.provider} />
            </div>
            <div className="field">
              {t("Effort")}
              <EffortSwitch
                model={findModel(catalogs, selectedWorker.provider, selectedWorker.model)}
                onChange={(effort) => {
                  const { effort: _effort, ...rest } = selectedWorker;
                  setWorker(selected, { ...rest, ...(effort ? { effort } : {}) });
                }}
                value={selectedWorker.effort}
              />
            </div>
          </div>
          <div className="field">
            {t("What it does")}
            <div className="chart-roles" role="group">
              {ROLE_IDS.map((id) => (
                <button aria-pressed={roleOf(selectedWorker) === id} className={`chart-role ${roleOf(selectedWorker) === id ? "on" : ""}`} key={id} onClick={() => setWorker(selected, withRole(selectedWorker, id))} type="button">
                  <RoleIcon role={id} />
                  {roleLabel(id)}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            {t("When to use it")}
            <input
              aria-label={t("When to use this helper")}
              className="input"
              onChange={(event) => {
                const { note: _note, ...rest } = selectedWorker;
                setWorker(selected, { ...rest, ...(event.target.value ? { note: event.target.value } : {}) });
              }}
              placeholder={t("Read by the lead, for example “all image and icon work”")}
              value={selectedWorker.note ?? ""}
            />
          </label>
          <label className="field">
            {t("Its own instructions")}
            <textarea
              aria-label={t("Its own instructions")}
              className="input chart-prompt"
              maxLength={4000}
              onChange={(event) => {
                const { prompt: _prompt, ...rest } = selectedWorker;
                setWorker(selected, { ...rest, ...(event.target.value ? { prompt: event.target.value } : {}) });
              }}
              placeholder={t("Sent with every task it gets, for example “Write tests with Vitest” or “Flat pastel art style, no gradients”")}
              rows={3}
              value={selectedWorker.prompt ?? ""}
            />
          </label>
          <details className="chart-tags">
            <summary className="small muted">{t("Fine-tune what it is good at")}</summary>
            <div className="row wrap">
              {WORKER_CAPABILITIES.map((capability) => {
                const on = selectedWorker.capabilities.includes(capability);
                return (
                  <button
                    aria-pressed={on}
                    className={`chip chip-button small ${on ? "chip-on" : ""}`}
                    key={capability}
                    onClick={() => setWorker(selected, { ...selectedWorker, capabilities: on ? selectedWorker.capabilities.filter((own) => own !== capability) : [...selectedWorker.capabilities, capability] })}
                    type="button"
                  >
                    {capability}
                  </button>
                );
              })}
            </div>
          </details>
        </section>
      ) : (
        <p className="small muted chart-help">{t("Click someone on the chart to change them.")}</p>
      )}
    </div>
  );
}
