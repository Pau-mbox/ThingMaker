/**
 * What ties the conversation to the Big Thing board.
 *
 * Big Thing drives a goal through this session's own turns: the board is the
 * record of the run, the conversation is where it happens. These say so — a
 * line above the conversation while a goal runs in it, and Big Thing's prompts
 * marked as Big Thing's rather than the user's, each linking to its milestone.
 */
import type { Card } from "../projection";
import type { BigThingTurn } from "../bigThingTurns";
import { useStore } from "../store";
import { IconCode } from "./icons";
import { t } from "../i18n";

function turnSummary(turn: BigThingTurn): string {
  switch (turn.kind) {
    case "briefing":
      return t("Big Thing briefed the agent on the goal");
    case "continuation":
      return t("Big Thing → milestone {n}/{total}: {title}", { n: turn.milestone, total: turn.total, title: turn.title });
    case "planning":
      return t("Big Thing asked the agent to plan the goal");
    case "other":
      return t("Big Thing sent a prompt");
  }
}

/** A prompt Big Thing submitted, folded: its text is for the model. */
export function BigThingTurnCard({ card, sessionId, text, turn }: { card: Extract<Card, { kind: "message" }>; sessionId: string; text: string; turn: BigThingTurn }) {
  const openBigThingAt = useStore((s) => s.openBigThingAt);
  return (
    <details className="card card-bigthing-turn" data-card-key={card.key}>
      <summary title={t("Sent by Big Thing, not by you. Big Thing runs the goal through this conversation.")}>
        <span className="bigthing-turn-mark" aria-hidden="true">
          <IconCode size={13} />
        </span>
        <span className="bigthing-turn-text">{turnSummary(turn)}</span>
        <button
          className="link small"
          onClick={(event) => {
            event.preventDefault();
            openBigThingAt(sessionId, turn.kind === "continuation" ? turn.milestone - 1 : null);
          }}
          type="button"
        >
          {t("Open in Big Thing")}
        </button>
      </summary>
      <pre className="text bigthing-turn-prompt">{text}</pre>
    </details>
  );
}

/** Above the conversation while a goal is, or was, run through it. */
export function BigThingBand({ sessionId }: { sessionId: string }) {
  const view = useStore((s) => s.odyssey[sessionId]);
  const openBigThingAt = useStore((s) => s.openBigThingAt);
  const odysseyPause = useStore((s) => s.odysseyPause);
  if (!view) return null;
  const { goal, milestones } = view;
  if (goal.state === "draft" || goal.state === "abandoned") return null;
  const verified = milestones.filter((milestone) => milestone.state === "verified").length;
  const line =
    goal.state === "running"
      ? t("Big Thing is driving this conversation")
      : goal.state === "waiting_usage"
        ? t("Big Thing is driving this conversation · waiting for the usage window")
        : goal.state === "paused"
          ? t("Big Thing is paused in this conversation")
          : goal.state === "blocked"
            ? t("Big Thing is blocked in this conversation")
            : t("Big Thing ran its goal in this conversation");
  return (
    <div className={`bigthing-band state-${goal.state}`} role="status">
      <span className="bigthing-band-line" title={t("Big Thing sends its prompts into this session, and the agent answers here. A message you send goes to the same agent.")}>
        {goal.state === "running" ? <span className="spinner" aria-hidden="true" /> : <IconCode size={13} />}
        <strong>{line}</strong>
        <span className="muted">
          {" · "}
          {goal.title}
          {" · "}
          {t("{done}/{total} verified", { done: verified, total: milestones.length })}
        </span>
      </span>
      {goal.state === "running" && (
        <button className="link small" onClick={() => void odysseyPause(sessionId)} type="button">
          {t("Pause")}
        </button>
      )}
      <button className="link small" onClick={() => openBigThingAt(sessionId, null)} type="button">
        {t("Open board")}
      </button>
    </div>
  );
}

/** Notes the side session passed to this one, and the user's words after them. */
export function SideNotesCard({ notes, own }: { notes: string[]; own: string }) {
  const openSide = useStore((s) => s.setSessionTab);
  return (
    <>
      <details className="card card-bigthing-turn card-side-note">
        <summary title={t("Passed on by the side transcript, not written by you.")}>
          <span className="bigthing-turn-mark" aria-hidden="true">
            ↳
          </span>
          <span className="bigthing-turn-text">{notes.length === 1 ? t("Side Transcript → this session: {note}", { note: notes[0]! }) : t("Side Transcript → this session: {n} notes", { n: notes.length })}</span>
          <button
            className="link small"
            onClick={(event) => {
              event.preventDefault();
              openSide("side");
            }}
            type="button"
          >
            {t("Open the side transcript")}
          </button>
        </summary>
        <ul className="bigthing-turn-prompt">
          {notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      </details>
      {own && (
        <article className="card card-user">
          <header className="small muted">{t("You")}</header>
          <pre className="text">{own}</pre>
        </article>
      )}
    </>
  );
}
