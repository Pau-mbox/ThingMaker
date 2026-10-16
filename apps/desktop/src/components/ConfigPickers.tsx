import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { asConfigOptions, isConfigOptionGroup, isEffortOption, type ConfigOptionChoice, type SessionConfigOption } from "@thingmaker/contracts";
import { useStore } from "../store";
import { IconBolt, IconCheck, IconChevron, IconUndo } from "./icons";

function choices(option: SessionConfigOption): { group: string | null; choice: ConfigOptionChoice }[] {
  const out: { group: string | null; choice: ConfigOptionChoice }[] = [];
  for (const entry of option.options ?? []) {
    if (isConfigOptionGroup(entry)) for (const choice of entry.options) out.push({ group: entry.name, choice });
    else out.push({ group: null, choice: entry });
  }
  return out;
}

function current(option: SessionConfigOption | undefined): { group: string | null; choice: ConfigOptionChoice } | undefined {
  if (!option) return undefined;
  const value = typeof option.currentValue === "string" ? option.currentValue : "";
  return choices(option).find((c) => c.choice.value === value) ?? (value ? { group: null, choice: { value, name: value } } : undefined);
}

/** Claude's Fast mode, advertised as a boolean or as an on/off select. */
const FAST_ID = "fast";
function fastOn(option: SessionConfigOption): boolean {
  return option.currentValue === true || option.currentValue === "on";
}

/** The effort an agent picks for itself; reset returns to it, and the slider leaves it out. */
const DEFAULT_EFFORT = "default";
/** Above this many models the list gets a filter. */
const FILTER_FROM = 12;

function ModelList({ option, onPick }: { option: SessionConfigOption; onPick: (value: string) => void }) {
  const [filter, setFilter] = useState("");
  const all = useMemo(() => choices(option), [option]);
  const value = typeof option.currentValue === "string" ? option.currentValue : "";
  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const map = new Map<string, ConfigOptionChoice[]>();
    for (const { group, choice } of all) {
      if (needle && !`${choice.name} ${group ?? ""} ${choice.value}`.toLowerCase().includes(needle)) continue;
      const list = map.get(group ?? "") ?? [];
      list.push(choice);
      map.set(group ?? "", list);
    }
    return [...map.entries()];
  }, [all, filter]);

  return (
    <div className="model-menu-list">
      <div className="model-menu-caption">Select model</div>
      {all.length > FILTER_FROM && (
        <input aria-label="Filter models" autoFocus className="input model-menu-filter" onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${all.length} models…`} value={filter} />
      )}
      <div className="model-menu-scroll" role="listbox" aria-label="Model">
        {groups.map(([group, list]) => (
          <div key={group || "-"}>
            {group && <div className="model-menu-group">{group}</div>}
            {list.map((choice) => (
              <button aria-selected={choice.value === value} className="model-menu-item" key={choice.value} onClick={() => onPick(choice.value)} role="option" type="button">
                <span className="model-menu-item-text">
                  <span>{choice.name}</span>
                  {choice.description && <span className="model-menu-item-note">{choice.description}</span>}
                </span>
                {choice.value === value && <IconCheck size={14} />}
              </button>
            ))}
          </div>
        ))}
        {groups.length === 0 && <div className="model-menu-group">No model matches</div>}
      </div>
    </div>
  );
}

/** The effort levels as a slider with a dot per level; click, drag or use the arrow keys. */
function EffortSlider({ levels, index, onPick, disabled }: { levels: ConfigOptionChoice[]; index: number; onPick: (value: string) => void; disabled: boolean }) {
  const track = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? index;
  const at = (clientX: number) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width === 0 || levels.length < 2) return 0;
    const inner = Math.min(Math.max(clientX - box.left - 14, 0), box.width - 28);
    return Math.round((inner / (box.width - 28)) * (levels.length - 1));
  };
  const commit = (next: number) => {
    const level = levels[next];
    if (level && next !== index) onPick(level.value);
  };
  const percent = (position: number) => (levels.length < 2 ? 0 : (position / (levels.length - 1)) * 100);
  const onKey = (event: KeyboardEvent) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    commit(Math.min(Math.max((index < 0 ? 0 : index) + step, 0), levels.length - 1));
  };

  return (
    <div
      aria-disabled={disabled}
      aria-label="Reasoning effort"
      aria-valuemax={levels.length - 1}
      aria-valuemin={0}
      aria-valuenow={Math.max(shown, 0)}
      aria-valuetext={levels[shown]?.name ?? "Default"}
      className={`effort-slider ${shown < 0 ? "effort-slider-unset" : ""}`}
      onKeyDown={disabled ? undefined : onKey}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        if (disabled) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(at(event.clientX));
      }}
      onPointerMove={(event) => dragging !== null && setDragging(at(event.clientX))}
      onPointerUp={(event) => {
        if (dragging === null) return;
        commit(at(event.clientX));
        setDragging(null);
      }}
      onPointerCancel={() => setDragging(null)}
      ref={track}
      role="slider"
      tabIndex={disabled ? -1 : 0}
    >
      <div className="effort-slider-rail">
        {shown >= 0 && <div className="effort-slider-fill" style={{ width: `calc(14px + (100% - 28px) * ${percent(shown) / 100})` }} />}
        {levels.map((level, position) => (
          <span className={`effort-slider-dot ${position <= shown ? "effort-slider-dot-on" : ""}`} key={level.value} style={{ left: `calc(14px + (100% - 28px) * ${percent(position) / 100})` }} title={level.name} />
        ))}
        {shown >= 0 && <span className="effort-slider-thumb" style={{ left: `calc(14px + (100% - 28px) * ${percent(shown) / 100})` }} />}
      </div>
    </div>
  );
}

/**
 * Model, reasoning effort and Fast mode in one small menu, the way Codex
 * offers them: the chip names the model and effort, and opens on the effort
 * as a slider, with the model a click away and Fast mode a toggle. Values
 * come from the agent's advertised options only (P08); switching uses
 * `session/set_config_option` and the agent's echo updates what is shown.
 */
export function ModelMenu({
  sessionId,
  model,
  effort,
  fast,
  disabled,
}: {
  sessionId: string;
  model?: SessionConfigOption | undefined;
  effort?: SessionConfigOption | undefined;
  fast?: SessionConfigOption | undefined;
  disabled: boolean;
}) {
  const setConfigOption = useStore((s) => s.setConfigOption);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"main" | "models">("main");
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: globalThis.PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (view === "models") setView("main");
      else setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, view]);

  const modelNow = current(model);
  const effortNow = current(effort);
  const levels = effort ? choices(effort).map((c) => c.choice).filter((c) => c.value !== DEFAULT_EFFORT) : [];
  const hasDefault = effort ? choices(effort).some((c) => c.choice.value === DEFAULT_EFFORT) : false;
  const effortIndex = levels.findIndex((level) => level.value === effortNow?.choice.value);
  const fastEnabled = fast ? fastOn(fast) : false;
  const set = (option: SessionConfigOption | undefined, value: string) => {
    if (option && value !== option.currentValue) void setConfigOption(sessionId, option.configId, value);
  };

  return (
    <span className="model-menu-anchor" ref={root}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="model-chip"
        disabled={disabled}
        onClick={() => {
          setView(effort || fast ? "main" : "models");
          setOpen(!open);
        }}
        title={modelNow?.group ? `${modelNow.choice.name} · ${modelNow.group}` : "Model and reasoning effort"}
        type="button"
      >
        {fastEnabled && <IconBolt className="model-chip-bolt" size={12} />}
        <span className="model-chip-model">{modelNow?.choice.name ?? "Model"}</span>
        {effortNow && <span className="model-chip-effort">{effortNow.choice.name}</span>}
        <IconChevron open size={11} />
      </button>
      {open && (
        <span className="model-menu" role="dialog" aria-label="Model and effort">
          {view === "models" && model ? (
            <ModelList
              onPick={(value) => {
                set(model, value);
                if (effort || fast) setView("main");
                else setOpen(false);
              }}
              option={model}
            />
          ) : (
            <>
              <div className="model-menu-head">
                {fast ? (
                  <button
                    aria-label="Fast mode"
                    aria-pressed={fastEnabled}
                    className={`model-menu-icon ${fastEnabled ? "model-menu-icon-on" : ""}`}
                    onClick={() => set(fast, fastEnabled ? "off" : "on")}
                    title={`Fast mode ${fastEnabled ? "on" : "off"}${fast.description ? ` — ${fast.description}` : ""}`}
                    type="button"
                  >
                    <IconBolt size={15} />
                  </button>
                ) : (
                  <span className="model-menu-icon-slot" />
                )}
                <div className="model-menu-title">
                  <span className="model-menu-effort">{effortNow?.choice.name ?? (effort ? "Default" : (modelNow?.choice.name ?? "Model"))}</span>
                  {model && (
                    <button className="model-menu-model" onClick={() => setView("models")} type="button">
                      {modelNow?.choice.name ?? "Choose a model"}
                      <IconChevron size={11} />
                    </button>
                  )}
                </div>
                {hasDefault && effortNow?.choice.value !== DEFAULT_EFFORT ? (
                  <button aria-label="Reset effort" className="model-menu-icon" onClick={() => set(effort, DEFAULT_EFFORT)} title="Back to the default effort" type="button">
                    <IconUndo size={15} />
                  </button>
                ) : (
                  <span className="model-menu-icon-slot" />
                )}
              </div>
              {effort && levels.length > 0 && <EffortSlider disabled={disabled} index={effortIndex} levels={levels} onPick={(value) => set(effort, value)} />}
            </>
          )}
        </span>
      )}
    </span>
  );
}

/** Renders every advertised option: model, effort and Fast mode share one menu, others a plain select. */
export function ConfigPickers({ sessionId, configOptions, disabled }: { sessionId: string; configOptions: unknown; disabled: boolean }) {
  const setConfigOption = useStore((s) => s.setConfigOption);
  const options = asConfigOptions(configOptions);
  if (options.length === 0) return <span className="small muted">The agent advertised no live config options for this session.</span>;
  const model = options.find((option) => option.configId === "model");
  const effort = options.find((option) => isEffortOption(option.configId));
  const fast = options.find((option) => option.configId === FAST_ID);
  return (
    <>
      {(model || effort || fast) && <ModelMenu disabled={disabled} effort={effort} fast={fast} model={model} sessionId={sessionId} />}
      {options.map((option) => {
        if (option === model || option === effort || option === fast) return null;
        // The permission mode is the workspace's trust, decided at launch; it is
        // shown, not offered, so a click cannot step around that decision.
        if (option.configId === "mode") {
          const current = choices(option).find((c) => c.choice.value === option.currentValue);
          return (
            <span className="chip small" key={option.configId} title="Set by the workspace's trust: trusted workspaces accept edits, others plan">
              mode: {current?.choice.name ?? String(option.currentValue ?? "unset")}
            </span>
          );
        }
        const all = choices(option);
        const value = typeof option.currentValue === "string" ? option.currentValue : "";
        if (all.length === 0) {
          return (
            <span className="chip small" key={option.configId} title={option.description}>
              {option.name}: {String(option.currentValue ?? "unset")}
            </span>
          );
        }
        return (
          <label className="small" key={option.configId} title={option.description}>
            {option.name}{" "}
            <select className="input inline" disabled={disabled} onChange={(e) => void setConfigOption(sessionId, option.configId, e.target.value)} value={value}>
              {all.map(({ choice }) => (
                <option key={choice.value} value={choice.value}>
                  {choice.name}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </>
  );
}
