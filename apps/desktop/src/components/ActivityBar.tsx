/**
 * Live activity strip (UX-08, INS-01): the crew at work. The lead and every
 * helper on the session's team stand in a row as tiny robots in their
 * provider's colour — working while they have something in flight, idle
 * while they wait, done once their last job finished — with the lead's own
 * subagents beside them, and the elapsed time and step count after them.
 *
 * It sits between the transcript and the composer rather than inside the
 * transcript, so it cannot scroll out of view while work continues — the case
 * that used to leave a finished foreground turn looking like nothing was
 * happening while background agents were still going. Everything listed comes
 * from runtime reports; nothing is inferred from silence.
 */
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { useStore, windowDelta } from "../store";
import { staleActivity } from "../odysseyRunner";
import { stepDoing, stepOf } from "../toolSteps";
import { UsageLine } from "./UsageLine";
import { IconChevron } from "./icons";
import { TinyBot, type BotRole, type BotState } from "./TinyBot";
import { closestRole } from "../teamRoles";
import type { JobView, Provider } from "@thingmaker/contracts";

/** One robot in the row. */
type CrewMember = { key: string; provider: Provider; role: BotRole | null; name: string; state: BotState; status: string; title: string };

/** The lead stands a size bigger than its helpers. */
const LEAD_SIZE = 38;
const HELPER_SIZE = 30;

/** How many robots the row shows before it says "+n". */
const CREW_LIMIT = 8;

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
  const team = useStore((s) => s.teams[sessionId]);
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
      ? t("Cancelling")
      : projection.foreground === "awaiting_user"
        ? t("Waiting for your input")
        : runningTools.length > 0
          ? t("Running tools")
          : t("Thinking")
    : t("Working in the background");

  // What the turn is doing, in the transcript's words, and how much it has
  // done: a long "Thinking" otherwise says nothing at all.
  const doing = runningTools.at(-1);
  let turnSteps = 0;
  for (let index = projection.cards.length - 1; index >= 0; index -= 1) {
    const card = projection.cards[index];
    if (card?.kind === "message" && card.message.role === "user") break;
    if (card?.kind === "tool") turnSteps += 1;
  }
  // The robots say who is working; the line after them says on what.
  const counts = [
    doing ? `${stepDoing(stepOf(doing, roots.split("\n").filter(Boolean)))}${runningTools.length > 1 ? ` (${t("+{n} more", { n: runningTools.length - 1 })})` : ""}` : null,
    foreground && turnSteps > 0 ? (turnSteps === 1 ? t("{n} step so far", { n: turnSteps }) : t("{n} steps so far", { n: turnSteps })) : null,
    detached.length > 0 ? t("{n} detached", { n: detached.length }) : null,
    waitingJobs > 0 ? t("({n} waiting out a limit)", { n: waitingJobs }) : null,
  ].filter(Boolean);

  // The lead, each helper on the team by its latest job, and the lead's own
  // subagents, which run on the lead's provider.
  const crew: CrewMember[] = [
    {
      key: "lead",
      provider: session.snapshot.provider,
      role: "lead",
      name: t("Lead"),
      state: foreground ? "working" : "idle",
      status: foreground ? phase.toLowerCase() : t("waiting on the team"),
      title: foreground ? phase : t("The lead waits while its helpers work"),
    },
  ];
  // A helper's job that says most about it now: one running, else one
  // waiting, else the one that finished last.
  const rank = (job: JobView) => (job.status === "starting" || job.status === "running" ? 2 : job.status === "waiting" ? 1 : 0);
  const latest = new Map<string, JobView>();
  for (const job of jobs ?? []) {
    const known = latest.get(job.worker);
    if (!known || rank(job) > rank(known) || (rank(job) === rank(known) && job.startedAtUnixMs >= known.startedAtUnixMs)) latest.set(job.worker, job);
  }
  const names = [...(team?.workers.map((worker) => worker.name) ?? []), ...[...latest.keys()].filter((name) => !team?.workers.some((worker) => worker.name === name))];
  for (const name of names) {
    const job = latest.get(name);
    const slot = team?.workers.find((worker) => worker.name === name);
    const provider = job?.provider ?? slot?.provider ?? session.snapshot.provider;
    const open = job && (job.status === "starting" || job.status === "running");
    const state: BotState = open ? "working" : job && (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") ? "done" : "idle";
    const status = !job
      ? t("ready")
      : open
        ? elapsed(now - job.startedAtUnixMs)
        : job.status === "waiting"
          ? t("waiting out a limit")
          : job.status === "succeeded"
            ? t("done")
            : job.status === "failed"
              ? t("failed")
              : t("stopped");
    crew.push({ key: `job:${name}`, provider, role: slot ? closestRole(slot) : null, name, state, status, title: job ? job.task.split("\n")[0]?.slice(0, 140) ?? name : t("On the team, with nothing to do yet") });
  }
  for (const agent of agents) {
    crew.push({
      key: `agent:${agent.id}`,
      provider: session.snapshot.provider,
      role: null,
      name: agent.name,
      state: "working",
      status: typeof agent.generationStartedAtUnixMs === "number" ? elapsed(now - agent.generationStartedAtUnixMs) : t("working"),
      title: agent.task,
    });
  }
  const shown = crew.slice(0, CREW_LIMIT);

  const lastRuntime = [...projection.cards].reverse().find((c) => c.kind === "runtime");
  const detail = runningTools.length > 0 || agents.length > 0;

  return (
    <div aria-live="off" className={`activity ${foreground ? "" : "activity-background"}`} role="status">
      <div className="activity-head">
        <ul aria-label={t("Who is working")} className="crew">
          {shown.map((member) => (
            <li className={`crew-member crew-${member.state}`} key={member.key} title={member.title}>
              <TinyBot provider={member.provider} role={member.role} size={member.role === "lead" ? LEAD_SIZE : HELPER_SIZE} state={member.state} />
              <span className="crew-text">
                <span className="crew-name">{member.name}</span>
                <span className="crew-status">{member.status}</span>
              </span>
            </li>
          ))}
          {crew.length > shown.length && <li className="crew-more">+{crew.length - shown.length}</li>}
        </ul>
        {stale && <strong className="small">{t("Reported running, but silent")}</strong>}
        {startedAt && <span className="muted small activity-clock">{elapsed(now - startedAt)}</span>}
        <span className="muted small activity-counts">
          {stale ? t("nothing has been reported for {time}; it probably ended without saying so", { time: elapsed(stale.silentMs) }) : counts.join(" · ")}
        </span>
        {stale && (
          <button className="link small" onClick={() => clearStaleActivity(sessionId)} type="button">
            {t("Clear")}
          </button>
        )}
        {agents.length + detached.length + openJobs.length > 0 && (
          <button className="link small" onClick={onOpenAgents} type="button">
            {t("Agents")}
          </button>
        )}
        {detail && (
          <button aria-expanded={open} className="icon-button icon-button-xs" onClick={() => setOpen(!open)} title={open ? t("Hide detail") : t("Show what is running")} type="button">
            <IconChevron open={open} size={14} />
          </button>
        )}
      </div>
      {open && detail && (
        <ul className="activity-list">
          {runningTools.slice(-4).map((tool) => (
            <li key={tool.toolCallId ?? tool.title ?? "tool"}>
              <span className="chip small">{tool.toolKind ?? tool.name ?? t("tool")}</span> <span>{tool.title ?? tool.name ?? tool.toolCallId}</span>
            </li>
          ))}
          {agents.slice(-4).map((agent) => (
            <li key={agent.id}>
              <span className="chip small">{agent.status === "starting" ? t("starting") : agent.status === "working" ? t("working") : agent.status}</span> <span>{agent.name}</span> <span className="muted small">{agent.task.length > 90 ? `${agent.task.slice(0, 90)}…` : agent.task}</span>
            </li>
          ))}
        </ul>
      )}
      {open && !detail && lastRuntime?.kind === "runtime" && <p className="small muted activity-last">{lastRuntime.text}</p>}
      {open && session.usage.turnStart && session.usage.latest && (
        <UsageLine
          label={t("Codex usage this turn")}
          primary={windowDelta(session.usage.turnStart.primary, session.usage.latest.primary)}
          secondary={windowDelta(session.usage.turnStart.secondary, session.usage.latest.secondary)}
          sampling={session.usage.sampling}
        />
      )}
    </div>
  );
}
