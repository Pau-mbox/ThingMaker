/**
 * Roles for a team's helpers: what a person picks instead of capability
 * tags. A role is a set of capabilities and the note the orchestrator reads;
 * the worker record stays the same, so a helper made by hand with other tags
 * still shows, as a custom one.
 *
 * Also what the team chart suggests: a sensible model for each role from the
 * models each signed-in provider offers, and the shapes a new team starts
 * from. Nothing here is hardcoded to a model id; it matches the catalogs.
 */
import { ORCHESTRATOR_PROVIDERS, PROVIDERS, type Combo, type OrchestratorChoice, type Provider, type ProviderModel, type WorkerSlot } from "@thingmaker/contracts";
import { uniqueName } from "./team";

export type RoleId = "coder" | "artist" | "reviewer" | "researcher" | "quick";

export const ROLE_IDS: readonly RoleId[] = ["coder", "artist", "reviewer", "researcher", "quick"];

/** What each role is good at, as the orchestrator's capability tags. */
export const ROLE_CAPABILITIES: Record<RoleId, string[]> = {
  coder: ["code"],
  artist: ["image", "ui"],
  reviewer: ["review"],
  researcher: ["research"],
  quick: ["fast"],
};

/** The line the orchestrator reads about when to use a helper. Sent to the
 *  agent, so it stays English whatever the interface language. */
export const ROLE_NOTES: Record<RoleId, string> = {
  coder: "Implementation tasks",
  artist: "Images, icons and UI art",
  reviewer: "Checks another worker's result before it counts as done",
  researcher: "Reads docs and code, and answers questions",
  quick: "Small, quick edits",
};

/** A helper's role, read from its tags: the role whose tags it has, the
 *  most specific first; none when it was tagged by hand some other way. */
export function roleOf(worker: Pick<WorkerSlot, "capabilities">): RoleId | null {
  const own = new Set(worker.capabilities);
  const exact = ROLE_IDS.find((role) => ROLE_CAPABILITIES[role].length === own.size && ROLE_CAPABILITIES[role].every((tag) => own.has(tag)));
  if (exact) return exact;
  return ROLE_IDS.filter((role) => ROLE_CAPABILITIES[role].every((tag) => own.has(tag))).sort((a, b) => ROLE_CAPABILITIES[b].length - ROLE_CAPABILITIES[a].length)[0] ?? null;
}

export type Catalogs = Partial<Record<Provider, ProviderModel[]>>;

/** The model to suggest for a role, among the providers that can run. */
export function suggestModel(role: RoleId, catalogs: Catalogs, usable: readonly Provider[], lead: Provider): { provider: Provider; model?: ProviderModel } {
  const find = (provider: Provider, pattern: RegExp) => (usable.includes(provider) ? catalogs[provider]?.find((model) => pattern.test(`${model.id} ${model.name}`)) : undefined);
  const fallback = (provider: Provider) => catalogs[provider]?.find((model) => model.isDefault) ?? catalogs[provider]?.[0];
  const first = (...tries: Array<[Provider, RegExp]>) => {
    for (const [provider, pattern] of tries) {
      const model = find(provider, pattern);
      if (model) return { provider, model };
    }
    return null;
  };
  const choice =
    role === "artist"
      ? first(["codex", /astra/i], ["codex", /luna/i], ["gemini", /pro/i])
      : role === "quick"
        ? first(["claude", /haiku/i], ["codex", /luna|mini/i], ["gemini", /flash/i])
        : role === "reviewer"
          ? // A review reads best from another provider than the lead's.
            lead === "claude"
            ? first(["codex", /sol/i], ["codex", /./], ["claude", /opus/i])
            : first(["claude", /opus/i], ["claude", /sonnet/i], ["codex", /sol/i])
          : first(["claude", /sonnet/i], ["codex", /sol/i], ["gemini", /pro/i]);
  if (choice) return choice;
  const provider = usable[0] ?? lead;
  const model = fallback(provider);
  return model ? { provider, model } : { provider };
}

/** A role's effort for a model: the lowest for a quick helper, else the
 *  model's own default, else the middle of what it offers. */
export function roleEffort(role: RoleId | null, model: ProviderModel | undefined): string | undefined {
  if (!model || model.efforts.length === 0) return undefined;
  if (role === "quick") return model.efforts[0];
  return model.defaultEffort ?? model.efforts[Math.min(2, model.efforts.length - 1)];
}

/** A new helper with a role, on the model picked for it. */
export function roleWorker(role: RoleId, provider: Provider, model: ProviderModel | undefined, taken: string[], name: string): WorkerSlot {
  const effort = roleEffort(role, model);
  return {
    name: uniqueName(name, taken),
    provider,
    ...(model ? { model: model.id } : {}),
    ...(effort ? { effort } : {}),
    capabilities: [...ROLE_CAPABILITIES[role]],
    note: ROLE_NOTES[role],
  };
}

/** A helper given a new role: its tags, and its note when that was a role's. */
export function withRole(worker: WorkerSlot, role: RoleId): WorkerSlot {
  const ownNote = worker.note && !Object.values(ROLE_NOTES).includes(worker.note);
  return { ...worker, capabilities: [...ROLE_CAPABILITIES[role]], note: ownNote && worker.note ? worker.note : ROLE_NOTES[role] };
}

/** The shapes "New team" offers. */
export type StarterId = "solo" | "reviewed" | "studio" | "coders";
export const STARTERS: Record<StarterId, RoleId[]> = {
  solo: [],
  reviewed: ["reviewer"],
  studio: ["artist", "reviewer"],
  coders: ["coder", "coder", "coder"],
};

/** The lead a new team starts with: Opus when Claude can run, else the first
 *  provider that can lead. */
export function starterLead(catalogs: Catalogs, usable: readonly Provider[]): OrchestratorChoice {
  const provider = ORCHESTRATOR_PROVIDERS.find((candidate) => usable.includes(candidate)) ?? "claude";
  const model = provider === "claude" ? (catalogs.claude?.find((entry) => /opus/i.test(`${entry.id} ${entry.name}`)) ?? catalogs.claude?.find((entry) => entry.isDefault)) : catalogs[provider]?.find((entry) => entry.isDefault);
  const effort = model?.efforts.includes("high") ? "high" : model?.defaultEffort;
  return { provider, ...(model ? { model: model.id } : {}), ...(effort ? { effort } : {}) };
}

/** The workers a starter shape gets, each on its suggested model. */
export function starterCombo(starter: StarterId, catalogs: Catalogs, usable: readonly Provider[], lead: Provider, names: Record<RoleId, string>): Combo {
  const workers: WorkerSlot[] = [];
  for (const role of STARTERS[starter]) {
    const { provider, model } = suggestModel(role, catalogs, usable, lead);
    workers.push(roleWorker(role, provider, model, workers.map((worker) => worker.name), names[role]));
  }
  return { workers, nativeSubagents: false };
}

/** The providers a person can use now: installed and not signed out. */
export function usableProviders(providers: Array<{ provider: Provider; resolved?: unknown; auth?: { loggedIn?: boolean } }> | null): Provider[] {
  if (!providers) return [...PROVIDERS];
  return PROVIDERS.filter((provider) => {
    const info = providers.find((entry) => entry.provider === provider);
    return info ? Boolean(info.resolved) && info.auth?.loggedIn !== false : false;
  });
}

/** A model's display name from its provider's catalog, or its id. */
export function modelName(catalogs: Catalogs, provider: Provider, id: string | undefined): string | null {
  if (!id) return null;
  return catalogs[provider]?.find((model) => model.id === id)?.name ?? id;
}
