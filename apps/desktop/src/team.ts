/**
 * Teams: the workers an orchestrator session may delegate to, and the jobs it
 * hands them (docs/research/multi-provider-viability.md §2.2).
 *
 * Pure helpers for the team picker, the jobs list and a cross-provider
 * handoff. The host owns the team and runs the jobs; nothing here decides
 * where work goes.
 */
import { PROVIDER_LABELS, type Combo, type JobView, type Provider, type ProviderModel, type TeamPreset, type WorkerSlot } from "@thingmaker/contracts";
import type { Card } from "./projection";

/** A worker to start from when the user adds one: the account's fastest
 *  model for Codex (the image maker), a mid Flash for Gemini, Sonnet for
 *  Claude. */
export function presetWorker(provider: Provider, models: ProviderModel[] | undefined, taken: string[]): WorkerSlot {
  const catalog = models ?? [];
  const pick =
    provider === "codex"
      ? (catalog.find((model) => /luna|mini|fast/i.test(model.id)) ?? catalog.find((model) => model.isDefault) ?? catalog[0])
      : provider === "gemini"
        ? (catalog.find((model) => /flash.*medium/i.test(model.id)) ?? catalog.find((model) => /flash/i.test(model.id)) ?? catalog[0])
        : (catalog.find((model) => /sonnet/i.test(model.id)) ?? catalog.find((model) => model.isDefault) ?? catalog[0]);
  const capabilities = provider === "codex" ? ["image", "fast", "code"] : provider === "gemini" ? ["fast", "research"] : ["code", "review"];
  const base = pick ? shortName(pick) : provider;
  return {
    name: uniqueName(base, taken),
    provider,
    ...(pick ? { model: pick.id } : {}),
    ...(pick?.efforts.includes("low") ? { effort: "low" } : {}),
    capabilities,
  };
}

/** What an orchestrator calls a worker: the model's own word, without the
 *  version or effort — `gpt-6-luna` → `luna`, `gemini-3.1-pro-high` → `pro`,
 *  `claude-opus-4-6-thinking` → `opus`. */
export function shortName(model: ProviderModel): string {
  const id = model.id.replace(/\[.*\]$/, "");
  const parts = id.split(/[-_]/).filter(Boolean);
  while (parts.length > 1 && /^(low|medium|high|max|thinking)$/i.test(parts[parts.length - 1] as string)) parts.pop();
  const word = [...parts].reverse().find((part) => !/^\d/.test(part));
  return (word ?? id).toLowerCase();
}

export function uniqueName(base: string, taken: string[]): string {
  const lower = new Set(taken.map((name) => name.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) if (!lower.has(`${base}-${n}`.toLowerCase())) return `${base}-${n}`;
}

/** `Codex · luna, Claude Code · sonnet` for a chip's title. */
export function teamSummary(combo: Combo | undefined): string {
  if (!combo || combo.workers.length === 0) return "No workers: the orchestrator works alone.";
  return combo.workers.map((worker) => `${worker.name} (${PROVIDER_LABELS[worker.provider]}${worker.model ? ` · ${worker.model}` : ""})`).join(", ");
}

/** Inserts or replaces a job by id, keeping the list in start order. */
export function upsertJob(list: JobView[] | undefined, job: JobView): JobView[] {
  const next = (list ?? []).filter((existing) => existing.id !== job.id);
  next.push(job);
  return next.sort((a, b) => a.startedAtUnixMs - b.startedAtUnixMs || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

export function isRunning(job: JobView): boolean {
  return job.status === "starting" || job.status === "running";
}

/** Not finished: running, or waiting out a temporary limit. */
export function isOpen(job: JobView): boolean {
  return isRunning(job) || job.status === "waiting";
}

/** `4:05`, the time left until a waiting job retries. */
export function countdown(retryAtUnixMs: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((retryAtUnixMs - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** How long a job ran, or has been running. */
export function jobDuration(job: JobView, now: number): string {
  const ms = (job.finishedAtUnixMs ?? now) - job.startedAtUnixMs;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ${seconds % 60} s` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function cardText(card: Card): { role: string; text: string } | null {
  if (card.kind !== "message" || card.message.role === "thought") return null;
  const text = card.message.blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  if (!text) return null;
  return { role: card.message.role, text };
}

/**
 * The brief a session on another provider starts from. Models cannot share a
 * context window, so a cross-provider switch is a new session told what the
 * old one knew: the latest exchange in full, the rest by its asks.
 */
export function handoffBrief(cards: Card[], from: Provider, budget = 6000): string {
  const messages = cards.map(cardText).filter((entry): entry is { role: string; text: string } => entry !== null);
  const header = `You are taking over this work from a ${PROVIDER_LABELS[from]} session in the same workspace. Its conversation is summarised below; the files it changed are on disk. Read what you need, then continue where it left off.`;
  if (messages.length === 0) return `${header}\n\n(The previous session had no conversation yet.)`;
  const lines: string[] = [];
  let used = 0;
  // Newest first, until the budget is spent; then oldest-first for reading.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index] as { role: string; text: string };
    const label = entry.role === "user" ? "User" : "Agent";
    const room = budget - used;
    if (room <= 80) break;
    const text = entry.text.length > room ? `${entry.text.slice(0, room)}…` : entry.text;
    lines.unshift(`${label}: ${text}`);
    used += text.length;
  }
  const skipped = messages.length - lines.length;
  return [header, "", skipped > 0 ? `(${skipped} earlier messages left out.)` : null, ...lines, "", "Continue from here."].filter((line) => line !== null).join("\n");
}

/** A fresh preset: a Claude orchestrator on the account default, no workers. */
export function newPreset(name: string, taken: string[]): TeamPreset {
  return {
    id: `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: uniqueName(name.trim() || "New team", taken),
    orchestrator: { provider: "claude" },
    combo: { workers: [], nativeSubagents: false },
    updatedAt: Date.now(),
  };
}

/** Inserts or replaces a preset by id, keeping the list in name order. */
export function upsertPreset(list: TeamPreset[], preset: TeamPreset): TeamPreset[] {
  return [...list.filter((existing) => existing.id !== preset.id), preset].sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads presets back from storage, dropping anything that is not one. */
export function readPresets(value: unknown): TeamPreset[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is TeamPreset =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as TeamPreset).id === "string" &&
      typeof (entry as TeamPreset).name === "string" &&
      typeof (entry as TeamPreset).orchestrator?.provider === "string" &&
      Array.isArray((entry as TeamPreset).combo?.workers),
  );
}

/**
 * Whether a session already matches a preset: the same orchestrator
 * provider, and the same workers. Model and effort are left out, because the
 * session's live picker can move them without changing the team.
 */
export function presetMatches(preset: TeamPreset, provider: Provider, combo: Combo | undefined): boolean {
  if (!combo || preset.orchestrator.provider !== provider) return false;
  const strip = (value: Combo) => JSON.stringify({ workers: value.workers, nativeSubagents: value.nativeSubagents });
  return strip(preset.combo) === strip(combo);
}
