#!/usr/bin/env python3
"""Stateful Tailscale Serve stand-in for the bridge CLI tests.

It only implements the four calls facilitator may make. State, controls, and
the append-only call record live below TS_FAKE_DIR, always an isolated test
folder. Unknown arguments fail so a changed production command cannot pass by
accident.
"""

import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(os.environ["TS_FAKE_DIR"])
STATUS = ROOT / "status.json"
SERVE = ROOT / "serve.json"
CONTROL = ROOT / "control.json"
CALLS = ROOT / "calls.jsonl"
ARGS = sys.argv[1:]


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def save(path, value):
    path.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")


def controls():
    try:
        value = load(CONTROL)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def recorded_calls():
    try:
        return [json.loads(line) for line in CALLS.read_text(encoding="utf-8").splitlines()]
    except OSError:
        return []


def record():
    with CALLS.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(ARGS) + "\n")


def raw(path):
    sys.stdout.write(path.read_text(encoding="utf-8"))


def host_port_port(value):
    try:
        parsed = urlparse("//" + value)
        return parsed.port
    except (TypeError, ValueError):
        return None


def remove_empty(config, name):
    value = config.get(name)
    if isinstance(value, dict) and not value:
        config.pop(name)


def mutate_on(config, status, target):
    name = status["Self"]["DNSName"].rstrip(".")
    host_port = f"{name}:443"
    tcp = config.setdefault("TCP", {})
    tcp.setdefault("443", {"HTTPS": True})
    web = config.setdefault("Web", {})
    server = web.setdefault(host_port, {})
    handlers = server.setdefault("Handlers", {})
    handlers["/"] = {"Proxy": target}
    funnel = config.get("AllowFunnel")
    if isinstance(funnel, dict):
        funnel.pop(host_port, None)
        remove_empty(config, "AllowFunnel")


def mutate_off(config, status):
    name = status["Self"]["DNSName"].rstrip(".")
    host_port = f"{name}:443"
    web = config.get("Web", {})
    server = web.get(host_port, {}) if isinstance(web, dict) else {}
    handlers = server.get("Handlers", {}) if isinstance(server, dict) else {}
    if isinstance(handlers, dict):
        handlers.pop("/", None)
        if not handlers:
            web.pop(host_port, None)
    remove_empty(config, "Web")

    remaining_443 = any(host_port_port(key) == 443 for key in config.get("Web", {}))
    if not remaining_443:
        tcp = config.get("TCP", {})
        if isinstance(tcp, dict):
            tcp.pop("443", None)
        remove_empty(config, "TCP")

    if host_port not in config.get("Web", {}):
        funnel = config.get("AllowFunnel", {})
        if isinstance(funnel, dict):
            funnel.pop(host_port, None)
        remove_empty(config, "AllowFunnel")


record()
control = controls()

if ARGS == ["status", "--json"]:
    if control.get("status_mode") == "fail":
        print("PRIVATE_STATUS_FAILURE", file=sys.stderr)
        raise SystemExit(20)
    raw(STATUS)
    raise SystemExit(0)

if ARGS == ["serve", "status", "--json"]:
    number = sum(call == ARGS for call in recorded_calls())
    replacement = control.get("serve_status_replacements", {}).get(str(number))
    if replacement is not None:
        save(SERVE, replacement)
    if number in control.get("serve_status_fail_calls", []):
        print("PRIVATE_SERVE_STATUS_FAILURE", file=sys.stderr)
        raise SystemExit(21)
    raw(SERVE)
    raise SystemExit(0)

enable = (len(ARGS) == 5 and ARGS[:4] ==
          ["serve", "--bg", "--https=443", "--set-path=/"] and
          ARGS[4].startswith("http://127.0.0.1:"))
disable = ARGS == ["serve", "--https=443", "--set-path=/", "off"]
if not (enable or disable):
    print("unexpected fake tailscale call: " + " ".join(ARGS), file=sys.stderr)
    raise SystemExit(22)

if control.get("mutation_mode") == "fail":
    print("PRIVATE_MUTATION_FAILURE", file=sys.stderr)
    raise SystemExit(23)

if control.get("mutation_mode") != "noop":
    current = load(SERVE)
    status = load(STATUS)
    if enable:
        mutate_on(current, status, ARGS[4])
    else:
        mutate_off(current, status)
    save(SERVE, current)

if "after_mutation_serve" in control:
    save(SERVE, control["after_mutation_serve"])
if "after_mutation_status" in control:
    save(STATUS, control["after_mutation_status"])

print("PRIVATE_SUCCESS_OUTPUT")
