"""The magic box's checks on the web, exercised with made-up name lookups and
made-up connections, so nothing here reaches the network.

What is proved:

  address   only https; no name or password in it; this computer, the home
            network, the tailnet and every other address that is not global
            are refused, whether written as a name, a number, or an IPv4
            address inside an IPv6 one; a name that resolves to even one such
            address is refused; a public name passes with its addresses.
  pinning   the connection goes to the checked address, with the name kept
            for the certificate, and is never looked up again.
  redirects followed by hand, each hop checked again: a hop to the home
            network or to http is refused, and the sixth hop is refused.
  framing   the browsers' rule, on the header sets seen from real sites on
            2026-10-07 and on the edges of the rule.
  preview   title and description from a page's own and Open Graph tags, as
            plain capped text.
  picture   a web picture is kept whole or refused; a page is not a picture.

    python3 -m unittest tests/test_magic_box.py

server.py is found by walking up from this file, or by FACILITATOR_SERVER
pointing straight at it.
"""

import http.client
import importlib.util
import io
import os
import socket
import tempfile
import types
import unittest
from pathlib import Path


def _find_server():
    named = os.environ.get("FACILITATOR_SERVER")
    if named:
        return Path(named)
    for parent in Path(__file__).resolve().parents:
        if (parent / "server.py").is_file():
            return parent / "server.py"
    raise AssertionError("server.py was not found above this test")


def _load():
    os.environ.setdefault("FACILITATOR_LOG_DIR", tempfile.mkdtemp(prefix="facil-magiclog-"))
    spec = importlib.util.spec_from_file_location("facilitator_server_magic", _find_server())
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SERVER = _load()


def lookup(table):
    """A name lookup that answers from a table and never asks DNS."""
    def resolve(host, port, type=0):
        if host not in table:
            raise socket.gaierror("no such name")
        return [(socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))
                for ip in table[host]]
    return resolve


def headers(text):
    return http.client.parse_headers(io.BytesIO(text.encode("latin-1") + b"\r\n"))


class Site:
    """Made-up answers by address: (status, header text, body)."""

    def __init__(self, answers):
        self.answers, self.asked = answers, []

    def connect(self, host, ip, port, timeout):
        site = self

        class Conn:
            def request(self, method, path, headers=None):
                self.url = f"https://{host}{'' if port == 443 else ':' + str(port)}{path}"
                site.asked.append((self.url, ip))

            def getresponse(self):
                status, head, body = site.answers[self.url]
                parsed, stream = headers(head), io.BytesIO(body)
                return types.SimpleNamespace(status=status, headers=parsed, read=stream.read,
                                             getheader=lambda name, default=None: parsed.get(name, default))

            def close(self):
                pass

        return Conn()


PUBLIC = {"example.org": ["93.184.215.14"], "en.m.wikipedia.org": ["185.15.59.224", "2a02:ec80:300:ed1a::1"],
          "upload.example.org": ["93.184.215.20"]}


class Address(unittest.TestCase):
    def refused(self, text, table=None, status=400):
        with self.assertRaises(SERVER._MagicRefused) as caught:
            SERVER._magic_address(text, lookup(table or {}))
        self.assertEqual(caught.exception.status, status, text)

    def test_only_https_without_credentials(self):
        for text in ["http://example.org/", "ftp://example.org/", "javascript:alert(1)", "//example.org",
                     "https://", "https://user:pw@example.org/", "https://user@example.org/",
                     "https://example.org/a b", "https://example.org/\\x", "https://example.org:99999/", ""]:
            self.refused(text, PUBLIC)

    def test_this_computer_and_the_home_network_are_refused(self):
        for text in ["https://localhost/", "https://printer.local/", "https://nas.home.arpa/", "https://box.lan/",
                     "https://mac.tail1234.ts.net/", "https://intranet/", "https://app.localhost/",
                     "https://127.0.0.1/", "https://10.0.0.2/", "https://172.16.4.4/", "https://192.168.1.1/",
                     "https://169.254.169.254/", "https://100.101.102.103/", "https://0.0.0.0/",
                     "https://[::1]/", "https://[fc00::1]/", "https://[fe80::1]/", "https://[::ffff:192.168.1.1]/",
                     "https://[2002:c0a8:101::1]/", "https://224.0.0.1/", "https://192.0.2.1/"]:
            self.refused(text, PUBLIC)

    def test_a_public_name_that_also_resolves_home_is_refused(self):
        self.refused("https://rebind.example/", {"rebind.example": ["93.184.215.14", "192.168.1.10"]})
        self.refused("https://inside.example/", {"inside.example": ["10.1.2.3"]})
        self.refused("https://missing.example/", {}, status=502)

    def test_a_public_name_passes_with_its_addresses(self):
        text, host, port, ips = SERVER._magic_address("https://en.m.wikipedia.org/wiki/Mars", lookup(PUBLIC))
        self.assertEqual((text, host, port), ("https://en.m.wikipedia.org/wiki/Mars", "en.m.wikipedia.org", 443))
        self.assertEqual(ips, PUBLIC["en.m.wikipedia.org"])
        self.assertEqual(SERVER._magic_address("https://93.184.215.14:8443/x", lookup({}))[3], ["93.184.215.14"])


class Pinning(unittest.TestCase):
    def test_the_connection_goes_to_the_checked_address_with_the_name_for_tls(self):
        made = {}

        class Wrapped:
            pass

        class Context:
            def wrap_socket(self, sock, server_hostname=None):
                made["sni"] = server_hostname
                return Wrapped()

        real = SERVER.socket.create_connection
        SERVER.socket.create_connection = lambda address, timeout=None: made.setdefault("to", address) and object()
        try:
            conn = SERVER._PinnedHTTPS("example.org", "93.184.215.14", 443, 5)
            conn._context = Context()
            conn.connect()
        finally:
            SERVER.socket.create_connection = real
        self.assertEqual(made["to"], ("93.184.215.14", 443))
        self.assertEqual(made["sni"], "example.org")
        self.assertTrue(SERVER._PinnedHTTPS("example.org", "93.184.215.14", 443, 5)._context.check_hostname)


class Redirects(unittest.TestCase):
    def fetch(self, answers, start, table=PUBLIC, limit=1024):
        site = Site(answers)
        return SERVER._magic_fetch(start, limit, resolve=lookup(table), connect=site.connect), site

    def test_redirects_are_followed_and_each_hop_checked(self):
        answers = {"https://example.org/a": (302, "Location: /b", b""),
                   "https://example.org/b": (301, "Location: https://en.m.wikipedia.org/wiki/Mars", b""),
                   "https://en.m.wikipedia.org/wiki/Mars": (200, "Content-Type: text/html", b"<title>Mars</title>")}
        (url, host, status, _h, body, whole), site = self.fetch(answers, "https://example.org/a")
        self.assertEqual((url, host, status, body, whole),
                         ("https://en.m.wikipedia.org/wiki/Mars", "en.m.wikipedia.org", 200, b"<title>Mars</title>", True))
        self.assertEqual([ip for _url, ip in site.asked], ["93.184.215.14", "93.184.215.14", "185.15.59.224"])

    def test_a_hop_home_or_to_http_is_refused(self):
        for where in ["https://192.168.1.1/admin", "http://example.org/", "https://router.local/"]:
            with self.assertRaises(SERVER._MagicRefused) as caught:
                self.fetch({"https://example.org/a": (302, f"Location: {where}", b"")}, "https://example.org/a")
            self.assertEqual(caught.exception.status, 400, where)

    def test_the_sixth_redirect_is_refused(self):
        answers = {f"https://example.org/{n}": (302, f"Location: /{n + 1}", b"") for n in range(7)}
        with self.assertRaises(SERVER._MagicRefused) as caught:
            self.fetch(answers, "https://example.org/0")
        self.assertIn("redirected more than 5", caught.exception.words)
        answers[f"https://example.org/5"] = (200, "Content-Type: text/html", b"ok")
        self.assertEqual(self.fetch(answers, "https://example.org/0")[0][4], b"ok")

    def test_a_body_is_cut_at_the_limit_and_says_so(self):
        answers = {"https://example.org/big": (200, "Content-Type: image/png", b"x" * 2000)}
        (_u, _h, _s, _hd, body, whole), _site = self.fetch(answers, "https://example.org/big", limit=1000)
        self.assertEqual((len(body), whole), (1000, False))

    def test_a_site_that_cannot_be_reached_is_a_502(self):
        def fail(*args):
            raise ConnectionRefusedError()
        with self.assertRaises(SERVER._MagicRefused) as caught:
            SERVER._magic_fetch("https://example.org/", 10, resolve=lookup(PUBLIC), connect=fail)
        self.assertEqual(caught.exception.status, 502)


class Framing(unittest.TestCase):
    def check(self, text):
        return SERVER._magic_frameable(headers(text))

    def test_header_sets_seen_on_real_sites(self):
        self.assertEqual(self.check("Content-Type: text/html"), (True, ""))                       # Wikipedia
        self.assertEqual(self.check("X-Frame-Options: SAMEORIGIN"), (False, "X-Frame-Options SAMEORIGIN"))  # Google
        self.assertEqual(self.check("X-Frame-Options: deny\r\nContent-Security-Policy: frame-ancestors 'none'"),
                         (False, "Content-Security-Policy frame-ancestors"))                     # GitHub
        self.assertEqual(self.check("X-Frame-Options: DENY"), (False, "X-Frame-Options DENY"))    # MDN

    def test_frame_ancestors_wins_over_x_frame_options(self):
        self.assertEqual(self.check("X-Frame-Options: DENY\r\nContent-Security-Policy: frame-ancestors *"), (True, ""))
        self.assertEqual(self.check("Content-Security-Policy: default-src 'self'; frame-ancestors http: https:"), (True, ""))
        for sources in ["'self'", "https:", "https://*.example.org", "'none'", ""]:
            self.assertFalse(self.check(f"Content-Security-Policy: frame-ancestors {sources}")[0], sources)
        self.assertFalse(self.check("Content-Security-Policy: frame-ancestors *\r\n"
                                    "Content-Security-Policy: frame-ancestors 'self'")[0])
        self.assertFalse(self.check("Content-Security-Policy: frame-ancestors *, frame-ancestors 'self'")[0])

    def test_what_browsers_ignore_is_ignored(self):
        self.assertTrue(self.check("Content-Security-Policy-Report-Only: frame-ancestors 'none'")[0])
        self.assertTrue(self.check("X-Frame-Options: ALLOW-FROM https://example.org")[0])
        self.assertTrue(self.check("X-Frame-Options: ALLOWALL")[0])
        self.assertTrue(self.check("Content-Security-Policy: default-src 'self'")[0])
        self.assertFalse(self.check("X-Frame-Options: SAMEORIGIN, DENY")[0])


class Preview(unittest.TestCase):
    def test_open_graph_first_then_the_page_own(self):
        page = (b"<html><head><title> Mars - Wikipedia </title>"
                b"<meta property='og:title' content='Mars &amp; moons'>"
                b"<meta name='description' content='The fourth\nplanet.'>"
                b"<meta property='og:site_name' content='Wikipedia'></head><body>x</body></html>")
        found = SERVER._magic_preview(page, headers("Content-Type: text/html; charset=utf-8"), "en.m.wikipedia.org")
        self.assertEqual(found, {"title": "Mars & moons", "description": "The fourth planet.", "site": "Wikipedia"})

    def test_missing_tags_fall_back_and_long_ones_are_cut(self):
        page = b"<title>" + b"t" * 400 + b"</title><script>var a='<title>no</title>'</script>"
        found = SERVER._magic_preview(page, headers("Content-Type: text/html"), "example.org")
        self.assertEqual(len(found["title"]), 200)
        self.assertTrue(found["title"].endswith("…"))
        self.assertEqual((found["description"], found["site"]), ("", "example.org"))

    def test_a_page_in_another_charset(self):
        page = '<meta charset="iso-8859-1"><title>Caf\xe9</title>'.encode("latin-1")
        self.assertEqual(SERVER._magic_preview(page, headers("Content-Type: text/html"), "x.org")["title"], "Café")


class Websites(unittest.TestCase):
    def website(self, head, status=200, body=b"<title>A page</title>"):
        site = Site({"https://example.org/": (status, head, body)})
        return SERVER._magic_website("https://example.org/", resolve=lookup(PUBLIC), connect=site.connect)[0]

    def test_frame_or_preview(self):
        self.assertEqual(self.website("Content-Type: text/html")["shown"], "frame")
        refused = self.website("Content-Type: text/html\r\nX-Frame-Options: SAMEORIGIN")
        self.assertEqual((refused["shown"], refused["reason"]), ("preview", "X-Frame-Options SAMEORIGIN"))
        self.assertEqual(refused["preview"]["title"], "A page")
        self.assertEqual(self.website("Content-Type: text/html", status=403)["reason"], "the site answered 403")
        self.assertEqual(self.website("Content-Type: application/pdf")["reason"], "not a web page")

    def test_a_web_picture_is_whole_or_refused(self):
        png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
        site = Site({"https://upload.example.org/p.png": (200, "Content-Type: image/png", png),
                     "https://upload.example.org/gone.png": (404, "Content-Type: text/html", b"no")})
        fetch = dict(resolve=lookup(PUBLIC), connect=site.connect)
        self.assertEqual(SERVER._magic_web_picture("https://upload.example.org/p.png", **fetch),
                         (png, "upload.example.org"))
        with self.assertRaises(SERVER._MagicRefused) as caught:
            SERVER._magic_web_picture("https://upload.example.org/gone.png", **fetch)
        self.assertEqual(caught.exception.status, 502)
        real = SERVER.MAGIC_IMAGE_MAX
        SERVER.MAGIC_IMAGE_MAX = 10
        try:
            with self.assertRaises(SERVER._MagicRefused) as caught:
                SERVER._magic_web_picture("https://upload.example.org/p.png", **fetch)
            self.assertEqual(caught.exception.status, 413)
        finally:
            SERVER.MAGIC_IMAGE_MAX = real
        self.assertIsNone(SERVER._magic_picture_ext(b"<html>not a picture</html>"))


if __name__ == "__main__":
    unittest.main()
