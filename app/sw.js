/* The board page's service worker, which is here so that being offered an
   install never depends on which Chrome is installed.

   Chrome asked for a worker with a real fetch handler before it would offer an
   install for years, and its own install guidance still says so. The Chrome on
   this machine (153) offers the install for this page with no worker at all,
   which was tried three ways: no worker, a worker whose fetch handler does
   nothing, and this one. All three were offered the install. So this file is
   insurance and not a gate, and it is written to cost nothing either way.

   It keeps nothing and stores nothing. The board is live data read over a
   loopback connection, so there is nothing a saved copy could make quicker and
   plenty it could make wrong: a kept page or a kept reading would be a board
   that looked connected while it was not. The phone page's worker is the one
   that keeps a shell, and it stands apart at its own scope (/m); this one is
   registered at / and the longer scope keeps every /m page on the phone's
   worker, controlled by it and not by this.

   The fetch handler below is the whole file. A page open is handed straight to
   the network, and every other request, the board's polling above all, is left
   untouched, so the page runs exactly as it does with no worker at all. It
   really answers a request rather than doing nothing, because a handler that
   does nothing is one Chrome is free to skip, and a skipped handler has counted
   as no handler at all. */

self.addEventListener("fetch", event => {
  if (event.request.mode === "navigate") event.respondWith(fetch(event.request));
});
