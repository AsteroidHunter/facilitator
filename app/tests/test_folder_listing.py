"""The folder picker's server side, against a home folder made up in a
temporary folder, so nothing here lists the real home.

What is proved:

  machines  this machine alone, named by its system, with home and the
            Desktop, Documents and Downloads it has, and the XDG names where
            Linux keeps them; an unknown machine is refused.
  listing   one folder's own subfolders, sorted with numbers read as numbers,
            with their dates and counts; the trail from home down; home as ~.
  fence     nothing outside home, by .., by an absolute path or by a link,
            and a link out of home is not listed; a home reached through a
            link is fenced the same.
  hidden    dot folders and folders with the system's hidden flag stay out,
            and a typed path through one is refused.
  typed     ~, a path relative to the folder on show, an absolute path; a
            missing folder and a file are refused in plain words that never
            hold the path.
  unread    a folder the board may not read answers unreadable, not an error;
            on macOS Desktop, Documents and Downloads are not read from home
            until the board has listed each one itself.
  mkdir     a new folder is made after its name is checked: empty, slash,
            leading dot, control and reserved characters, length, a clash;
            only inside home.
  routes    /machines, /dirs and /mkdir are routes and /pickdir is gone.

    python3 -B -m unittest tests/test_folder_listing.py

server.py is found by walking up from this file, or by FACILITATOR_SERVER
pointing straight at it.
"""

import atexit
import importlib.util
import os
import shutil
import stat
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


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
    # the module's log goes to a folder of its own, removed when the run ends
    logs = tempfile.mkdtemp(prefix="facil-folderlog-")
    atexit.register(shutil.rmtree, logs, True)
    os.environ.setdefault("FACILITATOR_LOG_DIR", logs)
    spec = importlib.util.spec_from_file_location("facilitator_server_folders", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SERVER = _load()


def Q(**kw):
    q = SERVER.Query({k: [v] for k, v in kw.items() if v != ""})
    q.path = ""
    return q


class FolderBase(unittest.TestCase):
    def setUp(self):
        self.outer = Path(tempfile.mkdtemp(prefix="facil-folders-")).resolve()
        self.home = self.outer / "robin"
        for rel in ["Desktop/drafts", "Documents/letters", "Downloads", "notes/daily", "notes/ideas",
                    "projects/website/assets", "projects/garden-planner", "run-9", "run-10", "Run-2",
                    ".secret/inner"]:
            (self.home / rel).mkdir(parents=True, exist_ok=True)
        (self.home / "notes" / "todo.txt").write_text("x")
        (self.home / "notes" / ".hidden-file").write_text("x")
        (self.outer / "elsewhere").mkdir()
        self._home = os.environ.get("HOME")
        os.environ["HOME"] = str(self.home)
        SERVER._folders_read.clear()

    def tearDown(self):
        if self._home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._home
        for root, dirs, _files in os.walk(self.outer):
            for d in dirs:
                try:
                    os.chmod(os.path.join(root, d), 0o755)
                except OSError:
                    pass
        shutil.rmtree(self.outer, ignore_errors=True)

    def dirs(self, **kw):
        return SERVER._get_dirs(Q(**kw), None)

    def names(self, **kw):
        status, answer = self.dirs(**kw)
        self.assertEqual(status, 200, answer)
        return [d["name"] for d in answer["dirs"]]


class Machines(FolderBase):
    def test_this_machine_alone_with_its_places(self):
        status, answer = SERVER._get_machines(Q(), None)
        self.assertEqual(status, 200)
        [m] = answer["machines"]
        self.assertEqual(m["id"], "this")
        self.assertEqual(m["name"], {"darwin": "This Mac", "win32": "This PC"}.get(sys.platform, "This computer"))
        self.assertTrue(m["online"])
        self.assertEqual(m["top"], str(self.home))
        self.assertEqual(m["sep"], os.sep)
        self.assertEqual([(p["id"], p["name"]) for p in m["places"]],
                         [("home", "robin"), ("desktop", "Desktop"), ("documents", "Documents"), ("downloads", "Downloads")])
        self.assertEqual(m["places"][1]["path"], str(self.home / "Desktop"))

    def test_a_place_that_is_missing_is_left_out(self):
        (self.home / "Downloads").rmdir()
        [m] = SERVER._get_machines(Q(), None)[1]["machines"]
        self.assertEqual([p["id"] for p in m["places"]], ["home", "desktop", "documents"])

    def test_the_xdg_names_are_used_where_linux_keeps_them(self):
        (self.home / "Schreibtisch").mkdir()
        (self.home / ".config").mkdir()
        (self.home / ".config" / "user-dirs.dirs").write_text(
            '# written by xdg-user-dirs-update\nXDG_DESKTOP_DIR="$HOME/Schreibtisch"\n'
            'XDG_DOWNLOAD_DIR="/elsewhere/Downloads"\nXDG_MUSIC_DIR="$HOME/Musik"\n')
        [m] = SERVER._get_machines(Q(), None)[1]["machines"]
        places = {p["id"]: p["name"] for p in m["places"]}
        self.assertEqual(places["desktop"], "Schreibtisch")
        self.assertEqual(places["downloads"], "Downloads", "a folder outside home is not taken")

    def test_an_unknown_machine_is_refused(self):
        self.assertEqual(self.dirs(machine="kestrel"), (400, {"error": "no such machine"}))
        self.assertEqual(SERVER._post_mkdir(Q(machine="kestrel", path=str(self.home), name="x"), "")[0], 400)
        self.assertEqual(self.dirs(machine="this")[0], 200)


class Listing(FolderBase):
    def test_home_lists_its_own_subfolders_sorted_with_numbers_as_numbers(self):
        self.assertEqual(self.names(), ["Desktop", "Documents", "Downloads", "notes", "projects",
                                        "Run-2", "run-9", "run-10"])

    def test_the_answer_names_the_folder_its_trail_and_its_rows(self):
        status, answer = self.dirs(path=str(self.home / "notes"))
        self.assertEqual(status, 200)
        self.assertEqual(answer["path"], str(self.home / "notes"))
        self.assertEqual(answer["name"], "notes")
        self.assertEqual(answer["short"], "~" + os.sep + "notes")
        self.assertEqual(answer["parent"], str(self.home))
        self.assertEqual(answer["top"], str(self.home))
        self.assertEqual(answer["trail"], [{"name": "robin", "path": str(self.home)},
                                           {"name": "notes", "path": str(self.home / "notes")}])
        daily = answer["dirs"][0]
        self.assertEqual(set(daily), {"name", "path", "modified", "items"})
        self.assertEqual(daily["path"], str(self.home / "notes" / "daily"))
        self.assertLessEqual(abs(daily["modified"] - time.time()), 120)
        self.assertEqual(daily["items"], 0)
        status, home = self.dirs()
        self.assertEqual((home["short"], home["parent"]), ("~", None))

    def test_items_count_names_without_a_dot_and_stop_past_the_cap(self):
        with mock.patch.object(SERVER, "FOLDER_COUNT_MAX", 2):
            status, answer = self.dirs()
        counted = {d["name"]: (d["items"], d.get("itemsCut", False)) for d in answer["dirs"]}
        self.assertEqual(counted["notes"], (2, True), "daily, ideas, todo.txt is three, past a cap of two")
        self.assertEqual(counted["projects"], (2, False))
        status, answer = self.dirs()
        self.assertEqual({d["name"]: d["items"] for d in answer["dirs"]}["notes"], 3, "the dot file is not counted")

    def test_counts_stop_when_their_time_is_spent(self):
        with mock.patch.object(SERVER, "FOLDER_COUNT_TIME", -1):
            status, answer = self.dirs()
        self.assertEqual(status, 200)
        self.assertTrue(all(d["items"] is None for d in answer["dirs"]))

    def test_rows_past_the_cap_are_counted_not_listed(self):
        with mock.patch.object(SERVER, "FOLDER_ROWS_MAX", 3):
            status, answer = self.dirs()
        self.assertEqual([d["name"] for d in answer["dirs"]], ["Desktop", "Documents", "Downloads"])
        self.assertEqual(answer["more"], 5)


class Fence(FolderBase):
    def test_nothing_outside_home(self):
        for path in [str(self.outer), str(self.outer / "elsewhere"), str(self.home / ".." / "elsewhere"), "/"]:
            self.assertEqual(self.dirs(path=path), (400, {"error": "outside the home folder"}), path)
        self.assertEqual(self.dirs(path="..", **{"from": str(self.home)}), (400, {"error": "outside the home folder"}))

    def test_the_words_never_hold_the_path(self):
        for path in [str(self.outer / "elsewhere"), str(self.home / "nope"), str(self.home / "notes" / "todo.txt")]:
            status, answer = self.dirs(path=path)
            self.assertEqual(status, 400)
            self.assertNotIn("robin", answer["error"])
            self.assertNotIn(os.sep, answer["error"])

    def test_a_link_out_of_home_is_neither_listed_nor_followed(self):
        os.symlink(self.outer / "elsewhere", self.home / "outside-link")
        os.symlink(self.home / "notes", self.home / "notes-link")
        names = self.names()
        self.assertNotIn("outside-link", names)
        self.assertIn("notes-link", names)
        self.assertEqual(self.dirs(path=str(self.home / "outside-link")), (400, {"error": "outside the home folder"}))
        status, answer = self.dirs(path=str(self.home / "notes-link"))
        self.assertEqual((status, answer["path"]), (200, str(self.home / "notes")))

    def test_a_home_reached_through_a_link_is_fenced_the_same(self):
        os.symlink(self.home, self.outer / "home-link")
        os.environ["HOME"] = str(self.outer / "home-link")
        status, answer = self.dirs(path=str(self.outer / "home-link" / "notes"))
        self.assertEqual(status, 200, answer)
        self.assertEqual(answer["top"], str(self.home))
        self.assertEqual(answer["path"], str(self.home / "notes"))


class Hidden(FolderBase):
    def test_dot_folders_stay_hidden_and_cannot_be_typed(self):
        self.assertNotIn(".secret", self.names())
        self.assertEqual(self.dirs(path=str(self.home / ".secret")), (400, {"error": "that folder is hidden"}))
        self.assertEqual(self.dirs(path="~/.secret/inner"), (400, {"error": "that folder is hidden"}))

    @unittest.skipUnless(hasattr(os, "chflags") and hasattr(stat, "UF_HIDDEN"), "no hidden flag on this system")
    def test_the_systems_hidden_flag_hides_a_folder_too(self):
        (self.home / "Library").mkdir()
        os.chflags(self.home / "Library", stat.UF_HIDDEN)
        self.assertNotIn("Library", self.names())
        self.assertEqual(self.dirs(path="~/Library"), (400, {"error": "that folder is hidden"}))


class Typed(FolderBase):
    def test_home_as_a_tilde(self):
        for path in ["~", "~/", ""]:
            status, answer = self.dirs(path=path)
            self.assertEqual((status, answer["path"]), (200, str(self.home)), path)
        status, answer = self.dirs(path="~/projects/website")
        self.assertEqual(answer["path"], str(self.home / "projects" / "website"))

    def test_a_relative_path_is_taken_from_the_folder_on_show(self):
        status, answer = self.dirs(path="website/assets", **{"from": str(self.home / "projects")})
        self.assertEqual((status, answer["path"]), (200, str(self.home / "projects" / "website" / "assets")))
        status, answer = self.dirs(path="../notes", **{"from": str(self.home / "projects")})
        self.assertEqual(answer["path"], str(self.home / "notes"))
        # a relative starting point is no starting point: home is
        status, answer = self.dirs(path="notes", **{"from": "projects"})
        self.assertEqual(answer["path"], str(self.home / "notes"))

    def test_an_absolute_path(self):
        status, answer = self.dirs(path=str(self.home / "notes" / "ideas"))
        self.assertEqual((status, answer["name"]), (200, "ideas"))

    def test_missing_folders_and_files_are_refused_in_plain_words(self):
        self.assertEqual(self.dirs(path="~/nope"), (400, {"error": "no folder there"}))
        self.assertEqual(self.dirs(path="~/notes/todo.txt"), (400, {"error": "that is a file, not a folder"}))
        self.assertEqual(self.dirs(path="~/no\x00pe")[0], 400)


@unittest.skipIf(os.name == "nt" or (hasattr(os, "geteuid") and os.geteuid() == 0), "a folder cannot be closed to this user")
class Unreadable(FolderBase):
    def test_a_folder_the_board_may_not_read_says_so(self):
        locked = self.home / "projects" / "website"
        os.chmod(locked, 0)
        status, answer = self.dirs(path=str(locked))
        self.assertEqual(status, 200)
        self.assertTrue(answer["unreadable"])
        self.assertEqual(answer["dirs"], [])
        # its parent still lists it, without a count
        status, answer = self.dirs(path=str(self.home / "projects"))
        self.assertEqual({d["name"]: d["items"] for d in answer["dirs"]}["website"], None)

    def test_desktop_documents_and_downloads_are_not_read_from_home_until_opened(self):
        read = []
        real = os.scandir

        def scandir(p):
            read.append(Path(p))
            return real(p)
        guarded = {self.home / "Desktop", self.home / "Documents", self.home / "Downloads"}
        with mock.patch.object(SERVER.sys, "platform", "darwin"), mock.patch.object(SERVER.os, "scandir", scandir):
            status, answer = self.dirs()
            counts = {d["name"]: d["items"] for d in answer["dirs"]}
            self.assertEqual([counts[n] for n in ("Desktop", "Documents", "Downloads")], [None, None, None])
            self.assertEqual(counts["notes"], 3)
            self.assertFalse(guarded & set(read), "home's listing read inside a guarded folder")
            # opened once, the folder is the reader's to count from then on
            self.assertEqual(self.dirs(path="~/Desktop")[0], 200)
            status, answer = self.dirs()
            counts = {d["name"]: d["items"] for d in answer["dirs"]}
            self.assertEqual((counts["Desktop"], counts["Documents"]), (1, None))


class NewFolder(FolderBase):
    def mkdir(self, name, path=None):
        return SERVER._post_mkdir(Q(path=str(path or self.home / "projects"), name=name), "")

    def test_a_good_name_makes_the_folder(self):
        status, answer = self.mkdir("  sound lab ")
        self.assertEqual(status, 200, answer)
        self.assertEqual(answer, {"ok": True, "name": "sound lab", "path": str(self.home / "projects" / "sound lab")})
        self.assertTrue((self.home / "projects" / "sound lab").is_dir())
        self.assertIn("sound lab", self.names(path="~/projects"))

    def test_names_are_checked_first(self):
        cases = {"": "a folder needs a name", "   ": "a folder needs a name",
                 "a/b": "a folder name cannot hold a slash", "a\\b": "a folder name cannot hold a slash",
                 ".hidden": "a folder name cannot start with a dot", "..": "a folder name cannot start with a dot",
                 "tab\there": "a folder name cannot hold a control character",
                 "what?": 'a folder name cannot hold any of < > : " | ? *',
                 "a:b": 'a folder name cannot hold any of < > : " | ? *',
                 "x" * 256: "that name is too long", "é" * 128: "that name is too long"}
        for name, words in cases.items():
            self.assertEqual(self.mkdir(name), (400, {"error": words}), repr(name))
        self.assertEqual(sorted(p.name for p in (self.home / "projects").iterdir()), ["garden-planner", "website"])
        self.assertEqual(self.mkdir("x" * 255)[0], 200)

    def test_a_clash_is_refused(self):
        self.assertEqual(self.mkdir("website"), (400, {"error": "a folder by that name is already here"}))
        (self.home / "projects" / "notes.txt").write_text("x")
        self.assertEqual(self.mkdir("notes.txt"), (400, {"error": "a folder by that name is already here"}))

    def test_only_inside_home(self):
        self.assertEqual(self.mkdir("x", self.outer / "elsewhere"), (400, {"error": "outside the home folder"}))
        self.assertEqual(self.mkdir("x", self.home / ".secret"), (400, {"error": "that folder is hidden"}))
        self.assertEqual(self.mkdir("x", self.home / "nope"), (400, {"error": "no folder there"}))
        self.assertFalse((self.outer / "elsewhere" / "x").exists())

    def test_windows_names_are_refused_on_windows(self):
        with mock.patch.object(SERVER.sys, "platform", "win32"):
            self.assertEqual(SERVER._folder_name_problem("CON"), "Windows keeps that name for itself")
            self.assertEqual(SERVER._folder_name_problem("lpt1.txt"), "Windows keeps that name for itself")
            self.assertEqual(SERVER._folder_name_problem("trailing."), "Windows keeps that name for itself")
        self.assertIsNone(SERVER._folder_name_problem("con"))


class Project(FolderBase):
    def test_a_project_folder_is_fenced_by_the_same_home(self):
        os.symlink(self.home, self.outer / "home-link")
        os.environ["HOME"] = str(self.outer / "home-link")
        with mock.patch.object(SERVER, "_save", lambda: None), mock.patch.object(SERVER, "_notify", lambda *a, **k: None), \
                mock.patch.object(SERVER, "_register_owner", lambda *a: None), \
                mock.patch.object(SERVER, "_create_box_record", lambda *a, **k: None), \
                mock.patch.object(SERVER, "_log", lambda *a, **k: None):
            state = SERVER._state
            saved = {k: state.get(k) for k in ("projects", "busy", "claimed", "busy_ts", "ack", "workspaces", "pages")}
            try:
                state.setdefault("busy", {}); state.setdefault("claimed", {}); state.setdefault("busy_ts", {})
                status, answer = SERVER._post_project(Q(name="notes"), str(self.home / "notes"))
                self.assertEqual(status, 200, answer)
                self.assertEqual(answer["dir"], str(self.home / "notes"))
                status, answer = SERVER._post_project(Q(name="away"), str(self.outer / "elsewhere"))
                self.assertEqual((status, answer), (400, {"error": "body must be a folder under home"}))
            finally:
                for k, v in saved.items():
                    if v is None:
                        state.pop(k, None)
                    else:
                        state[k] = v


class Routes(unittest.TestCase):
    def test_the_picker_routes_are_there_and_pickdir_is_gone(self):
        paths = {(r.path, tuple(sorted(r.methods or ()))) for r in SERVER.ROUTES if hasattr(r, "path")}
        for path, method in [("/machines", "GET"), ("/dirs", "GET"), ("/mkdir", "POST")]:
            self.assertTrue(any(p == path and method in m for p, m in paths), path)
        self.assertFalse(any(p == "/pickdir" for p, _m in paths))
        self.assertFalse(hasattr(SERVER, "_get_pickdir"))
        source = Path(SERVER.__file__).read_text()
        self.assertNotIn("PICKDIR", source)
        self.assertNotIn("choose folder", source)
        self.assertIn("/machines", SERVER.UNCOUNTED_GETS)


if __name__ == "__main__":
    unittest.main()
