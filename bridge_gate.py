"""ASGI gate for the phone listener and Serve-marked local requests."""

import asyncio
import json
import re
import time
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urlsplit

import bridge_auth

HERE = Path(__file__).resolve().parent
# The launch picture's painter and its squid are public: the gate paints the
# picture before sign-in, because iOS keeps the one on the page an icon is
# added from. Neither file holds anything read from the board.
PUBLIC_GET = frozenset({"/m-sw.js", "/m-icon-180.png",
                        "/m-icon-192.png", "/m-icon-512.png", "/m-splash-squid.png",
                        "/m-splash.js"})


def _gate_html():
    template = (HERE / "m-gate.html").read_bytes()
    try:
        match = re.search(rb'id="npversion">(v[0-9]+\.[0-9]+\.[0-9]+)<',
                          (HERE / "index.html").read_bytes())
    except OSError:
        match = None
    return template.replace(b"__FACILITATOR_VERSION__", match.group(1) if match else b"v0")


GATE_HTML = _gate_html()


def _headers(scope):
    return {key.lower(): value for key, value in scope.get("headers", [])}


def _cookie(headers):
    jar = SimpleCookie()
    try:
        jar.load(headers.get(b"cookie", b"").decode("ascii"))
        return jar[bridge_auth.COOKIE].value if bridge_auth.COOKIE in jar else ""
    except (UnicodeError, ValueError):
        return ""


REFUSAL_WINDOW = 5.0     # seconds: one refusal line per route per window
REFUSAL_ROUTES_KEPT = 64
REFUSAL_ROUTE_CHARS = 80
KNOWN_METHODS = frozenset(("GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"))
FETCH_WORD = re.compile(r"[a-z-]{1,24}")
# these two routes carry a file name in the path
FILE_ROUTES = ("/uploads/", "/laneimg/")
# a link from another site may open these; no other route may be read that way
PAGE_OPENS = frozenset({"/m", "/"})
# answered only to a page on the Mac itself, never through this gate, signed in
# or not: the Spotify sign-in and explicit browser-window launcher
LOCAL_ONLY = frozenset({"/spotify/session", "/open-in-browser"})


def _client_class(headers):
    """The client log's classes, from the user agent, which is never kept.
    A touch screen on a Mac user agent (an iPad) cannot be told from here."""
    ua = headers.get(b"user-agent", b"")[:512].decode("latin-1")
    if re.search(r"\b(iPhone|iPad|iPod|Android)\b", ua):
        return "phone"
    if "Electron/" in ua:
        return "electron"
    if "Chrome/" in ua:
        return "other" if re.search(r"\b(Edg|OPR)/", ua) else "chrome"
    if "Safari/" in ua:
        return "safari"
    if "Macintosh" in ua and "AppleWebKit/" in ua:
        return "tauri"
    return "other"


def _fetch_word(headers, name):
    value = headers.get(name)
    if value is None:
        return "absent"
    text = value.decode("latin-1").strip().lower()
    return text if FETCH_WORD.fullmatch(text) else "other"


def _cookie_counts(scope):
    """Whether a Cookie header came, how many cookies, whether ours was among
    them. Read from every copy of the header and by name only, so it does not
    depend on the parse that decides the session."""
    came, named, count = False, False, 0
    for name, value in scope.get("headers", []):
        if name.lower() == b"cookie":
            came = True
            for part in value.split(b";"):
                if part.strip():
                    count += 1
                    named = named or part.split(b"=", 1)[0].strip() == bridge_auth.COOKIE.encode()
    return came, count, named


def _refused_route(path):
    for prefix in FILE_ROUTES:
        if path.startswith(prefix):
            return prefix + "*"
    return path[:REFUSAL_ROUTE_CHARS]


def _renewing(send, token):
    """Send the session cookie again, same value, on a page open that succeeds."""
    async def renewed(message):
        if message["type"] == "http.response.start" and message.get("status") == 200:
            message = {**message, "headers": [*message.get("headers", []),
                                              (b"set-cookie", bridge_auth.session_cookie(token).encode())]}
        await send(message)
    return renewed


def _same_origin(headers):
    """Unsafe requests must come from this Host's HTTPS (or local test) origin."""
    try:
        host = headers[b"host"].decode("ascii").lower()
        origin = urlsplit(headers[b"origin"].decode("ascii"))
        loopback_http = origin.scheme == "http" and host.startswith(("127.0.0.1:", "localhost:"))
        return ((origin.scheme == "https" or loopback_http) and origin.netloc.lower() == host and
                origin.path == "" and not origin.query and not origin.fragment)
    except (KeyError, UnicodeError, ValueError):
        return False


async def _reply(scope, receive, send, status, body, content_type="application/json", extra=()):
    if isinstance(body, dict):
        body = json.dumps(body).encode()
    elif isinstance(body, str):
        body = body.encode()
    headers = [(b"content-type", content_type.encode()), (b"cache-control", b"no-store"),
               (b"x-content-type-options", b"nosniff"), (b"referrer-policy", b"no-referrer"),
               (b"content-length", str(len(body)).encode()), (b"connection", b"close"),
               (b"content-security-policy", b"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'"),
               *extra]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


async def _body(receive):
    body = bytearray()
    deadline = asyncio.get_running_loop().time() + 5
    while True:
        try:
            event = await asyncio.wait_for(receive(), timeout=max(0, deadline - asyncio.get_running_loop().time()))
        except asyncio.TimeoutError:
            return None
        if event["type"] != "http.request":
            return None
        body.extend(event.get("body", b""))
        if len(body) > 1024:
            return None
        if not event.get("more_body"):
            return bytes(body)


class BridgeGate:
    def __init__(self, app, bridge_port, log=None):
        self.app = app
        self.bridge_port = bridge_port
        self.log = log
        self._refused = {}   # reason and route -> [when its window opened, refusals folded into it]

    def _note_refusal(self, scope, headers, method, path, known, reason=None):
        """One line per route per window, with a count of the ones left out. A
        failure here must never change the answer, so it is swallowed."""
        if self.log is None:
            return
        try:
            now = time.monotonic()
            route = _refused_route(path)
            name = route if reason is None else f"{reason} {route}"
            table = self._refused
            if name not in table and len(table) >= REFUSAL_ROUTES_KEPT:
                for stale in [k for k, w in table.items() if now - w[0] >= REFUSAL_WINDOW]:
                    del table[stale]
            key = name if name in table or len(table) < REFUSAL_ROUTES_KEPT else ""
            window = table.get(key)
            if window is not None and now - window[0] < REFUSAL_WINDOW:
                window[1] += 1
                return
            folded = window[1] if window else 0
            table[key] = [now, 0]
            came, count, named = _cookie_counts(scope)
            self.log("signinrefused", method=method if method in KNOWN_METHODS else "other",
                     route=route, cookie_header=came, cookies=count, session_cookie=named,
                     session_known=known,
                     sec_fetch_site=_fetch_word(headers, b"sec-fetch-site"),
                     sec_fetch_mode=_fetch_word(headers, b"sec-fetch-mode"),
                     sec_fetch_dest=_fetch_word(headers, b"sec-fetch-dest"),
                     client=_client_class(headers), reason=reason, folded=folded or None)
        except Exception:
            pass

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = _headers(scope)
        # Serve adds X-Forwarded-For even for tagged nodes without identity
        # headers. If someone retargets it to the local board port after boot,
        # such traffic still enters the gate. An ordinary local caller may
        # supply the header too; that only narrows its access.
        proxied = b"x-forwarded-for" in headers or b"tailscale-headers-info" in headers
        if scope.get("server", (None, None))[1] != self.bridge_port and not proxied:
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        method = scope.get("method", "")
        token = _cookie(headers)

        if path in LOCAL_ONLY:
            await _reply(scope, receive, send, 404, {"error": "not found"})
            return

        if method == "GET" and path == "/m-manifest.json":
            # The local route names the board from private state. Installation
            # needs only the fixed app name and icons before sign-in.
            await _reply(scope, receive, send, 200, (HERE / "m-manifest.json").read_bytes(),
                         "application/manifest+json")
            return
        if method == "GET" and path in PUBLIC_GET:
            await self.app(scope, receive, send)
            return
        if path == "/auth/check" and method == "GET":
            await _reply(scope, receive, send, 200, {"authenticated": bridge_auth.has_session(token),
                                                  "configured": bridge_auth.configured()})
            return
        if path == "/auth/login" and method == "POST":
            if not _same_origin(headers):
                await _reply(scope, receive, send, 403, {"error": "origin refused"})
                return
            raw = await _body(receive)
            try:
                value = json.loads(raw).get("password") if raw is not None else None
            except (ValueError, AttributeError, TypeError):
                value = None
            verdict, issued = bridge_auth.login(value)
            if verdict == "ok":
                await _reply(scope, receive, send, 200, {"ok": True}, extra=(
                    (b"set-cookie", bridge_auth.session_cookie(issued).encode()),))
            elif verdict == "limited":
                await _reply(scope, receive, send, 429, {"error": "Too many attempts. Try again in a minute."},
                             extra=((b"retry-after", b"60"),))
            elif verdict == "unconfigured":
                await _reply(scope, receive, send, 503, {"error": "Set a bridge password on the Mac first."})
            else:
                await _reply(scope, receive, send, 401, {"error": "That password did not match."})
            return
        if path == "/auth/logout" and method == "POST":
            if not _same_origin(headers):
                await _reply(scope, receive, send, 403, {"error": "origin refused"})
                return
            bridge_auth.logout(token)
            await _reply(scope, receive, send, 200, {"ok": True}, extra=(
                (b"set-cookie", bridge_auth.clear_cookie().encode()),))
            return

        known = bridge_auth.has_session(token)
        if not known:
            self._note_refusal(scope, headers, method, path, known)
            if method == "GET" and path in ("/m", "/"):
                await _reply(scope, receive, send, 200, GATE_HTML,
                             "text/html; charset=utf-8")
            else:
                await _reply(scope, receive, send, 401, {"error": "sign in required"})
            return
        if method not in ("GET", "HEAD") and not _same_origin(headers):
            await _reply(scope, receive, send, 403, {"error": "origin refused"})
            return
        if (method in ("GET", "HEAD") and path not in PAGE_OPENS
                and _fetch_word(headers, b"sec-fetch-site") == "cross-site"):
            self._note_refusal(scope, headers, method, path, known, "cross-site-get")
            await _reply(scope, receive, send, 403, {"error": "origin refused"})
            return
        if method == "GET" and path == "/m":
            send = _renewing(send, token)
        reset = bridge_auth.CURRENT_SESSION.set(token)
        try:
            await self.app(scope, receive, send)
        finally:
            bridge_auth.CURRENT_SESSION.reset(reset)
