//! Plan-driven team dispatch (ADR-010).
//!
//! With runner dispatch on, the engine itself hands the active milestone's
//! ready tasks — not started, nothing they depend on still open — to the
//! team's workers, in parallel, choosing each by the capability the task
//! names. A finished task can be reviewed by a worker on another provider
//! before it counts as done. The orchestrator is not prompted while the
//! milestone's workers run; when they finish it gets one continuation with
//! every result, and verifies, reviews and reports as usual.

use super::{
    decide::Extra,
    engine::{Engine, Loaded},
    host::LiveSession,
    prompt::Delta,
    protocol::{ready_tasks, task_number},
};
use crate::{
    agents::Provider,
    delegation::{JobStatus, JobView, jobs::DelegateArgs},
    odyssey_notes::{AGENT_NOTES_DIR, STATE_NOTE_PATH},
    storage::odyssey::{JournalKind, MilestoneRecord, MilestoneState, StepRecord, StepState},
};

/// How a job a task was handed to is marked in its review field while the
/// review runs.
const REVIEWING: &str = "reviewing";
/// What a reviewer ends its reply with.
const VERDICT_PREFIX: &str = "VERDICT:";

/// A task's name as a worker and the board know it: `6.3-pricing`.
pub fn task_slug(milestone_index: usize, task_index: usize, title: &str) -> String {
    let words: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .take(3)
        .collect::<Vec<_>>()
        .join("-");
    let number = task_number(milestone_index, task_index);
    if words.is_empty() { number } else { format!("{number}-{words}") }
}

/// The task as the worker reads it. It sees nothing else of the run.
pub fn worker_task(goal_plan_path: Option<&str>, milestone: &MilestoneRecord, milestone_index: usize, task_index: usize, review_feedback: Option<&str>) -> String {
    let step = &milestone.steps[task_index];
    let slug = task_slug(milestone_index, task_index, &step.title);
    let mut lines = vec![
        format!("{slug}: {}", step.title),
        String::new(),
        format!("This is task {} of milestone {} (\"{}\") in a Big Thing run, ThingMaker's long-horizon runner.", task_number(milestone_index, task_index), milestone_index + 1, milestone.title),
    ];
    if !step.detail.is_empty() {
        lines.push(step.detail.clone());
    }
    if !milestone.detail.is_empty() {
        let detail: String = milestone.detail.chars().take(2_500).collect();
        lines.push(String::new());
        lines.push("The milestone, for context:".into());
        lines.push(detail);
    }
    if let Some(section) = milestone.section.as_deref() {
        lines.push(format!("Spec: {section}{}.", goal_plan_path.map(|path| format!(" in `{path}`")).unwrap_or_default()));
    }
    let others: Vec<String> = milestone
        .steps
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != task_index)
        .map(|(index, other)| format!("{} {} ({})", task_number(milestone_index, index), other.title, other.state.as_str().replace('_', " ")))
        .collect();
    if !others.is_empty() {
        lines.push(format!("Other tasks in this milestone, which other workers may be doing at the same time: {}. Stay inside your task.", others.join("; ")));
    }
    if let Some(feedback) = review_feedback {
        lines.push(String::new());
        lines.push(format!("A reviewer asked for changes to an earlier attempt at this task: {feedback}"));
    }
    lines.push(String::new());
    lines.push(format!("Read `{STATE_NOTE_PATH}` first if it exists. Use `memory_read` for decisions the project has already made and `memory_write` for any you make; `board` shows the run's tasks."));
    lines.push(format!("When you finish, write your result to `{AGENT_NOTES_DIR}/{slug}.md`, then end your reply with a short report: what you changed (files), what you verified, and anything left open."));
    lines.join("\n")
}

/// The review a worker on another provider is given.
pub fn review_task(milestone: &MilestoneRecord, milestone_index: usize, task_index: usize, job: &JobView) -> String {
    let step = &milestone.steps[task_index];
    let report: String = job.result.as_deref().unwrap_or("(no report)").chars().take(8_000).collect();
    [
        format!("{}-review: review task {} (\"{}\") of milestone {} (\"{}\").", task_slug(milestone_index, task_index, &step.title), task_number(milestone_index, task_index), step.title, milestone_index + 1, milestone.title),
        format!("It was done by {} on {}{}. Its report:", job.worker, job.provider.label(), job.model.as_deref().map(|model| format!(" · {model}")).unwrap_or_default()),
        "---".into(),
        report,
        "---".into(),
        "Read the files it names in the workspace and check the work against the task and the milestone. Do not change anything.".into(),
        format!("End your reply with one line: `{VERDICT_PREFIX} approve`, or `{VERDICT_PREFIX} changes — <what must change>`."),
    ]
    .join("\n")
}

/// Reads a reviewer's verdict: `Some(None)` approves, `Some(Some(why))` asks
/// for changes, `None` says nothing readable.
pub fn read_verdict(text: &str) -> Option<Option<String>> {
    let line = text.lines().rev().map(str::trim).find(|line| line.to_uppercase().trim_start_matches(['`', '*']).starts_with(VERDICT_PREFIX))?;
    let body = line.trim_matches(['`', '*']).trim();
    let rest = body[VERDICT_PREFIX.len()..].trim().trim_matches('`').trim();
    let lower = rest.to_lowercase();
    if lower.starts_with("approve") {
        return Some(None);
    }
    if lower.starts_with("changes") {
        let why = rest["changes".len()..].trim_start_matches([' ', '-', '—', ':']).trim();
        return Some(Some(if why.is_empty() { "the reviewer asked for changes".to_string() } else { why.to_string() }));
    }
    None
}

fn first_line(text: &str, limit: usize) -> String {
    let line = text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("");
    line.chars().take(limit).collect()
}

impl Engine {
    /// Puts workers on the active milestone's ready tasks, and says which
    /// runner-dispatched tasks are still open.
    pub(crate) async fn dispatch_ready(&self, loaded: &Loaded, live: &LiveSession) -> Extra {
        let Some(delegation) = self.inner.delegation.clone() else { return Extra::default() };
        let Some(combo) = delegation.combo(&live.handle).filter(|combo| !combo.workers.is_empty()) else { return Extra::default() };
        let carry_on = loaded.goal.on_report != crate::storage::odyssey::OnReport::Wait;
        let Some(index) = super::decide::active_milestone(&loaded.milestones, carry_on) else { return Extra::default() };
        let milestone = &loaded.milestones[index];
        if milestone.state == MilestoneState::Reported || milestone.steps.is_empty() {
            return Extra::default();
        }
        let jobs = delegation.jobs(&live.handle);
        let open = |step: &StepRecord| step.job_id.as_deref().is_some_and(|id| jobs.iter().any(|job| job.id == id && !job.status.is_finished())) || step.review.as_deref().is_some_and(|review| review.starts_with(REVIEWING));
        let mut dispatched_open: Vec<String> = milestone.steps.iter().enumerate().filter(|(_, step)| open(step)).map(|(task, _)| task_number(index, task)).collect();

        for task_index in ready_tasks(&milestone.steps) {
            let step = &milestone.steps[task_index];
            if step.job_id.is_some() {
                continue;
            }
            // A capability no worker has goes to whoever the router picks.
            let capability = step.capability.clone().filter(|capability| combo.workers.iter().any(|worker| worker.has(capability)));
            let args = DelegateArgs { task: worker_task(loaded.goal.plan_path.as_deref(), milestone, index, task_index, None), worker: None, capability, files: Vec::new(), continue_job: None };
            match delegation.delegate(&live.handle, args) {
                Ok(job) => {
                    let slug = task_slug(index, task_index, &step.title);
                    let _ = self.db(|storage| {
                        storage.step_set_job(&step.id, Some(&job.id))?;
                        storage.step_set_state(&step.id, StepState::InProgress, None)?;
                        storage.step_assign(&step.id, Some(&slug), Some(&format!("team · {}", job.provider.label())), job.model.as_deref())
                    });
                    self.journal(&loaded.goal.id, JournalKind::Plan, Some(&milestone.id), &format!("Gave task {} to {}", task_number(index, task_index), job.worker), Some(&format!("{} · {}", job.provider.label(), job.model.as_deref().unwrap_or("default model"))));
                    dispatched_open.push(task_number(index, task_index));
                }
                Err(error) => {
                    // Too many running is a wait; anything else is the task's.
                    if !error.contains("already running") {
                        let _ = self.db(|storage| storage.step_set_state(&step.id, StepState::Blocked, Some(&error)));
                        self.journal(&loaded.goal.id, JournalKind::Plan, Some(&milestone.id), &format!("Task {} could not be given to a worker", task_number(index, task_index)), Some(&error));
                    }
                    break;
                }
            }
        }
        if !dispatched_open.is_empty() {
            self.changed(&loaded.goal.id);
        }
        Extra { dispatched_open }
    }

    /// A job moved. Runner-dispatched tasks follow their jobs; a job the
    /// orchestrator named after a task is that task's worker.
    pub(crate) async fn job_changed(&self, goal_id: &str, job: &JobView) {
        let Ok(loaded) = self.load(goal_id) else { return };
        let owned = loaded.milestones.iter().enumerate().find_map(|(milestone_index, milestone)| {
            milestone.steps.iter().position(|step| step.job_id.as_deref() == Some(job.id.as_str()) || step.review.as_deref() == Some(format!("{REVIEWING}:{}", job.id).as_str())).map(|task| (milestone_index, task))
        });
        match owned {
            Some((milestone_index, task_index)) => self.dispatched_job_changed(&loaded, milestone_index, task_index, job).await,
            None => self.attribute_job(&loaded, job),
        }
    }

    fn attribute_job(&self, loaded: &Loaded, job: &JobView) {
        let digits: String = job.task.trim_start().chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        if !digits.contains('.') {
            return;
        }
        let name: String = job.task.trim_start().chars().take_while(|c| !c.is_whitespace() && *c != ':').collect();
        // A review names the task it reviews; it is not that task's worker.
        if name.ends_with("-review") {
            return;
        }
        let Some((milestone_index, step_index)) = super::protocol::match_agent_to_task(&name, &loaded.milestones) else { return };
        let step = &loaded.milestones[milestone_index].steps[step_index];
        // A task the runner gave out is attributed by the runner.
        if step.job_id.is_some() {
            return;
        }
        let harness = format!("team · {}", job.provider.label());
        let key = format!("{:?}|{harness}|{}", job.status, job.model.as_deref().unwrap_or(""));
        let seen_key = format!("job/{}", job.id);
        if self.inner.attributed.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(seen_key, key.clone()).as_deref() == Some(key.as_str()) {
            return;
        }
        let _ = self.db(|storage| storage.step_assign(&step.id, Some(&name), Some(&harness), job.model.as_deref()));
        if matches!(job.status, JobStatus::Starting | JobStatus::Running | JobStatus::Waiting) && step.state == StepState::Pending {
            let _ = self.db(|storage| storage.step_set_state(&step.id, StepState::InProgress, None));
        }
        self.changed(&loaded.goal.id);
    }

    async fn dispatched_job_changed(&self, loaded: &Loaded, milestone_index: usize, task_index: usize, job: &JobView) {
        if !job.status.is_finished() {
            return;
        }
        let goal = &loaded.goal;
        let milestone = &loaded.milestones[milestone_index];
        let step = &milestone.steps[task_index];
        let number = task_number(milestone_index, task_index);
        let reviewing = step.review.as_deref() == Some(format!("{REVIEWING}:{}", job.id).as_str());

        if reviewing {
            let verdict = job.result.as_deref().and_then(read_verdict);
            match (job.status, verdict) {
                (JobStatus::Succeeded, Some(Some(changes))) if !step.note.starts_with("reworked") => {
                    // One more attempt with the reviewer's words, on the same
                    // worker that did it, then it is the orchestrator's call.
                    let _ = self.db(|storage| {
                        storage.step_set_review(&step.id, Some(&format!("changes: {changes}")))?;
                        storage.step_set_job(&step.id, None)?;
                        storage.step_set_state(&step.id, StepState::Pending, Some("reworked after review"))
                    });
                    self.journal(&goal.id, JournalKind::Check, Some(&milestone.id), &format!("{} asked for changes to task {number}", job.worker), Some(&changes));
                    let args = DelegateArgs { task: worker_task(goal.plan_path.as_deref(), milestone, milestone_index, task_index, Some(&changes)), worker: None, capability: step.capability.clone(), files: Vec::new(), continue_job: None };
                    if let Some(live) = self.live_for(goal, false).await
                        && let Some(delegation) = &self.inner.delegation
                        && let Ok(rework) = delegation.delegate(&live.handle, args)
                    {
                        let _ = self.db(|storage| {
                            storage.step_set_job(&step.id, Some(&rework.id))?;
                            storage.step_set_state(&step.id, StepState::InProgress, Some("reworked after review"))
                        });
                    }
                }
                (_, verdict) => {
                    let review = match (&verdict, job.status) {
                        (Some(None), _) => format!("approved by {} ({})", job.worker, job.provider.label()),
                        (Some(Some(changes)), _) => format!("changes asked by {} ({}): {changes}", job.worker, job.provider.label()),
                        (None, JobStatus::Succeeded) => format!("reviewed by {} ({}), no verdict line: {}", job.worker, job.provider.label(), first_line(job.result.as_deref().unwrap_or(""), 200)),
                        (None, _) => format!("the review by {} did not finish: {}", job.worker, job.error.as_deref().unwrap_or("no reason given")),
                    };
                    let _ = self.db(|storage| {
                        storage.step_set_review(&step.id, Some(&review))?;
                        storage.step_set_state(&step.id, StepState::Done, None)
                    });
                    self.journal(&goal.id, JournalKind::Check, Some(&milestone.id), &format!("Task {number} reviewed"), Some(&review));
                    self.task_settled(goal, milestone_index, &format!("{number} done — {review}"));
                }
            }
            self.changed(&goal.id);
            self.nudge(&goal.id);
            return;
        }

        match job.status {
            JobStatus::Succeeded => {
                let report = first_line(job.result.as_deref().unwrap_or(""), 240);
                self.write_job_note(loaded, milestone_index, task_index, job);
                // A review on another provider, when the run asks for one and
                // the team has someone who can give it.
                if goal.review_tasks
                    && let Some(live) = self.live_for(goal, false).await
                    && let Some(delegation) = &self.inner.delegation
                    && let Some(reviewer) = pick_reviewer(delegation.combo(&live.handle).unwrap_or_default().workers.as_slice(), job.provider)
                {
                    let args = DelegateArgs { task: review_task(milestone, milestone_index, task_index, job), worker: Some(reviewer), capability: None, files: Vec::new(), continue_job: None };
                    if let Ok(review) = delegation.delegate(&live.handle, args) {
                        let _ = self.db(|storage| {
                            storage.step_set_review(&step.id, Some(&format!("{REVIEWING}:{}", review.id)))?;
                            storage.step_set_state(&step.id, StepState::InProgress, Some(&report))
                        });
                        self.journal(&goal.id, JournalKind::Check, Some(&milestone.id), &format!("Task {number} went to {} for review", review.worker), Some(&format!("{} · {}", review.provider.label(), review.model.as_deref().unwrap_or("default model"))));
                        self.changed(&goal.id);
                        return;
                    }
                }
                let _ = self.db(|storage| storage.step_set_state(&step.id, StepState::Done, Some(&report)));
                self.journal(&goal.id, JournalKind::Plan, Some(&milestone.id), &format!("{} finished task {number}", job.worker), Some(&report));
                self.task_settled(goal, milestone_index, &format!("{number} done by {} ({}): {report}", job.worker, job.provider.label()));
            }
            JobStatus::Failed | JobStatus::Cancelled => {
                let why = job.error.clone().unwrap_or_else(|| format!("the job ended {:?}", job.status).to_lowercase());
                let _ = self.db(|storage| storage.step_set_state(&step.id, StepState::Blocked, Some(&why)));
                self.journal(&goal.id, JournalKind::Plan, Some(&milestone.id), &format!("Task {number} did not finish"), Some(&why));
                self.task_settled(goal, milestone_index, &format!("{number} blocked: {why}"));
            }
            _ => {}
        }
        self.changed(&goal.id);
        self.nudge(&goal.id);
    }

    /// Collects finished tasks into one delta, so the orchestrator hears
    /// about the milestone's work in one continuation.
    fn task_settled(&self, goal: &crate::storage::odyssey::OdysseyRecord, _milestone_index: usize, line: &str) {
        let mut deltas = self.deltas(&goal.id);
        match deltas.iter_mut().find_map(|delta| if let Delta::TasksFinished { lines } = delta { Some(lines) } else { None }) {
            Some(lines) => lines.push(line.to_string()),
            None => deltas.push(Delta::TasksFinished { lines: vec![line.to_string()] }),
        }
        self.set_deltas(&goal.id, &deltas);
    }

    /// The worker's report on disk, where the next turn looks, when the worker
    /// did not write one itself.
    fn write_job_note(&self, loaded: &Loaded, milestone_index: usize, task_index: usize, job: &JobView) {
        let Some(result) = job.result.as_deref() else { return };
        let Some(root) = loaded.goal.session_id.as_deref().and_then(|row| self.inner.host.live(row)).map(|live| live.root) else { return };
        let slug = task_slug(milestone_index, task_index, &loaded.milestones[milestone_index].steps[task_index].title);
        let path = root.join(AGENT_NOTES_DIR).join(format!("{slug}.md"));
        if path.exists() {
            return;
        }
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, format!("# {slug}\n\nWorker: {} ({}{})\n\n{result}\n", job.worker, job.provider.label(), job.model.as_deref().map(|model| format!(" · {model}")).unwrap_or_default()));
    }
}

/// A reviewer on another provider: one with `review` first, else anyone.
pub fn pick_reviewer(workers: &[crate::delegation::WorkerSlot], author: Provider) -> Option<String> {
    workers
        .iter()
        .filter(|worker| worker.provider != author)
        .max_by_key(|worker| worker.has("review"))
        .map(|worker| worker.name.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delegation::WorkerSlot;
    use crate::storage::odyssey::MilestoneState;
    use crate::bigthing::tests::{milestone, step};

    #[test]
    fn a_task_is_named_and_written_for_a_worker_who_sees_nothing_else() {
        assert_eq!(task_slug(5, 2, "Price the ships!"), "6.3-price-the-ships");
        assert_eq!(task_slug(0, 0, "???"), "1.1");
        let mut m = milestone("m", MilestoneState::Active);
        m.title = "Economy".into();
        m.section = Some("## Economy".into());
        let mut first = step("a", StepState::Done);
        first.title = "Model".into();
        let mut second = step("b", StepState::Pending);
        second.title = "Price the ships".into();
        m.steps = vec![first, second];
        let text = worker_task(Some("docs/plan.md"), &m, 5, 1, Some("round the prices"));
        assert!(text.starts_with("6.2-price-the-ships: Price the ships"));
        assert!(text.contains("Spec: ## Economy in `docs/plan.md`."));
        assert!(text.contains("6.1 Model (done)"));
        assert!(text.contains("round the prices"));
        assert!(text.contains("docs/big-thing/agents/6.2-price-the-ships.md"));
    }

    #[test]
    fn a_verdict_is_read_or_not_at_all() {
        assert_eq!(read_verdict("Looks good.\nVERDICT: approve"), Some(None));
        assert_eq!(read_verdict("**VERDICT: changes — the totals are wrong**"), Some(Some("the totals are wrong".into())));
        assert_eq!(read_verdict("`VERDICT: changes`"), Some(Some("the reviewer asked for changes".into())));
        assert_eq!(read_verdict("I reviewed it, fine"), None);
    }

    #[test]
    fn the_reviewer_is_on_another_provider() {
        let worker = |name: &str, provider, capabilities: &[&str]| WorkerSlot { name: name.into(), provider, model: None, effort: None, capabilities: capabilities.iter().map(|c| c.to_string()).collect(), note: None };
        let team = vec![worker("luna", Provider::Codex, &["image"]), worker("sonnet", Provider::Claude, &["review"]), worker("gem", Provider::Gemini, &[])];
        assert_eq!(pick_reviewer(&team, Provider::Codex).as_deref(), Some("sonnet"));
        assert_ne!(pick_reviewer(&team, Provider::Claude).as_deref(), Some("sonnet"), "never the author's own provider");
        assert_eq!(pick_reviewer(&team[..1], Provider::Codex), None);
    }
}
