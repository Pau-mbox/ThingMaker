/**
 * ThingMaker desktop API contracts (spec section 20.1).
 *
 * These types mirror the serde output of `crates/thingmaker-supervisor` and the
 * Tauri command layer. They describe OUR desktop API, not the ACP wire: the
 * native side decodes ACP and every provider's own protocol into these.
 *
 * 64-bit counters are decimal strings so they survive JavaScript's safe
 * integer range.
 */

export const DESKTOP_API_VERSION = 1 as const;

/** Decimal string of a u64 (attachment generations, event sequences). */
export type DecimalId = string;

export type SessionHandle = {
  id: string;
  attachmentGeneration: DecimalId;
};

export type ErrorCode =
  | "NOT_READY"
  | "LOCKED"
  | "UNSUPPORTED"
  | "CONFLICT"
  | "UNTRUSTED"
  | "IO"
  | "AUTH_REQUIRED"
  | "OUTCOME_UNKNOWN"
  | "PROTOCOL"
  | "LIMIT_EXCEEDED"
  | "CANCELLED";

export type RetryPolicy = "never" | "read_only" | "after_reconcile" | "user_action";

export type DesktopError = {
  code: ErrorCode;
  /** Safe for user display; never a raw secret-bearing payload. */
  message: string;
  retry: RetryPolicy;
  diagnosticId?: string;
};

export function isDesktopError(value: unknown): value is DesktopError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.code === "string" && typeof candidate.message === "string" && typeof candidate.retry === "string";
}

// ---------------------------------------------------------------------------
// State machines (spec section 8.4)
// ---------------------------------------------------------------------------

export type ProcessState = "stopped" | "starting" | "negotiating" | "ready" | "degraded" | "closing" | "exited";
export type AttachmentState = "new" | "replaying" | "attached" | "locked" | "recovering" | "detached";
export type SubmissionState = "draft" | "validated" | "queued" | "writing" | "accepted" | "outcome_unknown" | "rejected";
export type TurnPhase = "idle" | "running" | "awaiting_user" | "cancelling" | "succeeded" | "failed" | "cancelled" | "unknown";
export type DetachedCallState = "active" | "cancellation_requested" | "completed" | "failed" | "unknown";
export type TurnKind = "foreground" | "autonomous";
export type SteerState = "pending" | "delivered" | "rejected" | "outcome_unknown";

export type TurnEffect =
  | { effect: "started"; kind: TurnKind; turnId?: number }
  | { effect: "cancelling"; kind: TurnKind }
  | { effect: "settled"; kind: TurnKind; turnId?: number; phase: TurnPhase; stopReason?: string; error?: string }
  | { effect: "ignored"; reason: string };

// ---------------------------------------------------------------------------
// Decoded ACP content (the native ACP client's output)
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data?: string; mimeType?: string; uri?: string }
  | { type: "audio"; data?: string; mimeType?: string }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string }
  | { type: "resource"; uri?: string; mimeType?: string; text?: string; blob?: string }
  | { type: "unknown"; originalType: string; raw: unknown };

export type MessageUpdate = {
  messageId: string;
  content: ContentBlock[];
  /** True for full messages, false for chunks. */
  replace: boolean;
  /** False only when a full message omitted `content` entirely. */
  hasContent: boolean;
};

export type ToolPatch = {
  toolCallId: string | null;
  title: string | null;
  status: string | null;
  /** The wire `kind` field, renamed so it cannot collide with the update discriminator. */
  toolKind: string | null;
  content: unknown;
  rawInput: unknown;
  rawOutput: unknown;
  name: string | null;
  locations: unknown;
  meta: unknown;
  present: string[];
  cleared: string[];
};

export type PlanEntry = { content: string; status?: string; priority?: string };

export type PlanContent =
  | { planType: "items"; id: string; entries: PlanEntry[] }
  | { planType: "file"; id: string; uri: string }
  | { planType: "markdown"; id: string; content: string }
  | { planType: "unknown"; id: string; originalType: string; raw: unknown };

export type TokenUsage = {
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thoughtTokens: number | null;
  cachedReadTokens: number | null;
  cachedWriteTokens: number | null;
};

export type SessionUpdate =
  | ({ kind: "user_message" } & MessageUpdate)
  | ({ kind: "agent_message" } & MessageUpdate)
  | ({ kind: "agent_thought" } & MessageUpdate)
  | ({ kind: "tool_call" } & ToolPatch)
  | ({ kind: "tool_call_update" } & ToolPatch)
  | { kind: "tool_call_content"; toolCallId: string; content: unknown }
  | ({ kind: "plan" } & PlanContent)
  | { kind: "plan_removed"; id: string }
  | { kind: "usage"; used: number | null; size: number | null; meta?: unknown }
  | { kind: "config_options"; configOptions: unknown }
  | { kind: "session_info"; title: string | null; updatedAt: string | null; titlePresent: boolean; updatedAtPresent: boolean }
  | { kind: "available_commands"; commands: { name: string; description?: string }[] }
  | { kind: "current_mode"; raw: unknown }
  | { kind: "notice"; severity: string | null; title: string; description?: string }
  | { kind: "compaction"; compactionId: string; status: string; summary?: ContentBlock[]; error?: string }
  | { kind: "compaction_chunk"; compactionId: string; content: ContentBlock }
  | { kind: "state"; state: string; stopReason?: string; usage?: TokenUsage }
  | { kind: "unknown"; raw: unknown; truncated: boolean; [key: string]: unknown };

export type RuntimeEvent =
  | {
      event: "subagent_state_changed";
      id: string;
      name: string;
      status: "starting" | "working" | "idle" | "removed";
      outcome: "success" | "failed" | null;
      generation: number;
      task: string;
      parent_id: string | null;
      parent_name: string | null;
      harness: string;
      model: string | null;
      created_at_unix_ms: number;
      generation_started_at_unix_ms: number;
      generation_finished_at_unix_ms: number | null;
    }
  | { event: "subagent_descendants_removed"; ancestor_id: string };

export type ExitInfo = { status: number | null; signal: number | null; forced: boolean };

/** The subscriptions the desktop drives. Each runs its own official program:
 *  `claude` is Claude Code (through claude-agent-acp), `codex` is Codex
 *  (through its app-server). */
export type Provider = "claude" | "codex" | "gemini";
export const PROVIDERS: readonly Provider[] = ["claude", "codex", "gemini"] as const;
export const PROVIDER_LABELS: Record<Provider, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini" };
/** Two letters for a tag, so the provider is visible without a second line. */
export const PROVIDER_SHORT: Record<Provider, string> = { claude: "CC", codex: "CX", gemini: "GM" };
/**
 * Providers that can lead a team. An orchestrator has to take the session's
 * own `team` MCP server; Antigravity's `agy` only reads MCP servers from its
 * global configuration, so Gemini is a worker or a plain session.
 */
export const ORCHESTRATOR_PROVIDERS: readonly Provider[] = ["claude", "codex"] as const;

export type QuotaStatus = "allowed" | "warning" | "rejected";
/** One usage window, as the provider names it (`five_hour`, `seven_day_opus`, `primary`, …). */
export type QuotaWindow = { kind: string; usedPercent?: number; windowMinutes?: number; resetsAt?: number };
/** An account's quota as its provider last reported it. */
export type QuotaSnapshot = { provider: Provider; status: QuotaStatus; windows: QuotaWindow[]; plan?: string; observedAtUnixMs: number };

export type AuthMethodSummary = { kind: string; methodId?: string; name?: string; description?: string };

export type CapabilitySnapshot = {
  protocolVersion: number;
  agentName: string;
  agentVersion: string;
  agentTitle?: string;
  promptImage: boolean;
  promptAudio: boolean;
  promptEmbeddedContext: boolean;
  supportsSteering: boolean;
  supportsLoad: boolean;
  supportsFork: boolean;
  supportsAdditionalDirectories: boolean;
  supportsMcp: boolean;
  authMethods: AuthMethodSummary[];
  raw: unknown;
};

export type SessionEvent =
  | { type: "process"; state: ProcessState; pid?: number }
  | { type: "attachment"; state: AttachmentState; agentSessionId?: string }
  | ({ type: "capabilities" } & CapabilitySnapshot)
  | ({ type: "update" } & SessionUpdate)
  | ({ type: "runtime_event" } & RuntimeEvent)
  | ({ type: "quota" } & QuotaSnapshot)
  | { type: "diagnostic"; text: string }
  | ({ type: "turn" } & TurnEffect)
  | { type: "submission"; requestId: string; state: SubmissionState; message?: string }
  | { type: "steer"; messageId: string; state: SteerState }
  | { type: "detached_call"; callId: string; state: DetachedCallState }
  /** What the workspace's trust state answered
   *  (docs/plans/odyssey-second-orchestrator.md §2.2). */
  | { type: "permission_request"; requestId: string; title: string | null; decision: "cancelled" | "allowed" }
  | ({ type: "exited" } & ExitInfo)
  | { type: "overflow"; stream: "stdout" | "stderr"; bytes: number; limit: number; fatal: boolean }
  | { type: "snapshot_needed"; reason: string; skipped?: number };

export type EventEnvelope = {
  apiVersion: typeof DESKTOP_API_VERSION;
  session: SessionHandle;
  /** App-local stream cursor, never an ACP replay cursor. */
  sequence: DecimalId;
  payload: SessionEvent;
};

export type Snapshot = {
  handle: SessionHandle;
  /** The provider this attachment runs on, and so which account it spends. */
  provider: Provider;
  historyStart: DecimalId;
  historyDropped: number;
  /** The agent's own id for the session, once `session/new` has answered. */
  agentSessionId: string | null;
  process: ProcessState;
  attachment: AttachmentState;
  capabilities: CapabilitySnapshot | null;
  foreground: TurnPhase;
  autonomousTurns: number[];
  detachedCalls: Record<string, DetachedCallState>;
  toolCalls: Record<string, ToolPatch>;
  configOptions: unknown;
  availableCommands: { name: string; description?: string }[];
  pendingSteers: string[];
  lastSequence: DecimalId;
  exit: ExitInfo | null;
};

/** An agent's session config option (ACP `SessionConfigOption`, select type). Options may be flat or grouped. */
export type ConfigOptionChoice = { value: string; name: string; description?: string };
export type ConfigOptionGroup = { groupId: string; name: string; options: ConfigOptionChoice[] };
export type SessionConfigOption = {
  configId: string;
  name: string;
  description?: string;
  category?: string;
  type?: string;
  currentValue?: unknown;
  options?: (ConfigOptionChoice | ConfigOptionGroup)[];
};

export function isConfigOptionGroup(entry: ConfigOptionChoice | ConfigOptionGroup): entry is ConfigOptionGroup {
  return typeof (entry as ConfigOptionGroup).groupId === "string" && Array.isArray((entry as ConfigOptionGroup).options);
}

/**
 * An agent's config options, normalised. ACP v1 names an option `id` and a
 * group `group`; Kit's v2 dialect said `configId` and `groupId`. Both are read,
 * and everything downstream sees the `configId`/`groupId` shape.
 */
export function asConfigOptions(value: unknown): SessionConfigOption[] {
  if (!Array.isArray(value)) return [];
  const out: SessionConfigOption[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const configId = typeof entry.configId === "string" ? entry.configId : typeof entry.id === "string" ? entry.id : null;
    if (!configId) continue;
    const options = Array.isArray(entry.options)
      ? entry.options.flatMap((choice): (ConfigOptionChoice | ConfigOptionGroup)[] => {
          if (typeof choice !== "object" || choice === null) return [];
          const item = choice as Record<string, unknown>;
          const groupId = typeof item.groupId === "string" ? item.groupId : typeof item.group === "string" ? item.group : null;
          if (groupId && Array.isArray(item.options)) {
            return [{ groupId, name: typeof item.name === "string" ? item.name : groupId, options: item.options as ConfigOptionChoice[] }];
          }
          return typeof item.value === "string" ? [item as unknown as ConfigOptionChoice] : [];
        })
      : undefined;
    out.push({ ...(entry as unknown as SessionConfigOption), configId, ...(options ? { options } : {}) });
  }
  return out;
}

/** Whether a config option is the reasoning effort, by either dialect's id. */
export function isEffortOption(configId: string): boolean {
  return configId === "effort" || configId === "reasoning_effort";
}

export type SubmissionOutcome =
  | { outcome: "accepted" }
  | { outcome: "rejected"; error: DesktopError }
  | { outcome: "outcome_unknown"; error: DesktopError };

export type SteerOutcome =
  | { outcome: "accepted"; messageId: string }
  | { outcome: "rejected"; error: DesktopError }
  | { outcome: "outcome_unknown"; error: DesktopError };

// ---------------------------------------------------------------------------
// Workspace, trust and runtime
// ---------------------------------------------------------------------------

export type TrustState = "untrusted" | "inspect_only" | "trusted_local";

export type WorkspaceRecord = {
  id: string;
  environmentId: string;
  canonicalRoot: string;
  displayPath: string;
  workspaceHash: string;
  trustState: TrustState;
  trustDigest?: string;
  trustedAt?: number;
  createdAt: number;
};

export type WorkspaceIdentity = { canonicalRoot: string; displayPath: string; workspaceHash: string };

export type ConfigSource = {
  path: string;
  kind: "mcp" | "instructions" | "claude-settings" | "codex-config";
  present: boolean;
  bytes: number;
  summary: string[];
  executable: boolean;
};

export type WorkspaceInspection = {
  identity: WorkspaceIdentity;
  record: WorkspaceRecord;
  sources: ConfigSource[];
  trustDigest: string;
  trustStale: boolean;
  isGitRepository: boolean;
  isUnityProject: boolean;
};

export type ExecutionProfile = "inspect_only" | "trusted_local" | "restricted_environment" | "remote_managed";

export type ProfileInfo = { profile: ExecutionProfile; label: string; explanation: string; available: boolean };

export type SessionRecord = {
  id: string;
  workspaceId: string;
  /** The agent's own id for the session. */
  agentSessionId: string;
  titleOverlay?: string;
  origin: "desktop" | "cli" | "unknown";
  archiveState: "active" | "archived" | "unavailable";
  pinned: boolean;
  lastSeen?: number;
  /** The provider this session runs on. */
  provider: Provider;
  /** The orchestrator's row, for a worker session a `delegate` opened. */
  parentSessionId?: string;
  createdAt: number;
};

// ---------------------------------------------------------------------------
// Teams and delegation (docs/research/multi-provider-viability.md §2.2)
// ---------------------------------------------------------------------------

/** Capabilities the team picker offers; free text is accepted too. */
export const WORKER_CAPABILITIES = ["code", "image", "fast", "review", "research", "ui"] as const;

/** One worker an orchestrator may delegate to. */
export type WorkerSlot = {
  /** Unique within the team; what the orchestrator names it by. */
  name: string;
  provider: Provider;
  /** The provider's own model id; absent is the account default. */
  model?: string;
  effort?: string;
  capabilities: string[];
  /** A line for the orchestrator: when to use this worker. */
  note?: string;
};

/** The team behind one orchestrator session. */
export type Combo = {
  workers: WorkerSlot[];
  /** Whether the orchestrator may also start its own provider's subagents. Read at session start. */
  nativeSubagents: boolean;
};

export const EMPTY_COMBO: Combo = { workers: [], nativeSubagents: false };

/** Who leads a team: a provider, and optionally its model and effort. */
export type OrchestratorChoice = { provider: Provider; model?: string; effort?: string };

/** A saved team: an orchestrator and its workers, ready to start a session with or apply to one. */
export type TeamPreset = {
  id: string;
  name: string;
  orchestrator: OrchestratorChoice;
  combo: Combo;
  updatedAt: number;
};

export type JobStatus = "starting" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

/** What a job does after a temporary limit (an image limit, an account window, an overloaded server). */
export type JobRetryPolicy = {
  enabled: boolean;
  firstDelaySecs: number;
  stepSecs: number;
  maxDelaySecs: number;
  maxAttempts: number;
  maxWaitSecs: number;
};

/** A task an orchestrator handed to a worker. */
export type JobView = {
  id: string;
  /** The orchestrator's attachment handle. */
  orchestrator: string;
  worker: string;
  provider: Provider;
  model?: string;
  effort?: string;
  task: string;
  status: JobStatus;
  result?: string;
  error?: string;
  /** The worker asked for, when another took the task, and why. */
  reroutedFrom?: string;
  /** The job this one follows up, in the same worker session. */
  continues?: string;
  /** The worker's attachment handle, once it is open. */
  workerSession?: string;
  agentSessionId?: string;
  toolCalls: number;
  /** Retries after a temporary limit, so far. */
  attempts: number;
  /** What the job is waiting out, while it waits. */
  waitingReason?: string;
  retryAtUnixMs?: number;
  startedAtUnixMs: number;
  finishedAtUnixMs?: number;
};

/** Emitted by the host on every job change. */
export const JOB_EVENT = "thingmaker://job";

// ---------------------------------------------------------------------------
// Providers: programs, sign-in and model catalogs
// ---------------------------------------------------------------------------

/** What a provider reported about its own sign-in. */
export type ProviderAuthStatus = {
  provider: Provider;
  loggedIn?: boolean;
  method?: string;
  account?: string;
  plan?: string;
  problem?: string;
};

/** A provider's program, resolved. */
export type ResolvedProvider = { provider: Provider; program: string; prefixArgs: string[]; source: "settings" | "environment" | "discovered" };

export type ProviderInfo = { provider: Provider; label: string; resolved?: ResolvedProvider; problem?: string; auth?: ProviderAuthStatus };

/** Where a provider's program is, as chosen in Settings. `script` is Claude's adapter entry point. */
export type ProviderLocation = { program: string; script?: string };

/** One model a provider says this account can select. */
export type ProviderModel = {
  id: string;
  name: string;
  description?: string;
  /** The provider's own description says it costs beyond the subscription. */
  needsCredits: boolean;
  efforts: string[];
  defaultEffort?: string;
  inputImage: boolean;
  isDefault: boolean;
};

// ---------------------------------------------------------------------------
// Files and review (FS, REV)
// ---------------------------------------------------------------------------

export type EntryKind = "file" | "dir" | "symlink" | "other";

export type DirEntry = {
  name: string;
  relativePath: string;
  kind: EntryKind;
  bytes: number;
  ignored: boolean;
  hidden: boolean;
  modifiedUnixMs: number | null;
};

export type FileRead = {
  relativePath: string;
  content: string;
  contentHash: string;
  bytes: number;
  totalLines: number;
  offsetLine: number;
  returnedLines: number;
  truncated: boolean;
  binary: boolean;
  editable: boolean;
  crlf: boolean;
  modifiedUnixMs: number | null;
};

export type WriteOutcome = { relativePath: string; contentHash: string; bytes: number };

export type BaselineRecord = {
  id: string;
  workspaceId: string;
  sessionId?: string;
  scope: string;
  baseRef?: string;
  manifestHash: string;
  fileCount: number;
  omittedCount: number;
  createdAt: number;
};

export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "mode_changed";

export type FileChange = {
  path: string;
  kind: ChangeKind;
  renamedFrom?: string;
  beforeHash?: string;
  afterHash?: string;
  beforeBytes: number;
  afterBytes: number;
  beforeMode?: number;
  afterMode?: number;
  binary: boolean;
  unified?: string;
  omitted?: string;
  additions: number;
  deletions: number;
};

export type DiffReport = {
  scope: string;
  label: string;
  baseRef: string;
  files: FileChange[];
  truncated: boolean;
  computedAtUnixMs: number;
};

export type DiffScope = "baseline" | "working_tree" | "staged";

export type RepositoryInfo = {
  head: string;
  detached: boolean;
  remotes: string[];
  upstream?: string;
  ahead: number;
  behind: number;
  branches: string[];
  root: string;
};

export type CommitOutcome = { commit: string; summary: string };

export type FileVersions = {
  path: string;
  before: string | null;
  after: string | null;
  beforeLabel: string;
  afterLabel: string;
  afterHash: string | null;
};

export type WorktreeEntry = {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
};

export type WorktreeRecord = {
  id: string;
  workspaceId: string;
  path: string;
  branch: string;
  baseRef: string;
  pinned: boolean;
  createdAt: number;
  removedAt?: number;
};

export type WorktreeView = { git: WorktreeEntry[]; managed: WorktreeRecord[]; managedRoot: string };

export type WorktreeCreated = { record: WorktreeRecord; workspace: WorkspaceRecord; carriedPatchBytes: number; carriedUntracked: number };

export type WorktreeRemovePreview = {
  path: string;
  branch: string;
  liveSessions: string[];
  dirtyFiles: string[];
  untrackedFiles: string[];
  pinned: boolean;
};

// ---------------------------------------------------------------------------
// Super Thing: long-horizon goals (docs/plans/odyssey.md)
// ---------------------------------------------------------------------------

export type OdysseyState = "draft" | "running" | "waiting_usage" | "paused" | "blocked" | "complete" | "abandoned";
export type StopCondition = "goal_complete" | "milestone_complete" | "manual";
export type OnUsageReset = "continue_automatically" | "notify_only" | "stop";
/** What the runner does with a milestone the agent claims is done but nothing
 *  has checked. `continue` never means verified — the milestone stays
 *  `reported` and the verified count still only counts real evidence. */
export type OnReport = "wait" | "continue";
/** A plan change the agent proposes waits for the user, or lands at once with the diff shown after. */
export type OnPlanChange = "tasks_auto" | "review" | "auto";
/** Which orchestrator a goal runs on. `either` starts where it is and moves
 *  when the account it is on is spent; the other two pin it. */
/** Who runs a Super Thing goal. Gemini cannot lead (it takes no session MCP server). */
export type Orchestrator = "claude" | "codex" | "either";

/** What the Claude account said about itself when it was last asked.
 *  There is no usage endpoint on that side: this is the adapter's own answer
 *  to a catalog probe, or the rate-limit error a refused prompt returned. */
export type ClaudeAccountStatus = {
  available: boolean;
  resetAtUnix?: number;
  message?: string;
  /** Why it could not be asked. An unaskable account is treated as available. */
  problem?: string;
};
export type PlanChangeState = "proposed" | "applied" | "rejected";
export type QuestionState = "open" | "answered" | "dismissed";

/** A plan change the agent proposed (docs/plans/odyssey.md §11.9). */
export type PlanChangeRecord = {
  id: string;
  odysseyId: string;
  at: number;
  /** The operations, JSON as the renderer wrote them. */
  ops: string;
  /** The diff, one line per operation. */
  summary: string;
  reason?: string;
  state: PlanChangeState;
  decidedAt?: number;
  decisionNote?: string;
};

/** A decision the agent handed to the user (docs/plans/odyssey.md §11.10). */
export type QuestionRecord = {
  id: string;
  odysseyId: string;
  at: number;
  kind: string;
  question: string;
  options: string[];
  /** What the agent does until it hears back. */
  fallback?: string;
  state: QuestionState;
  answer?: string;
  answeredAt?: number;
};
export type NewQuestion = { odysseyId: string; kind: string; question: string; options: string[]; fallback?: string };
export type MilestoneState = "planned" | "active" | "reported" | "verified" | "failed" | "skipped";
/** How a milestone's completion is decided. `manual` means only the user can. */
export type CheckKind = "manual" | "command" | "files_exist" | "tests_pass";
/** Which lane produced a check's evidence; they are not equally strong. */
export type CheckSource = "desktop" | "agent_tool_result" | "user";
export type StepState = "pending" | "in_progress" | "done" | "blocked";
export type JournalKind = "continuation" | "briefing" | "report" | "checkpoint" | "check" | "wait" | "resume" | "guard" | "state" | "plan";

export type OdysseyRecord = {
  id: string;
  workspaceId: string;
  sessionId?: string;
  title: string;
  brief: string;
  state: OdysseyState;
  stopCondition: StopCondition;
  onUsageReset: OnUsageReset;
  onReport: OnReport;
  /** Minutes of no events at all before a running turn is cancelled as dead.
   *  0 never cancels. */
  deadTurnMinutes: number;
  maxContinuations: number;
  continuationsUsed: number;
  tokenBudget?: number;
  tokensUsed: number;
  /** The document this goal's plan was read from, when one was given. The text
   *  itself is not in the view; `odysseyPlanDocument` reads it on demand. */
  planSource?: string;
  planDocumentBytes?: number;
  /** Workspace-relative path to the document, when the agent can open it. */
  planPath?: string;
  /** The project's test command: what the planner is told to use as each
   *  milestone's check when the document names nothing better. */
  defaultCheck?: string;
  onPlanChange: OnPlanChange;
  /** Which orchestrator this goal runs on, and whether it may move accounts. */
  orchestrator: Orchestrator;
  createdAt: number;
  updatedAt: number;
};

export type OdysseyStep = {
  id: string;
  milestoneId: string;
  position: number;
  title: string;
  state: StepState;
  note: string;
  detail: string;
  /** The subagent named for this task, by the agent or matched by the desktop. */
  agentName?: string;
  /** What the desktop saw that subagent running on: evidence, not the agent's word. */
  harness?: string;
  model?: string;
  /** Step ids this task waits for. */
  dependsOn: string[];
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
};

export type StepEdit = { title?: string; detail?: string; dependsOn?: string[] };

export type MilestoneRecord = {
  id: string;
  odysseyId: string;
  position: number;
  title: string;
  detail: string;
  state: MilestoneState;
  checkKind: CheckKind;
  checkSpec?: string;
  checkRanAt?: number;
  checkPassed?: boolean;
  checkOutput?: string;
  checkSource?: CheckSource;
  verifiedAt?: number;
  /** The model's own last claim about this milestone, kept as a claim. */
  reportedNote?: string;
  /** Where in the plan document this came from: a heading or a line range. */
  section?: string;
  steps: OdysseyStep[];
};

/** How far an amendment has got: queued, carried to the model, acted on. */
export type AmendmentState = "pending" | "told" | "applied" | "discarded";

/** A workspace-relative file or folder the agent can open for itself. */
export type AmendmentRef = { path: string; kind: string; detail: string };

/** Something the user wants folded into a goal that is already running. */
export type AmendmentRecord = {
  id: string;
  odysseyId: string;
  at: number;
  note: string;
  /** Only for a document outside the workspace, which is inlined in the prompt. */
  documentSource?: string;
  documentBytes?: number;
  refs: AmendmentRef[];
  state: AmendmentState;
  /** How many prompts have carried it; repeating is bounded. */
  tellCount: number;
  /** The goal's `continuationsUsed` when it was last carried. */
  toldAtContinuation?: number;
  toldAt?: number;
  settledAt?: number;
  /** `change` expects a plan change back and is re-told until one comes;
   *  `note` is an instruction, carried once and closed as delivered. Absent
   *  on rows from before the distinction: a change. */
  kind?: "change" | "note";
};

export type NewAmendment = {
  odysseyId: string;
  note: string;
  document?: string;
  documentSource?: string;
  refs: AmendmentRef[];
  kind?: "change" | "note";
};

/** What a desktop-run check reported (`odyssey_run_check`). */
export type CheckOutcome = {
  passed: boolean;
  exitCode?: number;
  /** One line for the badge: what ran and how it ended. */
  summary: string;
  /** The bounded tail kept as evidence. */
  output: string;
  durationMs: number;
  timedOut: boolean;
};

/** Where a plan document ended up, and whether it had to be copied in. */
export type AdoptedPlan = { path: string; copied: boolean };

export type RunCheckResponse = { outcome: CheckOutcome; milestone: MilestoneRecord };

/** Where the `super-thing` skill landed, and whether this call wrote it. */
export type SkillInstall = { path: string; changed: boolean };

export type OdysseyJournalEntry = {
  id: string;
  odysseyId: string;
  at: number;
  kind: JournalKind;
  milestoneId?: string;
  baselineId?: string;
  summary: string;
  detail?: string;
};

export type OdysseyView = { goal: OdysseyRecord; milestones: MilestoneRecord[]; journal: OdysseyJournalEntry[] };

export type NewOdyssey = {
  workspaceId: string;
  /** The agent's id for the session. The native side resolves it to the desktop
   *  session row the goal's foreign key points at. */
  agentSessionId?: string;
  /** The provider that session runs on, for a session with no record yet. */
  provider?: Provider;
  title: string;
  brief: string;
  stopCondition: StopCondition;
  onUsageReset: OnUsageReset;
  onReport?: OnReport;
  maxContinuations: number;
  tokenBudget?: number;
  /** A plan document to hand to the model, and where it came from. Super Thing
   *  never reads it for milestones; the session's model proposes those. */
  planSource?: string;
  planDocument?: string;
  planPath?: string;
  defaultCheck?: string;
};

/** Absent fields are left as they are; `tokenBudget: null` clears the budget. */
export type GoalEdit = {
  title?: string;
  brief?: string;
  stopCondition?: StopCondition;
  onUsageReset?: OnUsageReset;
  onReport?: OnReport;
  deadTurnMinutes?: number;
  maxContinuations?: number;
  tokenBudget?: number | null;
  /** `null` clears it. */
  defaultCheck?: string | null;
  onPlanChange?: OnPlanChange;
  orchestrator?: Orchestrator;
};

export type MilestoneEdit = { title?: string; detail?: string; checkKind?: CheckKind; checkSpec?: string | null; section?: string | null };

/** Workspace-relative path of the handoff note the agent keeps for a run. */
export const ODYSSEY_STATE_NOTE = "docs/super-thing/STATE.md";
/** Workspace-relative directory subagents write their results into. */
export const ODYSSEY_AGENT_NOTES_DIR = "docs/super-thing/agents";

/** One file a run has written into the workspace, with its age. */
export type NoteInfo = { path: string; bytes: number; modifiedAtUnixMs: number };
export type WorkspaceNotes = { state?: NoteInfo; agentNotes: NoteInfo[] };

/** A per-turn checkpoint: the tree now against the tree at the previous one. */
export type OdysseyCheckpointFile = { path: string; kind: "added" | "modified" | "deleted" | "renamed" | "mode_changed"; additions: number; deletions: number };
export type OdysseyCheckpoint = {
  /** Every path with its content hash, hashed: equal means an identical tree. */
  treeHash: string;
  fileCount: number;
  /** No earlier checkpoint existed for this goal, so nothing is "changed". */
  first: boolean;
  changed: number;
  additions: number;
  deletions: number;
  /** The list below was cut; `changed` is still exact. */
  truncated: boolean;
  files: OdysseyCheckpointFile[];
};

/** One reading of the usage windows with the session's token counters. */
export type NewUsageSample = {
  odysseyId: string;
  primaryUsedPercent?: number;
  primaryResetAt?: number;
  secondaryUsedPercent?: number;
  secondaryResetAt?: number;
  calls: number;
  paidInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};
export type UsageSampleRecord = NewUsageSample & { id: number; at: number };

export type SpendVerdict = "cached_counts" | "cached_free" | "output_only" | "inconclusive" | "insufficient";
export type SpendHypothesis = { verdict: SpendVerdict; counts: string; tokensPerPercent?: number; rmse: number };
/** What a run's usage samples say the subscription window charges. */
export type SpendModel = { samples: number; pairs: number; hypotheses: SpendHypothesis[]; verdict: SpendVerdict; note: string };

export type EditorProfile = "vscode" | "rider" | "cursor" | "system";

// ---------------------------------------------------------------------------
// Terminals, history, outbox (TERM, REC)
// ---------------------------------------------------------------------------

export type TerminalInfo = {
  id: string;
  cwd: string;
  program: string;
  cols: number;
  rows: number;
  exited: boolean;
  exitCode: number | null;
  pid: number | null;
};

export type TerminalEvent = { type: "output"; dataBase64: string } | { type: "exit"; code: number | null };

export type TerminalOpened = { info: TerminalInfo; workspaceId: string; environmentNote: string };

export type OpenSessionEntry = { handle: SessionHandle; workspaceId: string | null; root: string; agentSessionId: string };

export type OutboxRecord = {
  requestId: string;
  sessionId: string;
  contentHash: string;
  payloadRef: string;
  state: SubmissionState;
  generation: DecimalId;
  message?: string;
  createdAt: number;
  updatedAt: number;
};

export type OutboxEntry = { record: OutboxRecord; agentSessionId: string | null; text: string | null };

// ---------------------------------------------------------------------------
// Context sources and integration configuration (CTX-01, CFG-04..11)
// ---------------------------------------------------------------------------

export type SkillScope = "project" | "user";
export type SkillEntry = {
  directoryName: string;
  scope: SkillScope;
  path: string;
  name?: string;
  description?: string;
  bytes: number;
  contentHash: string;
  resources: string[];
  problems: string[];
  shadows?: SkillScope;
  shadowed: boolean;
};
export type SkillFrontmatter = { name?: string; description?: string; other: Record<string, string>; problems: string[] };
/** An instruction file an agent reads at session start. `readBy` lists the
 *  providers whose convention it is (`AGENTS.md` is Codex's, `CLAUDE.md` Claude Code's). */
export type InstructionFile = { path: string; bytes: number; contentHash: string; depth: number; readBy: Provider[] };
export type ContextSources = {
  root: string;
  instructionFiles: InstructionFile[];
  skills: SkillEntry[];
  notes: string[];
};
export type InstructionFileName = "AGENTS.md" | "CLAUDE.md";
export type ConfigTarget =
  | { kind: "instructions"; workspaceId: string; file: InstructionFileName }
  | { kind: "skill"; scope: SkillScope; workspaceId: string | null; directoryName: string };
export type ConfigFile = {
  path: string;
  exists: boolean;
  language: "markdown";
  content: string;
  contentHash?: string;
  skill?: SkillFrontmatter;
};
export type ConfigWriteOutcome = { path: string; contentHash: string; status: "saved_pending_reload" };
export type ImportedSkill = {
  directoryName: string;
  stagedSubpath: string;
  frontmatter: SkillFrontmatter;
  files: string[];
  bytes: number;
  problems: string[];
  collidesWith?: SkillScope;
  shadowsOrShadowedBy?: SkillScope;
};
export type ImportPlan = { stagingId: string; source: string; sourceKind: string; skills: ImportedSkill[]; rejected: string[]; totalBytes: number; entries: number };
export type AppliedSkill = { directoryName: string; path: string; replaced: boolean; backup?: string };
export type RemovedSkill = { directoryName: string; path: string; backup?: string };

/** Content Credentials (C2PA) read from a generated image. */
export type ContentCredentials = { generator?: string; generatorVersion?: string; claimGenerator?: string; created?: string };
export type WorkspaceImage = { relative: string; absolutePath: string; mime: string; width: number; height: number; bytes: number; dataBase64: string; credentials?: ContentCredentials };
export type RuntimeEnvInfo = { names: string[]; available: boolean; backend: string };

/** A reusable, user-authored context selection (CTX-04). Stored locally. */
export type ContextBundle = { id: string; name: string; instructions: string; refs: Mention[] };

// ---------------------------------------------------------------------------
// Attachments and mentions (UX-06, UX-07)
// ---------------------------------------------------------------------------

export type MediaKind = "image" | "audio";
export type AttachmentSnapshot = {
  id: string;
  name: string;
  mime: string;
  kind: MediaKind;
  bytes: number;
  width?: number;
  height?: number;
  blobPath: string;
  sourcePath?: string;
};
export type AttachmentPreview = { id: string; mime: string; dataBase64: string };
export type MentionMode = { mode: "path_reference" } | { mode: "copied_content"; startLine?: number; endLine?: number };
export type Mention = { relativePath: string; mode: MentionMode };
export type FileSearchResult = { matches: string[]; truncated: boolean };

// ---------------------------------------------------------------------------
// Artifacts (ART-01..04)
// ---------------------------------------------------------------------------

export type Provenance = "runtime_reported" | "observed";
export type ArtifactViewer = "text" | "markdown" | "json" | "code" | "image" | "markup_source" | "external";
export type ArtifactRecord = {
  id: string;
  workspaceId: string;
  environmentId: string;
  agentSessionId?: string;
  callId?: string;
  logicalPath: string;
  mime: string;
  viewer: ArtifactViewer;
  contentHash: string;
  bytes: number;
  provenance: Provenance;
  sourcePath: string;
  previousId?: string;
  version: number;
  createdAt: number;
};
export type ArtifactContent = {
  record: ArtifactRecord;
  text?: string;
  dataBase64?: string;
  width?: number;
  height?: number;
  truncated: boolean;
  unavailable?: string;
};
export type ArtifactsRefreshOutcome = { scanned: number; newVersions: number; artifacts: ArtifactRecord[]; notes: string[] };
export type ExportManifestEntry = {
  id: string;
  logicalPath: string;
  exportedAs: string;
  contentHash: string;
  bytes: number;
  mime: string;
  provenance: Provenance;
  callId?: string;
  agentSessionId?: string;
  version: number;
  createdAt: number;
};
export type ExportOutcome = { directory: string | null; written: ExportManifestEntry[]; excluded: { id: string; reason: string }[]; sensitiveHits: number };

// ---------------------------------------------------------------------------
// Support and storage (REL-06, section 15.2)
// ---------------------------------------------------------------------------

export type StorageEntry = { name: string; path: string; bytes: number; policy: string };
export type StorageReport = { dataDir: string; entries: StorageEntry[]; attachments: number; artifactVersions: number; notes: string[] };
export type CleanupCandidate = { kind: string; path: string; bytes: number; reason: string };

/** Token usage aggregated from the agent's canonical transcript (CTX-03). */
export type UsageCall = {
  generation: number;
  itemId: string;
  kind: string;
  /** Further transcript items that repeated this response's usage object. */
  foldedItemIds?: string[];
  createdAt?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  contextWindow?: number;
  cost?: unknown;
  /** Re-sent prefix this call could have had from cache but did not. Absent on
   *  the first call of a session and when no cached figure was reported. */
  missedPrefixTokens?: number;
};
export type UsageTotals = {
  /** Model responses, not transcript items. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  /** Items folded into an earlier call because they repeated its usage. */
  foldedItems: number;
  /** Input the provider did not serve from its prompt cache. */
  paidInputTokens: number;
  /** Prefix re-sent after an earlier call already sent it: the ceiling on what
   *  caching could save. */
  cacheablePrefixTokens: number;
  /** Cacheable prefix the provider did not serve from cache. */
  missedPrefixTokens: number;
  /** A call reported no cached figure, so the three above are estimates. */
  cachePartial: boolean;
  partial: boolean;
};
/** One window of an account's percentage rate limit (5-hour or weekly). */
export type UsageWindow = { usedPercent: number; windowSeconds: number; resetAfterSeconds?: number; resetAtUnix?: number };
/** Account-wide subscription status, for a provider that reports its windows
 *  as percentages (Codex). Derived from the provider's own quota events. */
export type UsageSnapshot = {
  fetchedAtUnixMs: number;
  planType?: string;
  email?: string;
  allowed: boolean;
  limitReached: boolean;
  primary?: UsageWindow;
  secondary?: UsageWindow;
  creditsBalance?: string;
  rateLimitReachedType?: string;
};
export type TranscriptUsage = { path: string; bytes: number; lines: number; parseErrors: number; schemaVersions: number[]; calls: UsageCall[]; totals: UsageTotals };

/** Defaults applied to new sessions, captured from the last picker change. */
export type SessionDefaults = { provider?: Provider; model?: string; reasoningEffort?: string };

/** Local UI preferences (non-secret). */
export type UiPrefs = { enterSends: boolean; reducedMotion: "system" | "reduce"; transcriptPage: number };

export type DiffResponse = { report: DiffReport; baseline?: BaselineRecord; isGitRepository: boolean };

// ---------------------------------------------------------------------------
// Desktop preferences (UX-10, ARCH-02)
// ---------------------------------------------------------------------------

export type CloseBehavior = "ask" | "tray" | "quit";

export type NotificationSettings = {
  /** Master switch; OS permission is requested contextually when first needed. */
  enabled: boolean;
  notifyCompleted: boolean;
  notifyFailed: boolean;
  notifyNeedsInput: boolean;
  /** Local time "HH:MM"; when start == end quiet hours are off. Wraps midnight. */
  quietHoursStart: string;
  quietHoursEnd: string;
  mutedWorkspaceIds: string[];
  closeBehavior: CloseBehavior;
  /** Super Thing defaults for a new goal; a goal keeps the ceiling it was made with. */
  odysseyMaxContinuations: number;
  odysseyTokenBudget?: number;
  /** The model a Claude orchestrator runs on, by the adapter's own selection
   *  id, and the effort it runs at. Absent means the built-in preference. */
  claudeOrchestratorModel?: string;
  claudeOrchestratorEffort?: string;
};

/** One model the Claude adapter offers, as the picker lists it. */
export type ClaudeModelChoice = { value: string; name: string; description?: string; needsCredits: boolean };

/**
 * What a Claude session runs on when nothing overrides it
 * (docs/plans/odyssey-second-orchestrator.md §12.9).
 *
 * `claude-fable-5-1` is Fable's selection id as claude-agent-acp 0.84 lists
 * it. Where it cannot be selected the session lands on the fallback, the
 * adapter's current Opus.
 */
export const CLAUDE_ORCHESTRATOR_MODEL = "claude-fable-5-1";
/** Where an orchestrator lands when the preferred model cannot be selected. */
export const CLAUDE_ORCHESTRATOR_FALLBACK = "opus";
export const CLAUDE_ORCHESTRATOR_EFFORT = "high";
/** Subagents raised by a Claude orchestrator. Never Fable: see above. */
export const CLAUDE_SUBAGENT_MODEL = "opus";

/** The agent definition a Claude orchestrator raises its delegates with. Its
 *  `model:` field is the only place a Claude subagent's model can be pinned. */
export const ODYSSEY_DELEGATE = "super-thing-delegate";

/** What a provider's sign-in program printed, streamed as it runs. */
export type LoginEvent =
  | { type: "started"; pid: number | null }
  | { type: "line"; stream: "stdout" | "stderr"; text: string }
  | { type: "url"; url: string }
  | { type: "exited"; status: number | null; success: boolean; cancelled: boolean; timedOut: boolean };

export type OpenResponse = { handle: SessionHandle; desktopSessionId: string; snapshot: Snapshot };

/** Command names exposed by the Tauri host. */
export const COMMANDS = {
  executionProfiles: "execution_profiles",
  workspaceInspect: "workspace_inspect",
  workspaceTrust: "workspace_trust",
  workspaceList: "workspace_list",
  sessionOpen: "session_open",
  sessionSubscribe: "session_subscribe",
  sessionSnapshot: "session_snapshot",
  sessionSubmit: "session_submit",
  sessionSteer: "session_steer",
  sessionCancel: "session_cancel",
  sessionSetConfigOption: "session_set_config_option",
  sessionStop: "session_stop",
  sessionListOpen: "session_list_open",
  sessionArchive: "session_archive",
  sessionPin: "session_pin",
  sessionRename: "session_rename",
  odysseyReadPlan: "odyssey_read_plan",
  odysseyAdoptPlan: "odyssey_adopt_plan",
  odysseyForSession: "odyssey_for_session",
  odysseyRepoint: "odyssey_repoint",
  odysseyClaudePreflight: "odyssey_claude_preflight",
  odysseyInstallDelegate: "odyssey_install_delegate",
  odysseyView: "odyssey_view",
  odysseyList: "odyssey_list",
  odysseyCreate: "odyssey_create",
  odysseyEditGoal: "odyssey_edit_goal",
  odysseyDelete: "odyssey_delete",
  odysseyAddMilestone: "odyssey_add_milestone",
  odysseyEditMilestone: "odyssey_edit_milestone",
  odysseyReorderMilestones: "odyssey_reorder_milestones",
  odysseyDeleteMilestone: "odyssey_delete_milestone",
  odysseySetState: "odyssey_set_state",
  odysseyRecordContinuation: "odyssey_record_continuation",
  odysseySetMilestoneState: "odyssey_set_milestone_state",
  odysseyRecordReport: "odyssey_record_report",
  odysseyRecordCheck: "odyssey_record_check",
  odysseyRunCheck: "odyssey_run_check",
  odysseyInstallSkill: "odyssey_install_skill",
  odysseySetPlan: "odyssey_set_plan",
  odysseyPlanDocument: "odyssey_plan_document",
  odysseyInspectRefs: "odyssey_inspect_refs",
  odysseyAmendAdd: "odyssey_amend_add",
  odysseyAmendList: "odyssey_amend_list",
  odysseyAmendDocument: "odyssey_amend_document",
  odysseyAmendSetState: "odyssey_amend_set_state",
  odysseyAmendMarkTold: "odyssey_amend_mark_told",
  odysseyJournalAppend: "odyssey_journal_append",
  odysseyAddStep: "odyssey_add_step",
  odysseySetStepState: "odyssey_set_step_state",
  odysseyDeleteStep: "odyssey_delete_step",
  odysseyEditStep: "odyssey_edit_step",
  odysseyAssignStep: "odyssey_assign_step",
  odysseyReorderSteps: "odyssey_reorder_steps",
  odysseyPlanChangeAdd: "odyssey_plan_change_add",
  odysseyPlanChangeList: "odyssey_plan_change_list",
  odysseyPlanChangeDecide: "odyssey_plan_change_decide",
  odysseyQuestionAdd: "odyssey_question_add",
  odysseyQuestionList: "odyssey_question_list",
  odysseyQuestionSettle: "odyssey_question_settle",
  odysseyCheckpoint: "odyssey_checkpoint",
  odysseyUsageSampleAdd: "odyssey_usage_sample_add",
  odysseySpendModel: "odyssey_spend_model",
  odysseyWorkspaceNotes: "odyssey_workspace_notes",
  sessionRecords: "session_records",
  openExternal: "open_external",
  providersStatus: "providers_status",
  providerSetLocation: "provider_set_location",
  providerLoginStart: "provider_login_start",
  providerLoginCancel: "provider_login_cancel",
  providerModels: "provider_models",
  providerQuota: "provider_quota",
  providerLogout: "provider_logout",
  delegationComboGet: "delegation_combo_get",
  delegationComboSet: "delegation_combo_set",
  delegationDefaultComboGet: "delegation_default_combo_get",
  delegationDefaultComboSet: "delegation_default_combo_set",
  delegationJobs: "delegation_jobs",
  delegationJobCancel: "delegation_job_cancel",
  delegationQuota: "delegation_quota",
  delegationJobRetry: "delegation_job_retry",
  delegationRetryPolicyGet: "delegation_retry_policy_get",
  delegationRetryPolicySet: "delegation_retry_policy_set",
  workspacePick: "workspace_pick",
  revealInFinder: "reveal_in_finder",
  settingsGet: "settings_get",
  settingsSet: "settings_set",
  appHideToTray: "app_hide_to_tray",
  appQuit: "app_quit",
  confirmDialog: "confirm_dialog",
  appActivity: "app_activity",
  workspaceListDir: "workspace_list_dir",
  fileRead: "file_read",
  fileWriteChecked: "file_write_checked",
  reviewCaptureBaseline: "review_capture_baseline",
  reviewBaselines: "review_baselines",
  reviewDiff: "review_diff",
  gitInfo: "git_info",
  gitStage: "git_stage",
  gitUnstage: "git_unstage",
  gitRevertFile: "git_revert_file",
  gitApplyHunk: "git_apply_hunk",
  gitCommit: "git_commit",
  gitPush: "git_push",
  reviewFileVersions: "review_file_versions",
  worktreeList: "worktree_list",
  worktreeCreate: "worktree_create",
  worktreeRemovePreview: "worktree_remove_preview",
  worktreeRemove: "worktree_remove",
  worktreePin: "worktree_pin",
  openInEditor: "open_in_editor",
  sessionHistory: "session_history",
  sessionTokenUsage: "session_token_usage",
  outboxList: "outbox_list",
  outboxResolve: "outbox_resolve",
  terminalOpen: "terminal_open",
  terminalList: "terminal_list",
  terminalSubscribe: "terminal_subscribe",
  terminalWrite: "terminal_write",
  terminalResize: "terminal_resize",
  terminalClose: "terminal_close",
  terminalExport: "terminal_export",
  saveTextFile: "save_text_file",
  contextSources: "context_sources_for_workspace",
  configReadFile: "config_read_file",
  configWriteFile: "config_write_file",
  skillCreate: "skill_create",
  skillImportPick: "skill_import_pick",
  skillImportFromPaths: "skill_import_from_paths",
  skillImportAnnotate: "skill_import_annotate",
  skillImportApply: "skill_import_apply",
  skillImportDiscard: "skill_import_discard",
  skillRemove: "skill_remove",
  runtimeEnvList: "runtime_env_list",
  runtimeEnvSet: "runtime_env_set",
  runtimeEnvRemove: "runtime_env_remove",
  workspaceImage: "workspace_image",
  generatedImage: "generated_image",
  workspaceRemove: "workspace_remove",
  attachmentPick: "attachment_pick",
  attachmentAddPaths: "attachment_add_paths",
  attachmentAddBytes: "attachment_add_bytes",
  attachmentPreview: "attachment_preview",
  workspaceSearchFiles: "workspace_search_files",
  artifactsRefresh: "artifacts_refresh",
  artifactsList: "artifacts_list",
  artifactRead: "artifact_read",
  artifactsExportPreview: "artifacts_export_preview",
  artifactsExport: "artifacts_export",
  supportBundlePreview: "support_bundle_preview",
  storageInspect: "storage_inspect",
  cleanupPreview: "cleanup_preview",
  cleanupRun: "cleanup_run",
  prefGet: "pref_get",
  prefSet: "pref_set",
} as const;

export type CommandName = (typeof COMMANDS)[keyof typeof COMMANDS];
