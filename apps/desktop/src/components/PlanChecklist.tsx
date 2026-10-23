/**
 * The agent's plan as a checklist (ACP `plan` updates).
 *
 * Claude Code's todo list, Codex's turn plan and anything else an adapter
 * reports as plan entries are drawn the same way: a card in the turn's flow,
 * which is the record, and a bar pinned above the composer while steps
 * remain, which is where you look to see how far along the agent is.
 */
import { useState } from "react";
import type { PlanContent, PlanEntry } from "@thingmaker/contracts";
import { t } from "../i18n";
import { Markdown } from "../markdown";
import { IconChevron, IconX } from "./icons";

type Status = "completed" | "in_progress" | "pending";

function statusOf(entry: PlanEntry): Status {
  if (entry.status === "completed") return "completed";
  if (entry.status === "in_progress") return "in_progress";
  return "pending";
}

function statusWord(status: Status): string {
  return status === "completed" ? t("done") : status === "in_progress" ? t("in progress") : t("to do");
}

export type PlanProgress = { done: number; total: number; current: PlanEntry | null; next: PlanEntry | null };

export function planProgress(plan: PlanContent): PlanProgress | null {
  if (plan.planType !== "items") return null;
  return {
    done: plan.entries.filter((entry) => statusOf(entry) === "completed").length,
    total: plan.entries.length,
    current: plan.entries.find((entry) => statusOf(entry) === "in_progress") ?? null,
    next: plan.entries.find((entry) => statusOf(entry) === "pending") ?? null,
  };
}

/** The plan's words, for transcript search. */
export function planText(plan: PlanContent): string {
  switch (plan.planType) {
    case "items":
      return plan.entries.map((entry) => entry.content).join("\n");
    case "markdown":
      return plan.content;
    case "file":
      return plan.uri;
    default:
      return plan.originalType;
  }
}

/** A step's mark, drawn rather than bordered so it stays even at this size:
 *  a ring of ten round dashes to do, an arc on a faint ring while the agent
 *  is on it (turning only while the turn runs), a filled check when done. */
function PlanMark({ status, live }: { status: Status; live: boolean }) {
  return (
    <svg aria-hidden="true" className={`plan-mark plan-mark-${status} ${status === "in_progress" && live ? "plan-mark-live" : ""}`} height="14" viewBox="0 0 14 14" width="14">
      {status === "completed" ? (
        <>
          <circle className="plan-mark-fill" cx="7" cy="7" r="7" />
          <path className="plan-mark-tick" d="M4.1 7.2 6.1 9.1 9.9 5.2" />
        </>
      ) : status === "in_progress" ? (
        <>
          <circle className="plan-mark-track" cx="7" cy="7" r="5.6" />
          <circle className="plan-mark-arc" cx="7" cy="7" pathLength="100" r="5.6" />
        </>
      ) : (
        <circle className="plan-mark-dots" cx="7" cy="7" pathLength="40" r="5.6" />
      )}
    </svg>
  );
}

function PlanItems({ entries, live }: { entries: PlanEntry[]; live: boolean }) {
  return (
    <ol className="plan-list">
      {entries.map((entry, index) => {
        const status = statusOf(entry);
        return (
          <li className={`plan-item plan-${status}`} key={`${index}|${entry.content}`}>
            <PlanMark live={live} status={status} />
            <span className="plan-text">{entry.content}</span>
            {entry.priority === "high" && <span className="chip small plan-priority">{t("high")}</span>}
            <span className="sr-only">, {statusWord(status)}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function PlanCard({ plan, live = false }: { plan: PlanContent; live?: boolean }) {
  const progress = planProgress(plan);
  return (
    <div className="card card-plan">
      <div className="plan-head small">
        <strong>{t("Plan")}</strong>
        {progress && (
          <span className="muted">
            {" "}
            · {t("{done} of {total} done", { done: progress.done, total: progress.total })}
          </span>
        )}
      </div>
      {plan.planType === "items" ? (
        <PlanItems entries={plan.entries} live={live} />
      ) : plan.planType === "markdown" ? (
        <Markdown source={plan.content} />
      ) : plan.planType === "file" ? (
        <span className="mono small">{plan.uri}</span>
      ) : (
        <span className="small muted">{t("a plan of a kind this version does not draw ({type})", { type: plan.originalType })}</span>
      )}
    </div>
  );
}

/**
 * The latest plan, pinned above the composer. Folded to one line by default:
 * how many steps are done and what the agent is on. It leaves once every step
 * is done and the turn is over, and hiding it lasts until the plan changes.
 */
export function PlanBar({ plan, active }: { plan: PlanContent; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState<string | null>(null);
  if (plan.planType !== "items" || plan.entries.length === 0) return null;
  const progress = planProgress(plan) as PlanProgress;
  const signature = JSON.stringify(plan.entries.map((entry) => [entry.content, entry.status ?? null]));
  const finished = progress.done === progress.total;
  if (hidden === signature || (finished && !active)) return null;
  const headline = progress.current?.content ?? (finished ? t("All steps done") : progress.next ? t("Next: {step}", { step: progress.next.content }) : "");
  return (
    <div className="plan-bar">
      <div className="plan-bar-row">
        <button aria-expanded={open} className="plan-bar-head" onClick={() => setOpen(!open)} title={open ? t("Fold the plan") : t("Show every step")} type="button">
          <IconChevron open={open} size={12} />
          <span className="plan-bar-count">
            {t("Plan {done}/{total}", { done: progress.done, total: progress.total })}
          </span>
          {progress.current && <PlanMark live={active} status="in_progress" />}
          <span className="plan-bar-current">{headline}</span>
        </button>
        <button aria-label={t("Hide the plan until it changes")} className="icon-button icon-button-xs" onClick={() => setHidden(signature)} title={t("Hide until the plan changes")} type="button">
          <IconX size={12} />
        </button>
      </div>
      <div aria-hidden="true" className="plan-meter">
        <span style={{ width: `${(100 * progress.done) / progress.total}%` }} />
      </div>
      {open && <PlanItems entries={plan.entries} live={active} />}
    </div>
  );
}
