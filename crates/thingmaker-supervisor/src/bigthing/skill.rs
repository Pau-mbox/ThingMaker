//! The gate on the `big-thing` skill: the protocol the agents load is the
//! one this code implements.
//!
//! A skill that drifts from the parser teaches the model a grammar Big Thing
//! ignores. So every grammar it quotes is compared with the real one, every
//! example line in it is parsed with the real parser, and the enumerations it
//! documents are compared with the real ones.

/// The skill, as installed into `~/.agents/skills/big-thing`.
pub const SKILL_MD: &str = include_str!("../../../../runtime/skills/big-thing/SKILL.md");

#[cfg(test)]
mod tests {
    use super::SKILL_MD as SKILL;
    use crate::bigthing::{
        prompt::{DELEGATE_NAME, milestone_state_label},
        protocol::{AMEND_GRAMMAR, ASK_GRAMMAR, PLAN_GRAMMAR, REPORT_GRAMMAR, ReportStatus, TASK_GRAMMAR, TaskStatus, parse_amendment, parse_asks, parse_plan, parse_report, parse_task_lines},
    };
    use crate::storage::odyssey::{CheckKind, MilestoneState};

    fn section(heading: &str) -> String {
        let start = SKILL.find(&format!("## {heading}")).unwrap_or_else(|| panic!("the skill has a \"{heading}\" section"));
        let rest = &SKILL[start + 3..];
        let end = rest.find("\n## ").map(|end| start + 3 + end).unwrap_or(SKILL.len());
        SKILL[start..end].replace("**", "").split_whitespace().collect::<Vec<_>>().join(" ")
    }

    fn lines_starting(prefix: &str, grammar_marker: &str) -> Vec<&'static str> {
        SKILL.lines().filter(|line| line.starts_with(prefix) && !line.contains(grammar_marker)).collect()
    }

    #[test]
    fn front_matter_names_the_skill_and_says_when_to_load_it() {
        let front = SKILL.strip_prefix("---\n").and_then(|rest| rest.split_once("\n---\n")).map(|(front, _)| front).expect("front matter");
        assert!(front.lines().any(|line| line == "name: big-thing"));
        let description = front.lines().find_map(|line| line.strip_prefix("description: ")).expect("a description");
        assert!(description.len() > 40 && description.contains("Use when"));
    }

    #[test]
    fn it_quotes_every_grammar_the_parsers_read() {
        for grammar in [REPORT_GRAMMAR, PLAN_GRAMMAR, AMEND_GRAMMAR, TASK_GRAMMAR, ASK_GRAMMAR] {
            assert!(SKILL.contains(grammar), "the skill quotes:\n{grammar}");
        }
    }

    #[test]
    fn every_example_line_parses_to_what_it_claims() {
        let reports = lines_starting("BIGTHING-REPORT: ", "milestone=<");
        assert!(reports.len() >= 2);
        let statuses: Vec<ReportStatus> = reports.iter().map(|line| parse_report(line).unwrap_or_else(|| panic!("parses: {line}")).status).collect();
        assert!(statuses.contains(&ReportStatus::Complete) && statuses.contains(&ReportStatus::Blocked), "both outcomes are shown");
        let tasks = lines_starting("BIGTHING-TASK: ", "milestone=<");
        assert!(tasks.len() >= 3);
        let mut seen = Vec::new();
        for line in &tasks {
            let parsed = parse_task_lines(line);
            assert_eq!(parsed.len(), 1, "parses: {line}");
            seen.push(parsed[0].status);
        }
        for status in [TaskStatus::InProgress, TaskStatus::Done, TaskStatus::Blocked] {
            assert!(seen.contains(&status));
        }
        let asks = lines_starting("BIGTHING-ASK: ", "kind=<");
        assert!(asks.len() >= 2);
        for line in asks {
            assert_eq!(parse_asks(line).len(), 1, "parses: {line}");
        }
    }

    #[test]
    fn the_grammars_filled_in_are_read_back() {
        let plan = PLAN_GRAMMAR
            .replace("<title>", "Phase one")
            .replace("<one line, optional>", "Do the thing.")
            .replace("<manual | command <cmd> | tests_pass <cmd> | files_exist <paths>>", "tests_pass cargo test")
            .replace("<task title, repeatable — three to eight per milestone, in order>", "first step")
            .replace("<numbers of earlier tasks in this milestone the one above waits for, optional>", "")
            .replace("<what the task needs from a worker, e.g. image or review, optional>", "review");
        let plan = parse_plan(&plan).expect("a plan");
        assert_eq!(plan.milestones[0].title, "Phase one");
        assert_eq!(plan.milestones[0].check_spec.as_deref(), Some("cargo test"));
        assert_eq!(plan.milestones[0].steps[0].capability.as_deref(), Some("review"));
        let amend = AMEND_GRAMMAR
            .replace("<title>", "Ship art")
            .replace("<milestone number, or \"end\">", "2")
            .replace("revise: <milestone number>", "revise: 3")
            .replace("drop: <milestone number>", "drop: 4")
            .replace("<one line>", "merged");
        let ops = parse_amendment(&amend).expect("an amendment").ops;
        assert!(ops.len() >= 3);
    }

    #[test]
    fn it_names_every_tool_the_team_server_carries() {
        for tool in ["bigthing_report", "bigthing_task", "bigthing_ask", "bigthing_amend", "bigthing_propose_plan", "memory_read", "memory_write", "board"] {
            assert!(SKILL.contains(&format!("`{tool}`")), "the skill names `{tool}`");
        }
    }

    #[test]
    fn it_documents_exactly_the_real_check_kinds_and_run_states() {
        let table = &SKILL[SKILL.find("| Check | Done when |").expect("the check table")..];
        let table = &table[..table.find("\n\n").unwrap_or(table.len())];
        let mut kinds: Vec<&str> = table.lines().filter_map(|line| line.strip_prefix("| `")).filter_map(|rest| rest.split_once('`').map(|(kind, _)| kind)).collect();
        kinds.sort_unstable();
        let mut real: Vec<&str> = [CheckKind::Manual, CheckKind::Command, CheckKind::FilesExist, CheckKind::TestsPass].iter().map(|kind| kind.as_str()).collect();
        real.sort_unstable();
        assert_eq!(kinds, real);
        let states = section("Run states");
        for state in ["draft", "running", "waiting_usage", "paused", "blocked", "complete", "abandoned"] {
            assert!(states.contains(&format!("`{state}`")), "{state}");
        }
        for state in ["planned", "active", "reported", "verified", "failed", "skipped"] {
            assert!(states.contains(&format!("`{state}`")), "{state}");
        }
    }

    #[test]
    fn it_reads_the_same_as_the_briefing() {
        let inherited = section("You may be picking up someone else's run");
        assert!(inherited.contains(crate::odyssey_notes::STATE_NOTE_PATH));
        assert!(inherited.contains(crate::odyssey_notes::AGENT_NOTES_DIR));
        assert!(inherited.contains(milestone_state_label(MilestoneState::Verified)));
        assert!(inherited.contains(milestone_state_label(MilestoneState::Reported)));
        assert!(section("Subagents").contains(&format!("subagent_type: {DELEGATE_NAME}")));
        assert!(SKILL.contains("briefing** once per session"));
        assert!(SKILL.contains("is a **claim**, not a verification"));
        assert!(SKILL.contains("Only a check or the user produces `verified`"));
        assert!(SKILL.contains("as its own shell call"));
        let team = section("Leading a team");
        assert!(team.contains("`delegate`") && team.contains("not evidence for the run") && team.contains("hands the milestone's ready tasks"));
        assert!(!SKILL.contains("acp.kit") && !SKILL.split(|c: char| !c.is_alphanumeric()).any(|word| word == "Kit"));
    }
}
