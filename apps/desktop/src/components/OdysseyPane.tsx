/**
 * Big Thing: the long-horizon goal screen (docs/plans/odyssey.md §8).
 *
 * O2 scope: the plan and its record. Every number shown is read from the
 * database, and the parts a runner would fill in — checkpoints, live state,
 * the countdown — render from the journal and the goal row, so they are empty
 * rather than invented until O3/O4 land.
 *
 * The design rule that shapes this file: **verified and reported look
 * different**. A milestone the model claims is done is not a milestone a check
 * confirmed, and the screen must never let the two read the same.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ODYSSEY_STATE_NOTE, ORCHESTRATOR_PROVIDERS, PROVIDER_LABELS, type AdoptedPlan, type Orchestrator, type OnPlanChange, type OnReport, type CheckKind, type MilestoneRecord, type OdysseyView, type OnUsageReset, type Provider, type StopCondition, type TeamPreset } from "@thingmaker/contracts";
import { PLAN_REQUESTED, useStore } from "../store";
import { checkLabel } from "../odysseyPrompt";
import { milestoneTurnKey } from "../bigThingTurns";
import { countdown, exhaustedCeiling, hasRunnableCheck, stallDuration, stallNotice, usageVerdict, waitingUntil } from "../odysseyRunner";
import { RunHistory, RunMonitor, UsageWindows, SpendModelNote } from "./OdysseyActivity";
import { DocumentsCard } from "./OdysseyDocuments";
import { TaskTable } from "./OdysseyTasks";
import { InboxPanel, useInboxItems } from "./OdysseyInbox";
import { taskProgress } from "../odysseyTasks";
import { AmendDialog, AmendmentList } from "./OdysseyAmend";
import { MemoryPanel, RunOptions, Timeline, WorktreeCard, fill } from "./BigThingTeam";
import { WorkLanes } from "./WorkLanes";
import { isPlanDocument, fileNameOf, summarize, type DocumentSummary } from "../odysseyDocument";
import { planSummary, allManual } from "../odysseyPlan";
import { api } from "../ipc";
import { IconAlertCircle, IconCheckCircle, IconChevron, IconCode, IconDots, IconPlus, IconX } from "./icons";
import { t } from "../i18n";

const STOP_LABEL: Record<StopCondition, string> = {
  goal_complete: t("All milestones"),
  milestone_complete: t("After each milestone"),
  manual: t("When I stop it"),
};

const STOP_HINT: Record<StopCondition, string> = {
  goal_complete: t("Big Thing works through every milestone in order."),
  milestone_complete: t("Big Thing stops after each milestone and waits for you."),
  manual: t("Big Thing keeps going until you stop it."),
};

const RESET_LABEL: Record<OnUsageReset, string> = {
  continue_automatically: t("Continue automatically"),
  notify_only: t("Notify me"),
  stop: t("Stop"),
};

const RESET_HINT: Record<OnUsageReset, string> = {
  continue_automatically: t("Resumes from the last checkpoint at the provider's reset time."),
  notify_only: t("Tells you the quota is back; you decide when to resume."),
  stop: t("Leaves the goal paused without a notification."),
};

const REPORT_LABEL: Record<OnReport, string> = {
  continue: t("Carry on to the next one"),
  wait: t("Wait for me to verify it"),
};

const REPORT_HINT: Record<OnReport, string> = {
  continue: t("The milestone stays reported · unverified and the run keeps going. A check Big Thing can run itself is still run."),
  wait: t("The run pauses at every claim until a check passes or you tick it."),
};

const PLAN_CHANGE_LABEL: Record<OnPlanChange, string> = {
  tasks_auto: t("Tasks change on their own; milestones wait for me"),
  review: t("Everything waits for my decision"),
  auto: t("Everything applies at once; show me the diff afterwards"),
};
const PLAN_CHANGE_HINT: Record<OnPlanChange, string> = {
  tasks_auto: t(
    "How the agent cuts its work into tasks is its own business and lands at once. Adding or dropping a milestone, or changing one's title or check, comes to the Inbox as a diff.",
  ),
  review: t("Every change, down to a task's title, waits in the Inbox until you accept or reject it."),
  auto: t("The plan changes as soon as the agent proposes it; the diff is kept in the Inbox and the journal."),
};

const CHECK_LABEL: Record<CheckKind, string> = {
  manual: t("I tick it"),
  command: t("A command exits 0"),
  tests_pass: t("Tests pass"),
  files_exist: t("Files exist"),
};

/** "just now" / "4m ago": the age of a reason, said the way a person would. */
function ago(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 45) return t("just now");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("{minutes}m ago", { minutes });
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? t("{hours}h ago", { hours }) : t("{hours}h {minutes}m ago", { hours, minutes: minutes % 60 });
}

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Verified counts only what a check or the user confirmed (§5). */
function verifiedCount(milestones: MilestoneRecord[]): number {
  return milestones.filter((milestone) => milestone.state === "verified").length;
}

/**
 * The progress bar is the honesty carrier: filled for verified, outlined for
 * a milestone the model only claims, muted for the rest.
 */
function ProgressBar({ milestones }: { milestones: MilestoneRecord[] }) {
  return (
    <div aria-hidden="true" className="odyssey-progress">
      {milestones.map((milestone) => (
        <span className={`odyssey-progress-seg seg-${milestone.state}`} key={milestone.id} />
      ))}
    </div>
  );
}

/** How strong a piece of evidence is, in words the reader can weigh (§5.1). */
function laneLabel(milestone: MilestoneRecord): string {
  switch (milestone.checkSource) {
    case "agent_tool_result":
      return t("check run by the agent, exit code read from its tool result");
    case "user":
      return t("you ticked it");
    case "desktop":
      return t("check run by Big Thing");
    default:
      return t("no check has run");
  }
}

/** Whether Big Thing itself can run this milestone's check. */
const runnable = hasRunnableCheck;

/** The evidence sheet: what ran, in which lane, and what it printed. */
function EvidenceSheet({ milestone }: { milestone: MilestoneRecord }) {
  return (
    <div className="odyssey-evidence">
      <p className="small muted">
        {laneLabel(milestone)}
        {milestone.checkRanAt ? ` · ${new Date(milestone.checkRanAt).toLocaleString()}` : ""}
      </p>
      {milestone.checkOutput ? <pre className="text">{milestone.checkOutput}</pre> : <p className="small muted">{t("Nothing was recorded as output.")}</p>}
      {milestone.reportedNote && (
        <p className="small muted">
          {t("The model’s own note:")} <em>{milestone.reportedNote}</em>
        </p>
      )}
    </div>
  );
}

function MilestoneBadge({ milestone, sessionId }: { milestone: MilestoneRecord; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const verifyManually = useStore((s) => s.odysseyVerifyManually);
  const runCheck = useStore((s) => s.odysseyRunCheck);
  const busy = useStore((s) => s.odysseyRuntime[sessionId]?.ticking ?? false);

  const runButton = runnable(milestone) ? (
    <button className="button button-small" disabled={busy} onClick={() => void runCheck(sessionId, milestone.id)} title={t("Big Thing runs `{command}` and reads the exit code", { command: milestone.checkSpec ?? "" })} type="button">
      {busy ? t("Running…") : t("Run check")}
    </button>
  ) : null;

  if (milestone.state === "verified") {
    const lane = laneLabel(milestone);
    return (
      <>
        <button className="odyssey-badge badge-verified" onClick={() => setOpen(!open)} title={t("Verified: {lane}", { lane })} type="button">
          <IconCheckCircle size={13} /> {t("Verified")}
        </button>
        {open && <EvidenceSheet milestone={milestone} />}
      </>
    );
  }
  if (milestone.state === "reported") {
    return (
      <>
        <span className="odyssey-badge badge-reported" title={t("The model reported this complete. Nothing has checked it.")}>
          {t("reported · unverified")}
        </span>
        {runButton}
        <button
          className="button button-small"
          disabled={busy}
          onClick={() => void verifyManually(sessionId, milestone.id)}
          title={milestone.checkKind === "manual" ? t("Confirm it yourself; you are the evidence") : t("Accept it without running the check")}
          type="button"
        >
          {milestone.checkKind === "manual" ? t("Verify") : t("Accept anyway")}
        </button>
      </>
    );
  }
  if (milestone.state === "failed") {
    return (
      <>
        <button className="odyssey-badge badge-failed" onClick={() => setOpen(!open)} title={t("The check did not pass. Open it to see what it printed.")} type="button">
          <IconAlertCircle size={13} /> {t("Check failed")}
        </button>
        {runButton}
        {open && <EvidenceSheet milestone={milestone} />}
      </>
    );
  }
  if (milestone.state === "skipped") return <span className="odyssey-badge">{t("Skipped")}</span>;
  // Every task done and nothing reported: the work may well be finished — an
  // orchestrator running many milestones in one turn reports late or never —
  // so it can be checked or verified now rather than waiting on a claim.
  const tasksDone = milestone.steps.length > 0 && milestone.steps.every((step) => step.state === "done");
  const verifyNow = tasksDone ? (
    <button
      className="button button-small"
      disabled={busy}
      onClick={() => void verifyManually(sessionId, milestone.id)}
      title={milestone.checkKind === "manual" ? t("All its tasks are done: confirm it yourself") : t("All its tasks are done: accept it without running the check")}
      type="button"
    >
      {milestone.checkKind === "manual" ? t("Verify") : t("Accept")}
    </button>
  ) : null;
  if (milestone.state === "active") {
    return (
      <>
        <span className="odyssey-badge badge-active">{tasksDone ? t("Tasks done") : t("Active")}</span>
        {runButton}
        {verifyNow}
      </>
    );
  }
  return (
    <>
      <span className="odyssey-badge">{tasksDone ? t("Tasks done") : t("Planned")}</span>
      {tasksDone && runButton}
      {verifyNow}
    </>
  );
}

/** Milestones open until the user folds or unfolds one: those being worked. */
function workedIds(milestones: MilestoneRecord[]): Set<string> {
  return new Set(milestones.filter((milestone) => milestone.state === "active" || milestone.state === "reported" || milestone.state === "failed").map((milestone) => milestone.id));
}

/** The conversation turn where Big Thing sent the agent to this milestone. */
function SeeInConversation({ milestone, index, sessionId }: { milestone: MilestoneRecord; index: number; sessionId: string }) {
  const showInTranscript = useStore((s) => s.showInTranscript);
  const [missing, setMissing] = useState(false);
  if (missing) return <p className="small muted">{t("This milestone's turns are not in this session's conversation.")}</p>;
  return (
    <p className="small">
      <button
        className="link small"
        onClick={() => {
          const cards = useStore.getState().sessions[sessionId]?.projection.cards ?? [];
          const key = milestoneTurnKey(cards, index, milestone.title);
          if (key) showInTranscript(sessionId, key);
          else setMissing(true);
        }}
        title={t("Big Thing runs each milestone as turns of this session's conversation")}
        type="button"
      >
        {t("See it in the conversation")}
      </button>
    </p>
  );
}

function MilestoneRow({
  milestone,
  index,
  total,
  expanded,
  onToggle,
  sessionId,
}: {
  milestone: MilestoneRecord;
  index: number;
  total: number;
  expanded: boolean;
  onToggle: () => void;
  sessionId: string;
}) {
  const editMilestone = useStore((s) => s.editMilestone);
  const deleteMilestone = useStore((s) => s.deleteMilestone);
  const reorderMilestones = useStore((s) => s.reorderMilestones);
  const view = useStore((s) => s.odyssey[sessionId]);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(milestone.title);
  const [detail, setDetail] = useState(milestone.detail);
  const [checkKind, setCheckKind] = useState<CheckKind>(milestone.checkKind);
  const [checkSpec, setCheckSpec] = useState(milestone.checkSpec ?? "");
  const [section, setSection] = useState(milestone.section ?? "");
  const [showDetail, setShowDetail] = useState(false);
  // A detail is now the milestone's working specification and can run to a
  // few hundred words; the list shows its opening and opens on request.
  const longDetail = milestone.detail.length > 320;

  const move = (direction: -1 | 1) => {
    if (!view) return;
    const ids = view.milestones.map((entry) => entry.id);
    const from = ids.indexOf(milestone.id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to] as string, ids[from] as string];
    void reorderMilestones(sessionId, milestone.odysseyId, ids);
  };

  const save = () => {
    setEditing(false);
    void editMilestone(sessionId, milestone.id, {
      title,
      detail,
      checkKind,
      checkSpec: checkKind === "manual" ? null : checkSpec.trim() || null,
      section: section.trim() || null,
    });
  };

  return (
    <li className={`odyssey-milestone state-${milestone.state} ${expanded ? "expanded" : ""}`} data-milestone-index={index}>
      <div className="odyssey-node" aria-hidden="true">
        <span className="odyssey-node-mark">{milestone.state === "verified" ? <IconCheckCircle size={16} /> : index + 1}</span>
      </div>
      <div className="odyssey-milestone-body">
        <div className="odyssey-milestone-head">
          <button className="odyssey-milestone-title" onClick={onToggle} type="button">
            <span>{milestone.title}</span>
            <IconChevron open={expanded} size={13} />
          </button>
          {milestone.steps.length > 0 && (
            <span className="odyssey-milestone-progress small muted" title={t("tasks done")}>
              {t("{done} / {total} tasks", { done: milestone.steps.filter((step) => step.state === "done").length, total: milestone.steps.length })}
              <span className="odyssey-meter odyssey-meter-mini" aria-hidden="true">
                <span style={{ width: `${Math.round((milestone.steps.filter((step) => step.state === "done").length / milestone.steps.length) * 100)}%` }} />
              </span>
            </span>
          )}
          <MilestoneBadge milestone={milestone} sessionId={sessionId} />
          <span className="row-actions">
            <button aria-label={t("Move {title} up", { title: milestone.title })} className="icon-button icon-button-xs row-action" disabled={index === 0} onClick={() => move(-1)} title={t("Move up (⌥↑)")} type="button">
              ↑
            </button>
            <button aria-label={t("Move {title} down", { title: milestone.title })} className="icon-button icon-button-xs row-action" disabled={index === total - 1} onClick={() => move(1)} title={t("Move down (⌥↓)")} type="button">
              ↓
            </button>
            <button aria-label={t("Edit {title}", { title: milestone.title })} className="icon-button icon-button-xs row-action" onClick={() => setEditing(!editing)} title={t("Edit")} type="button">
              <IconDots size={14} />
            </button>
            <button aria-label={t("Remove {name}", { name: milestone.title })} className="icon-button icon-button-xs row-action" onClick={() => void deleteMilestone(sessionId, milestone.id)} title={t("Remove")} type="button">
              <IconX size={14} />
            </button>
          </span>
        </div>
        {expanded && milestone.detail && !editing && (
          <p className="odyssey-detail small">
            {longDetail && !showDetail ? `${milestone.detail.slice(0, 300).trimEnd()}…` : milestone.detail}
            {longDetail && (
              <>
                {" "}
                <button className="link small" onClick={() => setShowDetail(!showDetail)} type="button">
                  {showDetail ? t("less") : t("more")}
                </button>
              </>
            )}
          </p>
        )}
        {expanded && milestone.section && !editing && (
          <p className="small muted odyssey-section" title={t("where in the plan document this milestone comes from")}>
            {t("spec:")} <span className="mono">{milestone.section}</span>
          </p>
        )}
        {expanded && milestone.reportedNote && milestone.state === "reported" && (
          <p className="odyssey-detail small muted" title={t("the model's own words, not a verification")}>
            {t("Model's note: {note}", { note: milestone.reportedNote })}
          </p>
        )}
        {expanded && !editing && <p className="small muted odyssey-check">{checkLabel(milestone.checkKind, milestone.checkSpec)}</p>}
        {expanded && !editing && milestone.state !== "planned" && milestone.state !== "skipped" && <SeeInConversation index={index} milestone={milestone} sessionId={sessionId} />}

        {editing && (
          <form
            className="odyssey-edit"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <input aria-label={t("Milestone title")} className="input" onChange={(event) => setTitle(event.target.value)} value={title} />
            <textarea aria-label={t("Milestone detail")} className="textarea" onChange={(event) => setDetail(event.target.value)} rows={2} value={detail} />
            <input
              aria-label={t("Specification section")}
              className="input"
              onChange={(event) => setSection(event.target.value)}
              placeholder={t("where in the plan document this comes from (heading or line range)")}
              value={section}
            />
            <div className="row wrap">
              <label className="small muted">
                {t("Done when")}
                <select className="select" onChange={(event) => setCheckKind(event.target.value as CheckKind)} value={checkKind}>
                  {(Object.keys(CHECK_LABEL) as CheckKind[]).map((kind) => (
                    <option key={kind} value={kind}>
                      {CHECK_LABEL[kind]}
                    </option>
                  ))}
                </select>
              </label>
              {checkKind !== "manual" && (
                <input
                  aria-label={t("Check specification")}
                  className="input"
                  onChange={(event) => setCheckSpec(event.target.value)}
                  placeholder={checkKind === "files_exist" ? t("one path per line") : t("command to run")}
                  value={checkSpec}
                />
              )}
              <button className="button button-small" type="submit">
                {t("Save")}
              </button>
              <button className="button button-small" onClick={() => setEditing(false)} type="button">
                {t("Cancel")}
              </button>
            </div>
          </form>
        )}

        {expanded && <TaskTable milestone={milestone} milestoneIndex={index} sessionId={sessionId} />}
      </div>
    </li>
  );
}

/** What an agent is called on screen. */
export const AGENT_LABEL: Record<Provider, string> = PROVIDER_LABELS;

/**
 * The *subscription* a run is spending, which is the thing a reader actually
 * needs and is not quite the same word as the agent: Claude Code spends the
 * Claude plan, Codex the ChatGPT one.
 */
export const ACCOUNT_LABEL: Record<Provider, string> = { claude: "Claude", codex: "ChatGPT", gemini: "Google" };

const ACCOUNT_HINT: Record<Provider, string> = {
  claude: t("This run is on Claude Code, which spends the Claude subscription. Its own subagents spend the same account."),
  codex: t("This run is on Codex, which spends the ChatGPT subscription. Its own subagents spend the same account."),
  gemini: t("This run is on Gemini through Antigravity, which spends the Google account's Antigravity quota."),
};

const ORCHESTRATOR_LABEL: Record<Orchestrator, string> = { claude: t("Claude only"), codex: t("Codex only"), either: t("Either account") };

const ORCHESTRATOR_HINT: Record<Orchestrator, string> = {
  claude: t("This goal always runs on Claude Code, on the Claude subscription."),
  codex: t("This goal always runs on Codex, on the ChatGPT subscription."),
  either: t(
    "Big Thing keeps the run where it is and moves it to the other account when this one is spent and the other is not. A move costs a fresh briefing — worth it against a five-hour wait and nothing less. At most one move an hour, never mid-turn.",
  ),
};

/**
 * Moving the run to another session
 * (docs/plans/odyssey-second-orchestrator.md §2.3).
 *
 * The one-click "restart the session without losing the run", and the same
 * mechanism failover uses. The open sessions of this workspace are offered
 * first, because moving to one that is already attached costs nothing; a
 * fresh session of either agent is the other way.
 */
function MoveMenu({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const moveTo = useStore((s) => s.odysseyMoveTo);
  const sessions = useStore((s) => s.sessions);
  const goals = useStore((s) => s.odyssey);
  const here = sessions[sessionId];
  if (!here) return null;
  // A session already driving a live goal cannot take this one: the record
  // allows exactly one live goal per session, and the move would be refused.
  const others = Object.entries(sessions).filter(([key, session]) => key !== sessionId && session.workspaceId === here.workspaceId && !goals[key]);
  return (
    <>
      <button aria-expanded={open} className="link small" onClick={() => setOpen(!open)} type="button">
        {t("move to…")}
      </button>
      {open && (
        // A span, not a div: this sits inside the strip's inline row of
        // actions, and a block element there is invalid nesting.
        <span className="row wrap odyssey-move" role="group" aria-label={t("Move this run to another session")}>
          {others.map(([key, session]) => (
            <button
              className="button button-small"
              key={key}
              onClick={() => {
                setOpen(false);
                void moveTo(sessionId, { kind: "session", sessionId: key });
              }}
              type="button"
            >
              {AGENT_LABEL[session.snapshot.provider]} · {session.snapshot.agentSessionId ?? key}
            </button>
          ))}
          {ORCHESTRATOR_PROVIDERS.map((agent) => (
            <button
              className="button button-small"
              key={agent}
              onClick={() => {
                setOpen(false);
                void moveTo(sessionId, { kind: "new", agent });
              }}
              type="button"
            >
              {t("new {agent} session", { agent: AGENT_LABEL[agent] })}
            </button>
          ))}
          <span className="small muted">
            {fill(t("The record moves; the conversation does not. The new session is briefed from the plan and from {note}."), { note: <code>{ODYSSEY_STATE_NOTE}</code> })}
          </span>
        </span>
      )}
    </>
  );
}

/**
 * State card (§8.4). It changes shape per state rather than swapping a label,
 * because while a run is unattended this is the only thing worth looking at.
 */
function StateCard({ view, sessionId }: { view: OdysseyView; sessionId: string }) {
  const { goal, milestones } = view;
  const runtime = useStore((s) => s.odysseyRuntime[sessionId]);
  const session = useStore((s) => s.sessions[sessionId]);
  // The account *this* session spends, not "the subscription": a run on one
  // provider parked against another's windows would be waiting on a number
  // that has nothing to do with it.
  const agent: Provider = session?.snapshot.provider ?? "claude";
  const usage = useStore((s) => s.usage[agent] ?? null);
  const odysseyStart = useStore((s) => s.odysseyStart);
  const editOdysseyGoal = useStore((s) => s.editOdysseyGoal);
  const odysseyPause = useStore((s) => s.odysseyPause);
  const notes = useStore((s) => s.odysseyNotes[sessionId]);
  const refreshNotes = useStore((s) => s.odysseyRefreshNotes);
  const [now, setNow] = useState(Date.now());
  // The strip carries what decides anything; the rest opens on request.
  const [details, setDetails] = useState(false);
  // A row written before migration 16 carries no orchestrator. The strip is
  // the one thing on screen during an unattended run, so it renders from a
  // default rather than blanking on a field that is not there yet.
  const orchestrator: Orchestrator = goal.orchestrator ?? "claude";
  const tasks = taskProgress(milestones);

  // The run's memory on disk, re-read whenever the record moves.
  const latestId = view.journal[0]?.id ?? null;
  useEffect(() => {
    if (goal.state === "draft") return;
    void refreshNotes(sessionId);
  }, [sessionId, goal.state, latestId, refreshNotes]);

  const waiting = goal.state === "waiting_usage";
  // The clock also has to run while the runner is held up, or the age of the
  // reason freezes at whatever it was when the card last rendered.
  const ticking = waiting || goal.state === "running";
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  const verified = verifiedCount(milestones);
  const budgetPct = goal.tokenBudget ? Math.min(100, Math.round((goal.tokensUsed / goal.tokenBudget) * 100)) : null;
  const continuationPct = Math.min(100, Math.round((goal.continuationsUsed / Math.max(1, goal.maxContinuations)) * 100));
  const verdict = usageVerdict(usage);
  const ceiling = goal.state === "blocked" ? exhaustedCeiling(goal) : null;
  // The same fallback the runner uses. Reading only the in-memory value made
  // the card announce "no reset time" directly above a usage readout showing
  // the reset time, because that value does not survive a reload.
  const resumeAt = waitingUntil(usage, runtime?.resumeAt ?? null);
  const stall = goal.state === "running" ? stallNotice({ reason: runtime?.lastReason ?? "", since: runtime?.stalledSince ?? null, now }) : null;
  // How long the session itself has been quiet, which is what the cancel reads.
  const silentFor = session?.lastEventAt && session.projection.foreground === "running" ? now - session.lastEventAt : null;

  const title =
    goal.state === "draft"
      ? t("Not started")
      : goal.state === "running"
        ? t("Running")
        : goal.state === "waiting_usage"
          ? t("Waiting for {account}'s usage window", { account: ACCOUNT_LABEL[agent] })
          : goal.state === "paused"
            ? t("Paused")
            : goal.state === "blocked"
              ? t("Blocked")
              : goal.state === "complete"
                ? t("Complete")
                : t("Abandoned");

  return (
    <section className={`card odyssey-state odyssey-strip state-${goal.state}`} aria-live="polite" role="status">
      <header className="work-head">
        <span className={`work-glyph ${goal.state === "complete" ? "glyph-ok" : goal.state === "blocked" ? "glyph-fail" : ""}`}>
          {goal.state === "running" ? <span className="spinner" /> : goal.state === "complete" ? <IconCheckCircle size={14} /> : goal.state === "blocked" ? <IconAlertCircle size={14} /> : <IconCode size={14} />}
        </span>
        <span className="work-title">{title}</span>
        {/* Which subscription this run is spending, next to what it is doing
            rather than at the end of a row of numbers. Buried among the
            stats it read as one more figure, and a run that had moved
            accounts looked identical to one that had not. */}
        <span className={`odyssey-account account-${agent}`} title={ACCOUNT_HINT[agent]}>
          {ACCOUNT_LABEL[agent]}
          {orchestrator === "either" && <span className="muted"> · {t("may move")}</span>}
        </span>
        {/* The facts that used to fill a card, in one line. */}
        <span className="odyssey-strip-facts small">
          <span>
            <span className="muted">{t("tasks")} </span>
            <span>{t("{done} of {total}", { done: tasks.done, total: tasks.total })}</span>
          </span>
          <span>
            <span className="muted">{t("milestones")} </span>
            <span>{t("{done} of {total}", { done: verified, total: milestones.length })}</span>
          </span>
          <span>
            <span className="muted">{t("continuations")} </span>
            <span>{t("{done} of {total}", { done: goal.continuationsUsed, total: goal.maxContinuations })}</span>
          </span>
          <span>
            <span className="muted">{t("tokens")} </span>
            <span>
              {goal.tokenBudget
                ? t("{done} of {total}", { done: goal.tokensUsed.toLocaleString(), total: goal.tokenBudget.toLocaleString() })
                : t("{used} · no budget", { used: goal.tokensUsed.toLocaleString() })}
            </span>
          </span>
        </span>
        <span className="row-actions">
          <button aria-expanded={details} className="link small" onClick={() => setDetails(!details)} type="button">
            {details ? t("hide details") : t("details")}
          </button>
          {(goal.state === "draft" || goal.state === "paused" || goal.state === "blocked") && (
            // A draft with no milestones has nothing to run; starting it would
            // only trip the runner's own guard.
            <button
              className="button button-small button-primary"
              disabled={(goal.state === "draft" && milestones.length === 0) || ceiling !== null}
              onClick={() => void odysseyStart(sessionId)}
              title={
                ceiling !== null
                  ? t("Resuming cannot clear a budget; raise the ceiling below")
                  : goal.state === "draft" && milestones.length === 0
                    ? t("Add a milestone, or let the agent propose them from the plan document")
                    : undefined
              }
              type="button"
            >
              {goal.state === "draft" ? t("Start") : t("Resume")}
            </button>
          )}
          {(goal.state === "running" || goal.state === "waiting_usage") && (
            <button className="button button-small" onClick={() => void odysseyPause(sessionId)} type="button">
              {t("Pause")}
            </button>
          )}
          {goal.state !== "draft" && goal.state !== "complete" && <MoveMenu sessionId={sessionId} />}
        </span>
      </header>
      <div className="odyssey-state-body">
        {waiting && (
          <>
            {verdict.kind !== "exhausted" ? (
              // Parked, but the latest sample says there is room: the next
              // poll resumes it. Showing a countdown here was the bug — it
              // counted down to a reset the runner was no longer waiting on.
              <p className="small muted">{t("Usage is back; the run picks up on the next check.")}</p>
            ) : resumeAt === null ? (
              <p className="small chip-warn">
                {t("{account} reported no reset time, so this goal cannot resume on a clock. Resume it yourself when that account’s quota is back.", { account: ACCOUNT_LABEL[agent] })}
              </p>
            ) : (
              <>
                <p className="small muted">
                  {fill(t("{account} reset time {time}"), {
                    account: ACCOUNT_LABEL[agent],
                    time: <time dateTime={new Date(resumeAt).toISOString()}>{new Date(resumeAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time>,
                  })}
                </p>
                {/* The clock is decoration for a screen reader; the state above says what matters. */}
                <p aria-hidden="true" className="odyssey-countdown">
                  {countdown(resumeAt - now)} <span className="small muted">{t("remaining")}</span>
                </p>
              </>
            )}
            <p className="small muted">
              {goal.onUsageReset === "continue_automatically"
                ? t("Auto-resume is on: Big Thing re-checks usage at the reset time and picks up from the last checkpoint.")
                : goal.onUsageReset === "notify_only"
                  ? t("You will be told when the quota is back; the run waits for you.")
                  : t("This goal is set to stop at the reset.")}
            </p>
          </>
        )}
        {details && <RunMonitor sessionId={sessionId} view={view} />}
        {/* Only a run that is actually stuck is warned about; the engine
            does not count a turn in flight or workers on tasks as stuck. */}
        {stall && <p className="small chip-warn">{stall}</p>}
        {/* A quiet turn is still a turn; this only says when the silent-turn
            cancel would step in, once the quiet has lasted a while. */}
        {silentFor !== null && silentFor >= 5 * 60_000 && goal.deadTurnMinutes > 0 && (
          <p className="small muted">
            {t("No events from the session for {time}; Big Thing cancels the turn if it stays silent for {minutes} minutes.", {
              time: stallDuration(silentFor),
              minutes: goal.deadTurnMinutes,
            })}
          </p>
        )}
        {/* The reason shows in every state and carries its age: a reason with
            no age reads as current when it is an hour old, which is exactly
            how a wedged run hid. */}
        {runtime?.lastReason && !stall && (
          <p className="small muted">
            {runtime.lastReason}
            {runtime.lastReasonAt > 0 && <span className="muted"> · {ago(now - runtime.lastReasonAt)}</span>}
          </p>
        )}
        {runtime?.forecast && <p className="small muted">{t("Forecast: {forecast}.", { forecast: runtime.forecast })}</p>}
        {goal.state === "blocked" && <p className="small chip-warn">{view.journal.find((entry) => entry.kind === "guard")?.summary ?? t("Blocked.")}</p>}
        {/* Resume writes "running" and the guard writes "blocked" again on the
            same tick, so offering it here would be offering nothing. The only
            thing that clears a budget is a bigger budget. */}
        {ceiling && (
          <div className="row wrap odyssey-ceiling">
            <span className="small muted">
              {ceiling.kind === "tokens"
                ? t("Resuming cannot clear this: {used} of {limit} tokens are spent.", { used: ceiling.used.toLocaleString(), limit: ceiling.limit.toLocaleString() })
                : t("Resuming cannot clear this: {used} of {limit} continuations are spent.", { used: ceiling.used.toLocaleString(), limit: ceiling.limit.toLocaleString() })}
            </span>
            <button
              className="button button-small button-primary"
              onClick={() => {
                const raised = ceiling.limit + ceiling.step;
                void (async () => {
                  await editOdysseyGoal(sessionId, goal.id, ceiling.kind === "tokens" ? { tokenBudget: raised } : { maxContinuations: raised });
                  await odysseyStart(sessionId);
                })();
              }}
              type="button"
            >
              {t("Allow {count} more and resume", { count: ceiling.step.toLocaleString() })}
            </button>
          </div>
        )}
        {goal.state === "draft" && (
          <p className="small muted">
            {milestones.length === 0
              ? t("This goal has no milestones yet.")
              : goal.planSource
                ? t("Starting accepts the plan as it stands and submits the briefing to this session. You can read the briefing first.")
                : t("Starting submits the briefing to this session. You can read it first.")}
          </p>
        )}
        {goal.state === "complete" &&
          (milestones.some((milestone) => milestone.state === "reported") ? (
            <p className="small chip-warn">
              {milestones.filter((milestone) => milestone.state === "reported").length === 1
                ? t("{count} milestone is the agent’s word alone. Tick them if you have checked them.", { count: 1 })
                : t("{count} milestones are the agent’s word alone. Tick them if you have checked them.", {
                    count: milestones.filter((milestone) => milestone.state === "reported").length,
                  })}
            </p>
          ) : (
            <p className="small muted">{t("Every milestone is verified or skipped.")}</p>
          ))}

        {!waiting && verdict.kind === "exhausted" && (
          <p className="small chip-warn">
            {t("The {account} account is spent: {reason}.", { account: ACCOUNT_LABEL[agent], reason: verdict.reason })}
          </p>
        )}
        {details && (
          <div className="odyssey-state-details">
            <div className="odyssey-meter" title={t("{percent}% of the continuation limit", { percent: continuationPct })}>
              <span style={{ width: `${continuationPct}%` }} />
            </div>
            {budgetPct !== null && (
              <div className="odyssey-meter" title={t("{percent}% of the token budget", { percent: budgetPct })}>
                <span style={{ width: `${budgetPct}%` }} />
              </div>
            )}
            {/* The handoff note is the run's memory across compaction and
                restarts; whether it is being kept is worth one line. */}
            {goal.state !== "draft" && notes !== undefined && (
              <p className="small muted odyssey-handoff">
                {notes?.state ? (
                  <>
                    {fill(t("Handoff note {note} updated {time}"), { note: <span className="mono">{ODYSSEY_STATE_NOTE}</span>, time: ago(now - notes.state.modifiedAtUnixMs) })}
                    {notes.agentNotes.length > 0 && (
                      <>
                        {" · "}
                        {notes.agentNotes.length === 1
                          ? t("{count} subagent note", { count: 1 })
                          : t("{count} subagent notes", { count: notes.agentNotes.length })}
                      </>
                    )}
                  </>
                ) : (
                  <>
                    {fill(t("No handoff note yet. The agent is asked to create {note} on its next turn."), { note: <span className="mono">{ODYSSEY_STATE_NOTE}</span> })}
                  </>
                )}
              </p>
            )}
            {/* The numbers the wait is decided from, so they can be checked
                against the provider's own meter. */}
            <UsageWindows agent={agent} usage={usage} />
            {goal.state !== "draft" && <SpendModelNote odysseyId={goal.id} refreshKey={view.journal.length} />}
          </div>
        )}
      </div>
    </section>
  );
}

function Settings({ view, sessionId }: { view: OdysseyView; sessionId: string }) {
  const editOdysseyGoal = useStore((s) => s.editOdysseyGoal);
  const runningOn = useStore((s) => s.sessions[sessionId]?.snapshot.provider);
  const { goal } = view;
  const [budget, setBudget] = useState(goal.tokenBudget ? String(goal.tokenBudget) : "");
  const [max, setMax] = useState(String(goal.maxContinuations));
  const [deadTurn, setDeadTurn] = useState(String(goal.deadTurnMinutes));
  const [testCommand, setTestCommand] = useState(goal.defaultCheck ?? "");

  return (
    <section className="card odyssey-settings">
      <header className="work-head">
        <span className="work-title">{t("Settings")}</span>
      </header>
      <div className="odyssey-state-body">
        <label className="odyssey-field">
          <span className="small">{t("Test command")}</span>
          <input
            aria-label={t("Test command")}
            className="input mono"
            onBlur={() => {
              const trimmed = testCommand.trim();
              if (trimmed !== (goal.defaultCheck ?? "")) void editOdysseyGoal(sessionId, goal.id, { defaultCheck: trimmed || null });
            }}
            onChange={(event) => setTestCommand(event.target.value)}
            placeholder={t("e.g. pnpm test, or python3 Tools/check.py")}
            value={testCommand}
          />
          <span className="small muted">
            {t(
              "Run from the project root. The planner is told to make it each milestone’s check unless the document names a better one, so a claim is verified by Big Thing rather than waiting for your tick. Nothing here runs until a milestone with that check is reported.",
            )}
          </span>
        </label>
        <label className="odyssey-field">
          <span className="small">{t("Stop when")}</span>
          <select aria-label={t("Stop when")} className="select" onChange={(event) => void editOdysseyGoal(sessionId, goal.id, { stopCondition: event.target.value as StopCondition })} value={goal.stopCondition}>
            {(Object.keys(STOP_LABEL) as StopCondition[]).map((value) => (
              <option key={value} value={value}>
                {STOP_LABEL[value]}
              </option>
            ))}
          </select>
          <span className="small muted">{STOP_HINT[goal.stopCondition]}</span>
        </label>
        <label className="odyssey-field">
          <span className="small">{t("When usage resets")}</span>
          <select aria-label={t("When usage resets")} className="select" onChange={(event) => void editOdysseyGoal(sessionId, goal.id, { onUsageReset: event.target.value as OnUsageReset })} value={goal.onUsageReset}>
            {(Object.keys(RESET_LABEL) as OnUsageReset[]).map((value) => (
              <option key={value} value={value}>
                {RESET_LABEL[value]}
              </option>
            ))}
          </select>
          <span className="small muted">{RESET_HINT[goal.onUsageReset]}</span>
        </label>
        <label className="odyssey-field">
          <span className="small">{t("Which account runs it")}</span>
          <select aria-label={t("Which account runs it")} className="select" onChange={(event) => void editOdysseyGoal(sessionId, goal.id, { orchestrator: event.target.value as Orchestrator })} value={goal.orchestrator ?? "claude"}>
            {(Object.keys(ORCHESTRATOR_LABEL) as Orchestrator[]).map((value) => (
              <option key={value} value={value}>
                {ORCHESTRATOR_LABEL[value]}
              </option>
            ))}
          </select>
          <span className="small muted">
            {ORCHESTRATOR_HINT[goal.orchestrator ?? "claude"]}
            {/* The setting is a policy; this says where the run actually is,
                which is not the same thing after a move or a failover. */}
            {runningOn && <> {t("Right now it is running on {account}.", { account: ACCOUNT_LABEL[runningOn] })}</>}
          </span>
        </label>
        <RunOptions onEdit={(edit) => void editOdysseyGoal(sessionId, goal.id, edit)} view={view} />
        <label className="odyssey-field">
          <span className="small">{t("When the agent says a milestone is done")}</span>
          <select aria-label={t("When the agent says a milestone is done")} className="select" onChange={(event) => void editOdysseyGoal(sessionId, goal.id, { onReport: event.target.value as OnReport })} value={goal.onReport}>
            {(Object.keys(REPORT_LABEL) as OnReport[]).map((value) => (
              <option key={value} value={value}>
                {REPORT_LABEL[value]}
              </option>
            ))}
          </select>
          <span className="small muted">{REPORT_HINT[goal.onReport]}</span>
        </label>
        <label className="odyssey-field">
          <span className="small">{t("When the agent proposes a plan change")}</span>
          <select aria-label={t("When the agent proposes a plan change")} className="select" onChange={(event) => void editOdysseyGoal(sessionId, goal.id, { onPlanChange: event.target.value as OnPlanChange })} value={goal.onPlanChange}>
            {(Object.keys(PLAN_CHANGE_LABEL) as OnPlanChange[]).map((value) => (
              <option key={value} value={value}>
                {PLAN_CHANGE_LABEL[value]}
              </option>
            ))}
          </select>
          <span className="small muted">{PLAN_CHANGE_HINT[goal.onPlanChange]}</span>
        </label>
        <label className="odyssey-field">
          <span className="small">{t("Cancel a silent turn after")}</span>
          <input
            aria-label={t("Cancel a silent turn after")}
            className="input"
            inputMode="numeric"
            onBlur={() => {
              const value = Number.parseInt(deadTurn, 10);
              if (Number.isFinite(value) && value >= 0 && value !== goal.deadTurnMinutes) void editOdysseyGoal(sessionId, goal.id, { deadTurnMinutes: value });
            }}
            onChange={(event) => setDeadTurn(event.target.value)}
            value={deadTurn}
          />
          <span className="small muted">
            {t("Minutes with no events at all while a turn is running. A turn that goes quiet cannot settle, and nothing else would ever free the run. 0 never cancels.")}
          </span>
        </label>
        <label className="odyssey-field">
          <span className="small">{t("Continuation limit")}</span>
          <input
            className="input"
            inputMode="numeric"
            onBlur={() => {
              const value = Number.parseInt(max, 10);
              if (Number.isFinite(value) && value > 0 && value !== goal.maxContinuations) void editOdysseyGoal(sessionId, goal.id, { maxContinuations: value });
            }}
            onChange={(event) => setMax(event.target.value)}
            value={max}
          />
          <span className="small muted">{t("Big Thing stops after this many continuations, whatever state the goal is in.")}</span>
        </label>
        <label className="odyssey-field">
          <span className="small">{t("Token budget")}</span>
          <input
            className="input"
            inputMode="numeric"
            onBlur={() => {
              const trimmed = budget.trim();
              const value = trimmed ? Number.parseInt(trimmed, 10) : null;
              if (value === null || Number.isFinite(value)) void editOdysseyGoal(sessionId, goal.id, { tokenBudget: value });
            }}
            onChange={(event) => setBudget(event.target.value)}
            placeholder={t("no budget")}
            value={budget}
          />
          <span className="small muted">{t("Paid input and output, counted from the agent's own transcript. Blank means no ceiling.")}</span>
        </label>
        <SkillRow />
      </div>
    </section>
  );
}

/**
 * The protocol document the briefing offers the model. It is installed with
 * the first briefing; this row says where it went and lets it be reinstalled
 * after a hand-edit.
 */
function SkillRow() {
  const setError = useStore((s) => s.setError);
  const [state, setState] = useState<{ path: string; changed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const install = async () => {
    setBusy(true);
    try {
      setState(await api.odysseyInstallSkill());
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="odyssey-field">
      <span className="small">{t("The `big-thing` skill")}</span>
      <div className="row wrap">
        <button className="button button-small" disabled={busy} onClick={() => void install()} type="button">
          {busy ? t("Installing…") : t("Install or repair")}
        </button>
        {state && <span className="small muted mono">{state.path}</span>}
      </div>
      <span className="small muted">
        {t("The full protocol the model can load on demand. Big Thing installs it with the first briefing; reinstall it if you have edited the copy.")}
      </span>
    </div>
  );
}

function VerifiedStrip({ milestones }: { milestones: MilestoneRecord[] }) {
  return (
    <section className="card odyssey-verified">
      <header className="work-head">
        <span className="work-title">{t("Verified milestones")}</span>
        <span className="work-meta">{t("{done} of {total}", { done: verifiedCount(milestones), total: milestones.length })}</span>
      </header>
      <div className="odyssey-seals">
        {milestones.map((milestone) => (
          // The seal's tooltip names the lane, because a check Big Thing ran and
          // one read from the agent's tool result are not equally strong.
          <span
            className={`odyssey-seal ${milestone.state === "verified" ? "seal-on" : ""} ${milestone.state === "failed" ? "seal-failed" : ""}`}
            key={milestone.id}
            title={milestone.state === "verified" ? `${milestone.title} — ${laneLabel(milestone)}` : milestone.state === "failed" ? t("{title} — the check did not pass", { title: milestone.title }) : milestone.title}
          >
            {milestone.state === "verified" ? <IconCheckCircle size={16} /> : milestone.state === "failed" ? <IconAlertCircle size={14} /> : <span className="odyssey-seal-empty" />}
          </span>
        ))}
      </div>
      <p className="small muted odyssey-foot">{t("A milestone is verified when a check ran or you ticked it — not when the agent said so.")}</p>
    </section>
  );
}

/**
 * The empty state: one card, which also accepts a dropped document.
 *
 * A dropped roadmap is *not* parsed here. It is stored with the goal and
 * handed to the session's model, which proposes the milestones — reading a
 * plan is judgement, and a regex has no business doing it. The card describes
 * what was dropped and what will happen; nothing is created until the button
 * is pressed, and nothing runs until the goal is started.
 */
/**
 * What the session a run moved off should say.
 *
 * It used to show the "set a goal" form, which is what an empty session shows
 * — so a goal that had simply moved read as a goal that had been wiped. The
 * record is one pointer away; say so, and offer the click.
 */
function MovedAway({ from, moved }: { from: string; moved: { goalId: string; title: string; to: string } }) {
  const selectSession = useStore((s) => s.selectSession);
  const sessions = useStore((s) => s.sessions);
  const target = sessions[moved.to];
  return (
    <div className="odyssey-empty">
      <section className="card odyssey-new">
        <h3>{t("This run moved to another session")}</h3>
        <p className="small muted">
          {fill(
            t(
              "{title} is still running — its milestones, its history and its budget came with it. What stayed behind is this session’s conversation, which is why the run was briefed afresh where it landed.",
            ),
            { title: <strong>{moved.title}</strong> },
          )}
        </p>
        <div className="row wrap">
          <button className="button button-small button-primary" disabled={!target} onClick={() => selectSession(moved.to)} type="button">
            {target ? t("Open the run") : t("That session is not attached")}
          </button>
          <span className="small muted">{t("You can start a separate goal here whenever you want one.")}</span>
        </div>
      </section>
      <NewGoalFormToggle from={from} />
    </div>
  );
}

/** Setting a *new* goal on the session left behind, once the user asks for it. */
function NewGoalFormToggle({ from }: { from: string }) {
  const [open, setOpen] = useState(false);
  const session = useStore((s) => s.sessions[from]);
  if (!session) return null;
  if (!open)
    return (
      <button className="link small" onClick={() => setOpen(true)} type="button">
        {t("set a goal for this session")}
      </button>
    );
  return <NewGoalForm agentSessionId={session.snapshot.agentSessionId} sessionId={from} workspaceId={session.workspaceId} />;
}

/** Who leads a preset: its orchestrator's provider, and the model when it names one. */
function presetLead(preset: TeamPreset): string {
  return `${PROVIDER_LABELS[preset.orchestrator.provider]}${preset.orchestrator.model ? ` · ${preset.orchestrator.model}` : ""}`;
}

function NewGoalForm({ sessionId, workspaceId, agentSessionId }: { sessionId: string; workspaceId: string; agentSessionId: string | null }) {
  const createOdyssey = useStore((s) => s.createOdyssey);
  const requestPlan = useStore((s) => s.odysseyRequestPlan);
  const setError = useStore((s) => s.setError);
  const defaults = useStore((s) => s.settings);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [stop, setStop] = useState<StopCondition>("goal_complete");
  const [document, setDocument] = useState<{ name: string; text: string; summary: DocumentSummary; adopted?: AdoptedPlan } | null>(null);
  const [testCommand, setTestCommand] = useState("");
  const [dropping, setDropping] = useState(false);
  const [creating, setCreating] = useState(false);
  const presets = useStore((s) => s.teamPresets);
  const saveTeam = useStore((s) => s.saveTeam);
  const [presetId, setPresetId] = useState("");
  const [isolate, setIsolate] = useState(false);
  const [dispatch, setDispatch] = useState<"agent" | "runner">("agent");
  const preset = presets.find((entry) => entry.id === presetId);

  // The project's test command is a property of the project more than of one
  // goal, so the newest goal in this workspace that had one is the default.
  useEffect(() => {
    let cancelled = false;
    api
      .odysseyList(workspaceId)
      .then((goals) => {
        if (!Array.isArray(goals)) return;
        const previous = goals.find((goal) => goal.defaultCheck)?.defaultCheck;
        if (!cancelled && previous) setTestCommand((current) => current || previous);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const maxContinuations = defaults?.odysseyMaxContinuations ?? 10;
  const tokenBudget = defaults?.odysseyTokenBudget;

  const readDocument = useCallback(
    async (paths: string[]) => {
      const path = paths.find(isPlanDocument);
      if (!path) {
        setError({ code: "UNSUPPORTED", message: t("Drop a Markdown or text file to plan a goal from it."), retry: "user_action" });
        return;
      }
      try {
        const name = fileNameOf(path);
        const text = await api.odysseyReadPlan(path);
        const summary = summarize(text, name);
        if (summary.tooLarge) {
          setError({ code: "LIMIT_EXCEEDED", message: summary.tooLarge, retry: "user_action" });
          return;
        }
        // Put it where the agent can re-read it. Inlining it into one prompt
        // makes it unreachable as soon as that turn compacts away.
        const adopted = await api.odysseyAdoptPlan(workspaceId, path).catch(() => null);
        setDocument({ name, text, summary, ...(adopted ? { adopted } : {}) });
        // The heading is a name, not a plan; the milestones are the agent's.
        setTitle((current) => current.trim() || summary.suggestedTitle);
      } catch (error) {
        setError(error);
      }
    },
    [setError],
  );

  // A document sent here from the transcript plans the goal, as a drop would.
  const sentDoc = useStore((s) => s.bigThingDoc[sessionId]);
  useEffect(() => {
    if (!sentDoc) return;
    const path = useStore.getState().takeBigThingDoc(sessionId);
    if (path) void readDocument([path]);
  }, [sentDoc, sessionId, readDocument]);

  // Tauri hands the webview file paths rather than File objects, so the drop
  // is read natively and this listener only routes it.
  useEffect(() => {
    let stop: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") setDropping(true);
        else if (event.payload.type === "leave") setDropping(false);
        else if (event.payload.type === "drop") {
          setDropping(false);
          void readDocument(event.payload.paths);
        }
      })
      .then((fn) => {
        stop = fn;
      });
    return () => stop?.();
  }, [readDocument]);

  const create = async () => {
    if (!title.trim() || !agentSessionId || creating) return;
    setCreating(true);
    try {
      await createOdyssey(sessionId, {
        workspaceId,
        agentSessionId,
        title: title.trim(),
        brief: brief.trim(),
        stopCondition: stop,
        onUsageReset: "notify_only",
        maxContinuations,
        ...(tokenBudget ? { tokenBudget } : {}),
        ...(document ? { planSource: document.name, planDocument: document.text } : {}),
        ...(document?.adopted ? { planPath: document.adopted.path } : {}),
        ...(testCommand.trim() ? { defaultCheck: testCommand.trim() } : {}),
        isolate,
        dispatch,
        // A preset is the run's team: its orchestrator becomes the account the
        // goal runs on, and the workers come with it to every session it uses.
        ...(preset ? { team: { orchestrator: preset.orchestrator, combo: preset.combo } } : {}),
      });
      const created = useStore.getState().odyssey[sessionId];
      if (preset && created) {
        if (preset.orchestrator.provider !== "gemini") await api.odysseyEditGoal(created.goal.id, { orchestrator: preset.orchestrator.provider }).catch(() => undefined);
        await saveTeam(sessionId, preset.combo).catch(() => undefined);
      }
      // With a document attached the next thing to happen is the planning
      // turn, so it is asked for immediately rather than waiting for a click.
      if (document && useStore.getState().odyssey[sessionId]) await requestPlan(sessionId);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className={`odyssey-empty ${dropping ? "drop-target" : ""}`}>
      <form
        className="card odyssey-new"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <h3>{t("Set a goal for this session")}</h3>
        <p className="small muted">
          {t(
            "Big Thing breaks a goal into milestones and keeps this session working through them, parking itself when the account's usage runs out. It never marks a milestone done on the agent's word alone.",
          )}
        </p>
        <input aria-label={t("Goal title")} className="input" onChange={(event) => setTitle(event.target.value)} placeholder={t("Ship onboarding v2")} value={title} />
        <textarea
          aria-label={t("Goal brief")}
          className="textarea"
          onChange={(event) => setBrief(event.target.value)}
          placeholder={t("What done looks like, and anything the agent must respect.")}
          rows={3}
          value={brief}
        />

        {document ? (
          <section className="odyssey-import">
            <header className="row wrap">
              <strong className="small mono">{document.name}</strong>
              <span className="small muted">
                {t("{size} KB · {lines} lines · {headings} headings", {
                  size: Math.max(1, Math.round(document.summary.bytes / 1024)),
                  lines: document.summary.lines.toLocaleString(),
                  headings: document.summary.headings,
                })}
              </span>
              <button className="link small" onClick={() => setDocument(null)} type="button">
                {t("remove")}
              </button>
            </header>
            <p className="small muted">
              {t(
                "Big Thing will hand this document to the session and the agent will propose the milestones. Nothing is read from it here, and the goal stays a draft until you start it.",
              )}
            </p>
            {document.adopted ? (
              <p className="small muted">
                {fill(
                  document.adopted.copied
                    ? t("Copied into the project as {path} — so it can go back to the full text whenever a milestone’s detail is not enough.")
                    : t("The agent can read it at {path} — so it can go back to the full text whenever a milestone’s detail is not enough."),
                  { path: <span className="mono">{document.adopted.path}</span> },
                )}
              </p>
            ) : (
              <p className="small chip-warn">
                {t("This could not be placed in the project, so the agent sees it once in the planning turn and cannot read it again afterwards.")}
              </p>
            )}
          </section>
        ) : (
          <p className="odyssey-dropzone small muted">{t("Drop a Markdown roadmap or plan here and the agent will turn it into milestones.")}</p>
        )}

        <label className="odyssey-field">
          <span className="small">{t("Test command")}</span>
          <input
            aria-label={t("Test command")}
            className="input mono"
            onChange={(event) => setTestCommand(event.target.value)}
            placeholder={t("e.g. pnpm test, or python3 Tools/check.py")}
            value={testCommand}
          />
          <span className="small muted">
            {t(
              "Run from the project root. The agent is told to make it each milestone’s check when it plans, so Big Thing can verify a claim instead of waiting for your tick. Without one, every milestone is yours to tick.",
            )}
          </span>
        </label>
        <label className="odyssey-field">
          <span className="small">{t("Team")}</span>
          <select aria-label={t("Team")} className="select" onChange={(event) => setPresetId(event.target.value)} value={presetId}>
            <option value="">{t("This session’s own team")}</option>
            {presets.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          <span className="small muted">
            {preset
              ? preset.combo.workers.length === 1
                ? t("Led by {who} with {count} worker. A run on another account moves there when it starts.", { who: presetLead(preset), count: 1 })
                : t("Led by {who} with {count} workers. A run on another account moves there when it starts.", { who: presetLead(preset), count: preset.combo.workers.length })
              : t("The run leads whatever team this session has.")}
          </span>
        </label>
        <label className="odyssey-field">
          <span className="small">{t("Who hands out the tasks")}</span>
          <select aria-label={t("Who hands out the tasks")} className="select" onChange={(event) => setDispatch(event.target.value as "agent" | "runner")} value={dispatch}>
            <option value="agent">{t("The orchestrator delegates")}</option>
            <option value="runner">{t("Big Thing hands out the tasks")}</option>
          </select>
        </label>
        <label className="odyssey-toggle">
          <input checked={isolate} onChange={(event) => setIsolate(event.target.checked)} type="checkbox" />
          <span className="small">{t("Run in its own branch and worktree, so it never touches your checkout until you merge")}</span>
        </label>
        <label className="odyssey-field">
          <span className="small">{t("Stop when")}</span>
          <select className="select" onChange={(event) => setStop(event.target.value as StopCondition)} value={stop}>
            {(Object.keys(STOP_LABEL) as StopCondition[]).map((value) => (
              <option key={value} value={value}>
                {STOP_LABEL[value]}
              </option>
            ))}
          </select>
          <span className="small muted">{STOP_HINT[stop]}</span>
        </label>
        <div className="row wrap">
          <button className="button button-primary" disabled={!title.trim() || !agentSessionId || creating} type="submit">
            {creating ? t("Creating…") : document ? t("Create goal and ask the agent to plan it") : t("Create goal")}
          </button>
          <span className="small muted">
            {agentSessionId ? t("Budget starts at {count} continuations; change it in Settings.", { count: maxContinuations }) : t("Waiting for the agent to report this session's id.")}
          </span>
        </div>
      </form>
    </div>
  );
}

/**
 * The planning state of a draft goal that came from a document: waiting for
 * the agent's plan, or showing the plan it proposed for approval.
 *
 * The approval is not ceremony. A proposed check is a command Big Thing will
 * run in the workspace, and the document it came from may not be the user's,
 * so Start is where a human agrees to it.
 */
function PlanCard({ view, sessionId }: { view: OdysseyView; sessionId: string }) {
  const requestPlan = useStore((s) => s.odysseyRequestPlan);
  const busy = useStore((s) => s.odysseyRuntime[sessionId]?.ticking ?? false);
  const { goal, milestones } = view;
  const source = planSummary(goal);
  if (goal.state !== "draft" || !source) return null;

  const entries = view.journal.filter((entry) => entry.kind === "plan");
  const asked = entries.some((entry) => entry.summary === PLAN_REQUESTED);
  const refused = entries.find((entry) => entry.summary === "The agent proposed no plan");
  const proposed = entries.find((entry) => entry.summary.startsWith("The agent proposed") && entry.summary !== "The agent proposed no plan");
  const runnable = milestones.filter((milestone) => milestone.checkSpec).length;

  const ask = (
    <button className="button button-small" disabled={busy} onClick={() => void requestPlan(sessionId)} type="button">
      {busy ? t("Asking…") : milestones.length > 0 ? t("Ask the agent again") : t("Ask the agent to plan it")}
    </button>
  );

  return (
    <section aria-label={t("Plan document")} className="card odyssey-plan-card">
      <header className="work-head">
        <span className="work-glyph">
          <IconCode size={14} />
        </span>
        <span className="work-title">{t("Planned from {source}", { source })}</span>
        <span className="row-actions">{ask}</span>
      </header>
      <div className="odyssey-state-body">
        {milestones.length === 0 && !refused && (
          <p className="small muted">
            {asked ? t("The agent is reading the document and will propose the milestones in its reply.") : t("Ask the agent to read the document and propose the milestones.")}
          </p>
        )}
        {refused && milestones.length === 0 && (
          <p className="small chip-warn">
            {t("The agent’s reply contained no plan. {detail} Read what it said in the transcript, then ask again or write the milestones yourself.", { detail: refused.detail ?? "" })}
          </p>
        )}
        {milestones.length > 0 && (
          <>
            <p className="small muted">
              {t("{summary}. They are the agent’s reading of the document, not Big Thing’s — edit, reorder or remove any of them before you start.", {
                summary: proposed?.summary ?? t("{count} milestones are proposed", { count: milestones.length }),
              })}
            </p>
            {runnable > 0 && (
              <p className="small chip-warn">
                {runnable === 1
                  ? t("{count} of them has a check Big Thing will run in this workspace. Read those commands in the milestone list before you press Start.", { count: 1 })
                  : t("{count} of them have checks Big Thing will run in this workspace. Read those commands in the milestone list before you press Start.", { count: runnable })}
              </p>
            )}
            {allManual(milestones) && (
              <p className="small chip-warn">
                {t(
                  "Every milestone is manual: the run will stop at each claim until you tick it, and nothing is verified by a command. Set a test command in Settings and ask the agent again, or edit the checks yourself.",
                )}
              </p>
            )}
            {proposed?.detail && <p className="small muted">{proposed.detail}</p>}
          </>
        )}
      </div>
    </section>
  );
}

export function OdysseyPane({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const view = useStore((s) => s.odyssey[sessionId]);
  const movedAway = useStore((s) => s.odysseyMovedAway[sessionId]);
  const amendments = useStore((s) => s.odysseyAmendments[sessionId]) ?? [];
  const loadOdyssey = useStore((s) => s.loadOdyssey);
  const addMilestone = useStore((s) => s.addMilestone);
  const editOdysseyGoal = useStore((s) => s.editOdysseyGoal);
  const deleteOdyssey = useStore((s) => s.deleteOdyssey);
  // Which milestones are open. Until the user touches one, the ones being
  // worked are open and the rest are a row each — a plan of twelve
  // specifications is not readable unfolded.
  const [expandedIds, setExpandedIds] = useState<Set<string> | null>(null);
  const [newMilestone, setNewMilestone] = useState("");
  const [editingGoal, setEditingGoal] = useState(false);
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [amendOpen, setAmendOpen] = useState(false);
  const [amendPaths, setAmendPaths] = useState<string[]>([]);
  // A document sent from the transcript to a session that already has a
  // goal is work to add to it.
  const sentDoc = useStore((s) => s.bigThingDoc[sessionId]);
  const hasGoal = Boolean(view);
  useEffect(() => {
    if (!sentDoc || !hasGoal) return;
    const path = useStore.getState().takeBigThingDoc(sessionId);
    if (!path) return;
    setAmendPaths([path]);
    setAmendOpen(true);
  }, [sentDoc, hasGoal, sessionId]);
  const [tab, setTab] = useState<"roadmap" | "inbox" | "documents" | "team" | "history" | "changes" | "settings">("roadmap");
  const inbox = useInboxItems(sessionId, view);
  const [goalTitle, setGoalTitle] = useState("");
  const [goalBrief, setGoalBrief] = useState("");
  const asked = useRef(false);

  const agentSessionId = session?.snapshot.agentSessionId ?? null;

  useEffect(() => {
    if (view === undefined && !asked.current && agentSessionId) {
      asked.current = true;
      void loadOdyssey(sessionId);
    }
  }, [view, sessionId, agentSessionId, loadOdyssey]);

  // The engine's own briefing, so what is shown is what the session is sent.
  const [briefing, setBriefing] = useState("");
  const briefingKey = view ? `${view.goal.id}:${view.goal.updatedAt}:${view.milestones.length}` : "";
  useEffect(() => {
    if (!view) return;
    let current = true;
    void api
      .bigthingBriefing(view.goal.id)
      .then((text) => current && setBriefing(text))
      .catch(() => undefined);
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefingKey]);

  // Asked from the conversation: open the roadmap at one milestone.
  const odysseyFocus = useStore((s) => (s.odysseyFocus?.sessionId === sessionId ? s.odysseyFocus : null));
  const clearJumpFocus = useStore((s) => s.clearJumpFocus);
  useEffect(() => {
    if (!odysseyFocus || !view) return;
    clearJumpFocus();
    const milestone = view.milestones[odysseyFocus.milestone];
    if (!milestone) return;
    setTab("roadmap");
    setExpandedIds((ids) => new Set([...(ids ?? workedIds(view.milestones)), milestone.id]));
    const index = odysseyFocus.milestone;
    setTimeout(() => {
      const target = document.querySelector<HTMLElement>(`.odyssey-pane [data-milestone-index="${index}"]`);
      if (!target) return;
      target.scrollIntoView({ block: "center" });
      target.classList.add("jump-flash");
      setTimeout(() => target.classList.remove("jump-flash"), 1600);
    }, 60);
  }, [odysseyFocus, view, clearJumpFocus]);

  if (!session) return null;
  if (view === undefined) {
    return (
      <section className="panel odyssey-pane">
        <div className="odyssey-skeleton" aria-busy="true">
          <span />
          <span />
          <span />
        </div>
      </section>
    );
  }
  if (view === null) {
    return (
      <section className="panel odyssey-pane">
        {movedAway ? <MovedAway from={sessionId} moved={movedAway} /> : <NewGoalForm agentSessionId={agentSessionId} sessionId={sessionId} workspaceId={session.workspaceId} />}
      </section>
    );
  }

  const { goal, milestones, journal } = view;
  const verified = verifiedCount(milestones);
  const latest = journal[0];
  const openAmendments = amendments.filter((record) => record.state === "pending" || record.state === "told").length;
  const openMilestones = expandedIds ?? workedIds(milestones);

  return (
    <section className="panel odyssey-pane">
      <header className="odyssey-header">
        <div>
          <h2>{goal.title}</h2>
          <p className="small muted">{goal.brief || t("No brief.")}</p>
        </div>
        <div className="row wrap">
          <button className="button button-small button-primary" onClick={() => setAmendOpen(true)} type="button">
            {t("Add or change work")}
          </button>
          <button className="button button-small" onClick={() => setBriefingOpen(true)} type="button">
            {t("Preview briefing")}
          </button>
          <button
            className="button button-small"
            onClick={() => {
              setGoalTitle(goal.title);
              setGoalBrief(goal.brief);
              setEditingGoal(true);
            }}
            type="button"
          >
            {t("Edit goal")}
          </button>
          <button className="button button-small button-warn" onClick={() => void deleteOdyssey(sessionId, goal.id)} title={t("Delete this goal and its record")} type="button">
            {t("Delete")}
          </button>
        </div>
      </header>

      <div className="odyssey-progress-row">
        <ProgressBar milestones={milestones} />
        <span className="small muted">
          {t("{verified} of {total} milestones verified", { verified, total: milestones.length })}
        </span>
      </div>

      {editingGoal && (
        <form
          className="card odyssey-edit"
          onSubmit={(event) => {
            event.preventDefault();
            setEditingGoal(false);
            void editOdysseyGoal(sessionId, goal.id, { title: goalTitle, brief: goalBrief });
          }}
        >
          <input aria-label={t("Goal title")} className="input" onChange={(event) => setGoalTitle(event.target.value)} value={goalTitle} />
          <textarea aria-label={t("Goal brief")} className="textarea" onChange={(event) => setGoalBrief(event.target.value)} rows={3} value={goalBrief} />
          <div className="row">
            <button className="button button-small" type="submit">
              {t("Save")}
            </button>
            <button className="button button-small" onClick={() => setEditingGoal(false)} type="button">
              {t("Cancel")}
            </button>
          </div>
        </form>
      )}

      <StateCard sessionId={sessionId} view={view} />

      <div className="tablist odyssey-tabs" role="tablist">
        {(
          [
            ["roadmap", t("Roadmap")],
            ["inbox", inbox.length > 0 ? t("Inbox ({count})", { count: inbox.length }) : t("Inbox")],
            ["documents", t("Documents")],
            ["team", t("Team")],
            ["history", t("History")],
            ["changes", openAmendments > 0 ? t("Changes ({count})", { count: openAmendments }) : t("Changes")],
            ["settings", t("Settings")],
          ] as const
        ).map(([id, label]) => (
          <button aria-selected={tab === id} className={`tab ${tab === id ? "tab-on" : ""}`} key={id} onClick={() => setTab(id)} role="tab" type="button">
            {label}
          </button>
        ))}
      </div>

      {tab === "roadmap" && (
        <div className="odyssey-roadmap">
          <WorkLanes sessionId={sessionId} />
          <PlanCard sessionId={sessionId} view={view} />
          <div className="odyssey-timeline">
            <ul>
              {milestones.map((milestone, index) => (
                <MilestoneRow
                  expanded={openMilestones.has(milestone.id)}
                  index={index}
                  key={milestone.id}
                  milestone={milestone}
                  onToggle={() => {
                    const next = new Set(openMilestones);
                    if (next.has(milestone.id)) next.delete(milestone.id);
                    else next.add(milestone.id);
                    setExpandedIds(next);
                  }}
                  sessionId={sessionId}
                  total={milestones.length}
                />
              ))}
            </ul>
            <form
              className="odyssey-add"
              onSubmit={(event) => {
                event.preventDefault();
                if (!newMilestone.trim()) return;
                void addMilestone(sessionId, { odysseyId: goal.id, title: newMilestone.trim() });
                setNewMilestone("");
              }}
            >
              <IconPlus size={14} />
              <input aria-label={t("New milestone")} className="input" onChange={(event) => setNewMilestone(event.target.value)} placeholder={t("Add a milestone…")} value={newMilestone} />
            </form>
          </div>
        </div>
      )}
      {tab === "inbox" && <InboxPanel sessionId={sessionId} view={view} />}
      {tab === "documents" && <DocumentsCard sessionId={sessionId} view={view} />}
      {tab === "team" && (
        <div className="odyssey-tab-stack">
          <WorkLanes sessionId={sessionId} />
          <Timeline view={view} />
          <MemoryPanel goalUpdatedAt={goal.updatedAt} workspaceId={session.workspaceId} />
        </div>
      )}
      {tab === "history" && (
        <div className="odyssey-tab-stack">
          <WorktreeCard sessionId={sessionId} view={view} />
          <RunHistory journal={journal} />
          <VerifiedStrip milestones={milestones} />
        </div>
      )}
      {tab === "changes" && (
        <div className="odyssey-tab-stack">
          <AmendmentList amendments={amendments} sessionId={sessionId} />
          {openAmendments === 0 && <p className="small muted">{t("Nothing queued. Use “Add or change work” to fold a document, a folder or an instruction into the running plan.")}</p>}
        </div>
      )}
      {tab === "settings" && <Settings sessionId={sessionId} view={view} />}

      <footer className="odyssey-footer small muted">
        {latest ? `${timeOf(latest.at)} · ${latest.summary}` : t("Nothing recorded yet.")}
        <span>{t("Saved in this app's database, not in your project.")}</span>
      </footer>

      {amendOpen && (
        <AmendDialog
          initialPaths={amendPaths}
          odysseyId={goal.id}
          onClose={() => {
            setAmendOpen(false);
            setAmendPaths([]);
          }}
          sessionId={sessionId}
          workspaceId={session.workspaceId}
        />
      )}

      {briefingOpen && (
        <div aria-modal="true" className="modal-backdrop" onClick={() => setBriefingOpen(false)} role="dialog">
          <div className="modal odyssey-briefing" onClick={(event) => event.stopPropagation()}>
            <h2>{t("What the session will be told")}</h2>
            <p className="small muted">{t("This exact text is submitted once when the goal starts. Continuations after it are one or two lines.")}</p>
            <pre className="text">{briefing}</pre>
            <button className="button" onClick={() => setBriefingOpen(false)} type="button">
              {t("Close")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
