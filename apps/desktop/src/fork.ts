/**
 * Forks: copies of a session, listed under it as nested sessions.
 *
 * Pure helpers for naming a fork and for where "Fork from here" ends it.
 * Copying is the provider's own (`session/fork`): Claude Code copies up to
 * any of its messages, Codex copies a whole thread, and a provider that
 * cannot copy (or a Codex point before the end) starts a new session with a
 * brief of the conversation up to that point instead.
 */
import type { Provider } from "@thingmaker/contracts";
import type { Card } from "./projection";

/** `Title (fork)`, then `Title (fork 2)`, … — the first not already taken. */
export function forkTitle(base: string, taken: readonly string[]): string {
  const root = base.replace(/ \(fork(?: \d+)?\)$/, "");
  const names = new Set(taken);
  if (!names.has(`${root} (fork)`)) return `${root} (fork)`;
  for (let n = 2; ; n += 1) if (!names.has(`${root} (fork ${n})`)) return `${root} (fork ${n})`;
}

/** A branch for a fork in its own worktree: `fork/login-work-3f2a`. */
export function forkBranch(title: string, suffix = Math.random().toString(16).slice(2, 6)): string {
  const words = title
    .replace(/ \(fork(?: \d+)?\)$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  return `fork/${words.length > 0 ? words.join("-") : "session"}-${suffix}`;
}

/** Where a fork from a message ends, and what it starts with. */
export type ForkPoint = {
  /** The agent's message the copy ends at; absent copies the whole conversation. */
  at?: string;
  /** The last card the copy includes, for a copy made by brief. */
  upTo: number;
  /** Your own message to send again, edited, in the fork's composer. */
  draft?: string;
  /** Nothing comes before the point: the fork starts empty. */
  fresh?: boolean;
};

function isAgentMessage(card: Card | undefined): card is Extract<Card, { kind: "message" }> {
  return card?.kind === "message" && card.message.role === "agent";
}

function text(card: Extract<Card, { kind: "message" }>): string {
  return card.message.blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

/**
 * Forking at a card: an agent reply is kept with everything before it; your
 * own message is not — the copy ends at the reply before it, and the message
 * waits in the fork's composer to be edited and sent again.
 */
export function forkPointAt(cards: readonly Card[], index: number): ForkPoint | null {
  const card = cards[index];
  if (card?.kind !== "message" || card.message.role === "thought") return null;
  if (card.message.role === "agent") return { at: card.message.messageId, upTo: index };
  let before = index - 1;
  while (before >= 0 && !isAgentMessage(cards[before])) before -= 1;
  const draft = text(card) || undefined;
  if (before < 0) return { upTo: -1, fresh: true, ...(draft ? { draft } : {}) };
  const reply = cards[before] as Extract<Card, { kind: "message" }>;
  return { at: reply.message.messageId, upTo: before, ...(draft ? { draft } : {}) };
}

/** The last agent reply's message id: a copy that ends there is a whole copy. */
export function lastAgentMessage(cards: readonly Card[]): string | undefined {
  for (let index = cards.length - 1; index >= 0; index -= 1) {
    const card = cards[index];
    if (isAgentMessage(card)) return card.message.messageId;
  }
  return undefined;
}

/**
 * Whether the provider copies the session itself at this point, rather than
 * a new session starting from a brief: Claude Code at any reply, Codex only
 * the whole thread, Gemini never.
 */
export function copiesItself(provider: Provider, point: ForkPoint | undefined, cards: readonly Card[] | undefined): boolean {
  if (point?.fresh) return false;
  if (provider === "claude") return true;
  if (provider === "gemini") return false;
  return !point?.at || point.at === lastAgentMessage(cards ?? []);
}
