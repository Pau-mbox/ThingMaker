/**
 * Transient UI state (Zustand). Not an authority for agent history: the
 * native supervisor owns session state and this store only holds renderer
 * projections, drafts, view selection and attention markers.
 *
 * Multiple sessions stay live at once (F01): switching the view never stops a
 * session actor. Attention is raised for sessions the user is not looking at
 * when a turn settles, an agent asks for input, or its process exits.
 */
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import type {
  AmendmentRecord,
  NewAmendment,
  AttachmentSnapshot,
  ContextBundle,
  Mention,
  SessionDefaults,
  UiPrefs,
  DesktopError,
  EventEnvelope,
  NotificationSettings,
  OutboxEntry,
  ProfileInfo,
  SessionHandle,
  SessionRecord,
  Snapshot,
  TrustState,
  WorkspaceInspection,
  WorkspaceRecord,
  UsageSnapshot,
  GoalEdit,
  MilestoneEdit,
  NewOdyssey,
  OdysseyView,
  OdysseyStep,
  PlanChangeRecord,
  QuestionRecord,
  RepositoryInfo,
  StepState,
  WorkspaceNotes,
  LoginEvent,
  Provider,
  ProviderInfo,
  QuotaSnapshot,
} from "@thingmaker/contracts";
import { EMPTY_COMBO, JOB_EVENT, ODYSSEY_STATE_NOTE, PROVIDERS, PROVIDER_LABELS, asConfigOptions, isEffortOption, type Combo, type JobView, type ProviderModel, type TeamPreset } from "@thingmaker/contracts";
import { handoffBrief, isOpen, readPresets, upsertJob, upsertPreset } from "./team";

/** Preference keys (scope `ui`) for saved teams. */
const TEAM_PRESETS_KEY = "teamPresets";
const DEFAULT_PRESET_KEY = "defaultTeamPreset";
import { api } from "./ipc";
import { notify, shouldNotify } from "./notifications";
import { agentNotesSince, buildBriefing, buildContinuation, type Delta } from "./odysseyPrompt";
import { PROMPT_UNANSWERED, QUOTA_WAIT_HOLD, RUN_STARTED, TICK_FAILED, TRANSPORT_CLOSED, checkpointDetail, handedOver, heldUntil, looksLikeQuotaError, looksLikeQuotaWait, looksLikeTransportError, parseReport, progressFingerprint, quotaWaitUntil, resumedFrom } from "./odysseyReport";
import { RESUME_JITTER_MS, continuationsLeft, deadTurn, decide, failoverDecision, lastPromptAt, resumeDecision, shouldResample, stallDuration, stallNotice, stopsAfterMilestone, usageVerdict } from "./odysseyRunner";
import { evidenceFor, failureTail, newCallIds, readableFromToolResults } from "./odysseyEvidence";
import { buildPlanningPrompt, parsePlan, type ProposedTask } from "./odysseyPlan";
import { matchAgentToTask, parseTaskLines } from "./odysseyTasks";
import { AMEND_INSTRUCTION, describeAmendment, describeOp, diffText, isMilestoneScope, parseAmendment, planDiff, resolveOps, retellNote, shouldCarry, type AmendOp, type ResolvedOp } from "./odysseyAmend";
import { parseAsks } from "./odysseyAsk";
import { CLAUDE_RETRY_MS, claudeUsageFrom } from "./odysseyClaudeQuota";
import { shellResultsIn } from "./toolSummary";
import { applyEvent, emptyProjection, type Projection } from "./projection";

export const CLOSE_REQUESTED_EVENT = "thingmaker://close-requested";

export type AttentionKind = "none" | "completed" | "failed" | "needs_input";

/** Change of one rate-limit window between two samples. `delta` is null when the window reset in between. */
export type WindowDelta = { before: number; after: number; delta: number | null; reset: boolean };
/**
 * Account-level OpenAI usage sampled around this session's turns. The
 * account counters are shared by everything using the subscription, so the
 * deltas are "usage during this session's turns", not a precise cost.
 */
export type SessionUsage = {
  turnStart: UsageSnapshot | null;
  latest: UsageSnapshot | null;
  lastTurn: { primary: WindowDelta | null; secondary: WindowDelta | null; settledAt: number } | null;
  totalPrimary: number;
  totalSecondary: number;
  turns: number;
  resets: number;
  sampling: boolean;
  error: string | null;
};

export const EMPTY_SESSION_USAGE: SessionUsage = { turnStart: null, latest: null, lastTurn: null, totalPrimary: 0, totalSecondary: 0, turns: 0, resets: 0, sampling: false, error: null };

export type LiveSession = {
  handle: SessionHandle;
  workspaceId: string;
  snapshot: Snapshot;
  projection: Projection;
  inFlightRequestId: string | null;
  steerInFlight: boolean;
  attention: AttentionKind;
  openedAt: number;
  /** Wall-clock start of the current foreground turn, for the activity view. */
  turnStartedAt: number | null;
  /** When this session last received any event. A turn that says it is running
   *  and has produced nothing for a long time has stopped being a turn. */
  lastEventAt: number | null;
  usage: SessionUsage;
};

export type View =
  | { kind: "welcome" }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "session"; sessionId: string }
  | { kind: "signin" }
  | { kind: "settings" }
  | { kind: "teams" }
  | { kind: "integrations" };

export type SessionTab = "transcript" | "files" | "changes" | "terminal" | "agents" | "context" | "artifacts" | "images" | "odyssey";

/** Every session view, in bar order. The command palette is the keyboard route
 *  to all of them, including the ones the bar keeps behind a menu or an icon,
 *  so it is built from this list rather than a second hand-written one. */
export type OdysseyRuntime = {
  resumeAt: number | null;
  lastReason: string;
  /** When `lastReason` was given. A reason with no age reads as current even
   *  when it is an hour old, which is exactly how a wedged run hides. */
  lastReasonAt: number;
  ticking: boolean;
  /** When the runner first gave this non-progress reason, or null while it is
   *  acting. `stallNotice` turns it into a warning once it has held too long. */
  stalledSince: number | null;
  /** Set once the stall has been journalled and announced, so it is reported
   *  once per episode rather than once per tick. */
  stallNotified: boolean;
};

/**
 * A prompt the runner submitted and has not yet seen settle.
 *
 * What it is for: telling an answered turn from one an agent accepted and no model
 * ever saw. The transcript's token total and the count of agent messages are
 * both read just before the submit; if neither moved by the settle, nothing
 * answered. Kept in memory on purpose — after a reload the turn is given the
 * benefit of the doubt and counted.
 */
export type PendingTurn = {
  kind: "brief" | "continue";
  submittedAt: number;
  tokensAtSubmit: number | null;
  agentMessagesAtSubmit: number;
};

export const SESSION_TABS: SessionTab[] = ["transcript", "agents", "odyssey", "terminal", "files", "changes", "context", "artifacts", "images"];

export const DEFAULT_UI_PREFS: UiPrefs = { enterSends: true, reducedMotion: "system", transcriptPage: 50 };

export type OpenMode = { mode: "new" } | { mode: "resume"; session_id: string };

/** A resume the agent refused because of a session lock; offered for explicit recovery. */
export type LockedResume = { workspaceId: string; sessionId: string; error: DesktopError };

export type SignInRun = {
  runId: string | null;
  provider: Provider;
  lines: { stream: string; text: string }[];
  urls: string[];
  state: "starting" | "running" | "success" | "failed" | "cancelled" | "timed_out";
};

type State = {
  /** Every provider this build knows, with its program and sign-in state. */
  providers: ProviderInfo[] | null;
  profiles: ProfileInfo[];
  workspaces: WorkspaceRecord[];
  inspections: Record<string, WorkspaceInspection>;
  /**
   * What each provider's account last said about itself, in one shape
   * (docs/plans/odyssey-second-orchestrator.md §2.4).
   *
   * The providers do not measure the same way: Codex reports two windows as
   * percentages, Claude reports its status on every turn and, once spent, a
   * refusal with a reset time on it. The runner asks `usageFor(provider)`
   * and never has to know the difference.
   *
   * `null` means nothing says the account is spent, which `usageVerdict`
   * reads as room. It is not a claim that the window is empty.
   */
  usage: Partial<Record<Provider, UsageSnapshot | null>>;
  /** The last quota each provider reported, verbatim, for the strip and Context tab. */
  quotas: Partial<Record<Provider, QuotaSnapshot>>;
  /** Desktop records per workspace (archive and pin flags), keyed by workspace id. */
  records: Record<string, SessionRecord[]>;
  /** Git head per workspace. `null` means checked and not a repository. */
  repoInfo: Record<string, RepositoryInfo | null>;
  /** The live Odyssey goal per session. `null` means read and there is none. */
  odyssey: Record<string, OdysseyView | null>;
  /** Runner bookkeeping that is not worth persisting: the resume time a wait
   *  is counting down to, the last reason a tick did nothing and when it was
   *  given, and how long the runner has been unable to act. */
  odysseyRuntime: Record<string, OdysseyRuntime>;
  /** State changes not yet told to the model; the next continuation carries them. */
  odysseyPendingDeltas: Record<string, Delta[]>;
  /** Tool-call ids the runner had already seen when it submitted, so a check
   *  the agent ran three turns ago cannot verify a milestone claimed now. */
  odysseyToolBaseline: Record<string, string[]>;
  /** Changes the user asked for while the goal was running, per session. */
  odysseyAmendments: Record<string, AmendmentRecord[]>;
  /** The runner's own prompt awaiting its settle, per session. */
  odysseyPendingTurn: Record<string, PendingTurn>;
  /** What the run has written into the workspace, as last read; null when the read failed. */
  odysseyNotes: Record<string, WorkspaceNotes | null>;
  /** Plan changes the agent proposed, newest first. */
  /**
   * Sessions a goal has moved *off*, and where it went.
   *
   * Without this the session left behind shows the "set a goal" form, which
   * reads as the run having been wiped rather than moved — the first thing a
   * user said on seeing it was that the session had corrupted. A pointer is
   * the truth and it is one click from the run.
   */
  odysseyMovedAway: Record<string, { goalId: string; title: string; to: string }>;
  odysseyPlanChanges: Record<string, PlanChangeRecord[]>;
  /** Decisions the agent handed to the user, newest first. */
  odysseyQuestions: Record<string, QuestionRecord[]>;
  showHidden: boolean;
  view: View;
  sessions: Record<string, LiveSession>;
  sessionOrder: string[];
  /** Each live session's team, as the host holds it. */
  teams: Record<string, Combo>;
  /** Jobs per orchestrator session (by attachment handle), oldest first. */
  jobs: Record<string, JobView[]>;
  /** The team a new session starts with. */
  defaultCombo: Combo;
  /** Model catalogs per provider, loaded on demand for the team picker. */
  providerModels: Partial<Record<Provider, ProviderModel[]>>;
  /** Saved teams (orchestrator and workers), in name order. */
  teamPresets: TeamPreset[];
  /** The preset a new session starts with, when one is chosen. */
  defaultPresetId: string | null;
  drafts: Record<string, string>;
  /** The provider sign-in in progress, if any. */
  signIn: SignInRun | null;
  settings: NotificationSettings | null;
  closeRequest: { activity: { id: string; active: boolean; detachedCalls: number }[] } | null;
  error: DesktopError | null;
  busy: string | null;
  focusComposerToken: number;
  lockedResume: LockedResume | null;
  /** Uncertain submissions per workspace, loaded on demand (REC-01). */
  outbox: Record<string, OutboxEntry[]>;
  /** Snapshotted media per session, sent with the next prompt (UX-06). */
  attachments: Record<string, AttachmentSnapshot[]>;
  /** File mentions per session with explicit delivery mode (UX-07). */
  mentions: Record<string, Mention[]>;
  contextBundles: Record<string, ContextBundle[]>;
  paletteOpen: boolean;
  sessionTab: SessionTab;
  transcriptSearchOpen: boolean;
  /** Text for the screen-reader live region (settled events only, UX-11). */
  announcement: string;
  uiPrefs: UiPrefs;
  sidebarCollapsed: boolean;
  /** Model/effort remembered from the last picker change (new sessions). */
  sessionDefaults: SessionDefaults;
  /** Images seen appearing under output/imagegen per session (observed files). */
  observedImages: Record<string, string[]>;
  seenImageFiles: Record<string, string[]>;

  bootstrap: () => Promise<void>;
  rehydrate: () => Promise<void>;
  loadOutbox: (workspaceId: string) => Promise<void>;
  discardOutbox: (workspaceId: string, requestId: string) => Promise<void>;
  resendOutbox: (workspaceId: string, entry: OutboxEntry) => Promise<void>;
  dismissLockedResume: () => void;
  addAttachments: (sessionId: string, snapshots: AttachmentSnapshot[]) => void;
  removeAttachment: (sessionId: string, id: string) => void;
  addMention: (sessionId: string, mention: Mention) => void;
  updateMention: (sessionId: string, index: number, mention: Mention) => void;
  removeMention: (sessionId: string, index: number) => void;
  loadContextBundles: (workspaceId: string) => Promise<void>;
  saveContextBundle: (workspaceId: string, bundle: ContextBundle) => Promise<void>;
  deleteContextBundle: (workspaceId: string, id: string) => Promise<void>;
  applyContextBundle: (sessionId: string, bundle: ContextBundle) => void;
  setPaletteOpen: (open: boolean) => void;
  setSessionTab: (tab: SessionTab) => void;
  setTranscriptSearchOpen: (open: boolean) => void;
  announce: (text: string) => void;
  toggleSidebar: () => void;
  removeWorkspace: (workspaceId: string) => Promise<void>;
  resetSessionDefaults: () => Promise<void>;
  noteImageFiles: (sessionId: string, files: string[], initial: boolean) => void;
  loadUiPrefs: () => Promise<void>;
  setUiPrefs: (patch: Partial<UiPrefs>) => Promise<void>;
  exportTranscript: (sessionId: string) => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: NotificationSettings) => Promise<void>;
  testNotification: () => Promise<void>;
  dismissCloseRequest: () => void;
  hideToTray: () => Promise<void>;
  quitAndStop: () => Promise<void>;
  setView: (view: View) => void;
  addWorkspaceByPicker: () => Promise<void>;
  addWorkspaceByPath: (path: string) => Promise<void>;
  selectWorkspace: (workspaceId: string) => Promise<void>;
  inspectWorkspace: (workspaceId: string) => Promise<WorkspaceInspection | null>;
  trust: (workspaceId: string, state: TrustState) => Promise<void>;
  loadProviders: () => Promise<void>;
  /**
   * Re-reads one provider's account now. Codex is asked; Claude's refusal is
   * re-read against its clock, because nothing on that side answers the
   * question in between turns. Returns the resulting snapshot.
   */
  refreshUsage: (provider: Provider) => Promise<UsageSnapshot | null>;
  /** Records what a provider reported about its quota. */
  noteQuota: (quota: QuotaSnapshot) => void;
  loadTeam: (sessionId: string) => Promise<void>;
  /** Changes a live session's team; the next `delegate` uses it. */
  saveTeam: (sessionId: string, combo: Combo) => Promise<void>;
  loadDefaultCombo: () => Promise<void>;
  saveDefaultCombo: (combo: Combo) => Promise<void>;
  loadProviderModels: (provider: Provider) => Promise<ProviderModel[]>;
  noteJob: (job: JobView) => void;
  cancelJob: (sessionId: string, jobId: string) => Promise<void>;
  /** Ends a waiting job's wait now. */
  retryJob: (sessionId: string, jobId: string) => Promise<void>;
  /** Shows a job's worker session, attaching to it if this window has not. */
  openWorker: (job: JobView) => Promise<void>;
  /**
   * Moves the work to a new session on another provider with the same team,
   * briefed from this one. Models cannot share a context window, so the brief
   * is put in the new session's composer to read and send.
   */
  handOff: (sessionId: string, provider: Provider, preset?: TeamPreset) => Promise<void>;
  loadTeamPresets: () => Promise<void>;
  saveTeamPreset: (preset: TeamPreset) => Promise<void>;
  deleteTeamPreset: (id: string) => Promise<void>;
  /** Makes a preset (or none) what a new session starts with. */
  setDefaultPreset: (id: string | null) => Promise<void>;
  /** Starts a session led by the preset's orchestrator, with its workers. */
  openSessionWithPreset: (workspaceId: string, preset: TeamPreset) => Promise<void>;
  /**
   * Applies a preset to a live session. Workers change at once; the
   * orchestrator's model and effort are set through its own options. A
   * preset led by another provider is a handoff, and that is returned so
   * the caller can say so rather than doing it silently.
   */
  applyPresetToSession: (sessionId: string, preset: TeamPreset) => Promise<"applied" | "needs_handoff">;
  sampleUsage: (sessionId: string, phase: "start" | "tick" | "settle") => Promise<void>;
  loadRecords: (workspaceId: string) => Promise<void>;
  archiveSession: (workspaceId: string, agentSessionId: string, archived: boolean) => Promise<void>;
  pinSession: (workspaceId: string, agentSessionId: string, pinned: boolean) => Promise<void>;
  renameSession: (workspaceId: string, agentSessionId: string, title: string | null) => Promise<void>;
  loadRepoInfo: (workspaceId: string) => Promise<void>;
  loadOdyssey: (sessionId: string) => Promise<void>;
  createOdyssey: (sessionId: string, request: NewOdyssey) => Promise<void>;
  editOdysseyGoal: (sessionId: string, id: string, edit: GoalEdit) => Promise<void>;
  deleteOdyssey: (sessionId: string, id: string) => Promise<void>;
  addMilestone: (sessionId: string, request: { odysseyId: string; title: string; detail?: string; checkKind?: string; checkSpec?: string | null }) => Promise<void>;
  editMilestone: (sessionId: string, id: string, edit: MilestoneEdit) => Promise<void>;
  reorderMilestones: (sessionId: string, odysseyId: string, orderedIds: string[]) => Promise<void>;
  deleteMilestone: (sessionId: string, id: string) => Promise<void>;
  addStep: (sessionId: string, milestoneId: string, title: string, detail?: string, dependsOn?: string[]) => Promise<void>;
  deleteStep: (sessionId: string, id: string) => Promise<void>;
  /** A human moving a task by hand; the record stamps the move. */
  setStepState: (sessionId: string, id: string, state: StepState) => Promise<void>;
  /** Queues an amendment asking the agent to break a milestone into tasks. */
  odysseyRequestTasks: (sessionId: string, milestoneIndex: number) => Promise<void>;
  /** Ties working subagents to the tasks they are named for, from the session stream. */
  odysseyObserveAgents: (sessionId: string) => Promise<void>;
  odysseyLoadInbox: (sessionId: string, odysseyId: string) => Promise<void>;
  /** Applies or rejects a held plan change; either way the agent is told. */
  odysseyDecidePlanChange: (sessionId: string, id: string, decision: "apply" | "reject", note?: string) => Promise<void>;
  /** Answers a question the agent asked, or dismisses it; the agent is told either way. */
  odysseyAnswerQuestion: (sessionId: string, id: string, answer: string | null) => Promise<void>;
  refreshOdyssey: (sessionId: string, id: string) => Promise<void>;
  odysseyStart: (sessionId: string) => Promise<void>;
  /** Points the goal at another open session, or a fresh one of either agent. */
  odysseyMoveTo: (sessionId: string, target: MoveTarget) => Promise<void>;
  odysseyPause: (sessionId: string, reason?: string) => Promise<void>;
  odysseyTick: (sessionId: string) => Promise<void>;
  /** One iteration, without the per-session guard. Call `odysseyTick`. */
  odysseyTickOnce: (sessionId: string) => Promise<void>;
  odysseyOnSettle: (sessionId: string, phase: string, error?: string) => Promise<void>;
  odysseyPoll: () => Promise<void>;
  odysseyVerifyManually: (sessionId: string, milestoneId: string) => Promise<void>;
  odysseyRunCheck: (sessionId: string, milestoneId: string) => Promise<void>;
  odysseyRequestPlan: (sessionId: string) => Promise<void>;
  odysseyAddAmendment: (sessionId: string, request: NewAmendment) => Promise<void>;
  odysseyDiscardAmendment: (sessionId: string, id: string) => Promise<void>;
  odysseyLoadAmendments: (sessionId: string, odysseyId: string) => Promise<void>;
  /** Reads an amendment block out of a reply and applies it. */
  odysseyApplyAmendment: (sessionId: string, reply: string) => Promise<void>;
  /** Closes activity the runtime never reported finishing. Presentation only. */
  clearStaleActivity: (sessionId: string) => void;
  odysseyReadPlanReply: (sessionId: string) => Promise<void>;
  /** Re-reads the handoff and subagent notes for the screen. */
  odysseyRefreshNotes: (sessionId: string) => Promise<void>;
  /** Stores one usage reading per running goal, with the session's token counters. */
  odysseyRecordUsageSamples: (snapshot: UsageSnapshot) => Promise<void>;
  /** Re-reads the account behind a session after a quota-shaped failure. */
  resampleAccount: (sessionId: string, message?: string | null) => Promise<void>;
  /** Which agent a live session runs, for the account its turns are charged to. */
  sessionAgent: (sessionId: string) => Provider;
  /** The account snapshot that governs this session, by its agent. */
  usageFor: (provider: Provider) => UsageSnapshot | null;
  /** Records what a Claude turn's failure said about the account. */
  noteClaudeLimit: (message: string | null | undefined) => boolean;
  /** Asks the Claude account whether it has room, without spending a turn. */
  refreshClaudeUsage: () => Promise<UsageSnapshot | null>;
  odysseyQueueDelta: (sessionId: string, delta: Delta) => void;
  odysseyDeltas: (sessionId: string) => Delta[];
  odysseyCheckpoint: (sessionId: string, milestoneId: string | null) => Promise<string | null>;
  odysseySessionTokens: (sessionId: string) => Promise<number | null>;
  odysseyStartTokens: (sessionId: string) => number | null;
  setShowHidden: (show: boolean) => void;
  /** Opens or resumes a session. A resume runs on the provider that wrote it; a new one on `provider`, else the last one used. */
  openSession: (workspaceId: string, mode: OpenMode, provider?: Provider) => Promise<void>;
  /** Opens a fresh session on a named agent and returns how to address it. */
  openSessionFor: (workspaceId: string, provider: Provider) => Promise<{ key: string; agentSessionId: string } | null>;
  selectSession: (sessionId: string) => void;
  setDraft: (sessionId: string, draft: string) => void;
  send: (sessionId: string) => Promise<void>;
  steer: (sessionId: string) => Promise<void>;
  cancel: (sessionId: string) => Promise<void>;
  stop: (sessionId: string) => Promise<void>;
  refreshSnapshot: (sessionId: string) => Promise<void>;
  setConfigOption: (sessionId: string, configId: string, value: string) => Promise<void>;
  startSignIn: (provider: Provider) => Promise<void>;
  /** Signs a provider out and straight back in, so its sessions spend a different account. */
  switchAccount: (provider: Provider) => Promise<void>;
  cancelSignIn: () => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  focusComposer: () => void;
  clearError: () => void;
  setError: (error: unknown) => void;
};

function asError(error: unknown): DesktopError {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    return error as DesktopError;
  }
  return { code: "IO", message: error instanceof Error ? error.message : String(error), retry: "user_action" };
}

function attentionFor(event: EventEnvelope, current: AttentionKind): AttentionKind {
  const payload = event.payload;
  // Permission requests are answered by the workspace's trust, with nobody
  // asked, so they need no input from anyone.
  if (payload.type === "exited") return "failed";
  if (payload.type === "turn" && payload.effect === "settled" && payload.kind === "foreground") {
    if (current === "needs_input") return current;
    return payload.phase === "succeeded" ? "completed" : "failed";
  }
  return current;
}

/** Whether a live session is a worker a delegation opened. */
function isWorkerSession(get: Get, id: string, session: LiveSession): boolean {
  if (Object.values(get().jobs).some((jobs) => jobs.some((job) => job.workerSession === id))) return true;
  const agentId = session.snapshot.agentSessionId;
  return !!agentId && !!(get().records[session.workspaceId] ?? []).find((record) => record.agentSessionId === agentId)?.parentSessionId;
}

export function basenameOf(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** A session's name: the desktop's rename (or a worker's job title) first, then the agent's, then its first prompt. */
export function sessionTitle(session: LiveSession, records?: SessionRecord[]): string {
  const overlay = session.snapshot.agentSessionId ? records?.find((record) => record.agentSessionId === session.snapshot.agentSessionId)?.titleOverlay : undefined;
  if (overlay) return overlay;
  if (session.projection.title) return session.projection.title;
  for (const card of session.projection.cards) {
    if (card.kind === "message" && card.message.role === "user") {
      const text = card.message.blocks.find((b) => b.type === "text");
      if (text && text.type === "text" && text.text.trim()) return text.text.trim().slice(0, 60);
    }
  }
  return `Session ${session.handle.id.replace(/^kw-/, "").slice(0, 8)}`;
}

/** Difference of one window between two samples; a changed reset time means the window rolled over. */
export function windowDelta(before: UsageSnapshot["primary"] | undefined, after: UsageSnapshot["primary"] | undefined): WindowDelta | null {
  if (!before || !after) return null;
  const reset = before.resetAtUnix !== undefined && after.resetAtUnix !== undefined && before.resetAtUnix !== after.resetAtUnix;
  return { before: before.usedPercent, after: after.usedPercent, delta: reset ? null : after.usedPercent - before.usedPercent, reset };
}

/**
 * A provider's quota report as the runner's usage snapshot.
 *
 * Windows the provider reports as percentages become `primary`/`secondary`,
 * shortest first. A report with no percentage at all (Claude says only
 * "allowed" until it is spent) is no snapshot, except when it is a refusal:
 * then the reset it names is the whole reading.
 */
export function usageFromQuota(quota: QuotaSnapshot): UsageSnapshot | null {
  const measured = quota.windows
    .filter((window) => window.usedPercent !== undefined)
    .sort((a, b) => (a.windowMinutes ?? Number.MAX_SAFE_INTEGER) - (b.windowMinutes ?? Number.MAX_SAFE_INTEGER));
  const toWindow = (window: QuotaSnapshot["windows"][number]) => ({
    usedPercent: window.usedPercent ?? 100,
    windowSeconds: (window.windowMinutes ?? 0) * 60,
    ...(window.resetsAt !== undefined ? { resetAtUnix: window.resetsAt } : {}),
  });
  const rejected = quota.status === "rejected";
  if (measured.length === 0 && !rejected) return null;
  const windows = measured.length > 0 ? measured : quota.windows;
  return {
    fetchedAtUnixMs: quota.observedAtUnixMs,
    ...(quota.plan ? { planType: quota.plan } : {}),
    allowed: !rejected,
    limitReached: rejected,
    ...(windows[0] ? { primary: rejected && measured.length === 0 ? { ...toWindow(windows[0]), usedPercent: 100 } : toWindow(windows[0]) } : {}),
    ...(windows[1] ? { secondary: toWindow(windows[1]) } : {}),
  };
}

/** The remembered model and effort, for a session on the provider they were chosen on. */
function launchDefaults(defaults: SessionDefaults, provider: Provider): { model?: string; reasoningEffort?: string } {
  if (defaults.provider !== provider) return {};
  return {
    ...(defaults.model ? { model: defaults.model } : {}),
    ...(defaults.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort } : {}),
  };
}

/**
 * One tick at a time per session.
 *
 * Three things start a tick — the heartbeat, a settled turn and Start — and
 * they each `await` something before calling, so they can all arrive at the
 * runner in the same instant. The `ticking` flag could not stop that: it is
 * read and written inside the tick, and by then the other callers are already
 * on their way. Five ticks landed together once and the agent refused four of them
 * with "session is already running a prompt", which blocked the goal and
 * burned continuations. A promise per session serialises them properly; the
 * ones that queue behind it then see the record the first one left.
 */
const tickInFlight = new Map<string, Promise<void>>();

/** Journal summary marking a planning turn as asked for. The settle that
 *  answers it is recognised by this line, so a reload does not lose the
 *  question and does not re-read an old reply as a plan. */
export const PLAN_REQUESTED = "Asked the agent to read the plan document";

const EMPTY_RUNTIME: OdysseyRuntime = { resumeAt: null, lastReason: "", lastReasonAt: 0, ticking: false, stalledSince: null, stallNotified: false };

/**
 * Merges into a goal's runner bookkeeping.
 *
 * Every call site used to write the whole record, so adding a field meant
 * every one of them silently reset it. Patching keeps the stall clock alive
 * across the ticks that do not care about it.
 */
function setRuntime(get: () => State, set: (partial: Partial<State>) => void, sessionId: string, patch: Partial<OdysseyRuntime>) {
  const current = get().odysseyRuntime[sessionId] ?? EMPTY_RUNTIME;
  set({ odysseyRuntime: { ...get().odysseyRuntime, [sessionId]: { ...current, ...patch } } });
}

/** Clears the submit-in-flight marker. It means "a submit is awaiting its
 *  accept", not "a turn is running" — `projection.foreground` says that — so
 *  it has to be released once the response is in, exactly as `send` does.
 *  Leaving it set makes the runner see a busy session for ever. */
function clearInFlight(get: () => State, set: (partial: Partial<State>) => void, sessionId: string) {
  const current = get().sessions[sessionId];
  if (current?.inFlightRequestId) set({ sessions: { ...get().sessions, [sessionId]: { ...current, inFlightRequestId: null } } });
}

/**
 * The lines that carry queued amendments into a prompt.
 *
 * Only `pending` ones: an amendment already told to the model is waiting for
 * its reply, and repeating it every turn would both cost tokens and invite the
 * model to apply it twice.
 */
/**
 * Writes proposed tasks under a milestone and wires their dependencies.
 *
 * The plan and the amendment grammars name a dependency by its number within
 * the milestone, counting the tasks that already exist first; the record
 * keeps ids, because a number drifts the moment a task is added above it.
 * Ids only exist after the writes, so the wiring is a second pass.
 */
async function createTasks(milestoneId: string, tasks: ProposedTask[], existing: OdysseyStep[]): Promise<void> {
  const created: OdysseyStep[] = [];
  for (const task of tasks) created.push(await api.odysseyAddStep(milestoneId, task.title));
  const all = [...existing, ...created];
  for (const [index, task] of tasks.entries()) {
    const step = created[index];
    if (!step || task.depends.length === 0) continue;
    const ids = task.depends.map((n) => all[n - 1]?.id).filter((id): id is string => !!id && id !== step.id);
    if (ids.length > 0) await api.odysseyEditStep(step.id, { dependsOn: ids });
  }
}

/**
 * Applies a resolved plan change: milestone and task operations in the
 * block's order, additions placed afterwards so a position the agent gave
 * still refers to the list it was shown. Writes the diff to the journal,
 * marks any told amendments applied and tells the agent what changed.
 */
async function applyResolvedOps(get: () => State, set: (partial: Partial<State>) => void, sessionId: string, view: OdysseyView, resolved: ResolvedOp[], notes: string[]): Promise<void> {
  const told = (get().odysseyAmendments[sessionId] ?? []).filter((record) => record.state === "told");
  const applied: string[] = [];
  try {
    for (const entry of resolved) {
      if (entry.refused) {
        applied.push(describeOp(entry));
        continue;
      }
      const { op, milestone, step } = entry;
      if (op.op === "revise" && milestone) {
        await api.odysseyEditMilestone(milestone.id, {
          ...(op.title ? { title: op.title } : {}),
          ...(op.detail ? { detail: op.detail } : {}),
          ...(op.section ? { section: op.section } : {}),
          ...(op.checkKind ? { checkKind: op.checkKind, checkSpec: op.checkSpec } : {}),
        });
        // Tasks named in a revise are appended after the milestone's own,
        // and their numbers count those first.
        if (op.steps.length > 0) await createTasks(milestone.id, op.steps, milestone.steps);
      } else if (op.op === "drop" && milestone) {
        await api.odysseyDeleteMilestone(milestone.id);
      } else if (op.op === "drop_task" && milestone && step) {
        // Whatever waited on it now waits on what it waited on.
        for (const sibling of milestone.steps) {
          if (!sibling.dependsOn.includes(step.id)) continue;
          const dependsOn = [...new Set([...sibling.dependsOn.filter((id) => id !== step.id), ...step.dependsOn.filter((id) => id !== sibling.id)])];
          await api.odysseyEditStep(sibling.id, { dependsOn });
        }
        await api.odysseyDeleteStep(step.id);
      } else if (op.op === "revise_task" && milestone && step) {
        const dependsOn = op.depends ? op.depends.map((n) => milestone.steps[n - 1]?.id).filter((id): id is string => !!id && id !== step.id) : undefined;
        await api.odysseyEditStep(step.id, {
          ...(op.title ? { title: op.title } : {}),
          ...(op.detail ? { detail: op.detail } : {}),
          ...(dependsOn ? { dependsOn } : {}),
        });
      } else if (op.op === "split_task" && milestone && step) {
        // The pieces inherit what the whole waited on, sit where it sat, and
        // whatever waited on the whole waits on the last piece.
        const pieces: OdysseyStep[] = [];
        for (const piece of op.steps) pieces.push(await api.odysseyAddStep(milestone.id, piece.title));
        const all = [...milestone.steps, ...pieces];
        for (const [index, piece] of op.steps.entries()) {
          const created = pieces[index];
          if (!created) continue;
          const own = piece.depends.map((n) => all[n - 1]?.id).filter((id): id is string => !!id && id !== created.id && id !== step.id);
          const dependsOn = [...new Set([...step.dependsOn, ...own])];
          if (dependsOn.length > 0) await api.odysseyEditStep(created.id, { dependsOn });
        }
        const last = pieces.at(-1);
        for (const sibling of milestone.steps) {
          if (sibling.id === step.id || !sibling.dependsOn.includes(step.id)) continue;
          await api.odysseyEditStep(sibling.id, { dependsOn: [...new Set(sibling.dependsOn.map((id) => (id === step.id && last ? last.id : id)))] });
        }
        const ordered = milestone.steps.flatMap((sibling) => (sibling.id === step.id ? pieces.map((piece) => piece.id) : [sibling.id]));
        await api.odysseyReorderSteps(milestone.id, ordered);
        await api.odysseyDeleteStep(step.id);
      } else if (op.op === "move_task" && milestone && step) {
        const rest = milestone.steps.filter((sibling) => sibling.id !== step.id).map((sibling) => sibling.id);
        const anchor = op.after === "start" ? -1 : rest.indexOf(milestone.steps[op.after - 1]?.id ?? "");
        rest.splice(anchor + 1, 0, step.id);
        await api.odysseyReorderSteps(milestone.id, rest);
      }
      applied.push(describeOp(entry));
    }

    // Adds go last and are placed afterwards, so a position the model gave
    // still refers to the list it was shown.
    const additions: { id: string; afterId: string | null }[] = [];
    for (const entry of resolved) {
      if (entry.op.op !== "add" || entry.refused) continue;
      const created = await api.odysseyAddMilestone({
        odysseyId: view.goal.id,
        title: entry.op.title,
        detail: entry.op.detail,
        checkKind: entry.op.checkKind,
        checkSpec: entry.op.checkSpec,
        section: entry.op.section,
      });
      await createTasks(created.id, entry.op.steps, []);
      const anchor = entry.op.after === "end" ? null : (view.milestones[entry.op.after - 1]?.id ?? null);
      additions.push({ id: created.id, afterId: anchor });
    }

    if (additions.length > 0) {
      await get().refreshOdyssey(sessionId, view.goal.id);
      const current = get().odyssey[sessionId]?.milestones ?? [];
      const added = new Set(additions.map((entry) => entry.id));
      const ordered: string[] = [];
      for (const milestone of current) {
        if (added.has(milestone.id)) continue;
        ordered.push(milestone.id);
        for (const entry of additions) if (entry.afterId === milestone.id) ordered.push(entry.id);
      }
      // Anything whose anchor is gone (dropped in this same block) lands at
      // the end rather than vanishing from the order.
      for (const entry of additions) if (!ordered.includes(entry.id)) ordered.push(entry.id);
      if (ordered.length === current.length) await api.odysseyReorderMilestones(view.goal.id, ordered);
    }

    await api.odysseyJournalAppend({
      odysseyId: view.goal.id,
      kind: "plan",
      summary: `The plan changed: ${applied.length} operation${applied.length === 1 ? "" : "s"}`,
      detail: [...applied, ...notes].join("\n"),
    });
    for (const record of told) await api.odysseyAmendSetState(record.id, "applied").catch(() => undefined);
    get().odysseyQueueDelta(sessionId, { kind: "plan_edited", summary: applied.join("; ") });
    await get().odysseyLoadAmendments(sessionId, view.goal.id);
    await get().refreshOdyssey(sessionId, view.goal.id);
  } catch (error) {
    set({ error: asError(error) });
  }
}

/** Per session: what the observer last recorded for each subagent, so a redraw does not rewrite the record. */
const observedAgents = new Map<string, Map<string, string>>();

async function buildAmendmentLines(get: () => State, sessionId: string, continuationsUsed: number): Promise<{ lines: string[]; ids: string[]; changes: boolean }> {
  const due = (get().odysseyAmendments[sessionId] ?? []).filter((record) => shouldCarry(record, continuationsUsed));
  const lines: string[] = [];
  const ids: string[] = [];
  let changes = false;
  for (const record of due) {
    const document = record.documentSource ? await api.odysseyAmendDocument(record.id).catch(() => null) : null;
    lines.push(...describeAmendment(record, document));
    // A repeat says so. Asking again in the same words reads as a new
    // request, and the model has no way to know it already declined one.
    if (record.tellCount > 0 && record.kind !== "note") lines.push(retellNote(record));
    if (record.kind !== "note") changes = true;
    ids.push(record.id);
  }
  return { lines, ids, changes };
}

/** The text of the last agent message in a session's projection. */
/** Every agent message in the transcript, oldest first, as text. */
function agentMessages(session: LiveSession | undefined): string[] {
  if (!session) return [];
  return session.projection.cards.flatMap((card) =>
    card.kind === "message" && card.message.role === "agent" ? [card.message.blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n")] : [],
  );
}

/**
 * The agent's messages from this turn only: everything after the count the
 * runner took at submit. Reading the *last* message on every settle is how
 * one report line was journalled eight times — a burst of settles each
 * re-read the same reply. A report belongs to the turn that produced it.
 */
function agentTextSince(session: LiveSession | undefined, fromCount: number): string {
  return agentMessages(session).slice(fromCount).join("\n");
}

/** Whether this claim was already journalled since the last prompt went out. */
function alreadyReported(journal: { kind: string; milestoneId?: string | undefined; detail?: string | undefined }[], milestoneId: string, note: string): boolean {
  for (const entry of journal) {
    if (entry.kind === "continuation" || entry.kind === "briefing") return false;
    if (entry.kind === "report" && entry.milestoneId === milestoneId && (entry.detail ?? "") === note) return true;
  }
  return false;
}

function lastAgentText(session: LiveSession | undefined): string {
  const card = session ? [...session.projection.cards].reverse().find((entry) => entry.kind === "message" && entry.message.role === "agent") : undefined;
  if (!card || card.kind !== "message") return "";
  return card.message.blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

type Get = () => State;
type Set = (partial: Partial<State>) => void;

function projectionFromSnapshot(snapshot: Snapshot): Projection {
  const projection = emptyProjection();
  projection.process = snapshot.process;
  projection.attachment = snapshot.attachment;
  projection.capabilities = snapshot.capabilities;
  projection.foreground = snapshot.foreground;
  projection.configOptions = snapshot.configOptions;
  for (const [id, patch] of Object.entries(snapshot.toolCalls)) projection.toolCalls.set(id, patch);
  return projection;
}

/**
 * Attaches the renderer to a live actor: snapshot, retained history (replayed
 * in order, deduplicated by sequence), then the live stream. Events that
 * arrive while history is loading are buffered and applied after it.
 */
/** Where a goal is being moved to: an open session, or a fresh one. */
type MoveTarget = { kind: "session"; sessionId: string } | { kind: "new"; agent: Provider };

/**
 * Moves a goal onto another session and leaves it running there
 * (docs/plans/odyssey-second-orchestrator.md §2.3).
 *
 * Shared by the user's "Move to…" and by automatic failover, which is the
 * point: the two differ only in who decided and whether anyone was asked.
 * `reason`, when given, is journalled so the history says why a run changed
 * accounts on its own.
 */
async function performMove(get: Get, set: Set, sessionId: string, target: MoveTarget, reason: string | null): Promise<boolean> {
  const view = get().odyssey[sessionId];
  const session = get().sessions[sessionId];
  if (!view || !session) return false;
  const running = session.projection.foreground === "running" || session.projection.foreground === "awaiting_user";
  try {
    // A turn owns the working tree. It is cancelled before anything else
    // moves, so two orchestrators are never editing it at once.
    if (running) await api.sessionCancel(session.handle).catch(() => undefined);

    let targetKey: string | null = null;
    let targetAgentSessionId: string | null = null;
    if (target.kind === "session") {
      targetKey = target.sessionId;
      targetAgentSessionId = get().sessions[target.sessionId]?.snapshot.agentSessionId ?? null;
    } else {
      // Moving onto an agent that cannot answer at all is how a goal ends up
      // on a session that will never take a prompt, with no way back. This
      // proves sign-in, not headroom — nothing on the Claude side reports
      // headroom — but sign-in is the failure worth catching before the move.
      if (target.agent === "claude") {
        const status = await api.odysseyClaudePreflight().catch(() => null);
        if (status && !status.available) {
          set({ error: asError(new Error(status.problem ?? status.message ?? "the Claude account cannot be used right now")) });
          return false;
        }
      }
      // Always a fresh session rather than an open one of the right agent:
      // the briefing goes out again anyway, so reusing one buys nothing and
      // could take a session the user is working in.
      const opened = await get().openSessionFor(session.workspaceId, target.agent);
      if (!opened) return false;
      targetKey = opened.key;
      targetAgentSessionId = opened.agentSessionId;
    }
    if (!targetKey || !targetAgentSessionId) {
      set({ error: asError(new Error("that session is not attached any more")) });
      return false;
    }

    const targetProvider = get().sessions[targetKey]?.snapshot.provider;
    let moved = await api.odysseyRepoint(view.goal.id, session.workspaceId, targetAgentSessionId, targetProvider);
    if (reason) {
      await api.odysseyJournalAppend({ odysseyId: view.goal.id, kind: "state", summary: reason }).catch(() => undefined);
    } else {
      // A move the user made by hand *is* a statement about which account
      // this run spends, so it updates the setting. Without this the runner
      // reads the goal as still pinned where it was and drags it back — which
      // it did, one second after the first real move, undoing a human who had
      // just said what they wanted. A goal set to `either` is left alone:
      // there the user has already said "you decide".
      const landedOn: "claude" | "codex" = targetProvider === "codex" ? "codex" : "claude";
      if (moved.goal.orchestrator !== "either" && moved.goal.orchestrator !== landedOn) {
        await api.odysseyEditGoal(moved.goal.id, { orchestrator: landedOn }).catch(() => undefined);
        moved = (await api.odysseyView(moved.goal.id)) ?? moved;
      }
    }

    // Deltas are what the next continuation has to say and they belong to the
    // goal, not to the session that happened to be holding them. The pending
    // turn belongs to the turn that was just cancelled and does not.
    const deltas = get().odysseyPendingDeltas;
    const { [sessionId]: carried = [], ...restDeltas } = deltas;
    const { [sessionId]: _dropped, ...restPending } = get().odysseyPendingTurn;
    set({
      odysseyPendingDeltas: { ...restDeltas, [targetKey]: [...(deltas[targetKey] ?? []), ...carried] },
      odysseyPendingTurn: restPending,
      odyssey: { ...get().odyssey, [sessionId]: null, [targetKey]: moved },
      // So the session left behind says where the run went instead of
      // offering a blank form, which reads as the goal having been lost.
      odysseyMovedAway: { ...get().odysseyMovedAway, [sessionId]: { goalId: moved.goal.id, title: moved.goal.title, to: targetKey } },
    });
    await get().loadOdyssey(targetKey);
    // A goal parked on usage is running again the moment it is on an account
    // that has room; without this it would sit in `waiting_usage` waiting for
    // a window it is no longer on.
    if (moved.goal.state === "waiting_usage") await get().odysseyStart(targetKey);
    else await get().odysseyTick(targetKey);
    return true;
  } catch (error) {
    set({ error: asError(error) });
    return false;
  }
}

async function attachLive(get: Get, set: Set, handle: SessionHandle, workspaceId: string, focus: boolean): Promise<void> {
  const snapshot = await api.sessionSnapshot(handle);
  const projection = projectionFromSnapshot(snapshot);
  const id = handle.id;
  const existing = get().sessions[id];
  const live: LiveSession = {
    handle,
    workspaceId,
    snapshot,
    projection,
    inFlightRequestId: null,
    steerInFlight: false,
    attention: existing?.attention ?? "none",
    openedAt: existing?.openedAt ?? Date.now(),
    turnStartedAt: null,
    usage: existing?.usage ?? EMPTY_SESSION_USAGE,
      lastEventAt: existing?.lastEventAt ?? null,
};
  set({
    sessions: { ...get().sessions, [id]: live },
    sessionOrder: [...get().sessionOrder.filter((s) => s !== id), id],
    ...(focus ? { view: { kind: "session", sessionId: id } as View, sessionTab: "transcript" as SessionTab } : {}),
  });
  // Read any goal this session is driving now rather than when its tab is
  // first opened: a run has to continue whether or not anyone is looking.
  void get().loadOdyssey(id);
  void get().loadTeam(id);

  let historyDone = false;
  const buffered: EventEnvelope[] = [];
  // Presentation batching (section 21.1): events are applied to the
  // projection as they arrive but the store publishes at most ~30 times per
  // second, so streaming tokens never rerender every pane per chunk.
  let queue: EventEnvelope[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    flushTimer = null;
    const events = queue;
    queue = [];
    const current = get().sessions[id];
    if (!current || events.length === 0) return;
    const view = get().view;
    const viewing = view.kind === "session" && view.sessionId === id;
    let attention = current.attention;
    let announcement: string | null = null;
    let sawAgents = false;
    let turnStartedAt = current.turnStartedAt;
    const worker = isWorkerSession(get, id, current);
    for (const event of events) {
      if (BigInt(event.sequence) <= BigInt(current.projection.lastSequence)) continue;
      applyEvent(current.projection, event);
      // A worker reports to its orchestrator, whose Agents tab shows it; its
      // own turns finishing are not the user's to acknowledge.
      if (!viewing && !worker) attention = attentionFor(event, attention);
      const payload = event.payload;
      if (payload.type === "turn" && payload.effect === "started" && payload.kind === "foreground") {
        turnStartedAt = Date.now();
        void get().sampleUsage(id, "start");
      }
      if (payload.type === "runtime_event" && payload.event === "subagent_state_changed") sawAgents = true;
      if (payload.type === "quota") {
        const { type: _type, ...quota } = payload;
        get().noteQuota(quota);
      }
      if (payload.type === "turn" && payload.effect === "settled" && payload.kind === "foreground") {
        turnStartedAt = null;
        void get().sampleUsage(id, "settle");
        // Odyssey advances on settled turns; it decides for itself whether
        // this session has a running goal.
        void get().odysseyOnSettle(id, payload.phase, payload.error);
        announcement = `${sessionTitle(current)}: turn ${payload.phase}`;
      } else if (payload.type === "permission_request") {
        announcement = `${sessionTitle(current)}: the agent asked for input`;
        // Every decision taken on an unattended run goes in the record
        // (docs/plans/odyssey-second-orchestrator.md §2.2). An orchestrator
        // answers these without a human, so the only way anyone can audit
        // what a run was allowed to do — or work out why the agent said its
        // subagent launches were declined — is if each one is written down.
        const goal = get().odyssey[id];
        if (goal) {
          const decision = payload.decision === "allowed" ? "allowed" : "refused";
          void api
            .odysseyJournalAppend({
              odysseyId: goal.goal.id,
              kind: "guard",
              summary: `Permission ${decision}: ${payload.title ?? "an unnamed request"}`,
              detail: `The agent asked to do something its permission mode did not already cover, and the run answered ${decision} from the workspace's trust state. Nobody was asked.`,
            })
            .catch(() => undefined);
        }
      } else if (payload.type === "exited") {
        announcement = `${sessionTitle(current)}: the agent exited`;
      }
    }
    if (viewing) attention = "none";
    set({ sessions: { ...get().sessions, [id]: { ...current, projection: { ...current.projection }, attention, turnStartedAt, lastEventAt: Date.now() } } });
    if (announcement) get().announce(announcement);
    // A subagent that appeared or moved may be a task's owner.
    if (sawAgents && get().odyssey[id]) void get().odysseyObserveAgents(id);
    if (!viewing && attention !== "none" && attention !== current.attention) {
      const settings = get().settings;
      const workspace = get().workspaces.find((w) => w.id === current.workspaceId);
      const name = workspace ? basenameOf(workspace.displayPath) : "a workspace";
      if (settings && shouldNotify(settings, attention, current.workspaceId)) void notify(attention, name);
    }
  };
  const applyLive = (event: EventEnvelope) => {
    queue.push(event);
    if (flushTimer === null) flushTimer = setTimeout(flush, 33);
  };
  await api.sessionSubscribe(handle, (event: EventEnvelope) => {
    if (historyDone) applyLive(event);
    else buffered.push(event);
  });
  try {
    const history = await api.sessionHistory(handle, "0");
    const current = get().sessions[id];
    if (current) {
      const fresh = projectionFromSnapshot(current.snapshot);
      for (const event of history) applyEvent(fresh, event);
      set({ sessions: { ...get().sessions, [id]: { ...current, projection: fresh } } });
    }
  } finally {
    historyDone = true;
    for (const event of buffered) applyLive(event);
  }
}

export const useStore = create<State>((set, get) => ({
  providers: null,
  profiles: [],
  workspaces: [],
  inspections: {},
  usage: {},
  quotas: {},
  records: {},
  repoInfo: {},
  odyssey: {},
  odysseyRuntime: {},
  odysseyToolBaseline: {},
  odysseyAmendments: {},
  odysseyPendingDeltas: {},
  odysseyPendingTurn: {},
  odysseyNotes: {},
  odysseyMovedAway: {},
  odysseyPlanChanges: {},
  odysseyQuestions: {},
  showHidden: false,
  view: { kind: "welcome" },
  sessions: {},
  sessionOrder: [],
  drafts: {},
  teams: {},
  jobs: {},
  defaultCombo: EMPTY_COMBO,
  providerModels: {},
  teamPresets: [],
  defaultPresetId: null,
  signIn: null,
  settings: null,
  closeRequest: null,
  error: null,
  busy: null,
  focusComposerToken: 0,
  lockedResume: null,
  outbox: {},
  attachments: {},
  mentions: {},
  contextBundles: {},
  paletteOpen: false,
  sessionTab: "transcript",
  transcriptSearchOpen: false,
  announcement: "",
  uiPrefs: DEFAULT_UI_PREFS,
  sidebarCollapsed: false,
  sessionDefaults: {},
  observedImages: {},
  seenImageFiles: {},

  async bootstrap() {
    try {
      const [profiles, workspaces] = await Promise.all([api.executionProfiles(), api.workspaceList()]);
      set({ profiles, workspaces });
      void get().loadSettings();
      void get().loadUiPrefs();
      void get().loadProviders();
      // Inspection never launches an agent; doing it up front lets the sidebar show
      // real trust state instead of "not inspected yet".
      for (const workspace of workspaces) {
        void get().inspectWorkspace(workspace.id);
        // Archive and pin flags live in desktop metadata; load them for every
        // workspace so archived sessions are hidden and the Pinned group is
        // complete on the first render, not after visiting each project.
        void get().loadRecords(workspace.id);
      }
      void get().rehydrate();
      void get().loadDefaultCombo();
      // Both accounts' usage for the sidebar, now and every five minutes: the
      // sessions report it too, but only while one is running.
      const readUsage = () => {
        for (const provider of PROVIDERS) void get().refreshUsage(provider);
      };
      readUsage();
      setInterval(readUsage, 5 * 60_000);
      void get().loadTeamPresets();
      void listen<JobView>(JOB_EVENT, (event) => get().noteJob(event.payload));
      void listen(CLOSE_REQUESTED_EVENT, async () => {
        let activity: { id: string; active: boolean; detachedCalls: number }[] = [];
        try {
          activity = await api.appActivity();
        } catch {
          activity = Object.values(get().sessions).map((s) => ({ id: s.handle.id, active: s.projection.foreground === "running", detachedCalls: 0 }));
        }
        set({ closeRequest: { activity } });
      });
      const first = workspaces[0];
      if (first) {
        await get().selectWorkspace(first.id);
      }
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async loadSettings() {
    try {
      set({ settings: await api.settingsGet() });
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async saveSettings(settings) {
    try {
      set({ settings: await api.settingsSet(settings) });
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async testNotification() {
    const sent = await notify("completed", "a test workspace");
    if (!sent) {
      set({ error: { code: "UNSUPPORTED", message: "Notifications are not permitted by the operating system for ThingMaker.", retry: "user_action" } });
    }
  },

  dismissCloseRequest() {
    set({ closeRequest: null });
  },

  async hideToTray() {
    set({ closeRequest: null });
    try {
      await api.appHideToTray();
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async quitAndStop() {
    set({ closeRequest: null, busy: "Stopping local tasks and quitting" });
    try {
      await api.appQuit(true);
    } catch (error) {
      set({ error: asError(error), busy: null });
    }
  },

  setView(view) {
    set({ view });
    if (view.kind === "session") {
      const session = get().sessions[view.sessionId];
      if (session && session.attention !== "none") {
        set({ sessions: { ...get().sessions, [view.sessionId]: { ...session, attention: "none" } } });
      }
    }
  },

  async addWorkspaceByPicker() {
    try {
      const path = await api.workspacePick();
      if (path) await get().addWorkspaceByPath(path);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async addWorkspaceByPath(path) {
    if (!path.trim()) return;
    set({ busy: "Inspecting workspace", error: null });
    try {
      const inspection = await api.workspaceInspect(path.trim());
      const workspaces = await api.workspaceList();
      set({
        workspaces,
        inspections: { ...get().inspections, [inspection.record.id]: inspection },
        view: { kind: "workspace", workspaceId: inspection.record.id },
      });
    } catch (error) {
      set({ error: asError(error) });
    } finally {
      set({ busy: null });
    }
  },

  async selectWorkspace(workspaceId) {
    set({ view: { kind: "workspace", workspaceId } });
    if (!get().inspections[workspaceId]) await get().inspectWorkspace(workspaceId);
  },

  async inspectWorkspace(workspaceId) {
    const record = get().workspaces.find((w) => w.id === workspaceId);
    if (!record) return null;
    try {
      const inspection = await api.workspaceInspect(record.canonicalRoot);
      set({ inspections: { ...get().inspections, [workspaceId]: inspection } });
      return inspection;
    } catch (error) {
      set({ error: asError(error) });
      return null;
    }
  },

  async trust(workspaceId, state) {
    const inspection = get().inspections[workspaceId];
    if (!inspection) return;
    set({ busy: "Recording trust decision", error: null });
    try {
      const updated = await api.workspaceTrust(workspaceId, state, inspection.trustDigest);
      const workspaces = await api.workspaceList();
      set({ workspaces, inspections: { ...get().inspections, [workspaceId]: updated } });
      if (state === "trusted_local") void get().loadRecords(workspaceId);
    } catch (error) {
      set({ error: asError(error) });
      // The digest may be stale: re-inspect so the user sees the new sources.
      await get().inspectWorkspace(workspaceId);
    } finally {
      set({ busy: null });
    }
  },

  async loadProviders() {
    try {
      set({ providers: await api.providersStatus() });
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async refreshUsage(provider) {
    // Both accounts are asked now: Codex through its app-server, Claude
    // through Claude Code's own `/usage` data. Neither costs a turn.
    try {
      const quota = await api.providerQuota(provider);
      // A reading is for the account it was asked about, or it is not one.
      if (!quota || quota.provider !== provider) throw new Error("no reading");
      get().noteQuota(quota);
    } catch {
      // A reading that cannot be taken leaves the last one in place; it is
      // evidence, never a decision. Claude's refusal-based reading is the
      // fallback when Claude Code cannot be asked.
      if (provider === "claude") return get().refreshClaudeUsage();
    }
    return get().usage[provider] ?? null;
  },

  noteQuota(quota) {
    const quotas = { ...get().quotas, [quota.provider]: quota };
    const snapshot = usageFromQuota(quota);
    const usage = { ...get().usage };
    // A provider that reports no percentages (Claude before it is spent) says
    // only "allowed": that is no snapshot at all, which reads as room, and it
    // clears a refusal recorded earlier — a turn that got an answer is the
    // positive evidence the refusal was waiting for.
    if (snapshot) usage[quota.provider] = snapshot;
    else if (quota.status !== "rejected") usage[quota.provider] = null;
    set({ quotas, usage });
    if (snapshot && quota.provider === "codex") void get().odysseyRecordUsageSamples(snapshot);
  },

  /**
   * Re-reads the account behind one session after a failure that looked like
   * a quota wall.
   *
   * The two accounts report in different ways and the difference matters: the
   * OpenAI one has an endpoint, so it is asked; the Claude one does not, so
   * the failure message *is* the reading, and asking anything else would be
   * asking a question nothing answers.
   */
  async resampleAccount(sessionId, message) {
    const provider = get().sessionAgent(sessionId);
    if (provider !== "claude") {
      await get().refreshUsage(provider);
      return;
    }
    // The message is the reading when it carries one; the probe is the
    // fallback for a refusal that named nothing useful.
    if (!get().noteClaudeLimit(message)) await get().refreshClaudeUsage();
  },

  sessionAgent(sessionId) {
    return get().sessions[sessionId]?.snapshot.provider ?? "claude";
  },

  usageFor(provider) {
    return get().usage[provider] ?? null;
  },

  /**
   * Reads a failed turn's error as the Claude account being spent, and keeps
   * it. Returns whether it was one, so the caller can tell a quota wall from
   * an ordinary failure without parsing the message twice.
   */
  noteClaudeLimit(message) {
    const snapshot = claudeUsageFrom(message, Date.now());
    if (!snapshot) return false;
    set({ usage: { ...get().usage, claude: snapshot } });
    return true;
  },

  /**
   * Re-reads the Claude account's state — which is a clock, not a question
   * anything answers (docs/plans/odyssey-second-orchestrator.md §2.4).
   *
   * This started out asking the adapter for its model catalog, on the theory
   * that a spent account would refuse it. It does not: `session/new` succeeds
   * and the catalog comes back in full while every prompt is refused
   * (verified against the live adapter). So the probe proves *sign-in*, never
   * headroom — and using it here cleared the limit a minute after it was
   * recorded, wiped the countdown off the screen and sent the runner back
   * into a refusal. Park, clear, resume, refuse, park, once a minute.
   *
   * The only two honest facts on this side are the refusal and the reset time
   * printed in it, so that is all this uses. Inside the window the recorded
   * limit stands and the goal counts down to it; once the window has passed
   * the limit is dropped so the run may try again, and if it is refused again
   * the refusal re-parks it with the new time. That costs one prompt per
   * window, which is the cheapest possible way to learn something nothing
   * will tell you.
   */
  async refreshClaudeUsage() {
    const held = get().usage.claude;
    if (!held) return null;
    const resetAt = held.primary?.resetAtUnix;
    const windowOver = resetAt !== undefined && Date.now() >= resetAt * 1000;
    // Retry well before the reset the refusal named, because that time is
    // not to be trusted as a floor. These windows roll — §6's lesson on the
    // other account — and a refusal can also name a window that was never
    // this run's to begin with: one was recorded here against the wrong
    // account entirely and would have parked a working run for three hours.
    //
    // A refused prompt costs nothing, so the cheap thing is to keep asking.
    const worthRetrying = Date.now() - held.fetchedAtUnixMs >= CLAUDE_RETRY_MS;
    if (!windowOver && !worthRetrying) return held;
    set({ usage: { ...get().usage, claude: null } });
    return null;
  },

  async sampleUsage(sessionId, phase) {
    const before = get().sessions[sessionId];
    if (!before) return;
    // Per-turn window deltas need percentages, which only Codex reports. The
    // readings arrive as quota events on the session's own stream, so a turn
    // boundary reads the latest one rather than asking anything.
    if (get().sessionAgent(sessionId) !== "codex") return;
    const snapshot = get().usage.codex ?? null;
    const patch = (usage: Partial<SessionUsage>) => {
      const current = get().sessions[sessionId];
      if (current) set({ sessions: { ...get().sessions, [sessionId]: { ...current, usage: { ...current.usage, ...usage } } } });
    };
    const current = get().sessions[sessionId];
    if (!current || !snapshot) return;
    const usage = current.usage;
    if (phase === "start") {
      patch({ sampling: false, error: null, turnStart: snapshot, latest: snapshot });
      return;
    }
    if (phase === "tick" || !usage.turnStart) {
      patch({ sampling: false, error: null, latest: snapshot });
      return;
    }
    const primary = windowDelta(usage.turnStart.primary, snapshot.primary);
    const secondary = windowDelta(usage.turnStart.secondary, snapshot.secondary);
    patch({
      sampling: false,
      error: null,
      latest: snapshot,
      turnStart: null,
      lastTurn: { primary, secondary, settledAt: Date.now() },
      totalPrimary: usage.totalPrimary + (primary?.delta ?? 0),
      totalSecondary: usage.totalSecondary + (secondary?.delta ?? 0),
      turns: usage.turns + 1,
      resets: usage.resets + (primary?.reset ? 1 : 0) + (secondary?.reset ? 1 : 0),
    });
  },

  async loadRecords(workspaceId) {
    try {
      const records = await api.sessionRecords(workspaceId);
      set({ records: { ...get().records, [workspaceId]: records } });
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async archiveSession(workspaceId, agentSessionId, archived) {
    try {
      await api.sessionArchive(workspaceId, agentSessionId, archived);
      await get().loadRecords(workspaceId);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  /**
   * Reads the workspace's git head for the top bar. A folder that is not a
   * repository is a normal case, not an error: it records `null` and stays
   * quiet rather than raising the global error banner.
   */
  async loadRepoInfo(workspaceId) {
    try {
      const info = await api.gitInfo(workspaceId);
      set({ repoInfo: { ...get().repoInfo, [workspaceId]: info } });
    } catch {
      set({ repoInfo: { ...get().repoInfo, [workspaceId]: null } });
    }
  },

  /** Blank clears the overlay, restoring the title derived from the transcript. */
  async renameSession(workspaceId, agentSessionId, title) {
    try {
      await api.sessionRename(workspaceId, agentSessionId, title && title.trim() ? title.trim() : null);
      await get().loadRecords(workspaceId);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  /**
   * Reads the goal for a session. A session with no goal records `null`, which
   * is how the screen tells "none yet" from "not read yet".
   */
  async loadOdyssey(sessionId) {
    const session = get().sessions[sessionId];
    const agentSessionId = session?.snapshot.agentSessionId;
    if (!session || !agentSessionId) return;
    try {
      // The goal is keyed by the desktop session record, which the supervisor
      // resolves from the agent's id.
      const view = await api.odysseyForSession(session.workspaceId, agentSessionId);
      set({ odyssey: { ...get().odyssey, [sessionId]: view } });
      // Queued amendments survive a reload; without this they would be in the
      // record and invisible, and the next prompt would not carry them.
      if (view) {
        await get().odysseyLoadAmendments(sessionId, view.goal.id);
        await get().odysseyLoadInbox(sessionId, view.goal.id);
      }
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async createOdyssey(sessionId, request) {
    try {
      const view = await api.odysseyCreate(request);
      set({ odyssey: { ...get().odyssey, [sessionId]: view } });
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async editOdysseyGoal(sessionId, id, edit) {
    try {
      await api.odysseyEditGoal(id, edit);
      await get().refreshOdyssey(sessionId, id);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async deleteOdyssey(sessionId, id) {
    try {
      await api.odysseyDelete(id);
      set({ odyssey: { ...get().odyssey, [sessionId]: null } });
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async addMilestone(sessionId, request) {
    try {
      await api.odysseyAddMilestone(request);
      await get().refreshOdyssey(sessionId, request.odysseyId);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async editMilestone(sessionId, id, edit) {
    const current = get().odyssey[sessionId];
    try {
      await api.odysseyEditMilestone(id, edit);
      if (current) await get().refreshOdyssey(sessionId, current.goal.id);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async reorderMilestones(sessionId, odysseyId, orderedIds) {
    try {
      await api.odysseyReorderMilestones(odysseyId, orderedIds);
      await get().refreshOdyssey(sessionId, odysseyId);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async deleteMilestone(sessionId, id) {
    const current = get().odyssey[sessionId];
    try {
      await api.odysseyDeleteMilestone(id);
      if (current) await get().refreshOdyssey(sessionId, current.goal.id);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async addStep(sessionId, milestoneId, title, detail = "", dependsOn = []) {
    const current = get().odyssey[sessionId];
    try {
      await api.odysseyAddStep(milestoneId, title, detail, dependsOn);
      if (current) await get().refreshOdyssey(sessionId, current.goal.id);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async setStepState(sessionId, id, state) {
    const current = get().odyssey[sessionId];
    try {
      await api.odysseySetStepState(id, state);
      if (current) await get().refreshOdyssey(sessionId, current.goal.id);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async odysseyRequestTasks(sessionId, milestoneIndex) {
    const view = get().odyssey[sessionId];
    const milestone = view?.milestones[milestoneIndex];
    if (!view || !milestone) return;
    await get().odysseyAddAmendment(sessionId, {
      odysseyId: view.goal.id,
      note: `Break milestone ${milestoneIndex + 1} ("${milestone.title}") into three to eight tasks, in order, each one thing a subagent can be given; put depends: under a task that has to wait for earlier ones. Send them in an ODYSSEY-AMEND block as revise: ${milestoneIndex + 1} with step: lines. Change nothing else about the milestone.`,
      refs: [],
    });
  },

  async odysseyObserveAgents(sessionId) {
    const view = get().odyssey[sessionId];
    const session = get().sessions[sessionId];
    if (!view || !session) return;
    const seen = observedAgents.get(sessionId) ?? new Map<string, string>();
    observedAgents.set(sessionId, seen);
    let changed = false;
    for (const agent of session.projection.inspector.agents.values()) {
      const key = `${agent.status}|${agent.harness}|${agent.model ?? ""}`;
      if (seen.get(agent.id) === key) continue;
      const match = matchAgentToTask(agent.name, view.milestones);
      if (!match) continue;
      seen.set(agent.id, key);
      try {
        // The harness and model are what the stream said; the name ties the
        // row to the agent for next time. Completion is not inferred here:
        // "done" is the agent's report, on its task line.
        if (match.step.agentName !== agent.name || match.step.harness !== agent.harness || (agent.model && match.step.model !== agent.model)) {
          await api.odysseyAssignStep(match.step.id, agent.name, agent.harness, agent.model);
          changed = true;
        }
        if ((agent.status === "working" || agent.status === "starting") && match.step.state === "pending") {
          await api.odysseySetStepState(match.step.id, "in_progress");
          changed = true;
        }
      } catch {
        // Attribution is a convenience; the run does not depend on it.
      }
    }
    if (changed) await get().refreshOdyssey(sessionId, view.goal.id);
  },

  async deleteStep(sessionId, id) {
    const current = get().odyssey[sessionId];
    try {
      await api.odysseyDeleteStep(id);
      if (current) await get().refreshOdyssey(sessionId, current.goal.id);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  /**
   * Starts or resumes a run. Everything a run does goes through `odysseyTick`,
   * so this only moves the state and lets the tick decide.
   */
  async odysseyStart(sessionId) {
    const view = get().odyssey[sessionId];
    if (!view) return;
    // Pressing Resume is the user saying "try it now", and on the Claude
    // account that is the only way to find out: nothing there reports
    // headroom, so a recorded refusal would otherwise stand until its own
    // stated reset even when the account is plainly working.
    if (get().sessionAgent(sessionId) === "claude" && get().usage.claude) set({ usage: { ...get().usage, claude: null } });
    try {
      await api.odysseySetState(view.goal.id, "running");
      // The exact wording the guard looks for, so a restart clears it.
      await api.odysseyJournalAppend({ odysseyId: view.goal.id, kind: "state", summary: view.goal.state === "draft" ? RUN_STARTED : resumedFrom(view.goal.state) });
      await get().refreshOdyssey(sessionId, view.goal.id);
      await get().odysseyTick(sessionId);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  /**
   * Points this goal at another session
   * (docs/plans/odyssey-second-orchestrator.md §2.3).
   *
   * The record moves, the transcript does not. What survives is what a fresh
   * orchestrator can read: the plan with its milestone states, the journal,
   * `docs/odyssey/STATE.md` and the subagent notes — which is why the next
   * briefing says so and lists what is already done.
   *
   * The current turn is cancelled rather than left running: two orchestrators
   * editing one tree is the risk this feature carries, and the only cheap
   * mitigation is that there is never more than one.
   */
  async odysseyMoveTo(sessionId, target) {
    const view = get().odyssey[sessionId];
    const session = get().sessions[sessionId];
    if (!view || !session) return;
    const running = session.projection.foreground === "running" || session.projection.foreground === "awaiting_user";
    const destination =
      target.kind === "session" ? (get().sessions[target.sessionId]?.snapshot.agentSessionId ?? null) : null;
    if (target.kind === "session" && !destination) {
      set({ error: asError(new Error("that session is not attached any more")) });
      return;
    }
    try {
      const confirmed = await api.confirmDialog({
        title: "Move this run to another session?",
        message: [
          running ? "The turn running now is cancelled first." : "",
          `The goal, its milestones and its history move across. The conversation does not: the new session is briefed from the record and from \`${ODYSSEY_STATE_NOTE}\`, and starts with no memory of this one.`,
          target.kind === "new" ? `A fresh ${PROVIDER_LABELS[target.agent]} session is opened for it.` : "",
        ]
          .filter(Boolean)
          .join(" "),
        okLabel: "Move the run",
        cancelLabel: "Leave it here",
        warning: running,
      });
      if (!confirmed) return;
    } catch (error) {
      set({ error: asError(error) });
      return;
    }

    set({ busy: "Moving the run" });
    try {
      if (await performMove(get, set, sessionId, target, null)) get().announce(`${view.goal.title}: moved to another session`);
    } finally {
      set({ busy: null });
    }
  },

  /** Pauses before the next continuation; an in-flight turn is left alone. */
  async odysseyPause(sessionId, reason) {
    const view = get().odyssey[sessionId];
    if (!view) return;
    try {
      await api.odysseySetState(view.goal.id, "paused");
      await api.odysseyJournalAppend({ odysseyId: view.goal.id, kind: "state", summary: reason ?? "Paused by you" });
      await get().refreshOdyssey(sessionId, view.goal.id);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  /**
   * One iteration of the runner (docs/plans/odyssey.md §4.1): checkpoint, then
   * do whatever `decide` says. Guarded against re-entry, because a settle and
   * a poll can land together.
   */
  async odysseyTick(sessionId) {
    // Not a queue, and not awaited: a tick that arrives while one is running
    // has nothing new to decide, and awaiting would deadlock the paths that
    // reach back into the runner (a desktop check restarts the run).
    if (tickInFlight.has(sessionId)) return;
    const run = get()
      .odysseyTickOnce(sessionId)
      .finally(() => tickInFlight.delete(sessionId));
    tickInFlight.set(sessionId, run);
    return run;
  },

  async odysseyTickOnce(sessionId) {
    const state = get();
    const view = state.odyssey[sessionId];
    const session = state.sessions[sessionId];
    if (!view || !session) return;
    const runtime = state.odysseyRuntime[sessionId];
    if (runtime?.ticking) return;

    const agent = state.sessionAgent(sessionId);
    const idle =
      !session.inFlightRequestId &&
      session.projection.foreground !== "running" &&
      session.projection.foreground !== "cancelling" &&
      session.projection.foreground !== "awaiting_user";
    const decision = decide({
      goal: view.goal,
      milestones: view.milestones,
      journal: view.journal,
      session: {
        attached: session.projection.attachment === "attached" && session.projection.process !== "exited",
        idle,
      },
      usage: state.usageFor(agent),
    });

    const note = (lastReason: string, resumeAt: number | null = runtime?.resumeAt ?? null) =>
      setRuntime(get, set, sessionId, { resumeAt, lastReason, lastReasonAt: Date.now(), ticking: false, stalledSince: null, stallNotified: false });

    // The largest lever there is: 62% of the first real run's wall clock went
    // on one account's usage window with a second subscription sitting idle
    // (docs/plans/odyssey-second-orchestrator.md §2.5). The rule is in the
    // runner and every guard in it is about *not* moving; this only performs
    // what it decided.
    const failover = failoverDecision({
      goal: view.goal,
      journal: view.journal,
      current: agent,
      usage: state.usage,
      // Providers not yet asked about are not ruled out: an unknown is not a no.
      ...(state.providers ? { candidates: state.providers.filter((info) => info.resolved && info.auth?.loggedIn !== false).map((info) => info.provider) } : {}),
      // Parked means "waiting on capacity, with nothing else to do": the
      // usage guard has stopped it, or the agent reported a quota wait and
      // the runner is holding until the time it named. Read from the record
      // rather than matched against the idle reason's wording, which is prose
      // and can be reworded without anyone noticing this depended on it.
      parked: decision.action === "wait_usage" || (decision.action === "idle" && (heldUntil(view.journal) ?? 0) > Date.now()),
      idle,
      now: Date.now(),
    });
    if (failover) {
      const summary = `Moving to ${PROVIDER_LABELS[failover.to]}: ${failover.reason}`;
      note(summary);
      get().announce(`${view.goal.title}: ${summary}`);
      await performMove(get, set, sessionId, { kind: "new", agent: failover.to }, summary);
      return;
    }

    if (decision.action === "idle") {
      // A run is mostly waiting, so an idle tick is not news. What is news is
      // the same reason holding for minutes: the run is wedged and nothing
      // else would ever say so (docs/plans/odyssey-observability.md §4).
      const now = Date.now();
      const previous = runtime ?? EMPTY_RUNTIME;
      const changed = previous.lastReason !== decision.reason;
      const since = changed || previous.stalledSince === null ? now : previous.stalledSince;
      const notified = changed ? false : previous.stallNotified;
      setRuntime(get, set, sessionId, { lastReason: decision.reason, lastReasonAt: now, ticking: false, stalledSince: since, stallNotified: notified });

      // A turn that has produced nothing for a long time has stopped being a
      // turn, and nothing else will ever free it. Cancelling is the only exit,
      // so the runner takes it rather than waiting for a human to notice.
      // Subagent activity arrives on the same stream, so a turn with a live
      // subagent is never silent and never cancelled here; the count is for
      // the record of what a dead one took down.
      // Jobs the session delegated run in their workers' sessions, so the
      // orchestrator's own stream is quiet while it waits on them; open jobs
      // are its turn being alive.
      const delegating = (get().jobs[sessionId] ?? []).some(isOpen);
      const dead = deadTurn({
        running: session.projection.foreground === "running" && !delegating,
        lastEventAt: session.lastEventAt,
        now,
        minutes: view.goal.deadTurnMinutes,
        workingAgents: [...session.projection.inspector.agents.values()].filter((agent) => agent.status === "working" || agent.status === "starting").length,
      });
      if (dead && decision.reason === "a turn is already running") {
        const silent = stallDuration(dead.silentMs);
        const agents = dead.workingAgents > 0 ? ` while ${dead.workingAgents} subagent${dead.workingAgents === 1 ? " was" : "s were"} still listed as working` : "";
        try {
          await api.sessionCancel(session.handle);
          await api.odysseyJournalAppend({
            odysseyId: view.goal.id,
            kind: "guard",
            summary: `Cancelled a turn that had produced nothing for ${silent}${agents}`,
            detail: `No events at all reached the session in that time — not from the turn and not from any subagent — so nothing in it was alive and the turn could not settle on its own. The run continues from the last checkpoint${dead.workingAgents > 0 ? "; whatever those subagents wrote to docs/odyssey/agents/ is read by the next turn" : ""}.`,
          });
          get().announce(`${view.goal.title}: cancelled a turn that went silent for ${silent}`);
        } catch (error) {
          set({ error: asError(error) });
        }
        setRuntime(get, set, sessionId, { lastReason: `cancelled a turn that went silent for ${silent}`, lastReasonAt: now, stalledSince: null, stallNotified: false });
        await get().refreshOdyssey(sessionId, view.goal.id);
        return;
      }

      const notice = stallNotice({ reason: decision.reason, since, now });
      if (notice && !notified) {
        setRuntime(get, set, sessionId, { stallNotified: true });
        // Written to the record as well as announced: a stall that happened
        // while nobody was looking has to be readable afterwards.
        await api.odysseyJournalAppend({ odysseyId: view.goal.id, kind: "guard", summary: notice }).catch(() => undefined);
        await get().refreshOdyssey(sessionId, view.goal.id);
        get().announce(`${view.goal.title}: ${notice}`);
      }
      return;
    }

    if (decision.action === "await_verification") {
      // A claim is not a verification. When the milestone has a check Odyssey
      // can run, run it — that is the desktop-run lane and it decides here
      // without another turn. When it does not, the claim is a stopping point
      // and the user's tick is the evidence.
      if (decision.milestone.checkKind !== "manual" && decision.milestone.checkSpec) {
        note(`running the check for milestone ${decision.index + 1}`);
        await get().odysseyRunCheck(sessionId, decision.milestone.id);
        return;
      }
      note(`milestone ${decision.index + 1} is reported complete and waiting for your tick`);
      if (view.goal.state === "running") {
        await get().odysseyPause(sessionId, `Milestone ${decision.index + 1} reported complete; verify it to continue`);
      }
      return;
    }

    setRuntime(get, set, sessionId, { lastReason: "working", lastReasonAt: Date.now(), ticking: true, stalledSince: null, stallNotified: false });
    try {
      if (decision.action === "block") {
        await api.odysseySetState(view.goal.id, "blocked");
        await api.odysseyJournalAppend({ odysseyId: view.goal.id, kind: "guard", summary: decision.reason });
        await get().refreshOdyssey(sessionId, view.goal.id);
        note(decision.reason);
        return;
      }
      if (decision.action === "complete") {
        await api.odysseySetState(view.goal.id, "complete");
        // Blunt on purpose: a goal can finish with claims nobody checked, and
        // the record should say how much of it was actually evidenced.
        const checked = view.milestones.filter((milestone) => milestone.state === "verified").length;
        const claimed = view.milestones.filter((milestone) => milestone.state === "reported").length;
        await api.odysseyJournalAppend({
          odysseyId: view.goal.id,
          kind: "state",
          summary:
            claimed > 0
              ? `Finished: ${checked} of ${view.milestones.length} milestones were verified, ${claimed} are the agent's word alone`
              : "Every milestone is verified or skipped",
        });
        await get().refreshOdyssey(sessionId, view.goal.id);
        note("the goal is complete", null);
        return;
      }
      if (decision.action === "wait_usage") {
        await api.odysseySetState(view.goal.id, "waiting_usage");
        await api.odysseyJournalAppend({
          odysseyId: view.goal.id,
          kind: "wait",
          summary: `Waiting for usage: ${decision.reason}`,
          detail: decision.resumeAt ? `resume at ${new Date(decision.resumeAt).toISOString()}` : "the provider reported no reset time",
        });
        await get().refreshOdyssey(sessionId, view.goal.id);
        note(decision.reason, decision.resumeAt);
        return;
      }

      // brief | continue: both submit a prompt, so both checkpoint first.
      const fingerprint = await get().odysseyCheckpoint(sessionId, decision.action === "continue" ? decision.milestone.id : null);
      // The briefing offers the `odyssey` skill, so it is installed first; a
      // failure drops the offer rather than pointing at nothing.
      const skillAvailable = decision.action === "brief" ? await api.odysseyInstallSkill().then(() => true).catch(() => false) : true;
      // Under a Claude orchestrator a subagent's model is a field on an agent
      // definition, not a role table, so the delegate has to exist in the
      // project before the agent is told to use it. Installed at the briefing
      // because that is the prompt that names it.
      if (decision.action === "brief" && agent === "claude") {
        await api.odysseyInstallDelegate(session.workspaceId).catch(() => undefined);
      }
      // What the run has written to the workspace, so the prompt can say
      // truthfully whether the handoff note exists and which subagent notes
      // are new since the model last worked.
      const notes = await api.odysseyWorkspaceNotes(session.workspaceId).catch(() => null);
      set({ odysseyNotes: { ...get().odysseyNotes, [sessionId]: notes } });
      // Anything the user queued rides on this prompt, whatever kind it is.
      const carried = await buildAmendmentLines(get, sessionId, view.goal.continuationsUsed);
      const base =
        decision.action === "brief"
          ? buildBriefing(view.goal, view.milestones, { skillAvailable, notes, handedOver: handedOver(view.journal), agent })
          : buildContinuation({
              milestone: decision.milestone,
              index: decision.index,
              total: view.milestones.length,
              deltas: get().odysseyDeltas(sessionId),
              planPath: view.goal.planPath ?? null,
              notes,
              agentNotes: agentNotesSince(notes, lastPromptAt(view.journal)),
            });
      // The "fold it into the plan" instruction goes only with a change; a
      // note alone needs no answer.
      const text = carried.lines.length > 0 ? [base, "", ...carried.lines, ...(carried.changes ? ["", AMEND_INSTRUCTION] : [])].join("\n") : base;

      // Read before the submit, so the model's first tokens cannot be
      // mistaken for the state before it answered.
      const tokensAtSubmit = await get().odysseySessionTokens(sessionId);
      const agentMessagesAtSubmit = agentMessages(session).length;

      const requestId = crypto.randomUUID();
      // Everything the projection already knows about is not this turn's
      // work; the agent-run lane reads only what appears after this point.
      set({
        odysseyToolBaseline: { ...get().odysseyToolBaseline, [sessionId]: [...session.projection.toolCalls.keys()] },
        sessions: { ...get().sessions, [sessionId]: { ...session, inFlightRequestId: requestId } },
      });
      const response = await api.sessionSubmit(session.handle, requestId, text);
      clearInFlight(get, set, sessionId);
      if (response.outcome.outcome !== "accepted") {
        const message = response.outcome.error?.message ?? "unknown";
        // A session that is mid-prompt is busy, not broken — the user may have
        // typed one themselves. Blocking the whole goal for that would need a
        // human to restart a run that was about to be fine on its own.
        if (/already running a prompt|session is busy/i.test(message)) {
          note("the session was busy; the next tick will try again");
          return;
        }
        // A transport that is not there is a process mid-restart, not a
        // broken run. Four of these blocked the first real run and each one
        // needed a human to press Resume on a goal that was about to be fine.
        if (looksLikeTransportError(message)) {
          await api.odysseyJournalAppend({
            odysseyId: view.goal.id,
            kind: "guard",
            summary: `${TRANSPORT_CLOSED}: ${message}`,
            detail: "The prompt was refused while the session was restarting. It is retried once the session is attached and idle again.",
          });
          await get().refreshOdyssey(sessionId, view.goal.id);
          note("the session was restarting; the next tick will try again");
          return;
        }
        // A spent account is a wait, not a fault — and on this side it
        // arrives as a *refused prompt* rather than a failed turn.
        //
        // Kit accepts the prompt and the turn fails afterwards, which is why
        // the quota path was only ever wired into the settle. The Claude
        // adapter refuses the submit outright with `errorKind: rate_limit`,
        // so a goal that had merely run out of window was blocked and sat
        // there needing a human, for a condition with a reset time on it
        // (docs/plans/odyssey-second-orchestrator.md §2.4).
        if (looksLikeQuotaError(message)) {
          await get().resampleAccount(sessionId, message);
          const verdict = usageVerdict(get().usageFor(get().sessionAgent(sessionId)));
          const resumeAt = verdict.kind === "exhausted" ? verdict.resumeAt : null;
          const reason = verdict.kind === "exhausted" ? verdict.reason : message;
          await api.odysseySetState(view.goal.id, "waiting_usage");
          await api.odysseyJournalAppend({
            odysseyId: view.goal.id,
            kind: "wait",
            summary: `Waiting for usage: ${reason}`,
            detail: resumeAt ? `resume at ${new Date(resumeAt).toISOString()}\nThe agent refused the prompt rather than failing the turn: ${message}` : message,
          });
          await get().refreshOdyssey(sessionId, view.goal.id);
          note(reason, resumeAt);
          return;
        }
        set({ error: response.outcome.error });
        await api.odysseySetState(view.goal.id, "blocked");
        await api.odysseyJournalAppend({ odysseyId: view.goal.id, kind: "guard", summary: `The session refused the prompt: ${message}` });
        await get().refreshOdyssey(sessionId, view.goal.id);
        note("the session refused the prompt");
        return;
      }

      set({
        odysseyPendingTurn: {
          ...get().odysseyPendingTurn,
          [sessionId]: { kind: decision.action, submittedAt: Date.now(), tokensAtSubmit, agentMessagesAtSubmit },
        },
      });

      if (decision.action === "brief") {
        // The starting token total lives in the briefing entry, so the budget
        // is measurable after a reload.
        await api.odysseyJournalAppend({ odysseyId: view.goal.id, kind: "briefing", summary: "Briefed the session on the goal", detail: JSON.stringify({ startTokens: tokensAtSubmit }) });
      } else {
        await api.odysseySetMilestoneState(decision.milestone.id, "active");
        await api.odysseyJournalAppend({
          odysseyId: view.goal.id,
          kind: "continuation",
          milestoneId: decision.milestone.id,
          summary: `Continued milestone ${decision.index + 1} of ${view.milestones.length}`,
          detail: text,
        });
      }
      // Clear the deltas we just told the model about, and mark the
      // amendments as carried so the next prompt does not repeat them. Only a
      // continuation carries deltas — the briefing does not mention them — so
      // clearing them there would throw away what the goal still has to say,
      // which is exactly what a move does: it briefs, and the deltas it
      // carried over would go with that prompt.
      if (decision.action === "continue") set({ odysseyPendingDeltas: { ...get().odysseyPendingDeltas, [sessionId]: [] } });
      for (const id of carried.ids) await api.odysseyAmendMarkTold(id, view.goal.continuationsUsed).catch(() => undefined);
      if (carried.ids.length > 0) await get().odysseyLoadAmendments(sessionId, view.goal.id);
      await get().refreshOdyssey(sessionId, view.goal.id);
      note(decision.action === "brief" ? "briefed the session" : `working milestone ${decision.index + 1}`);
      void fingerprint;
    } catch (error) {
      clearInFlight(get, set, sessionId);
      const failure = asError(error);
      set({ error: failure });
      // Written to the record, not just to a banner: a tick that throws
      // before it can submit does not clear by being retried, and retrying is
      // what this did — for ever, at a checkpoint every eleven seconds, on a
      // fault nobody was watching for. The guard in `decide` blocks the run
      // once a few of these are in a row.
      await api
        .odysseyJournalAppend({
          odysseyId: view.goal.id,
          kind: "guard",
          summary: `${TICK_FAILED}: ${failure.message}`,
          detail: "The prompt was never sent, so nothing was charged to the budget. The run stops after a few of these rather than retrying a fault that does not clear by itself.",
        })
        .catch(() => undefined);
      await get().refreshOdyssey(sessionId, view.goal.id);
      setRuntime(get, set, sessionId, { lastReason: `the last tick failed: ${failure.message}`, lastReasonAt: Date.now(), ticking: false });
    }
  },

  /**
   * After a turn settles: record what happened, then tick. A failure that
   * looks like a quota error re-samples usage first, so a real error is not
   * mistaken for a limit (docs/plans/odyssey.md §6.1).
   */
  async odysseyOnSettle(sessionId, phase, error) {
    const view = get().odyssey[sessionId];
    if (!view) return;

    // A draft goal that asked for a plan is waiting for this turn's reply.
    // The plan is read before anything else, because a draft has no run to
    // account for and nothing else to do with a settle.
    if (view.goal.state === "draft") {
      const asked = view.journal.find((entry) => entry.kind === "plan");
      if (phase === "succeeded" && asked?.summary === PLAN_REQUESTED && view.milestones.length === 0) await get().odysseyReadPlanReply(sessionId);
      return;
    }
    if (view.goal.state !== "running" && view.goal.state !== "waiting_usage") return;

    const session = get().sessions[sessionId];
    const pending = get().odysseyPendingTurn[sessionId];
    if (pending) {
      const { [sessionId]: _settled, ...rest } = get().odysseyPendingTurn;
      set({ odysseyPendingTurn: rest });
    }

    // Did a model answer at all? Kit accepts a prompt and writes it to the
    // transcript before anything runs, so a settle is not proof of a turn.
    // Twenty-five of fifty-four continuations on the first real run settled
    // with no model output; they are not turns and are not charged.
    const total = await get().odysseySessionTokens(sessionId);
    const answered = !pending || (total !== null && pending.tokensAtSubmit !== null ? total > pending.tokensAtSubmit : agentMessages(session).length > pending.agentMessagesAtSubmit);
    if (!answered) {
      await api.odysseyJournalAppend({
        odysseyId: view.goal.id,
        kind: "guard",
        summary: PROMPT_UNANSWERED,
        detail: `The turn ${phase}${error ? `: ${error}` : " with no model output"}. It is not charged to the budget and its checkpoint is not evidence of a stale turn.`,
      });
      if (looksLikeQuotaError(error)) await get().resampleAccount(sessionId, error);
      await get().refreshOdyssey(sessionId, view.goal.id);
      await get().odysseyTick(sessionId);
      return;
    }

    // Charge the turn to the goal's budget from the transcript's own numbers.
    const start = get().odysseyStartTokens(sessionId);
    if (total !== null && start !== null) {
      const target = Math.max(0, total - start);
      await api.odysseyRecordContinuation(view.goal.id, Math.max(0, target - view.goal.tokensUsed)).catch(() => undefined);
    } else {
      await api.odysseyRecordContinuation(view.goal.id, 0).catch(() => undefined);
    }

    if (phase !== "succeeded") {
      if (looksLikeQuotaError(error)) {
        await get().resampleAccount(sessionId, error);
        await get().refreshOdyssey(sessionId, view.goal.id);
        await get().odysseyTick(sessionId);
        return;
      }
      // The process went away under the turn. That is a restart: the run
      // stays running and carries on from the last checkpoint when the
      // session is back, and the guard's count starts again after it.
      if (looksLikeTransportError(error)) {
        await api.odysseyJournalAppend({
          odysseyId: view.goal.id,
          kind: "guard",
          summary: `${TRANSPORT_CLOSED}: ${error}`,
          detail: "The session's process or channel ended under the turn. That is not the agent's failure; the run continues from the last checkpoint once the session is attached again, and reads docs/odyssey/agents/ for anything a subagent finished before it died.",
        });
        await get().refreshOdyssey(sessionId, view.goal.id);
        await get().odysseyTick(sessionId);
        return;
      }
      await api.odysseySetState(view.goal.id, "blocked");
      await api.odysseyJournalAppend({ odysseyId: view.goal.id, kind: "guard", summary: `The turn ${phase}${error ? `: ${error}` : ""}` });
      await get().refreshOdyssey(sessionId, view.goal.id);
      return;
    }

    // A turn the Claude account answered is the only positive evidence that
    // account ever gives: there is no endpoint to ask, so a completed turn is
    // what clears a limit recorded earlier.
    if (get().sessionAgent(sessionId) === "claude" && get().usage.claude) set({ usage: { ...get().usage, claude: null } });

    // The model's own claim, read from *this turn's* messages and stored as a
    // claim. Without a pending turn (a reload, or a prompt the user sent) the
    // last message is all there is to read.
    const reply = pending ? agentTextSince(session, pending.agentMessagesAtSubmit) : lastAgentText(session);

    // The model may have folded the user's amendments into the plan in this
    // reply. That is read before the report, so a milestone the amendment
    // added is in the list before anything claims to have finished one.
    await get().odysseyApplyAmendment(sessionId, reply);

    const report = parseReport(reply);
    if (report) {
      const milestone = view.milestones[report.milestone - 1];
      // The same claim journalled twice since the last prompt is the same
      // reply read twice, not a second report.
      if (milestone && alreadyReported(view.journal, milestone.id, report.note)) {
        await get().refreshOdyssey(sessionId, view.goal.id);
        await get().odysseyTick(sessionId);
        return;
      }
      if (milestone) {
        if (report.status === "complete") {
          await api.odysseyRecordReport(milestone.id, report.note);
          await api.odysseyJournalAppend({ odysseyId: view.goal.id, kind: "report", milestoneId: milestone.id, summary: `Reported milestone ${report.milestone} complete`, detail: report.note });
          // Agent-run, desktop-read (§5.1): if the model (or a subagent it
          // raised) ran the check itself, the exit code in Kit's own tool
          // record decides. The prose never does.
          if (readableFromToolResults(milestone.checkKind)) {
            const fresh = newCallIds(session?.projection.toolCalls.keys() ?? [], get().odysseyToolBaseline[sessionId]);
            const results = (fresh ?? []).flatMap((id) => shellResultsIn(session?.projection.toolCalls.get(id)?.rawOutput));
            const evidence = fresh === null ? ({ kind: "absent", reason: "this turn was not started by the runner, so its tool results cannot be attributed to it" } as const) : evidenceFor(milestone.checkSpec, results);
            if (evidence.kind === "found") {
              const passed = evidence.result.exitCode === 0;
              const tail = failureTail(evidence.result);
              await api.odysseyRecordCheck(milestone.id, passed, `${evidence.how} (check run by the agent, exit code read from its tool result)${tail ? `\n\n${tail}` : ""}`, "agent_tool_result");
              await api.odysseyJournalAppend({
                odysseyId: view.goal.id,
                kind: "check",
                milestoneId: milestone.id,
                summary: `The agent's own check for milestone ${report.milestone} ${passed ? "passed" : "failed"}`,
                detail: evidence.how,
              });
              if (passed) {
                get().odysseyQueueDelta(sessionId, { kind: "verified", milestone: report.milestone, title: milestone.title, evidence: evidence.how });
              } else {
                get().odysseyQueueDelta(sessionId, {
                  kind: "check_failed",
                  milestone: report.milestone,
                  title: milestone.title,
                  command: evidence.result.command ?? milestone.checkSpec ?? "the check",
                  exitCode: evidence.result.exitCode,
                  tail,
                });
              }
            } else {
              // Nothing is claimed from an unreadable turn; the milestone
              // stays reported and the next tick runs the check here.
              await api.odysseyJournalAppend({
                odysseyId: view.goal.id,
                kind: "check",
                milestoneId: milestone.id,
                summary: `Nothing in the turn's tool results verified milestone ${report.milestone}`,
                detail: evidence.reason,
              });
            }
          }
        } else if (looksLikeQuotaWait(report.note)) {
          // A wait, not a block. The milestone stays as it is, the goal stays
          // running, and the runner holds its next prompt until the time the
          // note names, so nobody has to press Resume on a condition that
          // clears by itself.
          const until = quotaWaitUntil(report.note, Date.now());
          await api.odysseyJournalAppend({
            odysseyId: view.goal.id,
            kind: "guard",
            milestoneId: milestone.id,
            summary: `${QUOTA_WAIT_HOLD}: ${report.note}`,
            detail: `until=${until}\nReported as blocked, read as a wait: the run continues and the next continuation goes out at ${new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`,
          });
          get().announce(`${view.goal.title}: the agent is waiting on a quota; Odyssey resumes it at ${new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
        } else {
          await api.odysseySetMilestoneState(milestone.id, "failed");
          await api.odysseyJournalAppend({ odysseyId: view.goal.id, kind: "report", milestoneId: milestone.id, summary: `Reported milestone ${report.milestone} blocked`, detail: report.note });
          await api.odysseySetState(view.goal.id, "blocked");
        }
      }
    }

    // A decision the agent handed over. Recorded and surfaced; the run does
    // not stop, because the agent named what it does meanwhile.
    const asks = parseAsks(reply);
    for (const ask of asks) {
      await api.odysseyQuestionAdd({ odysseyId: view.goal.id, kind: ask.kind, question: ask.question, options: ask.options, ...(ask.fallback ? { fallback: ask.fallback } : {}) }).catch(() => undefined);
      await api.odysseyJournalAppend({ odysseyId: view.goal.id, kind: "plan", summary: `The agent asked you: ${ask.question}`, detail: ask.fallback ? `Meanwhile: ${ask.fallback}` : null }).catch(() => undefined);
    }
    if (asks.length > 0) {
      await get().odysseyLoadInbox(sessionId, view.goal.id);
      get().announce(`${view.goal.title}: the agent has a question for you`);
      const workspace = session ? get().workspaces.find((w) => w.id === session.workspaceId) : undefined;
      const settings = get().settings;
      if (session && settings && shouldNotify(settings, "needs_input", session.workspaceId)) void notify("needs_input", workspace ? basenameOf(workspace.displayPath) : "a workspace");
    }

    // Task moves are the agent's word about its own tasks, and are recorded
    // as such; the milestone's check is still the only gate. An unknown
    // number is ignored, never guessed at.
    for (const line of parseTaskLines(reply)) {
      const step = view.milestones[line.milestone - 1]?.steps[line.task - 1];
      if (!step) continue;
      await api.odysseySetStepState(step.id, line.status, line.note || undefined).catch(() => undefined);
      if (line.agent) {
        const seen = [...(session?.projection.inspector.agents.values() ?? [])].find((agent) => agent.name === line.agent);
        await api.odysseyAssignStep(step.id, line.agent, seen?.harness ?? null, seen?.model ?? null).catch(() => undefined);
      }
    }
    await get().refreshOdyssey(sessionId, view.goal.id);
    await get().odysseyTick(sessionId);
  },

  /** Called on a timer: moves waiting goals on when their reset time passes. */
  async odysseyPoll() {
    const state = get();
    for (const [sessionId, view] of Object.entries(state.odyssey)) {
      if (!view) continue;
      if (view.goal.state === "running") {
        void get().odysseyTick(sessionId);
        continue;
      }
      if (view.goal.state !== "waiting_usage") continue;
      const runtime = state.odysseyRuntime[sessionId];
      const resumeAt = runtime?.resumeAt ?? null;
      const agent = get().sessionAgent(sessionId);
      // The sample the goal was parked with says "no room" for ever, so the
      // decision has to be made from a fresh one once the window might be
      // back — deciding from the stale one held the goal past its own reset.
      if (shouldResample({ usage: get().usageFor(agent), resumeAt, now: Date.now() })) {
        await get().refreshUsage(agent);
      }
      const confirmed = resumeDecision({ goal: view.goal, usage: get().usageFor(agent), resumeAt, now: Date.now(), unsampledMeansRoom: agent === "claude" });
      if (confirmed.action === "hold") continue;
      if (confirmed.action === "resume") {
        await api.odysseyJournalAppend({ odysseyId: view.goal.id, kind: "resume", summary: confirmed.reason });
        get().odysseyQueueDelta(sessionId, { kind: "resumed", waitedMs: Date.now() - (resumeAt ?? Date.now()), checkpointFiles: null });
        await get().odysseyStart(sessionId);
      } else {
        await api.odysseySetState(view.goal.id, "paused");
        await api.odysseyJournalAppend({ odysseyId: view.goal.id, kind: "resume", summary: confirmed.reason });
        await get().refreshOdyssey(sessionId, view.goal.id);
        if (confirmed.action === "notify") get().announce(`${view.goal.title}: usage reset, ready to resume`);
      }
    }
  },

  /**
   * Reads the plan the model just proposed and writes it into the record.
   *
   * The goal stays a draft: a plan that came out of a document has not been
   * approved by anyone yet, and the checks in it are commands Odyssey would
   * run, so Start is the user's to press.
   */
  async odysseyReadPlanReply(sessionId) {
    const view = get().odyssey[sessionId];
    if (!view) return;
    const plan = parsePlan(lastAgentText(get().sessions[sessionId]));
    if (!plan) {
      await api.odysseyJournalAppend({
        odysseyId: view.goal.id,
        kind: "plan",
        summary: "The agent proposed no plan",
        detail: "Its reply contained no ODYSSEY-PLAN block. Read what it said, then ask again or write the milestones yourself.",
      });
      await get().refreshOdyssey(sessionId, view.goal.id);
      return;
    }

    try {
      for (const proposed of plan.milestones) {
        await api.odysseyAddMilestone({
          odysseyId: view.goal.id,
          title: proposed.title,
          detail: proposed.detail,
          checkKind: proposed.checkKind,
          checkSpec: proposed.checkSpec,
          section: proposed.section,
        });
      }
      await get().refreshOdyssey(sessionId, view.goal.id);
      // Steps need the ids the writes just produced, so they go in a second
      // pass over the refreshed record.
      const created = get().odyssey[sessionId]?.milestones ?? [];
      for (const [index, proposed] of plan.milestones.entries()) {
        const milestone = created[index];
        if (!milestone) continue;
        await createTasks(milestone.id, proposed.steps, []);
      }
      await api.odysseyJournalAppend({
        odysseyId: view.goal.id,
        kind: "plan",
        summary: `The agent proposed ${plan.milestones.length} milestone${plan.milestones.length === 1 ? "" : "s"} from ${view.goal.planSource ?? "the document"}`,
        detail: plan.notes.join(" ") || null,
      });
      await get().refreshOdyssey(sessionId, view.goal.id);
      get().announce(`${view.goal.title}: the agent proposed ${plan.milestones.length} milestones — review them and start the run`);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  /**
   * Queues something for the model to fold into a goal that is already
   * running (docs/plans/odyssey.md §3.2).
   *
   * Queued, never submitted here: the session is usually mid-turn, and a
   * second prompt would be refused. The runner carries it on its next prompt
   * and the model decides where it belongs — which is the point, because it
   * knows the plan and what it is halfway through.
   */
  async odysseyAddAmendment(sessionId, request) {
    const view = get().odyssey[sessionId];
    if (!view) return;
    try {
      await api.odysseyAmendAdd(request);
      await api.odysseyJournalAppend({
        odysseyId: view.goal.id,
        kind: "plan",
        summary: "You asked for a change to the plan",
        detail: [request.note, ...request.refs.map((reference) => `${reference.path} (${reference.kind}, ${reference.detail})`)].join("\n"),
      });
      await get().odysseyLoadAmendments(sessionId, view.goal.id);
      await get().refreshOdyssey(sessionId, view.goal.id);
      // If the session happens to be free, it goes out now rather than waiting
      // for the heartbeat; if it is busy, the next continuation carries it.
      if (view.goal.state === "running") void get().odysseyTick(sessionId);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  /**
   * Applies the amendment block from a reply, if there is one.
   *
   * Targets are resolved against the list as it stood *before* anything is
   * applied, so an insert in the middle cannot shift the numbers the model
   * meant. Verified milestones are refused: a check ran or the user ticked it,
   * and rewriting that is not an amendment, it is a loss. Every operation —
   * including every refusal — leaves a journal row.
   */
  async odysseyApplyAmendment(sessionId, reply) {
    const view = get().odyssey[sessionId];
    if (!view) return;
    const amendment = parseAmendment(reply);
    if (!amendment) return;
    const reason = amendment.ops.map((op) => ("reason" in op ? op.reason : "")).find(Boolean) ?? null;

    // What lands now and what waits. Under the default, only changes to what
    // a milestone is — added, dropped, retitled, its check changed — are the
    // user's decision; how the agent cuts its own work into tasks is not.
    const mode = view.goal.onPlanChange;
    const heldOps = mode === "auto" ? [] : mode === "review" ? amendment.ops : amendment.ops.filter(isMilestoneScope);
    const autoOps = amendment.ops.filter((op) => !heldOps.includes(op));

    if (autoOps.length > 0) {
      const resolved = resolveOps(autoOps, view.milestones);
      const summary = diffText(planDiff(resolved));
      // Applied at once; the diff is still recorded so it can be read after.
      await api.odysseyPlanChangeAdd({ odysseyId: view.goal.id, ops: JSON.stringify(autoOps), summary, reason, state: "applied" }).catch(() => undefined);
      await applyResolvedOps(get, set, sessionId, view, resolved, heldOps.length > 0 ? [] : amendment.notes);
      await get().odysseyLoadInbox(sessionId, view.goal.id);
    }
    if (heldOps.length === 0) return;

    const held = get().odyssey[sessionId] ?? view;
    const resolved = resolveOps(heldOps, held.milestones);
    const summary = diffText(planDiff(resolved));

    // Held: the user reads the diff and decides. The agent keeps working to
    // the plan it has, and is told so on its next continuation.
    try {
      // A model that is told its change is waiting tends to send it again
      // next turn, reworded. One decision, not three: the newest proposal
      // stands and the earlier ones are marked superseded.
      for (const prior of (get().odysseyPlanChanges[sessionId] ?? []).filter((record) => record.state === "proposed")) {
        await api.odysseyPlanChangeDecide(prior.id, "rejected", "superseded by a newer proposal from the agent").catch(() => undefined);
      }
      await api.odysseyPlanChangeAdd({ odysseyId: view.goal.id, ops: JSON.stringify(amendment.ops), summary, reason, state: "proposed" });
      await api.odysseyJournalAppend({
        odysseyId: view.goal.id,
        kind: "plan",
        summary: `The agent proposed a plan change: ${resolved.length} operation${resolved.length === 1 ? "" : "s"}, waiting for you`,
        detail: [summary, ...amendment.notes].join("\n"),
      });
      get().odysseyQueueDelta(sessionId, { kind: "plan_change_pending", summary: summary.split("\n").slice(0, 3).join("; ") + (resolved.length > 3 ? "; …" : "") });
      await get().odysseyLoadInbox(sessionId, view.goal.id);
      await get().refreshOdyssey(sessionId, view.goal.id);
      get().announce(`${view.goal.title}: the agent proposed a plan change — review it in the Inbox`);
      const session = get().sessions[sessionId];
      const workspace = session ? get().workspaces.find((w) => w.id === session.workspaceId) : undefined;
      const settings = get().settings;
      if (session && settings && shouldNotify(settings, "needs_input", session.workspaceId)) void notify("needs_input", workspace ? basenameOf(workspace.displayPath) : "a workspace");
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async odysseyDecidePlanChange(sessionId, id, decision, note) {
    const view = get().odyssey[sessionId];
    const change = (get().odysseyPlanChanges[sessionId] ?? []).find((record) => record.id === id);
    if (!view || !change) return;
    try {
      if (decision === "reject") {
        await api.odysseyPlanChangeDecide(id, "rejected", note ?? null);
        await api.odysseyJournalAppend({ odysseyId: view.goal.id, kind: "plan", summary: "You rejected the agent's plan change", detail: [change.summary, note ?? ""].filter(Boolean).join("\n") });
        get().odysseyQueueDelta(sessionId, { kind: "plan_change_rejected", summary: change.summary.split("\n").slice(0, 3).join("; "), note: note?.trim() || null });
      } else {
        // Resolved again now: the plan may have moved since the proposal, and
        // a number that no longer fits is refused rather than applied blind.
        const ops = JSON.parse(change.ops) as AmendOp[];
        const resolved = resolveOps(ops, view.milestones);
        await api.odysseyPlanChangeDecide(id, "applied", note ?? null);
        await applyResolvedOps(get, set, sessionId, view, resolved, []);
      }
      await get().odysseyLoadInbox(sessionId, view.goal.id);
      await get().refreshOdyssey(sessionId, view.goal.id);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async odysseyAnswerQuestion(sessionId, id, answer) {
    const view = get().odyssey[sessionId];
    const question = (get().odysseyQuestions[sessionId] ?? []).find((record) => record.id === id);
    if (!view || !question) return;
    try {
      const trimmed = answer?.trim() || null;
      await api.odysseyQuestionSettle(id, trimmed ? "answered" : "dismissed", trimmed);
      await api.odysseyJournalAppend({
        odysseyId: view.goal.id,
        kind: "plan",
        summary: trimmed ? "You answered the agent's question" : "You dismissed the agent's question",
        detail: `${question.question}\n${trimmed ?? "(no answer: the agent keeps its default)"}`,
      });
      get().odysseyQueueDelta(sessionId, { kind: "question_answered", question: question.question, answer: trimmed });
      await get().odysseyLoadInbox(sessionId, view.goal.id);
      await get().refreshOdyssey(sessionId, view.goal.id);
      // An answer is worth a turn now if the session is free.
      if (view.goal.state === "running") void get().odysseyTick(sessionId);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async odysseyDiscardAmendment(sessionId, id) {
    const view = get().odyssey[sessionId];
    try {
      await api.odysseyAmendSetState(id, "discarded");
      if (view) await get().odysseyLoadAmendments(sessionId, view.goal.id);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async odysseyLoadInbox(sessionId, odysseyId) {
    try {
      const [planChanges, questions] = await Promise.all([api.odysseyPlanChangeList(odysseyId), api.odysseyQuestionList(odysseyId)]);
      set({ odysseyPlanChanges: { ...get().odysseyPlanChanges, [sessionId]: planChanges }, odysseyQuestions: { ...get().odysseyQuestions, [sessionId]: questions } });
    } catch {
      // A missing table on an older build is not an error worth a banner.
    }
  },

  async odysseyLoadAmendments(sessionId, odysseyId) {
    try {
      const list = await api.odysseyAmendList(odysseyId);
      set({ odysseyAmendments: { ...get().odysseyAmendments, [sessionId]: list } });
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  /**
   * Asks the session's model to turn the goal's plan document into milestones
   * (docs/plans/odyssey.md §3.1).
   *
   * This is the only way a document becomes a plan: Odyssey hands over the
   * text and reads the block that comes back. It never parses the document
   * itself, and the goal stays a draft until the user starts it, so a plan
   * that came out of a file is always seen by a human before it runs.
   */
  async odysseyRequestPlan(sessionId) {
    const view = get().odyssey[sessionId];
    const session = get().sessions[sessionId];
    if (!view || !session) return;
    const runtime = get().odysseyRuntime[sessionId];
    if (runtime?.ticking) return;
    if (session.inFlightRequestId || session.projection.foreground === "running") {
      set({ error: asError({ code: "NOT_READY", message: "The session is busy; wait for the current turn to finish.", retry: "poll" }) });
      return;
    }

    setRuntime(get, set, sessionId, { lastReason: "asking the agent to read the plan", lastReasonAt: Date.now(), ticking: true, stalledSince: null, stallNotified: false });
    try {
      const document = await api.odysseyPlanDocument(view.goal.id);
      if (!document) {
        set({ error: asError({ code: "NOT_READY", message: "This goal has no plan document to read.", retry: "user_action" }) });
        return;
      }
      const requestId = crypto.randomUUID();
      set({ sessions: { ...get().sessions, [sessionId]: { ...session, inFlightRequestId: requestId } } });
      const response = await api.sessionSubmit(session.handle, requestId, buildPlanningPrompt({ goal: view.goal, document, source: view.goal.planSource ?? null }));
      clearInFlight(get, set, sessionId);
      if (response.outcome.outcome !== "accepted") {
        set({ error: response.outcome.error });
        return;
      }
      // The request is journalled so the settle that answers it can be
      // recognised after a reload.
      await api.odysseyJournalAppend({ odysseyId: view.goal.id, kind: "plan", summary: PLAN_REQUESTED, detail: view.goal.planSource ?? null });
      await get().refreshOdyssey(sessionId, view.goal.id);
    } catch (error) {
      set({ error: asError(error) });
    } finally {
      clearInFlight(get, set, sessionId);
      setRuntime(get, set, sessionId, { lastReason: "waiting for the agent's plan", lastReasonAt: Date.now(), ticking: false });
    }
  },

  /**
   * Runs a milestone's check here (docs/plans/odyssey.md §5.1, desktop-run).
   *
   * The verdict is the exit code, recorded with the lane that produced it. A
   * pass moves the run on; a failure becomes a delta with the command, the
   * code and a two-line tail, because a model that cannot see why a check
   * failed will just fail it again.
   */
  async odysseyRunCheck(sessionId, milestoneId) {
    const view = get().odyssey[sessionId];
    const session = get().sessions[sessionId];
    if (!view || !session) return;
    const index = view.milestones.findIndex((entry) => entry.id === milestoneId);
    const milestone = view.milestones[index];
    if (!milestone) return;
    if (milestone.checkKind === "manual") {
      set({ error: asError({ code: "UNSUPPORTED", message: "This milestone is verified by you, not by a command.", retry: "user_action" }) });
      return;
    }
    // The agent may be running the same suite in its turn; two Unity runs on
    // one editor collide and fail with a timeout that says nothing about the
    // code. The check waits for the turn to settle.
    if (session.projection.foreground === "running" || session.projection.foreground === "cancelling") {
      set({ error: asError({ code: "NOT_READY", message: "A turn is running; the check would collide with whatever the agent is running. It runs on its own when the turn settles.", retry: "poll" }) });
      return;
    }

    setRuntime(get, set, sessionId, { lastReason: `running the check for milestone ${index + 1}`, lastReasonAt: Date.now(), ticking: true, stalledSince: null, stallNotified: false });
    try {
      const { outcome } = await api.odysseyRunCheck(session.workspaceId, milestoneId);
      await api.odysseyJournalAppend({
        odysseyId: view.goal.id,
        kind: "check",
        milestoneId,
        summary: `Odyssey ran the check for milestone ${index + 1}: ${outcome.passed ? "passed" : "failed"}`,
        detail: outcome.summary,
      });
      if (outcome.passed) {
        get().odysseyQueueDelta(sessionId, { kind: "verified", milestone: index + 1, title: milestone.title, evidence: `${outcome.summary} (check run by Odyssey)` });
      } else {
        get().odysseyQueueDelta(sessionId, {
          kind: "check_failed",
          milestone: index + 1,
          title: milestone.title,
          command: milestone.checkSpec ?? outcome.summary,
          exitCode: outcome.exitCode ?? -1,
          tail: outcome.output.split("\n").filter(Boolean).slice(-2).join("\n"),
        });
      }
      await get().refreshOdyssey(sessionId, view.goal.id);
      // Release the tick guard before starting: the next tick is the point.
      setRuntime(get, set, sessionId, { lastReason: outcome.summary, lastReasonAt: Date.now(), ticking: false });

      // The check ran, so the milestone must have moved to verified or failed.
      // If it is still a bare claim the record did not take the verdict, and
      // continuing would run the same check for ever.
      const settled = get().odyssey[sessionId]?.milestones.find((entry) => entry.id === milestoneId);
      if (settled?.state === "reported") {
        await get().odysseyPause(sessionId, `The check for milestone ${index + 1} ran (${outcome.summary}) but the milestone is still only reported`);
        return;
      }

      // A pass is a stopping point only for a goal set to stop there; a
      // failure is always worth another turn, so the model can fix it.
      if (!outcome.passed || !stopsAfterMilestone(view.goal)) await get().odysseyStart(sessionId);
    } catch (error) {
      set({ error: asError(error) });
      setRuntime(get, set, sessionId, { lastReason: "the check could not be run", lastReasonAt: Date.now(), ticking: false });
    }
  },

  /** The user ticking a manual milestone: the user is the evidence. */
  async odysseyVerifyManually(sessionId, milestoneId) {
    const view = get().odyssey[sessionId];
    if (!view) return;
    try {
      await api.odysseyRecordCheck(milestoneId, true, "ticked by you", "user");
      const index = view.milestones.findIndex((milestone) => milestone.id === milestoneId);
      await api.odysseyJournalAppend({ odysseyId: view.goal.id, kind: "check", milestoneId, summary: `You verified milestone ${index + 1}` });
      get().odysseyQueueDelta(sessionId, { kind: "verified", milestone: index + 1, title: view.milestones[index]?.title ?? "", evidence: "you ticked it" });
      await get().refreshOdyssey(sessionId, view.goal.id);
      // A goal set to stop after each milestone waits for the user to start it.
      if (!stopsAfterMilestone(view.goal)) await get().odysseyStart(sessionId);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  /**
   * Closes out work the runtime never reported finishing.
   *
   * A subagent or child call leaves the inspector only when the runtime says
   * it ended. A process that is killed or dies with its provider never sends
   * that, so the node stays `working` and the activity strip reports it for
   * ever. The projection is a presentation cache (ADR-06), not history, so
   * correcting it here loses nothing: the agent's transcript is untouched, and a
   * `refreshSnapshot` would rebuild whatever the runtime still believes.
   */
  clearStaleActivity(sessionId) {
    const session = get().sessions[sessionId];
    if (!session) return;
    const { inspector, detached } = session.projection;
    const now = Date.now();
    for (const [id, agent] of inspector.agents) {
      if (agent.status === "working" || agent.status === "starting") {
        inspector.agents.set(id, { ...agent, status: "idle", outcome: null, generationFinishedAtUnixMs: now });
      }
    }
    for (const [call, state] of detached) {
      if (state === "active" || state === "cancellation_requested") detached.set(call, "completed");
    }
    set({ sessions: { ...get().sessions, [sessionId]: { ...session, projection: { ...session.projection } } } });
  },

  /** Queues a state change to tell the model in the next continuation. */
  odysseyQueueDelta(sessionId, delta) {
    const current = get().odysseyPendingDeltas[sessionId] ?? [];
    // Eight is more than a turn's worth; older ones have been superseded.
    set({ odysseyPendingDeltas: { ...get().odysseyPendingDeltas, [sessionId]: [...current, delta].slice(-8) } });
  },

  /** The deltas for the next continuation, plus a budget warning near the end. */
  odysseyDeltas(sessionId) {
    const view = get().odyssey[sessionId];
    const pending = get().odysseyPendingDeltas[sessionId] ?? [];
    if (!view) return pending;
    const left = continuationsLeft(view.goal);
    // Only near the ceiling: a running count every turn would be noise.
    return left > 0 && left <= 3 ? [...pending, { kind: "budget" as const, continuationsLeft: left }] : pending;
  },

  /**
   * Records what the working tree looks like now, and returns the progress
   * fingerprint the no-progress guard compares (§4.4). Stored in the journal,
   * so the guard survives a reload.
   */
  async odysseyCheckpoint(sessionId, milestoneId) {
    const view = get().odyssey[sessionId];
    const session = get().sessions[sessionId];
    if (!view || !session) return null;
    try {
      // The tree now against the tree at the previous checkpoint — what this
      // turn changed — not a cumulative diff against the session's baseline,
      // which saturated at the review cap and read "2000 files" for
      // sixty-three turns (docs/research/odyssey-review.md §1.4).
      const checkpoint = await api.odysseyCheckpoint(session.workspaceId, view.goal.id);
      const fingerprint = progressFingerprint({
        treeHash: checkpoint.treeHash,
        milestoneStates: view.milestones.map((milestone) => milestone.state),
        stepStates: view.milestones.flatMap((milestone) => milestone.steps.map((step) => step.state)),
      });
      const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
      const summary = checkpoint.first
        ? `first checkpoint · ${plural(checkpoint.fileCount, "file")} in the tree`
        : checkpoint.changed === 0
          ? "nothing changed since the last checkpoint"
          : `${plural(checkpoint.changed, "file")} changed · +${checkpoint.additions} −${checkpoint.deletions}${checkpoint.truncated ? " · list cut" : ""}`;
      await api.odysseyJournalAppend({
        odysseyId: view.goal.id,
        kind: "checkpoint",
        milestoneId,
        summary,
        detail: checkpointDetail(
          fingerprint,
          checkpoint.files.map((file) => file.path),
        ),
      });
      return fingerprint;
    } catch {
      // A workspace that cannot be captured still gets a run; it just has no
      // checkpoint to show, and the guard has nothing to compare.
      return null;
    }
  },

  /** Paid input plus output for this session, from the agent's own transcript. */
  async odysseySessionTokens(sessionId) {
    const session = get().sessions[sessionId];
    const agentSessionId = session?.snapshot.agentSessionId;
    if (!session || !agentSessionId) return null;
    try {
      const usage = await api.sessionTokenUsage(session.workspaceId, agentSessionId);
      return usage.totals.paidInputTokens + usage.totals.outputTokens;
    } catch {
      return null;
    }
  },

  /** The session's token total when the goal was briefed, from the journal. */
  odysseyStartTokens(sessionId) {
    const view = get().odyssey[sessionId];
    const briefing = view?.journal.find((entry) => entry.kind === "briefing" && entry.detail);
    if (!briefing?.detail) return null;
    try {
      const parsed = JSON.parse(briefing.detail) as { startTokens?: unknown };
      return typeof parsed.startTokens === "number" ? parsed.startTokens : null;
    } catch {
      return null;
    }
  },

  async odysseyRefreshNotes(sessionId) {
    const session = get().sessions[sessionId];
    if (!session) return;
    const notes = await api.odysseyWorkspaceNotes(session.workspaceId).catch(() => null);
    set({ odysseyNotes: { ...get().odysseyNotes, [sessionId]: notes } });
  },

  /**
   * One reading per goal that is running or parked: the account's windows as
   * just fetched, and the session's cumulative token counters from the agent's
   * transcript at the same moment. Differenced later, these say what the
   * window charges (docs/research/odyssey-review.md §4.1). A reading that
   * cannot be taken is dropped: it is evidence, never a decision.
   */
  async odysseyRecordUsageSamples(snapshot) {
    for (const [sessionId, view] of Object.entries(get().odyssey)) {
      if (!view || (view.goal.state !== "running" && view.goal.state !== "waiting_usage")) continue;
      const session = get().sessions[sessionId];
      const agentSessionId = session?.snapshot.agentSessionId;
      if (!session || !agentSessionId) continue;
      // The percentages are the OpenAI account's. A goal running on Claude
      // spends a different subscription, so pairing its token counters with
      // these windows would fit a spend model out of two unrelated series
      // (docs/plans/odyssey-second-orchestrator.md §2.6). Its tokens are
      // still recorded; the windows are left empty until something on that
      // side reports a percentage.
      const windows = get().sessionAgent(sessionId) === "claude" ? null : snapshot;
      try {
        const { totals } = await api.sessionTokenUsage(session.workspaceId, agentSessionId);
        await api.odysseyUsageSampleAdd({
          odysseyId: view.goal.id,
          ...(windows?.primary ? { primaryUsedPercent: windows.primary.usedPercent } : {}),
          ...(windows?.primary?.resetAtUnix !== undefined ? { primaryResetAt: windows.primary.resetAtUnix } : {}),
          ...(windows?.secondary ? { secondaryUsedPercent: windows.secondary.usedPercent } : {}),
          ...(windows?.secondary?.resetAtUnix !== undefined ? { secondaryResetAt: windows.secondary.resetAtUnix } : {}),
          calls: totals.calls,
          paidInputTokens: totals.paidInputTokens,
          cachedInputTokens: totals.cachedInputTokens,
          outputTokens: totals.outputTokens,
          reasoningTokens: totals.reasoningTokens,
        });
      } catch {
        // Nothing to do: the next reading is a minute away.
      }
    }
  },

  /** Re-reads one goal by id after a write, so the screen shows the record. */
  async refreshOdyssey(sessionId, id) {
    const view = await api.odysseyView(id);
    set({ odyssey: { ...get().odyssey, [sessionId]: view } });
  },

  async pinSession(workspaceId, agentSessionId, pinned) {
    try {
      await api.sessionPin(workspaceId, agentSessionId, pinned);
      await get().loadRecords(workspaceId);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  setShowHidden(show) {
    set({ showHidden: show });
  },

  /**
   * Rebuilds live sessions from the supervisor after a renderer reload
   * (REC-04): snapshot + retained history, then the live stream. Nothing is
   * re-sent; the supervisor's event log is the only source.
   */
  async rehydrate() {
    let open: Awaited<ReturnType<typeof api.sessionListOpen>> = [];
    try {
      open = await api.sessionListOpen();
    } catch {
      return;
    }
    for (const entry of open) {
      if (get().sessions[entry.handle.id]) continue;
      const workspaceId = entry.workspaceId ?? get().workspaces.find((w) => w.canonicalRoot === entry.root)?.id;
      if (!workspaceId) continue;
      try {
        await attachLive(get, set, entry.handle, workspaceId, false);
      } catch (error) {
        set({ error: asError(error) });
      }
    }
  },

  async loadOutbox(workspaceId) {
    try {
      const entries = await api.outboxList(workspaceId);
      set({ outbox: { ...get().outbox, [workspaceId]: entries } });
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async discardOutbox(workspaceId, requestId) {
    try {
      await api.outboxResolve(requestId, "discarded by user");
      await get().loadOutbox(workspaceId);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  /**
   * Explicit resend of an uncertain submission: a new request id is used and
   * the old entry is closed with a pointer to it (V08: never automatic).
   */
  async resendOutbox(workspaceId, entry) {
    const target = Object.values(get().sessions).find((s) => s.workspaceId === workspaceId && s.snapshot.agentSessionId === entry.agentSessionId);
    if (!target || entry.text === null) {
      set({ error: { code: "NOT_READY", message: "Resume the session this prompt belonged to before resending it.", retry: "user_action" } });
      return;
    }
    const requestId = crypto.randomUUID();
    try {
      const response = await api.sessionSubmit(target.handle, requestId, entry.text);
      if (response.outcome.outcome === "accepted") {
        await api.outboxResolve(entry.record.requestId, `resent as ${requestId}`);
      } else {
        set({ error: response.outcome.error });
      }
      await get().loadOutbox(workspaceId);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  dismissLockedResume() {
    set({ lockedResume: null });
  },

  setError(error) {
    set({ error: asError(error) });
  },

  addAttachments(sessionId, snapshots) {
    const current = get().attachments[sessionId] ?? [];
    const merged = [...current];
    for (const snapshot of snapshots) if (!merged.some((a) => a.id === snapshot.id)) merged.push(snapshot);
    if (merged.length > 8) {
      set({ error: { code: "LIMIT_EXCEEDED", message: "At most eight attachments per prompt.", retry: "user_action" } });
      return;
    }
    set({ attachments: { ...get().attachments, [sessionId]: merged } });
  },

  removeAttachment(sessionId, id) {
    set({ attachments: { ...get().attachments, [sessionId]: (get().attachments[sessionId] ?? []).filter((a) => a.id !== id) } });
  },

  addMention(sessionId, mention) {
    const current = get().mentions[sessionId] ?? [];
    if (current.some((m) => m.relativePath === mention.relativePath && JSON.stringify(m.mode) === JSON.stringify(mention.mode))) return;
    set({ mentions: { ...get().mentions, [sessionId]: [...current, mention] } });
  },

  updateMention(sessionId, index, mention) {
    const current = [...(get().mentions[sessionId] ?? [])];
    if (!current[index]) return;
    current[index] = mention;
    set({ mentions: { ...get().mentions, [sessionId]: current } });
  },

  removeMention(sessionId, index) {
    set({ mentions: { ...get().mentions, [sessionId]: (get().mentions[sessionId] ?? []).filter((_, i) => i !== index) } });
  },

  async loadContextBundles(workspaceId) {
    try {
      const bundles = (await api.prefGet<ContextBundle[]>(`context_bundles:${workspaceId}`)) ?? [];
      set({ contextBundles: { ...get().contextBundles, [workspaceId]: bundles } });
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async saveContextBundle(workspaceId, bundle) {
    const next = [...(get().contextBundles[workspaceId] ?? []).filter((b) => b.id !== bundle.id), bundle];
    try {
      await api.prefSet(`context_bundles:${workspaceId}`, next);
      set({ contextBundles: { ...get().contextBundles, [workspaceId]: next } });
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async deleteContextBundle(workspaceId, id) {
    const next = (get().contextBundles[workspaceId] ?? []).filter((b) => b.id !== id);
    try {
      await api.prefSet(`context_bundles:${workspaceId}`, next);
      set({ contextBundles: { ...get().contextBundles, [workspaceId]: next } });
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  applyContextBundle(sessionId, bundle) {
    for (const ref of bundle.refs) get().addMention(sessionId, ref);
    if (bundle.instructions.trim()) {
      const draft = get().drafts[sessionId] ?? "";
      set({ drafts: { ...get().drafts, [sessionId]: draft ? `${draft}\n${bundle.instructions}` : bundle.instructions } });
    }
    set({ sessionTab: "transcript" });
    get().focusComposer();
  },

  setPaletteOpen(open) {
    set({ paletteOpen: open });
  },

  setSessionTab(tab) {
    set({ sessionTab: tab });
  },

  setTranscriptSearchOpen(open) {
    set({ transcriptSearchOpen: open, sessionTab: open ? "transcript" : get().sessionTab });
  },

  toggleSidebar() {
    set({ sidebarCollapsed: !get().sidebarCollapsed });
  },

  announce(text) {
    // Re-announce identical text by toggling a trailing space.
    set({ announcement: get().announcement === text ? `${text} ` : text });
  },

  async loadUiPrefs() {
    try {
      const stored = await api.prefGet<Partial<UiPrefs>>("ui_prefs");
      if (stored) set({ uiPrefs: { ...DEFAULT_UI_PREFS, ...stored } });
      const defaults = await api.prefGet<SessionDefaults>("session_defaults");
      if (defaults) set({ sessionDefaults: defaults });
    } catch {
      // Preferences are optional conveniences.
    }
  },

  async removeWorkspace(workspaceId) {
    try {
      await api.workspaceRemove(workspaceId);
      const view = get().view;
      const leaving = (view.kind === "workspace" && view.workspaceId === workspaceId) || (view.kind === "session" && get().sessions[view.sessionId]?.workspaceId === workspaceId);
      const strip = <T>(record: Record<string, T>) => {
        const next = { ...record };
        delete next[workspaceId];
        return next;
      };
      set({
        workspaces: get().workspaces.filter((w) => w.id !== workspaceId),
        inspections: strip(get().inspections),
        records: strip(get().records),
        outbox: strip(get().outbox),
        contextBundles: strip(get().contextBundles),
        ...(leaving ? { view: { kind: "welcome" } as View } : {}),
      });
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async resetSessionDefaults() {
    set({ sessionDefaults: {} });
    try {
      await api.prefSet("session_defaults", {});
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  noteImageFiles(sessionId, files, initial) {
    const seen = new Set(get().seenImageFiles[sessionId] ?? []);
    const fresh = files.filter((f) => !seen.has(f));
    if (fresh.length === 0) return;
    for (const f of fresh) seen.add(f);
    const observed = initial ? (get().observedImages[sessionId] ?? []) : [...(get().observedImages[sessionId] ?? []), ...fresh];
    set({ seenImageFiles: { ...get().seenImageFiles, [sessionId]: [...seen] }, observedImages: { ...get().observedImages, [sessionId]: observed } });
  },

  async setUiPrefs(patch) {
    const next = { ...get().uiPrefs, ...patch };
    set({ uiPrefs: next });
    try {
      await api.prefSet("ui_prefs", next);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async exportTranscript(sessionId) {
    const session = get().sessions[sessionId];
    if (!session) return;
    const lines: string[] = [`# Session ${sessionTitle(session)}`, "", `${PROVIDER_LABELS[session.snapshot.provider]} session id: ${session.snapshot.agentSessionId ?? session.handle.id}`, ""];
    for (const card of session.projection.cards) {
      if (card.kind === "message") {
        lines.push(`## ${card.message.role}`, "");
        for (const block of card.message.blocks) {
          if (block.type === "text") lines.push(block.text, "");
          else if (block.type === "resource_link") lines.push(`- reference: ${block.uri}`, "");
          else lines.push(`- ${block.type} block omitted`, "");
        }
      } else if (card.kind === "tool") {
        const patch = session.projection.toolCalls.get(card.toolCallId);
        lines.push(`- tool ${patch?.title ?? card.toolCallId} (${patch?.status ?? "no status"})`, "");
      } else if (card.kind === "notice") lines.push(`> ${card.title} ${card.description ?? ""}`, "");
      else if (card.kind === "turn" || card.kind === "runtime" || card.kind === "compaction") lines.push(`_${card.text}_`, "");
    }
    try {
      await api.saveTextFile(`transcript-${session.handle.id.slice(0, 12)}.md`, lines.join("\n"));
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async openSession(workspaceId, mode, provider) {
    // Which program wrote this session decides which one can resume it. The
    // record knows, and the native side reads it again on a resume: launching
    // one provider against another's session id would ask the wrong program
    // for a session it has never heard of.
    const recorded = mode.mode === "resume" ? (get().records[workspaceId] ?? []).find((record) => record.agentSessionId === mode.session_id)?.provider : undefined;
    const defaults = get().sessionDefaults;
    // A new session with no provider asked for starts from the default
    // preset, when there is one: its orchestrator and its workers.
    const preset = mode.mode === "new" && !provider ? get().teamPresets.find((entry) => entry.id === get().defaultPresetId) : undefined;
    if (preset) return get().openSessionWithPreset(workspaceId, preset);
    // A session the app is already running — a worker a delegation opened —
    // is shown, not resumed: a second process on the same session is refused
    // by the agent, and would compete with the first one if it were not.
    if (mode.mode === "resume") {
      const live = Object.values(get().sessions).find((session) => session.snapshot.agentSessionId === mode.session_id);
      if (live) return get().selectSession(live.handle.id);
      try {
        const running = (await api.sessionListOpen()).find((entry) => entry.agentSessionId === mode.session_id);
        if (running) {
          await attachLive(get, set, running.handle, workspaceId, true);
          return;
        }
      } catch {
        // Fall through to an ordinary resume.
      }
    }
    const chosen: Provider = recorded ?? provider ?? defaults.provider ?? "claude";
    set({ busy: mode.mode === "new" ? `Starting ${PROVIDER_LABELS[chosen]}` : `Resuming ${PROVIDER_LABELS[chosen]} session`, error: null, lockedResume: null });
    try {
      const opened = await api.sessionOpen({ workspaceId, mode, provider: chosen, ...launchDefaults(defaults, chosen) });
      await attachLive(get, set, opened.handle, workspaceId, true);
    } catch (error) {
      const desktopError = asError(error);
      if (mode.mode === "resume" && desktopError.code === "LOCKED") {
        set({ lockedResume: { workspaceId, sessionId: mode.session_id, error: desktopError } });
      }
      // A resume can retire the row (a session with no transcript); the list
      // should show that at once.
      if (mode.mode === "resume") void get().loadRecords(workspaceId);
      set({ error: desktopError });
    } finally {
      set({ busy: null });
    }
  },

  /**
   * Opens a fresh session on a named provider, for a caller that then has to
   * address it — the run moving to a new orchestrator, rather than a person
   * starting work.
   */
  async openSessionFor(workspaceId, provider) {
    try {
      const opened = await api.sessionOpen({ workspaceId, mode: { mode: "new" }, provider, ...launchDefaults(get().sessionDefaults, provider) });
      await attachLive(get, set, opened.handle, workspaceId, false);
      const live = get().sessions[opened.handle.id];
      const agentSessionId = live?.snapshot.agentSessionId ?? opened.snapshot.agentSessionId ?? null;
      return agentSessionId ? { key: opened.handle.id, agentSessionId } : null;
    } catch (error) {
      set({ error: asError(error) });
      return null;
    }
  },

  async loadTeam(sessionId) {
    const session = get().sessions[sessionId];
    if (!session) return;
    try {
      const [combo, jobs] = await Promise.all([api.delegationComboGet(session.handle), api.delegationJobs(session.handle)]);
      set({
        teams: combo ? { ...get().teams, [sessionId]: combo } : get().teams,
        jobs: { ...get().jobs, [sessionId]: jobs },
      });
    } catch {
      // A worker session, or delegation unavailable: no team to show.
    }
  },

  async saveTeam(sessionId, combo) {
    const session = get().sessions[sessionId];
    if (!session) return;
    try {
      const saved = await api.delegationComboSet(session.handle, combo);
      set({ teams: { ...get().teams, [sessionId]: saved } });
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async loadDefaultCombo() {
    try {
      set({ defaultCombo: await api.delegationDefaultComboGet() });
    } catch {
      // Keeps the empty team.
    }
  },

  async saveDefaultCombo(combo) {
    try {
      set({ defaultCombo: await api.delegationDefaultComboSet(combo) });
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async loadProviderModels(provider) {
    const known = get().providerModels[provider];
    if (known) return known;
    try {
      const models = await api.providerModels(provider);
      set({ providerModels: { ...get().providerModels, [provider]: models } });
      return models;
    } catch {
      return [];
    }
  },

  noteJob(job) {
    const previous = get().jobs[job.orchestrator]?.find((existing) => existing.id === job.id);
    set({ jobs: { ...get().jobs, [job.orchestrator]: upsertJob(get().jobs[job.orchestrator], job) } });
    // A new worker session has a row now: the sidebar shows it under its
    // orchestrator.
    if (job.workerSession && previous?.workerSession !== job.workerSession) {
      const workspaceId = get().sessions[job.orchestrator]?.workspaceId;
      if (workspaceId) {
        void get().loadRecords(workspaceId);
        // Attached in the background, so its row is live and opening it
        // shows the running worker rather than trying to resume it.
        const handleId = job.workerSession;
        if (!get().sessions[handleId]) {
          void api
            .sessionListOpen()
            .then((open) => open.find((entry) => entry.handle.id === handleId))
            .then((entry) => (entry && !get().sessions[handleId] ? attachLive(get, set, entry.handle, workspaceId, false) : undefined))
            .catch(() => undefined);
        }
      }
    }
  },

  async cancelJob(sessionId, jobId) {
    const session = get().sessions[sessionId];
    if (!session) return;
    try {
      get().noteJob(await api.delegationJobCancel(session.handle, jobId));
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async retryJob(sessionId, jobId) {
    const session = get().sessions[sessionId];
    if (!session) return;
    try {
      get().noteJob(await api.delegationJobRetry(session.handle, jobId));
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async openWorker(job) {
    const handleId = job.workerSession;
    if (!handleId) return;
    if (!get().sessions[handleId]) {
      try {
        const entry = (await api.sessionListOpen()).find((open) => open.handle.id === handleId);
        const workspaceId = get().sessions[job.orchestrator]?.workspaceId ?? entry?.workspaceId ?? undefined;
        if (!entry || !workspaceId) {
          set({ error: { code: "NOT_READY", message: "This worker has stopped. Its transcript is in the sidebar under its orchestrator.", retry: "user_action" } });
          return;
        }
        await attachLive(get, set, entry.handle, workspaceId, true);
        return;
      } catch (error) {
        set({ error: asError(error) });
        return;
      }
    }
    get().selectSession(handleId);
  },

  async handOff(sessionId, provider, preset) {
    const session = get().sessions[sessionId];
    if (!session) return;
    const brief = handoffBrief(session.projection.cards, session.snapshot.provider);
    const team = preset?.combo ?? get().teams[sessionId];
    let key: string;
    if (preset) {
      try {
        const opened = await api.sessionOpen({
          workspaceId: session.workspaceId,
          mode: { mode: "new" },
          provider: preset.orchestrator.provider,
          ...(preset.orchestrator.model ? { model: preset.orchestrator.model } : {}),
          ...(preset.orchestrator.effort ? { reasoningEffort: preset.orchestrator.effort } : {}),
          combo: preset.combo,
        });
        await attachLive(get, set, opened.handle, session.workspaceId, false);
        key = opened.handle.id;
      } catch (error) {
        set({ error: asError(error) });
        return;
      }
    } else {
      const opened = await get().openSessionFor(session.workspaceId, provider);
      if (!opened) return;
      key = opened.key;
      if (team) await get().saveTeam(key, team);
    }
    set({ drafts: { ...get().drafts, [key]: brief } });
    get().selectSession(key);
  },

  async loadTeamPresets() {
    try {
      const [presets, defaultId] = await Promise.all([api.prefGet<unknown>(TEAM_PRESETS_KEY), api.prefGet<string>(DEFAULT_PRESET_KEY)]);
      const list = readPresets(presets);
      set({ teamPresets: list, defaultPresetId: list.some((preset) => preset.id === defaultId) ? (defaultId as string) : null });
    } catch {
      // No presets yet.
    }
  },

  async saveTeamPreset(preset) {
    const saved = { ...preset, name: preset.name.trim() || "Team", updatedAt: Date.now() };
    const list = upsertPreset(get().teamPresets, saved);
    try {
      await api.prefSet(TEAM_PRESETS_KEY, list);
      set({ teamPresets: list });
      // The default preset's workers are what the host starts a session with.
      if (get().defaultPresetId === saved.id) await get().saveDefaultCombo(saved.combo);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async deleteTeamPreset(id) {
    const list = get().teamPresets.filter((preset) => preset.id !== id);
    try {
      await api.prefSet(TEAM_PRESETS_KEY, list);
      set({ teamPresets: list });
      if (get().defaultPresetId === id) await get().setDefaultPreset(null);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async setDefaultPreset(id) {
    const preset = get().teamPresets.find((entry) => entry.id === id) ?? null;
    try {
      await api.prefSet(DEFAULT_PRESET_KEY, preset ? preset.id : null);
      set({ defaultPresetId: preset ? preset.id : null });
      await get().saveDefaultCombo(preset ? preset.combo : EMPTY_COMBO);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async openSessionWithPreset(workspaceId, preset) {
    const { provider, model, effort } = preset.orchestrator;
    set({ busy: `Starting ${preset.name}`, error: null });
    try {
      const opened = await api.sessionOpen({
        workspaceId,
        mode: { mode: "new" },
        provider,
        ...(model ? { model } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
        combo: preset.combo,
      });
      await attachLive(get, set, opened.handle, workspaceId, true);
    } catch (error) {
      set({ error: asError(error) });
    } finally {
      set({ busy: null });
    }
  },

  async applyPresetToSession(sessionId, preset) {
    const session = get().sessions[sessionId];
    if (!session) return "applied";
    if (preset.orchestrator.provider !== session.snapshot.provider) return "needs_handoff";
    await get().saveTeam(sessionId, preset.combo);
    const options = asConfigOptions(session.snapshot.configOptions);
    const model = options.find((option) => option.configId === "model");
    const effort = options.find((option) => isEffortOption(option.configId));
    if (preset.orchestrator.model && model && model.currentValue !== preset.orchestrator.model) {
      await get().setConfigOption(sessionId, model.configId, preset.orchestrator.model);
    }
    if (preset.orchestrator.effort && effort && effort.currentValue !== preset.orchestrator.effort) {
      await get().setConfigOption(sessionId, effort.configId, preset.orchestrator.effort);
    }
    return "applied";
  },

  selectSession(sessionId) {
    if (!get().sessions[sessionId]) return;
    set({ sessionTab: "transcript", transcriptSearchOpen: false });
    get().setView({ kind: "session", sessionId });
    get().focusComposer();
  },

  setDraft(sessionId, draft) {
    set({ drafts: { ...get().drafts, [sessionId]: draft } });
  },

  async send(sessionId) {
    const session = get().sessions[sessionId];
    const draft = get().drafts[sessionId] ?? "";
    const attachments = get().attachments[sessionId] ?? [];
    const mentions = get().mentions[sessionId] ?? [];
    if (!session || (!draft.trim() && attachments.length === 0 && mentions.length === 0) || session.inFlightRequestId) return;
    const requestId = crypto.randomUUID();
    set({ sessions: { ...get().sessions, [sessionId]: { ...session, inFlightRequestId: requestId } }, error: null });
    try {
      const response = await api.sessionSubmit(
        session.handle,
        requestId,
        draft,
        attachments.map((a) => a.id),
        mentions,
      );
      if (response.outcome.outcome === "accepted") {
        set({
          drafts: { ...get().drafts, [sessionId]: "" },
          attachments: { ...get().attachments, [sessionId]: [] },
          mentions: { ...get().mentions, [sessionId]: [] },
        });
      } else {
        // Rejected or uncertain: draft, attachments and mentions are preserved
        // so nothing the user assembled is lost.
        set({ error: response.outcome.error });
      }
    } catch (error) {
      set({ error: asError(error) });
    } finally {
      const current = get().sessions[sessionId];
      if (current) set({ sessions: { ...get().sessions, [sessionId]: { ...current, inFlightRequestId: null } } });
    }
  },

  async steer(sessionId) {
    const session = get().sessions[sessionId];
    const draft = get().drafts[sessionId] ?? "";
    if (!session || !draft.trim() || session.steerInFlight) return;
    set({ sessions: { ...get().sessions, [sessionId]: { ...session, steerInFlight: true } }, error: null });
    try {
      const outcome = await api.sessionSteer(session.handle, draft);
      if (outcome.outcome === "accepted") set({ drafts: { ...get().drafts, [sessionId]: "" } });
      else set({ error: outcome.error });
    } catch (error) {
      set({ error: asError(error) });
    } finally {
      const current = get().sessions[sessionId];
      if (current) set({ sessions: { ...get().sessions, [sessionId]: { ...current, steerInFlight: false } } });
    }
  },

  async cancel(sessionId) {
    const session = get().sessions[sessionId];
    if (!session) return;
    try {
      await api.sessionCancel(session.handle);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async stop(sessionId) {
    const session = get().sessions[sessionId];
    if (!session) return;
    const detached = [...session.projection.detached.values()].filter((s) => s === "active" || s === "cancellation_requested").length;
    const running = session.projection.foreground === "running" || session.projection.foreground === "awaiting_user" || session.projection.autonomous.size > 0;
    // Subagents die with the process and nothing resumes them; only what they
    // wrote to disk survives. The dialog says so before the user does it.
    const agents = [...session.projection.inspector.agents.values()].filter((agent) => agent.status === "working" || agent.status === "starting").length;
    if (running || detached > 0 || agents > 0) {
      const parts = [];
      if (running) parts.push("a turn is still running");
      if (agents > 0) parts.push(`${agents} subagent${agents === 1 ? " is" : "s are"} still working and will be killed with it (only what they wrote to docs/odyssey/agents/ survives)`);
      if (detached > 0) parts.push(`${detached} detached background call(s) are active`);
      let confirmed = false;
      try {
        confirmed = await api.confirmDialog({
          title: "Stop this session?",
          message: `Stopping shuts down this agent: ${parts.join(" and ")}. It will be asked to cancel first; remote side effects already in flight cannot be undone. The durable transcript stays on disk and can be resumed.`,
          okLabel: "Stop session",
          cancelLabel: "Keep running",
          warning: true,
        });
      } catch (error) {
        set({ error: asError(error) });
        return;
      }
      if (!confirmed) return;
    }
    set({ busy: "Stopping session" });
    try {
      await api.sessionStop(session.handle);
      const { [sessionId]: _removed, ...rest } = get().sessions;
      const order = get().sessionOrder.filter((s) => s !== sessionId);
      const view: View = get().view.kind === "session" ? { kind: "workspace", workspaceId: session.workspaceId } : get().view;
      set({ sessions: rest, sessionOrder: order, view });
      void get().inspectWorkspace(session.workspaceId);
      void get().loadRecords(session.workspaceId);
    } catch (error) {
      set({ error: asError(error) });
    } finally {
      set({ busy: null });
    }
  },

  async refreshSnapshot(sessionId) {
    const session = get().sessions[sessionId];
    if (!session) return;
    try {
      const snapshot = await api.sessionSnapshot(session.handle);
      // Deltas skipped by the lagging channel are recovered from the retained
      // history rather than guessed from the snapshot alone.
      const missed = await api.sessionHistory(session.handle, session.projection.lastSequence);
      const projection = { ...session.projection, snapshotNeeded: false, foreground: snapshot.foreground, process: snapshot.process, attachment: snapshot.attachment };
      for (const event of missed) if (BigInt(event.sequence) > BigInt(projection.lastSequence)) applyEvent(projection, event);
      for (const [id, patch] of Object.entries(snapshot.toolCalls)) if (!projection.toolCalls.has(id)) projection.toolCalls.set(id, patch);
      set({ sessions: { ...get().sessions, [sessionId]: { ...session, snapshot, projection } } });
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async setConfigOption(sessionId, configId, value) {
    const session = get().sessions[sessionId];
    if (!session) return;
    set({ busy: `Switching ${configId}`, error: null });
    try {
      const result = (await api.sessionSetConfigOption(session.handle, configId, value)) as { configOptions?: unknown } | null;
      const current = get().sessions[sessionId];
      if (current && result && typeof result === "object" && Array.isArray(result.configOptions)) {
        set({ sessions: { ...get().sessions, [sessionId]: { ...current, projection: { ...current.projection, configOptions: result.configOptions } } } });
      }
      // The accepted value becomes the default for sessions started later on
      // the same provider: a model id means nothing to another one.
      const defaults = { ...get().sessionDefaults };
      const provider = session.snapshot.provider;
      if (defaults.provider !== provider) {
        delete defaults.model;
        delete defaults.reasoningEffort;
      }
      defaults.provider = provider;
      if (configId === "model") {
        defaults.model = value;
      } else if (configId === "effort" || configId === "reasoning_effort") {
        if (value === "default") delete defaults.reasoningEffort;
        else defaults.reasoningEffort = value;
      }
      set({ sessionDefaults: defaults });
      void api.prefSet("session_defaults", defaults).catch(() => undefined);
    } catch (error) {
      set({ error: asError(error) });
    } finally {
      set({ busy: null });
    }
  },

  /**
   * Runs a provider's own sign-in: a separate process, no token through the
   * desktop, and a URL surfaced for the user to click.
   */
  async startSignIn(provider) {
    set({ signIn: { runId: null, provider, lines: [], urls: [], state: "starting" }, error: null });
    try {
      const { runId } = await api.providerLoginStart(provider, (event: LoginEvent) => {
        const run = get().signIn;
        if (!run || run.provider !== provider) return;
        let next: SignInRun = run;
        switch (event.type) {
          case "started":
            next = { ...run, state: "running" };
            break;
          case "line":
            next = { ...run, lines: [...run.lines, { stream: event.stream, text: event.text }].slice(-200) };
            break;
          case "url":
            next = { ...run, urls: run.urls.includes(event.url) ? run.urls : [...run.urls, event.url] };
            break;
          case "exited":
            next = { ...run, state: event.success ? "success" : event.cancelled ? "cancelled" : event.timedOut ? "timed_out" : "failed" };
            if (event.success) void get().loadProviders();
            break;
        }
        set({ signIn: next });
      });
      const run = get().signIn;
      if (run && run.provider === provider) set({ signIn: { ...run, runId } });
    } catch (error) {
      set({ error: asError(error), signIn: null });
    }
  },

  async switchAccount(provider) {
    const info = get().providers?.find((entry) => entry.provider === provider);
    const current = info?.auth?.account ? ` (${info.auth.account})` : "";
    const confirmed = await api
      .confirmDialog({
        title: `Switch ${PROVIDER_LABELS[provider]} account?`,
        message: `This signs ${PROVIDER_LABELS[provider]} out of the current account${current} and opens its own sign-in. Sessions already running keep the account they started with; new ones use the account you sign in with. It also changes the account for ${PROVIDER_LABELS[provider]} outside ThingMaker.`,
        okLabel: "Sign out and sign in again",
        cancelLabel: "Cancel",
        warning: true,
      })
      .catch(() => false);
    if (!confirmed) return;
    try {
      await api.providerLogout(provider);
    } catch (error) {
      set({ error: asError(error) });
      return;
    }
    await get().loadProviders();
    await get().startSignIn(provider);
  },

  async cancelSignIn() {
    const run = get().signIn;
    if (!run?.runId) return;
    try {
      await api.providerLoginCancel(run.runId);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async openUrl(url) {
    try {
      await api.openExternal(url);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  focusComposer() {
    set({ focusComposerToken: get().focusComposerToken + 1 });
  },

  clearError() {
    set({ error: null });
  },
}));
