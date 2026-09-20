// What the moon must do, proved against the shared helper the two pages call.
// Everything here is an invented local fixture: an invented board, invented
// cards and an invented clock. Nothing runs against the real board.
//
//   node --test author/tests/
//
// The assertions are about what is on screen, which list the card is in, which
// requests the board received and what state the board ends in. Where a
// timing claim is made it is made on the virtual clock: "at once" means in the
// same turn as the tap, with no clock advanced and nothing awaited.
//
// Two things the fixture is careful about, because two defects lived in the gap
// between them. A request ARRIVES at the board on its own schedule, and the
// caller's promise ENDS on its own: a deadline or a network failure ends the
// second without touching the first, so an abandoned command still arrives and
// is still acted on. And an answer is only an acknowledgment when it says so;
// a status is not an answer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { openPage, heldTaps } from "./fixture.mjs";

const parkCalls = board => board.asked("/park").map(e => e.params.v);

test("destination keys hold their latest value while an earlier park request travels", async () => {
  const { clock, board, ctx, page } = await openPage();
  board.delays["/park"] = 2500;

  ctx.setCardDestination("1", "deferred");
  ctx.setCardDestination("1", "deferred");
  assert.equal(page.parked("1"), true);
  assert.deepEqual(parkCalls(board), ["1"], "a repeated S sent a second park request");

  await clock.advance(100);
  ctx.setCardDestination("1", "doing");
  assert.equal(page.parked("1"), false, "N did not restore Doing on screen at once");
  await clock.advance(4900);
  assert.equal(board.box("1").parked, false, "the board kept the earlier Deferred value");
  assert.deepEqual(parkCalls(board), ["1", "0"], "the two destinations were not ordered");
});

test("the first snooze is on screen at once, with the request 2.5 seconds out", async () => {
  const { clock, board, ctx, page } = await openPage();
  board.delays["/park"] = 2500;

  const at = clock.ms;
  page.tap("1");
  assert.equal(clock.ms, at, "nothing was waited for");
  assert.ok(page.parked("1"), "the card is snoozed on screen in the same turn as the tap");
  assert.ok(page.waiting("1"), "and says the board has not answered yet");
  assert.deepEqual(page.list, ["2"], "and has left the doing list at once");
  assert.equal(board.box("1").parked, false, "the board has not been told yet, and nothing pretends it has");

  await clock.advance(2499);
  assert.ok(page.parked("1"), "still snoozed while the request travels");
  assert.equal(board.box("1").parked, false);

  await clock.advance(1);
  assert.equal(board.box("1").parked, true, "the board has it at 2500ms");
  assert.ok(page.parked("1"));
  assert.equal(page.waiting("1"), false, "and the card stops saying it is unconfirmed");
  assert.deepEqual(parkCalls(board), ["1"]);
  assert.equal(heldTaps(ctx).length, 0, "the hold is released once a reading carries it back");
});

test("a second tap during that delay unsnoozes at once and the board ends unsnoozed", async () => {
  const { clock, board, ctx, page } = await openPage();
  board.delays["/park"] = 2500;

  page.tap("1");
  await clock.advance(500);
  assert.ok(page.parked("1"));

  const at = clock.ms;
  page.tap("1");
  assert.equal(clock.ms, at);
  assert.equal(page.parked("1"), false, "the reversal is on screen in the same turn");
  assert.deepEqual(page.list, ["1", "2"], "and the card is back in the doing list");

  await clock.advance(2000);   // the first request lands: the board parks the card
  assert.equal(board.box("1").parked, true);
  assert.equal(page.parked("1"), false, "what the board is doing about an undone tap is not what the card shows");

  await page.pollNow();        // a reading that carries the board's parked card
  assert.equal(page.parked("1"), false, "and a reading of it does not put the snooze back");

  await clock.advance(2500);   // the second value goes out when the first answers
  assert.equal(board.box("1").parked, false, "the board ends where the last tap asked");
  assert.equal(page.parked("1"), false);
  assert.deepEqual(parkCalls(board), ["1", "0"], "both values were sent, one at a time");
  assert.equal(heldTaps(ctx).length, 0);
});

test("three rapid taps end snoozed, on screen and on the board", async () => {
  const { clock, board, ctx, page } = await openPage();
  board.delays["/park"] = 2500;

  page.tap("1");
  assert.ok(page.parked("1"));
  await clock.advance(50);
  page.tap("1");
  assert.equal(page.parked("1"), false);
  await clock.advance(50);
  page.tap("1");
  assert.ok(page.parked("1"), "the third tap is on screen at once too");
  assert.deepEqual(page.list, ["2"]);

  await clock.advance(5000);
  assert.equal(board.box("1").parked, true, "the board ends where the last tap asked");
  assert.ok(page.parked("1"));
  assert.deepEqual(parkCalls(board), ["1"],
    "one request carried the value the taps settled on; none were sent and undone");
  assert.equal(heldTaps(ctx).length, 0);
});

test("a reading asked for before the board answered may not repaint the card", async () => {
  const { clock, board, ctx, page } = await openPage();
  board.delays["/m/state"] = 3000;   // a reading of the board as it stood at the ask
  board.delays["/park"] = 2500;
  board.rev++;                       // something elsewhere moved, so this reading is a full one

  const older = page.poll();   // asked now, answering 3000ms later from the board as it stands now
  await clock.advance(100);
  page.tap("1");               // tapped at 100, so the snooze reaches the board at 2600
  await clock.advance(2500);
  assert.equal(board.box("1").parked, true, "the snooze reached the board 2500ms after the tap");
  assert.ok(page.parked("1"));

  await clock.advance(400);    // 3000: the older reading lands, after the answer it predates
  await older;
  assert.ok(page.parked("1"), "the older reading knew nothing of this card and changed nothing");
  assert.deepEqual(page.list, ["2"]);

  await clock.advance(3000);   // and the reading asked for after the answer arrives in its turn
  assert.ok(page.parked("1"));
  assert.equal(heldTaps(ctx).length, 0, "a reading new enough to judge the tap settles it");
});

test("a snooze the board had and something newer undid follows the board, not the tap", async () => {
  const { clock, board, ctx, page } = await openPage();
  board.refuse = { path: "/m/state", status: 503, times: 1 };   // the settling reading does not get through

  page.tap("1");
  await clock.advance(5);
  assert.ok(page.parked("1"));
  assert.equal(board.box("1").parked, true);
  assert.equal(heldTaps(ctx).length, 1, "still held, since no reading has carried it back");

  board.send("1", "one more thing");   // a message opens the card again on the board
  await page.pollNow();
  assert.equal(page.parked("1"), false, "the held tap does not put back a card the board has since changed");
  assert.ok(page.list.includes("1"));
  assert.equal(heldTaps(ctx).length, 0);
});

test("a refused request goes back to the board's word, says so, and the same chip retries", async () => {
  const { clock, board, page } = await openPage();
  board.delays["/park"] = 300;
  board.refuse = { path: "/park", status: 503, times: 1 };

  page.tap("1");
  assert.ok(page.parked("1"));
  await clock.advance(305);

  assert.equal(page.parked("1"), false, "a definite refusal is not a snooze");
  assert.equal(page.waiting("1"), false);
  assert.deepEqual(page.list, ["1", "2"]);
  assert.match(page.note("1"), /snooze failed \(503\)/);
  assert.match(page.note("1"), /try again/);
  assert.equal(page.card("1").meta.dataset.flagnote, "1",
    "the phone has one note node, and the guard its own pass reads sits on it");

  board.send("2", "an unrelated message");   // the next reading is a full one and redraws every card
  await page.pollNow();
  assert.match(page.note("1"), /snooze failed \(503\)/, "a reading that knows nothing of it may not wipe it");

  page.tap("1");
  assert.equal(page.note("1"), "", "the retry answers the note");
  assert.equal(page.card("1").meta.dataset.flagnote, undefined, "and takes its guard off the same node");
  assert.ok(page.parked("1"));
  await clock.advance(305);
  assert.equal(board.box("1").parked, true, "and the same chip carried the same intent through");
  assert.equal(page.note("1"), "");
});

test("an answer that never came takes nothing back, and a reading that agrees settles it", async () => {
  const { clock, board, ctx, page } = await openPage();
  board.delays["/m/state"] = 1500;
  board.mute = { path: "/park", times: 1 };   // the board gets it; the answer never comes back

  page.tap("1");
  await clock.advance(1000);
  assert.equal(board.box("1").parked, true, "the board had it all along; only the answer was lost");

  await clock.advance(6999);
  assert.ok(page.parked("1"));
  assert.ok(page.waiting("1"));

  await clock.advance(1);   // the request's own deadline, 8s from the tap
  assert.ok(page.parked("1"), "a lost answer is not a refusal and takes nothing back");
  assert.ok(page.waiting("1"), "the card still says the board has not confirmed it");
  assert.equal(page.note("1"), "", "and nothing is reported that has not happened");

  await clock.advance(1500);   // the reading that deadline asked for
  assert.ok(page.parked("1"));
  assert.equal(page.waiting("1"), false, "a reading that agrees settles it with no note at all");
  assert.equal(heldTaps(ctx).length, 0);
});

test("an unconfirmed tap is held while readings are asked, then ends at its window", async () => {
  const { clock, board, page } = await openPage();
  board.drop = { path: "/park", times: 1 };   // never answered, and never applied either

  page.tap("1");
  await clock.advance(8000);
  assert.ok(page.parked("1"));

  for (let i = 0; i < 5; i++){ page.poll(); await clock.advance(2000); }
  assert.ok(page.parked("1"), "readings saying otherwise do not end an unconfirmed tap early");
  assert.ok(page.waiting("1"));

  await clock.advance(2500);   // past 20s from the tap
  assert.equal(page.parked("1"), false, "the card goes back to the board's word rather than lying on");
  assert.match(page.note("1"), /snooze not confirmed/);
  assert.match(page.note("1"), /try again/);
  assert.deepEqual(page.list, ["1", "2"]);
});

test("a tap made while a request is out is what goes next, once that one is over", async () => {
  const { clock, board, page } = await openPage();
  board.drop = { path: "/park", times: 1 };

  page.tap("1");
  await clock.advance(1000);
  page.tap("1");
  assert.equal(page.parked("1"), false);
  assert.deepEqual(parkCalls(board), ["1"], "one request per card at a time");

  await clock.advance(7000);   // the first request's deadline
  assert.deepEqual(parkCalls(board), ["1", "0"], "the latest intent is what is sent next");

  await clock.advance(5);
  assert.equal(board.box("1").parked, false);
  assert.equal(page.parked("1"), false);
  assert.equal(page.note("1"), "", "the latest tap went through, so there is nothing to report");
});

// ---- the order of this page's own commands -----------------------------------
// Giving up on an answer does not recall the request. These are about what the
// board does with a command that outlives the page's patience.

test("a snooze the page gave up on cannot undo the unsnooze that replaced it", async () => {
  const { clock, board, page } = await openPage();
  // the snooze crawls, the unsnooze that replaces it goes straight through, and
  // the snooze arrives last: the board sees them in the wrong order
  board.delayQueue["/park"] = [12000, 500];

  page.tap("1");
  assert.ok(page.parked("1"));
  await clock.advance(8000);   // the page's own deadline: it stops waiting for an answer
  assert.ok(page.parked("1"), "giving up on an answer takes nothing back");
  assert.equal(board.box("1").parked, false, "and the board has not been reached yet either");

  // a fresh reading arrives, and it says unsnoozed, because the snooze is still
  // travelling. The reversal below therefore asks for a value this reading
  // already shows, which is exactly when a tap is easiest to lose
  await page.pollNow();
  assert.ok(page.parked("1"), "the reading is older than this page's own command and repaints nothing");

  page.tap("1");
  assert.equal(page.parked("1"), false, "the reversal is immediate, with the first still in flight");
  assert.equal(board.asked("/park").length, 2, "and it is actually sent, not swallowed as unnecessary");
  await clock.advance(500);
  assert.equal(board.box("1").parked, false, "the unsnooze is in and acknowledged");

  await clock.advance(4000);   // the abandoned snooze finally arrives, long after
  const parks = board.asked("/park");
  assert.equal(parks.length, 2);
  assert.ok(parks[0].delivered > parks[1].delivered, "the older request really did arrive last");
  assert.equal(parks[0].answer.stale, "superseded",
    "and the board refused a place in this page's stream that it had already passed");
  assert.equal(board.box("1").parked, false, "so the board finishes where the last tap asked");
  assert.equal(page.note("1"), "", "and nothing is reported: nothing about his last tap failed");

  await page.pollNow();
  assert.equal(page.parked("1"), false, "and the reading after it shows the same");
});

test("one page's place is not erased by another page touching the same card", async () => {
  const { board } = await openPage();
  board.fetchSync("/park?box=1&v=1");   // the card starts snoozed, by a caller that names no order
  assert.equal(board.box("1").parked, true);

  // page A's newer intent: unsnooze, place 2
  assert.equal(board.fetchSync("/park?box=1&v=0&sid=pagea&seq=2")[1].ok, true);
  assert.equal(board.box("1").parked, false);
  // page B's first command in its own stream, also unsnooze: applied, since
  // nothing of B's has been replaced
  assert.equal(board.fetchSync("/park?box=1&v=0&sid=pageb&seq=1")[1].ok, true);
  assert.equal(board.box("1").parked, false);
  // page A's abandoned snooze, place 1, arriving last. It is obsolete inside
  // A's own stream, and B having touched the card since does not revive it
  const [status, answer] = board.fetchSync("/park?box=1&v=1&sid=pagea&seq=1");
  assert.equal(status, 200);
  assert.equal(answer.ok, false);
  assert.equal(answer.stale, "superseded");
  assert.equal(board.box("1").parked, false, "and the card is left unsnoozed");
});

test("a page not yet superseded in its own stream still writes last", async () => {
  const { board } = await openPage();
  assert.equal(board.fetchSync("/park?box=1&v=0&sid=pagea&seq=2")[1].ok, true);
  const [, answer] = board.fetchSync("/park?box=1&v=1&sid=pageb&seq=1");
  assert.equal(answer.ok, true, "two devices stay last writer wins, exactly as they were");
  assert.equal(board.box("1").parked, true);
});

test("a command that names half an order, or a place that is not a number, is refused", async () => {
  const { clock, board, page } = await openPage();
  page.tap("1");
  await clock.advance(5);
  const sent = board.asked("/park")[0].params;
  assert.ok(sent.sid, "every command names this page's stream");
  assert.equal(sent.seq, "1", "and its place in it");

  assert.deepEqual(board.fetchSync("/park?box=1&v=1&sid=onlyaname"), [400, { error: "bad park order" }]);
  assert.deepEqual(board.fetchSync("/park?box=1&v=1&seq=4"), [400, { error: "bad park order" }]);
  assert.deepEqual(board.fetchSync("/park?box=1&v=1&sid=abc&seq=later"), [400, { error: "bad park order" }]);
  assert.equal(board.fetchSync("/park?box=1&v=0")[0], 200, "and a caller that names none is served as before");
  assert.equal(board.box("1").parked, false);
});

// ---- what counts as the board saying yes --------------------------------------

test("an unreadable answer is not an acknowledgment, and takes nothing back", async () => {
  const { clock, board, ctx, page } = await openPage();
  board.delays["/m/state"] = 1500;                       // readings are not instant here
  board.answers.push({ path: "/park", broken: true });   // applied; the answer will not parse

  page.tap("1");
  await clock.advance(5);
  assert.equal(board.box("1").parked, true, "the board did do it");
  assert.ok(page.parked("1"), "and nothing is taken back, since it may well have");
  assert.ok(page.waiting("1"), "but an answer that cannot be read is not a yes");
  assert.equal(page.note("1"), "", "and nothing is claimed either way");

  await clock.advance(1500);   // the reading this page asked for the moment it stopped knowing
  assert.ok(page.parked("1"));
  assert.equal(page.waiting("1"), false, "the reading that agrees is what settles it");
  assert.equal(page.note("1"), "");
  assert.equal(heldTaps(ctx).length, 0);
});

test("an empty answer on an unchanged board ends as not confirmed, never as a snooze", async () => {
  const { clock, board, page } = await openPage();
  board.answers.push({ path: "/park", body: {}, apply: false });   // 200, and nothing done

  page.tap("1");
  await clock.advance(5);
  assert.ok(page.parked("1"));
  assert.ok(page.waiting("1"), "2xx with an empty object is not an acknowledgment");
  assert.equal(board.box("1").parked, false);

  for (let i = 0; i < 5; i++){ page.poll(); await clock.advance(2000); }
  assert.ok(page.parked("1"), "and it is not torn down early either");

  await clock.advance(10500);   // past the window, counted from the tap
  assert.equal(page.parked("1"), false, "the board never had it, and the card ends up saying so");
  assert.match(page.note("1"), /snooze not confirmed/);
  assert.deepEqual(page.list, ["1", "2"]);
});

test("an explicit no with no reason is a refusal, and the chip asks again at once", async () => {
  const { clock, board, page } = await openPage();
  board.answers.push({ path: "/park", body: { ok: false }, apply: false });

  page.tap("1");
  await clock.advance(5);
  assert.equal(page.parked("1"), false, "the board said plainly that it did not do it");
  assert.equal(page.waiting("1"), false);
  assert.match(page.note("1"), /snooze refused by the board/);
  assert.match(page.note("1"), /try again/);

  page.tap("1");
  assert.ok(page.parked("1"), "and the next tap is there immediately");
  await clock.advance(5);
  assert.equal(board.box("1").parked, true);
  assert.equal(page.note("1"), "");
});

test("an older board's plain yes is still a yes", async () => {
  const { clock, board, page } = await openPage();
  board.answers.push({ path: "/park", body: { ok: true } });   // no parked, no rev, as it used to be

  page.tap("1");
  await clock.advance(5);
  assert.ok(page.parked("1"));
  assert.equal(page.waiting("1"), false, "ok:true is all an older board ever sent, and it is enough");
  assert.equal(page.note("1"), "");
  assert.equal(board.box("1").parked, true);
});

test("an answer naming this page's own newer tap says nothing to him, and the board still rules", async () => {
  const { clock, board, page } = await openPage();
  board.answers.push({ path: "/park", body: { ok: false, stale: "superseded", parked: true }, apply: false });

  page.tap("1");
  await clock.advance(5);
  assert.ok(page.parked("1"), "the answer names the value the card is already showing");
  assert.equal(page.waiting("1"), false);
  assert.equal(page.note("1"), "", "nothing failed, so nothing is reported");

  board.send("2", "an unrelated message");   // the next reading is a full one
  await page.pollNow();
  assert.equal(page.parked("1"), false, "and a later reading is authoritative, as always");
});

test("a tap is immediate while the last answer is still uncertain", async () => {
  const { clock, board, page } = await openPage();
  board.delays["/m/state"] = 1500;                       // no reading arrives to settle it
  board.answers.push({ path: "/park", broken: true });   // applied, but unreadable

  page.tap("1");
  await clock.advance(5);
  assert.ok(page.parked("1"));
  assert.ok(page.waiting("1"));
  assert.equal(board.box("1").parked, true);

  const at = clock.ms;
  page.tap("1");
  assert.equal(clock.ms, at);
  assert.equal(page.parked("1"), false, "an uncertain outcome does not hold the chip");
  assert.equal(board.asked("/park").length, 2, "and the reversal is sent, not swallowed");
  await clock.advance(5);
  assert.equal(board.box("1").parked, false, "and the board follows the latest tap");
  assert.equal(page.waiting("1"), false, "with a plain yes this time");
  assert.equal(page.note("1"), "");
});

test("a reversal after an empty answer is sent, even with a reading agreeing in between", async () => {
  const { clock, board, page } = await openPage();
  board.answers.push({ path: "/park", body: {}, apply: false });   // 200, and nothing done

  page.tap("1");
  await clock.advance(5);
  assert.ok(page.parked("1"));
  assert.ok(page.waiting("1"), "nobody has confirmed anything");

  board.send("2", "an unrelated message");   // the board moves elsewhere
  await page.pollNow();                      // a full reading, and it says this card is unsnoozed
  assert.ok(page.parked("1"), "the reading brings no answer to this page's own command");

  page.tap("1");
  assert.equal(page.parked("1"), false, "the reversal is immediate");
  assert.equal(board.asked("/park").length, 2,
    "and it is sent, though the value it asks for is the one the reading just showed");
  await clock.advance(5);
  assert.equal(board.box("1").parked, false);
  assert.equal(page.waiting("1"), false);
  assert.equal(page.note("1"), "");
});

test("snoozing the selected Doing card advances while Deferred browsing stays put", async () => {
  const { clock, board, page } = await openPage();
  board.delays["/park"] = 2500;
  page.select("1");
  assert.deepEqual(page.list, ["1", "2"]);

  page.tap("1");
  assert.deepEqual(page.list, ["2"], "the doing tab loses it at once");
  assert.equal(page.selected(), "2", "the next Doing card takes the screen");
  assert.ok(page.card("1"), "the Deferred card remains available to browse");

  page.setView("deferred");
  assert.deepEqual(page.list, ["1"], "the deferred tab has it at once, before any answer");
  page.select("1");

  page.tap("1");
  assert.deepEqual(page.list, [], "and loses it again on the reversing tap");
  assert.equal(page.selected(), "1", "deliberate Deferred browsing keeps its selection");
  page.setView("todo");
  assert.deepEqual(page.list, ["1", "2"]);

  await clock.advance(6000);
  assert.equal(board.box("1").parked, false);
  assert.deepEqual(page.list, ["1", "2"], "and the board's answers change nothing that was already right");
  assert.equal(page.selected(), "1");
});

test("a message that reaches the board first keeps the card open, and says why", async () => {
  const { clock, board, page } = await openPage();
  board.delays["/park"] = 2500;

  page.tap("1");
  await clock.advance(500);
  board.send("1", "one more thing");   // his message arrives while the snooze travels
  await clock.advance(2000);

  assert.equal(board.box("1").parked, false, "a card just written to is not buried under a snooze");
  assert.equal(board.box("1").pending.length, 1, "and the message is still there");
  assert.equal(page.parked("1"), false);
  assert.match(page.note("1"), /snooze skipped: a new message arrived/);

  await page.pollNow();
  assert.ok(page.list.includes("1"));
  assert.match(page.note("1"), /a new message arrived/, "the reason survives the readings after it");
});

test("a message already on the card is no reason to refuse a snooze", async () => {
  const { clock, board, page } = await openPage();
  board.send("2", "sent a moment ago");   // and not yet read by this page
  board.delays["/park"] = 2500;
  await clock.advance(50);

  page.tap("2");
  await clock.advance(2505);
  assert.equal(board.box("2").parked, true, "the basis is the moment of the tap, not the age of the reading");
});

test("a card deleted while a snooze travels is simply gone", async () => {
  const { clock, board, ctx, page } = await openPage();
  board.delays["/park"] = 1000;

  page.tap("1");
  assert.ok(page.parked("1"));
  board.remove("1");
  await clock.advance(1005);

  assert.equal(heldTaps(ctx).length, 0, "there is nothing left to hold");
  await page.pollNow();
  assert.equal(page.card("1"), undefined);
  assert.deepEqual(page.list, ["2"]);
  assert.deepEqual(page.problems, [], "and nothing threw on the way");
});

test("the desktop and its small card get the same immediacy from the same helper", async () => {
  const { clock, board, page } = await openPage("desktop");
  board.delays["/park"] = 2500;

  page.tapMini("1");   // the chip on the small card in the corner
  assert.ok(page.parked("1"), "the large card follows the small card's chip at once");
  assert.equal(page.section("1"), "later", "and the card is filed under deferred at once");
  assert.equal(page.toc("1"), "t-later");
  assert.ok(page.waiting("1"));

  await clock.advance(100);
  await page.pollNow();
  assert.ok(page.parked("1"), "a poll in the middle of it puts nothing back");

  await clock.advance(2500);
  assert.equal(board.box("1").parked, true);
  assert.equal(page.waiting("1"), false);

  board.delays["/park"] = 0;
  board.refuse = { path: "/park", status: 500, times: 1 };
  page.tap("1");   // the large card's own chip, unsnoozing
  assert.equal(page.parked("1"), false);
  await clock.advance(5);
  assert.ok(page.parked("1"), "a refused unsnooze goes back to the board's word");
  assert.match(page.note("1"), /unsnooze failed \(500\)/);
  await page.pollNow();
  assert.match(page.note("1"), /unsnooze failed/, "the desktop's note line is left alone by its poll too");
  assert.deepEqual(page.problems, []);
});

test("the desktop note is the card's own note element, and it stays that node", async () => {
  const { clock, board, page } = await openPage("desktop");
  const el = page.card("1");
  // the shape this is about: the note element is a child of a box the card
  // also holds a name for, so writing to the wrong name destroys the other
  assert.equal(el.metaNote.parentNode, el.meta);
  assert.ok(el.meta.children.includes(el.metaNote));

  board.refuse = { path: "/park", status: 503, times: 1 };
  page.tap("1");
  await clock.advance(5);

  assert.match(el.metaNote.textContent, /snooze failed \(503\)/, "the reason goes to the note element");
  assert.equal(el.metaNote.dataset.flagnote, "1", "and the guard this page's own pass reads is on it");
  assert.equal(el.meta.dataset.flagnote, undefined, "nothing is written onto the box that holds it");
  assert.equal(el.metaNote.parentNode, el.meta, "and the note element is still inside that box");
  assert.equal(page.card("1").metaNote, el.metaNote, "the card still holds the node it always held");

  await page.pollNow();
  assert.match(el.metaNote.textContent, /snooze failed \(503\)/, "a poll leaves the reason where it is");
  assert.equal(el.metaNote.parentNode, el.meta, "and leaves the node attached");
  assert.equal(page.card("1").metaNote, el.metaNote, "and is still the same node, not a replacement");

  page.tap("1");   // the retry, available at once
  assert.ok(page.parked("1"), "the retry paints immediately");
  assert.equal(el.metaNote.textContent, "", "and clears the very node the reason was written to");
  assert.equal(el.metaNote.dataset.flagnote, undefined, "taking its guard off with it");
  assert.equal(el.metaNote.parentNode, el.meta, "with the node still attached to its box");
  await clock.advance(5);
  assert.equal(board.box("1").parked, true, "and the retry itself goes through");
  assert.equal(page.card("1").metaNote, el.metaNote);
});

test("a board that names no clock is asked the way it always was", async () => {
  const { clock, board, page } = await openPage("desktop");
  board.carryNow = false;   // an older board, or one that has not been updated
  await page.pollNow();

  page.tap("2");
  await clock.advance(5);
  const last = board.asked("/park").at(-1);
  assert.equal(last.params.after, undefined, "no basis is sent when no reading has carried the board's clock");
  assert.equal(board.box("2").parked, true, "and the snooze goes through exactly as before");
  assert.ok(page.parked("2"));
});
