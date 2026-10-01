#!/usr/bin/env python3
"""A mock of `claude-agent-acp` 0.84.0 (first captured from 0.76.0), to the shape the real adapter answers.

Written from a capture of the real one rather than from its README. What
the desktop depends on:

- it negotiates ACP protocol version **1**, and names itself in `agentInfo`
  with its capabilities under `agentCapabilities`;
- the **client chooses nothing about the session id**: `session/new` answers
  with a UUID of the agent's own, and `session/load` takes that id back;
- model and permission mode are **config options**, set after the session
  exists, not launch flags;
- `session/prompt` answers only when the turn is over, with its stopReason;
- message chunks carry **no `messageId`**;
- `usage_update` carries the account's rate limit as `_meta["_claude/rateLimit"]`;
- a running turn is steered with `_session/steering`.

It writes `session/new`'s `_meta` to stderr as `meta: <json>`, so a test can
see what the desktop asked the SDK for.

Flags:
  --limit          every prompt is refused with the real rate-limit error
  --ask            the first prompt asks for permission before it does anything
  --session=<id>   the id `session/new` hands out (default: a fixed UUID)
  --refuse-model=<id>  a listed model the account cannot select
  --hang           a prompt is never answered and nothing is sent: a dead turn
  --hang-in-tool   a prompt starts a tool call and then waits in it, the way
                   an orchestrator waits in `await_jobs`; `session/cancel`
                   ends it
"""
import json
import sys
import threading

write_lock = threading.Lock()
LIMIT = "--limit" in sys.argv
HANG = "--hang" in sys.argv
HANG_IN_TOOL = "--hang-in-tool" in sys.argv
hanging = {}
ASK = "--ask" in sys.argv


def option(name, default):
    prefix = name + "="
    return next((arg[len(prefix):] for arg in sys.argv if arg.startswith(prefix)), default)


SESSION = option("--session", "d847b2a3-c7b5-4459-8b0f-02fdd03031a4")
# A model this account cannot select, the way an exhausted Fable behaves.
REFUSE_MODEL = option("--refuse-model", None)
mode = "default"
model = "opus"
effort = "default"
next_request_id = 1000


def send(message):
    with write_lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def update(session_id, payload):
    send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session_id, "update": payload}})


def config_options():
    global mode, model, effort
    return [
        {
            "id": "mode",
            "name": "Mode",
            "category": "mode",
            "type": "select",
            "currentValue": mode,
            "options": [
                {"value": "default", "name": "Manual"},
                {"value": "acceptEdits", "name": "Accept edits"},
                {"value": "plan", "name": "Plan"},
                {"value": "auto", "name": "Auto"},
                {"value": "bypassPermissions", "name": "Bypass permissions"},
            ],
        },
        {
            "id": "effort",
            "name": "Effort",
            "category": "thought_level",
            "type": "select",
            "currentValue": effort,
            "options": [{"value": level, "name": level.title()} for level in ["default", "low", "medium", "high", "xhigh", "max"]],
        },
        {
            "id": "model",
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": model,
            "options": [
                {"value": "default", "name": "Default (recommended)", "description": "Opus 5.5"},
                {"value": "opus", "name": "Opus 5.5", "description": "Best for everyday, complex tasks"},
                {"value": "claude-fable-5-1", "name": "Fable 5.1", "description": "Most capable for your hardest and longest-running tasks"},
                {"value": "sonnet", "name": "Sonnet 5.5", "description": "Efficient for routine tasks"},
                {"value": "haiku", "name": "Haiku 4.5", "description": "Fastest for quick answers"},
                {"value": "claude-sonnet-5", "name": "Sonnet 5", "description": "Efficient for routine tasks"},
            ],
        },
    ]


def initialize():
    return {
        "protocolVersion": 1,
        "agentCapabilities": {
            "promptCapabilities": {"image": True, "embeddedContext": True},
            "mcpCapabilities": {"http": True, "sse": True},
            "loadSession": True,
            "sessionCapabilities": {"close": {}, "delete": {}, "fork": {}, "list": {}, "resume": {}, "subagents": {}},
        },
        "agentInfo": {"name": "@agentclientprotocol/claude-agent-acp", "title": "Claude Agent", "version": "0.84.0"},
        "authMethods": [],
        "_meta": {"steering": {"supported": True}},
    }


def run_turn(session_id):
    """One turn that delegates to a subagent, as a `Task` tool call.

    No `state_update` is sent, because the real adapter has none: its whole
    turn-completion signal is the `session/prompt` response's `stopReason`.
    """
    global next_request_id
    update(session_id, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Looking "}})
    update(session_id, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "at it."}})
    if ASK:
        # The adapter asks the client, and names its own option ids; the kind
        # is the part ACP defines and the part the desktop matches on.
        request_id = next_request_id
        next_request_id += 1
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "session/request_permission",
            "params": {
                "sessionId": session_id,
                "title": "Run `pnpm test`",
                "options": [
                    {"optionId": "allow_once_1", "name": "Yes", "kind": "allow_once"},
                    {"optionId": "allow_always_1", "name": "Yes, and don't ask again", "kind": "allow_always"},
                    {"optionId": "reject_once_1", "name": "No", "kind": "reject_once"},
                ],
            },
        })
    update(session_id, {
        "sessionUpdate": "tool_call",
        "toolCallId": "toolu_01",
        "title": "7.3-pricing",
        "kind": "think",
        "status": "in_progress",
        "name": "Task",
        "rawInput": {"description": "7.3-pricing", "subagent_type": "general-purpose", "prompt": "work the task"},
    })
    update(session_id, {"sessionUpdate": "tool_call_update", "toolCallId": "toolu_01", "status": "completed"})
    update(session_id, {
        "sessionUpdate": "agent_message_chunk",
        "content": {"type": "text", "text": "SUPERTHING-REPORT: milestone=1 status=complete note=done"},
    })
    update(session_id, {
        "sessionUpdate": "usage_update",
        "used": 1200,
        "size": 200000,
        "_meta": {"_claude/rateLimit": {"status": "allowed_warning", "resetsAt": 1790800000, "rateLimitType": "five_hour", "utilization": 0.82}},
    })


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
        # A response to something we asked (a permission request). The mock
        # does not act on it; the test reads the desktop's decision from the
        # event stream instead.
        continue
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": request, "result": initialize()})
    elif method == "session/new":
        sys.stderr.write("meta: " + json.dumps(params.get("_meta")) + "\n")
        sys.stderr.flush()
        send({"jsonrpc": "2.0", "id": request, "result": {"sessionId": SESSION, "configOptions": config_options()}})
    elif method == "session/load":
        loaded = params.get("sessionId")
        if loaded != SESSION:
            send({"jsonrpc": "2.0", "id": request, "error": {"code": -32602, "message": f"no session {loaded}"}})
        else:
            # A load replays the session as updates before it answers.
            update(loaded, {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "earlier ask"}})
            update(loaded, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "earlier work"}})
            send({"jsonrpc": "2.0", "id": request, "result": {"sessionId": loaded, "configOptions": config_options()}})
    elif method == "session/set_config_option":
        # `configId` and a plain string `value`, as the real adapter reads
        # them; it ignores the `type` discriminator the desktop also sends.
        option_id = params.get("configId")
        value = params.get("value")
        if option_id == "mode":
            mode = value
        elif option_id == "effort":
            effort = value
        elif option_id == "model":
            # A model whose own allowance is gone is still *listed*; it just
            # cannot be selected. The adapter answers the call and leaves the
            # option where it was, which is why the desktop checks the value
            # that comes back rather than trusting the reply.
            if value != REFUSE_MODEL:
                model = value
        send({"jsonrpc": "2.0", "id": request, "result": {"configOptions": config_options()}})
    elif method == "session/prompt":
        # The real adapter answers this only when the turn is over, with its
        # stopReason and usage totals — so the turn's updates come first and
        # the response last. A client that expects an acknowledgement here
        # waits for the whole turn.
        if HANG:
            hanging["request"] = request
        elif HANG_IN_TOOL:
            update(params.get("sessionId"), {"sessionUpdate": "tool_call", "toolCallId": "toolu_wait", "title": "await_jobs", "kind": "other", "status": "in_progress"})
            hanging["request"] = request
        elif LIMIT:
            send({
                "jsonrpc": "2.0",
                "id": request,
                "error": {
                    "code": -32603,
                    "message": "Internal error: You've hit your session limit · resets 12:20am (Europe/Madrid)",
                    "data": {"errorKind": "rate_limit"},
                },
            })
        else:
            run_turn(params.get("sessionId"))
            send({"jsonrpc": "2.0", "id": request, "result": {"stopReason": "end_turn"}})
    elif method == "_session/steering":
        prompt = params.get("prompt") or []
        if not prompt:
            send({"jsonrpc": "2.0", "id": request, "error": {"code": -32602, "message": "steer params require a non-empty prompt array"}})
        else:
            send({"jsonrpc": "2.0", "id": request, "result": {}})
    elif method == "session/cancel":
        sys.stderr.write("cancel received\n")
        sys.stderr.flush()
        if "request" in hanging:
            send({"jsonrpc": "2.0", "id": hanging.pop("request"), "result": {"stopReason": "cancelled"}})
    elif method == "session/close":
        send({"jsonrpc": "2.0", "id": request, "result": {}})
    elif request is not None:
        send({"jsonrpc": "2.0", "id": request, "error": {"code": -32601, "message": f"no method {method}"}})
