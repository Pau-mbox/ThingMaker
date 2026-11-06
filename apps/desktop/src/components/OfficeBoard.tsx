/**
 * The office whiteboard: when the lead writes a plan (Claude Code's todo
 * list, Codex's turn plan; ACP `plan` entries), a whiteboard on wheels rolls
 * into the lounge with the steps on it — ticked when done, the current one
 * marked — and rolls away once the plan is done and the turn is over.
 *
 * The frame is pixel art on the room's 160 pixel grid; the writing is real
 * text laid over its face, sized with the room so it reads at any width.
 */
import { memo } from "react";
import type { PlanContent, PlanEntry } from "@thingmaker/contracts";
import { t } from "../i18n";
import { ROOM } from "./officeArt";

/** Where the board stands: in the lounge, between the sofa and the fridge (before the lounge moves with the rows). */
export const BOARD = { x: 51, y: 218, w: 60, h: 45 } as const;
/** The writing surface inside the frame, in the board's own pixels. */
const FACE = { x: 2, y: 2, w: 56, h: 33 };
/** Steps written on the board at once; more than that, and the board shows the stretch around the current one. */
export const BOARD_LINES = 5;

type Status = "completed" | "in_progress" | "pending";
const statusOf = (entry: PlanEntry): Status => (entry.status === "completed" ? "completed" : entry.status === "in_progress" ? "in_progress" : "pending");

/** Whether the board is out: a plan of steps, with steps left or the turn still running. */
export function boardPlan(plan: PlanContent | null | undefined, running: boolean): Extract<PlanContent, { planType: "items" }> | null {
  if (!plan || plan.planType !== "items" || plan.entries.length === 0) return null;
  const left = plan.entries.some((entry) => statusOf(entry) !== "completed");
  return left || running ? plan : null;
}

/** The stretch of steps that fits: all of them when they fit, else from the step before the current one. */
export function boardWindow(entries: readonly PlanEntry[], lines = BOARD_LINES): { start: number; shown: PlanEntry[]; above: number; below: number } {
  if (entries.length <= lines) return { start: 0, shown: [...entries], above: 0, below: 0 };
  let at = entries.findIndex((entry) => statusOf(entry) === "in_progress");
  if (at < 0) at = entries.findIndex((entry) => statusOf(entry) === "pending");
  if (at < 0) at = entries.length - 1;
  const start = Math.max(0, Math.min(at - 1, entries.length - lines));
  return { start, shown: entries.slice(start, start + lines), above: start, below: entries.length - start - lines };
}

/** The frame, the face, the marker tray, the legs and the wheels, drawn on the board's own grid. */
function Frame() {
  return (
    <svg aria-hidden="true" className="office-board-frame" preserveAspectRatio="none" shapeRendering="crispEdges" viewBox={`0 0 ${BOARD.w} ${BOARD.h}`}>
      {/* Legs and their wheels. */}
      <rect fill="#9aa0ab" height="7" width="2" x="5" y="36" />
      <rect fill="#9aa0ab" height="7" width="2" x="53" y="36" />
      <rect fill="#9aa0ab" height="1" width="12" x="0" y="42" />
      <rect fill="#9aa0ab" height="1" width="12" x="48" y="42" />
      <rect fill="#23262f" height="2" width="2" x="0" y="43" />
      <rect fill="#23262f" height="2" width="2" x="10" y="43" />
      <rect fill="#23262f" height="2" width="2" x="48" y="43" />
      <rect fill="#23262f" height="2" width="2" x="58" y="43" />
      {/* The aluminium frame and the white face. */}
      <rect fill="#b9bdc6" height="37" width="60" />
      <rect fill="#d3d6dd" height="1" width="60" />
      <rect fill="#8d929d" height="1" width="60" y="36" />
      <rect fill="#fbfbf8" height={FACE.h} width={FACE.w} x={FACE.x} y={FACE.y} />
      <rect fill="#eef0f2" height="1" width={FACE.w} x={FACE.x} y={FACE.y + FACE.h - 1} />
      {/* The marker tray, with a red and a blue marker and an eraser. */}
      <rect fill="#8d929d" height="2" width="40" x="10" y="35" />
      <rect fill="#e5484d" height="1" width="5" x="14" y="34" />
      <rect fill="#2f5bd3" height="1" width="5" x="21" y="34" />
      <rect fill="#23262f" height="2" width="6" x="40" y="33" />
      <rect fill="#ffd400" height="1" width="6" x="40" y="33" />
    </svg>
  );
}

/** The whiteboard with the lead's plan on it. `dy` is how far the lounge has moved; `h` the room's height. */
export const OfficeBoard = memo(function OfficeBoard({ plan, dy, h }: { plan: Extract<PlanContent, { planType: "items" }>; dy: number; h: number }) {
  const done = plan.entries.filter((entry) => statusOf(entry) === "completed").length;
  const { start, shown, above, below } = boardWindow(plan.entries);
  const pct = (value: number, of: number) => `${(value / of) * 100}%`;
  const top = BOARD.y + dy;
  return (
    <div
      aria-label={t("Whiteboard: {done} of {total} steps done", { done, total: plan.entries.length })}
      className="office-board"
      role="img"
      style={{ left: pct(BOARD.x, ROOM.w), top: pct(top, h), width: pct(BOARD.w, ROOM.w), height: pct(BOARD.h, h), zIndex: Math.round(top + BOARD.h) }}
      title={plan.entries.map((entry, index) => `${statusOf(entry) === "completed" ? "✓" : statusOf(entry) === "in_progress" ? "▸" : "○"} ${index + 1}. ${entry.content}`).join("\n")}
    >
      <Frame />
      <div className="office-board-face" style={{ left: pct(FACE.x, BOARD.w), top: pct(FACE.y, BOARD.h), width: pct(FACE.w, BOARD.w), height: pct(FACE.h, BOARD.h) }}>
        <div className="office-board-head">
          <span>{t("Plan")}</span>
          <span className="office-board-count">
            {done}/{plan.entries.length}
          </span>
        </div>
        <ol className="office-board-steps" start={start + 1}>
          {shown.map((entry, index) => {
            const status = statusOf(entry);
            return (
              <li className={`office-board-step office-board-${status}`} key={`${start + index}-${entry.content}`}>
                <span aria-hidden="true" className="office-board-mark">
                  {status === "completed" ? "✓" : status === "in_progress" ? "▸" : "○"}
                </span>
                <span className="office-board-text">{entry.content}</span>
              </li>
            );
          })}
        </ol>
        {(above > 0 || below > 0) && (
          <div className="office-board-more">{[above > 0 ? t("✓ {n} above", { n: above }) : "", below > 0 ? t("+{n} more", { n: below }) : ""].filter(Boolean).join(" · ")}</div>
        )}
      </div>
    </div>
  );
});
