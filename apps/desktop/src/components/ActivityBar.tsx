/**
 * Live activity strip (UX-08, INS-01). Shows that something is running and
 * what exactly is in flight: the foreground turn, running tool calls, compose
 * children, detached calls and background subagents, with elapsed time.
 *
 * It sits between the transcript and the composer rather than inside the
 * transcript, so it cannot scroll out of view while work continues — the case
 * that used to leave a finished foreground turn looking like nothing was
 * happening while background agents were still going. Everything listed comes
 * from runtime reports; nothing is inferred from silence.
 */
import { useEffect, useState } from "react";
import { useStore, windowDelta } from "../store";
import { staleActivity } from "../odysseyRunner";
import { stepDoing, stepOf } from "../toolSteps";
import { UsageLine } from "./UsageLine";
import { IconChevron } from "./icons";

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function ActivityBar({ sessionId, onOpenAgents }: { sessionId: string; onOpenAgents: () => void }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const sampleUsage = useStore((s) => s.sampleUsage);
  const clearStaleActivity = useStore((s) => s.clearStaleActivity);
  const jobs = useStore((s) => s.jobs[sessionId]);
  // A string, so the selection is stable between updates.
  const roots = useStore((s) => {
    const workspace = s.workspaces.find((entry) => entry.id === s.sessions[sessionId]?.workspaceId);
    return workspace ? `${workspace.canonicalRoot}\n${workspace.displayPath}` : "";
  });

  const foreground = !!session && (session.projection.foreground === "running" || session.projection.foreground === "cancelling" || session.projection.foreground === "awaiting_user");
  const projection = session?.projection;
  const runningTools = projection ? [...projection.toolCalls.values()].filter((t) => t.status === "in_progress" || t.status === "pending") : [];
  const detached = projection ? [...projection.detached.entries()].filter(([, state]) => state === "active" || state === "cancellation_requested") : [];
  const agents = projection ? [...projection.inspector.agents.values()].filter((a) => a.status === "working" || a.status === "starting") : [];
  // The team's jobs come from the host, which holds the workers, so they are
  // known rather than inferred: a worker on a job is work in flight even
  // while the orchestrator itself says nothing.
  const openJobs = (jobs ?? []).filter((job) => job.status === "starting" || job.status === "running" || job.status === "waiting");
  const waitingJobs = openJobs.filter((job) => job.status === "waiting").length;
  // Background work outlives the turn that started it, which is exactly why
  // this strip stays visible after the foreground settles.
  const busy = foreground || agents.length > 0 || detached.length > 0 || openJobs.length > 0;

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  // Long turns: refresh the account counters every minute so the running
  // delta moves while Kit works.
  useEffect(() => {
    if (!foreground) return;
    const timer = setInterval(() => void sampleUsage(sessionId, "tick"), 60_000);
    return () => clearInterval(timer);
  }, [foreground, sessionId, sampleUsage]);

  if (!session || !projection || !busy) return null;

  const startedAt = foreground
    ? session.turnStartedAt
    : // Oldest still-running background item, so the clock reflects the work
      // that is actually outstanding.
      [...agents.map((agent) => agent.generationStartedAtUnixMs), ...openJobs.map((job) => job.startedAtUnixMs)].filter((value): value is number => typeof value === "number").sort((a, b) => a - b)[0] ??
      null;

  // Nothing reports that it stopped when its process is killed or dies with
  // its provider, so the strip would claim work for ever. The session's own
  // silence is what we actually know; say that instead of guessing.
  const stale = foreground || openJobs.length > 0 ? null : staleActivity({ lastEventAt: session.lastEventAt, now });

  const phase = foreground
    ? projection.foreground === "cancelling"
      ? "Cancelling"
      : projection.foreground === "awaiting_user"
        ? "Waiting for your input"
        : runningTools.length > 0
          ? "Running tools"
          : "Thinking"
    : "Working in the background";

  // What the turn is doing, in the transcript's words, and how much it has
  // done: a long "Thinking" otherwise says nothing at all.
  const doing = runningTools.at(-1);
  let turnSteps = 0;
  for (let index = projection.cards.length - 1; index >= 0; index -= 1) {
    const card = projection.cards[index];
    if (card?.kind === "message" && card.message.role === "user") break;
    if (card?.kind === "tool") turnSteps += 1;
  }
  const counts = [
    doing ? `${stepDoing(stepOf(doing, roots.split("\n").filter(Boolean)))}${runningTools.length > 1 ? ` (+${runningTools.length - 1} more)` : ""}` : null,
    foreground && turnSteps > 0 ? `${turnSteps} step${turnSteps === 1 ? "" : "s"} so far` : null,
    agents.length > 0 ? `${agents.length} background agent${agents.length === 1 ? "" : "s"}` : null,
    detached.length > 0 ? `${detached.length} detached` : null,
    openJobs.length > 0 ? `${openJobs.length} worker job${openJobs.length === 1 ? "" : "s"}${waitingJobs > 0 ? ` (${waitingJobs} waiting out a limit)` : ""}` : null,
  ].filter(Boolean);

  const lastRuntime = [...projection.cards].reverse().find((c) => c.kind === "runtime");
  const detail = runningTools.length > 0 || agents.length > 0;

  return (
    <div aria-live="off" className={`activity ${foreground ? "" : "activity-background"}`} role="status">
      <div className="activity-head">
        {stale ? <span className="activity-stale-dot" /> : <span className="spinner" />}
        <strong>{stale ? "Reported running, but silent" : phase}</strong>
        {startedAt && <span className="muted small activity-clock">{elapsed(now - startedAt)}</span>}
        <span className="muted small activity-counts">
          {stale ? `nothing has been reported for ${elapsed(stale.silentMs)}; it probably ended without saying so` : counts.join(" · ")}
        </span>
        {stale && (
          <button className="link small" onClick={() => clearStaleActivity(sessionId)} type="button">
            Clear
          </button>
        )}
        {agents.length + detached.length + openJobs.length > 0 && (
          <button className="link small" onClick={onOpenAgents} type="button">
            Agents
          </button>
        )}
        {detail && (
          <button aria-expanded={open} className="icon-button icon-button-xs" onClick={() => setOpen(!open)} title={open ? "Hide detail" : "Show what is running"} type="button">
            <IconChevron open={open} size={14} />
          </button>
        )}
      </div>
      {open && detail && (
        <ul className="activity-list">
          {runningTools.slice(-4).map((tool) => (
            <li key={tool.toolCallId ?? tool.title ?? "tool"}>
              <span className="chip small">{tool.toolKind ?? tool.name ?? "tool"}</span> <span>{tool.title ?? tool.name ?? tool.toolCallId}</span>
            </li>
          ))}
          {agents.slice(-4).map((agent) => (
            <li key={agent.id}>
              <span className="chip small">{agent.status}</span> <span>{agent.name}</span> <span className="muted small">{agent.task.length > 90 ? `${agent.task.slice(0, 90)}…` : agent.task}</span>
            </li>
          ))}
        </ul>
      )}
      {open && !detail && lastRuntime?.kind === "runtime" && <p className="small muted activity-last">{lastRuntime.text}</p>}
      {open && session.usage.turnStart && session.usage.latest && (
        <UsageLine
          label="Codex usage this turn"
          primary={windowDelta(session.usage.turnStart.primary, session.usage.latest.primary)}
          secondary={windowDelta(session.usage.turnStart.secondary, session.usage.latest.secondary)}
          sampling={session.usage.sampling}
        />
      )}
    </div>
  );
}
