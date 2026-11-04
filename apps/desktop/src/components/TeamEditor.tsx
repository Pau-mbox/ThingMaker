/**
 * The composer's team chip (docs/research/multi-provider-viability.md §2.2):
 * which saved team the session works with, and a menu of the saved teams to
 * switch to. Hovering one shows who is on it. Teams are made and edited in
 * the Teams view, which the menu links to.
 *
 * Picking a team sets its helpers at once (the next `delegate` uses them).
 * Its lead's model and effort go through the session's own options; a lead
 * on another provider is the next message's provider, as the model menu's
 * provider switch is.
 */
import { useEffect, useRef, useState } from "react";
import { PROVIDER_LABELS, asConfigOptions, isEffortOption, type Combo, type OrchestratorChoice, type Provider, type TeamPreset, type WorkerSlot } from "@thingmaker/contracts";
import { useStore } from "../store";
import { hasConversation, presetMatches, teamSummary, tidyCombo } from "../team";
import { closestRole, modelName, type Catalogs } from "../teamRoles";
import { ProviderLogo } from "./ProviderLogo";
import { RoleIcon, roleLabel, useCatalogs } from "./TeamChart";
import { Faces, describe } from "./TeamsView";
import { IconCheck, IconChevron, IconDoc } from "./icons";
import { t } from "../i18n";

/** The menu and the card beside it, with the gap between. */
const POP_WIDTH = 616;

/** What the session works with now, as a team to show. */
type Shown = { id: string; name: string; orchestrator: OrchestratorChoice; combo: Combo };

function Helper({ worker, catalogs }: { worker: WorkerSlot; catalogs: Catalogs }) {
  const role = closestRole(worker);
  const model = modelName(catalogs, worker.provider, worker.model) ?? t("Account default");
  return (
    <li className="team-card-helper">
      <ProviderLogo provider={worker.provider} size={24} />
      <span className="team-card-text">
        <span className="team-card-line">
          <strong>{worker.name}</strong>
          <span className="team-card-role">
            <RoleIcon role={role} size={11} /> {roleLabel(role)}
          </span>
        </span>
        <span className="small muted">
          {model}
          {worker.effort ? ` · ${worker.effort}` : ""}
        </span>
        {worker.note && <span className="small team-card-note">{worker.note}</span>}
        {worker.prompt && (
          <span className="small muted team-card-prompt" title={worker.prompt}>
            <IconDoc size={11} /> {t("Own instructions: {text}", { text: worker.prompt })}
          </span>
        )}
      </span>
    </li>
  );
}

/** Who is on a team: the lead, then each helper with its role and model. */
function TeamCard({ team, provider, started }: { team: Shown; provider: Provider; started: boolean }) {
  const catalogs = useCatalogs();
  const lead = team.orchestrator;
  const leadModel = modelName(catalogs, lead.provider, lead.model) ?? t("Account default");
  return (
    <div className="team-card" role="note" aria-label={t("Who is on {name}", { name: team.name })}>
      <strong className="team-card-name">{team.name}</strong>
      <div className="team-card-lead">
        <ProviderLogo provider={lead.provider} size={30} />
        <span className="team-card-text">
          <span className="team-card-line">
            <strong>{leadModel}</strong>
            <span className="team-card-leads">{t("leads")}</span>
          </span>
          <span className="small muted">
            {PROVIDER_LABELS[lead.provider]}
            {lead.effort ? ` · ${lead.effort}` : ""}
          </span>
        </span>
      </div>
      {team.combo.workers.length === 0 ? (
        <p className="small muted team-card-alone">{t("No helpers: the lead works alone.")}</p>
      ) : (
        <ul className="team-card-helpers">
          {team.combo.workers.map((worker) => (
            <Helper catalogs={catalogs} key={worker.name} worker={worker} />
          ))}
        </ul>
      )}
      {lead.provider !== provider && (
        <p className="small team-card-switch">
          {started
            ? t("Led by {provider}: your next message carries this conversation on in a new {provider} session.", { provider: PROVIDER_LABELS[lead.provider] })
            : t("Led by {provider}: this session starts on {provider} with your first message.", { provider: PROVIDER_LABELS[lead.provider] })}
        </p>
      )}
    </div>
  );
}

/** The composer's team button and its menu of saved teams. */
export function TeamChip({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const team = useStore((s) => s.teams[sessionId]);
  const presets = useStore((s) => s.teamPresets);
  const session = useStore((s) => s.sessions[sessionId]);
  const pending = useStore((s) => s.pendingProvider[sessionId]);
  const started = useStore((s) => hasConversation(s.sessions[sessionId]?.projection.cards));
  const running = useStore((s) => (s.jobs[sessionId] ?? []).filter((job) => job.status === "starting" || job.status === "running").length);
  const saveTeam = useStore((s) => s.saveTeam);
  const setConfigOption = useStore((s) => s.setConfigOption);
  const setPendingProvider = useStore((s) => s.setPendingProvider);
  const setView = useStore((s) => s.setView);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  // Opens to the right, with the card beside the menu; near the window's
  // right edge, to the left, the card then on the menu's left.
  const [leftward, setLeftward] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("[aria-checked='true'], button")?.focus();
    const onDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        root.current?.querySelector<HTMLButtonElement>(".team-chip")?.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (!team || !session) return null;
  const provider = session.snapshot.provider;
  // The lead the next message goes to: a pending switch is the team's too.
  const leading = pending?.provider ?? provider;
  const current = presets.find((preset) => presetMatches(preset, leading, team));
  const own: Shown | null = current
    ? null
    : (() => {
        const options = asConfigOptions(session.snapshot.configOptions);
        const value = (option: { currentValue?: unknown } | undefined) => (typeof option?.currentValue === "string" && option.currentValue !== "default" ? option.currentValue : undefined);
        const model = pending ? pending.model : value(options.find((option) => option.configId === "model"));
        const effort = pending ? pending.effort : value(options.find((option) => isEffortOption(option.configId)));
        return { id: "", name: t("This session's own team"), orchestrator: { provider: leading, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, combo: team };
      })();
  const label = current ? current.name : team.workers.length === 0 ? t("solo") : team.workers.map((worker) => worker.name).join(" + ");
  const shown: Shown | null = (hovered === "" ? own : presets.find((preset) => preset.id === hovered)) ?? (current ?? own);

  const apply = async (preset: TeamPreset) => {
    setOpen(false);
    await saveTeam(sessionId, tidyCombo(preset.combo));
    const lead = preset.orchestrator;
    if (lead.provider !== provider) {
      setPendingProvider(sessionId, { provider: lead.provider, ...(lead.model ? { model: lead.model } : {}), ...(lead.effort ? { effort: lead.effort } : {}) });
      return;
    }
    if (pending) setPendingProvider(sessionId, null);
    const options = asConfigOptions(session.snapshot.configOptions);
    const model = options.find((option) => option.configId === "model");
    const effort = options.find((option) => isEffortOption(option.configId));
    if (model && lead.model && lead.model !== model.currentValue) await setConfigOption(sessionId, model.configId, lead.model);
    if (effort && lead.effort && lead.effort !== effort.currentValue) await setConfigOption(sessionId, effort.configId, lead.effort);
  };

  return (
    <span className="team-menu-anchor" ref={root}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className={`chip chip-button team-chip ${running > 0 ? "chip-active" : ""}`}
        disabled={disabled}
        onClick={() => {
          setHovered(null);
          const rect = root.current?.getBoundingClientRect();
          setLeftward(Boolean(rect && rect.left + POP_WIDTH > window.innerWidth - 16));
          setOpen(!open);
        }}
        title={t("Team: {summary}", { summary: teamSummary(team) })}
        type="button"
      >
        {t("team: {label}", { label })}
        {running > 0 ? ` · ${t("{count} working", { count: running })}` : ""}
        <IconChevron open size={11} />
      </button>
      {open && (
        <div className={`team-menu-pop ${leftward ? "team-menu-pop-left" : ""}`}>
          <div aria-label={t("Teams")} className="team-menu" ref={menu} role="menu">
            <span className="model-menu-caption">{t("Work with a team")}</span>
            {own && (
              <button
                aria-checked="true"
                className="team-menu-item"
                onClick={() => setOpen(false)}
                onFocus={() => setHovered("")}
                onMouseEnter={() => setHovered("")}
                role="menuitemradio"
                type="button"
              >
                <Faces preset={own} />
                <span className="team-menu-text">
                  <span className="team-menu-name">{own.name}</span>
                  <span className="small muted">{teamSummary(own.combo)}</span>
                </span>
                <IconCheck size={13} />
              </button>
            )}
            {presets.map((preset) => {
              const on = preset.id === current?.id;
              return (
                <button
                  aria-checked={on}
                  className="team-menu-item"
                  key={preset.id}
                  onClick={() => (on ? setOpen(false) : void apply(preset))}
                  onFocus={() => setHovered(preset.id)}
                  onMouseEnter={() => setHovered(preset.id)}
                  role="menuitemradio"
                  type="button"
                >
                  <Faces preset={preset} />
                  <span className="team-menu-text">
                    <span className="team-menu-name">{preset.name}</span>
                    <TeamLine preset={preset} />
                  </span>
                  {on && <IconCheck size={13} />}
                </button>
              );
            })}
            {presets.length === 0 && <span className="small muted team-menu-empty">{t("No saved teams yet.")}</span>}
            <span className="team-menu-rule" role="separator" />
            <button
              className="team-menu-item team-menu-go"
              onClick={() => {
                setOpen(false);
                setView({ kind: "teams" });
              }}
              role="menuitem"
              type="button"
            >
              {presets.length === 0 ? t("Make a team in Teams…") : t("Go to Teams…")}
            </button>
          </div>
          {shown && <TeamCard provider={provider} started={started} team={shown} />}
        </div>
      )}
    </span>
  );
}

function TeamLine({ preset }: { preset: TeamPreset }) {
  const catalogs = useCatalogs();
  return <span className="small muted">{describe(preset, catalogs)}</span>;
}
