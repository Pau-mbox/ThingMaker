/**
 * The runner's decisions (docs/plans/odyssey.md §4, §6).
 *
 * Pure on purpose: given a goal, its milestones, what the session is doing and
 * what the usage sampler last said, it returns the one action to take. The
 * store performs it. Every guard that stands between a goal and the user's
 * quota is decided here, so it can be tested without a provider.
 */
import type { MilestoneRecord, OdysseyJournalEntry, OdysseyRecord, Provider, UsageSnapshot } from "@thingmaker/contracts";
import { ORCHESTRATOR_PROVIDERS, PROVIDER_LABELS } from "@thingmaker/contracts";
import { briefedThisSession, failedTickRun, heldUntil, lastMoveAt, staleCheckpointRun, unansweredRun } from "./odysseyReport";

/** Percent of a usage window at which Big Thing parks rather than risk a turn. */
export const USAGE_FLOOR_PERCENT = 98;

/**
 * The least time between two prompts for one goal (docs/plans/odyssey.md §4.1
 * step 5). Specified from the start and never built, which is how eight
 * continuations went out in eighteen seconds: nothing rate-limited the runner,
 * so every caller that reached it submitted.
 *
 * Derived from the journal rather than from memory on purpose — that makes it
 * hold across a reload, and across however many callers exist, because they
 * all read the same record.
 */
export const PROMPT_COOLDOWN_MS = 5_000;

/** Consecutive turns that change nothing before the run is blocked. */
export const STALE_TURN_LIMIT = 3;

/**
 * Consecutive prompts an agent accepted and no model answered before the run is
 * blocked. The usage guard runs first, so by the time this trips the account
 * says there is room and the session still is not reaching a model: that is
 * a real fault, and it needs a human, not another prompt.
 */
export const UNANSWERED_LIMIT = 3;

/**
 * Consecutive ticks that threw before submitting anything, before the run is
 * blocked.
 *
 * Distinct from `UNANSWERED_LIMIT`: that one is "the prompt went out and no
 * model answered", this one is "the prompt never went out at all", which is a
 * fault in the desktop or the agent's command surface rather than anything
 * about quota. Neither clears by retrying, and retrying is what the runner
 * did — for ever, once, at a checkpoint every eleven seconds.
 */
export const TICK_FAILURE_LIMIT = 3;

/** Spread simultaneous resumes so several goals do not fire at once. */
export const RESUME_JITTER_MS = 30_000;

/**
 * How long the runner may be unable to act before that is reported as a stall.
 *
 * A run is mostly waiting, so a few idle ticks mean nothing. Minutes of the
 * same "I cannot act" reason mean something is wrong — a detached session, an
 * exited process, a claim waiting on a tick, or a bug in the runner itself —
 * and the difference between noticing that in a minute and in an hour is
 * whether anything says so.
 */
export const STALL_WARNING_MS = 5 * 60_000;

/**
 * Whether a turn that says it is running has actually stopped being one.
 *
 * The case this is for: six subagents hit a spent quota, stopped mid-tool-call
 * and sat on open sockets. The parent turn could not settle while its children
 * never returned, so the runner saw "a turn is already running" and correctly
 * refused to act — for eighty minutes, across a quota window that had since
 * reset. Nothing else would ever have freed it.
 *
 * The signal is *no events at all*, not "no visible progress": a long silent
 * tool call is a legitimate thing, and a run that is streaming anything is
 * alive. `minutes` is generous for the same reason, and 0 turns it off.
 *
 * Subagents count. Their state changes and child calls arrive on the same
 * session stream and move `lastEventAt`, so a turn whose orchestrator is
 * quiet while a subagent is still working is not dead and is not cancelled.
 * A subagent whose process died sends nothing, and that is the case this
 * catches; `workingAgents` is how many the cancel would take with it, for the
 * record.
 */
export function deadTurn(input: { running: boolean; lastEventAt: number | null; now: number; minutes: number; workingAgents?: number }): { silentMs: number; workingAgents: number } | null {
  const { running, lastEventAt, now, minutes, workingAgents = 0 } = input;
  if (!running || minutes <= 0 || lastEventAt === null) return null;
  const silentMs = now - lastEventAt;
  return silentMs >= minutes * 60_000 ? { silentMs, workingAgents } : null;
}

/**
 * How long a session may be completely silent before what it reports as
 * running stops being believable.
 *
 * A subagent or child call only leaves the inspector when the runtime says it
 * finished. A process that is killed, crashes, or dies with its provider never
 * sends that, so the node sits at `working` for ever — "Working in the
 * background · 196m · 1 child process" for something that exited three hours
 * ago. The session's own silence is the evidence: if *nothing at all* has
 * arrived, nothing in it is running.
 *
 * This only changes what is displayed. It cancels nothing and decides nothing.
 */
export const STALE_ACTIVITY_MS = 10 * 60_000;

/** How long a session has been silent, once that is long enough to matter. */
export function staleActivity(input: { lastEventAt: number | null; now: number; limit?: number }): { silentMs: number } | null {
  const { lastEventAt, now, limit = STALE_ACTIVITY_MS } = input;
  if (lastEventAt === null) return null;
  const silentMs = now - lastEventAt;
  return silentMs >= limit ? { silentMs } : null;
}

/** The closest together two usage samples may ever be. */
export const USAGE_RESAMPLE_MS = 60_000;

/**
 * How often a parked goal re-checks while its named reset is still ahead.
 *
 * It has to check at all: these windows roll, so capacity comes back as old
 * usage ages out, well before the `reset_at` the provider names. Only
 * sampling once that clock ran out left a goal parked in front of a window
 * that had been free for hours.
 */
export const PARKED_RESAMPLE_MS = 5 * 60_000;

/**
 * When a parked goal is when the reset time it was parked with has passed,
 * from whichever source knows it.
 *
 * The sample's own time wins: the one the runner recorded lives in memory and
 * does not survive a reload.
 */
export function waitingUntil(usage: UsageSnapshot | null | undefined, resumeAt: number | null): number | null {
  const verdict = usageVerdict(usage);
  // Nothing to wait for once there is room: showing a countdown to a reset
  // time the runner is no longer waiting on is how a stuck goal looked busy.
  if (verdict.kind !== "exhausted") return null;
  return verdict.resumeAt ?? resumeAt;
}

/**
 * Whether a parked goal should fetch a fresh usage sample.
 *
 * The trap this exists for: the decision to resume was made from the snapshot
 * the goal was parked with, which says "no room" for ever. It held, so it
 * never refreshed, so it never learned the window was back — a goal parked at
 * 16:07 was still parked at 18:58, an hour after its own reset time.
 *
 * So: no sampling while it is plainly too early, and from the reset time
 * onward — or when nothing knows the reset time — one sample a minute.
 */
export function shouldResample(input: { usage: UsageSnapshot | null | undefined; resumeAt: number | null; now: number; minInterval?: number }): boolean {
  const { usage, resumeAt, now, minInterval = USAGE_RESAMPLE_MS } = input;
  if (!usage) return true;
  const age = now - usage.fetchedAtUnixMs;
  if (age < minInterval) return false;
  const until = waitingUntil(usage, resumeAt);
  // Past the named reset, or with no reset named, check at the fastest rate
  // allowed; before it, check periodically anyway, because the window may
  // have freed up early.
  return until === null || now >= until || age >= PARKED_RESAMPLE_MS;
}

/** Plain-English duration for a stall, rounded the way a reader would say it. */
export function stallDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/**
 * The warning for a run that has been unable to act, or `null` while it is
 * still within the grace period. `since` is when this reason first appeared,
 * so a reason that keeps changing never trips it — that is a run doing things,
 * not a run stuck.
 */
export function stallNotice(input: { reason: string; since: number | null; now: number; limit?: number }): string | null {
  const { reason, since, now, limit = STALL_WARNING_MS } = input;
  if (since === null || !reason) return null;
  const waited = now - since;
  if (waited < limit) return null;
  return `Big Thing has not been able to act for ${stallDuration(waited)}: ${reason}`;
}

export type SessionCondition = { attached: boolean; idle: boolean };

export type Decision =
  /** Submit the briefing: the goal has not been introduced yet. */
  | { action: "brief" }
  /** Submit a continuation for this milestone. */
  | { action: "continue"; milestone: MilestoneRecord; index: number }
  /** Every milestone is settled; the goal is done. */
  | { action: "complete" }
  /** Park until the provider's quota resets. */
  | { action: "wait_usage"; resumeAt: number | null; reason: string }
  /** Stop and ask the user. */
  | { action: "block"; reason: string }
  /** The model claims a milestone is done; something has to verify it. */
  | { action: "await_verification"; milestone: MilestoneRecord; index: number }
  /** Nothing to do right now, and nothing wrong. */
  | { action: "idle"; reason: string };

export type UsageVerdict = { kind: "ok" } | { kind: "exhausted"; resumeAt: number | null; reason: string };

/**
 * Whether the account has room for another turn.
 *
 * An unsampled account is treated as fine: absence of data is not evidence of
 * exhaustion, and blocking on it would strand every goal on a machine that has
 * never fetched usage. When both windows are spent the resume time is the
 * *later* of the two — recovering the 5-hour window does not help if the
 * weekly one is gone.
 */
export function usageVerdict(usage: UsageSnapshot | null | undefined, floor = USAGE_FLOOR_PERCENT): UsageVerdict {
  if (!usage) return { kind: "ok" };
  const windows = [
    { name: "5-hour", window: usage.primary },
    { name: "weekly", window: usage.secondary },
  ].filter((entry): entry is { name: string; window: NonNullable<UsageSnapshot["primary"]> } => !!entry.window);

  const spent = windows.filter((entry) => entry.window.usedPercent >= floor);
  if (spent.length === 0 && !usage.limitReached) return { kind: "ok" };

  // `limitReached` with no window over the floor still means stop; the reset
  // time is then whatever the windows report, and may be nothing.
  const relevant = spent.length > 0 ? spent : windows;
  const resets = relevant.map((entry) => entry.window.resetAtUnix).filter((value): value is number => typeof value === "number");
  const reason =
    spent.length > 0
      ? `the ${spent.map((entry) => entry.name).join(" and ")} window${spent.length > 1 ? "s are" : " is"} at ${spent.map((entry) => `${entry.window.usedPercent}%`).join(" and ")}`
      : "the provider reported the usage limit was reached";
  return { kind: "exhausted", resumeAt: resets.length > 0 ? Math.max(...resets) * 1000 : null, reason };
}

/** Whether Big Thing can settle this milestone itself, without asking anyone. */
export function hasRunnableCheck(milestone: Pick<MilestoneRecord, "checkKind" | "checkSpec">): boolean {
  return milestone.checkKind !== "manual" && !!milestone.checkSpec?.trim();
}

/**
 * The milestone the runner should be working, and its index.
 *
 * `skipUncheckedClaims` is what "carry on past an unverified claim" means: a
 * milestone the agent reported done, whose only possible evidence is a human
 * tick, is stepped over instead of parking the run. It stays `reported` in the
 * record — not verified, and the badge still says so.
 *
 * A claim whose check Big Thing *can* run is never skipped: running it is cheap
 * and decisive, so the run stops long enough to do that whatever the setting.
 */
export function activeMilestone(milestones: MilestoneRecord[], skipUncheckedClaims = false): { milestone: MilestoneRecord; index: number } | null {
  const index = milestones.findIndex((milestone) => {
    if (milestone.state === "active" || milestone.state === "failed" || milestone.state === "planned") return true;
    if (milestone.state !== "reported") return false;
    return !skipUncheckedClaims || hasRunnableCheck(milestone);
  });
  return index < 0 ? null : { milestone: milestones[index] as MilestoneRecord, index };
}

export type RunnerInput = {
  goal: OdysseyRecord;
  milestones: MilestoneRecord[];
  journal: OdysseyJournalEntry[];
  session: SessionCondition;
  usage: UsageSnapshot | null | undefined;
  /** Now, for the prompt cooldown. Defaults to the wall clock. */
  now?: number;
};

/** When this goal last had a prompt submitted, from the record. */
export function lastPromptAt(journal: OdysseyJournalEntry[]): number | null {
  const entry = journal.find((item) => item.kind === "continuation" || item.kind === "briefing");
  return entry ? entry.at : null;
}

/**
 * The next action for a goal. Guards run in the order the plan lists them, so
 * a run out of budget is reported as out of budget rather than as whatever
 * else is also true.
 */
export function decide(input: RunnerInput): Decision {
  const { goal, milestones, journal, session, usage } = input;

  if (goal.state !== "running") return { action: "idle", reason: `the goal is ${goal.state}` };
  if (milestones.length === 0) return { action: "block", reason: "the goal has no milestones" };

  // Facts about the account and the budget come first, because they are true
  // whatever the session is doing. Putting the session checks above them hid
  // a spent quota behind "a turn is already running" for as long as that turn
  // took — and a turn with no quota behind it can take a very long time. The
  // goal then never reached `waiting_usage`, so it never learned a reset time
  // and could never resume by itself.
  if (goal.continuationsUsed >= goal.maxContinuations) {
    return { action: "block", reason: `the continuation limit of ${goal.maxContinuations} is used up` };
  }
  if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
    return { action: "block", reason: `the token budget of ${goal.tokenBudget.toLocaleString()} is used up` };
  }

  const verdict = usageVerdict(usage);
  if (verdict.kind === "exhausted") return { action: "wait_usage", resumeAt: verdict.resumeAt, reason: verdict.reason };

  const stale = staleCheckpointRun(journal);
  if (stale >= STALE_TURN_LIMIT) {
    return { action: "block", reason: `${stale} turns in a row changed nothing on disk and nothing in the plan` };
  }
  const unanswered = unansweredRun(journal);
  if (unanswered >= UNANSWERED_LIMIT) {
    return { action: "block", reason: `${unanswered} prompts in a row were accepted but never answered; the session is not reaching a model` };
  }
  const failed = failedTickRun(journal);
  if (failed >= TICK_FAILURE_LIMIT) {
    return { action: "block", reason: `${failed} ticks in a row failed before a prompt could be sent; this needs a look rather than another try` };
  }

  // Now the session: these say "not right now", with no recovery time to wait
  // for, so they are the weakest reasons and go last.
  if (!session.attached) return { action: "idle", reason: "the session is not attached" };
  if (!session.idle) return { action: "idle", reason: "a turn is already running" };

  // One prompt at a time, and not faster than the cooldown. A turn that
  // settles instantly — or never settles, so the record never advances — would
  // otherwise spend the whole continuation budget in seconds.
  const since = lastPromptAt(journal);
  const now = input.now ?? Date.now();
  if (since !== null && now - since < PROMPT_COOLDOWN_MS) {
    return { action: "idle", reason: "waiting out the cooldown after the last prompt" };
  }

  // The agent said its delegates are out of quota. That is a wait, not a
  // block: the goal stays running and the next prompt goes out when the
  // window it named is back, rather than prompting a turn that can only say
  // the same thing again.
  const hold = heldUntil(journal);
  if (hold !== null && now < hold) {
    return { action: "idle", reason: `the agent is waiting for its delegates' quota; the next continuation goes out at ${new Date(hold).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` };
  }

  // Nothing left to work. With `wait` that means every milestone is verified
  // or skipped; with `continue` a claim also counts as nothing left to work,
  // though it is still not verified.
  const carryOn = goal.onReport !== "wait";
  const active = activeMilestone(milestones, carryOn);
  if (!active) return { action: "complete" };

  // The briefing is the first thing a goal submits on a session — once per
  // session, not once per goal. A goal that moved is in front of a model that
  // has never heard of it, and "Continue. Milestone 7/9" means nothing there
  // (docs/plans/odyssey-second-orchestrator.md §2.3).
  if (!briefedThisSession(journal)) return { action: "brief" };

  // A claimed milestone is not a finished one. Under `wait`, continuing would
  // re-prompt the same milestone for ever, so the run stops for a tick.
  if (active.milestone.state === "reported") return { action: "await_verification", milestone: active.milestone, index: active.index };

  return { action: "continue", milestone: active.milestone, index: active.index };
}

/**
 * What to do for a goal parked on usage, once the reset time has passed.
 * `notify_only` and `stop` never resume by themselves; `continue_automatically`
 * only resumes when a fresh sample agrees there is room.
 */
export function resumeDecision(input: {
  goal: OdysseyRecord;
  usage: UsageSnapshot | null | undefined;
  resumeAt: number | null;
  now: number;
  /**
   * Whether *no snapshot* means there is room rather than "nobody has looked
   * yet" (docs/plans/odyssey-second-orchestrator.md §2.4).
   *
   * False for the OpenAI account, which has an endpoint: absence there means
   * the fetch failed, and resuming on it would be resuming on nothing.
   *
   * True for Claude, which has no endpoint at all. The only record that
   * account ever produces is a refusal with a reset time, and it is dropped
   * once that time passes — so absence is the normal, healthy state, and
   * treating it as "not sampled yet" held a parked goal for ever on a window
   * that had already come back.
   */
  unsampledMeansRoom?: boolean;
}): { action: "hold" | "resume" | "notify" | "stay_paused"; reason: string } {
  const { goal, usage, resumeAt, now, unsampledMeansRoom = false } = input;
  if (goal.state !== "waiting_usage") return { action: "hold", reason: `the goal is ${goal.state}` };

  // A fresh sample is the authority; the clock only says when to bother taking
  // one. Without a sample there is nothing to confirm, so the goal waits —
  // absence of data is not evidence that the quota is back. Unless nothing
  // reports on this account at all, in which case it is the only evidence
  // there will ever be.
  if (!usage && !unsampledMeansRoom) return { action: "hold", reason: "usage has not been sampled yet" };

  const verdict = usageVerdict(usage);
  if (verdict.kind === "exhausted") {
    // The time the *sample* names is preferred over the one the runner
    // recorded when it parked: that one lives in memory and does not survive
    // a reload, which used to strand a parked goal for ever.
    const until = verdict.resumeAt ?? resumeAt;
    if (until === null) return { action: "hold", reason: "usage reports no room and the provider gave no reset time, so there is nothing to wait for" };
    if (now < until + RESUME_JITTER_MS) return { action: "hold", reason: "the reset time has not passed" };
    return { action: "hold", reason: "the reset time passed but usage still reports no room" };
  }

  // There is room, so the wait is over. The recorded reset time does not get a
  // vote here, and gating on it was a bug: these windows *roll*, so capacity
  // comes back gradually as old usage ages out, well before the `reset_at` the
  // provider names. A goal parked at 99% with a reset two hours out would sit
  // there with a full window in front of it, and each re-sample moved the
  // clock further away. The sample is the authority — that was the rule, and
  // subordinating it to a stale clock quietly reversed it.

  switch (goal.onUsageReset) {
    case "continue_automatically":
      return { action: "resume", reason: "usage reset and this goal continues automatically" };
    case "notify_only":
      return { action: "notify", reason: "usage reset; waiting for you to resume" };
    case "stop":
      return { action: "stay_paused", reason: "usage reset; this goal is set to stop" };
  }
}

/**
 * The least time between two moves of one goal
 * (docs/plans/odyssey-second-orchestrator.md §2.5).
 *
 * Both accounts' windows roll, so near a boundary they can each look spent to
 * the other's sampler for a few minutes at a time. Without a floor a goal
 * would ping-pong between them, briefing afresh each time — and a briefing is
 * the most expensive prompt a run sends. An hour is longer than any such
 * flap and far shorter than a usage window.
 */
export const FAILOVER_COOLDOWN_MS = 60 * 60_000;

/** Every account's last known state, by the provider that spends it. */
export type AccountUsage = Partial<Record<Provider, UsageSnapshot | null | undefined>>;

export type Failover = { to: Provider; reason: string };

/**
 * Whether this goal should move to the other account, and why
 * (docs/plans/odyssey-second-orchestrator.md §2.5).
 *
 * The lever this exists for: 62% of the first real run's wall clock was spent
 * parked on one account's usage window while a second subscription sat idle.
 *
 * It is not a free lunch and the rule is written knowing that: a move costs a
 * fresh briefing on an orchestrator that has never seen the transcript. That
 * is worth it against a five-hour park and not worth it against anything
 * else, which is why the only trigger is *this account is spent and another
 * is not*.
 *
 * Every guard here is about not moving:
 *
 * - only from a parked run, never mid-turn — two orchestrators must never
 *   hold the same tree, and a turn that is still going owns it;
 * - only when the account in front of the run is actually exhausted, from its
 *   own sampler, not from a guess;
 * - only to an account that is not, on the same test, and that the user has
 *   set up (`candidates`);
 * - and at most once an hour, because a move costs a fresh briefing.
 *
 * A pinned goal moves only to get onto the provider it was pinned to, and
 * never because of usage: the user said which account this run spends, and
 * quota is not a reason to overrule them.
 *
 * That correcting move is on the same one-an-hour leash as the rest, and the
 * reason is a real one: without it a run that ended up on another provider
 * would be dragged back on the very next tick. It was — a manual move was
 * undone one second later, which is the runner overruling a human who had
 * just said what they wanted.
 */
export function failoverDecision(input: {
  goal: OdysseyRecord;
  journal: OdysseyJournalEntry[];
  /** The provider the goal's current session runs on. */
  current: Provider;
  usage: AccountUsage;
  /** Providers a goal may move onto: installed and signed in. Defaults to all. */
  candidates?: readonly Provider[];
  /** True when the run is parked: waiting on usage, or holding on a quota. */
  parked: boolean;
  /** True when no turn is in flight on the current session. */
  idle: boolean;
  now: number;
}): Failover | null {
  const { goal, journal, current, usage, parked, idle, now } = input;
  // A goal is run by an orchestrator, so only providers that can lead one
  // are somewhere to move it.
  const candidates = (input.candidates ?? ORCHESTRATOR_PROVIDERS).filter((provider) => ORCHESTRATOR_PROVIDERS.includes(provider));
  if (goal.state !== "running" && goal.state !== "waiting_usage") return null;
  // A turn owns the working tree until it settles. Nothing below is urgent
  // enough to take it away mid-edit.
  if (!idle) return null;

  // One move an hour, whatever the reason for it. A move costs a fresh
  // briefing, and the two ways to ask for one — a pin that does not match, and
  // an account that is spent — can otherwise take turns firing for ever.
  const since = lastMoveAt(journal);
  if (since !== null && now - since < FAILOVER_COOLDOWN_MS) return null;

  if (goal.orchestrator !== "either") {
    if (goal.orchestrator === current) return null;
    return { to: goal.orchestrator, reason: `this goal is set to run on ${label(goal.orchestrator)}` };
  }

  if (!parked) return null;

  const here = usageVerdict(usage[current]);
  if (here.kind !== "exhausted") return null;
  // In the order providers are listed, so the choice is stable tick to tick.
  const other = candidates.find((provider) => provider !== current && usageVerdict(usage[provider]).kind !== "exhausted");
  if (!other) return null;
  return { to: other, reason: `${label(current)}'s account is spent (${here.reason}) and ${label(other)}'s is not` };
}

function label(provider: Provider): string {
  return PROVIDER_LABELS[provider];
}

/** A goal set to stop after each milestone pauses instead of rolling on. */
export function stopsAfterMilestone(goal: OdysseyRecord): boolean {
  return goal.stopCondition === "milestone_complete" || goal.stopCondition === "manual";
}

/**
 * The ceiling a blocked goal has run into, if that is why it is blocked.
 *
 * Resume cannot clear a budget — the counters are real and the guard is right
 * — so a goal in this state will re-block on the instant, and the button that
 * offers to resume it is offering something that cannot work. The caller uses
 * this to name the actual remedy instead.
 */
export function exhaustedCeiling(goal: OdysseyRecord): { kind: "continuations" | "tokens"; used: number; limit: number; step: number } | null {
  if (goal.continuationsUsed >= goal.maxContinuations) {
    return { kind: "continuations", used: goal.continuationsUsed, limit: goal.maxContinuations, step: Math.max(1, goal.maxContinuations) };
  }
  if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
    return { kind: "tokens", used: goal.tokensUsed, limit: goal.tokenBudget, step: Math.max(1, goal.tokenBudget) };
  }
  return null;
}

/** Continuations left, for the budget line the model is told about. */
export function continuationsLeft(goal: OdysseyRecord): number {
  return Math.max(0, goal.maxContinuations - goal.continuationsUsed);
}

/** Human phrasing for the countdown, dropping seconds past an hour (§8.4). */
export function countdown(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, "0")}`;
  return `0:${String(seconds).padStart(2, "0")}`;
}
