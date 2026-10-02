/**
 * A run of tool calls between two messages, folded into one line: "Explored
 * · read 6 files, searched 9 times · 18 steps". Open, it lists one plain
 * line per step, and a step opens on the raw call. A step that failed or
 * edited a file stays in view while the run is folded, and while the turn is
 * still going the line says what is happening now rather than piling up
 * boxes.
 */
import { useState, type ReactNode } from "react";
import type { ToolPatch } from "@thingmaker/contracts";
import type { Card } from "../projection";
import { useStore } from "../store";
import { stepDoing, stepOf, summarize, type Step, type StepVerb } from "../toolSteps";
import { IconChevron } from "./icons";

const GLYPH: Record<StepVerb, string> = { read: "◱", search: "⌕", list: "☰", run: "›_", edit: "✎", fetch: "↓", agent: "◎", other: "·" };
const WORD: Record<StepVerb, string> = { read: "Read", search: "Searched", list: "Listed", run: "Ran", edit: "Edited", fetch: "Fetched", agent: "Started", other: "Used" };
/** Edits and failures shown under a folded run before "and N more". */
const ALWAYS_SHOWN = 4;

function StepLine({ step, patch, renderDetail }: { step: Step; patch: ToolPatch; renderDetail: (patch: ToolPatch) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`tool-step tool-step-${step.verb} ${step.failed ? "tool-step-failed" : ""}`}>
      <button aria-expanded={open} className="tool-step-line" onClick={() => setOpen(!open)} type="button">
        <span aria-hidden="true" className="tool-step-glyph mono">
          {GLYPH[step.verb]}
        </span>
        {step.sentence ? (
          <span className="tool-step-text">{step.sentence}</span>
        ) : (
          <span className="tool-step-text">
            {step.parts.slice(0, 2).map((entry, index) => (
              <span key={index}>
                {index > 0 && <span className="muted"> · </span>}
                {index === 0 ? WORD[entry.verb] : WORD[entry.verb].toLowerCase()} {entry.target && <code>{entry.target}</code>} {entry.extra && <span className="muted">{entry.extra}</span>}
              </span>
            ))}
            {step.parts.length > 2 && <span className="muted"> · +{step.parts.length - 2} more</span>}
          </span>
        )}
        {step.running && <span aria-label="running" className="spinner spinner-xs" />}
        {step.failed && <span className="tool-step-flag">failed</span>}
      </button>
      {open && <div className="tool-step-detail">{renderDetail(patch)}</div>}
    </li>
  );
}

export function ToolGroup({
  cards,
  sessionId,
  live,
  renderDetail,
  renderCard,
}: {
  cards: Card[];
  sessionId: string;
  /** The last run in a turn that is still going. */
  live: boolean;
  renderDetail: (patch: ToolPatch) => ReactNode;
  renderCard: (card: Card) => ReactNode;
}) {
  const tools = useStore((s) => s.sessions[sessionId]?.projection.toolCalls);
  const roots = useStore((s) => {
    const workspaceId = s.sessions[sessionId]?.workspaceId;
    const workspace = s.workspaces.find((entry) => entry.id === workspaceId);
    return workspace ? `${workspace.canonicalRoot}\n${workspace.displayPath}` : "";
  });
  const [open, setOpen] = useState(false);
  const rootList = roots.split("\n").filter(Boolean);

  const entries: { card: Card; patch: ToolPatch | null; step: Step | null }[] = cards.map((card) => {
    const patch = card.kind === "tool" ? (tools?.get(card.toolCallId) ?? null) : null;
    return { card, patch, step: patch ? stepOf(patch, rootList) : null };
  });
  const steps = entries.filter((entry): entry is { card: Card; patch: ToolPatch; step: Step } => entry.step !== null && entry.patch !== null);
  if (steps.length === 0) return <>{cards.map((card) => renderCard(card))}</>;

  const { title, detail } = summarize(steps.map((entry) => entry.step));
  const running = steps.filter((entry) => entry.step.running);
  const current = running.at(-1) ?? (live ? steps.at(-1) : undefined);
  const notable = steps.filter((entry) => entry.step.failed || entry.step.verb === "edit");
  // Folded, the run still shows what needs a look; what is running now is
  // in the line itself.
  const inView = open ? [] : notable.slice(-ALWAYS_SHOWN);
  const failures = steps.filter((entry) => entry.step.failed).length;

  return (
    <section className={`tool-group ${live ? "tool-group-live" : ""}`}>
      <button aria-expanded={open} className="tool-group-head" onClick={() => setOpen(!open)} type="button">
        <IconChevron open={open} size={12} />
        {live ? (
          <>
            <span aria-label="working" className="spinner spinner-xs" />
            <span className="tool-group-title">Working</span>
            {current && <span className="tool-group-detail">· {stepDoing(current.step)}</span>}
          </>
        ) : (
          <>
            <span className="tool-group-title">{title}</span>
            {detail && <span className="tool-group-detail">· {detail}</span>}
          </>
        )}
        {failures > 0 && <span className="tool-step-flag">{failures} failed</span>}
        <span className="tool-group-count">
          {steps.length} step{steps.length === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <ol className="tool-step-list">
          {entries.map((entry) =>
            entry.step && entry.patch ? (
              <StepLine key={entry.card.key} patch={entry.patch} renderDetail={renderDetail} step={entry.step} />
            ) : (
              <li className="tool-step-other" key={entry.card.key}>
                {renderCard(entry.card)}
              </li>
            ),
          )}
        </ol>
      )}
      {!open && inView.length > 0 && (
        <ol className="tool-step-list tool-step-list-folded">
          {inView.map((entry) => (
            <StepLine key={entry.card.key} patch={entry.patch} renderDetail={renderDetail} step={entry.step} />
          ))}
          {notable.length > ALWAYS_SHOWN && <li className="small muted tool-step-more">and {notable.length - ALWAYS_SHOWN} more edits or failures — open the run to see them</li>}
        </ol>
      )}
    </section>
  );
}
