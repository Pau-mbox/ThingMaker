#!/usr/bin/env python3
"""A mock of `codex app-server` 0.158, to the shape the real one answers.

Written from the protocol the real binary generates (`codex app-server
generate-ts --experimental`) and from a live capture on 30 September 2026.
What the bridge depends on:

- messages carry **no `"jsonrpc"` field**;
- `thread/start` / `thread/resume` answer with a `thread` whose `id` is the
  session id; `thread/resume` includes the past `turns`;
- `turn/start` answers at once with the `turn`; the turn's items stream as
  `item/started`, `item/agentMessage/delta`, `item/completed`, and it ends
  with `turn/completed`;
- `account/rateLimits/updated` and `thread/tokenUsage/updated` arrive during
  a turn.

It writes each `turn/start` it receives to stderr as `turn: <json>`, so a test
can see the model, effort and sandbox the bridge asked for.

Flags:
  --limit       every turn fails with `usageLimitExceeded`
  --ask         the first turn asks to run a command before it answers
  --elicit      the first turn asks, as Codex does before an MCP tool runs,
                whether the `team` server's tool may run, then asks the
                same for a server the session was not given
  --thread=<id> the id `thread/start` hands out
  --image-limit-once  the first turn's image tool fails with Codex's
                      `usageLimitExceeded`; later turns make the image
  --overloaded-once   the first turn fails with `serverOverloaded`
"""
import json
import sys
import threading

LIMIT = "--limit" in sys.argv
ASK = "--ask" in sys.argv
ELICIT = "--elicit" in sys.argv
IMAGE_LIMIT_ONCE = "--image-limit-once" in sys.argv
OVERLOADED_ONCE = "--overloaded-once" in sys.argv


def option(name, default):
    prefix = name + "="
    return next((arg[len(prefix):] for arg in sys.argv if arg.startswith(prefix)), default)


THREAD = option("--thread", "01a0f24c-75b5-77d0-ba43-9319ccd9e5ef")
lock = threading.Lock()
next_server_id = 9000
approval_answers = {}
answered = threading.Condition()


def send(message):
    with lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def notify(method, params):
    send({"method": method, "params": params})


def thread_object(turns=None):
    return {"id": THREAD, "sessionId": THREAD, "cwd": "/tmp", "model": "gpt-6-astra", "turns": turns or [], "status": {"type": "idle"}}


MODELS = [
    {"id": "gpt-6-astra", "displayName": "GPT-6-Astra", "description": "", "hidden": False, "isDefault": True,
     "supportedReasoningEfforts": [{"reasoningEffort": e} for e in ["low", "medium", "high", "max"]], "defaultReasoningEffort": "medium", "inputModalities": ["text", "image"]},
    {"id": "gpt-6-luna", "displayName": "GPT-6-Luna", "description": "Fast", "hidden": False, "isDefault": False,
     "supportedReasoningEfforts": [{"reasoningEffort": e} for e in ["low", "max"]], "defaultReasoningEffort": "low", "inputModalities": ["text", "image"]},
]


def run_turn(turn_id, prompt="hi"):
    global next_server_id
    if ASK:
        request_id = next_server_id
        next_server_id += 1
        send({"id": request_id, "method": "item/commandExecution/requestApproval",
              "params": {"threadId": THREAD, "turnId": turn_id, "itemId": "cmd_1", "kind": "command", "startedAtMs": 1, "command": "pnpm test", "reason": None}})
        with answered:
            answered.wait_for(lambda: request_id in approval_answers, timeout=10)
    if ELICIT:
        for server in ["team", "someone-else"]:
            request_id = next_server_id
            next_server_id += 1
            send({"id": request_id, "method": "mcpServer/elicitation/request",
                  "params": {"threadId": THREAD, "turnId": turn_id, "serverName": server, "mode": "form",
                             "_meta": {"codex_approval_kind": "mcp_tool_call", "persist": ["session", "always"], "tool_title": "Delegate a task"},
                             "message": "Allow the team MCP server to run tool \"delegate\"?",
                             "requestedSchema": {"type": "object", "properties": {}}}})
            with answered:
                answered.wait_for(lambda: request_id in approval_answers, timeout=10)
    notify("item/started", {"threadId": THREAD, "turnId": turn_id, "startedAtMs": 1,
                             "item": {"type": "userMessage", "id": "u_1", "clientId": None, "content": [{"type": "text", "text": prompt, "text_elements": []}]}})
    notify("item/completed", {"threadId": THREAD, "turnId": turn_id, "completedAtMs": 1,
                               "item": {"type": "userMessage", "id": "u_1", "clientId": None, "content": [{"type": "text", "text": prompt, "text_elements": []}]}})
    if OVERLOADED_ONCE and turns == 1:
        notify("turn/completed", {"threadId": THREAD, "turn": {"id": turn_id, "items": [], "status": "failed",
                                                                "error": {"message": "We're currently experiencing high demand.", "codexErrorInfo": "serverOverloaded"}}})
        return
    if IMAGE_LIMIT_ONCE:
        limited = turns == 1
        item = {"type": "imageGeneration", "id": f"ig_{turns}", "status": "failed" if limited else "completed", "revisedPrompt": "a logo",
                "result": "", "failure": {"type": "usageLimitExceeded", "limitId": "images", "resetsAt": None} if limited else None}
        if not limited:
            item["savedPath"] = "/tmp/.codex/generated_images/t/ig.png"
        notify("item/started", {"threadId": THREAD, "turnId": turn_id, "startedAtMs": 2, "item": {**item, "status": "inProgress", "failure": None}})
        notify("item/completed", {"threadId": THREAD, "turnId": turn_id, "completedAtMs": 3, "item": item})
        text = "The image generation limit is spent, so I could not make the logo." if limited else "Saved the logo."
        notify("item/completed", {"threadId": THREAD, "turnId": turn_id, "completedAtMs": 4,
                                   "item": {"type": "agentMessage", "id": f"msg_img_{turns}", "text": text, "phase": None, "memoryCitation": None, "delivery": None, "questions": None}})
        notify("turn/completed", {"threadId": THREAD, "turn": {"id": turn_id, "items": [], "status": "completed", "error": None}})
        return
    if LIMIT:
        notify("turn/completed", {"threadId": THREAD, "turn": {"id": turn_id, "items": [], "status": "failed",
                                                                "error": {"message": "You've hit your usage limit. Try again in 2 hours.", "codexErrorInfo": "usageLimitExceeded"}}})
        return
    notify("item/started", {"threadId": THREAD, "turnId": turn_id, "startedAtMs": 2,
                             "item": {"type": "commandExecution", "id": "cmd_2", "command": "ls", "cwd": "/tmp", "status": "inProgress", "commandActions": []}})
    notify("item/completed", {"threadId": THREAD, "turnId": turn_id, "completedAtMs": 3,
                               "item": {"type": "commandExecution", "id": "cmd_2", "command": "ls", "cwd": "/tmp", "status": "completed", "exitCode": 0, "aggregatedOutput": "a.txt\n", "durationMs": 4}})
    notify("item/started", {"threadId": THREAD, "turnId": turn_id, "startedAtMs": 4,
                             "item": {"type": "collabAgentToolCall", "id": "k_1", "tool": "spawnAgent", "status": "inProgress", "senderThreadId": THREAD,
                                      "receiverThreadIds": [], "prompt": "7.3-pricing: price the tiers", "model": "gpt-6-luna", "reasoningEffort": "low", "agentsStates": {}}})
    notify("item/completed", {"threadId": THREAD, "turnId": turn_id, "completedAtMs": 5,
                               "item": {"type": "collabAgentToolCall", "id": "k_1", "tool": "spawnAgent", "status": "completed", "senderThreadId": THREAD,
                                        "receiverThreadIds": ["sub"], "prompt": "7.3-pricing: price the tiers", "model": "gpt-6-luna", "reasoningEffort": "low", "agentsStates": {}}})
    # A subagent's own stream is not the session's.
    notify("item/agentMessage/delta", {"threadId": "sub", "turnId": "t_sub", "itemId": "m_sub", "delta": "subagent chatter"})
    for delta in ["Looking ", "at it."]:
        notify("item/agentMessage/delta", {"threadId": THREAD, "turnId": turn_id, "itemId": "msg_1", "delta": delta})
    notify("item/completed", {"threadId": THREAD, "turnId": turn_id, "completedAtMs": 6,
                               "item": {"type": "agentMessage", "id": "msg_1", "text": "Looking at it.", "phase": None, "memoryCitation": None, "delivery": None, "questions": None}})
    notify("thread/tokenUsage/updated", {"threadId": THREAD, "turnId": turn_id, "tokenUsage": {
        "total": {"totalTokens": 17198, "inputTokens": 17193, "cachedInputTokens": 12032, "cacheWriteInputTokens": 0, "outputTokens": 5, "reasoningOutputTokens": 0},
        "last": {"totalTokens": 17198, "inputTokens": 17193, "cachedInputTokens": 12032, "cacheWriteInputTokens": 0, "outputTokens": 5, "reasoningOutputTokens": 0},
        "modelContextWindow": 258400}})
    notify("account/rateLimits/updated", {"rateLimits": {"limitId": "codex", "primary": {"usedPercent": 3, "windowDurationMins": 300, "resetsAt": 1790785099},
                                                         "secondary": {"usedPercent": 71, "windowDurationMins": 10080, "resetsAt": 1791062537},
                                                         "planType": "plus", "rateLimitReachedType": None}})
    notify("turn/completed", {"threadId": THREAD, "turn": {"id": turn_id, "items": [], "status": "completed", "error": None}})


turns = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        message = json.loads(line)
    except json.JSONDecodeError:
        continue
    method = message.get("method")
    request = message.get("id")
    params = message.get("params") or {}
    if method is None:
        with answered:
            approval_answers[request] = message.get("result") or message.get("error")
            answered.notify_all()
        sys.stderr.write("answer: " + json.dumps(message) + "\n")
        sys.stderr.flush()
        continue
    if method == "initialize":
        send({"id": request, "result": {"userAgent": "thingmaker/0.158.0-alpha.2.1 (Mac OS 15.3.2; arm64) unknown (thingmaker; 0.0.0)", "codexHome": "/tmp/.codex", "platformFamily": "unix", "platformOs": "macos"}})
    elif method == "initialized":
        pass
    elif method == "thread/start":
        send({"id": request, "result": {"thread": thread_object(), "model": params.get("model") or "gpt-6-astra", "modelProvider": "openai", "cwd": params.get("cwd")}})
    elif method == "thread/resume":
        if params.get("threadId") != THREAD:
            send({"id": request, "error": {"code": -32602, "message": "no such thread"}})
            continue
        past = [{"id": "t_0", "status": "completed", "items": [
            {"type": "userMessage", "id": "u_0", "clientId": None, "content": [{"type": "text", "text": "earlier ask", "text_elements": []}]},
            {"type": "agentMessage", "id": "m_0", "text": "earlier work"},
        ]}]
        send({"id": request, "result": {"thread": thread_object(past), "model": "gpt-6-astra", "modelProvider": "openai", "cwd": params.get("cwd")}})
    elif method == "model/list":
        send({"id": request, "result": {"data": MODELS, "nextCursor": None}})
    elif method == "turn/start":
        sys.stderr.write("turn: " + json.dumps(params) + "\n")
        sys.stderr.flush()
        turns += 1
        turn_id = f"t_{turns}"
        send({"id": request, "result": {"turn": {"id": turn_id, "items": [], "status": "inProgress", "error": None}}})
        text = "".join(part.get("text", "") for part in params.get("input") or [] if part.get("type") == "text")
        threading.Thread(target=run_turn, args=(turn_id, text or "hi"), daemon=True).start()
    elif method == "turn/steer":
        send({"id": request, "result": {"turnId": params.get("expectedTurnId")}})
    elif method == "turn/interrupt":
        send({"id": request, "result": {}})
    elif request is not None:
        send({"id": request, "error": {"code": -32601, "message": f"no method {method}"}})
