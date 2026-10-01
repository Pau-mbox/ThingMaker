---
name: odyssey
description: The protocol for working under Odyssey, ThingMaker's long-horizon goal runner — how to turn a plan document into milestones, how to fold a change the user asks for mid-run into the plan, how continuations arrive, how to report a milestone, which check decides that a milestone is done, how to delegate verification to a subagent, how to keep the handoff note and subagent notes the run reads back, and what the run states mean. Use when a prompt says you are working under Odyssey, when you are asked to plan a goal from a document, when you are asked to continue a milestone, or when you need the exact report or plan line.
---

# Working under Odyssey

Odyssey is the ThingMaker runner for goals that take longer than one turn.
It holds an ordered list of milestones, submits your continuations, records
what happened, and parks the run when the account's usage window is spent.

You are being driven. That is the point: you do not need to ask to continue,
and you must not wait for a human between milestones.

## Planning a goal from a document

A goal can be created from a roadmap or tech plan the user dropped on it.
Odyssey does not parse that document: it hands you the whole thing and you
propose the plan. You will get a prompt that says it is planning only.

Reply with nothing but this block:

```text
ODYSSEY-PLAN
milestone: <title>
detail: <one line, optional>
section: <the heading or line range of the document this milestone comes from, optional>
check: <manual | command <cmd> | tests_pass <cmd> | files_exist <paths>>
step: <task title, repeatable — three to eight per milestone, in order>
depends: <numbers of earlier tasks in this milestone the one above waits for, optional>
END-ODYSSEY-PLAN
```

Repeat the `milestone:` group once per milestone, in the order the work has to
happen. `detail:`, `section:`, `check:` and `step:` attach to the `milestone:`
above them; `depends:` attaches to the `step:` above it.

- One reviewable outcome per milestone. Three to twelve is usual.
- `detail:` is the working specification for that milestone: carry the
  document's substance across in its own words, several lines if needed.
- `section:` says where in the document it came from — a heading, or a line
  range — so that later you, and every subagent you raise, read those two
  pages rather than the whole file.
- `step:` lines are the milestone's **tasks**: three to eight, in order, each
  one thing a subagent can be given. `depends: 1, 2` under a task says it
  waits for tasks 1 and 2 of the same milestone. The run tracks tasks — who
  ran each and when — so make them units of work, not headings.
- **A check is a command Odyssey will run itself**, in the workspace root, and
  its exit code is what marks the milestone done. The planning prompt names
  the project's test command when the user has set one; use
  `tests_pass <that command>` for every milestone unless the document names a
  better command for it. A milestone with no runnable check waits for a human
  to tick it — on the first real run that was every milestone, and one claim
  waited eight hours. Only when nothing can be run, leave it `manual`. Never
  invent a command that is not in the repository; an unrecognised check is
  read as `manual`, never guessed into a command.
- Skip anything the document records as already finished; mention it in that
  milestone's `detail:` rather than adding it as work.
- If the document is not a plan for this goal, reply with **no block** and say
  what you found instead. That is a useful answer; an invented plan is not.

The plan lands as a draft. The user reads it, edits it, and starts the run —
so planning never starts work, and nothing you propose runs until a human has
seen it.

## The loop

1. Odyssey submits a **briefing** once per session: the goal, the milestones,
   each milestone's check, the stop condition and the continuation budget. A
   goal can outlive the session it started in — see *You may be picking up
   someone else's run* — and each new session is briefed from the record.
2. Before every turn it takes a **checkpoint** — the working tree now against
   the tree at the previous checkpoint, so it records exactly what your last
   turn changed. Three turns in a row that change nothing on disk and nothing
   in the plan block the run.
3. It submits a short **continuation** naming the active milestone, the pending
   steps, and anything that changed since your last turn (a milestone verified,
   a check that failed with its exit code and output tail, a plan edit, a
   resume after a usage wait).
4. When your turn settles it reads your report line, runs or reads the
   milestone's check, records the result, and goes round again.

A gap between turns is normal. It usually means the usage window was spent and
Odyssey is waiting for the provider's quota to reset. Nothing failed.

## When the user changes the plan mid-run

The user can add work or correct the plan while you are working. It arrives in
your next prompt as a note, usually with paths to files or folders in the
project. **Open those yourself** — they are references, not attachments, which
is why a folder of a hundred assets costs one line. A document from outside
the project is quoted in the prompt instead, because you cannot reach it.

A line that begins "A note from the user" is an instruction, not work to
place: read it, follow it, and send no block for it.

**You decide where it belongs, but not whether to answer.** Finish the thought
you are on. If the change fits the milestone you are working, do it now; if it
is later work, put it where it goes and carry on.

**Deferring silently loses it.** The block below is the only way a request is
recorded; a prompt you read and set aside is gone as soon as it compacts out of
context. So in the reply where you are asked: either send the block, or say
plainly that the plan already covers it, or say why it does not belong. One of
those three, every time. If you are asked again, it is because none of them
happened.

Reply with this block, in the same reply as any other work:

```text
ODYSSEY-AMEND
add: <title>
after: <milestone number, or "end">
detail: <one line, optional>
section: <heading or line range in the plan document, optional>
check: <manual | command <cmd> | tests_pass <cmd> | files_exist <paths>>
step: <task title, optional, repeatable>
depends: <numbers of earlier tasks the one above waits for, optional>
revise: <milestone number>
title: <new title, optional>
detail: <new detail, optional>
section: <new section reference, optional>
check: <new check, optional>
step: <a task to add to it, optional, repeatable>
depends: <numbers of the milestone's tasks the one above waits for, optional>
drop: <milestone number>
reason: <one line>
drop_task: <task number, e.g. 7.4>
reason: <one line>
revise_task: <task number>
title: <new title, optional>
detail: <new detail, optional>
depends: <numbers of the milestone's tasks it waits for, optional>
split_task: <task number>
step: <each task that replaces it, repeatable>
depends: <numbers of the milestone's tasks the one above waits for, optional>
move_task: <task number>
after: <task number in the same milestone, or "start">
END-ODYSSEY-AMEND
```

- Use as many `add:` / `revise:` / `drop:` groups as you need; the keys under
  each one belong to it.
- Milestone numbers are the ones in the prompt you were given. They are read
  against that list, so a number you quote will not drift as the block applies.
- **A verified milestone cannot be revised or dropped.** A check ran on it, or
  the user ticked it; that is settled. Add a new milestone instead.
- `check:` follows the same rule as the plan block: name one of the four kinds
  or it is read as `manual`. Odyssey runs what you name.
- If the request needs no change to the plan, say so and send **no block**.
  That is a real answer. Do not invent a milestone to look responsive.

### Replanning when reality diverges

The same block is how **you** change the plan when what you found does not
match it: a task that turns out to be two, one that is already done by
another, an order that cannot work, a milestone that needs a task nobody
listed. Use `drop_task:`, `revise_task:`, `split_task:` and `move_task:` for
tasks, `add:` / `revise:` / `drop:` for milestones, and give a `reason:` — the
user reads it next to the diff.

Two rules:

- **Task changes land at once** by default: splitting, reordering, adding,
  revising or dropping tasks inside a milestone is your own housekeeping.
  **Changes to what a milestone is** — adding or dropping one, changing its
  title or its check — are a proposal until the user accepts it. Your next
  continuation says whether it is waiting, applied or rejected. Until it is
  applied, work to the plan as it stands; do not send it again.
- Done tasks and verified milestones are not rewritten. Add instead.

## Working independently

You are trusted to run for days without anyone watching. Almost nothing that
happens to you is the user's problem:

- **A delegate is out of quota, or refuses.** Do the work in your own turn in
  bounded pieces; note in `STATE.md` that you did and why. Never block or ask for
  this: which account pays is already decided by the configuration you were
  given, and the user would rather the work happened.
- **A worker died mid-task.** Read `docs/odyssey/agents/` and the tree,
  finish what it left, and carry on.
- **A tool is slow or timed out once.** Retry it alone; two suites on one
  editor collide. Never run a check while the runner's own check may be
  running.
- **The plan does not match the code.** Change the tasks yourself; propose
  the milestone-level change if there is one; keep working meanwhile.
- **You are unsure of a detail.** Read the specification section the
  milestone names, then the document, then the code. Decide, and record the
  decision in `STATE.md`.

A turn that ends with no report line and real progress is the normal turn.

## Asking the user

Almost everything is yours to decide. A few things are not: a requirement
that can be read two ways with different work behind each, a fork in the
architecture that is expensive to reverse, constraints in the plan that
conflict, a failure that has recurred after honest attempts, a permission you
cannot grant yourself. For those, one line in your reply:

```text
ODYSSEY-ASK: kind=<ambiguity|architecture|conflict|failure|permission> default=<what you do until you hear back> options=<a | b | c, optional> question=<one line>
```

Examples:

```text
ODYSSEY-ASK: kind=architecture default=continuing with plain C# classes options=ECS | plain classes question=Should the economy simulation move to an ECS layout before milestone 8 builds on it?
ODYSSEY-ASK: kind=failure default=leaving the PlayMode suite skipped and noting it in STATE.md question=The touch-input PlayMode tests fail only on the CI editor after three fixes; may I mark them known-flaky for M6?
```

- **Never wait for the answer.** Name the default you are following and carry
  on; the answer, or a dismissal, arrives on a later continuation.
- **One open question at a time**, and rarely. The bar is: a wrong default
  would cost more than a milestone to undo, and nothing you can read decides
  it. Quota, harness choice, tooling, workers, and how to cut a milestone
  into tasks are never questions.
- Ask once. The question stays in the user's inbox until they act on it;
  repeating it costs a turn and adds nothing.
- Do not ask about things the plan, the document or the code answer. Read
  them first. An ask that a search would have settled is noise in the one
  place the user looks for real decisions.

## Reporting a milestone

End your final message with one line, exactly this shape:

```text
ODYSSEY-REPORT: milestone=<n> status=<complete|blocked> note=<one line>
```

- `milestone` is the 1-based number from the briefing's list.
- `status=complete` claims the milestone is finished. `status=blocked` says the
  milestone **cannot be finished by any means you have**: the plan contradicts
  itself, a credential or external system you cannot obtain is required, or
  the check cannot pass as written. The run stops and the user is told, so it
  is expensive. It is **not** for a delegate that is out of quota, a worker
  that died, a plan change you are waiting on, or a tool that is slow — those
  you route around (see "Working independently") and keep going with no
  report line.
- `note` runs to the end of the line. Keep it to one sentence.

Examples that parse:

```text
ODYSSEY-REPORT: milestone=2 status=complete note=onboarding screens build and render
ODYSSEY-REPORT: milestone=4 status=blocked note=the staging credentials are missing
```

Rules:

- **Omit the line while you are mid-work.** A missing line means "work
  continued, nothing claimed", which is the correct thing to say when it is
  true. Odyssey simply continues.
- Write it once, as the last line. If you restate it, the last one is read.
- A malformed line is ignored exactly like a missing one. It is never an error
  and never worth a retry.
- `status=complete` is a **claim**, not a verification. It moves the milestone
  to `reported`, and the badge says `reported · unverified` until a check runs
  or the user ticks it.
- By default the run **carries on** to the next milestone after a claim it
  cannot check — so a false claim does not stall the run, it just leaves a
  milestone permanently marked as your word alone, in front of the person who
  asked for the work. Report `complete` when it is complete.

## What makes a milestone done

The check decides, not your report. Each milestone has one:

| Check | Done when |
| --- | --- |
| `command` | the command exits 0 |
| `tests_pass` | the test command exits 0 |
| `files_exist` | every listed path exists |
| `manual` | the user ticks it |

Two lanes can produce that evidence:

- **Odyssey runs it.** It runs the milestone's command in the workspace root
  and reads the exit code itself. This is the default and needs nothing
  from you.
- **You run it, Odyssey reads it.** If you run the check yourself, Odyssey
  looks in *your tool results* for a shell result whose command is the
  milestone's check and takes that result's exit code.

For the second lane to work, run the check **as its own shell call, with the
command exactly as the briefing states it**. If a turn runs several commands
and none of the results reports which command it was, Odyssey can attribute
nothing and claims nothing — the milestone stays `reported` and the check is
run again by the desktop.

A failing check comes back to you in the next continuation with the command,
the exit code and the last lines of output. Fix the cause; do not re-report the
milestone as complete without changing anything, because a run of turns that
changes nothing on disk and nothing in the plan trips a guard and stops the
goal.

## Tasks

Each milestone is broken into numbered tasks: `6.3` is the third task of
milestone 6. The continuation lists them with the state the record holds —
`done`, `in progress`, `ready`, `waiting on 6.1`, `blocked` — so after a gap
or a compaction you can see what not to redo and what you may start.

Two habits make the task table true:

- **Name each subagent after its task**: `6.3-<slug>`, for example
  `6.3-pricing-model`. The desktop watches the session stream, ties that
  subagent to the task, and records the harness and model it ran on. That is
  how the screen shows which model did the work; nothing else can.
- **Report task moves on a line**, several per reply if several moved:

```text
ODYSSEY-TASK: milestone=<m> task=<t> status=<in_progress|done|blocked> agent=<subagent name, optional> note=<one line, optional>
```

  Examples:

```text
ODYSSEY-TASK: milestone=6 task=3 status=in_progress agent=6.3-pricing-model
ODYSSEY-TASK: milestone=6 task=3 status=done note=prices converge within 20 ticks
ODYSSEY-TASK: milestone=6 task=5 status=blocked note=needs the harbour data from 6.4
```

  A task's `done` is your word, like a report; the milestone's check is still
  what verifies the milestone. A number the record does not have is ignored.
  To add tasks to a milestone that has none, or too few, use `revise:` with
  `step:` lines in an amendment block.

## Your handoff note

The transcript compacts, and the session you are in can be replaced by a
fresh one. The milestone list survives both; your sense of where you are
*inside* a milestone survives neither. So you keep it on disk.

Keep `docs/odyssey/STATE.md` in the workspace. It holds, in this order:

1. **Done** — what is finished and verified, one line each.
2. **In flight** — the active milestone: what is built, what is not, what the
   next turn should do first.
3. **Owned files** — the paths you and your subagents are changing right now.
4. **Learned** — anything true about this project that the plan does not say:
   a command that has to run first, a test that is flaky, a decision you made
   and why.

Rules:

- **Update it before every report line**, and whenever you stop mid-milestone.
  The continuation tells you how old it is; if it says the note does not exist,
  create it that turn.
- Keep it short. It is a note to a colleague who has your plan but not your
  memory, not a log.
- If you have lost the thread — after a long gap, a restart, or a compaction —
  read it first.

## You may be picking up someone else's run

A goal is not tied to the session it started in. It can be moved to a fresh
one — because the old session was restarted, or because the account it was
running on ran out of quota and the run moved to the other one. **Your
briefing says so when it happens**, and it lists every milestone with the
state the record holds.

Nothing of that session's conversation comes with the goal. The record does,
and so does everything the run wrote to the workspace. So when the briefing
says you have inherited a run:

1. Read `docs/odyssey/STATE.md` first. It is where the previous session left
   off, and it was written for exactly this moment.
2. Read `docs/odyssey/agents/`. Work that finished on disk is finished even if
   the session that ordered it is gone.
3. Then look at what the plan says is already done. The briefing tags each
   milestone with its state. One tagged **done — its check passed; do not
   redo it** is finished. One tagged **claimed done by the previous session,
   never verified** is a claim, not a fact, and it is the one thing worth
   checking before you build on it.

Do not start the goal from the beginning, and do not ask the user what
happened. Everything you are entitled to know is in the briefing and in those
two places.

## Subagent notes

Half the subagent work on the first real run was lost: agents died at a quota
wall with their result in memory, and the next turn redid the work. So a
result lives on disk before it is returned.

- **Every subagent you raise writes its result to
  `docs/odyssey/agents/<name>.md` before it returns** — what it did, which
  files it touched, what passed, what it could not finish. Put that
  instruction in the subagent's prompt; it is not automatic.
- Give each subagent the handoff note path and the milestone's `section:` so
  it reads the specification itself instead of your paraphrase of it.
- When a continuation says subagent notes were written since your last turn,
  **read them before raising any of that work again.** A subagent that died
  may have finished on disk.
- You plan, delegate, read results and report. Run the shell yourself to
  verify a subagent's claim or the milestone's own check; routine
  implementation belongs in a subagent.

## Subagents

You may be Claude Code or Codex; a run can be moved from one to the other
when an account is spent, and the briefing says so when it happens. Either
way your subagents are your own, on the same subscription as you, so
delegate for context and independence rather than for budget.

**If you are Claude Code**, raise every subagent with
`subagent_type: odyssey-delegate`, the definition this project carries in
`.claude/agents/`. A subagent's model is a field on its definition and nowhere
else, so the default subagent type runs on whatever the account defaults to,
which is not what the run intends.

**If you are Codex**, raise subagents the way you normally do.

Whichever you are, the milestone's check is Odyssey's to run: it runs the
check itself rather than reading an exit code out of your tool results, so
run the check when you want to know, and let Odyssey be the one that decides.

Everything else is the same: name each subagent after its task, and have it
write its result to `docs/odyssey/agents/<name>.md` before it returns.

A subagent cannot ask for permission. Give a subagent work that runs within
the permissions it already has, and keep anything that would prompt in your
own turn.

## Delegating verification

Raising a subagent to verify is a good use of one: a fresh context that checks
the work rather than the worker arguing its own case. Have the subagent run the
milestone's check as a shell call and report the exit code. The exit code in
the tool record is what counts, so the subagent's opinion does not need to be
trusted — and neither does yours.

## Run states

The state you may see named in the UI or a prompt:

- `draft` — the goal exists and has not started.
- `running` — the runner is working milestones.
- `waiting_usage` — parked until the provider's quota resets.
- `paused` — stopped by the user, or waiting for a tick on a `manual` check.
- `blocked` — a guard tripped, a turn failed, or a milestone is blocked. Needs
  the user.
- `complete` — every milestone is verified or skipped.
- `abandoned` — the user dropped the goal.

Milestones move through `planned` → `active` → `reported` → `verified`, with
`failed` when a check did not pass and `skipped` when the goal moves past one.
Only a check or the user produces `verified`.

## Rules

- Work the active milestone named in the continuation. Do not skip ahead; if a
  later milestone is genuinely blocking the active one, say so in a `blocked`
  report rather than reordering the plan yourself.
- Keep each turn's work bounded and leave the tree in a state a checkpoint can
  describe. The diff between turns is what the user reads to follow the run.
- Do not ask whether to continue. Do not ask for permission to run the
  milestone's own check.
- If the goal itself looks wrong — the milestones do not add up to it, or a
  check cannot pass as written — report `blocked` with the reason. That is the
  designed way to reach the user, and it is better than working around it.
