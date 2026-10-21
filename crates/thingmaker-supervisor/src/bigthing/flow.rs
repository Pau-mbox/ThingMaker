//! How work moves through a milestone's tasks beyond "after these ones".
//!
//! Three things a plan can say about a task, each kept on the task itself:
//!
//! - **a loop**: when the task asks for changes, the work goes back to an
//!   earlier task and every task between the two runs again, with what was
//!   asked, until it approves — or a round limit says what happens instead;
//! - **the user's approval**: a task nobody but the user does. The run stops
//!   there and asks; the answer approves it, sends the work back, or stops
//!   the run;
//! - **inputs**: the earlier tasks whose results the task is given.
//!
//! The pure parts decide what runs again and what a worker is told; the
//! engine methods write that into the record.

use serde::{Deserialize, Serialize};

use super::{
    dispatch::read_verdict,
    engine::{Engine, Loaded},
    prompt::Delta,
    protocol::{task_number, task_status},
};
use crate::{
    DesktopError,
    storage::odyssey::{JournalKind, LoopAtLimit, MilestoneRecord, NewQuestion, OdysseyRecord, OdysseyState, QuestionState, StepKind, StepRecord, StepState},
};

/// A question standing for a task that is the user's own approval.
pub const APPROVAL_KIND: &str = "approval";
/// A question standing for a loop that reached its round limit.
pub const LOOP_LIMIT_KIND: &str = "loop_limit";

/// How much of one earlier task's result a worker is given.
const INPUT_LIMIT: usize = 6_000;

/// What the user decided at an approval, or at a loop's limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approve,
    SendBack,
    Stop,
}

/// What became of a task that finished.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Finished {
    Done,
    /// The work went back for another round.
    SentBack,
    /// A loop reached its limit and the user is asked.
    AskedYou,
    /// A loop reached its limit and the run stopped.
    Stopped,
}

/// Each task, and whether it lies downstream of `from` along dependencies
/// (`from` included).
fn downstream(steps: &[StepRecord], from: usize) -> Vec<bool> {
    let mut reached = vec![false; steps.len()];
    reached[from] = true;
    let mut changed = true;
    while changed {
        changed = false;
        for (index, step) in steps.iter().enumerate() {
            if !reached[index] && step.depends_on.iter().any(|id| steps.iter().position(|other| &other.id == id).is_some_and(|parent| reached[parent])) {
                reached[index] = true;
                changed = true;
            }
        }
    }
    reached
}

/// Each task, and whether `of` depends on it, directly or not (`of` included).
fn upstream(steps: &[StepRecord], of: usize) -> Vec<bool> {
    let mut reached = vec![false; steps.len()];
    reached[of] = true;
    let mut queue = vec![of];
    while let Some(index) = queue.pop() {
        for id in &steps[index].depends_on {
            if let Some(parent) = steps.iter().position(|other| &other.id == id)
                && !reached[parent]
            {
                reached[parent] = true;
                queue.push(parent);
            }
        }
    }
    reached
}

/// The tasks that run again when `decider` sends the work back to `target`:
/// those on the way from one to the other. Without a path between them, the
/// tasks listed between the two.
pub fn loop_span(steps: &[StepRecord], target: usize, decider: usize) -> Vec<usize> {
    let down = downstream(steps, target);
    let up = upstream(steps, decider);
    let span: Vec<usize> = (0..steps.len()).filter(|index| down[*index] && up[*index]).collect();
    if span.contains(&target) && span.contains(&decider) {
        return span;
    }
    (target.min(decider)..=target.max(decider)).collect()
}

/// What sending the work back from `decider` reopens: the loop it names, or,
/// for an approval with no loop, the tasks it waits on directly.
pub fn send_back_span(steps: &[StepRecord], decider: usize) -> Vec<usize> {
    let step = &steps[decider];
    if let Some(target) = step.loop_to.as_deref().and_then(|id| steps.iter().position(|other| other.id == id)) {
        return loop_span(steps, target, decider);
    }
    let mut span: Vec<usize> = step.depends_on.iter().filter_map(|id| steps.iter().position(|other| &other.id == id)).collect();
    span.push(decider);
    span.sort_unstable();
    span.dedup();
    span
}

/// The user's approvals in a milestone that are not given yet, by number.
/// A milestone with one open is not complete, whatever the agent says.
pub fn open_approvals(milestone_index: usize, steps: &[StepRecord]) -> Vec<String> {
    steps.iter().enumerate().filter(|(_, step)| step.kind == StepKind::Approval && step.state != StepState::Done).map(|(task, _)| task_number(milestone_index, task)).collect()
}

/// Where a task sits in the plan: milestone and task index.
pub fn locate(milestones: &[MilestoneRecord], step_id: &str) -> Option<(usize, usize)> {
    milestones.iter().enumerate().find_map(|(milestone, record)| record.steps.iter().position(|step| step.id == step_id).map(|task| (milestone, task)))
}

/// The earlier results a task is given, one block each.
pub fn inputs_for(step: &StepRecord, milestones: &[MilestoneRecord]) -> Vec<String> {
    step.uses
        .iter()
        .filter_map(|id| {
            let (milestone, task) = locate(milestones, id)?;
            let source = &milestones[milestone].steps[task];
            let result: String = match source.result.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
                Some(text) => text.chars().take(INPUT_LIMIT).collect(),
                None => "(no result recorded yet)".into(),
            };
            Some(format!("Result of task {} (\"{}\"):\n{result}", task_number(milestone, task), source.title))
        })
        .collect()
}

/// What a deciding task is told about the verdict it gives.
pub fn verdict_instruction(steps: &[StepRecord], milestone_index: usize, decider: usize) -> Option<String> {
    let target = steps[decider].loop_to.as_deref().and_then(|id| steps.iter().position(|other| other.id == id))?;
    Some(format!(
        "This task decides whether the work so far is good enough. End your reply with one line: `VERDICT: approve`, or `VERDICT: changes — <what must change>`. Changes send the work back to task {} (\"{}\") for another round.",
        task_number(milestone_index, target),
        steps[target].title
    ))
}

/// What a task in its second round or later is told about the last one.
pub fn round_note(step: &StepRecord) -> Option<String> {
    (step.round > 1).then(|| match step.feedback.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
        Some(feedback) => format!("This is round {} of this task. The last round was sent back with: {feedback}", step.round),
        None => format!("This is round {} of this task.", step.round),
    })
}

/// How the board describes a task's place in the flow, after its title.
pub fn flow_suffix(steps: &[StepRecord], milestone_index: usize, index: usize) -> String {
    let step = &steps[index];
    let mut parts = Vec::new();
    if step.kind == StepKind::Approval {
        parts.push("the user's approval".to_string());
    }
    let uses: Vec<String> = step.uses.iter().filter_map(|id| steps.iter().position(|other| &other.id == id)).map(|task| task_number(milestone_index, task)).collect();
    if !uses.is_empty() {
        parts.push(format!("uses {}", uses.join(", ")));
    }
    if let Some(target) = step.loop_to.as_deref().and_then(|id| steps.iter().position(|other| other.id == id)) {
        let limit = step.loop_limit.map(|limit| format!(" of {limit}")).unwrap_or_default();
        parts.push(format!("sends the work back to {} when it asks for changes, round {}{limit}", task_number(milestone_index, target), step.round));
    } else if step.round > 1 {
        parts.push(format!("round {}", step.round));
    }
    if parts.is_empty() { String::new() } else { format!(" ({})", parts.join("; ")) }
}

fn clip(text: &str, limit: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= limit {
        return text.to_string();
    }
    format!("{}…", text.chars().take(limit).collect::<String>())
}

impl Engine {
    /// Opens the user's approvals that are ready in the active milestone,
    /// and names the tasks waiting on the user when nothing else in it can
    /// move — so the run waits rather than prompting for nothing. Also says
    /// whether it opened any, which changes the record.
    pub(crate) fn open_gates(&self, loaded: &Loaded) -> (Vec<String>, bool) {
        let goal = &loaded.goal;
        let carry_on = goal.on_report != crate::storage::odyssey::OnReport::Wait;
        let Some(index) = super::decide::active_milestone(&loaded.milestones, carry_on) else { return (Vec::new(), false) };
        let milestone = &loaded.milestones[index];
        let mut opened = false;
        for (task, step) in milestone.steps.iter().enumerate() {
            if step.kind != StepKind::Approval || task_status(step, &milestone.steps) != "pending" {
                continue;
            }
            if self.db(|storage| storage.question_open_for_step(&step.id)).ok().flatten().is_none() {
                let new = NewQuestion { odyssey_id: goal.id.clone(), kind: APPROVAL_KIND.into(), question: step.title.clone(), options: Vec::new(), fallback: None, step_id: Some(step.id.clone()) };
                let _ = self.db(|storage| storage.question_add(&new));
            }
            let _ = self.db(|storage| storage.step_set_state(&step.id, StepState::InProgress, Some("waiting for you")));
            let number = task_number(index, task);
            self.journal(&goal.id, JournalKind::Plan, Some(&milestone.id), &format!("Task {number} waits for your approval"), Some(&step.title));
            self.announce(goal, &format!("task {number} waits for your approval"));
            self.notify(goal, "needs_input", &format!("task {number} waits for your approval: {}", step.title));
            opened = true;
        }
        let steps = match opened {
            true => self.load(&goal.id).ok().and_then(|fresh| fresh.milestones.get(index).map(|milestone| milestone.steps.clone())).unwrap_or_default(),
            false => milestone.steps.clone(),
        };
        if opened {
            self.changed(&goal.id);
        }
        let waiting: Vec<usize> = steps
            .iter()
            .enumerate()
            .filter(|(_, step)| step.state == StepState::InProgress && self.db(|storage| storage.question_open_for_step(&step.id)).ok().flatten().is_some())
            .map(|(task, _)| task)
            .collect();
        // Anything else that can still move keeps the run going.
        let moving = steps.iter().enumerate().any(|(task, step)| !waiting.contains(&task) && matches!(task_status(step, &steps), "pending" | "in_progress"));
        if waiting.is_empty() || moving {
            return (Vec::new(), opened);
        }
        (waiting.into_iter().map(|task| task_number(index, task)).collect(), opened)
    }

    /// A task finished with `result`. A task that decides a loop reads its
    /// verdict and may send the work back; any other is done.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn task_finished(&self, goal: &OdysseyRecord, milestones: &[MilestoneRecord], milestone_index: usize, task_index: usize, result: Option<&str>, note: &str, who: &str) -> Finished {
        let step = &milestones[milestone_index].steps[task_index];
        if let Some(result) = result.map(str::trim).filter(|text| !text.is_empty()) {
            let _ = self.db(|storage| storage.step_set_result(&step.id, Some(result)));
        }
        if step.loop_to.is_some()
            && let Some(Some(changes)) = result.and_then(read_verdict)
        {
            return self.send_back(goal, milestones, milestone_index, task_index, &changes, who, false).unwrap_or_else(|_| {
                let _ = self.db(|storage| storage.step_set_state(&step.id, StepState::Done, Some(note)));
                Finished::Done
            });
        }
        let _ = self.db(|storage| storage.step_set_state(&step.id, StepState::Done, Some(note).filter(|note| !note.is_empty())));
        Finished::Done
    }

    /// Sends the work back from `decider` for another round, unless its
    /// loop has used its rounds and `past_limit` does not override that.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn send_back(&self, goal: &OdysseyRecord, milestones: &[MilestoneRecord], milestone_index: usize, decider: usize, feedback: &str, who: &str, past_limit: bool) -> Result<Finished, String> {
        let milestone = &milestones[milestone_index];
        let steps = &milestone.steps;
        let step = &steps[decider];
        let number = task_number(milestone_index, decider);
        let feedback = feedback.trim();
        if !past_limit
            && step.kind == StepKind::Work
            && let Some(limit) = step.loop_limit
            && step.round >= limit
        {
            let rounds = format!("{} round{}", step.round, if step.round == 1 { "" } else { "s" });
            let detail = format!("{}\n{feedback}", step.title);
            return Ok(match step.loop_at_limit {
                LoopAtLimit::Ask => {
                    if self.db(|storage| storage.question_open_for_step(&step.id)).ok().flatten().is_none() {
                        let new = NewQuestion {
                            odyssey_id: goal.id.clone(),
                            kind: LOOP_LIMIT_KIND.into(),
                            question: format!("Task {number} (\"{}\") still asks for changes after {rounds}", step.title),
                            options: Vec::new(),
                            fallback: Some(feedback.to_string()).filter(|text| !text.is_empty()),
                            step_id: Some(step.id.clone()),
                        };
                        let _ = self.db(|storage| storage.question_add(&new));
                    }
                    let _ = self.db(|storage| storage.step_set_state(&step.id, StepState::InProgress, Some(&format!("waiting for you after {rounds}"))));
                    self.journal(&goal.id, JournalKind::Check, Some(&milestone.id), &format!("Task {number} still asks for changes after {rounds}; asking you"), Some(&detail));
                    self.notify(goal, "needs_input", &format!("task {number} still asks for changes after {rounds}"));
                    self.changed(&goal.id);
                    Finished::AskedYou
                }
                LoopAtLimit::Stop => {
                    let _ = self.db(|storage| storage.step_set_state(&step.id, StepState::Blocked, Some(&format!("stopped after {rounds}: {}", clip(feedback, 200)))));
                    let _ = self.set_state(&goal.id, OdysseyState::Paused);
                    self.journal(&goal.id, JournalKind::State, Some(&milestone.id), &format!("Stopped: task {number} still asks for changes after {rounds}"), Some(&detail));
                    self.note(&goal.id, "paused at a loop's limit", Some(None));
                    self.notify(goal, "blocked", &format!("stopped: task {number} still asks for changes after {rounds}"));
                    self.changed(&goal.id);
                    Finished::Stopped
                }
                LoopAtLimit::Continue => {
                    let _ = self.db(|storage| storage.step_set_state(&step.id, StepState::Done, Some(&format!("accepted after {rounds}; still asked: {}", clip(feedback, 200)))));
                    self.journal(&goal.id, JournalKind::Check, Some(&milestone.id), &format!("Task {number} reached its {rounds}; the run carries on with the work as it is"), Some(&detail));
                    self.changed(&goal.id);
                    Finished::Done
                }
            });
        }
        let span = send_back_span(steps, decider);
        if span == [decider] {
            return Err(format!("task {number} has no earlier task to send the work back to"));
        }
        let round = step.round + 1;
        let feedback_text = if feedback.is_empty() { format!("{who} sent it back") } else { feedback.to_string() };
        for task in &span {
            let _ = self.db(|storage| storage.step_reopen(&steps[*task].id, Some(&feedback_text), &format!("round {}: sent back by {who}", steps[*task].round + 1)));
        }
        let first = span[0];
        let line = format!("Task {number} sent the work back to task {} for round {round}: {}", task_number(milestone_index, first), clip(&feedback_text, 300));
        self.journal(&goal.id, JournalKind::Check, Some(&milestone.id), &format!("Task {number} sent the work back to task {} (round {round})", task_number(milestone_index, first)), Some(&feedback_text));
        self.queue_delta(&goal.id, Delta::SentBack { line, tasks: span.iter().map(|task| task_number(milestone_index, *task)).collect() });
        self.changed(&goal.id);
        Ok(Finished::SentBack)
    }

    /// The user's answer at an approval, or at a loop's limit.
    pub async fn decide_approval(&self, goal_id: &str, question_id: &str, decision: ApprovalDecision, comment: Option<&str>) -> Result<(), DesktopError> {
        let question = self.db(|storage| storage.question_get(question_id))?.ok_or_else(|| DesktopError::not_ready("question not found"))?;
        if question.state != QuestionState::Open {
            return Err(DesktopError::not_ready("that question is already answered"));
        }
        let step_id = question.step_id.clone().ok_or_else(|| DesktopError::not_ready("that question is not about a task"))?;
        let loaded = self.load(goal_id)?;
        let (milestone_index, task_index) = locate(&loaded.milestones, &step_id).ok_or_else(|| DesktopError::not_ready("that task is no longer in the plan"))?;
        let milestone = &loaded.milestones[milestone_index];
        let step = &milestone.steps[task_index];
        let number = task_number(milestone_index, task_index);
        let comment = comment.map(str::trim).filter(|text| !text.is_empty());
        let at_limit = question.kind == LOOP_LIMIT_KIND;
        let answer = match decision {
            ApprovalDecision::Approve => {
                let note = if at_limit { format!("accepted by you after {} rounds", step.round) } else { "approved by you".to_string() };
                if step.kind == StepKind::Approval {
                    let _ = self.db(|storage| storage.step_set_result(&step.id, Some(comment.unwrap_or("Approved."))));
                }
                self.db(|storage| storage.step_set_state(&step.id, StepState::Done, Some(&note)))?;
                self.journal(goal_id, JournalKind::Check, Some(&milestone.id), &format!("You approved task {number}"), comment);
                self.queue_delta(goal_id, Delta::Approved { line: format!("The user {} task {number}{}", if at_limit { "accepted, as it is," } else { "approved" }, comment.map(|text| format!(": {text}")).unwrap_or_default()) });
                format!("approved{}", comment.map(|text| format!(": {text}")).unwrap_or_default())
            }
            ApprovalDecision::SendBack => {
                let feedback = comment.or(question.fallback.as_deref()).unwrap_or("");
                self.send_back(&loaded.goal, &loaded.milestones, milestone_index, task_index, feedback, "you", true).map_err(DesktopError::not_ready)?;
                format!("sent back{}", comment.map(|text| format!(": {text}")).unwrap_or_default())
            }
            ApprovalDecision::Stop => {
                self.db(|storage| storage.step_set_state(&step.id, StepState::Blocked, Some("stopped by you")))?;
                self.set_state(goal_id, OdysseyState::Paused)?;
                self.journal(goal_id, JournalKind::State, Some(&milestone.id), &format!("You stopped the run at task {number}"), comment);
                self.note(goal_id, "stopped by you", Some(None));
                "stopped the run".to_string()
            }
        };
        self.db(|storage| storage.question_settle(question_id, QuestionState::Answered, Some(&answer)))?;
        self.changed(goal_id);
        self.nudge(goal_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bigthing::tests::step;

    fn chain() -> Vec<StepRecord> {
        // 1 → 2 → 4 → 5, 1 → 3 → 4, and 6 on its own.
        let mut steps: Vec<StepRecord> = (1..=6).map(|n| step(&format!("s{n}"), StepState::Done)).collect();
        steps[1].depends_on = vec!["s1".into()];
        steps[2].depends_on = vec!["s1".into()];
        steps[3].depends_on = vec!["s2".into(), "s3".into()];
        steps[4].depends_on = vec!["s4".into()];
        steps
    }

    #[test]
    fn a_loop_reruns_the_tasks_on_the_way_and_nothing_else() {
        let steps = chain();
        assert_eq!(loop_span(&steps, 0, 4), vec![0, 1, 2, 3, 4]);
        assert_eq!(loop_span(&steps, 1, 4), vec![1, 3, 4], "3 does not lead from 2");
        assert_eq!(loop_span(&steps, 5, 4), vec![4, 5], "no path: the tasks listed between");
    }

    #[test]
    fn an_approval_without_a_loop_sends_the_work_back_to_what_it_waits_on() {
        let mut steps = chain();
        steps[4].kind = StepKind::Approval;
        assert_eq!(send_back_span(&steps, 4), vec![3, 4]);
        steps[4].loop_to = Some("s2".into());
        assert_eq!(send_back_span(&steps, 4), vec![1, 3, 4]);
        assert_eq!(send_back_span(&steps, 5), vec![5], "nothing to go back to");
    }

    #[test]
    fn a_task_is_given_the_results_it_uses_and_what_its_last_round_was_asked() {
        let mut milestone = crate::bigthing::tests::milestone("m", crate::storage::odyssey::MilestoneState::Active);
        milestone.steps = chain();
        milestone.steps[0].title = "Write the design".into();
        milestone.steps[0].result = Some("A puzzle game about bees.".into());
        milestone.steps[3].uses = vec!["s1".into(), "s2".into()];
        let inputs = inputs_for(&milestone.steps[3], std::slice::from_ref(&milestone));
        assert_eq!(inputs[0], "Result of task 1.1 (\"Write the design\"):\nA puzzle game about bees.");
        assert!(inputs[1].ends_with("(no result recorded yet)"));
        milestone.steps[3].round = 3;
        milestone.steps[3].feedback = Some("the bees are too slow".into());
        assert_eq!(round_note(&milestone.steps[3]).as_deref(), Some("This is round 3 of this task. The last round was sent back with: the bees are too slow"));
        assert_eq!(round_note(&milestone.steps[0]), None);
    }

    #[test]
    fn the_board_says_where_a_task_sits_in_the_flow() {
        let mut steps = chain();
        steps[4].loop_to = Some("s1".into());
        steps[4].loop_limit = Some(5);
        steps[4].round = 2;
        steps[3].uses = vec!["s2".into()];
        steps[5].kind = StepKind::Approval;
        assert_eq!(flow_suffix(&steps, 1, 4), " (sends the work back to 2.1 when it asks for changes, round 2 of 5)");
        assert_eq!(flow_suffix(&steps, 1, 3), " (uses 2.2)");
        assert_eq!(flow_suffix(&steps, 1, 5), " (the user's approval)");
        assert!(verdict_instruction(&steps, 1, 4).is_some_and(|text| text.contains("task 2.1")));
        assert_eq!(verdict_instruction(&steps, 1, 3), None);
    }
}
