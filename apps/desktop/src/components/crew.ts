/**
 * Who is on a session's crew and what each is doing: the lead, each helper
 * on the team by its latest job, and the lead's own subagents. Shared by the
 * activity strip (a row of tiny robots) and the office (the same robots at
 * their desks), so both always agree.
 */
import { t } from "../i18n";
import { closestRole } from "../teamRoles";
import type { BotRole, BotState } from "./TinyBot";
import type { JobView, Provider, Combo } from "@thingmaker/contracts";

/** One robot of the crew. */
export type CrewMember = {
  key: string;
  provider: Provider;
  role: BotRole | null;
  name: string;
  state: BotState;
  status: string;
  title: string;
  /** Where it comes from: the lead, a helper on the team, or one of the lead's own subagents. */
  kind: "lead" | "helper" | "subagent";
  /** The model it runs, when it says. */
  model: string | null;
  /** What it was asked to do, whole, for the roster. */
  task: string;
};

export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** One of the lead's own subagents, as the inspector reports it. */
export type CrewAgent = {
  id: string;
  name: string;
  task: string;
  generationStartedAtUnixMs: number | null;
  status?: string;
  outcome?: string | null;
  model?: string | null;
};

export function buildCrew(input: {
  provider: Provider;
  foreground: boolean;
  phase: string;
  jobs: JobView[] | undefined;
  team: Combo | undefined;
  agents: CrewAgent[];
  now: number;
}): CrewMember[] {
  const { provider: leadProvider, foreground, phase, jobs, team, agents, now } = input;
  const crew: CrewMember[] = [
    {
      key: "lead",
      provider: leadProvider,
      role: "lead",
      name: t("Lead"),
      state: foreground ? "working" : "idle",
      status: foreground ? phase.toLowerCase() : t("waiting on the team"),
      title: foreground ? phase : t("The lead waits while its helpers work"),
      kind: "lead",
      model: null,
      task: "",
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
    const provider = job?.provider ?? slot?.provider ?? leadProvider;
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
    crew.push({ key: `job:${name}`, provider, role: slot ? closestRole(slot) : null, name, state, status, title: job ? job.task.split("\n")[0]?.slice(0, 140) ?? name : t("On the team, with nothing to do yet"), kind: "helper", model: job?.model ?? slot?.model ?? null, task: job?.task ?? "" });
  }
  for (const agent of agents) {
    const running = agent.status === undefined || agent.status === "working" || agent.status === "starting";
    const failed = agent.outcome === "failed";
    const state: BotState = running ? "working" : agent.status === "idle" ? "idle" : "done";
    crew.push({
      key: `agent:${agent.id}`,
      provider: leadProvider,
      role: null,
      name: agent.name,
      state,
      status: running
        ? typeof agent.generationStartedAtUnixMs === "number"
          ? elapsed(now - agent.generationStartedAtUnixMs)
          : t("working")
        : agent.status === "idle"
          ? t("ready")
          : failed
            ? t("failed")
            : t("done"),
      title: agent.task,
      kind: "subagent",
      model: agent.model ?? null,
      task: agent.task,
    });
  }
  return crew;
}
