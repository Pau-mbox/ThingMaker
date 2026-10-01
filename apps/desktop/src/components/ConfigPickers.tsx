import { useMemo, useState } from "react";
import { asConfigOptions, isConfigOptionGroup, isEffortOption, type ConfigOptionChoice, type SessionConfigOption } from "@thingmaker/contracts";
import { useStore } from "../store";

function choices(option: SessionConfigOption): { group: string | null; choice: ConfigOptionChoice }[] {
  const out: { group: string | null; choice: ConfigOptionChoice }[] = [];
  for (const entry of option.options ?? []) {
    if (isConfigOptionGroup(entry)) for (const choice of entry.options) out.push({ group: entry.name, choice });
    else out.push({ group: null, choice: entry });
  }
  return out;
}

function currentLabel(option: SessionConfigOption): string {
  const value = typeof option.currentValue === "string" ? option.currentValue : "";
  const match = choices(option).find((c) => c.choice.value === value);
  return match ? `${match.choice.name}${match.group ? ` · ${match.group}` : ""}` : value || "unknown";
}

/**
 * Searchable, grouped select for the agent's `model` option. Values come from
 * the agent's advertised options only (P08): nothing is hardcoded. Switching
 * uses `session/set_config_option`; the agent's echo updates the shown value.
 */
export function ModelPicker({ sessionId, option, disabled }: { sessionId: string; option: SessionConfigOption; disabled: boolean }) {
  const setConfigOption = useStore((s) => s.setConfigOption);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const all = useMemo(() => choices(option), [option]);
  const value = typeof option.currentValue === "string" ? option.currentValue : "";
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((c) => c.choice.name.toLowerCase().includes(needle) || (c.group ?? "").toLowerCase().includes(needle) || c.choice.value.toLowerCase().includes(needle));
  }, [all, filter]);
  const groups = useMemo(() => {
    const map = new Map<string, ConfigOptionChoice[]>();
    for (const { group, choice } of filtered) {
      const key = group ?? "";
      const list = map.get(key) ?? [];
      list.push(choice);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <span className="picker">
      <button aria-expanded={open} className="chip chip-button" disabled={disabled} onClick={() => setOpen(!open)} title="Model (from the agent's advertised options)" type="button">
        model: {currentLabel(option)} ▾
      </button>
      {open && (
        <span className="picker-pop">
          <input
            aria-label="Filter models"
            autoFocus
            className="input"
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${all.length} models…`}
            value={filter}
          />
          <select
            aria-label="Model"
            className="input select"
            onChange={(e) => {
              if (e.target.value && e.target.value !== value) void setConfigOption(sessionId, option.configId, e.target.value);
              setOpen(false);
            }}
            size={Math.min(12, Math.max(4, filtered.length + groups.length))}
            value={value}
          >
            {groups.map(([group, list]) =>
              group ? (
                <optgroup key={group} label={group}>
                  {list.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              ) : (
                list.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.name}
                  </option>
                ))
              ),
            )}
          </select>
          <span className="small muted">
            {filtered.length} of {all.length}. Switching a provider group requires that provider's credentials.
          </span>
        </span>
      )}
    </span>
  );
}

/** Segmented control for `reasoning_effort` (default / low / medium / high as advertised). */
export function EffortPicker({ sessionId, option, disabled }: { sessionId: string; option: SessionConfigOption; disabled: boolean }) {
  const setConfigOption = useStore((s) => s.setConfigOption);
  const value = typeof option.currentValue === "string" ? option.currentValue : "";
  const all = choices(option);
  return (
    <span aria-label="Reasoning effort" className="segmented" role="radiogroup" title={option.description ?? "Reasoning effort (the agent's config option)"}>
      {all.map(({ choice }) => (
        <button
          aria-checked={choice.value === value}
          className={`seg ${choice.value === value ? "seg-on" : ""}`}
          disabled={disabled}
          key={choice.value}
          onClick={() => choice.value !== value && void setConfigOption(sessionId, option.configId, choice.value)}
          role="radio"
          type="button"
        >
          {choice.name}
        </button>
      ))}
    </span>
  );
}

/** Renders every advertised option: model and effort get dedicated controls, others a plain select. */
export function ConfigPickers({ sessionId, configOptions, disabled }: { sessionId: string; configOptions: unknown; disabled: boolean }) {
  const setConfigOption = useStore((s) => s.setConfigOption);
  const options = asConfigOptions(configOptions);
  if (options.length === 0) return <span className="small muted">The agent advertised no live config options for this session.</span>;
  return (
    <>
      {options.map((option) => {
        if (option.configId === "model") return <ModelPicker disabled={disabled} key={option.configId} option={option} sessionId={sessionId} />;
        if (isEffortOption(option.configId)) return <EffortPicker disabled={disabled} key={option.configId} option={option} sessionId={sessionId} />;
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
