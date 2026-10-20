/**
 * The intervention inbox (docs/plans/odyssey.md §11.10): what a run needs a
 * human for, and nothing else.
 *
 * Each item is one decision with the controls that settle it right there —
 * answer or dismiss a question, apply or reject a plan change from its diff,
 * resume a blocked run, verify a claim, open the transcript for a permission
 * request. Items come from `inboxItems`, derived from the record; this
 * component renders and acts.
 */
import { useMemo, useState } from "react";
import type { OdysseyView, PlanChangeRecord, QuestionRecord } from "@thingmaker/contracts";
import { useStore } from "../store";
import { ASK_KIND_LABEL, type AskKind } from "../odysseyAsk";
import { inboxItems, type InboxItem } from "../odysseyInbox";
import { exhaustedCeiling } from "../odysseyRunner";
import { IconAlertCircle, IconCheckCircle, IconMessage } from "./icons";
import { t } from "../i18n";

function ago(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  if (minutes < 1) return t("just now");
  if (minutes < 60) return t("{minutes}m ago", { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t("{hours}h ago", { hours });
  return t("{days}d ago", { days: Math.floor(hours / 24) });
}

/** Everything the inbox counts, for the tab badge. */
export function useInboxItems(sessionId: string, view: OdysseyView | null | undefined): InboxItem[] {
  const questions = useStore((s) => s.odysseyQuestions[sessionId]);
  const planChanges = useStore((s) => s.odysseyPlanChanges[sessionId]);
  const amendments = useStore((s) => s.odysseyAmendments[sessionId]);
  const attention = useStore((s) => s.sessions[sessionId]?.attention ?? null);
  return useMemo(
    () =>
      view
        ? inboxItems({
            goal: view.goal,
            milestones: view.milestones,
            journal: view.journal,
            questions: questions ?? [],
            planChanges: planChanges ?? [],
            amendments: amendments ?? [],
            sessionAttention: attention,
            now: Date.now(),
          })
        : [],
    [view, questions, planChanges, amendments, attention],
  );
}

function QuestionItem({ sessionId, question }: { sessionId: string; question: QuestionRecord }) {
  const answer = useStore((s) => s.odysseyAnswerQuestion);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = (value: string | null) => {
    setBusy(true);
    void answer(sessionId, question.id, value).finally(() => setBusy(false));
  };
  const kind = (Object.keys(ASK_KIND_LABEL) as AskKind[]).includes(question.kind as AskKind) ? ASK_KIND_LABEL[question.kind as AskKind] : question.kind;
  return (
    <li className="card odyssey-inbox-item" data-kind="question">
      <header className="row wrap">
        <IconMessage size={13} />
        <strong className="small">{kind}</strong>
        <span className="small muted">{t("asked {time}", { time: ago(Date.now() - question.at) })}</span>
      </header>
      <p className="odyssey-inbox-question">{question.question}</p>
      {question.fallback && (
        <p className="small muted">
          {t("Meanwhile the agent is:")} <em>{question.fallback}</em>
        </p>
      )}
      {question.options.length > 0 && (
        <div className="row wrap odyssey-inbox-options">
          {question.options.map((option) => (
            <button className="button button-small" disabled={busy} key={option} onClick={() => submit(option)} type="button">
              {option}
            </button>
          ))}
        </div>
      )}
      <div className="row wrap">
        <input aria-label={t("Your answer")} className="input" onChange={(event) => setText(event.target.value)} placeholder={t("Or answer in your own words…")} value={text} />
        <button className="button button-small button-primary" disabled={busy || !text.trim()} onClick={() => submit(text)} type="button">
          {t("Answer")}
        </button>
        <button className="link small" disabled={busy} onClick={() => submit(null)} title={t("The agent keeps the default it named")} type="button">
          {t("dismiss, keep the default")}
        </button>
      </div>
    </li>
  );
}

export function PlanChangeDiff({ change }: { change: PlanChangeRecord }) {
  return (
    <ul className="odyssey-plan-diff">
      {change.summary.split("\n").map((line, index) => {
        const sign = line.slice(0, 1);
        const refused = line.includes(" — refused: ");
        return (
          <li className={`odyssey-plan-diff-line sign-${sign === "+" ? "add" : sign === "−" ? "drop" : sign === "~" ? "revise" : sign === "⇄" ? "split" : "move"} ${refused ? "refused" : ""}`} key={index}>
            <span className="mono odyssey-plan-diff-sign">{sign}</span>
            <span className="small">{line.slice(2)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function PlanChangeItem({ sessionId, change }: { sessionId: string; change: PlanChangeRecord }) {
  const decide = useStore((s) => s.odysseyDecidePlanChange);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const run = (decision: "apply" | "reject") => {
    setBusy(true);
    void decide(sessionId, change.id, decision, note.trim() || undefined).finally(() => setBusy(false));
  };
  const count = change.summary.split("\n").filter(Boolean).length;
  return (
    <li className="card odyssey-inbox-item" data-kind="plan_change">
      <header className="row wrap">
        <IconAlertCircle size={13} />
        <strong className="small">{t("Plan change proposed")}</strong>
        <span className="small muted">
          {count === 1 ? t("{count} operation", { count: 1 }) : t("{count} operations", { count })} · {ago(Date.now() - change.at)}
        </span>
      </header>
      {change.reason && (
        <p className="small muted">
          {t("Why:")} <em>{change.reason}</em>
        </p>
      )}
      <PlanChangeDiff change={change} />
      <p className="small muted">{t("The agent works to the current plan until you decide. Refused lines are shown so nothing asked for disappears silently.")}</p>
      <div className="row wrap">
        <button className="button button-small button-primary" disabled={busy} onClick={() => run("apply")} type="button">
          {t("Apply")}
        </button>
        <button className="button button-small" disabled={busy} onClick={() => run("reject")} type="button">
          {t("Reject")}
        </button>
        <input aria-label={t("Note to the agent")} className="input" onChange={(event) => setNote(event.target.value)} placeholder={t("A note for the agent, optional")} value={note} />
      </div>
    </li>
  );
}

export function InboxPanel({ sessionId, view }: { sessionId: string; view: OdysseyView }) {
  const items = useInboxItems(sessionId, view);
  const odysseyStart = useStore((s) => s.odysseyStart);
  const verify = useStore((s) => s.odysseyVerifyManually);
  const runCheck = useStore((s) => s.odysseyRunCheck);
  const discard = useStore((s) => s.odysseyDiscardAmendment);
  const setSessionTab = useStore((s) => s.setSessionTab);

  const openQuestions = items.filter((item) => item.kind === "question").length;
  // The one remedy Resume genuinely cannot apply.
  const ceiling = exhaustedCeiling(view.goal);

  if (items.length === 0) {
    return (
      <section className="card odyssey-inbox-empty">
        <p className="small muted">
          {t(
            "Nothing needs you. The run decides everything it can by itself; what lands here is a question only you can answer, a plan change to accept, a run that stopped, or a check that keeps failing.",
          )}
        </p>
      </section>
    );
  }

  return (
    <ul className="odyssey-inbox" aria-label={t("Inbox")}>
      {items.map((item) => {
        switch (item.kind) {
          case "question":
            return <QuestionItem key={item.id} question={item.question} sessionId={sessionId} />;
          case "plan_change":
            return <PlanChangeItem change={item.change} key={item.id} sessionId={sessionId} />;
          case "amendment_stuck":
            return (
              <li className="card odyssey-inbox-item" data-kind="amendment_stuck" key={item.id}>
                <header className="row wrap">
                  <IconAlertCircle size={13} />
                  <strong className="small">{t("The agent did not fold in your change")}</strong>
                  <span className="small muted">{t("told {count} times", { count: item.amendment.tellCount })}</span>
                </header>
                <p className="small">{item.amendment.note}</p>
                <div className="row wrap">
                  <button className="button button-small" onClick={() => void discard(sessionId, item.amendment.id)} type="button">
                    {t("Withdraw it")}
                  </button>
                  <span className="small muted">{t("Or edit the plan by hand in the Roadmap; the agent will not be asked again.")}</span>
                </div>
              </li>
            );
          case "blocked":
            return (
              <li className="card odyssey-inbox-item" data-kind="blocked" key={item.id}>
                <header className="row wrap">
                  <IconAlertCircle size={13} />
                  <strong className="small">{t("The run is blocked")}</strong>
                  <span className="small muted">{ago(Date.now() - item.at)}</span>
                </header>
                <p className="small">{item.reason}</p>
                {openQuestions > 0 && (
                  <p className="small chip-warn">
                    {openQuestions === 1
                      ? t("The agent has a question open above. Resuming without answering repeats the same turn.")
                      : t("The agent has {count} questions open above. Resuming without answering repeats the same turn.", { count: openQuestions })}
                  </p>
                )}
                <div className="row wrap">
                  <button className="button button-small button-primary" onClick={() => void odysseyStart(sessionId)} type="button">
                    {t("Resume")}
                  </button>
                  {/* Only when that is actually why it stopped. Said next to
                      every block, it explained a budget ceiling to someone
                      whose run had been stopped by something else entirely. */}
                  {ceiling && (
                    <span className="small muted">
                      {ceiling.kind === "tokens"
                        ? t("Resuming cannot clear this: {used} of {limit} tokens are spent. Raise the ceiling in Settings.", { used: ceiling.used.toLocaleString(), limit: ceiling.limit.toLocaleString() })
                        : t("Resuming cannot clear this: {used} of {limit} continuations are spent. Raise the ceiling in Settings.", { used: ceiling.used.toLocaleString(), limit: ceiling.limit.toLocaleString() })}
                    </span>
                  )}
                </div>
              </li>
            );
          case "repeated_failure":
            return (
              <li className="card odyssey-inbox-item" data-kind="repeated_failure" key={item.id}>
                <header className="row wrap">
                  <IconAlertCircle size={13} />
                  <strong className="small">
                    {t("Milestone {number} failed its check {count} times in a row", { number: item.index + 1, count: item.failures })}
                  </strong>
                </header>
                <p className="small">{item.milestone.title}</p>
                {item.lastOutput && <pre className="text odyssey-inbox-output">{item.lastOutput.split("\n").slice(-6).join("\n")}</pre>}
                <div className="row wrap">
                  <button className="button button-small" onClick={() => void runCheck(sessionId, item.milestone.id)} type="button">
                    {t("Run the check again")}
                  </button>
                  <button className="button button-small" onClick={() => void verify(sessionId, item.milestone.id)} title={t("Mark it verified on your own judgement")} type="button">
                    {t("Accept anyway")}
                  </button>
                </div>
              </li>
            );
          case "claim":
            return (
              <li className="card odyssey-inbox-item" data-kind="claim" key={item.id}>
                <header className="row wrap">
                  <IconCheckCircle size={13} />
                  <strong className="small">{t("Milestone {number} is reported complete and waits for your tick", { number: item.index + 1 })}</strong>
                </header>
                <p className="small">{item.milestone.title}</p>
                {item.milestone.reportedNote && <p className="small muted">{t("The agent says: {note}", { note: item.milestone.reportedNote })}</p>}
                <button className="button button-small button-primary" onClick={() => void verify(sessionId, item.milestone.id)} type="button">
                  {t("Verify")}
                </button>
              </li>
            );
          case "needs_input":
            return (
              <li className="card odyssey-inbox-item" data-kind="needs_input" key={item.id}>
                <header className="row wrap">
                  <IconAlertCircle size={13} />
                  <strong className="small">{t("The agent is asking for input")}</strong>
                </header>
                <p className="small muted">{t("A permission or a prompt the agent cannot answer itself is waiting in the transcript.")}</p>
                <button className="button button-small button-primary" onClick={() => setSessionTab("transcript")} type="button">
                  {t("Open the transcript")}
                </button>
              </li>
            );
        }
      })}
    </ul>
  );
}
