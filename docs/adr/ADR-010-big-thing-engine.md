# ADR-010: Big Thing runs in the supervisor, and speaks through tools

**Status:** Accepted.

## Decision

The long-horizon runner is a service in the supervisor (`bigthing`), not
code in the web view.

- **The engine owns the loop.** It decides, prompts, reads each settled turn,
  takes checkpoints, runs checks, moves a goal to another account and resumes
  it after a usage reset. It drives sessions through the same session actors
  the user's tabs attach to, and writes every decision to the goal's record
  before it acts. The interface only shows the record and the engine's state,
  and sends the user's actions. A run keeps going when its window is closed or
  the interface reloads, and a running goal whose session is not open is
  reopened by the engine when the app starts.
- **The run protocol is tools.** An orchestrator's `team` MCP server carries
  `bigthing_report`, `bigthing_task`, `bigthing_ask`,
  `bigthing_propose_plan` and `bigthing_amend`. A call is checked against
  the record on the spot (a milestone that does not exist is refused in the
  tool's answer, not discovered later), and the engine applies what the turn
  sent when it settles. The text lines (`BIGTHING-REPORT:` and the rest) are
  still read, for providers that cannot load the session's MCP server.
- **Shared memory is tools too.** `memory_read`, `memory_write` and
  `board` give the orchestrator and its workers one project memory and the
  run's task board. Workers get a reduced server: memory and board only, no
  delegation.
- **A run can have its own worktree.** With isolation on, starting a goal in a
  Git repository creates a branch and worktree for it and opens the run's
  orchestrator there. Each checkpoint is a commit on that branch, a rollback is
  a reset to one of them, and two runs never edit the same tree.
- **The engine can dispatch the plan.** With runner dispatch on, ready tasks
  (nothing they depend on is open) go to the team's workers in parallel, by
  capability, and a finished task can be reviewed by a worker on another
  provider before the milestone is handed back to the orchestrator.

## Consequences

- One decision path, tested in Rust against the mock providers, with a live
  end-to-end test behind `THINGMAKER_REAL_BIGTHING=1`.
- The model-visible tool set grows. Every tool answers from the record and
  writes only to the goal it belongs to; the token that identifies the session
  also identifies the goal, so one session cannot report on another's run.
- Nothing about credentials changes: the engine opens sessions through the
  host the same way the user does, on the same subscriptions.
