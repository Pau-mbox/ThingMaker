/**
 * Which messages in a transcript Big Thing wrote.
 *
 * Big Thing runs a goal by submitting prompts to the session as ordinary
 * turns, so the transcript is where the orchestration actually happens. Shown
 * as "You", those prompts made the conversation and the Big Thing board look
 * like two unrelated things; recognised, they can say who sent them and link
 * the two.
 *
 * Live, a prompt carries its submission id (`prompt-bigthing-…`, set by the
 * engine). History replayed by the provider has the provider's own ids, so the
 * fixed first lines the engine writes (`bigthing/prompt.rs`) are read as well.
 */
import type { Card } from "./projection";
import { withoutHandoff } from "./team";

export type BigThingTurn =
  | { kind: "briefing" }
  | { kind: "continuation"; milestone: number; total: number; title: string }
  | { kind: "planning" }
  | { kind: "other" };

const CONTINUATION = /^Continue\. Milestone (\d+)\/(\d+): (.*)\.$/;

export function bigThingTurnOf(messageId: string, text: string): BigThingTurn | null {
  const first = text.trimStart().split("\n", 1)[0] ?? "";
  const continuation = CONTINUATION.exec(first);
  if (continuation) return { kind: "continuation", milestone: Number(continuation[1]), total: Number(continuation[2]), title: continuation[3] ?? "" };
  if (first.startsWith("You are working under Big Thing")) return { kind: "briefing" };
  if (first.startsWith("You are setting up a Big Thing goal")) return { kind: "planning" };
  if (messageId.includes("bigthing-plan-")) return { kind: "planning" };
  if (messageId.includes("bigthing-")) return { kind: "other" };
  return null;
}

/** The text of a user message as Big Thing wrote it. */
export function userMessageText(card: Extract<Card, { kind: "message" }>): string {
  return card.message.blocks.map((block) => (block.type === "text" ? withoutHandoff(block.text) : "")).join("\n");
}

/**
 * The latest turn in which Big Thing sent the agent to a milestone, by its
 * title first — milestones can be reordered after the prompt went out — and by
 * its position when no title matches.
 */
export function milestoneTurnKey(cards: readonly Card[], index: number, title: string): string | null {
  let byPosition: string | null = null;
  for (let at = cards.length - 1; at >= 0; at -= 1) {
    const card = cards[at]!;
    if (card.kind !== "message" || card.message.role !== "user") continue;
    const turn = bigThingTurnOf(card.message.messageId, userMessageText(card));
    if (turn?.kind !== "continuation") continue;
    if (turn.title === title) return card.key;
    if (byPosition === null && turn.milestone === index + 1) byPosition = card.key;
  }
  return byPosition;
}

/** How a note from the side session starts (`SIDE_NOTE_PREFIX` in the engine). */
export const SIDE_NOTE_PREFIX = "[From the side transcript]";

/**
 * The side session's notes at the front of a message, and what the user wrote
 * after them. Each note is one line; the engine sends them ahead of the next
 * prompt when the main session had no turn to steer them into.
 */
export function splitSideNotes(text: string): { notes: string[]; rest: string } {
  const lines = text.split("\n");
  const notes: string[] = [];
  let at = 0;
  while (at < lines.length && lines[at]!.startsWith(SIDE_NOTE_PREFIX)) {
    notes.push(lines[at]!.slice(SIDE_NOTE_PREFIX.length).trim());
    at += 1;
  }
  return { notes, rest: notes.length > 0 ? lines.slice(at).join("\n").trim() : text };
}
