/**
 * What a Big Thing run is doing right now, one lane per worker: the
 * orchestrator's own turn, each team job a worker holds, and each of the
 * provider's own subagents. A lane names who (provider and model), what (the
 * task it is on, by number when it is one of the plan's) and for how long,
 * and ticks while it runs. Everything is read from what the host reports —
 * the session's projection and the team's jobs — never inferred.
 */
import { useEffect, useState } from "react";
import type { JobView, MilestoneRecord, OdysseyStep, Provider } from "@thingmaker/contracts";
import { useStore } from "../store";
import { matchAgentToTask, taskNumber } from "../odysseyTasks";
import { ProviderBadge } from "./ProviderMark";

export type Lane = {
  key: string;
  who: string;
  provider: Provider | null;
  model: string | null;
  task: string;
  number: string | null;
  state: "working" | "waiting" | "starting";
  note: string | null;
  startedAt: number | null;
  toolCalls: number | null;
  /** A worker session the lane can open. */
  session: string | null;
};

function providerOf(harness: string | null | undefined): Provider | null {
  const value = (harness ?? "").toLowerCase();
  if (value.includes("claude")) return "claude";
  if (value.includes("codex")) return "codex";
  if (value.includes("gemini") || value.includes("antigravity")) return "gemini";
  return null;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((entry) => entry.trim()) ?? text;
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function stepFor(milestones: MilestoneRecord[], find: (step: OdysseyStep) => boolean): { step: OdysseyStep; number: string } | null {
  for (const [milestoneIndex, milestone] of milestones.entries()) {
    const index = milestone.steps.findIndex(find);
    const step = milestone.steps[index];
    if (step) return { step, number: taskNumber(milestoneIndex, index) };
  }
  return null;
}

/** The lanes, from the session, its team's jobs and the plan. */
export function lanesFor(input: {
  orchestrator: { provider: Provider; model: string | null; running: boolean; startedAt: number | null; toolCalls: number; milestone: string | null } | null;
  jobs: JobView[];
  agents: { id: string; name: string; harness: string; model: string | null; status: string; task: string; generationStartedAtUnixMs: number | null }[];
  milestones: MilestoneRecord[];
}): Lane[] {
  const lanes: Lane[] = [];
  const { orchestrator, milestones } = input;
  if (orchestrator?.running) {
    lanes.push({
      key: "orchestrator",
      who: "Orchestrator",
      provider: orchestrator.provider,
      model: orchestrator.model,
      task: orchestrator.milestone ?? "Its own turn",
      number: null,
      state: "working",
      note: null,
      startedAt: orchestrator.startedAt,
      toolCalls: orchestrator.toolCalls,
      session: null,
    });
  }
  for (const job of input.jobs) {
    if (job.status !== "starting" && job.status !== "running" && job.status !== "waiting") continue;
    const match = stepFor(milestones, (step) => step.jobId === job.id);
    lanes.push({
      key: `job-${job.id}`,
      who: job.worker,
      provider: job.provider,
      model: job.model ?? null,
      task: match ? match.step.title : firstLine(job.task),
      number: match?.number ?? null,
      state: job.status === "waiting" ? "waiting" : job.status === "starting" ? "starting" : "working",
      note: job.status === "waiting" ? (job.waitingReason ?? "waiting out a limit") : job.warm ? "kept its context from an earlier job" : null,
      startedAt: job.startedAtUnixMs,
      toolCalls: job.toolCalls,
      session: job.workerSession ?? null,
    });
  }
  for (const agent of input.agents) {
    if (agent.status !== "working" && agent.status !== "starting") continue;
    const match = matchAgentToTask(agent.name, milestones);
    const number = match ? taskNumber(match.milestoneIndex, match.stepIndex) : null;
    lanes.push({
      key: `agent-${agent.id}`,
      who: agent.name,
      provider: providerOf(agent.harness),
      model: agent.model,
      task: match ? match.step.title : firstLine(agent.task),
      number,
      state: agent.status === "starting" ? "starting" : "working",
      note: "subagent",
      startedAt: agent.generationStartedAtUnixMs,
      toolCalls: null,
      session: null,
    });
  }
  return lanes;
}

export function WorkLanes({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const jobs = useStore((s) => s.jobs[sessionId]);
  const view = useStore((s) => s.odyssey[sessionId]);
  const milestones = view?.milestones ?? [];
  const selectSession = useStore((s) => s.selectSession);
  const [now, setNow] = useState(Date.now());

  const projection = session?.projection;
  const running = projection?.foreground === "running" || projection?.foreground === "cancelling";
  const active = milestones.findIndex((milestone) => milestone.state === "active");
  const lanes = session && projection
    ? lanesFor({
        orchestrator: {
          provider: session.snapshot.provider,
          // The model the run last prompted, as the engine recorded it.
          model: view?.journal.find((entry) => (entry.kind === "continuation" || entry.kind === "briefing") && entry.model)?.model ?? null,
          running,
          startedAt: session.turnStartedAt,
          toolCalls: [...projection.toolCalls.values()].filter((tool) => tool.status === "in_progress" || tool.status === "pending").length,
          milestone: active >= 0 ? `Milestone ${active + 1}: ${milestones[active]?.title ?? ""}` : null,
        },
        jobs: jobs ?? [],
        agents: [...projection.inspector.agents.values()],
        milestones,
      })
    : [];
  const live = lanes.length > 0;

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  if (!live) return null;
  const parallel = lanes.filter((lane) => lane.key !== "orchestrator").length;

  return (
    <section aria-label="Working now" className="card work-lanes">
      <header className="work-head">
        <span className="work-title">Working now</span>
        <span className="small muted">{parallel > 0 ? `${parallel} in parallel${running ? " beside the orchestrator" : ""}` : "the orchestrator alone"}</span>
      </header>
      <ul className="work-lane-list">
        {lanes.map((lane) => (
          <li className={`work-lane work-lane-${lane.state}`} key={lane.key}>
            <span className="work-lane-who">
              {lane.provider ? <ProviderBadge provider={lane.provider} /> : null}
              <span className="mono">{lane.who}</span>
              {lane.model && <span className="small muted">{lane.model}</span>}
            </span>
            <span className="work-lane-task">
              {lane.number && <span className="mono muted">{lane.number}</span>} <span>{lane.task}</span>
              {lane.note && <span className="small muted"> · {lane.note}</span>}
            </span>
            <span className="work-lane-meta small muted">
              {lane.toolCalls !== null && lane.toolCalls > 0 ? `${lane.toolCalls} tool${lane.toolCalls === 1 ? "" : "s"} · ` : ""}
              {lane.startedAt ? elapsed(now - lane.startedAt) : ""}
            </span>
            {lane.session ? (
              <button className="link small" onClick={() => selectSession(lane.session as string)} type="button">
                Open
              </button>
            ) : (
              <span />
            )}
            <span aria-hidden="true" className="work-lane-bar" />
          </li>
        ))}
      </ul>
    </section>
  );
}
