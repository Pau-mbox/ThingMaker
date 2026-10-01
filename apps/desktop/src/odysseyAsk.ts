/**
 * A decision the agent hands to the user (docs/plans/odyssey.md §11.10).
 *
 * The line is for the few things a human genuinely has to decide — an
 * ambiguous requirement, a fork in the architecture, constraints that
 * conflict, a failure that keeps recurring, a permission the agent cannot
 * grant itself. It does not stop the run: the agent names what it will do
 * meanwhile and carries on; the answer arrives on a later continuation.
 */
export const ASK_KINDS = ["ambiguity", "architecture", "conflict", "failure", "permission"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

/** Quoted in the briefing and the skill. `question=` is last because it runs to the end of the line. */
export const ASK_GRAMMAR = "BIGTHING-ASK: kind=<ambiguity|architecture|conflict|failure|permission> default=<what you do until you hear back> options=<a | b | c, optional> question=<one line>";

export type Ask = { kind: AskKind; fallback: string; options: string[]; question: string };

/** Every readable ask in a reply, in order. A line with no question is skipped. */
export function parseAsks(text: string): Ask[] {
  if (!text) return [];
  const asks: Ask[] = [];
  for (const match of text.matchAll(/^\s*(?:BIGTHING|SUPERTHING|ODYSSEY)-ASK:\s*(.+)$/gim)) {
    const body = match[1] ?? "";
    const question = /(?:^|\s)question\s*=\s*(.+)$/i.exec(body)?.[1]?.trim() ?? "";
    if (!question) continue;
    const head = body.slice(0, body.search(/(?:^|\s)question\s*=/i));
    const kindText = /(?:^|\s)kind\s*=\s*([a-z_]+)/i.exec(head)?.[1]?.toLowerCase();
    const kind = (ASK_KINDS as readonly string[]).includes(kindText ?? "") ? (kindText as AskKind) : "ambiguity";
    const fallback = /(?:^|\s)default\s*=\s*(.*?)(?=\s+(?:options|kind)\s*=|$)/i.exec(head)?.[1]?.trim() ?? "";
    const optionsText = /(?:^|\s)options\s*=\s*(.*?)(?=\s+(?:default|kind)\s*=|$)/i.exec(head)?.[1] ?? "";
    const options = optionsText
      .split("|")
      .map((option) => option.trim())
      .filter(Boolean);
    asks.push({ kind, fallback, options, question });
  }
  return asks;
}

export const ASK_KIND_LABEL: Record<AskKind, string> = {
  ambiguity: "Ambiguous requirement",
  architecture: "Architectural fork",
  conflict: "Conflicting constraints",
  failure: "Repeated failure",
  permission: "Permission needed",
};
