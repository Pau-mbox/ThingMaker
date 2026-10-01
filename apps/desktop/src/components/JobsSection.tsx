/**
 * Jobs the orchestrator handed to its team: who took each, how it went, and
 * the report. The host runs them; this only shows them and offers cancel and
 * a way into the worker's own session.
 */
import { useEffect, useState } from "react";
import { PROVIDER_LABELS, PROVIDER_SHORT, type JobView } from "@thingmaker/contracts";
import { useStore } from "../store";
import { countdown, isOpen, isRunning, jobDuration, teamSummary } from "../team";

const EMPTY: JobView[] = [];

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
        <span className={`chip small ${chip}`}>{job.status}</span>
        <strong>{job.worker}</strong>
        <span className={`provider-tag provider-${job.provider}`}>{PROVIDER_SHORT[job.provider]}</span>
        <span className="small muted">
          {PROVIDER_LABELS[job.provider]}
          {job.model ? ` · ${job.model}` : ""}
          {job.effort ? ` · ${job.effort}` : ""} · {jobDuration(job, now)}
          {job.toolCalls > 0 ? ` · ${job.toolCalls} tool call${job.toolCalls === 1 ? "" : "s"}` : ""}
          {job.continues ? ` · follows ${job.continues}` : ""}
        </span>
        <span className="composer-spacer" />
        {job.workerSession && (
          <button className="link small" onClick={() => void openWorker(job)} type="button">
            open worker
          </button>
        )}
        {waiting && (
          <button className="link small" onClick={() => void retryJob(sessionId, job.id)} title="Try again now instead of waiting" type="button">
            retry now
          </button>
        )}
        {(running || waiting) && (
          <button className="link small" onClick={() => void cancelJob(sessionId, job.id)} type="button">
            cancel
          </button>
        )}
      </div>
      <p className="small agent-task" title={job.task}>
        <span className="mono muted">{job.id}</span> {firstLine}
      </p>
      {job.reroutedFrom && <p className="small chip-warn-text">Rerouted from {job.reroutedFrom}.</p>}
      {waiting && (
        <p className="small job-waiting">
          Waiting: {job.waitingReason ?? "a temporary limit"}.{" "}
          {job.retryAtUnixMs !== undefined && (
            <>
              Retries in <strong>{countdown(job.retryAtUnixMs, now)}</strong>
              {job.attempts > 0 ? ` (retry ${job.attempts})` : ""}.
            </>
          )}
        </p>
      )}
      {!waiting && job.attempts > 0 && <p className="small muted">Retried {job.attempts} time{job.attempts === 1 ? "" : "s"} after a temporary limit.</p>}
      {job.error && job.status !== "succeeded" && <p className="small chip-warn-text">{job.error}</p>}
      {job.result && (
        <div className="job-report">
          <button className="link small" onClick={() => setExpanded(!expanded)} type="button">
            {expanded ? "hide report" : "show report"}
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
      <h3>Delegated jobs</h3>
      <p className="small muted">Team: {teamSummary(team)} Change it from the team button beside the model picker.</p>
      {jobs.length === 0 ? (
        <p className="small muted">The orchestrator has not delegated anything yet. Jobs appear here as it calls the team <code>delegate</code> tool.</p>
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
