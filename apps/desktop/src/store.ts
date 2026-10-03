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
import { EMPTY_COMBO, JOB_EVENT, ODYSSEY_STATE_NOTE, PROVIDERS, PROVIDER_LABELS, BIGTHING_EVENT, asConfigOptions, isEffortOption, type Combo, type JobView, type ProviderModel, type BigThingEvent, type BigThingRuntime, type TeamPreset } from "@thingmaker/contracts";
import { handoffBrief, readPresets, upsertJob, upsertPreset } from "./team";

/** Preference keys (scope `ui`) for saved teams. */
const TEAM_PRESETS_KEY = "teamPresets";
const DEFAULT_PRESET_KEY = "defaultTeamPreset";
import { api } from "./ipc";
import { notify, shouldNotify } from "./notifications";
import { CLAUDE_RETRY_MS, claudeUsageFrom } from "./odysseyClaudeQuota";
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
  /** What the engine's spend forecast says about the next turn. */
  forecast?: string | null;
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
  /** The live Big Thing goal per session. `null` means read and there is none. */
  odyssey: Record<string, OdysseyView | null>;
  /** Runner bookkeeping that is not worth persisting: the resume time a wait
   *  is counting down to, the last reason a tick did nothing and when it was
   *  given, and how long the runner has been unable to act. */
  odysseyRuntime: Record<string, OdysseyRuntime>;
  /** Changes the user asked for while the goal was running, per session. */
  odysseyAmendments: Record<string, AmendmentRecord[]>;
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
  /** A document on its way to a session's Big Thing tab, by absolute path. */
  bigThingDoc: Record<string, string>;
  /** Opens Big Thing with this document: a new goal planned from it, or a change to the running one. */
  sendDocToBigThing: (sessionId: string, path: string) => void;
  /** The document waiting for this session's Big Thing tab, taken once. */
  takeBigThingDoc: (sessionId: string) => string | null;
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
  /** Asks the engine to look at the goal now. */
  odysseyTick: (sessionId: string) => Promise<void>;
  /** What the engine tells the interface. */
  noteBigThing: (event: BigThingEvent) => void;
  odysseyVerifyManually: (sessionId: string, milestoneId: string) => Promise<void>;
  odysseyRunCheck: (sessionId: string, milestoneId: string) => Promise<void>;
  odysseyRequestPlan: (sessionId: string) => Promise<void>;
  odysseyAddAmendment: (sessionId: string, request: NewAmendment) => Promise<void>;
  odysseyDiscardAmendment: (sessionId: string, id: string) => Promise<void>;
  odysseyLoadAmendments: (sessionId: string, odysseyId: string) => Promise<void>;
  /** Closes activity the runtime never reported finishing. Presentation only. */
  clearStaleActivity: (sessionId: string) => void;
  /** Re-reads the handoff and subagent notes for the screen. */
  odysseyRefreshNotes: (sessionId: string) => Promise<void>;
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
  setShowHidden: (show: boolean) => void;
  /** Opens or resumes a session. A resume runs on the provider that wrote it; a new one on `provider`, else the last one used. */
  openSession: (workspaceId: string, mode: OpenMode, provider?: Provider) => Promise<void>;
  /** Opens a fresh session on a named agent and returns how to address it. */
  openSessionFor: (workspaceId: string, provider: Provider, combo?: Combo) => Promise<{ key: string; agentSessionId: string } | null>;
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
  return isWorkerIn(get(), id, session);
}

/** The same, for a component's selector: a worker reports to its orchestrator. */
export function isWorkerIn(state: Pick<State, "jobs" | "records">, id: string, session: LiveSession | undefined): boolean {
  if (Object.values(state.jobs).some((jobs) => jobs.some((job) => job.workerSession === id))) return true;
  const agentId = session?.snapshot.agentSessionId;
  return !!session && !!agentId && !!(state.records[session.workspaceId] ?? []).find((record) => record.agentSessionId === agentId)?.parentSessionId;
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

/** Journal summary marking a planning turn as asked for; the engine writes it. */
export const PLAN_REQUESTED = "Asked the agent to read the plan document";

/** The engine's runtime for a goal, in the shape the screen reads. */
function runtimeFrom(runtime: BigThingRuntime): OdysseyRuntime {
  return {
    resumeAt: runtime.resumeAt ?? null,
    lastReason: runtime.lastReason,
    lastReasonAt: runtime.lastReasonAt,
    ticking: runtime.ticking,
    stalledSince: runtime.stalledSince ?? null,
    stallNotified: runtime.stallNotified,
    forecast: runtime.forecast ?? null,
  };
}

/** The live session a goal's record points at, by its id or its agent's. */
function sessionKeyForGoal(state: State, goalId: string, agentSessionId?: string | null): string | null {
  for (const [key, view] of Object.entries(state.odyssey)) if (view?.goal.id === goalId) return key;
  if (agentSessionId) {
    const live = Object.values(state.sessions).find((session) => session.snapshot.agentSessionId === agentSessionId);
    if (live) return live.handle.id;
  }
  return null;
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

/** Where a goal is being moved to: an open session, or a fresh one. */
type MoveTarget = { kind: "session"; sessionId: string } | { kind: "new"; agent: Provider };

/**
 * Attaches the renderer to a live actor: snapshot, retained history (replayed
 * in order, deduplicated by sequence), then the live stream. Events that
 * arrive while history is loading are buffered and applied after it.
 */
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
      if (payload.type === "quota") {
        const { type: _type, ...quota } = payload;
        get().noteQuota(quota);
      }
      if (payload.type === "turn" && payload.effect === "settled" && payload.kind === "foreground") {
        turnStartedAt = null;
        void get().sampleUsage(id, "settle");
        announcement = `${sessionTitle(current)}: turn ${payload.phase}`;
      } else if (payload.type === "permission_request") {
        announcement = `${sessionTitle(current)}: the agent asked for input`;
        // A run's permission decisions are journalled by the engine.
      } else if (payload.type === "exited") {
        announcement = `${sessionTitle(current)}: the agent exited`;
      }
    }
    if (viewing) attention = "none";
    set({ sessions: { ...get().sessions, [id]: { ...current, projection: { ...current.projection }, attention, turnStartedAt, lastEventAt: Date.now() } } });
    if (announcement) get().announce(announcement);
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
  odysseyAmendments: {},
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
  bigThingDoc: {},
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
      void listen<BigThingEvent>(BIGTHING_EVENT, (event) => get().noteBigThing(event.payload));
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
        // What the engine is doing now; later changes arrive as events.
        const runtime = await api.bigthingRuntime(view.goal.id).catch(() => null);
        if (runtime && typeof runtime === "object" && "lastReason" in runtime) set({ odysseyRuntime: { ...get().odysseyRuntime, [sessionId]: runtimeFrom(runtime) } });
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
      note: `Break milestone ${milestoneIndex + 1} ("${milestone.title}") into three to eight tasks, each one thing a subagent or worker can be given on its own, cut so that independent tasks can run in parallel; put depends: under a task only when it truly cannot start until an earlier one has finished. Send them in a BIGTHING-AMEND block as revise: ${milestoneIndex + 1} with step: lines. Change nothing else about the milestone.`,
      refs: [],
    });
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
   * Starts or resumes a run. The engine in the host runs it (ADR-010); this
   * hands it the user's "go" and shows what the record says.
   */
  async odysseyStart(sessionId) {
    const view = get().odyssey[sessionId];
    if (!view) return;
    try {
      await api.bigthingStart(view.goal.id);
      await get().refreshOdyssey(sessionId, view.goal.id);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  /**
   * Points this goal at another session. The record moves, the transcript
   * does not: the new session is briefed from the record and the run's notes.
   * The current turn is cancelled first, so there is never more than one
   * orchestrator on the tree.
   */
  async odysseyMoveTo(sessionId, target) {
    const view = get().odyssey[sessionId];
    const session = get().sessions[sessionId];
    if (!view || !session) return;
    const running = session.projection.foreground === "running" || session.projection.foreground === "awaiting_user";
    if (target.kind === "session" && !get().sessions[target.sessionId]) {
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
      await api.bigthingMove(view.goal.id, target.kind === "session" ? { kind: "session", handle: target.sessionId } : { kind: "new", provider: target.agent });
      get().announce(`${view.goal.title}: moved to another session`);
    } catch (error) {
      set({ error: asError(error) });
    } finally {
      set({ busy: null });
    }
  },

  /** Pauses before the next continuation; an in-flight turn is left alone. */
  async odysseyPause(sessionId, reason) {
    const view = get().odyssey[sessionId];
    if (!view) return;
    try {
      await api.bigthingPause(view.goal.id, reason);
      await get().refreshOdyssey(sessionId, view.goal.id);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  /** Asks the engine to look at the goal now rather than on its next tick. */
  async odysseyTick(sessionId) {
    const view = get().odyssey[sessionId];
    if (!view) return;
    await api.bigthingTick(view.goal.id).catch(() => undefined);
  },

  /** What the engine tells the interface (ADR-010). */
  noteBigThing(event) {
    const state = get();
    switch (event.kind) {
      case "changed": {
        const key = sessionKeyForGoal(state, event.goalId, event.agentSessionId);
        if (!key) return;
        void get().refreshOdyssey(key, event.goalId);
        void get().odysseyLoadInbox(key, event.goalId);
        void get().odysseyLoadAmendments(key, event.goalId);
        void get().odysseyRefreshNotes(key);
        return;
      }
      case "runtime": {
        const handle = event.runtime.sessionHandle;
        const key = handle && state.sessions[handle] ? handle : sessionKeyForGoal(state, event.goalId);
        if (key) set({ odysseyRuntime: { ...get().odysseyRuntime, [key]: runtimeFrom(event.runtime) } });
        return;
      }
      case "announce":
        get().announce(event.text);
        return;
      case "notify": {
        const settings = state.settings;
        const kind: AttentionKind = event.attention === "needs_input" ? "needs_input" : event.attention === "blocked" ? "failed" : "completed";
        const workspace = state.workspaces.find((entry) => entry.id === event.workspaceId);
        if (settings && shouldNotify(settings, kind, event.workspaceId)) void notify(kind, workspace ? basenameOf(workspace.displayPath) : "a workspace");
        return;
      }
      case "session_named":
        void get().loadRecords(event.workspaceId);
        return;
      case "session_opened": {
        void get().loadRecords(event.workspaceId);
        if (state.sessions[event.handle]) return;
        void api
          .sessionListOpen()
          .then((open) => open.find((entry) => entry.handle.id === event.handle))
          .then((entry) => (entry && !get().sessions[event.handle] ? attachLive(get, set, entry.handle, event.workspaceId, false) : undefined))
          .catch(() => undefined);
        return;
      }
      case "moved": {
        const from = event.fromAgentSessionId ? Object.values(state.sessions).find((session) => session.snapshot.agentSessionId === event.fromAgentSessionId)?.handle.id : sessionKeyForGoal(state, event.goalId);
        const view = from ? state.odyssey[from] : null;
        if (from && from !== event.toHandle) {
          set({
            odyssey: { ...get().odyssey, [from]: null },
            odysseyMovedAway: { ...get().odysseyMovedAway, [from]: { goalId: event.goalId, title: view?.goal.title ?? "The run", to: event.toHandle } },
          });
        }
        if (get().sessions[event.toHandle]) void get().loadOdyssey(event.toHandle);
        return;
      }
    }
  },

  /**
   * Queues something for the model to fold into a goal that is already
   * running. The engine carries it on the next prompt; the model decides
   * where it belongs.
   */
  async odysseyAddAmendment(sessionId, request) {
    const view = get().odyssey[sessionId];
    if (!view) return;
    try {
      await api.bigthingAmend(request);
      await get().odysseyLoadAmendments(sessionId, view.goal.id);
      await get().refreshOdyssey(sessionId, view.goal.id);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async odysseyDecidePlanChange(sessionId, id, decision, note) {
    const view = get().odyssey[sessionId];
    if (!view) return;
    try {
      await api.bigthingDecidePlanChange(view.goal.id, id, decision === "apply", note);
      await get().odysseyLoadInbox(sessionId, view.goal.id);
      await get().refreshOdyssey(sessionId, view.goal.id);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  async odysseyAnswerQuestion(sessionId, id, answer) {
    const view = get().odyssey[sessionId];
    if (!view) return;
    try {
      await api.bigthingAnswer(view.goal.id, id, answer);
      await get().odysseyLoadInbox(sessionId, view.goal.id);
      await get().refreshOdyssey(sessionId, view.goal.id);
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
   * Asks the session's model to turn the goal's plan document into
   * milestones. The goal stays a draft until the user starts it.
   */
  async odysseyRequestPlan(sessionId) {
    const view = get().odyssey[sessionId];
    if (!view) return;
    try {
      await api.bigthingRequestPlan(view.goal.id);
      await get().refreshOdyssey(sessionId, view.goal.id);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  /** Runs a milestone's check here; the engine records the verdict. */
  async odysseyRunCheck(sessionId, milestoneId) {
    const view = get().odyssey[sessionId];
    if (!view) return;
    try {
      await api.bigthingRunCheck(view.goal.id, milestoneId);
      await get().refreshOdyssey(sessionId, view.goal.id);
    } catch (error) {
      set({ error: asError(error) });
    }
  },

  /** The user ticking a manual milestone: the user is the evidence. */
  async odysseyVerifyManually(sessionId, milestoneId) {
    const view = get().odyssey[sessionId];
    if (!view) return;
    try {
      await api.bigthingVerify(view.goal.id, milestoneId);
      await get().refreshOdyssey(sessionId, view.goal.id);
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

  async odysseyRefreshNotes(sessionId) {
    const session = get().sessions[sessionId];
    if (!session) return;
    const notes = await api.odysseyWorkspaceNotes(session.workspaceId).catch(() => null);
    set({ odysseyNotes: { ...get().odysseyNotes, [sessionId]: notes } });
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

  sendDocToBigThing(sessionId, path) {
    set({ bigThingDoc: { ...get().bigThingDoc, [sessionId]: path }, sessionTab: "odyssey" });
  },

  takeBigThingDoc(sessionId) {
    const path = get().bigThingDoc[sessionId] ?? null;
    if (path) {
      const { [sessionId]: _taken, ...rest } = get().bigThingDoc;
      set({ bigThingDoc: rest });
    }
    return path;
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
  async openSessionFor(workspaceId, provider, combo) {
    try {
      const opened = await api.sessionOpen({ workspaceId, mode: { mode: "new" }, provider, ...launchDefaults(get().sessionDefaults, provider), ...(combo ? { combo } : {}) });
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
    // A worker closed for being idle is archived by the host: the sidebar
    // reads the rows again so it leaves the live list.
    if (job.workerClosed && !previous?.workerClosed) {
      const workspaceId = get().sessions[job.orchestrator]?.workspaceId;
      if (workspaceId) void get().loadRecords(workspaceId);
    }
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
      if (agents > 0) parts.push(`${agents} subagent${agents === 1 ? " is" : "s are"} still working and will be killed with it (only what they wrote to docs/big-thing/agents/ survives)`);
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
