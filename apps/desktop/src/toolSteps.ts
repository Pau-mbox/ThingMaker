/**
 * A tool call as a step a person can read: "Read ROADMAP.md lines 1–40",
 * "Searched Docs/ for “presentation”", "Ran pnpm test".
 *
 * The words come from what the provider reported, in this order: the
 * actions Codex parsed out of a command itself, the description Claude
 * gives each shell command, the title the adapter set for reads, edits and
 * searches, and only then a reading of the shell command here. A command
 * this cannot read is shown as itself, shortened, never guessed at.
 */
import type { ToolPatch } from "@thingmaker/contracts";

export type StepVerb = "read" | "search" | "list" | "run" | "edit" | "fetch" | "agent" | "other";

/** One thing a step did; a shell line can do several. */
export type StepPart = { verb: StepVerb; target: string | null; extra: string | null; files: number };

export type Step = {
  verb: StepVerb;
  /** A sentence of its own (Claude's description), when there is one. */
  sentence: string | null;
  parts: StepPart[];
  running: boolean;
  failed: boolean;
};

const VERB_WORD: Record<StepVerb, string> = { read: "Read", search: "Searched", list: "Listed", run: "Ran", edit: "Edited", fetch: "Fetched", agent: "Started", other: "Used" };
const VERB_ING: Record<StepVerb, string> = { read: "reading", search: "searching", list: "listing", run: "running", edit: "editing", fetch: "fetching", agent: "starting", other: "using" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function short(text: string, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A path as the workspace sees it. */
export function relativePath(path: string, roots: (string | null | undefined)[]): string {
  let out = path;
  for (const root of roots) {
    if (!root) continue;
    const base = root.endsWith("/") ? root : `${root}/`;
    if (out === root || out === base.slice(0, -1)) return ".";
    out = out.split(base).join("");
  }
  return out;
}

/** Shell words, honouring quotes and backslash escapes. */
function words(segment: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let had = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index] as string;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < segment.length) current += segment[++index];
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      had = true;
    } else if (char === "\\" && index + 1 < segment.length) {
      current += segment[++index];
      had = true;
    } else if (/\s/.test(char)) {
      if (current || had) out.push(current);
      current = "";
      had = false;
    } else {
      current += char;
    }
  }
  if (current || had) out.push(current);
  return out;
}

/** Splits a shell line at `;`, `&&`, `||`, newlines and `|`, outside quotes. Each entry is a pipeline. */
function pipelines(line: string): string[][] {
  const out: string[][] = [];
  let pipeline: string[] = [];
  let current = "";
  let quote: string | null = null;
  const flush = () => {
    if (current.trim()) pipeline.push(current.trim());
    current = "";
  };
  const end = () => {
    flush();
    if (pipeline.length) out.push(pipeline);
    pipeline = [];
  };
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    const next = line[index + 1];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && index + 1 < line.length) {
        current += char + next;
        index += 1;
        continue;
      }
      current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (char === "\\" && index + 1 < line.length) {
      current += char + next;
      index += 1;
    } else if (char === ";" || char === "\n" || (char === "&" && next === "&") || (char === "|" && next === "|")) {
      end();
      if (char !== ";" && char !== "\n") index += 1;
    } else if (char === "|") {
      flush();
    } else {
      current += char;
    }
  }
  end();
  return out;
}

/** `zsh -lc '…'` and friends: the command inside. */
function unwrap(command: string): string {
  const match = /^\s*(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  return match ? (match[2] as string) : command;
}

const SEARCH = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
const READ = new Set(["cat", "head", "tail", "sed", "nl", "less", "more", "bat", "wc"]);
const LIST = new Set(["ls", "find", "tree", "fd", "du"]);
/** Flags that take the next word as their value. */
const VALUED = new Set(["-e", "-f", "-A", "-B", "-C", "-m", "-g", "-t", "-n", "-c", "--glob", "--type", "--max-count", "--context", "--name", "-name", "-iname", "-type", "-maxdepth", "-mindepth", "-path", "-L"]);

function operands(args: string[], skipValued = true): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--") {
      out.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (skipValued && VALUED.has(arg)) index += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function quoted(pattern: string): string {
  const alternatives = pattern
    .split(/\\\||\|/)
    .map((entry) => entry.replace(/\\(.)/g, "$1").replace(/^\^|\$$/g, "").trim())
    .filter(Boolean);
  const shown = alternatives.slice(0, 3).map((entry) => `“${short(entry, 30)}”`);
  return `for ${shown.join(", ")}${alternatives.length > 3 ? ` +${alternatives.length - 3}` : ""}`;
}

function joinTargets(targets: string[]): string | null {
  if (targets.length === 0) return null;
  return targets.length > 2 ? `${targets.slice(0, 2).join(", ")} +${targets.length - 2}` : targets.join(", ");
}

/** What one command in a pipeline does. */
function readCommand(tokens: string[], rel: (path: string) => string): StepPart | null {
  const [head, ...args] = tokens;
  if (!head) return null;
  const name = head.split("/").pop() as string;
  if (name === "cd" || name === "export" || name === "set" || name === "source" || name === ".") return null;
  if (name === "git" && args[0] === "grep") return readCommand(["grep", ...args.slice(1)], rel);
  if (SEARCH.has(name)) {
    const explicit = args.indexOf("-e");
    const rest = operands(args);
    const pattern = explicit >= 0 ? (args[explicit + 1] ?? "") : (rest.shift() ?? "");
    return { verb: "search", target: joinTargets(rest.map(rel)), extra: pattern ? quoted(pattern) : null, files: 0 };
  }
  if (READ.has(name)) {
    let range: string | null = null;
    let rest: string[];
    if (name === "sed") {
      // `-n` here is a switch, not a flag with a value: the script follows.
      const [script = "", ...files] = operands(args, false);
      const lines = /^(\d+)(?:,(\d+))?p$/.exec(script);
      if (lines) range = lines[2] ? `lines ${lines[1]}–${lines[2]}` : `line ${lines[1]}`;
      rest = files;
    } else {
      rest = operands(args).filter((arg) => !/^\+?\d+$/.test(arg));
      const flag = args.indexOf("-n");
      const count = flag >= 0 ? args[flag + 1] : args.find((arg) => /^-\d+$/.test(arg))?.slice(1);
      if ((name === "head" || name === "tail") && count) range = `${name === "head" ? "first" : "last"} ${count} lines`;
    }
    if (rest.length === 0) return null;
    return { verb: "read", target: joinTargets(rest.map(rel)), extra: range, files: rest.length };
  }
  if (LIST.has(name)) {
    const rest = operands(args);
    return { verb: "list", target: joinTargets((name === "find" ? rest.slice(0, 1) : rest).map(rel)) ?? ".", extra: null, files: 0 };
  }
  return { verb: "run", target: short(tokens.slice(0, 3).map(rel).join(" "), 48), extra: null, files: 0 };
}

/** The parts of a shell line, the `cd` into a folder dropped. */
export function readShell(command: string, roots: (string | null | undefined)[]): StepPart[] {
  const parts: StepPart[] = [];
  const dirs = [...roots];
  for (const pipeline of pipelines(unwrap(command))) {
    const first = words(pipeline[0] as string);
    if ((first[0] === "cd" || first[0] === "pushd") && first[1]) {
      dirs.unshift(first[1]);
      continue;
    }
    // `cat x | grep y` searches x: the filter after the pipe says what was done.
    let part = readCommand(first, (path) => relativePath(path, dirs));
    const filter = pipeline.length > 1 ? readCommand(words(pipeline[1] as string), (path) => relativePath(path, dirs)) : null;
    if (part?.verb === "read" && filter?.verb === "search") part = { ...filter, target: part.target };
    if (part) parts.push(part);
  }
  return parts;
}

function actionsOf(actions: unknown, roots: (string | null | undefined)[]): StepPart[] | null {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const rel = (path: string) => relativePath(path, roots);
  const parts: StepPart[] = [];
  for (const action of actions) {
    if (!isRecord(action)) continue;
    const path = str(action.path);
    switch (action.type) {
      case "read":
        parts.push({ verb: "read", target: path ? rel(path) : str(action.name), extra: null, files: 1 });
        break;
      case "listFiles":
        parts.push({ verb: "list", target: path ? rel(path) : ".", extra: null, files: 0 });
        break;
      case "search": {
        const query = str(action.query);
        parts.push({ verb: "search", target: path ? rel(path) : null, extra: query ? quoted(query) : null, files: 0 });
        break;
      }
      default: {
        const command = str(action.command);
        if (command) parts.push(...readShell(command, roots));
      }
    }
  }
  return parts.length > 0 ? parts : null;
}

function kindVerb(kind: string | null): StepVerb {
  switch (kind) {
    case "read":
      return "read";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "search":
      return "search";
    case "execute":
      return "run";
    case "fetch":
      return "fetch";
    case "think":
      return "agent";
    default:
      return "other";
  }
}

function editedCount(patch: ToolPatch): number {
  if (Array.isArray(patch.locations) && patch.locations.length > 0) return patch.locations.length;
  const many = /^Edit (\d+) files/.exec(patch.title ?? "");
  return many ? Number(many[1]) : 1;
}

/** ThingMaker's own team tools, in words. */
const TEAM_TOOLS: Record<string, string> = {
  list_workers: "Looked at the team",
  delegate: "Delegated a task",
  await_jobs: "Waited for the workers",
  job_status: "Checked a worker's job",
  cancel_job: "Cancelled a worker's job",
  phone_status: "Checked the phone",
  phone_install: "Installed an app on the phone",
  memory_read: "Read the project memory",
  memory_write: "Wrote to the project memory",
  board: "Read the task board",
  bigthing_report: "Reported a milestone",
  bigthing_task: "Moved a task",
  bigthing_ask: "Asked you a question",
  bigthing_propose_plan: "Proposed the plan",
  bigthing_amend: "Proposed a plan change",
};

/** An MCP tool's call, `mcp__server__tool` (Claude) or `server · tool` (Codex), as words. */
export function mcpLabel(title: string): string | null {
  const match = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(title) ?? /^([\w.-]+) · ([\w.-]+)$/.exec(title);
  if (!match) return null;
  const [, server, tool] = match as unknown as [string, string, string];
  if (server === "team" && TEAM_TOOLS[tool]) return TEAM_TOOLS[tool] as string;
  return `${tool.replace(/_/g, " ")} · ${server}`;
}

/** The step a tool call is. */
export function stepOf(patch: ToolPatch, roots: (string | null | undefined)[]): Step {
  const running = patch.status === "in_progress" || patch.status === "pending";
  const output = isRecord(patch.rawOutput) ? patch.rawOutput : null;
  const exit = output && typeof output.exitCode === "number" ? output.exitCode : null;
  const failed = patch.status === "failed" || (exit !== null && exit !== 0);
  const input = isRecord(patch.rawInput) ? patch.rawInput : null;
  const title = relativePath(patch.title ?? patch.name ?? "tool", roots);
  const verb = kindVerb(patch.toolKind);

  if (patch.toolKind === "execute") {
    const command = str(input?.command) ?? (Array.isArray(input?.command) ? (input?.command as unknown[]).join(" ") : null) ?? patch.title ?? "";
    const parts = actionsOf(input?.actions, roots) ?? readShell(command, roots);
    const description = str(input?.description);
    const shown = parts.length > 0 ? parts : [{ verb: "run" as const, target: short(relativePath(command, roots), 48), extra: null, files: 0 }];
    const main = shown.find((part) => part.verb === "run") ? "run" : (shown[0]?.verb ?? "run");
    return { verb: main, sentence: description ? short(description, 100) : null, parts: shown, running, failed };
  }
  if (verb === "edit") return { verb, sentence: title, parts: [{ verb, target: null, extra: null, files: editedCount(patch) }], running, failed };
  if (verb === "read") return { verb, sentence: title, parts: [{ verb, target: null, extra: null, files: 1 }], running, failed };
  const named = mcpLabel(patch.title ?? "") ?? mcpLabel(patch.name ?? "");
  return { verb, sentence: short(named ?? title, 100), parts: [{ verb, target: null, extra: null, files: 0 }], running, failed };
}

/** The step as one line of plain text, for a live label or a test. */
export function stepText(step: Step): string {
  if (step.sentence) return step.sentence;
  return step.parts
    .slice(0, 2)
    .map((part, index) => {
      const word = VERB_WORD[part.verb];
      const text = [index === 0 ? word : word.toLowerCase(), part.target, part.extra].filter(Boolean).join(" ");
      return text;
    })
    .concat(step.parts.length > 2 ? [`+${step.parts.length - 2} more`] : [])
    .join(" · ");
}

/** "reading ROADMAP.md", for the live strip. */
export function stepDoing(step: Step): string {
  const part = step.parts[0];
  if (step.sentence && (!part || !part.target)) return step.sentence.charAt(0).toLowerCase() + step.sentence.slice(1);
  if (!part) return "working";
  return [VERB_ING[part.verb], part.target === "." ? "the project" : part.target].filter(Boolean).join(" ");
}

/** "Explored · read 6 files, searched 9 times" for a run of steps. */
export function summarize(steps: Step[]): { title: string; detail: string } {
  const tally: Record<StepVerb, number> = { read: 0, search: 0, list: 0, run: 0, edit: 0, fetch: 0, agent: 0, other: 0 };
  for (const step of steps) {
    for (const part of step.parts) tally[part.verb] += part.verb === "read" || part.verb === "edit" ? Math.max(1, part.files) : 1;
  }
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const phrases = [
    tally.edit && `edited ${plural(tally.edit, "file", "files")}`,
    tally.read && `read ${plural(tally.read, "file", "files")}`,
    tally.search && `searched ${plural(tally.search, "time", "times")}`,
    tally.list && `listed ${plural(tally.list, "folder", "folders")}`,
    tally.run && `ran ${plural(tally.run, "command", "commands")}`,
    tally.fetch && `fetched ${plural(tally.fetch, "page", "pages")}`,
    tally.agent && `started ${plural(tally.agent, "agent", "agents")}`,
    tally.other && `used ${plural(tally.other, "tool", "tools")}`,
  ].filter(Boolean) as string[];
  const exploring = tally.edit + tally.run + tally.fetch + tally.agent + tally.other === 0;
  if (tally.edit > 0 && phrases.length === 1) return { title: `Edited ${plural(tally.edit, "file", "files")}`, detail: "" };
  return { title: exploring ? "Explored" : "Worked", detail: phrases.join(", ") };
}
