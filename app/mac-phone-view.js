/* The Mac's narrow view hosts the real phone document. No phone markup or
   styling belongs here. Handoffs are synchronous, after both live pages are
   ready, so input cannot arrive between taking a draft and handing it over. */
(function (root) {
  "use strict";
  function portrait(width, height, leftRight, wasPortrait) {
    return height > width * (1.2 + (wasPortrait ? -.06 : .06)) ||
      width < leftRight * (.5 + (wasPortrait ? -.04 : .04));
  }
  function readDrafts(els, shelf = {}) {
    const drafts = {};
    for (const [id, saved] of Object.entries(shelf)) drafts[id] = { ...saved, replyTop: saved.top || 0 };
    for (const [id, el] of Object.entries(els)) {
      if (!el.ta) continue;
      const ta = el.ta;
      drafts[id] = { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd,
        dir: ta.selectionDirection, raw: el.reply?.dataset.raw, focus: !!el.field?.focused(), replyTop: el.replyview?.scrollTop || 0 };
    }
    return drafts;
  }
  function writeDraft(el, saved) {
    if (!el?.ta) return;
    el.ta.value = saved.value;
    el.ta.setSelectionRange(saved.start || 0, saved.end || 0, saved.dir || "none");
    el.tick?.();
    if (el.replyview) el.replyview.scrollTop = saved.replyTop || 0;
  }
  function createHost(options) {
    let child = null, childWindow = null, frame = null, wanted = false, active = false;
    let mac = false, transferring = false, timer = null, failed = false;
    let composing = false, lastPhone = null, recovering = false;
    const doc = options.window.document, win = options.window;
    const status = doc.createElement("div");
    status.id = "phoneviewstatus"; status.setAttribute("role", "status"); status.hidden = true;
    const back = doc.createElement("button");
    back.id = "phoneviewreturn"; back.type = "button"; back.textContent = "Back to phone view"; back.hidden = true;
    doc.body.append(status, back);
    back.addEventListener("click", () => { mac = false; tick(); });
    doc.addEventListener("compositionstart", () => { composing = true; }, true);
    doc.addEventListener("compositionend", () => { composing = false; schedule(); }, true);
    function note(text) { status.textContent = text; status.hidden = !text; }
    function schedule() {
      if (timer) return;
      timer = win.setTimeout(() => { timer = null; tick(); }, 120);
    }
    function mount() {
      if (frame) return;
      frame = doc.createElement("iframe"); frame.id = "phoneview";
      frame.title = "Facilitator phone view";
      frame.hidden = true;
      frame.setAttribute("allow", "clipboard-read; clipboard-write");
      frame.src = "/m?mac=1";
      frame.addEventListener("load", () => {
        if (!child) { failed = true; note("Phone view could not load. Restart the updated server, then reload."); }
        tick();
      });
      frame.addEventListener("error", () => { failed = true; tick(); });
      doc.body.appendChild(frame);
    }
    function show(on) {
      active = on;
      win.macPhoneInactive = on;
      if (childWindow) childWindow.macPhoneInactive = !on;
      frame.hidden = !on;
      doc.body.classList.toggle("phoneview-active", on);
      // Inert siblings preserve their layout boxes for the unchanged fit math.
      for (const el of doc.body.children) {
        if (el === frame || el === status || el === back || el.tagName === "SCRIPT") continue;
        if (on) {
          if (!el.hasAttribute("data-phone-inert")) el.dataset.phoneInert = el.inert ? "1" : "0";
          el.inert = true;
        } else if (el.hasAttribute("data-phone-inert")) {
          el.inert = el.dataset.phoneInert === "1"; delete el.dataset.phoneInert;
        }
      }
      back.hidden = !(mac && wanted);
      if (on) childWindow.focus();
      else win.focus();
    }
    function tick() {
      if (transferring) return;
      if (recovering) {
        if (!options.adapter.ready(lastPhone)) { schedule(); return; }
        try { options.adapter.restore(lastPhone); recovering = false; }
        catch (_) { schedule(); return; }
      }
      const target = wanted && !mac;
      back.hidden = !(mac && wanted);
      if (target && !frame) mount();
      if (target === active) { note(""); return; }
      if (!child) {
        note(failed ? "Phone view could not load. Restart the updated server, then reload." : "Loading phone view…");
        if (!failed) schedule();
        return;
      }
      const from = active ? child : options.adapter, into = target ? child : options.adapter;
      if (composing || from.busy()) {
        note("Keeping this view until typing, attachments or sends are finished. Retry or remove any failed item.");
        schedule(); return;
      }
      const snapshot = from.capture();
      if (!into.ready(snapshot)) { note("Waiting for the board before switching views…"); schedule(); return; }
      transferring = true;
      try {
        from.prepare?.();
        const state = from.capture(); // includes attachments prepared above
        into.restore(state);
        if (active) lastPhone = state;
        show(target);
        into.focus?.(state);
        note("");
      } catch (_) {
        note("Keeping your draft here until the other view is ready.");
        schedule();
        return;
      } finally { transferring = false; }
      options.changed?.();
    }
    return {
      request(on) { wanted = !!on; if (!wanted) mac = false; tick(); },
      connect(source, adapter) {
        if (!frame || source !== frame.contentWindow) return false;
        try { if (source.location.origin !== win.location.origin) return false; }
        catch (_) { return false; }
        childWindow = source; child = adapter; failed = false;
        source.macPhoneInactive = !active;
        options.childConnected?.(source);
        tick(); return true;
      },
      accepts(source) { return !!frame && source === frame.contentWindow; },
      openMac() { mac = true; tick(); },
      current() { return active && child ? child.capture() : null; },
      active() { return active; },
      refresh: tick,
      lost(source) {
        if (source !== childWindow) return;
        if (active) {
          // pagehide can follow a navigation or the whole app closing. Take
          // a final text copy even if preparing an attachment or repaint fails.
          try { if (!child.busy()) child.prepare?.(); } catch (_) {}
          lastPhone = child.capture();
          try { options.adapter.restore(lastPhone); }
          catch (_) { recovering = true; schedule(); }
          show(false);
        }
        child = null; childWindow = null; failed = true;
        note("Phone view closed. Your words are kept on the Mac board. Reload to reconnect.");
      },
    };
  }
  root.MacPhoneView = { portrait, readDrafts, writeDraft, createHost };
})(globalThis);
