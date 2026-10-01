/**
 * Typed client for the narrow Tauri command surface (spec section 20.1).
 *
 * Every call resolves with a typed result or rejects with a `DesktopError`.
 * There is no generic invoke passthrough: the renderer can only call the
 * commands enumerated in `@thingmaker/contracts`.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  COMMANDS,
  isDesktopError,
  type Combo,
  type JobView,
  type JobRetryPolicy,
  type AttachmentPreview,
  type GoalEdit,
  type MilestoneEdit,
  type MilestoneRecord,
  type NewOdyssey,
  type OdysseyRecord,
  type CheckSource,
  type JournalKind,
  type MilestoneState,
  type OdysseyJournalEntry,
  type OdysseyState,
  type OdysseyStep,
  type NewQuestion,
  type PlanChangeRecord,
  type PlanChangeState,
  type QuestionRecord,
  type QuestionState,
  type StepEdit,
  type OdysseyView,
  type AdoptedPlan,
  type AmendmentRecord,
  type AmendmentRef,
  type AmendmentState,
  type NewAmendment,
  type RunCheckResponse,
  type SkillInstall,
  type StepState,
  type BaselineRecord,
  type CommitOutcome,
  type DiffResponse,
  type EditorProfile,
  type EventEnvelope as EventEnvelopeType,
  type FileVersions,
  type OpenSessionEntry,
  type OutboxEntry,
  type AppliedSkill,
  type RemovedSkill,
  type RuntimeEnvInfo,
  type ClaudeAccountStatus,
  type WorkspaceImage,
  type ImportPlan,
  type ArtifactContent,
  type ArtifactRecord,
  type ArtifactsRefreshOutcome,
  type AttachmentSnapshot,
  type CleanupCandidate,
  type ConfigFile,
  type ConfigTarget,
  type ConfigWriteOutcome,
  type ContextSources,
  type ExportOutcome,
  type FileSearchResult,
  type Mention,
  type SkillScope,
  type StorageReport,
  type TranscriptUsage,
  type TerminalEvent,
  type TerminalInfo,
  type TerminalOpened,
  type RepositoryInfo,
  type WorktreeCreated,
  type WorktreeRemovePreview,
  type WorktreeView,
  type DiffScope,
  type DirEntry,
  type FileRead,
  type WriteOutcome,
  type NotificationSettings,
  type DesktopError,
  type EventEnvelope,
  type ExitInfo,
  type OpenResponse,
  type ProfileInfo,
  type SessionHandle,
  type SessionRecord,
  type Snapshot,
  type SteerOutcome,
  type SubmissionOutcome,
  type TrustState,
  type WorkspaceInspection,
  type WorkspaceRecord,
  type NewUsageSample,
  type OdysseyCheckpoint,
  type SpendModel,
  type UsageSampleRecord,
  type WorkspaceNotes,
  type LoginEvent,
  type Provider,
  type ProviderInfo,
  type ProviderLocation,
  type ProviderModel,
  type QuotaSnapshot,
} from "@thingmaker/contracts";

function toDesktopError(error: unknown): DesktopError {
  if (isDesktopError(error)) return error;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  return { code: "IO", message, retry: "user_action" };
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toDesktopError(error);
  }
}

export type OpenRequest = {
  workspaceId: string;
  mode: { mode: "new" } | { mode: "resume"; session_id: string };
  /** Which provider to launch. On a resume the session's own record wins. */
  provider?: Provider;
  model?: string;
  reasoningEffort?: string;
  /** The team the session starts with; absent keeps its own, or the default. */
  combo?: Combo;
};

export const api = {
  executionProfiles: () => call<ProfileInfo[]>(COMMANDS.executionProfiles),
  workspaceInspect: (path: string) => call<WorkspaceInspection>(COMMANDS.workspaceInspect, { path }),
  workspaceTrust: (workspaceId: string, state: TrustState, trustDigest: string) =>
    call<WorkspaceInspection>(COMMANDS.workspaceTrust, { request: { workspaceId, state, trustDigest } }),
  workspaceList: () => call<WorkspaceRecord[]>(COMMANDS.workspaceList),
  sessionOpen: (request: OpenRequest) => call<OpenResponse>(COMMANDS.sessionOpen, { request }),
  sessionSubscribe: (handle: SessionHandle, onEvent: (event: EventEnvelope) => void) => {
    const channel = new Channel<EventEnvelope>();
    channel.onmessage = onEvent;
    return call<void>(COMMANDS.sessionSubscribe, { handle, onEvent: channel });
  },
  sessionSnapshot: (handle: SessionHandle) => call<Snapshot>(COMMANDS.sessionSnapshot, { handle }),
  sessionSubmit: (handle: SessionHandle, requestId: string, text: string, attachmentIds: string[] = [], mentions: Mention[] = []) =>
    call<{ requestId: string; outcome: SubmissionOutcome }>(COMMANDS.sessionSubmit, {
      request: { handle, requestId, text, attachmentIds, mentions },
    }),
  sessionSteer: (handle: SessionHandle, text: string) =>
    call<SteerOutcome>(COMMANDS.sessionSteer, { request: { handle, text } }),
  sessionCancel: (handle: SessionHandle) => call<void>(COMMANDS.sessionCancel, { handle }),
  sessionSetConfigOption: (handle: SessionHandle, configId: string, value: unknown) =>
    call<unknown>(COMMANDS.sessionSetConfigOption, { request: { handle, configId, value } }),
  sessionStop: (handle: SessionHandle) => call<ExitInfo>(COMMANDS.sessionStop, { handle }),
  sessionListOpen: () => call<OpenSessionEntry[]>(COMMANDS.sessionListOpen),
  sessionHistory: (handle: SessionHandle, after: string, limit = 20000) =>
    call<EventEnvelopeType[]>(COMMANDS.sessionHistory, { request: { handle, after, limit } }),
  sessionTokenUsage: (workspaceId: string, agentSessionId: string) =>
    call<TranscriptUsage>(COMMANDS.sessionTokenUsage, { request: { workspaceId, agentSessionId } }),
  outboxList: (workspaceId: string) => call<OutboxEntry[]>(COMMANDS.outboxList, { workspaceId }),
  outboxResolve: (requestId: string, reason: string) => call<void>(COMMANDS.outboxResolve, { request: { requestId, reason } }),
  terminalOpen: (workspaceId: string, cols: number, rows: number) => call<TerminalOpened>(COMMANDS.terminalOpen, { request: { workspaceId, cols, rows } }),
  terminalList: () => call<{ info: TerminalInfo; workspaceId: string | null }[]>(COMMANDS.terminalList),
  terminalSubscribe: (id: string, onEvent: (event: TerminalEvent) => void) => {
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = onEvent;
    return call<void>(COMMANDS.terminalSubscribe, { id, onEvent: channel });
  },
  terminalWrite: (id: string, text: string) => call<void>(COMMANDS.terminalWrite, { request: { id, text } }),
  terminalResize: (id: string, cols: number, rows: number) => call<void>(COMMANDS.terminalResize, { request: { id, cols, rows } }),
  terminalClose: (id: string) => call<void>(COMMANDS.terminalClose, { id }),
  terminalExport: (id: string) => call<string>(COMMANDS.terminalExport, { id }),
  saveTextFile: (suggestedName: string, content: string) => call<string | null>(COMMANDS.saveTextFile, { request: { suggestedName, content } }),
  contextSources: (workspaceId: string) => call<ContextSources>(COMMANDS.contextSources, { workspaceId }),
  configReadFile: (target: ConfigTarget) => call<ConfigFile>(COMMANDS.configReadFile, { target }),
  configWriteFile: (target: ConfigTarget, expectedHash: string | null, content: string) =>
    call<ConfigWriteOutcome>(COMMANDS.configWriteFile, { request: { target, expectedHash, content } }),
  skillCreate: (scope: SkillScope, workspaceId: string | null, directoryName: string) =>
    call<ConfigFile>(COMMANDS.skillCreate, { request: { scope, workspaceId, directoryName } }),
  skillImportPick: (kind: "folder" | "zip", scope: SkillScope, workspaceId: string | null) =>
    call<ImportPlan | null>(COMMANDS.skillImportPick, { request: { kind, scope, workspaceId } }),
  skillImportFromPaths: (paths: string[], scope: SkillScope, workspaceId: string | null) =>
    call<ImportPlan | null>(COMMANDS.skillImportFromPaths, { request: { paths, scope, workspaceId } }),
  skillImportAnnotate: (stagingId: string, scope: SkillScope, workspaceId: string | null) =>
    call<ImportPlan>(COMMANDS.skillImportAnnotate, { request: { stagingId, scope, workspaceId } }),
  skillImportApply: (stagingId: string, selected: string[], scope: SkillScope, workspaceId: string | null, replace: boolean) =>
    call<AppliedSkill[]>(COMMANDS.skillImportApply, { request: { stagingId, selected, scope, workspaceId, replace } }),
  skillImportDiscard: (stagingId: string) => call<void>(COMMANDS.skillImportDiscard, { stagingId }),
  skillRemove: (scope: SkillScope, workspaceId: string | null, directoryName: string, keepBackup: boolean) =>
    call<RemovedSkill>(COMMANDS.skillRemove, { request: { scope, workspaceId, directoryName, keepBackup } }),
  runtimeEnvList: () => call<RuntimeEnvInfo>(COMMANDS.runtimeEnvList),
  runtimeEnvSet: (name: string, value: string) => call<string[]>(COMMANDS.runtimeEnvSet, { name, value }),
  runtimeEnvRemove: (name: string) => call<string[]>(COMMANDS.runtimeEnvRemove, { name }),
  workspaceRemove: (workspaceId: string) => call<void>(COMMANDS.workspaceRemove, { workspaceId }),
  workspaceImage: (workspaceId: string, relative: string) => call<WorkspaceImage>(COMMANDS.workspaceImage, { workspaceId, relative }),
  generatedImage: (path: string) => call<WorkspaceImage>(COMMANDS.generatedImage, { path }),
  attachmentPick: () => call<AttachmentSnapshot[]>(COMMANDS.attachmentPick),
  attachmentAddPaths: (paths: string[]) => call<AttachmentSnapshot[]>(COMMANDS.attachmentAddPaths, { request: { paths } }),
  attachmentAddBytes: (name: string, dataBase64: string) => call<AttachmentSnapshot>(COMMANDS.attachmentAddBytes, { request: { name, dataBase64 } }),
  attachmentPreview: (id: string) => call<AttachmentPreview>(COMMANDS.attachmentPreview, { request: { id } }),
  workspaceSearchFiles: (workspaceId: string, query: string, limit = 20) =>
    call<FileSearchResult>(COMMANDS.workspaceSearchFiles, { request: { workspaceId, query, limit } }),
  artifactsRefresh: (workspaceId: string, agentSessionId: string | null) =>
    call<ArtifactsRefreshOutcome>(COMMANDS.artifactsRefresh, { request: { workspaceId, agentSessionId } }),
  artifactsList: (workspaceId: string, agentSessionId: string | null) => call<ArtifactRecord[]>(COMMANDS.artifactsList, { workspaceId, agentSessionId }),
  artifactRead: (id: string) => call<ArtifactContent>(COMMANDS.artifactRead, { id }),
  artifactsExportPreview: (ids: string[]) => call<ExportOutcome>(COMMANDS.artifactsExportPreview, { request: { ids } }),
  artifactsExport: (ids: string[]) => call<ExportOutcome>(COMMANDS.artifactsExport, { request: { ids } }),
  supportBundlePreview: () => call<unknown>(COMMANDS.supportBundlePreview),
  storageInspect: () => call<StorageReport>(COMMANDS.storageInspect),
  cleanupPreview: () => call<CleanupCandidate[]>(COMMANDS.cleanupPreview),
  cleanupRun: (paths: string[]) => call<CleanupCandidate[]>(COMMANDS.cleanupRun, { request: { paths } }),
  prefGet: <T>(key: string) => call<T | null>(COMMANDS.prefGet, { key }),
  prefSet: (key: string, value: unknown) => call<void>(COMMANDS.prefSet, { key, value }),
  sessionArchive: (workspaceId: string, agentSessionId: string, archived: boolean, provider?: Provider) =>
    call<void>(COMMANDS.sessionArchive, { request: { workspaceId, agentSessionId, archived, provider } }),
  sessionPin: (workspaceId: string, agentSessionId: string, pinned: boolean, provider?: Provider) =>
    call<void>(COMMANDS.sessionPin, { request: { workspaceId, agentSessionId, pinned, provider } }),
  sessionRename: (workspaceId: string, agentSessionId: string, title: string | null, provider?: Provider) =>
    call<void>(COMMANDS.sessionRename, { request: { workspaceId, agentSessionId, title, provider } }),

  odysseyReadPlan: (path: string) => call<string>(COMMANDS.odysseyReadPlan, { request: { path } }),
  odysseyAdoptPlan: (workspaceId: string, path: string) => call<AdoptedPlan>(COMMANDS.odysseyAdoptPlan, { request: { workspaceId, path } }),
  odysseyRunCheck: (workspaceId: string, milestoneId: string) => call<RunCheckResponse>(COMMANDS.odysseyRunCheck, { request: { workspaceId, milestoneId } }),
  odysseyInstallSkill: () => call<SkillInstall>(COMMANDS.odysseyInstallSkill),
  odysseySetPlan: (id: string, source: string | null, document: string | null) => call<void>(COMMANDS.odysseySetPlan, { request: { id, source, document } }),
  odysseyPlanDocument: (id: string) => call<string | null>(COMMANDS.odysseyPlanDocument, { id }),
  odysseyInspectRefs: (workspaceId: string, paths: string[]) => call<AmendmentRef[]>(COMMANDS.odysseyInspectRefs, { request: { workspaceId, paths } }),
  odysseyAmendAdd: (request: NewAmendment) => call<AmendmentRecord>(COMMANDS.odysseyAmendAdd, { request }),
  odysseyAmendList: (odysseyId: string) => call<AmendmentRecord[]>(COMMANDS.odysseyAmendList, { odysseyId }),
  odysseyAmendDocument: (id: string) => call<string | null>(COMMANDS.odysseyAmendDocument, { id }),
  odysseyAmendSetState: (id: string, state: AmendmentState) => call<void>(COMMANDS.odysseyAmendSetState, { request: { id, state } }),
  odysseyAmendMarkTold: (id: string, continuationsUsed: number) => call<void>(COMMANDS.odysseyAmendMarkTold, { request: { id, continuationsUsed } }),
  odysseyForSession: (workspaceId: string, agentSessionId: string) => call<OdysseyView | null>(COMMANDS.odysseyForSession, { request: { workspaceId, agentSessionId } }),
  odysseyRepoint: (id: string, workspaceId: string, agentSessionId: string, provider?: Provider) =>
    call<OdysseyView>(COMMANDS.odysseyRepoint, { request: { id, workspaceId, agentSessionId, provider } }),
  odysseyClaudePreflight: () => call<ClaudeAccountStatus>(COMMANDS.odysseyClaudePreflight),
  odysseyInstallDelegate: (workspaceId: string) => call<SkillInstall>(COMMANDS.odysseyInstallDelegate, { workspaceId }),
  odysseyView: (id: string) => call<OdysseyView | null>(COMMANDS.odysseyView, { id }),
  odysseyList: (workspaceId: string) => call<OdysseyRecord[]>(COMMANDS.odysseyList, { workspaceId }),
  odysseyCreate: (request: NewOdyssey) => call<OdysseyView>(COMMANDS.odysseyCreate, { request }),
  odysseyEditGoal: (id: string, edit: GoalEdit) => call<OdysseyRecord>(COMMANDS.odysseyEditGoal, { request: { id, ...edit } }),
  odysseyDelete: (id: string) => call<void>(COMMANDS.odysseyDelete, { id }),
  odysseyAddMilestone: (request: { odysseyId: string; title: string; detail?: string; checkKind?: string; checkSpec?: string | null; section?: string | null }) =>
    call<MilestoneRecord>(COMMANDS.odysseyAddMilestone, { request }),
  odysseyEditMilestone: (id: string, edit: MilestoneEdit) => call<MilestoneRecord>(COMMANDS.odysseyEditMilestone, { request: { id, ...edit } }),
  odysseyReorderMilestones: (odysseyId: string, orderedIds: string[]) =>
    call<void>(COMMANDS.odysseyReorderMilestones, { request: { odysseyId, orderedIds } }),
  odysseyDeleteMilestone: (id: string) => call<void>(COMMANDS.odysseyDeleteMilestone, { id }),
  odysseySetState: (id: string, state: OdysseyState) => call<void>(COMMANDS.odysseySetState, { request: { id, state } }),
  odysseyRecordContinuation: (id: string, tokens: number) => call<void>(COMMANDS.odysseyRecordContinuation, { request: { id, tokens } }),
  odysseySetMilestoneState: (id: string, state: MilestoneState) => call<void>(COMMANDS.odysseySetMilestoneState, { request: { id, state } }),
  odysseyRecordReport: (id: string, note: string) => call<void>(COMMANDS.odysseyRecordReport, { request: { id, note } }),
  odysseyRecordCheck: (id: string, passed: boolean, output: string, source: CheckSource) =>
    call<MilestoneRecord>(COMMANDS.odysseyRecordCheck, { request: { id, passed, output, source } }),
  odysseyJournalAppend: (request: { odysseyId: string; kind: JournalKind; milestoneId?: string | null; baselineId?: string | null; summary: string; detail?: string | null }) =>
    call<OdysseyJournalEntry>(COMMANDS.odysseyJournalAppend, { request }),
  odysseyAddStep: (milestoneId: string, title: string, detail = "", dependsOn: string[] = []) =>
    call<OdysseyStep>(COMMANDS.odysseyAddStep, { request: { milestoneId, title, detail, dependsOn } }),
  odysseyEditStep: (id: string, edit: StepEdit) => call<OdysseyStep>(COMMANDS.odysseyEditStep, { request: { id, ...edit } }),
  odysseyAssignStep: (id: string, agentName: string | null, harness: string | null, model: string | null) =>
    call<void>(COMMANDS.odysseyAssignStep, { request: { id, agentName, harness, model } }),
  odysseyReorderSteps: (milestoneId: string, orderedIds: string[]) => call<void>(COMMANDS.odysseyReorderSteps, { request: { milestoneId, orderedIds } }),
  odysseyPlanChangeAdd: (request: { odysseyId: string; ops: string; summary: string; reason?: string | null; state: PlanChangeState }) =>
    call<PlanChangeRecord>(COMMANDS.odysseyPlanChangeAdd, { request }),
  odysseyPlanChangeList: (odysseyId: string) => call<PlanChangeRecord[]>(COMMANDS.odysseyPlanChangeList, { odysseyId }),
  odysseyPlanChangeDecide: (id: string, state: PlanChangeState, note?: string | null) =>
    call<void>(COMMANDS.odysseyPlanChangeDecide, { request: { id, state, note: note ?? null } }),
  odysseyQuestionAdd: (request: NewQuestion) => call<QuestionRecord>(COMMANDS.odysseyQuestionAdd, { request }),
  odysseyQuestionList: (odysseyId: string) => call<QuestionRecord[]>(COMMANDS.odysseyQuestionList, { odysseyId }),
  odysseyQuestionSettle: (id: string, state: QuestionState, answer?: string | null) =>
    call<void>(COMMANDS.odysseyQuestionSettle, { request: { id, state, answer: answer ?? null } }),
  odysseySetStepState: (id: string, state: StepState, note?: string) => call<void>(COMMANDS.odysseySetStepState, { request: { id, state, note: note ?? null } }),
  odysseyDeleteStep: (id: string) => call<void>(COMMANDS.odysseyDeleteStep, { id }),
  odysseyCheckpoint: (workspaceId: string, odysseyId: string) => call<OdysseyCheckpoint>(COMMANDS.odysseyCheckpoint, { request: { workspaceId, odysseyId } }),
  odysseyUsageSampleAdd: (request: NewUsageSample) => call<UsageSampleRecord | null>(COMMANDS.odysseyUsageSampleAdd, { request }),
  odysseySpendModel: (odysseyId: string) => call<SpendModel>(COMMANDS.odysseySpendModel, { odysseyId }),
  odysseyWorkspaceNotes: (workspaceId: string) => call<WorkspaceNotes>(COMMANDS.odysseyWorkspaceNotes, { request: { workspaceId } }),
  sessionRecords: (workspaceId: string) => call<SessionRecord[]>(COMMANDS.sessionRecords, { workspaceId }),
  openExternal: (url: string) => call<void>(COMMANDS.openExternal, { url }),
  providersStatus: () => call<ProviderInfo[]>(COMMANDS.providersStatus),
  providerSetLocation: (provider: Provider, location: ProviderLocation | null) =>
    call<void>(COMMANDS.providerSetLocation, { request: { provider, location } }),
  providerLoginStart: (provider: Provider, onEvent: (event: LoginEvent) => void) => {
    const channel = new Channel<LoginEvent>();
    channel.onmessage = onEvent;
    return call<{ runId: string }>(COMMANDS.providerLoginStart, { provider, onEvent: channel });
  },
  providerLoginCancel: (runId: string) => call<boolean>(COMMANDS.providerLoginCancel, { runId }),
  providerModels: (provider: Provider) => call<ProviderModel[]>(COMMANDS.providerModels, { provider }),
  providerQuota: (provider: Provider) => call<QuotaSnapshot>(COMMANDS.providerQuota, { provider }),
  providerLogout: (provider: Provider) => call<void>(COMMANDS.providerLogout, { provider }),
  delegationComboGet: (handle: SessionHandle) => call<Combo | null>(COMMANDS.delegationComboGet, { handle }),
  delegationComboSet: (handle: SessionHandle, combo: Combo) => call<Combo>(COMMANDS.delegationComboSet, { request: { handle, combo } }),
  delegationDefaultComboGet: () => call<Combo>(COMMANDS.delegationDefaultComboGet),
  delegationDefaultComboSet: (combo: Combo) => call<Combo>(COMMANDS.delegationDefaultComboSet, { combo }),
  delegationJobs: (handle: SessionHandle) => call<JobView[]>(COMMANDS.delegationJobs, { handle }),
  delegationJobCancel: (handle: SessionHandle, jobId: string) => call<JobView>(COMMANDS.delegationJobCancel, { request: { handle, jobId } }),
  delegationJobRetry: (handle: SessionHandle, jobId: string) => call<JobView>(COMMANDS.delegationJobRetry, { request: { handle, jobId } }),
  delegationRetryPolicyGet: () => call<JobRetryPolicy>(COMMANDS.delegationRetryPolicyGet),
  delegationRetryPolicySet: (policy: JobRetryPolicy) => call<JobRetryPolicy>(COMMANDS.delegationRetryPolicySet, { policy }),
  workspacePick: () => call<string | null>(COMMANDS.workspacePick),
  revealInFinder: (path: string) => call<void>(COMMANDS.revealInFinder, { path }),
  settingsGet: () => call<NotificationSettings>(COMMANDS.settingsGet),
  settingsSet: (settings: NotificationSettings) => call<NotificationSettings>(COMMANDS.settingsSet, { settings }),
  appHideToTray: () => call<void>(COMMANDS.appHideToTray),
  appQuit: (stopSessions: boolean) => call<void>(COMMANDS.appQuit, { stopSessions }),
  confirmDialog: (request: { title: string; message: string; okLabel: string; cancelLabel: string; warning?: boolean }) =>
    call<boolean>(COMMANDS.confirmDialog, { request }),
  appActivity: () => call<{ id: string; active: boolean; detachedCalls: number }[]>(COMMANDS.appActivity),
  workspaceListDir: (workspaceId: string, relative: string, showIgnored: boolean) =>
    call<DirEntry[]>(COMMANDS.workspaceListDir, { workspaceId, relative, showIgnored }),
  fileRead: (workspaceId: string, relative: string, offsetLine = 0, limit = 5000) =>
    call<FileRead>(COMMANDS.fileRead, { workspaceId, relative, offsetLine, limit }),
  fileWriteChecked: (workspaceId: string, relative: string, expectedHash: string | null, content: string) =>
    call<WriteOutcome>(COMMANDS.fileWriteChecked, { request: { workspaceId, relative, expectedHash, content } }),
  reviewCaptureBaseline: (workspaceId: string, sessionId?: string) =>
    call<BaselineRecord>(COMMANDS.reviewCaptureBaseline, { request: { workspaceId, sessionId: sessionId ?? null, scope: "session_baseline" } }),
  reviewBaselines: (workspaceId: string) => call<BaselineRecord[]>(COMMANDS.reviewBaselines, { workspaceId }),
  reviewDiff: (workspaceId: string, scope: DiffScope, sessionId?: string, baselineId?: string) =>
    call<DiffResponse>(COMMANDS.reviewDiff, { request: { workspaceId, scope, sessionId: sessionId ?? null, baselineId: baselineId ?? null } }),
  gitInfo: (workspaceId: string) => call<RepositoryInfo>(COMMANDS.gitInfo, { workspaceId }),
  gitStage: (workspaceId: string, paths: string[]) => call<void>(COMMANDS.gitStage, { request: { workspaceId, paths } }),
  gitUnstage: (workspaceId: string, paths: string[]) => call<void>(COMMANDS.gitUnstage, { request: { workspaceId, paths } }),
  gitRevertFile: (workspaceId: string, path: string, expectedHash: string, untracked: boolean) =>
    call<void>(COMMANDS.gitRevertFile, { request: { workspaceId, path, expectedHash, untracked } }),
  gitApplyHunk: (workspaceId: string, patch: string, staged: boolean, reverse: boolean) =>
    call<void>(COMMANDS.gitApplyHunk, { request: { workspaceId, patch, staged, reverse } }),
  gitCommit: (workspaceId: string, message: string) => call<CommitOutcome>(COMMANDS.gitCommit, { request: { workspaceId, message } }),
  gitPush: (workspaceId: string, remote: string) => call<string>(COMMANDS.gitPush, { request: { workspaceId, remote } }),
  reviewFileVersions: (workspaceId: string, scope: DiffScope, path: string, beforeHash?: string) =>
    call<FileVersions>(COMMANDS.reviewFileVersions, { request: { workspaceId, scope, path, beforeHash: beforeHash ?? null } }),
  worktreeList: (workspaceId: string) => call<WorktreeView>(COMMANDS.worktreeList, { workspaceId }),
  worktreeCreate: (workspaceId: string, branch: string, baseRef: string, carryUncommitted: boolean) =>
    call<WorktreeCreated>(COMMANDS.worktreeCreate, { request: { workspaceId, branch, baseRef, carryUncommitted } }),
  worktreeRemovePreview: (workspaceId: string, worktreeId: string) =>
    call<WorktreeRemovePreview>(COMMANDS.worktreeRemovePreview, { request: { workspaceId, worktreeId } }),
  worktreeRemove: (workspaceId: string, worktreeId: string) => call<string | null>(COMMANDS.worktreeRemove, { request: { workspaceId, worktreeId } }),
  worktreePin: (worktreeId: string, pinned: boolean) => call<void>(COMMANDS.worktreePin, { request: { worktreeId, pinned } }),
  openInEditor: (workspaceId: string, relative: string, editor: EditorProfile, line?: number) =>
    call<void>(COMMANDS.openInEditor, { request: { workspaceId, relative, editor, line: line ?? null } }),
};

export { toDesktopError };
