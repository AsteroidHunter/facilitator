/* The board's own folder picker: what "Open a new folder" opens on the Mac
   board, the typed page and the phone page, in place of the system's folder
   window. The approved mocks are its spec: the panel is mocks A and B in one,
   with a list (Name, Modified, Items) or columns in its well and a switch
   between them, and the drop is mock C, which the phone page opens from its
   project capsule. folder-picker.css is its sheet.

   It reads the board's three folder routes (server.py): /machines for the
   machines and their places, /dirs for one folder, /mkdir to make one. The
   server names every path; this file shows what it is given and never takes a
   path apart, so a Windows path reads as well as a Mac one. Only this machine
   is listed today; another machine is one more entry in /machines and needs
   nothing new here.

   It is fetched the first time a folder is asked for (folderPickerBundle,
   card-logic.js) and never on boot. While it is open every key is its own:
   the page's guard hands each one to FolderPicker.key before anything else
   on the page hears it, so the board's keys wait until it closes. It takes
   the focus when it opens and gives it back to where it was when it closes.

   The state and the moves are one class, Picker, which draws itself as
   markup and asks the server through a function it is handed, so the tests
   can run it with no page. The rest of the file puts one on the page. */
(function installFolderPicker(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && root.document) root.FolderPicker = api;
})(typeof globalThis === "object" ? globalThis : this, function folderPickerFactory(root) {
  "use strict";

  const VIEW_KEY = "folderview";   // the panel's view, a board setting (board-settings.js)
  const SLOW_MS = 150;             // a listing out longer than this says it is on its way
  const SPIN_MS = 110;             // the working spinner's step, the card's own
  const SPIN = "|/-\\";
  const DROP_W = 504, DROP_H = 630, DROP_AIR = 10;   // mock C's size, and the phone list's gap over the capsule
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // ---- marks: the board's own where it has one (the house, the folder, the
  // plus, MAGIC_CROSS in card-logic.js), Lucide outlines otherwise
  const MARKS = {
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/>',
    desktop: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    documents: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    downloads: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
    computer: '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
    server: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>',
    plusfolder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6"/><path d="M9 13h6"/>',
    lock: '<rect width="8" height="5" x="14" y="17" rx="1"/><path d="M10 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v2.5"/><path d="M20 17v-2a2 2 0 1 0-4 0v2"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    chev: '<path d="m6 9 6 6 6-6"/>',
    up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    enter: '<path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
    list: '<path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/>',
    columns: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/>'
  };
  const mark = (k, cls) => '<svg class="fp-i' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + MARKS[k] + "</svg>";
  const CROSS = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.3333" stroke-linecap="round" ' +
    'aria-hidden="true"><path d="M1.936 1.936L8.064 8.064M8.064 1.936L1.936 8.064"></path></svg>';
  const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>';
  const PLACE_MARK = { home: "home", desktop: "desktop", documents: "documents", downloads: "downloads" };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const capital = s => { s = String(s || ""); return s ? s[0].toUpperCase() + s.slice(1) : s; };
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

  // ---- dates and counts, the way the mocks write them --------------------------
  // Today, 09:41 / Yesterday, 18:20 / 16 Oct 2026, and in the drop the first
  // part alone, without this year: Today / Yesterday / 16 Oct
  const dayOf = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  function when(sec, now = Date.now()){
    if (typeof sec !== "number" || !isFinite(sec)) return "";
    const d = new Date(sec * 1000), days = Math.round((dayOf(new Date(now)) - dayOf(d)) / 86400000);
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    if (days === 0) return "Today, " + hm;
    if (days === 1) return "Yesterday, " + hm;
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  }
  function whenShort(sec, now = Date.now()){
    return when(sec, now).split(",")[0].replace(new RegExp(" " + new Date(now).getFullYear() + "$"), "");
  }
  // a count the server stopped reads with a plus; no count reads as nothing
  function count(row){
    if (!row || typeof row.items !== "number") return "";
    return row.items + (row.itemsCut ? "+" : "");
  }
  function itemsText(row){
    const n = count(row);
    return n && n + (row.items === 1 && !row.itemsCut ? " item" : " items");
  }

  // ---- the view the panel shows, kept as the board's setting -------------------
  function storeOf(){
    try { return root.boardSettings || root.localStorage || null; } catch (_) { return null; }
  }
  function readView(store){
    try { return store && store.getItem(VIEW_KEY) === "columns" ? "columns" : "list"; } catch (_) { return "list"; }
  }
  function writeView(store, view){
    try { if (store) store.setItem(VIEW_KEY, view); } catch (_) {}
  }

  async function askBoard(url, init){
    try {
      const r = await root.fetch(url, { cache: "no-store", credentials: "same-origin", ...(init || {}) });
      let json = null;
      try { json = await r.json(); } catch (_) {}
      return { ok: r.ok, status: r.status, json };
    } catch (_) {
      return { ok: false, status: 0, json: null };
    }
  }

  // ---- one picker: its state, its moves and its drawing ------------------------
  class Picker {
    // opts: kind ("panel" or "drop") and choose, which is handed the chosen
    // folder and may answer words to show instead of closing. deps: ask
    // (url, init) -> {ok, status, json}, store and now, for the tests
    constructor(opts = {}, deps = {}){
      this.kind = opts.kind === "drop" ? "drop" : "panel";
      this.chooseFn = typeof opts.choose === "function" ? opts.choose : null;
      this.ask = deps.ask || askBoard;
      this.store = "store" in deps ? deps.store : storeOf();
      this.now = deps.now || (() => Date.now());
      this.view = readView(this.store);
      this.machines = [];
      this.machineId = "this";
      this.place = "home";      // the sidebar's row that is on: a place's id or a machine's
      this.at = null;           // the listing on show, as /dirs answered it
      this.cache = new Map();   // listings by path, for the columns behind the last one
      this.fwd = [];            // the folders Forward goes back down to
      this.base = null;         // the column view's first column
      this.hot = -1;            // the folder the arrow keys have reached
      this.menu = null;         // the open pop-up
      this.typed = null;        // the path field's words while they differ from the folder
      this.note = "";           // the line that says why something was refused
      this.edit = false;        // the drop's trail is a path field
      this.naming = null;       // a new folder being named: {name, at, value, sending}
      this.waiting = 0;         // listings out
      this.loading = false;     // a listing has been out long enough to say so
      this.busy = false;        // a choice is being acted on
      this.failed = "";         // the machines could not be read: nothing else works
      this.fresh = false;       // the list was just replaced, and fades in
      this.targets = [];        // the paths the last drawing's rows and crumbs lead to
      this.seq = 0;
      this.onchange = () => {};
    }
    get M(){ return this.machines.find(m => m.id === this.machineId) || null; }
    get off(){ return !this.at || this.waiting > 0 || this.busy || !!this.failed; }
    changed(){ this.onchange(); }

    async start(){
      const r = await this.ask("/machines");
      const list = r.json && Array.isArray(r.json.machines) ? r.json.machines : [];
      if (!r.ok || !list.length){
        this.failed = r.status === 404 ? "The folder picker needs the board's server restarted."
          : "The board did not answer. Try again in a moment.";
        this.changed();
        return false;
      }
      this.machines = list;
      this.machineId = list[0].id;
      this.place = "home";
      return this.go(list[0].home, { place: "home", base: list[0].top });
    }

    async listing(path, from){
      const q = new URLSearchParams({ path: path || "" });
      if (from) q.set("from", from);
      if (this.machineId !== "this") q.set("machine", this.machineId);
      const r = await this.ask("/dirs?" + q);
      if (r.ok && r.json && typeof r.json.path === "string" && Array.isArray(r.json.dirs)){
        this.cache.set(r.json.path, r.json);
        return { listing: r.json };
      }
      return { error: (r.json && r.json.error) || (r.status ? "the board refused that folder" : "the board did not answer") };
    }

    // the folder at path, opened. how: keepFwd (back and forward keep the
    // forward list), typed (the words a typed path came from), from (what a
    // relative path is taken from), place, base (the first column) or up (the
    // first column this many folders above), hotPath (the row to reach)
    async go(path, how = {}){
      if (this.busy) return false;   // a choice is being acted on: the folder stays
      const seq = ++this.seq;
      this.menu = null;
      this.waiting++;
      const slow = setTimeout(() => { if (seq === this.seq && this.waiting){ this.loading = true; this.changed(); } }, SLOW_MS);
      this.changed();
      let got;
      try { got = await this.listing(path, how.from); }
      finally { this.waiting--; clearTimeout(slow); }
      if (seq !== this.seq) return false;
      this.loading = false;
      if (!got.listing){
        if (how.typed != null){ this.typed = how.typed; this.note = this.refusal(how.typed, got.error); }
        else this.note = capital(got.error);
        this.changed();
        return false;
      }
      const L = got.listing, trail = L.trail || [];
      this.at = L;
      this.naming = null;
      if (!how.keepFwd) this.fwd = [];
      this.typed = null; this.note = ""; this.edit = false; this.hot = -1; this.fresh = true;
      if (how.base) this.base = how.base;
      else if (how.up) this.base = trail[Math.max(0, trail.length - 1 - how.up)].path;
      else if (!trail.some(t => t.path === this.base)) this.base = trail.length > 1 ? trail[trail.length - 2].path : L.path;
      this.place = how.place || this.placeFor(L);
      if (how.hotPath) this.hot = L.dirs.findIndex(d => d.path === how.hotPath);
      if (this.kind === "panel" && this.view === "columns") await this.fill();
      if (seq !== this.seq) return false;
      this.changed();
      return true;
    }
    // the sidebar row that stays on: a machine's stays wherever it leads, and a
    // place's while the folder is inside it; outside it the machine's is on
    placeFor(L){
      const m = this.M;
      if (!m || this.place === m.id) return m ? m.id : this.place;
      const place = (m.places || []).find(p => p.id === this.place);
      return place && (L.trail || []).some(t => t.path === place.path) ? place.id : m.id;
    }
    refusal(t, error){
      const machine = this.M ? this.M.name : "this machine";
      switch (error){
        case "no folder there": return "No folder at " + t + " on " + machine;
        case "outside the home folder": return t + " is outside your home folder";
        case "that folder is hidden": return t + " is a hidden folder";
        case "that is a file, not a folder": return t + " is a file, not a folder";
        default: return capital(error || "the board did not answer");
      }
    }

    // Back is up one folder and Forward back down the same way, as the mocks do
    up(){
      const L = this.at;
      if (this.off || !L.parent) return null;
      this.fwd.push(L.path);
      return this.go(L.parent, { keepFwd: true, base: this.base === L.path ? L.parent : undefined });
    }
    async forward(){
      if (this.off || !this.fwd.length) return false;
      const ok = await this.go(this.fwd.pop(), { keepFwd: true });
      if (!ok) this.fwd = [];
      return ok;
    }
    choosePlace(id){
      const m = this.M;
      if (!m || this.busy) return null;
      if (id === m.id) return this.go(m.top, { place: id, base: m.top });
      const p = (m.places || []).find(x => x.id === id);
      return p ? this.go(p.path, { place: id, base: p.path }) : null;
    }
    goTyped(text){
      const t = String(text == null ? "" : text).trim();
      if (!t || this.busy || this.failed) return null;
      return this.go(t, { typed: t, from: this.at && this.at.path, up: 2 });
    }
    openRow(i){
      const r = this.rows().filter(x => !x.draft)[i];
      return r && !this.off ? this.go(r.path) : null;
    }

    // the folders of the folder on show, with a new one being named among them
    rows(){
      const L = this.at;
      if (!L || L.unreadable) return [];
      const out = L.dirs.slice(), n = this.naming;
      if (n && n.at === L.path){
        let i = out.findIndex(d => byName(d.name, n.name) > 0);
        if (i < 0) i = out.length;
        out.splice(i, 0, { name: n.name, draft: true });
      }
      return out;
    }
    moveHot(step){
      const n = this.rows().filter(r => !r.draft).length;
      if (!n || this.off) return;
      this.hot = this.hot < 0 ? (step > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, this.hot + step));
      this.changed();
    }

    // New folder: a row named "untitled folder", the name selected for typing
    // over. Enter, or leaving the row, makes it after the server has checked
    // the name; Escape drops it and nothing is made
    newFolder(){
      const L = this.at;
      if (this.off || L.unreadable || this.naming) return false;
      const taken = new Set(L.dirs.map(d => d.name.toLowerCase()));
      let name = "untitled folder", i = 2;
      while (taken.has(name)) name = "untitled folder " + i++;
      this.naming = { name, at: L.path, value: name, sending: false, focused: false };
      this.menu = null; this.note = ""; this.hot = -1; this.edit = false; this.typed = null;
      this.changed();
      return true;
    }
    async nameFolder(value){
      const n = this.naming;
      if (!n || n.sending) return false;
      const name = String(value == null ? n.value : value).trim();
      if (!name){ this.cancelName(); return false; }
      n.value = String(value == null ? n.value : value);
      n.sending = true;
      const q = new URLSearchParams({ path: n.at, name });
      if (this.machineId !== "this") q.set("machine", this.machineId);
      const r = await this.ask("/mkdir?" + q, { method: "POST" });
      n.sending = false;
      if (this.naming !== n) return false;
      if (!r.ok || !r.json || !r.json.path){
        this.note = capital((r.json && r.json.error) || "that folder could not be made");
        n.focused = false;
        this.changed();
        return false;
      }
      this.cache.delete(n.at);
      return this.go(n.at, { keepFwd: true, hotPath: r.json.path });
    }
    cancelName(){
      if (!this.naming) return;
      this.naming = null; this.note = "";
      this.changed();
    }

    // Choose: the folder on show. a page that gave choose is asked first, and
    // words from it are shown here with the picker kept open
    async choose(){
      const L = this.at;
      if (this.off || (this.naming && this.naming.sending)) return null;
      const folder = { machine: this.machineId, path: L.path, name: L.name, short: L.short };
      if (!this.chooseFn) return folder;
      this.busy = true; this.note = "";
      this.changed();
      let said;
      try { said = await this.chooseFn(folder); }
      catch (_) { said = "that folder could not be opened"; }
      this.busy = false;
      if (said){ this.note = capital(said); this.changed(); return null; }
      return folder;
    }

    async setView(view){
      if (this.kind !== "panel" || (view !== "list" && view !== "columns") || view === this.view) return;
      this.view = view;
      writeView(this.store, view);
      this.hot = -1; this.menu = null; this.fresh = true;
      this.changed();
      if (view === "columns" && this.at){ const seq = this.seq; await this.fill(); if (seq === this.seq) this.changed(); }
    }

    // the column view's columns, the first column to the folder on show:
    // each folder's listing and the row in it that leads on
    columns(){
      const L = this.at;
      if (!L) return [];
      const trail = L.trail || [{ name: L.name, path: L.path }];
      let i = trail.findIndex(t => t.path === this.base);
      if (i < 0) i = trail.length - 1;
      return trail.slice(i).map((t, k, all) => ({
        path: t.path, name: t.name, pick: all[k + 1] ? all[k + 1].path : null,
        listing: t.path === L.path ? L : this.cache.get(t.path) || null }));
    }
    async fill(){
      const want = this.columns().filter(c => !c.listing).map(c => c.path);
      await Promise.all(want.map(p => this.listing(p)));
    }

    // ---- drawing --------------------------------------------------------------
    target(path){ this.targets.push(path); return ' data-t="' + (this.targets.length - 1) + '"'; }
    ib(a, label, k, disabled, extra = ""){
      return '<button type="button" class="fp-ib" data-a="' + a + '" title="' + label + '" aria-label="' + label + '"' +
        (disabled ? " disabled" : "") + extra + ">" + mark(k) + "</button>";
    }
    cross(){
      return '<button type="button" class="fp-x" data-a="cancel" aria-label="Close the folder picker" title="Close">' + CROSS + "</button>";
    }
    buttons(){
      return '<button type="button" class="fp-btn" data-a="cancel">Cancel</button>' +
        '<button type="button" class="fp-btn fp-go" data-a="choose"' + (this.off ? " disabled" : "") + ">Choose</button>";
    }
    waitLine(){
      const m = this.M;
      return this.loading ? '<div class="fp-ld"><span class="fp-spin">|</span>Reading folders on ' + esc(m ? m.name : "this machine") + "</div>" : "";
    }
    // what the well holds in place of folders, or null when there are folders
    // to show: the machines could not be read, the first listing is still on
    // its way (said once it takes a while), or the folder may not be read
    stopped(){
      if (this.failed) return '<div class="fp-card">' + mark("lock") + '<div class="fp-cardt">' + esc(this.failed) + "</div></div>";
      if (!this.at) return this.waitLine();
      if (this.at.unreadable) return '<div class="fp-card">' + mark("lock") + '<div class="fp-cardt">' + esc(this.at.name) +
        ' cannot be read</div><div class="fp-cardw">The board may not look inside this folder.</div></div>';
      return null;
    }
    nameField(){
      const n = this.naming;
      return '<input class="fp-rn" data-f="name" value="' + esc(n.value) + '" aria-label="The new folder\'s name" spellcheck="false" autocomplete="off" autocapitalize="off">';
    }
    machineRow(m, cls){
      const on = this.place === m.id ? " fp-on" : "", off = m.online === false ? " fp-off" : "";
      return '<button type="button" class="' + cls + on + off + '" data-a="place" data-p="' + esc(m.id) + '" title="' +
        esc(m.online === false ? m.name + " is offline" : m.name) + '">' + mark(m.kind === "server" ? "server" : "computer") +
        '<span class="fp-nm">' + esc(m.name) + "</span>" +
        (m.id === "this" ? "" : m.online === false ? '<span class="fp-tag">offline</span><span class="fp-dot fp-off"></span>' : '<span class="fp-dot"></span>') +
        "</button>";
    }

    // mocks A and B in one: the bar, places and machines down the left, the
    // well with the list or the columns, the path field and the buttons
    drawPanel(){
      this.targets = [];
      const L = this.at, m = this.M, off = this.off;
      const atTop = L && m && L.path === m.top;
      let menu = "";
      if (this.menu === "loc" && L && !off){
        const chain = (L.trail || []).slice().reverse();
        menu = '<div class="fp-menu qn-glass" role="menu">' + chain.map((t, i) =>
          '<button type="button" class="fp-mr' + (i === 0 ? " fp-on" : "") + '" role="menuitem" data-a="goto"' + this.target(t.path) + ">" +
            (m && t.path === m.home ? mark("home") : mark("folder", "fp-fi")) + '<span class="fp-nm">' + esc(t.name) + "</span></button>").join("") +
          (m ? '<button type="button" class="fp-mr" role="menuitem" data-a="goto"' + this.target(m.top) + ">" + mark("computer") +
            '<span class="fp-nm">' + esc(m.name) + "</span></button>" : "") + "</div>";
      }
      const view = this.view;
      let h = '<div class="fp-tb">' +
        this.ib("up", "Back", "left", off || !L.parent) + this.ib("fwd", "Forward", "right", off || !this.fwd.length) +
        '<div class="fp-view" role="group" aria-label="View" data-on="' + view + '"><span class="fp-thumb"></span>' +
          '<button type="button" class="fp-vs' + (view === "list" ? " fp-on" : "") + '" data-a="view" data-v="list" title="as a list" aria-label="as a list" aria-pressed="' + (view === "list") + '">' + mark("list") + "</button>" +
          '<button type="button" class="fp-vs' + (view === "columns" ? " fp-on" : "") + '" data-a="view" data-v="columns" title="as columns" aria-label="as columns" aria-pressed="' + (view === "columns") + '">' + mark("columns") + "</button></div>" +
        '<div class="fp-locw"><button type="button" class="fp-loc qn-glass" data-a="menu" data-m="loc" aria-haspopup="true" aria-expanded="' + (!!menu) + '"' + (off ? " disabled" : "") + ">" +
          (!L ? mark("computer") : atTop ? mark("home") : mark("folder", "fp-fi")) + '<span class="fp-nm">' + esc(L ? L.name : m ? m.name : "") + "</span>" + mark("chev", "fp-cv") + "</button>" + menu + "</div>" +
        '<span class="fp-sp"></span>' +
        '<button type="button" class="fp-ib" data-a="new"' + (off || (L && L.unreadable) || this.naming ? " disabled" : "") + ">" + mark("plusfolder") + "<span>New folder</span></button>" +
        this.cross() + "</div>";
      h += '<div class="fp-bd"><div class="fp-sb"><div class="fp-sbh">Places</div>';
      for (const p of (m && m.places) || [])
        h += '<button type="button" class="fp-sbi' + (this.place === p.id ? " fp-on" : "") + '" data-a="place" data-p="' + esc(p.id) + '">' +
          mark(PLACE_MARK[p.id] || "folder") + '<span class="fp-nm">' + esc(p.name) + "</span></button>";
      h += '<div class="fp-sbh">Machines</div>' + this.machines.map(x => this.machineRow(x, "fp-sbi")).join("") + "</div>";
      h += '<div class="fp-well">' + (view === "columns" ? this.drawColumns() : this.drawList()) + "</div></div>";
      h += '<div class="fp-ft"><label for="fp-goto">Go to</label><input id="fp-goto" class="fp-fld' + (this.typed != null && this.note ? " fp-bad" : "") +
        '" data-f="path" value="' + esc(this.typed != null ? this.typed : L ? L.short : "") + '" placeholder="Type or paste a path" spellcheck="false" autocomplete="off" autocapitalize="off"' +
        (this.failed ? " disabled" : "") + ">" + this.buttons() + "</div>";
      return h;
    }
    notes(){
      let h = "";
      if (this.at && this.at.more) h += '<div class="fp-note">' + this.at.more + " more folders here are not listed</div>";
      if (this.note) h += '<div class="fp-note fp-bad" role="alert">' + esc(this.note) + "</div>";
      return h;
    }
    drawList(){
      const stop = this.stopped();
      if (stop !== null) return '<div class="fp-ls">' + stop + "</div>" + this.notes();
      const L = this.at, now = this.now();
      let h = '<div class="fp-lh"><span class="fp-c-n">Name</span><span class="fp-c-d">Modified</span><span class="fp-c-c">Items</span><span class="fp-c-x"></span></div>';
      h += '<div class="fp-ls' + (this.fresh ? " fp-fresh" : "") + '">';
      const rows = this.rows();
      if (!rows.length) h += '<div class="fp-empty">No folders inside ' + esc(L.name) + "</div>";
      let i = 0;
      for (const r of rows){
        if (r.draft){
          h += '<div class="fp-fr fp-sel">' + mark("folder", "fp-fi") + this.nameField() + '<span class="fp-dt"></span><span class="fp-ct"></span>' + mark("right", "fp-cx") + "</div>";
          continue;
        }
        h += '<button type="button" class="fp-fr' + (i === this.hot ? " fp-hot" : "") + '" data-a="goto"' + this.target(r.path) + ">" + mark("folder", "fp-fi") +
          '<span class="fp-nm">' + esc(r.name) + '</span><span class="fp-dt">' + when(r.modified, now) + '</span><span class="fp-ct">' + itemsText(r) + "</span>" +
          mark("right", "fp-cx") + "</button>";
        i++;
      }
      return h + "</div>" + this.notes();
    }
    drawColumns(){
      const stop = this.stopped();
      if (stop !== null) return '<div class="fp-cols"><div class="fp-col fp-wide">' + stop + "</div></div>" + this.notes();
      const cols = this.columns(), m = this.M;
      let h = '<div class="fp-cols">';
      cols.forEach((c, k) => {
        const last = k === cols.length - 1;
        h += '<div class="fp-col' + (last && this.fresh ? " fp-fresh" : "") + '">';
        if (!c.listing) h += this.waitLine();
        else if (c.listing.unreadable) h += '<div class="fp-empty">' + esc(c.name) + " cannot be read</div>";
        else {
          const rows = last ? this.rows() : c.listing.dirs;
          if (!rows.length) h += '<div class="fp-empty">No folders inside</div>';
          let i = 0;
          for (const r of rows){
            if (r.draft){ h += '<div class="fp-fr fp-sel">' + mark("folder", "fp-fi") + this.nameField() + "</div>"; continue; }
            const cls = r.path === c.pick ? (k === cols.length - 2 ? " fp-cur" : " fp-path") : last && i === this.hot ? " fp-hot" : "";
            h += '<button type="button" class="fp-fr' + cls + '" data-a="goto"' + this.target(r.path) + ">" + mark("folder", "fp-fi") +
              '<span class="fp-nm">' + esc(r.name) + "</span>" + (r.items === 0 ? "" : mark("right", "fp-cx")) + "</button>";
            if (last) i++;
          }
        }
        h += "</div>";
      });
      h += "</div>";
      // the path bar along the well's foot: the machine, then the folders
      const trail = this.at.trail || [];
      h += '<div class="fp-pathbar"><div class="fp-crumbs">' +
        (m ? '<button type="button" class="fp-crumb" data-a="goto"' + this.target(m.top) + ">" + mark("computer") + esc(m.name) + "</button>" : "") +
        trail.map((t, i) => '<span class="fp-csep">›</span><button type="button" class="fp-crumb' + (i === trail.length - 1 ? " fp-last" : "") + '" data-a="goto"' +
          this.target(t.path) + ">" + esc(t.name) + "</button>").join("") + "</div></div>";
      return h + this.notes();
    }

    // mock C: the title bar, the machines as the ticket list's names, the
    // trail or the path field, the places, the folders as tickets, the plus
    drawDrop(){
      this.targets = [];
      const L = this.at, m = this.M, off = this.off, now = this.now();
      let h = '<div class="fp-titlebar"><span class="fp-title">Open a new folder</span>' + this.cross() + "</div>";
      h += '<div class="fp-mh">' + this.machines.map(x => '<button type="button" class="fp-mt' + (x.id === this.machineId ? " fp-on" : "") +
        (x.online === false ? " fp-off" : "") + '" data-a="place" data-p="' + esc(x.id) + '" title="' + esc(x.online === false ? x.name + " is offline" : x.name) + '">' +
        (x.id === "this" ? "" : '<span class="fp-dot' + (x.online === false ? " fp-off" : "") + '"></span>') + "<span>" + esc(x.name) + "</span></button>").join("") + "</div>";
      const upMark = this.ib("up", "Up one folder", "up", off || !L.parent);
      if (this.edit && L){
        h += '<div class="fp-nav">' + upMark + '<input class="fp-fld' + (this.typed != null && this.note ? " fp-bad" : "") + '" data-f="path" value="' +
          esc(this.typed != null ? this.typed : L.short) + '" placeholder="Type or paste a path" aria-label="A path to go to" spellcheck="false" autocomplete="off" autocapitalize="off" enterkeyhint="go">' +
          this.ib("go", "Go", "enter", false) + "</div>";
      } else {
        const trail = (L && L.trail) || [], sep = (m && m.sep) || "/";
        h += '<div class="fp-nav">' + upMark + '<div class="fp-crumbs">' + trail.map((t, i) =>
          (i ? '<span class="fp-csep">' + esc(sep) + "</span>" : "") + '<button type="button" class="fp-crumb' + (i === trail.length - 1 ? " fp-last" : "") + '" data-a="goto"' +
          this.target(t.path) + ">" + esc(i === 0 && m && t.path === m.home ? "~" : t.name) + "</button>").join("") +
          "</div>" + this.ib("edit", "Type a path", "pencil", !L) + "</div>";
      }
      h += '<div class="fp-sc">' + ((m && m.places) || []).map(p => '<button type="button" class="fp-psug' + (L && p.path === L.path ? " fp-on" : "") +
        '" data-a="goto"' + this.target(p.path) + ">" + esc(p.id === "home" ? "Home" : p.name) + "</button>").join("") + "</div>";
      h += '<div class="fp-ls' + (this.fresh ? " fp-fresh" : "") + '">';
      const stop = this.stopped();
      if (stop !== null) h += stop;
      else {
        const rows = this.rows();
        if (!rows.length) h += '<div class="fp-empty">No folders inside ' + esc(L.name) + "</div>";
        let i = 0;
        for (const r of rows){
          const meta = '<span class="fp-tmeta"><span class="fp-tage">' + (r.draft ? "" : count(r)) + '</span><span class="fp-teng">' +
            (r.draft ? "" : whenShort(r.modified, now)) + "</span></span>";
          if (r.draft){ h += '<div class="fp-trow">' + mark("folder", "fp-fi") + this.nameField() + meta + "</div>"; continue; }
          h += '<button type="button" class="fp-trow' + (i === this.hot ? " fp-hot" : "") + '" data-a="goto"' + this.target(r.path) + ">" +
            mark("folder", "fp-fi") + '<span class="fp-ttl">' + esc(r.name) + "</span>" + meta + "</button>";
          i++;
        }
        h += '<button type="button" class="fp-plus" data-a="new" title="New folder" aria-label="New folder"' + (off || this.naming ? " disabled" : "") + ">" + PLUS + "<span>New folder</span></button>";
      }
      if (this.at && this.at.more) h += '<div class="fp-empty">' + this.at.more + " more folders here are not listed</div>";
      if (this.note) h += '<div class="fp-err" role="alert">' + esc(this.note) + "</div>";
      h += "</div>";
      h += '<div class="fp-ft"><div class="fp-opens"><span>Opens</span><code>' + esc((m ? m.name : "") + "  " + (L ? L.short : "")) + "</code></div>" + this.buttons() + "</div>";
      return h;
    }
  }

  // ---- the picker on the page ---------------------------------------------------
  // one at a time. live holds the open one: its Picker, its two layers, what it
  // was opened with, where the focus was, and how its promise is answered
  let live = null;
  const doc = root && root.document;

  function shown(el){
    if (!el || !el.isConnected || el === doc.body || el === doc.documentElement) return false;
    const view = el.ownerDocument.defaultView;
    return el.getClientRects().length > 0 && view.getComputedStyle(el).visibility !== "hidden" && !el.closest("[inert]");
  }

  // opts: kind ("panel", or "drop" for the phone page), choose (see Picker),
  // anchor and span (the drop's capsule and the two buttons at the ends of its
  // row) and back (where the focus goes if the element that had it is no longer
  // shown). answers the chosen folder {machine, path, name, short}, or null
  function open(opts = {}){
    if (live) return live.promise;
    const picker = new Picker(opts);
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    const veil = doc.createElement("div");
    veil.className = "fp fp-veil" + (picker.kind === "drop" ? " fp-soft" : "");
    const panel = doc.createElement("div");
    panel.className = "fp fp-panel qn-glass " + (picker.kind === "drop" ? "fp-c" : "fp-a");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Open a new folder");
    panel.tabIndex = -1;
    const L = live = { picker, veil, panel, opts, resolve, promise, was: doc.activeElement, drawing: false, spin: 0, frame: 0, watch: null };
    doc.body.append(veil, panel);
    if (picker.kind === "drop") placeDrop(L);
    bind(L);
    picker.onchange = () => { if (live === L) render(L); };
    render(L);
    panel.focus({ preventScroll: true });
    picker.start();
    return promise;
  }

  // the drop stands over the capsule it came from, as the phone's project list
  // does: centred on it and kept between the row's two end buttons, DROP_AIR
  // above it, at most DROP_W wide and DROP_H tall, and below the top's safe area
  function placeDrop(L){
    const a = L.opts.anchor && L.opts.anchor.getBoundingClientRect();
    const de = doc.documentElement, wide = de.clientWidth, high = de.clientHeight;
    const ends = (L.opts.span || []).map(el => el && el.getBoundingClientRect());
    const lo = ends[0] ? ends[0].left : 8, hi = ends[1] ? ends[1].right : wide - 8;
    const w = Math.min(DROP_W, hi - lo);
    const centre = a ? a.left + a.width / 2 : wide / 2, top = a ? a.top : high - 8;
    const left = Math.max(lo, Math.min(centre - w / 2, hi - w));
    Object.assign(L.panel.style, { left: left + "px", width: w + "px", bottom: (high - top + DROP_AIR) + "px",
      top: "max(calc(env(safe-area-inset-top, 0px) + 12px), " + (top - DROP_AIR - DROP_H) + "px)" });
  }

  function bind(L){
    const { picker: p, panel, veil } = L;
    panel.addEventListener("click", e => {
      const b = e.target.closest && e.target.closest("[data-a]");
      if (!b || !panel.contains(b) || b.disabled) return;
      const d = b.dataset;
      switch (d.a){
        case "goto": p.go(p.targets[+d.t]); break;
        case "up": p.up(); break;
        case "fwd": p.forward(); break;
        case "place": p.choosePlace(d.p); break;
        case "view": p.setView(d.v); break;
        case "menu": p.menu = p.menu === d.m ? null : d.m; p.changed(); break;
        case "new": p.newFolder(); break;
        case "edit": p.edit = true; p.note = ""; p.typed = null; p.changed(); focusField(L, true); break;
        case "go": { const f = panel.querySelector("[data-f=path]"); if (f) p.goTyped(f.value); break; }
        case "choose": chooseNow(L); break;
        case "cancel": close(null); break;
      }
    });
    // a press outside an open pop-up only shuts it, as a Mac menu does; a press
    // on Cancel or the cross drops a folder being named before the field's
    // leaving would make it
    panel.addEventListener("pointerdown", e => {
      const t = e.target;
      if (p.naming && t.closest && t.closest("[data-a=cancel]")) p.naming = null;
      if (p.menu && !(t.closest && t.closest(".fp-menu, [data-a=menu]"))){
        e.preventDefault(); e.stopPropagation();
        p.menu = null; p.changed();
      }
    }, true);
    panel.addEventListener("input", e => {
      const t = e.target;
      if (t.matches("[data-f=path]")) p.typed = t.value;
      else if (t.matches("[data-f=name]") && p.naming) p.naming.value = t.value;
    });
    panel.addEventListener("focusout", e => {
      if (L.drawing || live !== L || !e.target.matches("[data-f=name]") || !p.naming || p.naming.sending) return;
      if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest("[data-a=cancel]")) return;
      p.nameFolder(e.target.value);
    });
    panel.addEventListener("scroll", e => {
      if (e.target.classList && (e.target.classList.contains("fp-ls") || e.target.classList.contains("fp-col"))) bands(L);
    }, true);
    // a click on the shade closes it, as it shuts the project list
    veil.addEventListener("click", () => close(null));
    // nothing under the picker hears its presses: the phone's edge pulls and
    // swipes, and the board's drags, listen on the document
    for (const layer of [veil, panel])
      for (const type of ["touchstart", "touchmove", "touchend", "mousedown", "pointerdown", "wheel"])
        layer.addEventListener(type, e => e.stopPropagation(), { passive: true });
    L.onResize = () => { if (p.kind === "drop") placeDrop(L); };
    root.addEventListener("resize", L.onResize);
    // the Mac's phone view takes the window over: a picker on the board
    // under it could not be reached, so it closes
    if (typeof root.MutationObserver === "function"){
      L.watch = new root.MutationObserver(() => { if (doc.body.classList.contains("phoneview-active")) close(null); });
      L.watch.observe(doc.body, { attributes: true, attributeFilter: ["class"] });
    }
    // a page that has no guard (card-logic.js) to hand the keys over hears them here
    if (!root.folderPickerKeys){
      L.keys = e => key(e);
      root.addEventListener("keydown", L.keys, true);
    }
  }

  function render(L){
    const p = L.picker, panel = L.panel;
    const active = doc.activeElement, inside = active && panel.contains(active) && active !== panel;
    const keepField = inside && active.dataset && active.dataset.f ? { f: active.dataset.f, start: active.selectionStart, end: active.selectionEnd } : null;
    const keepButton = inside && !keepField && active.dataset && /^(up|fwd|view|new|edit|menu|go)$/.test(active.dataset.a || "")
      ? '[data-a="' + active.dataset.a + '"]' + (active.dataset.v ? '[data-v="' + active.dataset.v + '"]' : "") : null;
    const list = panel.querySelector(".fp-ls"), top = list && !p.fresh ? list.scrollTop : 0;
    L.drawing = true;
    panel.innerHTML = p.kind === "drop" ? p.drawDrop() : p.drawPanel();
    L.drawing = false;
    const field = keepField && panel.querySelector('[data-f="' + keepField.f + '"]');
    const button = keepButton && panel.querySelector(keepButton + ":not(:disabled)");
    if (field && !field.disabled){
      field.focus({ preventScroll: true });
      try { field.setSelectionRange(keepField.start, keepField.end); } catch (_) {}
    } else if (button) button.focus({ preventScroll: true });
    else if (inside || active === panel || !active || active === doc.body) panel.focus({ preventScroll: true });
    if (p.naming && !p.naming.focused){
      const name = panel.querySelector("[data-f=name]");
      if (name){ name.focus({ preventScroll: true }); name.select(); p.naming.focused = true; }
    }
    const newList = panel.querySelector(".fp-ls");
    if (newList && top) newList.scrollTop = top;
    const cols = panel.querySelector(".fp-cols");
    if (cols) cols.scrollLeft = cols.scrollWidth;
    const hot = panel.querySelector(".fp-hot, .fp-sel");
    if (hot) hot.scrollIntoView({ block: "nearest" });
    p.fresh = false;
    bands(L);
    spin(L);
  }

  // how far each list has scrolled and still can, as far as the 22px ramp
  function bands(L){
    for (const ls of L.panel.querySelectorAll(".fp-ls, .fp-col")){
      const up = Math.min(22, ls.scrollTop), down = Math.min(22, Math.max(0, ls.scrollHeight - ls.clientHeight - ls.scrollTop));
      ls.style.setProperty("--fp-up", up + "px");
      ls.style.setProperty("--fp-down", down + "px");
    }
  }
  function spin(L){
    const any = L.panel.querySelector(".fp-spin");
    if (any && !L.spin) L.spin = setInterval(() => {
      L.frame = (L.frame + 1) % SPIN.length;
      for (const s of L.panel.querySelectorAll(".fp-spin")) s.textContent = SPIN[L.frame];
    }, SPIN_MS);
    else if (!any && L.spin){ clearInterval(L.spin); L.spin = 0; }
  }
  function focusField(L, select){
    const f = L.panel.querySelector("[data-f=path]");
    if (!f) return;
    f.focus({ preventScroll: true });
    if (select) f.select();
  }

  async function chooseNow(L){
    const folder = await L.picker.choose();
    if (folder && live === L) close(folder);
  }

  // closes the open picker with what it answers. the focus goes back to where
  // it was, if that is still shown, else to the opener's own place for it, else
  // nowhere, and never stays in the picker
  function close(result){
    const L = live;
    if (!L) return;
    live = null;
    L.picker.onchange = () => {};
    root.removeEventListener("resize", L.onResize);
    if (L.keys) root.removeEventListener("keydown", L.keys, true);
    if (L.watch) L.watch.disconnect();
    if (L.spin) clearInterval(L.spin);
    L.veil.classList.add("fp-going");
    L.panel.classList.add("fp-going");
    const back = shown(L.was) ? L.was : shown(L.opts.back) ? L.opts.back : null;
    if (back) back.focus({ preventScroll: true });
    else if (L.panel.contains(doc.activeElement)) doc.activeElement.blur();
    setTimeout(() => { L.veil.remove(); L.panel.remove(); }, 280);
    L.resolve(result || null);
  }

  // the Chrome shortcuts the board blocks (chromeShortcutBlocked, index.html):
  // the picker's keys stop before the board's guard hears them, so it is asked
  // from here, on the board or from the phone view's own board
  function blocked(e){
    let test = root.chromeShortcutBlocked;
    if (typeof test !== "function"){
      try { test = root.parent && root.parent !== root ? root.parent.chromeShortcutBlocked : null; } catch (_) { test = null; }
    }
    try { return typeof test === "function" && test(e); } catch (_) { return false; }
  }

  // every key while the picker is open. Up and Down move over the folders on
  // show (the last column's in column view), Enter or Right goes into the one
  // reached and Enter with none reached chooses the folder on show, Left goes
  // up, Escape shuts a pop-up, leaves the drop's path field, drops a folder
  // being named, and otherwise closes. a button keeps its own Enter and Space,
  // a field its typing, and Tab stays inside
  function key(e){
    const L = live;
    if (!L) return;
    e.stopImmediatePropagation();
    if ((e.metaKey || e.ctrlKey) && e.cancelable && !e.defaultPrevented && blocked(e)) e.preventDefault();
    if (e.isComposing || e.keyCode === 229) return;
    const p = L.picker, panel = L.panel;
    let t = e.target && e.target.nodeType === 1 ? e.target : null;
    if (!t || !panel.contains(t)){
      // a key aimed at the page under the picker types nothing there
      if (!e.metaKey && !e.ctrlKey) e.preventDefault();
      panel.focus({ preventScroll: true });
      t = panel;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Tab"){ trap(L, e); return; }
    if (t.matches("[data-f=name]")){
      if (e.key === "Enter"){ e.preventDefault(); p.nameFolder(t.value); }
      else if (e.key === "Escape"){ e.preventDefault(); p.cancelName(); panel.focus({ preventScroll: true }); }
      return;
    }
    if (t.matches("[data-f=path]")){
      if (e.key === "Enter"){ e.preventDefault(); p.goTyped(t.value); }
      else if (e.key === "Escape"){
        e.preventDefault();
        if (p.kind === "drop" && p.edit){ p.edit = false; p.typed = null; p.note = ""; p.changed(); panel.focus({ preventScroll: true }); }
        else close(null);
      }
      return;
    }
    if (p.menu){
      const items = [...panel.querySelectorAll(".fp-menu .fp-mr")];
      if (e.key === "Escape"){
        e.preventDefault();
        p.menu = null; p.changed();
        const loc = panel.querySelector("[data-a=menu]");
        if (loc) loc.focus({ preventScroll: true });
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp"){
        e.preventDefault();
        const at = items.indexOf(doc.activeElement), step = e.key === "ArrowDown" ? 1 : -1;
        const next = items[at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length];
        if (next) next.focus({ preventScroll: true });
      }
      return;
    }
    if (e.key === "Escape"){ e.preventDefault(); close(null); return; }
    if (t !== panel && t.closest("button") && (e.key === "Enter" || e.key === " ")) return;
    switch (e.key){
      case "ArrowDown": e.preventDefault(); p.moveHot(1); break;
      case "ArrowUp": e.preventDefault(); p.moveHot(-1); break;
      case "ArrowRight": if (p.kind === "panel" && p.hot >= 0){ e.preventDefault(); p.openRow(p.hot); } break;
      case "ArrowLeft": if (p.kind === "panel"){ e.preventDefault(); p.up(); } break;
      case "Enter": e.preventDefault(); if (p.hot >= 0) p.openRow(p.hot); else chooseNow(L); break;
    }
  }
  function trap(L, e){
    const all = [...L.panel.querySelectorAll("button:not(:disabled), input:not(:disabled)")].filter(shown);
    if (!all.length) return;
    e.preventDefault();
    const at = all.indexOf(doc.activeElement);
    all[at < 0 ? (e.shiftKey ? all.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + all.length) % all.length].focus({ preventScroll: true });
  }

  return { open, key, isOpen: () => !!live, close: () => close(null), Picker, when, whenShort, itemsText, readView, writeView, VIEW_KEY };
});
