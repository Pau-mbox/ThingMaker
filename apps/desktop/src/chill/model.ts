import type {
  ActivityActor,
  ActivitySnapshot,
  FileActivity,
  ActivityGoal,
  WorkspaceRecord,
} from "@thingmaker/contracts";
export type ActivityActorView = ActivityActor & {
  reason: string | null;
  retryAt: number | null;
  jobId: string | null;
  orchestrator: string | null;
};
export type ActivityProject = {
  id: string;
  name: string;
  root: string;
  actors: ActivityActorView[];
  files: FileActivity[];
  goals: ActivityGoal[];
};
export type Selection = {
  kind: "project" | "actor" | "file";
  id: string;
} | null;
export const EMPTY: ActivitySnapshot = {
  revision: "0",
  observedAt: 0,
  actors: [],
  files: [],
  jobs: [],
  goals: [],
};
export function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export function projectsOf(
  snapshot: ActivitySnapshot,
  workspaces: WorkspaceRecord[],
  now: number,
): ActivityProject[] {
  const actors = new Map<string, ActivityActorView>();
  for (const actor of snapshot.actors) {
    const stale =
      now - actor.lastSeen > 10 * 60_000 &&
      ["working", "starting"].includes(actor.status);
    actors.set(actor.id, {
      ...actor,
      status: stale ? "unknown" : actor.status,
      reason: stale
        ? "No recent activity reported"
        : actor.status === "unknown"
          ? actor.native
            ? "Child completion has not been reported"
            : "Current session state is uncertain"
          : (actor.waitingReason ?? null),
      retryAt: actor.retryAtUnixMs ?? null,
      jobId: null,
      orchestrator: null,
    });
  }
  // A warm worker is a single actor across jobs. Most recent job wins;
  // retired jobs do not resurrect workers whose session has closed.
  const seenWorkers = new Set<string>();
  for (const job of [...snapshot.jobs].sort(
    (a, b) => b.startedAtUnixMs - a.startedAtUnixMs,
  )) {
    const parent = actors.get(job.orchestrator);
    const key = job.workerSession ?? `job:${job.id}`;
    if (seenWorkers.has(key)) continue;
    seenWorkers.add(key);
    const existing = actors.get(key);
    if (
      !existing &&
      (!["starting", "running", "waiting", "failed"].includes(job.status) ||
        !parent)
    )
      continue;
    const active = ["starting", "running", "waiting"].includes(job.status);
    const actor = existing ?? {
      id: key,
      sessionId: job.agentSessionId ?? job.orchestrator,
      workspaceId: parent!.workspaceId,
      parentId: job.orchestrator,
      name: job.worker,
      provider: job.provider,
      model: job.model ?? null,
      status: "starting",
      task: job.task,
      operation: "thinking",
      fileId: null,
      lastSeen: job.finishedAtUnixMs ?? job.startedAtUnixMs,
      native: false,
      generation: "1",
    };
    actors.set(key, {
      ...actor,
      parentId: job.orchestrator,
      name: job.worker,
      model: job.model ?? actor.model,
      task: job.task,
      status:
        job.status === "waiting"
          ? "waiting"
          : job.status === "failed"
            ? "failed"
            : job.status === "running"
              ? actor.status === "unknown"
                ? "unknown"
                : "working"
              : job.status === "starting"
                ? "starting"
                : actor.status,
      reason: job.waitingReason ?? job.error ?? null,
      retryAt: job.retryAtUnixMs ?? null,
      jobId: active ? job.id : null,
      orchestrator: job.orchestrator,
    });
  }
  return workspaces.map((w) => {
    const graft = snapshot.worktrees?.find((t) => t.workspaceId === w.id);
    const source = graft
      ? workspaces.find((p) => p.id === graft.sourceWorkspaceId)
      : null;
    return {
      id: w.id,
      name: source
        ? `${source.displayPath.split(/[\\/]/).pop()} · ${graft!.branch}`
        : (w.displayPath
            .replace(/[\\/]$/, "")
            .split(/[\\/]/)
            .pop() ?? w.displayPath),
      root: w.canonicalRoot,
      actors: [...actors.values()].filter((a) => a.workspaceId === w.id),
      files: snapshot.files
        .filter((f) => f.workspaceId === w.id)
        .map((f) => ({
          ...f,
          activeActors: f.activeActors.filter(
            (id) => actors.get(id)?.status !== "unknown",
          ),
        })),
      goals: snapshot.goals.filter((g) => g.workspaceId === w.id),
    };
  });
}
export function ageLabel(at: number, now: number): string {
  if (!at) return "Recency unknown";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  return seconds < 60
    ? "Just now"
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h ago`
        : `${Math.floor(seconds / 86400)}d ago`;
}
