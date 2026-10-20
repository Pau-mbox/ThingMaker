/**
 * Renderer-side projection of session events.
 *
 * This is a presentation cache, not history (ADR-06). It applies the same
 * absence/null/replacement semantics as the native adapter (F04) so the UI
 * never guesses. Everything here is pure and unit-tested.
 */
import type {
  ContentBlock,
  DetachedCallState,
  EventEnvelope,
  ExitInfo,
  MessageUpdate,
  ProcessState,
  AttachmentState,
  SessionEvent,
  SubmissionState,
  ToolPatch,
  TurnKind,
  TurnPhase,
  CapabilitySnapshot,
  PlanContent,
  QueueView,
  QuotaSnapshot,
} from "@thingmaker/contracts";
import { t } from "./i18n";

export type Role = "user" | "agent" | "thought";

export type Message = {
  key: string;
  role: Role;
  messageId: string;
  blocks: ContentBlock[];
  /** Set when a full message arrived without a `content` field. */
  contentUnknown: boolean;
};

export type Card =
  | { kind: "message"; key: string; message: Message }
  | { kind: "tool"; key: string; toolCallId: string }
  | { kind: "notice"; key: string; severity: string | null; title: string; description?: string }
  | { kind: "plan"; key: string; plan: PlanContent }
  | { kind: "unknown"; key: string; label: string; raw: unknown; truncated: boolean }
  | { kind: "permission"; key: string; requestId: string; title: string | null; decision: string }
  | { kind: "runtime"; key: string; text: string }
  | { kind: "diagnostic"; key: string; text: string }
  | { kind: "turn"; key: string; text: string }
  | { kind: "compaction"; key: string; text: string };

/** Inspector view of a subagent as reported by `subagent_state_changed`. */
export type AgentNode = {
  id: string;
  name: string;
  status: "starting" | "working" | "idle" | "removed";
  outcome: "success" | "failed" | null;
  generation: number;
  task: string;
  parentId: string | null;
  parentName: string | null;
  harness: string;
  model: string | null;
  createdAtUnixMs: number;
  generationStartedAtUnixMs: number;
  generationFinishedAtUnixMs: number | null;
  /** Sequence of the last event that touched this node. */
  updatedSequence: string;
};

export type Inspector = {
  agents: Map<string, AgentNode>;
};

export type Projection = {
  process: ProcessState;
  attachment: AttachmentState;
  foreground: TurnPhase;
  autonomous: Set<number>;
  capabilities: CapabilitySnapshot | null;
  cards: Card[];
  messages: Map<string, Message>;
  toolCalls: Map<string, ToolPatch>;
  detached: Map<string, DetachedCallState>;
  submissions: Map<string, { state: SubmissionState; message?: string }>;
  steers: Map<string, string>;
  usage: { used: number | null; size: number | null } | null;
  tokens: { total: number | null; input: number | null; output: number | null; thought: number | null; cachedRead: number | null; cachedWrite: number | null } | null;
  exit: ExitInfo | null;
  /** The account's quota as the agent last reported it. */
  quota: QuotaSnapshot | null;
  /** Agent-reported session title (session_info_update), when any. */
  title: string | null;
  /** Latest `config_option_update` payload (or the attach snapshot's options). */
  configOptions: unknown;
  lastSequence: string;
  snapshotNeeded: boolean;
  eventCount: number;
  /** Turns that reached a settled phase. Counts every settle, including the
   *  routine successes that no longer leave a card in the transcript, so
   *  anything keyed to "a turn just finished" still fires. */
  settledTurns: number;
  inspector: Inspector;
  /** Prompts waiting for the running turn, as the actor last published them. */
  queue: QueueView;
  /** The agent's latest plan, for the checklist pinned above the composer. */
  plan: { key: string; content: PlanContent } | null;
  /** The card each plan id was last drawn in, and the turn it belongs to. */
  planCards: Map<string, { key: string; turn: number }>;
};

export const EMPTY_QUEUE: QueueView = { items: [], paused: null, sending: null };

export function emptyInspector(): Inspector {
  return { agents: new Map() };
}

export function emptyProjection(): Projection {
  return {
    process: "starting",
    attachment: "new",
    foreground: "idle",
    autonomous: new Set(),
    capabilities: null,
    cards: [],
    messages: new Map(),
    toolCalls: new Map(),
    detached: new Map(),
    submissions: new Map(),
    steers: new Map(),
    usage: null,
    tokens: null,
    exit: null,
    quota: null,
    title: null,
    configOptions: null,
    lastSequence: "0",
    snapshotNeeded: false,
    eventCount: 0,
    settledTurns: 0,
    inspector: emptyInspector(),
    queue: EMPTY_QUEUE,
    plan: null,
    planCards: new Map(),
  };
}

function applyRuntimeEvent(projection: Projection, event: Extract<SessionEvent, { type: "runtime_event" }>, sequence: string): void {
  const inspector = projection.inspector;
  switch (event.event) {
    case "subagent_state_changed":
      inspector.agents.set(event.id, {
        id: event.id,
        name: event.name,
        status: event.status,
        outcome: event.outcome,
        generation: event.generation,
        task: event.task,
        parentId: event.parent_id,
        parentName: event.parent_name,
        harness: event.harness,
        model: event.model,
        createdAtUnixMs: event.created_at_unix_ms,
        generationStartedAtUnixMs: event.generation_started_at_unix_ms,
        generationFinishedAtUnixMs: event.generation_finished_at_unix_ms,
        updatedSequence: sequence,
      });
      break;
    case "subagent_descendants_removed": {
      // Remove every node whose ancestry chain reaches the ancestor.
      const isDescendant = (node: AgentNode): boolean => {
        let cursor: AgentNode | undefined = node;
        const seen = new Set<string>();
        while (cursor && cursor.parentId && !seen.has(cursor.id)) {
          seen.add(cursor.id);
          if (cursor.parentId === event.ancestor_id) return true;
          cursor = inspector.agents.get(cursor.parentId);
        }
        return false;
      };
      for (const [id, node] of [...inspector.agents.entries()]) {
        if (isDescendant(node)) inspector.agents.delete(id);
      }
      break;
    }
    default:
      break;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const TOOL_FIELDS: (keyof ToolPatch)[] = [
  "title",
  "toolKind",
  "status",
  "content",
  "rawInput",
  "rawOutput",
  "name",
  "locations",
  "meta",
];

const WIRE_FIELD: Record<string, string> = {
  title: "title",
  toolKind: "kind",
  status: "status",
  content: "content",
  rawInput: "rawInput",
  rawOutput: "rawOutput",
  name: "name",
  locations: "locations",
  meta: "_meta",
};

/** Mirrors `ToolPatch::merging` in Rust: missing = unchanged, null = cleared, value = replaced. */
export function mergeToolPatch(existing: ToolPatch | undefined, patch: ToolPatch): ToolPatch {
  if (!existing) return { ...patch, present: [...patch.present], cleared: [...patch.cleared] };
  const result: ToolPatch = { ...existing };
  const present = new Set(patch.present);
  const cleared = new Set(patch.cleared);
  for (const field of TOOL_FIELDS) {
    const wire = WIRE_FIELD[field as string] ?? (field as string);
    if (present.has(wire)) {
      (result as Record<string, unknown>)[field] = cleared.has(wire) ? null : patch[field];
    }
  }
  if (patch.toolCallId) result.toolCallId = patch.toolCallId;
  const mergedPresent = new Set([...existing.present, ...patch.present]);
  const mergedCleared = new Set(existing.cleared.filter((f) => !present.has(f)));
  for (const f of cleared) mergedCleared.add(f);
  result.present = [...mergedPresent];
  result.cleared = [...mergedCleared];
  return result;
}

export function isBackground(patch: ToolPatch): boolean {
  const input = patch.rawInput as { background?: unknown } | null | undefined;
  return !!input && typeof input === "object" && input.background === true;
}

function applyMessage(projection: Projection, role: Role, update: MessageUpdate): void {
  const key = `${role}|${update.messageId}`;
  const existing = projection.messages.get(key);
  if (update.replace) {
    const message: Message = {
      key,
      role,
      messageId: update.messageId,
      blocks: update.hasContent ? update.content : existing?.blocks ?? [],
      contentUnknown: !update.hasContent,
    };
    projection.messages.set(key, message);
    if (!existing) projection.cards.push({ kind: "message", key, message });
    else replaceCard(projection, key, { kind: "message", key, message });
    return;
  }
  if (existing) {
    const blocks = [...existing.blocks];
    for (const block of update.content) {
      const last = blocks[blocks.length - 1];
      if (block.type === "text" && last && last.type === "text") {
        blocks[blocks.length - 1] = { type: "text", text: last.text + block.text };
      } else {
        blocks.push(block);
      }
    }
    const message = { ...existing, blocks, contentUnknown: false };
    projection.messages.set(key, message);
    replaceCard(projection, key, { kind: "message", key, message });
  } else {
    const message: Message = { key, role, messageId: update.messageId, blocks: [...update.content], contentUnknown: false };
    projection.messages.set(key, message);
    projection.cards.push({ kind: "message", key, message });
  }
}

function replaceCard(projection: Projection, key: string, card: Card): void {
  const index = projection.cards.findIndex((c) => c.key === key);
  if (index >= 0) projection.cards[index] = card;
  else projection.cards.push(card);
}

function pushCard(projection: Projection, card: DistributiveOmit<Card, "key">, sequence: string, key?: string): void {
  projection.cards.push({ ...card, key: key ?? `${card.kind}|${sequence}` } as Card);
}

/** Applies one envelope. Mutates and returns the same projection object. */
export function applyEvent(projection: Projection, envelope: EventEnvelope): Projection {
  const payload: SessionEvent = envelope.payload;
  projection.lastSequence = envelope.sequence;
  projection.eventCount += 1;
  switch (payload.type) {
    case "process":
      projection.process = payload.state;
      break;
    case "attachment":
      projection.attachment = payload.state;
      break;
    case "capabilities": {
      const { type: _type, ...snapshot } = payload;
      projection.capabilities = snapshot;
      break;
    }
    case "update":
      applyUpdate(projection, payload, envelope.sequence);
      break;
    case "runtime_event":
      applyRuntimeEvent(projection, payload, envelope.sequence);
      pushCard(projection, { kind: "runtime", text: describeRuntimeEvent(payload) }, envelope.sequence);
      break;
    case "quota": {
      const { type: _type, ...quota } = payload;
      projection.quota = quota;
      break;
    }
    case "diagnostic":
      pushCard(projection, { kind: "diagnostic", text: payload.text }, envelope.sequence);
      break;
    case "turn":
      // A turn starting and finishing normally is already visible: the
      // composer, the activity strip and the reply itself all say so. Only
      // the outcomes you would act on leave a line in the transcript.
      if (payload.effect === "started") {
        if (payload.kind === "foreground") projection.foreground = "running";
        else if (payload.turnId !== undefined) projection.autonomous.add(payload.turnId);
      } else if (payload.effect === "cancelling") {
        if (payload.kind === "foreground") projection.foreground = "cancelling";
        pushCard(projection, { kind: "turn", text: t("cancellation requested") }, envelope.sequence);
      } else if (payload.effect === "settled") {
        if (payload.kind === "foreground") projection.foreground = payload.phase;
        else if (payload.turnId !== undefined) projection.autonomous.delete(payload.turnId);
        projection.settledTurns += 1;
        if (payload.phase !== "succeeded") {
          const reason = payload.stopReason ? ` (${payload.stopReason})` : payload.error ? ` (${payload.error})` : "";
          pushCard(projection, { kind: "turn", text: turnLine(payload.kind, payload.phase, reason) }, envelope.sequence);
        }
      }
      break;
    case "submission":
      projection.submissions.set(payload.requestId, { state: payload.state, ...(payload.message ? { message: payload.message } : {}) });
      break;
    case "steer":
      projection.steers.set(payload.messageId, payload.state);
      break;
    case "queue": {
      const { type: _type, ...queue } = payload;
      projection.queue = queue;
      break;
    }
    case "detached_call":
      projection.detached.set(payload.callId, payload.state);
      break;
    case "permission_request":
      pushCard(
        projection,
        { kind: "permission", requestId: payload.requestId, title: payload.title, decision: payload.decision },
        envelope.sequence,
      );
      break;
    case "exited":
      projection.exit = { status: payload.status, signal: payload.signal, forced: payload.forced };
      projection.process = "exited";
      break;
    case "overflow":
      pushCard(
        projection,
        { kind: "diagnostic", text: payload.fatal ? t("{stream} frame of {bytes} bytes exceeded {limit}; attachment failed", { stream: payload.stream, bytes: payload.bytes, limit: payload.limit }) : t("{stream} frame of {bytes} bytes exceeded {limit}", { stream: payload.stream, bytes: payload.bytes, limit: payload.limit }) },
        envelope.sequence,
      );
      break;
    case "snapshot_needed":
      projection.snapshotNeeded = true;
      break;
  }
  return projection;
}

function applyUpdate(projection: Projection, update: Extract<SessionEvent, { type: "update" }>, sequence: string): void {
  switch (update.kind) {
    case "user_message":
      applyMessage(projection, "user", update);
      break;
    case "agent_message":
      applyMessage(projection, "agent", update);
      break;
    case "agent_thought":
      applyMessage(projection, "thought", update);
      break;
    case "tool_call":
    case "tool_call_update": {
      const { kind: _kind, ...patch } = update;
      const id = patch.toolCallId;
      if (!id) break;
      const merged = mergeToolPatch(projection.toolCalls.get(id), patch);
      projection.toolCalls.set(id, merged);
      if (!projection.cards.some((c) => c.kind === "tool" && c.toolCallId === id)) {
        pushCard(projection, { kind: "tool", toolCallId: id }, sequence, `tool|${id}`);
      }
      break;
    }
    case "notice":
      pushCard(
        projection,
        { kind: "notice", severity: update.severity, title: update.title, ...(update.description ? { description: update.description } : {}) },
        sequence,
      );
      break;
    case "plan": {
      const { kind: _kind, ...content } = update;
      // Within one turn the agent revises its plan in place. A later turn's
      // plan is a card of its own in that turn's flow, so the transcript
      // reads in order rather than rewriting a card far above.
      const known = projection.planCards.get(content.id);
      const key = known && known.turn === projection.settledTurns ? known.key : `plan|${content.id}|${projection.settledTurns}`;
      projection.planCards.set(content.id, { key, turn: projection.settledTurns });
      replaceCard(projection, key, { kind: "plan", key, plan: content });
      projection.plan = { key, content };
      break;
    }
    case "plan_removed": {
      const known = projection.planCards.get(update.id);
      if (known) projection.cards = projection.cards.filter((c) => c.key !== known.key);
      projection.planCards.delete(update.id);
      if (projection.plan?.content.id === update.id) projection.plan = null;
      break;
    }
    case "usage":
      projection.usage = { used: update.used, size: update.size };
      break;
    case "session_info":
      if (update.titlePresent) projection.title = update.title;
      break;
    case "config_options":
      projection.configOptions = update.configOptions;
      break;
    case "state":
      if (update.usage) {
        projection.tokens = {
          total: update.usage.totalTokens,
          input: update.usage.inputTokens,
          output: update.usage.outputTokens,
          thought: update.usage.thoughtTokens,
          cachedRead: update.usage.cachedReadTokens,
          cachedWrite: update.usage.cachedWriteTokens,
        };
      }
      break;
    case "compaction":
      pushCard(projection, { kind: "compaction", text: t("compaction {id}: {status}{error}", { id: update.compactionId, status: update.status, error: update.error ? ` (${update.error})` : "" }) }, sequence);
      break;
    case "unknown": {
      const label = typeof (update as Record<string, unknown>).originalKind === "string" ? String((update as Record<string, unknown>).originalKind) : "unknown";
      pushCard(projection, { kind: "unknown", label: `update ${label}`, raw: update.raw, truncated: update.truncated }, sequence);
      break;
    }
    default:
      break;
  }
}

/** A turn that did not succeed, as its transcript line. */
function turnLine(kind: TurnKind, phase: TurnPhase, reason: string): string {
  const values = { reason };
  if (kind === "foreground" && phase === "failed") return t("foreground turn failed{reason}", values);
  if (kind === "foreground" && phase === "cancelled") return t("foreground turn cancelled{reason}", values);
  if (kind === "autonomous" && phase === "failed") return t("autonomous turn failed{reason}", values);
  if (kind === "autonomous" && phase === "cancelled") return t("autonomous turn cancelled{reason}", values);
  return t("{kind} turn {phase}{reason}", { kind, phase, reason });
}

function describeRuntimeEvent(event: Extract<SessionEvent, { type: "runtime_event" }>): string {
  switch (event.event) {
    case "subagent_state_changed": {
      const values = { name: event.name, harness: event.harness };
      switch (event.status) {
        case "starting":
          return t("subagent {name} ({harness}) starting", values);
        case "working":
          return t("subagent {name} ({harness}) working", values);
        case "idle":
          return t("subagent {name} ({harness}) idle", values);
        case "removed":
          return t("subagent {name} ({harness}) removed", values);
        default:
          return t("subagent {name} ({harness}) {status}", { ...values, status: String(event.status) });
      }
    }
    case "subagent_descendants_removed":
      return t("subagent descendants of {id} removed", { id: event.ancestor_id });
    default:
      return t("runtime event");
  }
}
