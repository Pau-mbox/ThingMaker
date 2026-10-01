//! Writing what the agent proposed into the record.
//!
//! Targets were resolved against the list as it stood before anything was
//! applied (`protocol::resolve_ops`), so an insert in the middle cannot shift
//! the numbers the agent meant. Additions go in last and are placed
//! afterwards for the same reason. Every operation, refusals included, ends
//! up in the journal row this returns the lines for.

use super::protocol::{AmendOp, Place, ProposedPlan, ProposedTask, ResolvedOp, describe_op};
use crate::storage::{
    Storage, StorageError,
    odyssey::{MilestoneEdit, MilestoneRecord, StepEdit, StepRecord},
};

/// Writes proposed tasks under a milestone and wires their dependencies.
/// Numbers count the tasks that already exist first.
pub fn create_tasks(storage: &Storage, milestone_id: &str, tasks: &[ProposedTask], existing: &[StepRecord]) -> Result<Vec<StepRecord>, StorageError> {
    let mut created = Vec::new();
    for task in tasks {
        created.push(storage.step_add_with(milestone_id, &task.title, "", &[], task.capability.as_deref())?);
    }
    let all: Vec<&StepRecord> = existing.iter().chain(created.iter()).collect();
    for (index, task) in tasks.iter().enumerate() {
        let step = &created[index];
        if task.depends.is_empty() {
            continue;
        }
        let ids: Vec<String> = task.depends.iter().filter_map(|n| all.get(n.wrapping_sub(1)).map(|step| step.id.clone())).filter(|id| *id != step.id).collect();
        if !ids.is_empty() {
            storage.step_edit(&step.id, &StepEdit { depends_on: Some(ids), ..StepEdit::default() })?;
        }
    }
    Ok(created)
}

fn dedupe(ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out = Vec::new();
    for id in ids {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// Applies resolved operations; returns one line per operation for the
/// journal, in the block's order.
pub fn apply_ops(storage: &Storage, goal_id: &str, milestones: &[MilestoneRecord], resolved: &[ResolvedOp]) -> Result<Vec<String>, StorageError> {
    let mut applied = Vec::new();
    for entry in resolved {
        applied.push(describe_op(entry, milestones));
        if entry.refused.is_some() {
            continue;
        }
        let milestone = entry.milestone.and_then(|index| milestones.get(index));
        let step = milestone.and_then(|milestone| entry.step.and_then(|index| milestone.steps.get(index)));
        match (&entry.op, milestone, step) {
            (AmendOp::Revise { title, detail, section, check_kind, check_spec, steps, .. }, Some(milestone), _) => {
                let edit = MilestoneEdit {
                    title: title.clone(),
                    detail: detail.clone(),
                    check_kind: *check_kind,
                    check_spec: check_kind.map(|_| check_spec.clone()),
                    section: section.clone().map(Some),
                };
                storage.milestone_edit(&milestone.id, &edit)?;
                if !steps.is_empty() {
                    create_tasks(storage, &milestone.id, steps, &milestone.steps)?;
                }
            }
            (AmendOp::Drop { .. }, Some(milestone), _) => storage.milestone_delete(&milestone.id)?,
            (AmendOp::DropTask { .. }, Some(milestone), Some(step)) => {
                // Whatever waited on it now waits on what it waited on.
                for sibling in &milestone.steps {
                    if !sibling.depends_on.contains(&step.id) {
                        continue;
                    }
                    let depends = dedupe(sibling.depends_on.iter().filter(|id| **id != step.id).cloned().chain(step.depends_on.iter().filter(|id| **id != sibling.id).cloned()));
                    storage.step_edit(&sibling.id, &StepEdit { depends_on: Some(depends), ..StepEdit::default() })?;
                }
                storage.step_delete(&step.id)?;
            }
            (AmendOp::ReviseTask { title, detail, depends, .. }, Some(milestone), Some(step)) => {
                let depends = depends.as_ref().map(|numbers| numbers.iter().filter_map(|n| milestone.steps.get(n.wrapping_sub(1)).map(|step| step.id.clone())).filter(|id| *id != step.id).collect());
                storage.step_edit(&step.id, &StepEdit { title: title.clone(), detail: detail.clone(), depends_on: depends })?;
            }
            (AmendOp::SplitTask { steps, .. }, Some(milestone), Some(step)) => {
                // The pieces inherit what the whole waited on and sit where it
                // sat; whatever waited on the whole waits on the last piece.
                let mut pieces = Vec::new();
                for piece in steps {
                    pieces.push(storage.step_add_with(&milestone.id, &piece.title, "", &[], piece.capability.as_deref())?);
                }
                let all: Vec<&StepRecord> = milestone.steps.iter().chain(pieces.iter()).collect();
                for (index, piece) in steps.iter().enumerate() {
                    let created = &pieces[index];
                    let own = piece.depends.iter().filter_map(|n| all.get(n.wrapping_sub(1)).map(|step| step.id.clone())).filter(|id| *id != created.id && *id != step.id);
                    let depends = dedupe(step.depends_on.iter().cloned().chain(own));
                    if !depends.is_empty() {
                        storage.step_edit(&created.id, &StepEdit { depends_on: Some(depends), ..StepEdit::default() })?;
                    }
                }
                if let Some(last) = pieces.last() {
                    for sibling in &milestone.steps {
                        if sibling.id == step.id || !sibling.depends_on.contains(&step.id) {
                            continue;
                        }
                        let depends = dedupe(sibling.depends_on.iter().map(|id| if *id == step.id { last.id.clone() } else { id.clone() }));
                        storage.step_edit(&sibling.id, &StepEdit { depends_on: Some(depends), ..StepEdit::default() })?;
                    }
                }
                let ordered: Vec<String> = milestone.steps.iter().flat_map(|sibling| if sibling.id == step.id { pieces.iter().map(|piece| piece.id.clone()).collect::<Vec<_>>() } else { vec![sibling.id.clone()] }).collect();
                // Deleted before the reorder: a reorder lists every task, and
                // the whole is no longer one of them.
                storage.step_delete(&step.id)?;
                storage.step_reorder(&milestone.id, &ordered)?;
            }
            (AmendOp::MoveTask { after, .. }, Some(milestone), Some(step)) => {
                let mut rest: Vec<String> = milestone.steps.iter().filter(|sibling| sibling.id != step.id).map(|sibling| sibling.id.clone()).collect();
                let anchor = match after {
                    Place::After(n) => milestone.steps.get(n.wrapping_sub(1)).and_then(|target| rest.iter().position(|id| *id == target.id)).map(|index| index + 1).unwrap_or(0),
                    _ => 0,
                };
                rest.insert(anchor.min(rest.len()), step.id.clone());
                storage.step_reorder(&milestone.id, &rest)?;
            }
            _ => {}
        }
    }

    // Additions last, placed afterwards.
    let mut additions: Vec<(String, Option<String>)> = Vec::new();
    for entry in resolved {
        let AmendOp::Add { title, detail, section, check_kind, check_spec, steps, after } = &entry.op else { continue };
        if entry.refused.is_some() {
            continue;
        }
        let created = storage.milestone_add(goal_id, title, detail, *check_kind, check_spec.as_deref(), section.as_deref())?;
        create_tasks(storage, &created.id, steps, &[])?;
        let anchor = match after {
            Place::After(n) => milestones.get(n.wrapping_sub(1)).map(|milestone| milestone.id.clone()),
            _ => None,
        };
        additions.push((created.id, anchor));
    }
    if !additions.is_empty() {
        let current = storage.odyssey_view(goal_id)?.map(|view| view.milestones).unwrap_or_default();
        let added: Vec<&String> = additions.iter().map(|(id, _)| id).collect();
        let mut ordered: Vec<String> = Vec::new();
        for milestone in &current {
            if added.contains(&&milestone.id) {
                continue;
            }
            ordered.push(milestone.id.clone());
            for (id, anchor) in &additions {
                if anchor.as_deref() == Some(milestone.id.as_str()) {
                    ordered.push(id.clone());
                }
            }
        }
        for (id, _) in &additions {
            if !ordered.contains(id) {
                ordered.push(id.clone());
            }
        }
        if ordered.len() == current.len() {
            storage.milestone_reorder(goal_id, &ordered)?;
        }
    }
    Ok(applied)
}

/// Writes a proposed plan into a goal with no milestones yet.
pub fn write_plan(storage: &Storage, goal_id: &str, plan: &ProposedPlan) -> Result<usize, StorageError> {
    for proposed in &plan.milestones {
        let created = storage.milestone_add(goal_id, &proposed.title, &proposed.detail, proposed.check_kind, proposed.check_spec.as_deref(), proposed.section.as_deref())?;
        create_tasks(storage, &created.id, &proposed.steps, &[])?;
    }
    Ok(plan.milestones.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::odyssey::{CheckKind, NewOdyssey, StepState};
    use crate::bigthing::protocol::{TaskRef, parse_amendment, parse_plan, resolve_ops};

    fn storage_with_goal() -> (tempfile::TempDir, Storage, String) {
        let temp = tempfile::tempdir().unwrap();
        let storage = Storage::open(&temp.path().join("t.db")).unwrap();
        let workspace = storage.workspace_upsert("/repo", "/repo", "h").unwrap();
        let goal = storage.odyssey_create(&NewOdyssey { workspace_id: workspace.id, title: "Goal".into(), max_continuations: 10, ..Default::default() }).unwrap();
        (temp, storage, goal.id)
    }

    fn milestones(storage: &Storage, goal: &str) -> Vec<MilestoneRecord> {
        storage.odyssey_view(goal).unwrap().unwrap().milestones
    }

    #[test]
    fn a_plan_is_written_with_its_tasks_and_their_dependencies() {
        let (_temp, storage, goal) = storage_with_goal();
        let plan = parse_plan("BIGTHING-PLAN\nmilestone: One\ncheck: tests_pass cargo test\nstep: a\nstep: b\ndepends: 1\ncapability: image\nmilestone: Two\nEND-BIGTHING-PLAN").unwrap();
        assert_eq!(write_plan(&storage, &goal, &plan).unwrap(), 2);
        let list = milestones(&storage, &goal);
        assert_eq!(list[0].check_kind, CheckKind::TestsPass);
        assert_eq!(list[0].steps[1].depends_on, vec![list[0].steps[0].id.clone()]);
        assert_eq!(list[0].steps[1].capability.as_deref(), Some("image"));
    }

    #[test]
    fn an_amendment_lands_in_order_and_refusals_change_nothing() {
        let (_temp, storage, goal) = storage_with_goal();
        let plan = parse_plan("BIGTHING-PLAN\nmilestone: One\nstep: a\nstep: b\ndepends: 1\nstep: c\ndepends: 2\nmilestone: Two\nmilestone: Three\nEND-BIGTHING-PLAN").unwrap();
        write_plan(&storage, &goal, &plan).unwrap();
        let before = milestones(&storage, &goal);
        storage.step_set_state(&before[0].steps[0].id, StepState::Done, None).unwrap();
        let before = milestones(&storage, &goal);
        let amendment = parse_amendment(
            "BIGTHING-AMEND\nadd: Between\nafter: 1\nstep: x\ndrop: 3\nreason: not needed\nsplit_task: 1.2\nstep: b1\nstep: b2\ndrop_task: 1.1\nreason: done already\nEND-BIGTHING-AMEND",
        )
        .unwrap();
        let resolved = resolve_ops(&amendment.ops, &before);
        let lines = apply_ops(&storage, &goal, &before, &resolved).unwrap();
        assert_eq!(lines.len(), 4);
        assert!(lines[3].contains("refused: task 1.1 is done"), "{lines:?}");
        let after = milestones(&storage, &goal);
        assert_eq!(after.iter().map(|m| m.title.as_str()).collect::<Vec<_>>(), ["One", "Between", "Two"]);
        let titles: Vec<&str> = after[0].steps.iter().map(|step| step.title.as_str()).collect();
        assert_eq!(titles, ["a", "b1", "b2", "c"]);
        let c = &after[0].steps[3];
        assert_eq!(c.depends_on, vec![after[0].steps[2].id.clone()], "what waited on the whole waits on the last piece");
        assert_eq!(after[0].steps[1].depends_on, vec![after[0].steps[0].id.clone()], "the pieces inherit what the whole waited on");
        let moved = resolve_ops(&[AmendOp::MoveTask { task: TaskRef { milestone: 1, task: 4 }, after: Place::Named(crate::bigthing::protocol::PlaceName::Start), reason: String::new() }], &after);
        apply_ops(&storage, &goal, &after, &moved).unwrap();
        assert_eq!(milestones(&storage, &goal)[0].steps[0].title, "c");
    }
}
