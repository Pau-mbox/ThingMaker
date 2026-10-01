#!/usr/bin/env python3
"""A mock of Antigravity's `agy` 1.2.14 in stream-json mode.

Written from a live capture on 1 October 2026. What the bridge depends on:

- `init` (with `conversation_id`) is written at start, before any prompt;
- each `{"event":"user",...}` line on stdin is one turn: a `user_input` step,
  `agent_response` steps with `text_delta`, `tool` steps with `tool_info`,
  then exactly one `result` with `status`, `usage` and `denied_actions`;
- `--conversation <id>` resumes a known conversation; an unknown one only
  warns and starts a new conversation;
- SIGINT ends the turn with `status: ERROR` and the process with it.

It writes its argv to stderr as `argv: <json>`, so a test can see the model,
mode and conversation each launch was given.

Flags (after the real ones):
  --mock-limit   every turn fails as a spent account
  --mock-slow    the answer streams slowly, so a turn can be cancelled
"""
import json
import signal
import sys
import time
import uuid

KNOWN = "c0ffee00-0000-4000-8000-000000000001"
args = sys.argv[1:]
sys.stderr.write("argv: " + json.dumps(args) + "\n")
sys.stderr.flush()


def value(flag):
    if flag in args:
        index = args.index(flag)
        if index + 1 < len(args):
            return args[index + 1]
    return None


LIMIT = "--mock-limit" in args
SLOW = "--mock-slow" in args
asked = value("--conversation")
if asked and asked != KNOWN:
    sys.stderr.write(f'warning: conversation "{asked}" not found\n')
    sys.stderr.flush()
conversation = asked if asked == KNOWN else (str(uuid.uuid4()) if asked else KNOWN)
model = value("--model") or "gemini-3.8-flash-medium"
mode = value("--mode") or "accept-edits"
step = 100 if asked == KNOWN else 0
turns = 0
total = 0


def emit(event):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def step_update(**fields):
    global step
    fields.setdefault("conversation_id", conversation)
    fields.setdefault("step_index", step)
    emit({"event": "step_update", "step_update": fields})


def interrupted(*_):
    emit({"event": "result", "result": {"conversation_id": conversation, "status": "ERROR", "response": "", "num_turns": turns}})
    sys.stderr.write("error: interrupted\n")
    sys.stderr.flush()
    sys.exit(1)


signal.signal(signal.SIGINT, interrupted)
emit({"event": "init", "conversation_id": conversation, "init": {"model": model, "cwd": "/tmp", "tools": ["run_command", "write_to_file"]}})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    message = json.loads(line)
    if message.get("event") != "user":
        continue
    turns += 1
    text = message.get("message", {}).get("content", "")
    step_update(state="DONE", step_type="user_input")
    step += 1
    if LIMIT:
        emit({"event": "result", "result": {"conversation_id": conversation, "status": "ERROR", "response": "",
                                            "error": {"message": "RESOURCE_EXHAUSTED: You have reached your quota for this model. It resets in 5 hours."},
                                            "num_turns": turns}})
        continue
    # A tool that ran, and one the mode refused.
    step_update(state="ACTIVE", step_type="tool", tool_name="write_to_file", tool_info={"name": "write_to_file", "parameters": {"TargetFile": "/tmp/hello.txt"}})
    step_update(state="DONE", step_type="tool", tool_name="write_to_file", duration_seconds=0.02, tool_info={"name": "write_to_file", "parameters": {"TargetFile": "/tmp/hello.txt"}})
    step += 1
    denied = []
    if mode == "plan":
        step_update(state="ERROR", step_type="tool", tool_name="run_command",
                    tool_info={"name": "run_command", "parameters": {"CommandLine": "ls"},
                               "error": {"type": "TOOL_ERROR", "message": "permission check failed for command \"ls\": user denied permission"}})
        step += 1
        denied = [{"action": "command", "display_name": "RunCommand"}]
    parts = ["Echo: ", text[:40]] if not SLOW else [f"{n} " for n in range(1, 60)]
    for part in parts:
        step_update(state="ACTIVE", step_type="agent_response", text_delta=part)
        if SLOW:
            time.sleep(0.1)
    usage = {"input_tokens": 13791, "output_tokens": 7, "thinking_tokens": 0, "cache_read_tokens": 0, "total_tokens": 13798}
    total += usage["total_tokens"]
    step_update(state="DONE", step_type="agent_response", text_delta="\n", duration_seconds=1.2, usage=usage)
    step += 1
    emit({"event": "result", "result": {"conversation_id": conversation, "status": "SUCCESS", "response": "".join(parts) + "\n",
                                        "num_turns": turns, "usage": {"total_tokens": total}, "denied_actions": denied}})
