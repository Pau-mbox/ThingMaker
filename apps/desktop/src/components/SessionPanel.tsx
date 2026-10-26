import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { ContentBlock, Mention, Provider, ToolPatch } from "@thingmaker/contracts";
import { PROVIDER_LABELS } from "@thingmaker/contracts";
import { t } from "../i18n";
import { useStore, isWorkerIn, sessionTitle, type SessionTab } from "../store";
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
import { ToolGroup } from "./ToolGroup";
import { ToolPayloads } from "./ToolPayloads";
import { IS_REMOTE } from "../remote/mode";
import { DocCard } from "./DocCard";
import { ApkCard, apksNamedIn } from "./ApkCard";
import { docsNamedIn, docsWrittenBy } from "../markdownDocs";
import { ImagesPane } from "./ImagesPane";
import { OdysseyPane } from "./OdysseyPane";
import { BigThingBand, BigThingTurnCard } from "./BigThingLinks";
import { bigThingTurnOf, userMessageText } from "../bigThingTurns";
import { AttachmentThumb, BlockImage, InlineImage, workspaceImageRenderer } from "./InlineImage";
import { Markdown } from "../markdown";
import type { Card } from "../projection";
import { assignImages, keyOf, type ImageRef } from "../transcriptImages";
import { detectTestRun, editedFilesIn, shellResultsOf } from "../toolSummary";
import { CodeChangesCard, EditedFilesList, TestsCard } from "./ChangeCards";
import { PlanBar, PlanCard, planText } from "./PlanChecklist";
import { QueueStrip } from "./QueueStrip";
import { ProviderMark } from "./ProviderMark";
import { IconAgents, IconArrowUp, IconAt, IconBox, IconBranch, IconCheck, IconChevron, IconDots, IconFolder, IconImage, IconPaperclip, IconSquare, IconTerminal } from "./icons";
import { withoutHandoff } from "../team";

const EMPTY_LIST: never[] = [];

/** A sentence with one piece of markup in it, at `{name}`. */
function around(text: string, name: string, node: ReactNode) {
  const [before, after] = text.split(`{${name}}`);
  return (
    <>
      {before}
      {node}
      {after}
    </>
  );
}

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
                {t("audio {mime}", { mime: block.mimeType ?? "" })}
              </span>
            );
          case "resource_link":
            return (
              <span className="chip mono" key={index} title={t("path reference: the agent reads this file itself")}>
                {block.name ?? block.uri}
              </span>
            );
          case "resource":
            return (
              <pre className="text" key={index}>
                {block.text ?? t("[resource {uri}]", { uri: block.uri ?? "" })}
              </pre>
            );
          default:
            return (
              <details className="unknown" key={index}>
                <summary>{t("unknown content block {type}", { type: block.originalType })}</summary>
                <pre className="text">{JSON.stringify(block.raw, null, 2)}</pre>
              </details>
            );
        }
      })}
    </>
  );
}

/** A tool call's raw detail: what went in, what came out, what it wrote. */
function ToolDetail({ patch, provider, workspaceId }: { patch: ToolPatch; provider: Provider | undefined; workspaceId: string }) {
  // Both are read from what the tool returned, so they appear only when the
  // call actually produced that shape.
  const testRun = useMemo(() => detectTestRun(patch.rawInput, patch.rawOutput, shellResultsOf(patch, provider)), [patch, provider]);
  const edited = useMemo(() => editedFilesIn(patch.rawOutput).slice(0, 12), [patch.rawOutput]);
  // No agent times its tool calls on the wire; nothing is guessed.
  const millis = null;
  return (
    <>
      {testRun && <TestsCard millis={millis} run={testRun} />}
      {edited.length > 0 && (
        <>
          <h4>{t("Files this call reported writing")}</h4>
          <EditedFilesList files={edited} />
        </>
      )}
      <ToolPayloads patch={patch} workspaceId={workspaceId} />
      <p className="small muted">
        {patch.toolKind ?? t("tool")} · {patch.status ?? t("no status")} · {t("supplied fields: {fields}", { fields: patch.present.join(", ") || t("none") })}
        {patch.cleared.length > 0 ? `; ${t("cleared: {fields}", { fields: patch.cleared.join(", ") })}` : ""}
      </p>
    </>
  );
}

function ToolCard({ patch, detached, provider, workspaceId }: { patch: ToolPatch; detached: string | undefined; provider: Provider | undefined; workspaceId: string }) {
  return (
    <details className="card card-tool">
      <summary>
        <span className="chip">{patch.toolKind ?? t("tool")}</span> {patch.title ?? patch.name ?? patch.toolCallId}{" "}
        <span className="chip small">{patch.status ?? t("no status")}</span>
        {detached && <span className="chip chip-warn small">{t("detached: {state}", { state: detached.replace("_", " ") })}</span>}
      </summary>
      <ToolDetail patch={patch} provider={provider} workspaceId={workspaceId} />
    </details>
  );
}

/** A message's blocks as the person sees them: their own, without a hand-off brief in front. */
function shownBlocks(card: Extract<Card, { kind: "message" }>): ContentBlock[] {
  if (card.message.role !== "user") return card.message.blocks;
  return card.message.blocks.map((block) => (block.type === "text" ? { ...block, text: withoutHandoff(block.text) } : block));
}

function messageText(card: Extract<Card, { kind: "message" }>): string {
  return shownBlocks(card).map((b) => (b.type === "text" ? b.text : b.type === "resource_link" ? (b.name ?? b.uri) : `[${b.type}]`)).join("\n");
}

/**
 * Above a session that carries on another on a different provider: the
 * earlier conversation, read-only, then where it continued. After a restart
 * only a link to the earlier (archived) session is left.
 */
function EarlierConversation({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const continuation = useStore((s) => (session?.snapshot.agentSessionId ? s.continuations[session.snapshot.agentSessionId] : undefined));
  const earlier = useStore((s) => s.continuationHistory[sessionId]);
  const openSession = useStore((s) => s.openSession);
  const openUrl = useStore((s) => s.openUrl);
  if (!session || !continuation) return null;
  const from = continuation.fromProvider;
  const messages = (earlier ?? []).filter((card): card is Extract<Card, { kind: "message" }> => card.kind === "message" && card.message.role !== "thought");
  return (
    <>
      {messages.map((card) => (
        <article className={`card card-${card.message.role} card-earlier`} key={`earlier-${card.key}`}>
          <header className="small muted">{card.message.role === "user" ? t("You") : PROVIDER_LABELS[from]}</header>
          <Blocks blocks={shownBlocks(card)} markdown={card.message.role !== "user"} onLink={(url) => void openUrl(url)} workspaceId={session.workspaceId} />
        </article>
      ))}
      <div className="continued-divider small muted" role="separator">
        {earlier
          ? t("Continued with {provider}", { provider: PROVIDER_LABELS[session.snapshot.provider] })
          : t("Continues a {provider} session", { provider: PROVIDER_LABELS[from] })}
        {!earlier && (
          <button className="link small" onClick={() => void openSession(session.workspaceId, { mode: "resume", session_id: continuation.fromAgentSessionId }, from)} type="button">
            {t("open the earlier session")}
          </button>
        )}
      </div>
    </>
  );
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
  // The plan the running turn is revising: its current step turns.
  const livePlan = useStore((s) => {
    if (card.kind !== "plan") return false;
    const projection = s.sessions[sessionId]?.projection;
    return projection?.plan?.key === card.key && (projection.foreground === "running" || projection.foreground === "awaiting_user");
  });
  const onLink = (url: string) => void openUrl(url);
  switch (card.kind) {
    case "message":
      // An answer is marked by its provider's logo in the gutter rather than
      // a name line above it.
      if (card.message.role === "agent" && provider) {
        return (
          <article className="card card-agent card-agent-marked">
            <span className="card-author" title={`${PROVIDER_LABELS[provider]} · ${card.message.messageId}`}>
              <ProviderMark provider={provider} size={15} />
            </span>
            <div className="card-content">
              {card.message.contentUnknown && <span className="chip chip-warn small">{t("content not supplied")}</span>}
              <Blocks blocks={card.message.blocks} markdown onLink={onLink} workspaceId={workspaceId} />
            </div>
            <span className="card-actions card-actions-float">
              <button className="link small" onClick={() => copyText(messageText(card))} type="button">
                {t("copy")}
              </button>
            </span>
          </article>
        );
      }
      if (card.message.role === "user") {
        // Big Thing's own prompts are not the user's words.
        const text = userMessageText(card);
        const turn = bigThingTurnOf(card.message.messageId, text);
        if (turn) return <BigThingTurnCard card={card} sessionId={sessionId} text={text} turn={turn} />;
      }
      return (
        <article className={`card card-${card.message.role}`}>
          <header className="small muted" title={card.message.messageId}>
            {card.message.role === "user" ? t("You") : card.message.role === "thought" ? t("Reasoning") : provider ? PROVIDER_LABELS[provider] : t("Agent")}
            {card.message.contentUnknown && <span className="chip chip-warn small">{t("content not supplied")}</span>}
            <span className="card-actions">
              <button className="link small" onClick={() => copyText(messageText(card))} type="button">
                {t("copy")}
              </button>
            </span>
          </header>
          <Blocks blocks={shownBlocks(card)} markdown={card.message.role !== "user"} onLink={onLink} workspaceId={workspaceId} />
        </article>
      );
    case "tool": {
      if (!patch) return null;
      return <ToolCard detached={detached} patch={patch} provider={provider} workspaceId={workspaceId} />;
    }
    case "notice":
      return (
        <div className={`card card-notice notice-${card.severity ?? "info"}`}>
          <strong>{card.title}</strong> {card.description}
        </div>
      );
    case "plan":
      return <PlanCard live={livePlan} plan={card.plan} />;
    case "permission":
      // Answered by the workspace's trust: an allowed request is routine
      // and not worth a line; a refused one is shown, since it changed what
      // the agent could do.
      if (card.decision === "allowed") return null;
      return (
        <div className="card card-notice notice-warning">
          {around(t("The agent asked for permission ({title}) and it was {refused}.", { title: card.title ?? card.requestId }), "refused", <strong>{t("refused")}</strong>)}
        </div>
      );
    case "unknown":
      return (
        <details className="card card-unknown">
          <summary>
            {t("Unknown {label}", { label: card.label })} {card.truncated && <span className="chip small">{t("payload truncated")}</span>}
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
      return planText(card.plan);
    case "unknown":
      return card.label;
    case "permission":
      return card.title ?? card.requestId;
    default:
      return card.text;
  }
}

type CardGroup = { kind: "single"; card: Card } | { kind: "runtime"; key: string; cards: Card[] } | { kind: "work"; key: string; cards: Card[] };

/**
 * Consecutive runtime/stderr lines collapse into one expandable group, and a
 * run of tool calls between two messages into one work group. Runtime
 * lines and routine permission answers inside a run stay in it; a message,
 * a notice or a refusal ends it.
 */
export function groupCards(cards: Card[]): CardGroup[] {
  const out: CardGroup[] = [];
  for (const card of cards) {
    const noisy = card.kind === "runtime" || card.kind === "diagnostic";
    const quiet = card.kind === "permission" && card.decision === "allowed";
    const last = out.at(-1);
    if (card.kind === "tool") {
      if (last && last.kind === "work") last.cards.push(card);
      else if (last && last.kind === "runtime") out[out.length - 1] = { kind: "work", key: last.key, cards: [...last.cards, card] };
      else out.push({ kind: "work", key: `work|${card.key}`, cards: [card] });
    } else if ((noisy || quiet) && last && last.kind === "work") last.cards.push(card);
    else if (noisy && last && last.kind === "runtime") last.cards.push(card);
    else if (noisy) out.push({ kind: "runtime", key: `group|${card.key}`, cards: [card] });
    else out.push({ kind: "single", card });
  }
  return out.map((group) => (group.kind === "runtime" && group.cards.length === 1 ? { kind: "single", card: group.cards[0] as Card } : group));
}

type PlacedDoc = { path: string; version: string; verb: "wrote" | "named" };

/**
 * Where each Markdown document goes in the transcript: under the last run
 * that wrote it, so its card shows the file as it is now; or, when nothing
 * shown wrote it, under the last agent message that names it. Once each.
 */
export function placeDocs(groups: CardGroup[], tools: Map<string, ToolPatch>, roots: string[]): Map<number, PlacedDoc[]> {
  const written = new Map<string, { index: number; version: string }>();
  const named = new Map<string, number>();
  groups.forEach((group, index) => {
    if (group.kind === "work") {
      for (const card of group.cards) {
        if (card.kind !== "tool") continue;
        const patch = tools.get(card.toolCallId);
        if (!patch) continue;
        for (const path of docsWrittenBy(patch, roots)) {
          const before = written.get(path);
          written.set(path, { index, version: `${before?.index === index ? before.version : ""}${card.toolCallId}:${patch.status ?? ""};` });
        }
      }
    } else if (group.kind === "single" && group.card.kind === "message" && group.card.message.role === "agent") {
      for (const path of docsNamedIn(messageText(group.card), roots)) named.set(path, index);
    }
  });
  const placed = new Map<number, PlacedDoc[]>();
  const put = (index: number, doc: PlacedDoc) => placed.set(index, [...(placed.get(index) ?? []), doc]);
  for (const [path, at] of written) put(at.index, { path, version: at.version, verb: "wrote" });
  for (const [path, index] of named) if (!written.has(path)) put(index, { path, version: "", verb: "named" });
  return placed;
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
  // Getters, so the words are looked up in the interface's language when shown.
  {
    id: "files",
    get label() {
      return t("Files");
    },
    icon: IconFolder,
    get hint() {
      return t("Browse the workspace");
    },
  },
  {
    id: "changes",
    get label() {
      return t("Changes");
    },
    icon: IconBranch,
    get hint() {
      return t("Review the diff and commit");
    },
  },
  {
    id: "context",
    get label() {
      return t("Context");
    },
    icon: IconAt,
    get hint() {
      return t("What the agent can see");
    },
  },
  {
    id: "artifacts",
    get label() {
      return t("Artifacts");
    },
    icon: IconBox,
    get hint() {
      return t("Files the run produced");
    },
  },
  {
    id: "images",
    get label() {
      return t("Images");
    },
    icon: IconImage,
    get hint() {
      return t("Generated images");
    },
  },
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
        {current?.label ?? t("Views")}
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
  const enqueue = useStore((s) => s.enqueue);
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

  // The transcript follows new output only while it is scrolled to the
  // bottom: scrolling up to read stops it, scrolling back down resumes it.
  // It opens at the bottom and stays there while images and cards that load
  // after the first paint grow it.
  const followRef = useRef(true);
  const hasSession = !!session;
  useEffect(() => {
    const element = transcriptRef.current;
    if (!element || tab !== "transcript") return;
    followRef.current = !query;
    const pin = () => {
      if (followRef.current) element.scrollTop = element.scrollHeight;
    };
    // Only a move up is the reader leaving the bottom: output arriving after
    // the view's own jump down makes it look far from the bottom without
    // anyone having scrolled.
    let lastTop = element.scrollTop;
    const onScroll = () => {
      const top = element.scrollTop;
      if (top < lastTop - 2) followRef.current = false;
      if (!query && element.scrollHeight - top - element.clientHeight < 48) followRef.current = true;
      lastTop = top;
    };
    const resize = new ResizeObserver(pin);
    const watch = () => {
      resize.disconnect();
      resize.observe(element);
      for (const child of element.children) resize.observe(child);
    };
    const added = new MutationObserver(() => {
      watch();
      pin();
    });
    element.addEventListener("scroll", onScroll, { passive: true });
    added.observe(element, { childList: true });
    watch();
    pin();
    return () => {
      element.removeEventListener("scroll", onScroll);
      added.disconnect();
      resize.disconnect();
    };
  }, [hasSession, query, tab]);

  // Asked from the Big Thing board: show one card of the conversation. Clear
  // a search that would hide it and open enough of the history to hold it,
  // then stop following the bottom so the jump stays put.
  const transcriptFocus = useStore((s) => (s.transcriptFocus?.sessionId === sessionId ? s.transcriptFocus : null));
  const clearJumpFocus = useStore((s) => s.clearJumpFocus);
  useEffect(() => {
    if (!transcriptFocus || tab !== "transcript" || !session) return;
    if (query) {
      setQuery("");
      return;
    }
    const cards = session.projection.cards;
    const at = cards.findIndex((card) => card.key === transcriptFocus.cardKey);
    if (at < 0) {
      clearJumpFocus();
      return;
    }
    if (cards.length - at > visible) {
      setVisible(cards.length - at + 4);
      return;
    }
    followRef.current = false;
    clearJumpFocus();
    requestAnimationFrame(() => {
      const target = [...(transcriptRef.current?.querySelectorAll<HTMLElement>("[data-card-key]") ?? [])].find((element) => element.dataset.cardKey === transcriptFocus.cardKey);
      if (!target) return;
      target.scrollIntoView({ block: "start" });
      target.classList.add("jump-flash");
      setTimeout(() => target.classList.remove("jump-flash"), 1600);
    });
  }, [transcriptFocus, tab, session, query, visible, clearJumpFocus]);

  /** Sending a prompt goes back to the bottom to follow the reply. */
  const sendAndFollow = () => {
    followRef.current = true;
    const element = transcriptRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    void send(sessionId);
  };

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
    // On a phone, focusing the box raises the keyboard over what you came to read.
    if (!IS_REMOTE) composerRef.current?.focus();
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
          // gets it: the Big Thing tab reads a dropped Markdown plan, and a
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
  const workspaceDisplay = useStore((s) => s.workspaces.find((w) => w.id === s.sessions[sessionId]?.workspaceId)?.displayPath ?? "");
  const lastSequence = session?.projection.lastSequence;
  const sessionJobs = useStore((s) => s.jobs[sessionId] ?? EMPTY_LIST);
  // A worker does a task for its orchestrator; a Big Thing is led from the
  // orchestrator's session, so a worker has no Big Thing tab.
  const isWorker = useStore((s) => isWorkerIn(s, sessionId, s.sessions[sessionId]));
  const setSessionTab = useStore((s) => s.setSessionTab);
  useEffect(() => {
    if (isWorker && tab === "odyssey") setSessionTab("transcript");
  }, [isWorker, tab, setSessionTab]);
  const cardImages = useMemo(
    () => (session ? assignImages(session.projection.cards, session.projection.toolCalls, workspaceRoot) : new Map<string, ImageRef[]>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lastSequence, session?.projection.cards.length, workspaceRoot],
  );

  if (!session) {
    return (
      <section className="panel session-panel">
        <h2>{t("Session")}</h2>
        <p className="muted">{t("This session is no longer attached.")}</p>
      </section>
    );
  }

  const { projection, handle, inFlightRequestId, steerInFlight } = session;
  const title = sessionTitle(session, useStore.getState().records[session.workspaceId]);
  const configOptions = projection.configOptions ?? session.snapshot.configOptions;
  const busy = useStore.getState().busy;
  const active = projection.foreground === "running" || projection.foreground === "awaiting_user" || projection.foreground === "cancelling";
  const canSteer = active && !!projection.capabilities?.supportsSteering;
  const followUp = uiPrefs.followUp ?? "queue";
  const steerFirst = followUp === "steer" && canSteer;
  const sendKey = uiPrefs.enterSends ? "Enter" : "Shift+Enter";
  const hasInput = !!draft.trim() || attachments.length > 0 || mentions.length > 0;
  const canSend = !inFlightRequestId && projection.attachment === "attached" && projection.process !== "exited";
  const lastSubmission = [...projection.submissions.entries()].at(-1);
  const mediaOk = { image: projection.capabilities?.promptImage ?? false, audio: projection.capabilities?.promptAudio ?? false };
  const windowStart = Math.max(0, filteredCards.length - visible);
  const shownCards = filteredCards.slice(windowStart);
  const transcriptGroups = groupCards(shownCards);
  const docPlaces = placeDocs(transcriptGroups, projection.toolCalls, [workspaceRoot, workspaceDisplay].filter(Boolean));

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
      if (!active) {
        if (canSend && hasInput) sendAndFollow();
        return;
      }
      // While a turn runs the send key does the preferred follow-up, and
      // with ⌘ (Ctrl) held, the other one.
      const alternate = event.metaKey || event.ctrlKey;
      const wantsSteer = (followUp === "steer") !== alternate;
      if (wantsSteer && canSteer) void steer(sessionId);
      else if (canSend && hasInput) void enqueue(sessionId);
    }
  };

  // A goal's headline number belongs on the tab: it is the thing you check
  // without opening it.
  const odysseyView = useStore.getState().odyssey[sessionId];
  const odysseyLabel = odysseyView
    ? `${t("Big Thing board")} ${odysseyView.milestones.filter((m) => m.state === "verified").length}/${odysseyView.milestones.length}`
    : t("Big Thing board");
  // Only the views you watch stay in the bar; the rest live behind one menu
  // and the terminal behind one icon, so the bar reads at a glance.
  // Agents is a main tab again, second: delegated jobs and subagents are
  // things you watch while a turn runs, not something you go and look for.
  // Its label carries what is busy in it.
  const working = [...projection.inspector.agents.values()].filter((agent) => agent.status === "working" || agent.status === "starting").length;
  const jobsBusy = sessionJobs.filter((job) => job.status === "starting" || job.status === "running").length;
  const jobsWaiting = sessionJobs.filter((job) => job.status === "waiting").length;
  const agentsBusy = working + jobsBusy;
  const agentsLabel = `${t("Agents")}${agentsBusy > 0 ? ` · ${agentsBusy}` : ""}${jobsWaiting > 0 ? ` · ${t("{n} waiting", { n: jobsWaiting })}` : ""}`;
  const tabs: { id: typeof tab; label: string }[] = [
    { id: "transcript", label: t("Conversation") },
    { id: "agents", label: agentsLabel },
    ...(isWorker ? [] : [{ id: "odyssey" as const, label: odysseyLabel }]),
  ];

  return (
    <section className={`panel session-panel ${dropping ? "drop-target" : ""}`}>
      <header className="session-header">
        <h2
          title={[
            handle.id,
            t("process {process} · attachment {attachment} · turn {turn}", { process: projection.process, attachment: projection.attachment, turn: projection.foreground }),
            projection.capabilities
              ? `${projection.capabilities.agentName} ${projection.capabilities.agentVersion} · ACP v${projection.capabilities.protocolVersion} · ${projection.capabilities.supportsSteering ? t("steering") : t("no steering")}`
              : null,
            projection.usage ? t("context {used}/{size}", { used: projection.usage.used ?? "?", size: projection.usage.size ?? "?" }) : null,
            t("events {n} · seq {seq}", { n: projection.eventCount, seq: projection.lastSequence }),
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
            {projection.process !== "ready" && <span className="chip chip-warn">{t("process: {state}", { state: projection.process })}</span>}
            {projection.attachment !== "attached" && <span className="chip chip-warn">{t("attachment: {state}", { state: projection.attachment })}</span>}
            {projection.autonomous.size > 0 && <span className="chip chip-active">{t("autonomous turns: {n}", { n: projection.autonomous.size })}</span>}
            {projection.exit && (
              <span className="chip chip-warn">
                {t("exited status {status}", { status: projection.exit.status ?? "?" })}
                {projection.exit.forced ? ` ${t("(forced)")}` : ""}
              </span>
            )}
          </div>
        )}
        {projection.snapshotNeeded && (
          <div className="banner banner-busy">
            {t("The event stream lagged; deltas were skipped.")}{" "}
            <button className="link" onClick={() => void refreshSnapshot(sessionId)} type="button">
              {t("refresh from snapshot and history")}
            </button>
          </div>
        )}
      </header>

      <div className="tabs">
        {/* Only the real tabs are in the tablist; the trailing controls are a
            toggle and a menu, and claiming otherwise would mislead a reader
            using a screen reader. */}
        <div className="tablist" role="tablist">
          {tabs.map((item) => (
            <button
              aria-selected={tab === item.id}
              className={`tab ${tab === item.id ? "tab-on" : ""} ${item.id === "transcript" && active ? "tab-running" : ""}`}
              key={item.id}
              onClick={() => setTab(item.id)}
              role="tab"
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="tabs-spacer" />
        <button
          aria-label={t("Terminal")}
          aria-pressed={tab === "terminal"}
          className={`icon-button icon-button-xs tab-icon remote-hidden ${tab === "terminal" ? "on" : ""}`}
          onClick={() => setTab("terminal")}
          title={t("Terminal")}
          type="button"
        >
          <IconTerminal size={15} />
        </button>
        {!IS_REMOTE && <ViewsMenu onPick={setTab} tab={tab} />}
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
                    aria-label={t("Search transcript")}
                    className="input"
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setQuery("");
                        setSearchOpen(false);
                        composerRef.current?.focus();
                      }
                    }}
                    placeholder={t("Search transcript (Esc to close)")}
                    ref={searchRef}
                    value={query}
                  />
                  <span className="small muted">
                    {t("{shown} of {total} entries", { shown: filteredCards.length, total: projection.cards.length })}
                  </span>
                </>
              )}
              {windowStart > 0 && (
                <button className="link small" onClick={() => setVisible((v) => v + uiPrefs.transcriptPage)} type="button">
                  {t("show {n} earlier of {total}", { n: Math.min(uiPrefs.transcriptPage, windowStart), total: windowStart })}
                </button>
              )}
            </div>
          )}
          <BigThingBand sessionId={sessionId} />
          <div aria-busy={active} className="transcript" ref={transcriptRef}>
            <EarlierConversation sessionId={sessionId} />
            {transcriptGroups.map((group, index, groups) => (
              <Fragment key={group.kind === "single" ? group.card.key : group.key}>
              {group.kind === "single" ? (
                <CardView card={group.card} images={cardImages.get(group.card.key)} key={group.card.key} sessionId={sessionId} />
              ) : group.kind === "work" ? (
                <>
                  <ToolGroup
                    cards={group.cards}
                    key={group.key}
                    live={active && index === groups.length - 1}
                    renderCard={(card) => <CardView card={card} key={card.key} sessionId={sessionId} />}
                    renderDetail={(patch) => <ToolDetail patch={patch} provider={session.snapshot.provider} workspaceId={session.workspaceId} />}
                    sessionId={sessionId}
                  />
                  {/* Images the folded tools made or looked at stay in view
                      under the run, not hidden inside it. */}
                  {(() => {
                    const images = group.cards.flatMap((card) => cardImages.get(card.key) ?? []);
                    return images.length > 0 ? <CardImages images={images} workspaceId={session.workspaceId} /> : null;
                  })()}
                </>
              ) : (
                <details className="runtime-group" key={group.key}>
                  <summary className="small muted">
                    {t("runtime · {n} events · latest: {text}", { n: group.cards.length, text: (group.cards.at(-1) as { text: string }).text.slice(0, 120) })}
                  </summary>
                  {group.cards.map((card) => (
                    <CardView card={card} key={card.key} sessionId={sessionId} />
                  ))}
                </details>
              )}
              {group.kind === "single" &&
                group.card.kind === "message" &&
                group.card.message.role === "agent" &&
                apksNamedIn(messageText(group.card), workspaceRoot).map((path) => <ApkCard key={`apk|${path}`} path={path} />)}
              {docPlaces.get(index)?.map((doc) => (
                <DocCard key={`doc|${doc.path}`} relative={doc.path} sessionId={sessionId} verb={doc.verb} version={doc.version} workspaceId={session.workspaceId} />
              ))}
              </Fragment>
            ))}
            {/* What this session has changed on disk, at the end of the
                reading order so it is the last thing before the composer. */}
            {projection.cards.length > 0 && <CodeChangesCard refreshKey={projection.cards.length} sessionId={sessionId} workspaceId={session.workspaceId} />}
            {observedImages.length > 0 && (
              // Most of these already appear inline where the agent produced
              // them, so this catch-all stays folded: it is a backstop for
              // files that never made it into the transcript, not a gallery.
              <details className="card observed-images">
                <summary className="small muted">
                  {observedImages.length === 1
                    ? t("{n} image appeared in output/imagegen during this session (observed files)", { n: observedImages.length })
                    : t("{n} images appeared in output/imagegen during this session (observed files)", { n: observedImages.length })}
                  <span className="link small observed-images-open" onClick={(event) => event.stopPropagation()} role="none">
                    <button className="link small" onClick={() => setTab("images")} type="button">
                      {t("open Images tab")}
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
            {projection.cards.length === 0 && <p className="muted">{t("Attached. Send a prompt to begin.")}</p>}
            {query && filteredCards.length === 0 && <p className="muted">{t("No entries match.")}</p>}
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
        {projection.plan && <PlanBar active={active} key={projection.plan.content.id} plan={projection.plan.content} />}
        {/* The Big Thing view has no use for a prompt box: the run submits its
            own turns. The activity strip above stays, because background work
            outliving a turn is exactly what it is for. */}
        {tab !== "odyssey" && (
        <>
        <QueueStrip active={active} canSteer={canSteer} queue={projection.queue} sessionId={sessionId} />
        <div className="composer-card">
        {(attachments.length > 0 || mentions.length > 0) && (
          <div className="attachment-strip">
            {mentions.map((m, index) => (
              <span
                className="attachment-chip"
                key={`${m.relativePath}-${index}`}
                title={m.mode.mode === "path_reference" ? t("The agent receives an environment-local path and reads the file itself.") : t("The file content is copied into the prompt with its path and hash.")}
              >
                <span className="mono small">@{m.relativePath}</span>
                <button
                  className="link small"
                  onClick={() => updateMention(sessionId, index, { ...m, mode: m.mode.mode === "path_reference" ? { mode: "copied_content" } : { mode: "path_reference" } })}
                  type="button"
                >
                  {m.mode.mode === "path_reference" ? t("as path") : `${t("copied")}${m.mode.startLine ? ` ${m.mode.startLine}-${m.mode.endLine ?? ""}` : ""}`}
                </button>
                <button aria-label={t("remove mention {path}", { path: m.relativePath })} className="link small" onClick={() => removeMention(sessionId, index)} type="button">
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
                {!mediaOk[a.kind] && <span className="chip small chip-warn">{a.kind === "image" ? t("runtime did not advertise image prompts") : t("runtime did not advertise audio prompts")}</span>}
                <button aria-label={t("remove attachment {name}", { name: a.name })} className="link small" onClick={() => removeAttachment(sessionId, a.id)} type="button">
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-wrap">
          {mention && (
            <div aria-label={t("Mention a file")} className="mention-popover" role="listbox">
              <div className="row wrap small" style={{ padding: "4px 8px" }}>
                <span className="muted">{t("Mention @{token}", { token: mention.token })}</span>
                <label className="check small">
                  <input checked={mention.copy} onChange={(e) => setMention({ ...mention, copy: e.target.checked })} type="checkbox" /> {t("copy content into the prompt (default: path reference)")}
                </label>
                {mention.truncated && <span className="muted">{t("more matches; keep typing")}</span>}
              </div>
              <ul className="mention-list">
                {mention.matches.length === 0 && <li className="mention-item muted small">{t("No files match.")}</li>}
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
            aria-label={t("Prompt")}
            className="textarea"
            onChange={(event) => setDraft(sessionId, event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={
              active
                ? canSteer
                  ? steerFirst
                    ? t("Steer this turn ({key}), or queue for the next (⌘{key}). Type @ to mention a file.", { key: sendKey })
                    : t("Queue for the next turn ({key}), or steer this one (⌘{key}). Type @ to mention a file.", { key: sendKey })
                  : t("Queue for the next turn ({key}). Type @ to mention a file.", { key: sendKey })
                : uiPrefs.enterSends
                  ? t("Prompt (Enter to send, Shift+Enter for newline). Type @ to mention a file; drop or paste images to attach.")
                  : t("Prompt (Shift+Enter to send, Enter for newline). Type @ to mention a file; drop or paste images to attach.")
            }
            ref={composerRef}
            rows={2}
            value={draft}
          />
        </div>
        <div className="composer-row">
          <button
            aria-label={t("Attach media")}
            className="icon-button remote-hidden"
            disabled={!canSend}
            onClick={() =>
              api
                .attachmentPick()
                .then((snapshots) => addAttachments(sessionId, snapshots))
                .catch(setError)
            }
            title={t("Attach PNG, JPEG, GIF, WebP, WAV or MP3 (8 files, 10 MiB each, 20 MiB total). Type @ to mention a file.")}
            type="button"
          >
            <IconPaperclip />
          </button>
          <ConfigPickers configOptions={configOptions} disabled={projection.process === "exited" || busy !== null} sessionId={sessionId} />
          {!configOptions && <span className="chip small">{t("the account's default model")}</span>}
          <TeamChip disabled={projection.process === "exited"} sessionId={sessionId} />
          <span className="composer-spacer" />
          {active && (
            <button aria-label={t("Cancel turn")} className="icon-button" onClick={() => void cancel(sessionId)} title={t("Cancel the current turn")} type="button">
              <IconSquare />
            </button>
          )}
          {active ? (
            <>
              {canSteer && (
                <button
                  className={`send-button ${steerFirst ? "" : "send-secondary"}`}
                  disabled={steerInFlight || !draft.trim()}
                  onClick={() => void steer(sessionId)}
                  title={t("Send into the running turn now ({key})", { key: steerFirst ? sendKey : `⌘${sendKey}` })}
                  type="button"
                >
                  {t("Steer")}
                </button>
              )}
              <button
                className={`send-button ${steerFirst ? "send-secondary" : ""}`}
                disabled={!canSend || !hasInput}
                onClick={() => void enqueue(sessionId)}
                title={t("Send when the running turn is over ({key})", { key: steerFirst ? `⌘${sendKey}` : sendKey })}
                type="button"
              >
                {t("Queue")} <IconArrowUp size={14} />
              </button>
            </>
          ) : (
            <button aria-label={t("Send")} className="send-button send-round" disabled={!canSend || !hasInput} onClick={sendAndFollow} title={t("Send")} type="button">
              <IconArrowUp size={16} />
            </button>
          )}
        </div>
        </div>
        <div className="row wrap composer-meta">
          <button className="link small" onClick={() => void stop(sessionId)} type="button">
            {t("stop session")}
          </button>
          {lastSubmission && (
            <span className="small muted">
              {t("last submission {id}: {state}", { id: String(lastSubmission[0]).slice(0, 8), state: String(lastSubmission[1].state).replace("_", " ") })}
              {lastSubmission[1].message ? ` (${lastSubmission[1].message})` : ""}
            </span>
          )}
          {[...projection.steers.entries()].slice(-1).map(([id, state]) => (
            <span className="small muted" key={id}>
              {t("steer {id}: {state}", { id, state: state.replace("_", " ") })}
            </span>
          ))}
        </div>
        </>
        )}
      </footer>
    </section>
  );
}
