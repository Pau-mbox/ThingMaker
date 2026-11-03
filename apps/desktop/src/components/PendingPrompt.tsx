import { t } from "../i18n";
import { useStore } from "../store";

/** Presentation only: never add an optimistic message to canonical history. */
export function PendingPrompt({ sessionId }: { sessionId: string }) {
  const session = useStore((state) => state.sessions[sessionId]);
  const prompt = session?.pendingPrompt;
  if (!session || !prompt) return null;
  const { projection } = session;
  if (projection.messages.has(`user|prompt-${prompt.requestId}`)
    || projection.queue.items.some((item) => item.id === prompt.requestId)) return null;
  return (
    <article aria-busy={!prompt.accepted} className="card card-user">
      <header className="small muted">{t("You")} · <span role="status">{t(prompt.accepted ? (prompt.queued ? "Queued" : "Sent") : "Sending…")}</span></header>
      {prompt.text && <div style={{ whiteSpace: "pre-wrap" }}>{prompt.text}</div>}
      {prompt.attachments.map((attachment) => <div className="small muted" key={attachment.id}>{attachment.name}</div>)}
      {prompt.mentions.map((mention, index) => <div className="small muted" key={index}>@{mention.relativePath}</div>)}
    </article>
  );
}
