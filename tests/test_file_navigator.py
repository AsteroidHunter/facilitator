"""The server side of the general file navigator, exercised against synthetic
roots so nothing here touches a real board's folders.

What is proved:

  listing   every ordinary name under one directory is shown, dotfiles and
            dotfolders included, folders and files sorted the panel's way, and
            ONLY that one directory is read (one scandir), never the whole tree.
            A missing or empty directory comes back present-and-empty; a
            traversal out of the root comes back empty, never the outside.
  links     a symlink that stays inside the root is followed and classified; a
            symlink that escapes the root is named but marked unavailable and its
            content is never served or opened.
  specials  a fifo (and any non-regular file) is named but never opened.
  text      a real utf-8 text file opens; a file that decodes but carries NUL or
            other control bytes is refused as binary; invalid utf-8 is refused;
            a file over the editor cap is refused before it is read whole.
  save      a text body over a text file writes atomically and keeps the file's
            permission bits; a stale stamp is refused; a non-text body is
            refused; a text body is never allowed to overwrite a binary file; a
            missing target is never created; a path out of the root is refused.
  image     an in-root image is served with a sandbox CSP and nosniff; a
            non-image is refused; an oversize image is refused; a path out of the
            root is refused.

    .venv/bin/python -m unittest tests/test_file_navigator.py

server.py is found by walking up from this file, or by FACILITATOR_SERVER
pointing straight at it.
"""

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


def _find_server():
    named = os.environ.get("FACILITATOR_SERVER")
    if named:
        p = Path(named)
        return p if p.is_file() else None
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "server.py"
        if candidate.is_file():
            return candidate
    return None


def _load():
    path = _find_server()
    if path is None:
        raise AssertionError(
            "server.py was not found above this test. Point FACILITATOR_SERVER at it; "
            "these cases are a gate and are not meant to be skipped.")
    # keep the module's logging off any real board folder
    os.environ.setdefault("FACILITATOR_LOG_DIR", tempfile.mkdtemp(prefix="facil-navlog-"))
    spec = importlib.util.spec_from_file_location("facilitator_server_navigator", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module._save = lambda: module._state.__setitem__("rev", int(module._state.get("rev", 0)) + 1)
    module._notify = lambda *a, **k: None
    return module


SERVER = _load()


def Q(**kw):
    q = SERVER.Query({k: [v] for k, v in kw.items()})
    q.path = ""
    return q


class NavigatorBase(unittest.TestCase):
    LANE = "proj"

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="facil-nav-")
        self.projdir = Path(self.tmp) / "proj"
        self.internal = self.projdir / "proj-internal"
        self.wiki = self.projdir / "proj-wiki"
        self.internal.mkdir(parents=True)
        self.wiki.mkdir(parents=True)
        self.outside = Path(self.tmp) / "outside"
        self.outside.mkdir()
        # point the lane at our synthetic project, and mount the panel on it
        SERVER._lane_pwds = lambda: {self.LANE: str(self.projdir)}
        SERVER.NAV_LANES = (self.LANE,)

    def files(self, **kw):
        kw.setdefault("lane", self.LANE)
        return SERVER._get_navfiles(Q(**kw), None)

    def read(self, root, rel):
        return SERVER._get_navfile(Q(lane=self.LANE, root=root, rel=rel), None)

    def img(self, root, rel):
        return SERVER._get_navimg(Q(lane=self.LANE, root=root, rel=rel), None)

    def save(self, root, rel, body, mtime=""):
        return SERVER._post_navsave(Q(lane=self.LANE, root=root, rel=rel, mtime=mtime), body)


class Listing(NavigatorBase):
    def test_lists_all_ordinary_names_including_dotfiles_and_folders(self):
        (self.internal / "README.md").write_text("# hi")
        (self.internal / "notes.txt").write_text("plain")
        (self.internal / ".secret.env").write_text("KEY=1")
        (self.internal / "guides").mkdir()
        (self.internal / ".hidden").mkdir()
        (self.internal / "photo.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        status, out = self.files(kind="internal", rel="")
        self.assertEqual(status, 200)
        self.assertTrue(out["exists"])
        names = [(e["name"], e["type"]) for e in out["entries"]]
        # folders first (case-insensitive), then files (case-insensitive), with
        # dotnames shown; README sorts last among files because r follows n and p
        self.assertEqual(names, [
            (".hidden", "dir"), ("guides", "dir"),
            (".secret.env", "file"), ("notes.txt", "file"),
            ("photo.png", "file"), ("README.md", "file"),
        ])
        png = next(e for e in out["entries"] if e["name"] == "photo.png")
        self.assertEqual(png["ext"], "png")
        self.assertIn("size", png)
        self.assertIn("mtime", png)
        # both roots are always reported for the tabs
        self.assertEqual({r["kind"] for r in out["roots"]}, {"internal", "wiki"})

    def test_both_roots_reported_with_existence(self):
        status, out = self.files(kind="internal", rel="")
        kinds = {r["kind"]: r for r in out["roots"]}
        self.assertTrue(kinds["internal"]["exists"])
        self.assertTrue(kinds["wiki"]["exists"])
        self.assertEqual(out["root"], "proj-internal")

    def test_empty_and_missing_directories(self):
        # empty root
        status, out = self.files(kind="internal", rel="")
        self.assertTrue(out["exists"])
        self.assertEqual(out["entries"], [])
        # missing subdir
        status, out = self.files(kind="internal", rel="nope")
        self.assertFalse(out["exists"])
        self.assertEqual(out["entries"], [])

    def test_traversal_out_of_root_is_empty_not_the_outside(self):
        (self.outside / "loot.md").write_text("secret")
        status, out = self.files(kind="internal", rel="../../outside")
        self.assertFalse(out["exists"])
        self.assertEqual(out["entries"], [])

    def test_unknown_lane_and_unknown_kind(self):
        status, out = SERVER._get_navfiles(Q(lane="ghost", kind="internal", rel=""), None)
        self.assertEqual(status, 200)
        self.assertEqual(out["roots"], [])
        self.assertEqual(out["entries"], [])
        # a kind that is not one of this lane's folders
        status, out = self.files(kind="banana", rel="")
        self.assertEqual(out["entries"], [])

    def test_only_one_directory_is_read_no_recursion(self):
        # a wide, deep subtree under one folder; listing the root must not read it
        big = self.internal / "archive"
        big.mkdir()
        for i in range(200):
            (big / f"f{i}.bin").write_bytes(b"\x00\x01")
        deep = big / "deep" / "deeper"
        deep.mkdir(parents=True)
        (deep / "buried.md").write_text("x")
        (self.internal / "top.md").write_text("x")

        orig = SERVER.os.scandir
        calls = {"n": 0}

        def counting(path):
            calls["n"] += 1
            return orig(path)

        SERVER.os.scandir = counting
        try:
            status, out = self.files(kind="internal", rel="")
        finally:
            SERVER.os.scandir = orig
        self.assertEqual(calls["n"], 1, "listing a directory must read exactly that one directory")
        names = {e["name"] for e in out["entries"]}
        self.assertEqual(names, {"archive", "top.md"})
        self.assertNotIn("f0.bin", names)
        self.assertNotIn("buried.md", names)


class Links(NavigatorBase):
    def test_symlink_inside_root_is_followed_and_classified(self):
        (self.internal / "real.md").write_text("hello")
        os.symlink(self.internal / "real.md", self.internal / "alias.md")
        (self.internal / "sub").mkdir()
        os.symlink(self.internal / "sub", self.internal / "subalias")
        status, out = self.files(kind="internal", rel="")
        by = {e["name"]: e for e in out["entries"]}
        self.assertEqual(by["alias.md"]["type"], "file")
        self.assertTrue(by["alias.md"]["avail"])
        self.assertEqual(by["subalias"]["type"], "dir")
        # and it opens, since it lands inside the root
        st, d = self.read("proj-internal", "alias.md")
        self.assertEqual(st, 200)
        self.assertEqual(d["text"], "hello")

    def test_symlink_escaping_root_is_named_but_never_served(self):
        (self.outside / "target.md").write_text("secret outside")
        os.symlink(self.outside / "target.md", self.internal / "escape.md")
        status, out = self.files(kind="internal", rel="")
        esc = next(e for e in out["entries"] if e["name"] == "escape.md")
        self.assertFalse(esc["avail"])
        self.assertEqual(esc["type"], "other")
        self.assertEqual(esc["reason"], "link outside the folder")
        # its content is never handed over
        st, d = self.read("proj-internal", "escape.md")
        self.assertEqual(st, 400)
        st2 = self.save("proj-internal", "escape.md", b"pwn", mtime="")
        self.assertEqual(st2[0], 400)

    def test_symlinked_directory_escaping_root_is_unavailable(self):
        (self.outside / "d").mkdir()
        os.symlink(self.outside / "d", self.internal / "outdir")
        status, out = self.files(kind="internal", rel="")
        od = next(e for e in out["entries"] if e["name"] == "outdir")
        self.assertFalse(od["avail"])


class Specials(NavigatorBase):
    def test_fifo_is_named_but_not_opened(self):
        fifo = self.internal / "pipe"
        os.mkfifo(fifo)
        status, out = self.files(kind="internal", rel="")
        p = next(e for e in out["entries"] if e["name"] == "pipe")
        self.assertEqual(p["type"], "other")
        self.assertFalse(p["avail"])
        self.assertEqual(p["reason"], "not a regular file")
        # never opened as text (would otherwise block on a fifo)
        st, d = self.read("proj-internal", "pipe")
        self.assertEqual(st, 404)


class TextReads(NavigatorBase):
    def test_plain_text_opens(self):
        (self.internal / "a.txt").write_text("line one\nline two\n")
        st, d = self.read("proj-internal", "a.txt")
        self.assertEqual(st, 200)
        self.assertEqual(d["text"], "line one\nline two\n")
        self.assertFalse(d["crlf"])
        self.assertIn("mtime", d)

    def test_crlf_is_reported(self):
        (self.internal / "win.md").write_bytes(b"a\r\nb\r\n")
        st, d = self.read("proj-internal", "win.md")
        self.assertEqual(st, 200)
        self.assertTrue(d["crlf"])

    def test_nul_byte_binary_is_refused_even_though_it_decodes(self):
        (self.internal / "b.dat").write_bytes(b"ABC\x00DEF")
        st, d = self.read("proj-internal", "b.dat")
        self.assertEqual(st, 415)

    def test_control_byte_binary_is_refused(self):
        # valid utf-8, ascii range, but full of C0 control bytes: still binary
        (self.internal / "c.bin").write_bytes(b"\x01\x02\x03\x04\x05\x06")
        st, d = self.read("proj-internal", "c.bin")
        self.assertEqual(st, 415)

    def test_invalid_utf8_is_refused(self):
        (self.internal / "d.bin").write_bytes(b"\xff\xfe\xfa")
        st, d = self.read("proj-internal", "d.bin")
        self.assertEqual(st, 415)

    def test_tab_newline_ff_cr_are_allowed_text(self):
        (self.internal / "ok.txt").write_bytes(b"a\tb\nc\x0cd\r\n")
        st, d = self.read("proj-internal", "ok.txt")
        self.assertEqual(st, 200)

    def test_file_over_cap_is_refused_before_full_read(self):
        old = SERVER.MAX_TEXT_BODY
        SERVER.MAX_TEXT_BODY = 8
        try:
            (self.internal / "big.txt").write_text("way more than eight bytes")
            st, d = self.read("proj-internal", "big.txt")
            self.assertEqual(st, 413)
        finally:
            SERVER.MAX_TEXT_BODY = old

    def test_traversal_read_is_refused(self):
        (self.outside / "p.md").write_text("x")
        st, d = self.read("proj-internal", "../../outside/p.md")
        self.assertEqual(st, 400)

    def test_directory_is_not_a_file(self):
        (self.internal / "sub").mkdir()
        st, d = self.read("proj-internal", "sub")
        self.assertEqual(st, 404)


class Saves(NavigatorBase):
    def test_save_text_over_text_keeps_permissions(self):
        p = self.internal / "note.md"
        p.write_text("old")
        os.chmod(p, 0o640)
        st0, d0 = self.read("proj-internal", "note.md")
        stamp = d0["mtime"]
        status, res = self.save("proj-internal", "note.md", b"new body\n", mtime=stamp)
        self.assertEqual(status, 200)
        self.assertTrue(res["ok"])
        self.assertEqual(p.read_text(), "new body\n")
        self.assertEqual(oct(p.stat().st_mode & 0o777), oct(0o640))
        self.assertNotEqual(res["mtime"], stamp)

    def test_stale_stamp_is_refused(self):
        p = self.internal / "note.md"
        p.write_text("old")
        status, res = self.save("proj-internal", "note.md", b"new", mtime="1")
        self.assertEqual(status, 409)
        self.assertIn("mtime", res)
        self.assertEqual(p.read_text(), "old")

    def test_non_text_body_is_refused(self):
        p = self.internal / "note.md"
        p.write_text("old")
        status, res = self.save("proj-internal", "note.md", b"has\x00nul", mtime="")
        self.assertEqual(status, 415)
        self.assertEqual(p.read_text(), "old")

    def test_text_body_never_overwrites_a_binary_file(self):
        p = self.internal / "image.png"
        p.write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00binary")
        status, res = self.save("proj-internal", "image.png", b"plain text", mtime="")
        self.assertEqual(status, 415)
        self.assertEqual(p.read_bytes(), b"\x89PNG\r\n\x1a\n\x00\x00binary")

    def test_missing_target_is_not_created(self):
        status, res = self.save("proj-internal", "ghost.md", b"hello", mtime="")
        self.assertEqual(status, 404)
        self.assertFalse((self.internal / "ghost.md").exists())

    def test_traversal_save_is_refused(self):
        (self.outside / "t.md").write_text("safe")
        status, res = self.save("proj-internal", "../../outside/t.md", b"pwned", mtime="")
        self.assertEqual(status, 400)
        self.assertEqual((self.outside / "t.md").read_text(), "safe")

    def test_round_trip_save_then_read(self):
        p = self.internal / "r.md"
        p.write_text("start")
        st0, d0 = self.read("proj-internal", "r.md")
        st1, r1 = self.save("proj-internal", "r.md", b"second\n", mtime=d0["mtime"])
        self.assertEqual(st1, 200)
        st2, d2 = self.read("proj-internal", "r.md")
        self.assertEqual(d2["text"], "second\n")
        self.assertEqual(d2["mtime"], r1["mtime"])


class Images(NavigatorBase):
    PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32

    def test_image_served_sandboxed(self):
        (self.internal / "p.png").write_bytes(self.PNG)
        res = self.img("proj-internal", "p.png")
        self.assertFalse(isinstance(res, tuple), "a served image should be a Response, not an error tuple")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.media_type, "image/png")
        self.assertEqual(res.headers["content-security-policy"], "sandbox")
        self.assertEqual(res.headers["x-content-type-options"], "nosniff")
        self.assertEqual(res.body, self.PNG)

    def test_svg_served_sandboxed_not_as_markup(self):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        (self.internal / "x.svg").write_bytes(svg)
        res = self.img("proj-internal", "x.svg")
        self.assertFalse(isinstance(res, tuple))
        self.assertEqual(res.media_type, "image/svg+xml")
        # the sandbox CSP is what makes serving an svg safe: it never runs in-origin
        self.assertEqual(res.headers["content-security-policy"], "sandbox")

    def test_non_image_is_refused(self):
        (self.internal / "note.txt").write_text("hi")
        res = self.img("proj-internal", "note.txt")
        self.assertTrue(isinstance(res, tuple))
        self.assertEqual(res[0], 415)

    def test_oversize_image_is_refused(self):
        old = SERVER.MAX_IMG_PREVIEW
        SERVER.MAX_IMG_PREVIEW = 4
        try:
            (self.internal / "big.png").write_bytes(self.PNG)
            res = self.img("proj-internal", "big.png")
            self.assertTrue(isinstance(res, tuple))
            self.assertEqual(res[0], 413)
        finally:
            SERVER.MAX_IMG_PREVIEW = old

    def test_traversal_image_is_refused(self):
        (self.outside / "o.png").write_bytes(self.PNG)
        res = self.img("proj-internal", "../../outside/o.png")
        self.assertTrue(isinstance(res, tuple))
        self.assertEqual(res[0], 400)

    def test_escaping_symlink_image_is_refused(self):
        (self.outside / "o.png").write_bytes(self.PNG)
        os.symlink(self.outside / "o.png", self.internal / "link.png")
        res = self.img("proj-internal", "link.png")
        self.assertTrue(isinstance(res, tuple))
        self.assertEqual(res[0], 400)


class TempWriteSafety(NavigatorBase):
    """The save's temp file must never destroy a real neighbour or follow a
    planted symlink out of the root. These drive the REAL _post_navsave handler."""

    def test_real_neighbour_named_target_tmp_survives(self):
        target = self.internal / "notes.txt"
        neighbour = self.internal / "notes.txt.tmp"
        target.write_text("the note being edited\n")
        neighbour.write_bytes(b"IMPORTANT UNRELATED DATA the user also keeps\n")
        st, d = self.read("proj-internal", "notes.txt")
        status, res = self.save("proj-internal", "notes.txt", b"edited body\n", mtime=d["mtime"])
        self.assertEqual(status, 200)
        self.assertEqual(target.read_text(), "edited body\n")
        self.assertTrue(neighbour.exists(), "the real <name>.tmp neighbour must survive")
        self.assertEqual(neighbour.read_bytes(), b"IMPORTANT UNRELATED DATA the user also keeps\n")

    def test_planted_tmp_symlink_cannot_escape_the_root(self):
        secret = self.outside / "secret.conf"
        secret.write_bytes(b"ORIGINAL SECRET OUTSIDE THE ROOT\n")
        target = self.internal / "notes.txt"
        target.write_text("a note inside the root\n")
        os.symlink(secret, self.internal / "notes.txt.tmp")   # attacker-planted temp name
        st, d = self.read("proj-internal", "notes.txt")
        status, res = self.save("proj-internal", "notes.txt", b"new in-root body\n", mtime=d["mtime"])
        self.assertEqual(status, 200)
        # the write went to the real target, never through the planted link
        self.assertEqual(target.read_text(), "new in-root body\n")
        self.assertFalse(target.is_symlink(), "the target must stay a regular file")
        self.assertEqual(secret.read_bytes(), b"ORIGINAL SECRET OUTSIDE THE ROOT\n",
                         "nothing outside the root may be written or chmod'd")

    def test_planted_tmp_symlink_mode_not_stamped_outside(self):
        secret = self.outside / "secret.conf"
        secret.write_bytes(b"x\n")
        os.chmod(secret, 0o600)
        target = self.internal / "note.md"
        target.write_text("hi")
        os.chmod(target, 0o644)
        os.symlink(secret, self.internal / "note.md.tmp")
        st, d = self.read("proj-internal", "note.md")
        self.save("proj-internal", "note.md", b"body\n", mtime=d["mtime"])
        self.assertEqual(oct(secret.stat().st_mode & 0o777), oct(0o600),
                         "the outside file's mode must be untouched")


class CappedReader(NavigatorBase):
    def test_read_capped_is_bounded_to_cap_plus_one(self):
        p = self.internal / "grow.dat"
        p.write_bytes(b"x" * 100)
        data = SERVER._read_capped(p, 10)
        self.assertEqual(len(data), 11, "a bounded read returns at most cap+1 bytes")

    def test_read_capped_rejects_fifo_promptly(self):
        import time
        fifo = self.internal / "pipe2"
        os.mkfifo(fifo)
        t = time.time()
        self.assertIsNone(SERVER._read_capped(fifo, 10))
        self.assertLess(time.time() - t, 2.0, "a fifo must be rejected without blocking")

    def test_read_capped_reads_a_regular_file(self):
        p = self.internal / "ok.txt"
        p.write_bytes(b"hello")
        self.assertEqual(SERVER._read_capped(p, 100), b"hello")

    def test_read_capped_missing_returns_none(self):
        self.assertIsNone(SERVER._read_capped(self.internal / "nope", 100))


class BinaryTypes(NavigatorBase):
    # a minimal PDF is entirely printable ASCII, so _looks_text alone is not
    # enough; the extension deny-list is what keeps it out of the text editor.
    PDF = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"

    def test_ascii_pdf_decodes_as_text_but_is_not_editable(self):
        self.assertTrue(SERVER._looks_text(self.PDF), "a minimal PDF is ASCII and does decode")
        (self.internal / "doc.pdf").write_bytes(self.PDF)
        st, d = self.read("proj-internal", "doc.pdf")
        self.assertEqual(st, 415)

    def test_ascii_pdf_cannot_be_overwritten_as_text(self):
        p = self.internal / "doc.pdf"
        p.write_bytes(self.PDF)
        st, res = self.save("proj-internal", "doc.pdf", b"hijacked text", mtime="")
        self.assertEqual(st, 415)
        self.assertEqual(p.read_bytes(), self.PDF)

    def test_binary_type_is_still_listed_and_visible(self):
        (self.internal / "archive.zip").write_bytes(b"PK\x03\x04rest")
        (self.internal / "doc.pdf").write_bytes(self.PDF)
        _, out = self.files(kind="internal", rel="")
        names = {e["name"] for e in out["entries"]}
        self.assertIn("archive.zip", names)
        self.assertIn("doc.pdf", names)

    def test_svg_is_editable_text_not_denied_by_extension(self):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>\n'
        (self.internal / "pic.svg").write_bytes(svg)
        st, d = self.read("proj-internal", "pic.svg")
        self.assertEqual(st, 200, "svg is text and remains editable")

    def test_text_alias_to_ascii_pdf_cannot_be_read_as_text(self):
        # a text-looking alias name pointing at a recognized binary target must not
        # slip the deny-list: the resolved target's extension is checked too
        (self.internal / "doc.pdf").write_bytes(self.PDF)
        os.symlink(self.internal / "doc.pdf", self.internal / "notes.txt")
        st, d = self.read("proj-internal", "notes.txt")
        self.assertEqual(st, 415)

    def test_text_alias_to_ascii_pdf_cannot_be_overwritten(self):
        p = self.internal / "doc.pdf"
        p.write_bytes(self.PDF)
        os.symlink(p, self.internal / "notes.txt")
        st, res = self.save("proj-internal", "notes.txt", b"hijack via alias", mtime="")
        self.assertEqual(st, 415)
        self.assertEqual(p.read_bytes(), self.PDF, "the PDF target's bytes must be untouched")

    def test_text_alias_to_text_target_still_opens(self):
        # the fix must not break an allowed in-root text alias
        (self.internal / "real.txt").write_text("plain body\n")
        os.symlink(self.internal / "real.txt", self.internal / "shortcut.md")
        st, d = self.read("proj-internal", "shortcut.md")
        self.assertEqual(st, 200)
        self.assertEqual(d["text"], "plain body\n")


class PathRule(NavigatorBase):
    # the chosen contract: a path is refused only when it resolves OUTSIDE the
    # root. A .. that still lands inside names that same in-root location.
    def test_dotdot_that_stays_inside_is_served(self):
        (self.internal / "guides").mkdir()
        (self.internal / "README.md").write_text("# hi")
        st, d = self.read("proj-internal", "guides/../README.md")
        self.assertEqual(st, 200)
        self.assertEqual(d["text"], "# hi")

    def test_listing_dotdot_that_stays_inside_resolves_to_that_folder(self):
        (self.internal / "guides").mkdir()
        (self.internal / "guides" / "intro.md").write_text("x")
        st, out = self.files(kind="internal", rel="guides/..")
        self.assertTrue(out["exists"])
        self.assertIn("guides", {e["name"] for e in out["entries"]})

    def test_dotdot_that_escapes_is_refused(self):
        (self.outside / "p.md").write_text("secret")
        st, d = self.read("proj-internal", "guides/../../../outside/p.md")
        self.assertEqual(st, 400)


if __name__ == "__main__":
    unittest.main()
