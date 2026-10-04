/*
 * The board's own settings, for the two desktop pages (index.html and
 * page.html): where each box sits and how big it is, which boxes are put
 * away, the background colour, the outline's width, formatting while typing,
 * the home chart, the typed page's tasks and the one-time layout passes that
 * go with them. They used to live in each browser's localStorage, which files
 * them under the board's address, so the board opened at another address (a
 * port it moved to) started from nothing. Now they are the board's, kept in
 * settings.json beside state.json, and every address shows the same board.
 *
 * The store reads and writes the way localStorage does (getItem, setItem,
 * removeItem, key, length), so a page changed one word at each call. Reading
 * is synchronous: the server writes the board's values in front of this file
 * as it serves it (globalThis.BOARD_SETTINGS), so a page has every one before
 * its first line runs and nothing is drawn twice. A write lands in memory at
 * once and goes to the board one request at a time, where writes are merged
 * key by key, so two windows arranging different boxes both keep theirs. A key
 * this window wrote is held for SETTINGS_HOLD against readings already on
 * their way, as the tab bar's TAB_HOLD is (card-logic.js), and after that it
 * follows the board. A key that is not a setting (the open card, the open tab,
 * a cache) goes straight to localStorage: it belongs to the one window.
 *
 * The one-time copy: a browser that held settings before this file existed
 * hands them over the first time it loads it, and only to an empty store, so
 * the first browser to do so wins and any other takes the board's. The keys
 * are left in the browser as they were. A page at a new address cannot read
 * the old address's storage, so the copy has to happen at the old one.
 *
 * The phone page never loads this file: the phone's settings stay its own.
 */
(function installBoardSettings(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  // only a copy the server wrote the board's values in front of is a store;
  // a page without one goes on with its browser's own storage
  if (root && root.BOARD_SETTINGS && typeof root.localStorage !== "undefined") {
    const store = api.create({ seed: root.BOARD_SETTINGS, local: root.localStorage,
                               fetch: (url, init) => root.fetch(url, init) });
    root.boardSettings = store;
    root.addEventListener("pagehide", () => store.flush(true));
  }
})(typeof globalThis === "object" ? globalThis : this, function boardSettingsFactory() {
  "use strict";

  // the keys that are the board's settings, the same list as SETTINGS_KEY in
  // server.py. A lane is any printable text, a box one of the page's ids
  const SETTINGS_KEY = new RegExp("^(?:(?:(?:layoutbak\\.)?(?:pos|size)|hide|show)\\.[^\\x00-\\x1f\\x7f]{1,200}\\.[A-Za-z0-9_-]{1,64}"
    + "|doc\\.tasks\\.[^\\x00-\\x1f\\x7f]{1,200}"
    + "|bgcolor|tocw|composeformat|chimemuted|home\\.chart"
    + "|magicrename\\.1|layoutsync\\.1|hideseed\\.1|layoutvisibility\\.[12]|navrestore\\.1)$", "u");
  const SETTINGS_HOLD = 3000;   // ms a window's own write stands over a reading on its way
  const RETRY = 2000;           // ms before a write the board did not answer goes again
  const COPIED = "settings.copied";   // this browser has handed its settings over, once

  const isSetting = key => typeof key === "string" && SETTINGS_KEY.test(key);

  // deps: seed ({rev, values}, what the server wrote in front of this file),
  // local (this browser's localStorage), fetch, and for tests now and later
  function create(deps) {
    const local = deps.local;
    const now = deps.now || (() => Date.now());
    const later = deps.later || ((fn, ms) => setTimeout(fn, ms));
    let rev = Number(deps.seed && deps.seed.rev) || 0;
    let values = Object.assign({}, deps.seed && deps.seed.values);
    const unsent = new Map();   // key -> its value, or null for a removal, not sent yet
    let inflight = new Map();   // the batch out now, sent again on leaving in case it is cut off
    const held = new Map();     // key -> until when this window's own write stands
    let seeding = false, sending = false, asking = false, due = false;

    const readLocal = key => { try { return local.getItem(key); } catch (err) { return null; } };
    const writeLocal = (key, value) => { try { local.setItem(key, value); } catch (err) {} };

    if (Object.keys(values).length) {
      // the board already has settings: this browser's old ones are never
      // handed over, now or later
      writeLocal(COPIED, "1");
    } else if (!readLocal(COPIED)) {
      const mine = {};
      try {
        for (let i = 0; i < local.length; i++) {
          const key = local.key(i);
          if (isSetting(key)) mine[key] = local.getItem(key);
        }
      } catch (err) {}
      if (Object.keys(mine).length) {
        // the page starts from this browser's own arrangement at once, and
        // the board is offered it as the store's first contents
        values = mine;
        seeding = true;
        schedule();
      } else {
        writeLocal(COPIED, "1");
      }
    }

    function schedule(ms) {
      if (due) return;
      due = true;
      later(() => { due = false; flush(false); }, ms || 0);
    }

    // a reading of the board's settings: taken in whole, except the keys this
    // window wrote and is still holding or has not sent, and never one older
    // than what is already here
    function adopt(answer) {
      if (!answer || typeof answer.rev !== "number" || !answer.values || answer.rev < rev) return;
      rev = answer.rev;
      const t = now();
      const next = Object.assign({}, answer.values);
      for (const [key, until] of held) {
        if (until <= t && !unsent.has(key)) { held.delete(key); continue; }
        if (Object.prototype.hasOwnProperty.call(values, key)) next[key] = values[key];
        else delete next[key];
      }
      values = next;
    }

    function note(key, value) {
      unsent.set(key, value);
      held.set(key, now() + SETTINGS_HOLD);
      schedule();
    }

    // one request at a time. leaving says the page is going: what is unsent,
    // and the batch still out in case the page's going cuts it off, goes with
    // keepalive and nothing waits for an answer. Sending a batch twice is
    // harmless: the same keys get the same values
    function flush(leaving) {
      if (sending && !leaving) return;
      let body, query = "";
      if (seeding) {
        body = Object.assign({}, values);
        query = "?seed=1";
      } else if (leaving) {
        if (!unsent.size && !inflight.size) return;
        body = Object.fromEntries(new Map([...inflight, ...unsent]));
      } else {
        if (!unsent.size) return;
        body = Object.fromEntries(unsent);
      }
      const batch = new Map(unsent);
      unsent.clear();
      const init = { method: "POST", body: JSON.stringify(body) };
      if (leaving) { init.keepalive = true; deps.fetch("/settings" + query, init).catch(() => {}); return; }
      inflight = batch;
      sending = true;
      deps.fetch("/settings" + query, init)
        .then(r => r.ok ? r.json() : Promise.reject(r.status))
        .then(answer => {
          sending = false;
          inflight = new Map();
          if (seeding) {
            seeding = false;
            writeLocal(COPIED, "1");
            // another browser's copy got there first: the board's settings
            // stand, and this window's own start-up writes went with the copy
            if (answer.seeded === false) { held.clear(); unsent.clear(); }
          }
          adopt(answer);
          if (unsent.size) schedule();
        }, problem => {
          sending = false;
          inflight = new Map();
          // a refusal will be refused again and is let go; anything else is
          // sent again, under any newer write to the same key
          if (typeof problem === "number" && problem >= 400 && problem < 500 && problem !== 408) {
            if (seeding) { seeding = false; writeLocal(COPIED, "1"); }
            return;
          }
          for (const [key, value] of batch) if (!unsent.has(key)) unsent.set(key, value);
          schedule(RETRY);
        });
    }

    return {
      getItem(key) {
        if (!isSetting(key)) return readLocal(key);
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
      },
      setItem(key, value) {
        if (!isSetting(key)) { local.setItem(key, value); return; }
        values[key] = String(value);
        note(key, values[key]);
      },
      removeItem(key) {
        if (!isSetting(key)) { local.removeItem(key); return; }
        delete values[key];
        note(key, null);
      },
      key(index) { return Object.keys(values)[index] ?? null; },
      get length() { return Object.keys(values).length; },
      // the pages hand in /state's settingsRev: a newer one is read
      notice(serverRev) {
        if (typeof serverRev !== "number" || serverRev <= rev || asking || sending || seeding) return;
        asking = true;
        deps.fetch("/settings").then(r => r.ok ? r.json() : null)
          .then(adopt, () => {}).finally(() => { asking = false; });
      },
      flush,
      get rev() { return rev; },
      // true while a write has not been answered: the copy, or any setting
      get busy() { return seeding || sending || unsent.size > 0; },
    };
  }

  return { create, isSetting, SETTINGS_KEY, SETTINGS_HOLD, COPIED };
});
