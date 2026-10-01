import { memo, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactElement } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { ContentBlock, Mention, ToolPatch } from "@thingmaker/contracts";
import { PROVIDER_LABELS } from "@thingmaker/contracts";
import { useStore, sessionTitle, type SessionTab } from "../store";
import { api } from "../ipc";
import { ConfigPickers } from "./ConfigPickers";
import { TeamChip } from "./TeamEditor";
import { FilesPane } from "./FilesPane";
import { ChangesPane } from "./ChangesPane";
import { TerminalPane } from "./TerminalPane";
import { AgentsPane } from "./AgentsPane";
import { ContextPane } from "./ContextPane";
import { ArtifactsPane } from "./ArtifactsPane";
import { ActivityBar } from "./ActivityBar";
import { ImagesPane } from "./ImagesPane";
import { OdysseyPane } from "./OdysseyPane";
import { AttachmentThumb, BlockImage, InlineImage, workspaceImageRenderer } from "./InlineImage";
import { Markdown } from "../markdown";
import type { Card } from "../projection";
import { assignImages, keyOf, type ImageRef } from "../transcriptImages";
import { detectTestRun, editedFilesIn } from "../toolSummary";
import { CodeChangesCard, EditedFilesList, TestsCard } from "./ChangeCards";
import { IconAgents, IconArrowUp, IconAt, IconBox, IconBranch, IconCheck, IconChevron, IconDots, IconFolder, IconImage, IconPaperclip, IconSquare, IconTerminal } from "./icons";

const EMPTY_LIST: never[] = [];

function copyText(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

function Blocks({ blocks, markdown, onLink, workspaceId }: { blocks: ContentBlock[]; markdown: boolean; onLink: (url: string) => void; workspaceId: string }) {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case "text":
            return markdown ? (
              <Markdown key={index} onCopyCode={copyText} onImage={workspaceImageRenderer(workspaceId)} onLink={onLink} source={block.text} />
            ) : (
              <pre className="text" key={index}>
                {block.text}
              </pre>
            );
          case "image":
            return <BlockImage data={block.data} key={index} mimeType={block.mimeType} uri={block.uri} workspaceId={workspaceId} />;
          case "audio":
            return (
              <span className="chip" key={index}>
                audio {block.mimeType ?? ""}
              </span>
            );
          case "resource_link":
            return (
              <span className="chip mono" key={index} title="path reference: the agent reads this file itself">
                {block.name ?? block.uri}
              </span>
            );
          case "resource":
            return (
              <pre className="text" key={index}>
                {block.text ?? `[resource ${block.uri ?? ""}]`}
              </pre>
            );
          default:
            return (
              <details className="unknown" key={index}>
                <summary>unknown content block {block.originalType}</summary>
                <pre className="text">{JSON.stringify(block.raw, null, 2)}</pre>
              </details>
            );
        }
      })}
    </>
  );
}

function ToolCard({ patch, detached, sessionId, workspaceId }: { patch: ToolPatch; detached: string | undefined; sessionId: string; workspaceId: string }) {
  // Both are read from what the tool returned, so they appear only when the
  // call actually produced that shape.
  const testRun = useMemo(() => detectTestRun(patch.rawInput, patch.rawOutput), [patch.rawInput, patch.rawOutput]);
  const edited = useMemo(() => editedFilesIn(patch.rawOutput).slice(0, 12), [patch.rawOutput]);
  // No agent times its tool calls on the wire; nothing is guessed.
  const millis = null;
  const running = patch.status === "in_progress" || patch.status === "pending";
  const id = patch.toolCallId;
  return (
    <details className="card card-tool">
      <summary>
        <span className="chip">{patch.toolKind ?? "tool"}</span> {patch.title ?? patch.name ?? patch.toolCallId}{" "}
        <span className="chip small">{patch.status ?? "no status"}</span>
        {detached && <span className="chip chip-warn small">detached: {detached.replace("_", " ")}</span>}
      </summary>
      {testRun && <TestsCard millis={millis} run={testRun} />}
      {edited.length > 0 && (
        <>
          <h4>Files this call reported writing</h4>
          <EditedFilesList files={edited} />
        </>
      )}
      {patch.rawInput !== null && patch.rawInput !== undefined && (
        <>
          <h4>Input</h4>
          <pre className="text">{JSON.stringify(patch.rawInput, null, 2)}</pre>
        </>
      )}
      {patch.rawOutput !== null && patch.rawOutput !== undefined && (
        <>
          <h4>Output</h4>
          <pre className="text">{JSON.stringify(patch.rawOutput, null, 2)}</pre>
        </>
      )}
      {patch.content !== null && patch.content !== undefined && (
        <>
          <h4>Content</h4>
          <pre className="text">{JSON.stringify(patch.content, null, 2)}</pre>
        </>
      )}
      <p className="small muted">
        supplied fields: {patch.present.join(", ") || "none"}
        {patch.cleared.length > 0 ? `; cleared: ${patch.cleared.join(", ")}` : ""}
      </p>
    </details>
  );
}

function messageText(card: Extract<Card, { kind: "message" }>): string {
  return card.message.blocks.map((b) => (b.type === "text" ? b.text : b.type === "resource_link" ? (b.name ?? b.uri) : `[${b.type}]`)).join("\n");
}

/** Images a card brought into the transcript, shown under it. */
function CardImages({ images, workspaceId }: { images: ImageRef[]; workspaceId: string }) {
  return (
    <div className="inline-images card-images">
      {images.map((ref) =>
        ref.kind === "workspace" ? (
          <InlineImage key={keyOf(ref)} relative={ref.relative} workspaceId={workspaceId} />
        ) : (
          <InlineImage generated={ref.path} key={keyOf(ref)} relative={ref.path.split("/").pop() ?? ref.path} workspaceId={workspaceId} />
        ),
      )}
    </div>
  );
}

type CardViewProps = { card: Card; sessionId: string; images?: ImageRef[] | undefined };

function sameImages(a: ImageRef[] | undefined, b: ImageRef[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((ref, index) => keyOf(ref) === keyOf(b[index] as ImageRef));
}

/**
 * One transcript entry. Rendered again only when its own card (or its tool
 * call, or its images) changed: a streaming turn updates the session many
 * times a second, and redrawing — re-parsing the Markdown of — every visible
 * message on each update is what made a long session heavy to open.
 */
const CardView = memo(
  function CardView({ card, sessionId, images }: CardViewProps) {
    const workspaceId = useStore((s) => s.sessions[sessionId]?.workspaceId ?? "");
    const view = <CardBody card={card} sessionId={sessionId} />;
    if (!images || images.length === 0) return view;
    return (
      <>
        {view}
        <CardImages images={images} workspaceId={workspaceId} />
      </>
    );
  },
  (before, after) => before.card === after.card && before.sessionId === after.sessionId && sameImages(before.images, after.images),
);

function CardBody({ card, sessionId }: { card: Card; sessionId: string }) {
  // Narrow selections, so an update elsewhere in the session does not
  // redraw this card.
  const provider = useStore((s) => s.sessions[sessionId]?.snapshot.provider);
  const workspaceId = useStore((s) => s.sessions[sessionId]?.workspaceId ?? "");
  const patch = useStore((s) => (card.kind === "tool" ? s.sessions[sessionId]?.projection.toolCalls.get(card.toolCallId) : undefined));
  const detached = useStore((s) => (card.kind === "tool" ? s.sessions[sessionId]?.projection.detached.get(card.toolCallId) : undefined));
  const openUrl = useStore((s) => s.openUrl);
  const onLink = (url: string) => void openUrl(url);
  switch (card.kind) {
    case "message":
      return (
        <article className={`card card-${card.message.role}`}>
          <header className="small muted" title={card.message.messageId}>
            {card.message.role === "user" ? "You" : card.message.role === "thought" ? "Reasoning" : provider ? PROVIDER_LABELS[provider] : "Agent"}
            {card.message.contentUnknown && <span className="chip chip-warn small">content not supplied</span>}
            <span className="card-actions">
              <button className="link small" onClick={() => copyText(messageText(card))} type="button">
                copy
              </button>
            </span>
          </header>
          <Blocks blocks={card.message.blocks} markdown={card.message.role !== "user"} onLink={onLink} workspaceId={workspaceId} />
        </article>
      );
    case "tool": {
      if (!patch) return null;
      return <ToolCard detached={detached} patch={patch} sessionId={sessionId} workspaceId={workspaceId} />;
    }
    case "notice":
      return (
        <div className={`card card-notice notice-${card.severity ?? "info"}`}>
          <strong>{card.title}</strong> {card.description}
        </div>
      );
    case "plan":
      return <div className="card card-plan">Plan: {card.summary}</div>;
    case "permission":
      // Answered by the workspace's trust: an allowed request is routine
      // and not worth a line; a refused one is shown, since it changed what
      // the agent could do.
      if (card.decision === "allowed") return null;
      return (
        <div className="card card-notice notice-warning">
          The agent asked for permission ({card.title ?? card.requestId}) and it was <strong>refused</strong>.
        </div>
      );
    case "unknown":
      return (
        <details className="card card-unknown">
          <summary>
            Unknown {card.label} {card.truncated && <span className="chip small">payload truncated</span>}
          </summary>
          <pre className="text">{JSON.stringify(card.raw, null, 2)}</pre>
        </details>
      );
    case "runtime":
      return <div className="line line-runtime">{card.text}</div>;
    case "diagnostic":
      return <div className="line line-diagnostic">{card.text}</div>;
    case "turn":
      return <div className="line line-turn">{card.text}</div>;
    case "compaction":
      return <div className="line line-turn">{card.text}</div>;
    default:
      return null;
  }
}

function cardText(card: Card, tools: Map<string, ToolPatch>): string {
  switch (card.kind) {
    case "message":
      return messageText(card);
    case "tool": {
      const patch = tools.get(card.toolCallId);
      return `${patch?.title ?? ""} ${patch?.name ?? ""} ${JSON.stringify(patch?.rawInput ?? "")}`;
    }
    case "notice":
      return `${card.title} ${card.description ?? ""}`;
    case "plan":
      return card.summary;
    case "unknown":
      return card.label;
    case "permission":
      return card.title ?? card.requestId;
    default:
      return card.text;
  }
}

type CardGroup = { kind: "single"; card: Card } | { kind: "runtime"; key: string; cards: Card[] };

/** Consecutive runtime/stderr lines collapse into one expandable group. */
function groupCards(cards: Card[]): CardGroup[] {
  const out: CardGroup[] = [];
  for (const card of cards) {
    const noisy = card.kind === "runtime" || card.kind === "diagnostic";
    const last = out.at(-1);
    if (noisy && last && last.kind === "runtime") last.cards.push(card);
    else if (noisy) out.push({ kind: "runtime", key: `group|${card.key}`, cards: [card] });
    else out.push({ kind: "single", card });
  }
  return out.map((group) => (group.kind === "runtime" && group.cards.length === 1 ? { kind: "single", card: group.cards[0] as Card } : group));
}

function bytesLabel(n: number): string {
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The views kept behind one menu so the bar stays quiet. */
export const GROUPED_VIEWS: { id: SessionTab; label: string; icon: (props: { size?: number }) => ReactElement; hint: string }[] = [
  { id: "files", label: "Files", icon: IconFolder, hint: "Browse the workspace" },
  { id: "changes", label: "Changes", icon: IconBranch, hint: "Review the diff and commit" },
  { id: "context", label: "Context", icon: IconAt, hint: "What the agent can see" },
  { id: "artifacts", label: "Artifacts", icon: IconBox, hint: "Files the run produced" },
  { id: "images", label: "Images", icon: IconImage, hint: "Generated images" },
];

/**
 * One trigger for the views you go and look at.
 *
 * A row of eight tabs made the two you actually watch — the transcript and
 * the goal — hard to find. These six are things you open deliberately, so
 * they share a trigger that names whichever one is open, and carries the
 * badge of a grouped view that has something live in it while it is closed.
 */
export function ViewsMenu({ tab, onPick, badges }: { tab: SessionTab; onPick: (tab: SessionTab) => void; badges?: Partial<Record<SessionTab, string>> }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const current = GROUPED_VIEWS.find((view) => view.id === tab);
  // A count worth glancing at is useless inside a closed menu, so the trigger
  // carries it while that view is not the one on screen.
  const hidden = GROUPED_VIEWS.filter((view) => view.id !== tab && badges?.[view.id])
    .map((view) => badges?.[view.id])
    .filter(Boolean);

  useEffect(() => {
    if (!at) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onDown = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setAt(null);
    };
    // The DOM event, not React's: this listener is on `document`.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setAt(null);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [at]);

  const open = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setAt({ x: rect.right - 208, y: rect.bottom + 4 });
  };

  return (
    <>
      <button
        aria-expanded={at !== null}
        aria-haspopup="menu"
        className={`tab tab-menu ${current ? "tab-on" : ""}`}
        onClick={() => (at ? setAt(null) : open())}
        ref={trigger}
        type="button"
      >
        {current ? <current.icon size={13} /> : <IconDots size={13} />}
        {current?.label ?? "Views"}
        {hidden.length > 0 && <span className="tab-badge">{hidden.join(" ")}</span>}
        {/* Rotated by CSS from the button's expanded state: down when closed, up when open. */}
        <IconChevron size={13} />
      </button>
      {at && (
        <div className="context-menu" ref={menu} role="menu" style={{ left: Math.max(8, at.x), top: at.y }}>
          {GROUPED_VIEWS.map((view) => (
            <button
              className="context-item context-item-row"
              key={view.id}
              onClick={() => {
                onPick(view.id);
                setAt(null);
              }}
              role="menuitemradio"
              aria-checked={tab === view.id}
              title={view.hint}
              type="button"
            >
              <view.icon size={14} />
              <span className="context-item-label">{view.label}</span>
              {badges?.[view.id] && <span className="tab-badge">{badges[view.id]}</span>}
              {tab === view.id && <IconCheck size={13} />}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function SessionPanel({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const draft = useStore((s) => s.drafts[sessionId] ?? "");
  const setDraft = useStore((s) => s.setDraft);
  const send = useStore((s) => s.send);
  const steer = useStore((s) => s.steer);
  const cancel = useStore((s) => s.cancel);
  const stop = useStore((s) => s.stop);
  const refreshSnapshot = useStore((s) => s.refreshSnapshot);
  const focusToken = useStore((s) => s.focusComposerToken);
  const inspection = useStore((s) => (session ? s.inspections[session.workspaceId] : undefined));
  const tab = useStore((s) => s.sessionTab);
  const setTab = useStore((s) => s.setSessionTab);
  const searchOpen = useStore((s) => s.transcriptSearchOpen);
  const setSearchOpen = useStore((s) => s.setTranscriptSearchOpen);
  const uiPrefs = useStore((s) => s.uiPrefs);
  const attachments = useStore((s) => s.attachments[sessionId] ?? EMPTY_LIST);
  const mentions = useStore((s) => s.mentions[sessionId] ?? EMPTY_LIST);
  const addAttachments = useStore((s) => s.addAttachments);
  const removeAttachment = useStore((s) => s.removeAttachment);
  const addMention = useStore((s) => s.addMention);
  const updateMention = useStore((s) => s.updateMention);
  const removeMention = useStore((s) => s.removeMention);
  const setError = useStore((s) => s.setError);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(uiPrefs.transcriptPage);
  const [dropping, setDropping] = useState(false);
  const [mention, setMention] = useState<{ token: string; matches: string[]; index: number; truncated: boolean; copy: boolean } | null>(null);

  useEffect(() => {
    const element = transcriptRef.current;
    if (element && !query) element.scrollTop = element.scrollHeight;
  }, [session?.projection.eventCount, query, tab]);

  // Images appearing under output/imagegen while a turn runs show up inline as
  // observed files (the agent or a background subagent may have produced them).
  const observedImages = useStore((s) => s.observedImages[sessionId] ?? EMPTY_LIST);
  const noteImageFiles = useStore((s) => s.noteImageFiles);
  const activeForPoll = !!session && (session.projection.foreground === "running" || session.projection.foreground === "cancelling");
  const settledMarker = session?.projection.settledTurns ?? 0;
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let first = !(sessionId in useStore.getState().seenImageFiles);
    const poll = async () => {
      try {
        const entries = await api.workspaceListDir(session.workspaceId, "output/imagegen", false);
        if (cancelled) return;
        const files = entries.filter((e) => e.kind === "file" && /\.(png|jpe?g|webp|gif)$/i.test(e.name)).map((e) => `output/imagegen/${e.name}`);
        noteImageFiles(sessionId, files, first);
        first = false;
      } catch {
        // No output directory yet.
      }
    };
    void poll();
    if (!activeForPoll) return () => {
      cancelled = true;
    };
    const timer = setInterval(() => void poll(), 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, session?.workspaceId, activeForPoll, settledMarker, noteImageFiles]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    composerRef.current?.focus();
  }, [focusToken, sessionId]);

  useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => searchRef.current?.focus());
  }, [searchOpen]);

  // OS drag-and-drop of files onto the window (UX-05): paths are validated,
  // sniffed and snapshotted natively before they become attachments.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let webview: ReturnType<typeof getCurrentWebview>;
    try {
      webview = getCurrentWebview();
    } catch {
      // Not running inside Tauri (tests); drag-and-drop is unavailable.
      return;
    }
    webview
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") setDropping(true);
        else if (event.payload.type === "leave") setDropping(false);
        else if (event.payload.type === "drop") {
          setDropping(false);
          const state = useStore.getState();
          if (state.view.kind !== "session") return;
          // A drop listener is webview-wide, so the tab that owns the drop
          // gets it: the Odyssey tab reads a dropped Markdown plan, and a
          // file dropped there must not also become an attachment.
          if (state.sessionTab === "odyssey") return;
          api
            .attachmentAddPaths(event.payload.paths)
            .then((snapshots) => addAttachments(sessionId, snapshots))
            .catch(setError);
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [sessionId, addAttachments, setError]);

  // Grow the composer with its content: two lines when empty, up to twice
  // that, then it scrolls. The bounds live in CSS (min-height/max-height); this
  // only measures the text, so the two cannot drift apart.
  useEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [draft, sessionId]);

  // Mention autocomplete: `@token` before the caret searches the workspace.
  useEffect(() => {
    if (!session) return;
    const element = composerRef.current;
    const caret = element?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (!match) {
      setMention(null);
      return;
    }
    const token = match[1] ?? "";
    const timer = setTimeout(() => {
      api
        .workspaceSearchFiles(session.workspaceId, token, 12)
        .then((result) => setMention((current) => ({ token, matches: result.matches, index: 0, truncated: result.truncated, copy: current?.copy ?? false })))
        .catch(() => setMention(null));
    }, 120);
    return () => clearTimeout(timer);
  }, [draft, session?.workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickMention = useCallback(
    (path: string) => {
      if (!mention) return;
      const element = composerRef.current;
      const caret = element?.selectionStart ?? draft.length;
      const before = draft.slice(0, caret).replace(/@[^\s@]*$/, "");
      setDraft(sessionId, `${before}${draft.slice(caret)}`);
      const m: Mention = { relativePath: path, mode: mention.copy ? { mode: "copied_content" } : { mode: "path_reference" } };
      addMention(sessionId, m);
      setMention(null);
      requestAnimationFrame(() => element?.focus());
    },
    [mention, draft, sessionId, setDraft, addMention],
  );

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    for (const file of files) {
      file
        .arrayBuffer()
        .then((buffer) => api.attachmentAddBytes(file.name || "pasted-image", toBase64(buffer)))
        .then((snapshot) => addAttachments(sessionId, [snapshot]))
        .catch(setError);
    }
  };

  const filteredCards = useMemo(() => {
    if (!session) return [];
    const cards = session.projection.cards;
    if (!query.trim()) return cards;
    const q = query.toLowerCase();
    return cards.filter((card) => cardText(card, session.projection.toolCalls).toLowerCase().includes(q));
  }, [session, query]);
  // Images the agents made or looked at, each under the card where it first
  // appears. Recomputed when the stream moves, not on every render.
  const workspaceRoot = useStore((s) => s.workspaces.find((w) => w.id === s.sessions[sessionId]?.workspaceId)?.canonicalRoot ?? "");
  const lastSequence = session?.projection.lastSequence;
  const sessionJobs = useStore((s) => s.jobs[sessionId] ?? EMPTY_LIST);
  const cardImages = useMemo(
    () => (session ? assignImages(session.projection.cards, session.projection.toolCalls, workspaceRoot) : new Map<string, ImageRef[]>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lastSequence, session?.projection.cards.length, workspaceRoot],
  );

  if (!session) {
    return (
      <section className="panel session-panel">
        <h2>Session</h2>
        <p className="muted">This session is no longer attached.</p>
      </section>
    );
  }

  const { projection, handle, inFlightRequestId, steerInFlight } = session;
  const title = sessionTitle(session, useStore.getState().records[session.workspaceId]);
  const configOptions = projection.configOptions ?? session.snapshot.configOptions;
  const busy = useStore.getState().busy;
  const active = projection.foreground === "running" || projection.foreground === "awaiting_user" || projection.foreground === "cancelling";
  const canSteer = active && !!projection.capabilities?.supportsSteering;
  const hasInput = !!draft.trim() || attachments.length > 0 || mentions.length > 0;
  const canSend = !inFlightRequestId && projection.attachment === "attached" && projection.process !== "exited";
  const lastSubmission = [...projection.submissions.entries()].at(-1);
  const mediaOk = { image: projection.capabilities?.promptImage ?? false, audio: projection.capabilities?.promptAudio ?? false };
  const windowStart = Math.max(0, filteredCards.length - visible);
  const shownCards = filteredCards.slice(windowStart);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && mention.matches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMention({ ...mention, index: Math.min(mention.matches.length - 1, mention.index + 1) });
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMention({ ...mention, index: Math.max(0, mention.index - 1) });
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        pickMention(mention.matches[mention.index] ?? mention.matches[0] ?? "");
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      const sends = uiPrefs.enterSends ? !event.shiftKey : event.shiftKey;
      if (!sends) return;
      event.preventDefault();
      if (canSteer) void steer(sessionId);
      else if (canSend && hasInput) void send(sessionId);
    }
  };

  // A goal's headline number belongs on the tab: it is the thing you check
  // without opening it.
  const odysseyView = useStore.getState().odyssey[sessionId];
  const odysseyLabel = odysseyView
    ? `Odyssey ${odysseyView.milestones.filter((m) => m.state === "verified").length}/${odysseyView.milestones.length}`
    : "Odyssey";
  // Only the views you watch stay in the bar; the rest live behind one menu
  // and the terminal behind one icon, so the bar reads at a glance.
  // Agents is a main tab again, second: delegated jobs and subagents are
  // things you watch while a turn runs, not something you go and look for.
  // Its label carries what is busy in it.
  const working = [...projection.inspector.agents.values()].filter((agent) => agent.status === "working" || agent.status === "starting").length;
  const jobsBusy = sessionJobs.filter((job) => job.status === "starting" || job.status === "running").length;
  const jobsWaiting = sessionJobs.filter((job) => job.status === "waiting").length;
  const agentsBusy = working + jobsBusy;
  const agentsLabel = `Agents${agentsBusy > 0 ? ` · ${agentsBusy}` : ""}${jobsWaiting > 0 ? ` · ${jobsWaiting} waiting` : ""}`;
  const tabs: { id: typeof tab; label: string }[] = [
    { id: "transcript", label: "Transcript" },
    { id: "agents", label: agentsLabel },
    { id: "odyssey", label: odysseyLabel },
  ];

  return (
    <section className={`panel session-panel ${dropping ? "drop-target" : ""}`}>
      <header className="session-header">
        <h2
          title={[
            handle.id,
            `process ${projection.process} · attachment ${projection.attachment} · turn ${projection.foreground}`,
            projection.capabilities
              ? `${projection.capabilities.agentName} ${projection.capabilities.agentVersion} · ACP v${projection.capabilities.protocolVersion}${projection.capabilities.supportsSteering ? " · steering" : " · no steering"}`
              : null,
            projection.usage ? `context ${projection.usage.used ?? "?"}/${projection.usage.size ?? "?"}` : null,
            `events ${projection.eventCount} · seq ${projection.lastSequence}`,
          ]
            .filter(Boolean)
            .join("\n")}
        >
          {title} <span className="mono small muted">{handle.id}</span>
        </h2>
        {/* Nominal state is not worth a row of chips; only the states you would
            want to act on are shown, and the details stay on hover. */}
        {(projection.process !== "ready" || projection.attachment !== "attached" || projection.exit || projection.autonomous.size > 0) && (
          <div className="row wrap">
            {projection.process !== "ready" && <span className="chip chip-warn">process: {projection.process}</span>}
            {projection.attachment !== "attached" && <span className="chip chip-warn">attachment: {projection.attachment}</span>}
            {projection.autonomous.size > 0 && <span className="chip chip-active">autonomous turns: {projection.autonomous.size}</span>}
            {projection.exit && (
              <span className="chip chip-warn">
                exited status {projection.exit.status ?? "?"}
                {projection.exit.forced ? " (forced)" : ""}
              </span>
            )}
          </div>
        )}
        {projection.snapshotNeeded && (
          <div className="banner banner-busy">
            The event stream lagged; deltas were skipped.{" "}
            <button className="link" onClick={() => void refreshSnapshot(sessionId)} type="button">
              refresh from snapshot and history
            </button>
          </div>
        )}
      </header>

      <div className="tabs">
        {/* Only the real tabs are in the tablist; the trailing controls are a
            toggle and a menu, and claiming otherwise would mislead a reader
            using a screen reader. */}
        <div className="tablist" role="tablist">
          {tabs.map((t) => (
            <button
              aria-selected={tab === t.id}
              className={`tab ${tab === t.id ? "tab-on" : ""} ${t.id === "transcript" && active ? "tab-running" : ""}`}
              key={t.id}
              onClick={() => setTab(t.id)}
              role="tab"
              type="button"
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="tabs-spacer" />
        <button
          aria-label="Terminal"
          aria-pressed={tab === "terminal"}
          className={`icon-button icon-button-xs tab-icon ${tab === "terminal" ? "on" : ""}`}
          onClick={() => setTab("terminal")}
          title="Terminal"
          type="button"
        >
          <IconTerminal size={15} />
        </button>
        <ViewsMenu onPick={setTab} tab={tab} />
      </div>
      {active && <div aria-hidden="true" className="progress-line" />}
      {tab === "transcript" && (
        <>
          {/* Only rendered when it has something to carry, so the transcript
              keeps the height in the common case. Search opens with ⌘F and
              export lives in the top bar. */}
          {(searchOpen || windowStart > 0) && (
            <div className="transcript-tools">
              {searchOpen && (
                <>
                  <input
                    aria-label="Search transcript"
                    className="input"
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setQuery("");
                        setSearchOpen(false);
                        composerRef.current?.focus();
                      }
                    }}
                    placeholder="Search transcript (Esc to close)"
                    ref={searchRef}
                    value={query}
                  />
                  <span className="small muted">
                    {filteredCards.length} of {projection.cards.length} entries
                  </span>
                </>
              )}
              {windowStart > 0 && (
                <button className="link small" onClick={() => setVisible((v) => v + uiPrefs.transcriptPage)} type="button">
                  show {Math.min(uiPrefs.transcriptPage, windowStart)} earlier of {windowStart}
                </button>
              )}
            </div>
          )}
          <div aria-busy={active} className="transcript" ref={transcriptRef}>
            {groupCards(shownCards).map((group) =>
              group.kind === "single" ? (
                <CardView card={group.card} images={cardImages.get(group.card.key)} key={group.card.key} sessionId={sessionId} />
              ) : (
                <details className="runtime-group" key={group.key}>
                  <summary className="small muted">
                    runtime · {group.cards.length} events · latest: {(group.cards.at(-1) as { text: string }).text.slice(0, 120)}
                  </summary>
                  {group.cards.map((card) => (
                    <CardView card={card} key={card.key} sessionId={sessionId} />
                  ))}
                </details>
              ),
            )}
            {/* What this session has changed on disk, at the end of the
                reading order so it is the last thing before the composer. */}
            {projection.cards.length > 0 && <CodeChangesCard refreshKey={projection.cards.length} sessionId={sessionId} workspaceId={session.workspaceId} />}
            {observedImages.length > 0 && (
              // Most of these already appear inline where the agent produced
              // them, so this catch-all stays folded: it is a backstop for
              // files that never made it into the transcript, not a gallery.
              <details className="card observed-images">
                <summary className="small muted">
                  {observedImages.length} image{observedImages.length === 1 ? "" : "s"} appeared in output/imagegen during this session (observed files)
                  <span className="link small observed-images-open" onClick={(event) => event.stopPropagation()} role="none">
                    <button className="link small" onClick={() => setTab("images")} type="button">
                      open Images tab
                    </button>
                  </span>
                </summary>
                <div className="inline-images">
                  {observedImages.map((relative) => (
                    <InlineImage key={relative} relative={relative} workspaceId={session.workspaceId} />
                  ))}
                </div>
              </details>
            )}
            {projection.cards.length === 0 && <p className="muted">Attached. Send a prompt to begin.</p>}
            {query && filteredCards.length === 0 && <p className="muted">No entries match.</p>}
          </div>
        </>
      )}
      {tab === "files" && <FilesPane workspaceId={session.workspaceId} />}
      {tab === "changes" && <ChangesPane isGit={inspection?.isGitRepository ?? false} sessionId={sessionId} workspaceId={session.workspaceId} />}
      {tab === "terminal" && <TerminalPane workspaceId={session.workspaceId} />}
      {tab === "agents" && <AgentsPane sessionId={sessionId} />}
      {tab === "context" && <ContextPane sessionId={sessionId} />}
      {tab === "artifacts" && <ArtifactsPane agentSessionId={session.snapshot.agentSessionId} workspaceId={session.workspaceId} />}
      {tab === "images" && <ImagesPane sessionId={sessionId} />}
      {tab === "odyssey" && <OdysseyPane sessionId={sessionId} />}

      <footer className="composer">
        {/* Between the transcript and the prompt, so anything still running
            stays visible however far the transcript has scrolled. */}
        <ActivityBar onOpenAgents={() => setTab("agents")} sessionId={sessionId} />
        {/* The Odyssey view has no use for a prompt box: the run submits its
            own turns. The activity strip above stays, because background work
            outliving a turn is exactly what it is for. */}
        {tab !== "odyssey" && (
        <>
        <div className="composer-card">
        {(attachments.length > 0 || mentions.length > 0) && (
          <div className="attachment-strip">
            {mentions.map((m, index) => (
              <span
                className="attachment-chip"
                key={`${m.relativePath}-${index}`}
                title={m.mode.mode === "path_reference" ? "The agent receives an environment-local path and reads the file itself." : "The file content is copied into the prompt with its path and hash."}
              >
                <span className="mono small">@{m.relativePath}</span>
                <button
                  className="link small"
                  onClick={() => updateMention(sessionId, index, { ...m, mode: m.mode.mode === "path_reference" ? { mode: "copied_content" } : { mode: "path_reference" } })}
                  type="button"
                >
                  {m.mode.mode === "path_reference" ? "as path" : `copied${m.mode.startLine ? ` ${m.mode.startLine}-${m.mode.endLine ?? ""}` : ""}`}
                </button>
                <button aria-label={`remove mention ${m.relativePath}`} className="link small" onClick={() => removeMention(sessionId, index)} type="button">
                  ×
                </button>
              </span>
            ))}
            {attachments.map((a) => (
              <span className="attachment-chip" key={a.id} title={`${a.mime} · ${a.bytes} bytes · blake3 ${a.id.slice(0, 12)}`}>
                {a.kind === "image" && <AttachmentThumb id={a.id} name={a.name} />}
                <span className="small">
                  {a.name}
                  <span className="muted">
                    {" "}
                    · {bytesLabel(a.bytes)}
                    {a.kind === "image" && a.width && a.height ? ` · ${a.width}×${a.height}` : ""}
                  </span>
                </span>
                {!mediaOk[a.kind] && <span className="chip small chip-warn">runtime did not advertise {a.kind} prompts</span>}
                <button aria-label={`remove attachment ${a.name}`} className="link small" onClick={() => removeAttachment(sessionId, a.id)} type="button">
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-wrap">
          {mention && (
            <div aria-label="Mention a file" className="mention-popover" role="listbox">
              <div className="row wrap small" style={{ padding: "4px 8px" }}>
                <span className="muted">Mention @{mention.token}</span>
                <label className="check small">
                  <input checked={mention.copy} onChange={(e) => setMention({ ...mention, copy: e.target.checked })} type="checkbox" /> copy content into the prompt (default: path reference)
                </label>
                {mention.truncated && <span className="muted">more matches; keep typing</span>}
              </div>
              <ul className="mention-list">
                {mention.matches.length === 0 && <li className="mention-item muted small">No files match.</li>}
                {mention.matches.map((path, i) => (
                  <li
                    aria-selected={i === mention.index}
                    className={`mention-item mono small ${i === mention.index ? "mention-item-on" : ""}`}
                    key={path}
                    onClick={() => pickMention(path)}
                    onMouseEnter={() => setMention({ ...mention, index: i })}
                    role="option"
                  >
                    {path}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <textarea
            aria-label="Prompt"
            className="textarea"
            onChange={(event) => setDraft(sessionId, event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={
              canSteer
                ? `Steer the current turn (${uiPrefs.enterSends ? "Enter" : "Shift+Enter"} to steer). Type @ to mention a file.`
                : `Prompt (${uiPrefs.enterSends ? "Enter to send, Shift+Enter for newline" : "Shift+Enter to send, Enter for newline"}). Type @ to mention a file; drop or paste images to attach.`
            }
            ref={composerRef}
            rows={2}
            value={draft}
          />
        </div>
        <div className="composer-row">
          <button
            aria-label="Attach media"
            className="icon-button"
            disabled={!canSend}
            onClick={() =>
              api
                .attachmentPick()
                .then((snapshots) => addAttachments(sessionId, snapshots))
                .catch(setError)
            }
            title="Attach PNG, JPEG, GIF, WebP, WAV or MP3 (8 files, 10 MiB each, 20 MiB total). Type @ to mention a file."
            type="button"
          >
            <IconPaperclip />
          </button>
          <ConfigPickers configOptions={configOptions} disabled={projection.process === "exited" || busy !== null} sessionId={sessionId} />
          {!configOptions && <span className="chip small">the account's default model</span>}
          <TeamChip disabled={projection.process === "exited"} sessionId={sessionId} />
          <span className="composer-spacer" />
          {active && !projection.capabilities?.supportsSteering && <span className="small muted">steering not advertised</span>}
          {active && (
            <button aria-label="Cancel turn" className="icon-button" onClick={() => void cancel(sessionId)} title="Cancel the current turn" type="button">
              <IconSquare />
            </button>
          )}
          {canSteer ? (
            <button className="send-button" disabled={steerInFlight || !draft.trim()} onClick={() => void steer(sessionId)} title="Steer the current turn" type="button">
              Steer <IconArrowUp size={14} />
            </button>
          ) : (
            <button aria-label="Send" className="send-button send-round" disabled={!canSend || !hasInput} onClick={() => void send(sessionId)} title="Send" type="button">
              <IconArrowUp size={16} />
            </button>
          )}
        </div>
        </div>
        <div className="row wrap composer-meta">
          <button className="link small" onClick={() => void stop(sessionId)} type="button">
            stop session
          </button>
          {lastSubmission && (
            <span className="small muted">
              last submission {String(lastSubmission[0]).slice(0, 8)}: {String(lastSubmission[1].state).replace("_", " ")}
              {lastSubmission[1].message ? ` (${lastSubmission[1].message})` : ""}
            </span>
          )}
          {[...projection.steers.entries()].slice(-1).map(([id, state]) => (
            <span className="small muted" key={id}>
              steer {id}: {state.replace("_", " ")}
            </span>
          ))}
        </div>
        </>
        )}
      </footer>
    </section>
  );
}
