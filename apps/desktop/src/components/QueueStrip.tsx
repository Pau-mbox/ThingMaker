/**
 * Prompts waiting for the running turn: the session actor's queue.
 *
 * The queue lives in the supervisor, not here, so it keeps sending with the
 * window closed and the phone sees the same list. Each prompt can be moved,
 * taken back into the composer to edit, sent now or dropped. "Send now"
 * steers it into the running turn when the agent can be steered, and
 * otherwise interrupts the turn so it goes next. A queue that stopped after a
 * turn that did not finish says why and waits to be resumed.
 */
import type { QueueView } from "@thingmaker/contracts";
import { useStore } from "../store";
import { IconX } from "./icons";

export function QueueStrip({ sessionId, queue, active, canSteer }: { sessionId: string; queue: QueueView; active: boolean; canSteer: boolean }) {
  const queueOp = useStore((s) => s.queueOp);
  const editQueued = useStore((s) => s.editQueued);
  if (queue.items.length === 0) return null;
  const last = queue.items.length - 1;
  const sendNow = active
    ? canSteer
      ? { label: "Steer in", title: "Send it into the running turn now" }
      : { label: "Interrupt and send", title: "Cancel the running turn and send this next" }
    : { label: "Send now", title: "Send it now" };
  return (
    <div aria-label="Queued prompts" className="queue-strip">
      {queue.paused && (
        <div className="queue-paused small" role="status">
          <span>Queue paused: {queue.paused}.</span>
          <button className="link small" onClick={() => void queueOp(sessionId, { op: "resume" })} title={active ? "Send them after the running turn" : "Send the first one now"} type="button">
            Resume
          </button>
          <button className="link small" onClick={() => void queueOp(sessionId, { op: "clear" })} type="button">
            Clear
          </button>
        </div>
      )}
      <ol className="queue-list">
        {queue.items.map((item, index) => (
          <li className="queue-item" key={item.id}>
            <span className="queue-index small muted">{index + 1}</span>
            <span className="queue-text" title={item.text}>
              {item.text.trim() || <span className="muted">(files only)</span>}
            </span>
            {item.extras > 0 && (
              <span className="chip small" title={`${item.extras} mentioned file${item.extras === 1 ? "" : "s"} or attachment${item.extras === 1 ? "" : "s"}`}>
                +{item.extras}
              </span>
            )}
            <span className="queue-actions">
              <button aria-label="Move up" className="link small" disabled={index === 0} onClick={() => void queueOp(sessionId, { op: "move", id: item.id, index: index - 1 })} type="button">
                ↑
              </button>
              <button aria-label="Move down" className="link small" disabled={index === last} onClick={() => void queueOp(sessionId, { op: "move", id: item.id, index: index + 1 })} type="button">
                ↓
              </button>
              <button className="link small" onClick={() => void editQueued(sessionId, item.id)} title="Take it back into the composer" type="button">
                Edit
              </button>
              <button className="link small" onClick={() => void queueOp(sessionId, { op: "send_now", id: item.id })} title={sendNow.title} type="button">
                {sendNow.label}
              </button>
              <button aria-label="Remove from the queue" className="icon-button icon-button-xs" onClick={() => void queueOp(sessionId, { op: "remove", id: item.id })} title="Remove" type="button">
                <IconX size={12} />
              </button>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
