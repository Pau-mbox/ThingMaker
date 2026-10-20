/**
 * Jobs the orchestrator handed to its team: who took each, how it went, and
 * the report. The host runs them; this only shows them and offers cancel and
 * a way into the worker's own session.
 */
import { useEffect, useState } from "react";
import { PROVIDER_LABELS, type JobView } from "@thingmaker/contracts";
import { useStore } from "../store";
import { t } from "../i18n";
import { countdown, isOpen, isRunning, jobDuration, teamSummary } from "../team";
import { ProviderBadge } from "./ProviderMark";

const EMPTY: JobView[] = [];

/** A job's status as the person reads it. */
const STATUS = (): Record<JobView["status"], string> => ({
  starting: t("starting"),
  running: t("running"),
  waiting: t("waiting"),
  succeeded: t("succeeded"),
  failed: t("failed"),
  cancelled: t("cancelled"),
});

function JobRow({ job, sessionId, now }: { job: JobView; sessionId: string; now: number }) {
  const cancelJob = useStore((s) => s.cancelJob);
  const retryJob = useStore((s) => s.retryJob);
  const openWorker = useStore((s) => s.openWorker);
  const [expanded, setExpanded] = useState(false);
  const running = isRunning(job);
  const waiting = job.status === "waiting";
  const chip = running ? "chip-active" : job.status === "succeeded" ? "" : "chip-warn";
  const firstLine = job.task.split("\n")[0] ?? job.task;
  return (
    <li className="job-row">
      <div className="agent-row">
        <span className={`chip small ${chip}`}>{STATUS()[job.status] ?? job.status}</span>
        <strong>{job.worker}</strong>
        <ProviderBadge provider={job.provider} />
        <span className="small muted">
          {PROVIDER_LABELS[job.provider]}
          {job.model ? ` · ${job.model}` : ""}
          {job.effort ? ` · ${job.effort}` : ""} · {jobDuration(job, now)}
          {job.toolCalls > 0 ? ` · ${job.toolCalls === 1 ? t("1 tool call") : t("{count} tool calls", { count: job.toolCalls })}` : ""}
          {job.continues ? ` · ${t("follows {job}", { job: job.continues })}` : ""}
        </span>
        <span className="composer-spacer" />
        {job.workerSession && (
          <button className="link small" onClick={() => void openWorker(job)} type="button">
            {t("open worker")}
          </button>
        )}
        {waiting && (
          <button className="link small" onClick={() => void retryJob(sessionId, job.id)} title={t("Try again now instead of waiting")} type="button">
            {t("retry now")}
          </button>
        )}
        {(running || waiting) && (
          <button className="link small" onClick={() => void cancelJob(sessionId, job.id)} type="button">
            {t("cancel")}
          </button>
        )}
      </div>
      <p className="small agent-task" title={job.task}>
        <span className="mono muted">{job.id}</span> {firstLine}
      </p>
      {job.reroutedFrom && <p className="small chip-warn-text">{t("Rerouted from {worker}.", { worker: job.reroutedFrom })}</p>}
      {waiting && (
        <p className="small job-waiting">
          {t("Waiting: {reason}.", { reason: job.waitingReason ?? t("a temporary limit") })}{" "}
          {job.retryAtUnixMs !== undefined && (
            <>
              {t("Retries in")} <strong>{countdown(job.retryAtUnixMs, now)}</strong>
              {job.attempts > 0 ? ` ${t("(retry {count})", { count: job.attempts })}` : ""}.
            </>
          )}
        </p>
      )}
      {!waiting && job.attempts > 0 && <p className="small muted">
          {job.attempts === 1 ? t("Retried 1 time after a temporary limit.") : t("Retried {count} times after a temporary limit.", { count: job.attempts })}
        </p>}
      {job.error && job.status !== "succeeded" && <p className="small chip-warn-text">{job.error}</p>}
      {job.result && (
        <div className="job-report">
          <button className="link small" onClick={() => setExpanded(!expanded)} type="button">
            {expanded ? t("hide report") : t("show report")}
          </button>
          {expanded && <pre className="job-report-text">{job.result}</pre>}
        </div>
      )}
    </li>
  );
}

export function JobsSection({ sessionId }: { sessionId: string }) {
  const jobs = useStore((s) => s.jobs[sessionId] ?? EMPTY);
  const team = useStore((s) => s.teams[sessionId]);
  const anyRunning = jobs.some(isOpen);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);
  if (!team) return null;
  return (
    <section>
      <h3>{t("Delegated jobs")}</h3>
      <p className="small muted">{t("Team: {summary} Change it from the team button beside the model picker.", { summary: teamSummary(team) })}</p>
      {jobs.length === 0 ? (
        <p className="small muted">
          {t("The orchestrator has not delegated anything yet. Jobs appear here as it calls the team")} <code>delegate</code> {t("tool.")}
        </p>
      ) : (
        <ul className="jobs-list">
          {[...jobs].reverse().map((job) => (
            <JobRow job={job} key={job.id} now={now} sessionId={sessionId} />
          ))}
        </ul>
      )}
    </section>
  );
}
