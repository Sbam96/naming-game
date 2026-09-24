'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, CATEGORIES, LETTERS } = require('../src/engine');
const { Registry } = require('../src/registry');
const { isOffensive } = require('../src/server');

// ---------- helpers ----------
function seeded(seed = 7) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}
function setup(n = 3, { seed = 7, names } = {}) {
  const ctx = { now: 1_000_000 };
  ctx.room = new Room({ code: 'TEST1', now: ctx.now, rng: seeded(seed), isOffensive });
  ctx.room.settings.maxPlayers = 12; // allow big test rooms
  ctx.players = [];
  for (let i = 0; i < n; i++) ctx.players.push(ctx.room.addPlayer(names?.[i] || `P${i + 1}`, ctx.now).player);
  ctx.ids = ctx.players.map((p) => p.id);
  ctx.host = ctx.ids[0];
  ctx.adv = (secs) => { ctx.now += secs * 1000; ctx.room.tick(ctx.now); return ctx.now; };
  ctx.p = (id) => ctx.room.players.get(id);
  return ctx;
}
const fill = (letter, overrides = {}) => Object.fromEntries(CATEGORIES.map((c) => [c, overrides[c] ?? `${letter}${c}`]));

// start (if needed), pick a letter, submit answers, close answering (everyone done)
function playToVoting(ctx, letter, answersFor = () => null) {
  const { room } = ctx;
  if (room.phase === 'lobby') assert.equal(room.start(ctx.host, ctx.now).ok, true);
  assert.equal(room.phase, 'picking');
  const L = letter || LETTERS.find((x) => !room.usedLetters.has(x));
  assert.equal(room.pickLetter(room.pickerId, L, ctx.now).ok, true);
  for (const id of room.round.participants) {
    const a = answersFor(id) || fill(L);
    for (const c of CATEGORIES) assert.equal(room.setAnswer(id, c, a[c], ctx.now).ok, true);
  }
  for (const id of room.round.participants) if (ctx.p(id).connected) room.setDone(id, true, ctx.now);
  assert.equal(room.phase, 'voting');
  return L;
}
const reviewerOf = (ctx, author) => ctx.room.round.assignments.get(author);
function voteAll(ctx, decide = () => true) {
  const r = ctx.room.round;
  for (const [author, reviewer] of [...r.assignments]) {
    if (!reviewer || r.completed.has(author)) continue;
    const votes = {};
    for (const c of CATEGORIES) if (r.answers[author][c]) votes[c] = decide(author, c);
    assert.equal(ctx.room.submitVotes(reviewer, author, votes, ctx.now).ok, true);
  }
}
function finishRound(ctx) {
  // challenge window -> results -> next picking
  ctx.adv(ctx.room.settings.challengeTime);
  assert.equal(ctx.room.phase, 'results');
  ctx.adv(8);
}
function playFullRound(ctx, decide, letter, answersFor) {
  const L = playToVoting(ctx, letter, answersFor);
  voteAll(ctx, decide);
  finishRound(ctx);
  return L;
}

// ---------- 1. Creating a game room ----------
test('GR-02 creator is host; only the host can start, kick and end the game', () => {
  const ctx = setup(3);
  const { room } = ctx;
  assert.equal(room.hostId, ctx.host);
  assert.equal(room.viewFor(ctx.host, ctx.now).you.isHost, true);
  assert.equal(room.viewFor(ctx.ids[1], ctx.now).you.isHost, false);
  assert.equal(room.start(ctx.ids[1], ctx.now).error, 'not_host');
  assert.equal(room.kick(ctx.ids[1], ctx.ids[2], ctx.now).error, 'not_host');
  assert.equal(room.kick(ctx.host, ctx.ids[2], ctx.now).ok, true);
  assert.equal(room.players.has(ctx.ids[2]), false);
  assert.equal(room.start(ctx.host, ctx.now).ok, true);
  assert.equal(room.endGame(ctx.ids[1], ctx.now).error, 'not_host');
  assert.equal(room.endGame(ctx.host, ctx.now).ok, true);
});

test('GR-04 defaults are 50s answer, 20s pick, 30s review, 30s challenge; out-of-range values rejected', () => {
  const { room, host } = setup(2);
  assert.deepEqual(
    { a: room.settings.answerTime, p: room.settings.pickTime, r: room.settings.reviewFallback, c: room.settings.challengeTime },
    { a: 50, p: 20, r: 30, c: 30 });
  for (const bad of [{ answerTime: 19 }, { answerTime: 61 }, { maxPlayers: 1 }, { maxPlayers: 13 }, { answerTime: 30.5 }]) {
    assert.equal(room.updateSettings(host, bad).error, 'invalid_setting', JSON.stringify(bad));
  }
  assert.equal(room.updateSettings(host, { answerTime: 20, maxPlayers: 12 }).ok, true);
  assert.equal(room.updateSettings(host, { answerTime: 60, maxPlayers: 2 }).ok, true);
  assert.equal(room.settings.answerTime, 60);
});

test('GR-05 settings are locked once the game starts', () => {
  const ctx = setup(2);
  ctx.room.start(ctx.host, ctx.now);
  assert.equal(ctx.room.updateSettings(ctx.host, { answerTime: 30 }).error, 'settings_locked');
  assert.equal(ctx.room.updateSettings(ctx.host, { visibility: 'public' }).error, 'settings_locked');
});

test('GR-06 host can start with the defaults in one action', () => {
  const ctx = setup(2);
  assert.equal(ctx.room.start(ctx.host, ctx.now).ok, true);
  ctx.room.pickLetter(ctx.room.pickerId, 'B', ctx.now);
  assert.equal(ctx.room.deadline - ctx.now, 50_000);
});

test('GR-07 when the host leaves, the longest-joined player becomes host', () => {
  const ctx = setup(3);
  ctx.room.leave(ctx.host, ctx.now);
  assert.equal(ctx.room.hostId, ctx.ids[1]);
  // and after a disconnect longer than the grace period
  const c2 = setup(3);
  c2.room.disconnect(c2.host, c2.now);
  c2.adv(10);
  assert.equal(c2.room.hostId, c2.host);
  c2.adv(11);
  assert.equal(c2.room.hostId, c2.ids[1]);
});

test('GR-08 the room locks to new players when the game starts', () => {
  const ctx = setup(2);
  ctx.room.start(ctx.host, ctx.now);
  assert.equal(ctx.room.addPlayer('Late', ctx.now).error, 'in_progress');
});

test('GR-09 the room closes when the last participant leaves', () => {
  const reg = new Registry({ isOffensive });
  const { room, player } = reg.create({ hostName: 'Ste', now: 0 });
  const guest = room.addPlayer('Ade', 0).player;
  room.leave(guest.id, 0);
  assert.equal(room.closed, false);
  room.leave(player.id, 0);
  reg.sweep();
  assert.equal(room.closed, true);
  assert.equal(reg.get(room.code), null);
  assert.equal(reg.status(room.code).status, 'closed');
});

test('GR-10 a new game can start after a game ends if 2+ players are present; not with 1', () => {
  const ctx = setup(2);
  ctx.room.start(ctx.host, ctx.now);
  ctx.room.endGame(ctx.host, ctx.now);
  assert.equal(ctx.room.phase, 'final');
  ctx.room.disconnect(ctx.ids[1], ctx.now);
  assert.equal(ctx.room.restart(ctx.host, ctx.now).error, 'not_enough_players');
  ctx.room.rejoin(ctx.p(ctx.ids[1]).token, ctx.now);
  assert.equal(ctx.room.restart(ctx.host, ctx.now).ok, true);
  assert.equal(ctx.room.phase, 'picking');
});

// ---------- 2. Sharing link ----------
test('SL-01 each room gets a unique short code', () => {
  const reg = new Registry({ isOffensive });
  const codes = new Set();
  for (let i = 0; i < 500; i++) {
    const { room } = reg.create({ hostName: `H${i}`, now: 0 });
    assert.match(room.code, /^[A-HJ-NP-Z2-9]{5}$/);
    codes.add(room.code);
  }
  assert.equal(codes.size, 500);
});

test('SL-05 a new room gets a new code and the old code stops working', () => {
  const reg = new Registry({ isOffensive });
  const first = reg.create({ hostName: 'Ste', now: 0 });
  first.room.leave(first.player.id, 0);
  reg.sweep();
  const second = reg.create({ hostName: 'Ste', now: 0 });
  assert.notEqual(second.room.code, first.room.code);
  assert.equal(reg.status(first.room.code).status, 'closed');
  assert.equal(reg.closedCodes.has(first.room.code), true);
});

// ---------- 3. Joining ----------
test('JG-03 players cannot join a full room', () => {
  const ctx = setup(2);
  ctx.room.updateSettings(ctx.host, { maxPlayers: 2 });
  assert.equal(ctx.room.addPlayer('Extra', ctx.now).error, 'full');
  assert.equal(ctx.room.players.size, 2);
});

test('JG-05 duplicate display names are auto-suffixed', () => {
  const ctx = setup(0);
  ctx.room.addPlayer('Ste', ctx.now);
  assert.equal(ctx.room.addPlayer('Ste', ctx.now).player.name, 'Ste 2');
  assert.equal(ctx.room.addPlayer('ste', ctx.now).player.name, 'ste 3');
});

test('JG-06 a disconnected player rejoins mid-game and keeps their score', () => {
  const ctx = setup(3);
  playFullRound(ctx, () => true);
  const p = ctx.p(ctx.ids[1]);
  const score = p.score;
  assert.ok(score > 0);
  ctx.room.disconnect(p.id, ctx.now);
  const res = ctx.room.rejoin(p.token, ctx.now);
  assert.equal(res.ok, true);
  assert.equal(res.player.score, score);
  assert.equal(p.connected, true);
});

test('JG-07 nobody new can join or watch once the game has started', () => {
  const ctx = setup(2);
  ctx.room.start(ctx.host, ctx.now);
  assert.equal(ctx.room.addPlayer('Watcher', ctx.now).error, 'in_progress');
  assert.equal(ctx.room.rejoin('not-a-real-token', ctx.now).error, 'in_progress');
});

// ---------- 4. Responding ----------
test('PR-01 every round uses Name, Food, Animal, Place, Thing in that order', () => {
  const ctx = setup(2);
  ctx.room.start(ctx.host, ctx.now);
  ctx.room.pickLetter(ctx.room.pickerId, 'V', ctx.now);
  assert.deepEqual(ctx.room.viewFor(ctx.host, ctx.now).categories, ['name', 'food', 'animal', 'place', 'thing']);
  assert.deepEqual(Object.keys(ctx.room.round.answers[ctx.host]), ['name', 'food', 'animal', 'place', 'thing']);
});

test('PR-02 players enter one answer per category', () => {
  const ctx = setup(2);
  ctx.room.start(ctx.host, ctx.now);
  ctx.room.pickLetter(ctx.room.pickerId, 'V', ctx.now);
  for (const c of CATEGORIES) ctx.room.setAnswer(ctx.host, c, `V${c}`, ctx.now);
  assert.deepEqual(ctx.room.round.answers[ctx.host], fill('V'));
  assert.equal(ctx.room.setAnswer(ctx.host, 'colour', 'Violet', ctx.now).error, 'invalid_category');
});

test('PR-03 answers are hidden from other players until the round closes', () => {
  const ctx = setup(2);
  ctx.room.start(ctx.host, ctx.now);
  ctx.room.pickLetter(ctx.room.pickerId, 'V', ctx.now);
  ctx.room.setAnswer(ctx.host, 'animal', 'Vulture', ctx.now);
  const other = JSON.stringify(ctx.room.viewFor(ctx.ids[1], ctx.now));
  assert.equal(other.includes('Vulture'), false);
  assert.equal(JSON.stringify(ctx.room.viewFor(ctx.host, ctx.now)).includes('Vulture'), true);
});

test('PR-04 answers stay editable until the timer expires, then submit and lock', () => {
  const ctx = setup(2);
  ctx.room.start(ctx.host, ctx.now);
  ctx.room.pickLetter(ctx.room.pickerId, 'V', ctx.now);
  ctx.room.setAnswer(ctx.host, 'food', 'Vinegar', ctx.now);
  ctx.adv(40);
  ctx.room.setAnswer(ctx.host, 'food', 'Vanilla Ice Cream', ctx.now);
  assert.equal(ctx.room.round.answers[ctx.host].food, 'Vanilla Ice Cream');
  ctx.adv(10);
  assert.equal(ctx.room.phase, 'voting');
  assert.equal(ctx.room.setAnswer(ctx.host, 'food', 'Veal', ctx.now).ok, false);
  assert.equal(ctx.room.round.answers[ctx.host].food, 'Vanilla Ice Cream');
});

test('PR-05 answers are limited to 3 words and 25 characters', () => {
  const ctx = setup(2);
  ctx.room.start(ctx.host, ctx.now);
  ctx.room.pickLetter(ctx.room.pickerId, 'V', ctx.now);
  assert.equal(ctx.room.setAnswer(ctx.host, 'food', 'Vanilla Ice Cream', ctx.now).ok, true);
  assert.equal(ctx.room.setAnswer(ctx.host, 'place', 'Vatican City', ctx.now).ok, true);
  assert.equal(ctx.room.setAnswer(ctx.host, 'food', 'Very Vanilla Ice Cream', ctx.now).error, 'too_many_words');
  assert.equal(ctx.room.setAnswer(ctx.host, 'food', 'V'.repeat(26), ctx.now).error, 'too_many_characters');
  assert.equal(ctx.room.setAnswer(ctx.host, 'food', 'V'.repeat(25), ctx.now).ok, true);
});

test('PR-06 an answer not starting with the letter is accepted with a warning', () => {
  const ctx = setup(2);
  ctx.room.start(ctx.host, ctx.now);
  ctx.room.pickLetter(ctx.room.pickerId, 'V', ctx.now);
  const res = ctx.room.setAnswer(ctx.host, 'food', 'Banana', ctx.now);
  assert.equal(res.ok, true);
  assert.equal(res.warning, 'wrong_letter');
  assert.equal(ctx.room.round.answers[ctx.host].food, 'Banana');
});

test('PR-07 the round closes early when every player marks Done', () => {
  const ctx = setup(3);
  ctx.room.start(ctx.host, ctx.now);
  ctx.room.pickLetter(ctx.room.pickerId, 'V', ctx.now);
  for (const id of ctx.ids) ctx.room.setAnswer(id, 'animal', 'Vulture', ctx.now);
  ctx.room.setDone(ctx.ids[0], true, ctx.now);
  ctx.room.setDone(ctx.ids[1], true, ctx.now);
  assert.equal(ctx.room.phase, 'answering');
  ctx.room.setDone(ctx.ids[2], true, ctx.now);
  assert.equal(ctx.room.phase, 'voting');
});

// ---------- 5. Review ----------
test('RV-01 each player is assigned exactly one other player\'s answer set', () => {
  const ctx = setup(5);
  playToVoting(ctx);
  for (const id of ctx.ids) {
    const assigned = ctx.room.viewFor(id, ctx.now).voting.assigned;
    assert.equal(assigned.length, 1);
    assert.deepEqual(Object.keys(assigned[0].answers), CATEGORIES);
  }
});

test('RV-02 a player is never assigned their own answer set', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const ctx = setup(2 + (seed % 11), { seed });
    playToVoting(ctx);
    for (const [author, reviewer] of ctx.room.round.assignments) assert.notEqual(author, reviewer);
  }
});

test('RV-03 no repeat pairing until a player has reviewed everyone; 2 players always swap', () => {
  for (const n of [3, 4, 5, 6, 8, 12]) {
    for (let seed = 1; seed <= 5; seed++) {
      const ctx = setup(n, { seed });
      const seen = new Map(ctx.ids.map((id) => [id, new Set()]));
      for (let round = 0; round < n - 1; round++) {
        playToVoting(ctx);
        for (const [author, reviewer] of ctx.room.round.assignments) {
          assert.equal(seen.get(reviewer).has(author), false, `n=${n} seed=${seed} round=${round} repeated`);
          seen.get(reviewer).add(author);
        }
        voteAll(ctx);
        finishRound(ctx);
      }
      for (const [rev, set] of seen) assert.equal(set.size, n - 1, `n=${n}: ${rev} reviewed ${set.size}`);
    }
  }
  const two = setup(2);
  for (let i = 0; i < 4; i++) {
    playToVoting(two);
    assert.equal(reviewerOf(two, two.ids[0]), two.ids[1]);
    assert.equal(reviewerOf(two, two.ids[1]), two.ids[0]);
    voteAll(two);
    finishRound(two);
  }
});

test('RV-04 the reviewer must give a thumbs up or down on each answer', () => {
  const ctx = setup(2);
  playToVoting(ctx);
  const author = ctx.ids[0];
  const reviewer = reviewerOf(ctx, author);
  assert.equal(ctx.room.submitVotes(reviewer, author, { name: true, food: true }, ctx.now).error, 'incomplete_votes');
  const all = Object.fromEntries(CATEGORIES.map((c) => [c, true]));
  assert.equal(ctx.room.submitVotes(reviewer, author, all, ctx.now).ok, true);
});

test('RV-05 blank answers cannot be voted on and score 0', () => {
  const ctx = setup(2);
  playToVoting(ctx, 'V', (id) => (id === ctx.ids[0] ? fill('V', { animal: '' }) : null));
  const author = ctx.ids[0];
  const reviewer = reviewerOf(ctx, author);
  const votes = { name: true, food: true, place: true, thing: true }; // no animal vote needed
  assert.equal(ctx.room.submitVotes(reviewer, author, { ...votes, animal: true }, ctx.now).ok, true);
  assert.equal('animal' in ctx.room.round.votes.get(author), false);
  voteAll(ctx);
  assert.equal(ctx.room.round.results.get(author).points, 4);
});

test('RV-06 reviewers are anonymous in the results', () => {
  const ctx = setup(3);
  playToVoting(ctx);
  voteAll(ctx);
  const view = ctx.room.viewFor(ctx.ids[0], ctx.now);
  for (const set of view.results.sets) {
    assert.deepEqual(Object.keys(set).sort(), ['answers', 'authorId', 'name', 'points', 'status', 'votes']);
  }
  assert.equal('voting' in view, false);
});

test('RV-07 once voting ends, every player sees all answer sets and results', () => {
  const ctx = setup(3);
  playToVoting(ctx);
  voteAll(ctx, (a, c) => c !== 'thing');
  for (const id of ctx.ids) {
    const sets = ctx.room.viewFor(id, ctx.now).results.sets;
    assert.equal(sets.length, 3);
    for (const s of sets) assert.equal(s.votes.thing, false);
  }
});

test('RV-08 a player can only challenge their own rejected answers', () => {
  const ctx = setup(3);
  playToVoting(ctx);
  voteAll(ctx, (a, c) => c !== 'food');
  const [a, b] = ctx.ids;
  assert.equal(ctx.room.raiseChallenge(a, 'name', ctx.now).error, 'not_challengeable'); // accepted answer
  const res = ctx.room.raiseChallenge(a, 'food', ctx.now);
  assert.equal(res.ok, true);
  assert.equal(ctx.room.voteChallenge(a, res.challengeId, true, ctx.now).error, 'cannot_vote_own');
  // the API has no way to name another player's answer: challenges always target the caller's own set
  assert.equal(ctx.room.round.challenges[0].authorId, a);
  assert.equal(ctx.room.raiseChallenge(b, 'food', ctx.now).ok, true);
  assert.equal(ctx.room.round.challenges[1].authorId, b);
});

test('RV-09 each player has 4 challenges per game, reset on restart', () => {
  const ctx = setup(2);
  const me = ctx.host;
  for (let i = 0; i < 5; i++) {
    playToVoting(ctx);
    voteAll(ctx, () => false);
    const res = ctx.room.raiseChallenge(me, 'name', ctx.now);
    if (i < 4) assert.equal(res.ok, true, `challenge ${i + 1}`);
    else assert.equal(res.error, 'no_challenges_left');
    const ch = ctx.room.round.challenges.find((c) => c.authorId === me);
    if (ch) ctx.room.voteChallenge(ctx.ids[1], ch.id, false, ctx.now);
    finishRound(ctx);
  }
  assert.equal(ctx.p(me).challengesLeft, 0);
  ctx.room.endGame(ctx.host, ctx.now);
  ctx.room.restart(ctx.host, ctx.now);
  assert.equal(ctx.p(me).challengesLeft, 4);
});

test('RV-10 group majority up gives the challenger the point; majority down leaves 0', () => {
  const ctx = setup(4);
  playToVoting(ctx, 'S', (id) => (id === ctx.host ? fill('S', { food: 'Snake' }) : null));
  voteAll(ctx, (a, c) => !(a === ctx.host && c === 'food'));
  const before = ctx.p(ctx.host).score;
  const { challengeId } = ctx.room.raiseChallenge(ctx.host, 'food', ctx.now);
  ctx.room.voteChallenge(ctx.ids[1], challengeId, true, ctx.now);
  ctx.room.voteChallenge(ctx.ids[2], challengeId, true, ctx.now);
  ctx.room.voteChallenge(ctx.ids[3], challengeId, false, ctx.now);
  assert.equal(ctx.room.round.challenges[0].status, 'won');
  assert.equal(ctx.p(ctx.host).score, before + 1);
  assert.equal(ctx.room.round.results.get(ctx.host).votes.food, true);

  const c2 = setup(4);
  playToVoting(c2);
  voteAll(c2, (a, c) => !(a === c2.host && c === 'food'));
  const b2 = c2.p(c2.host).score;
  const ch2 = c2.room.raiseChallenge(c2.host, 'food', c2.now).challengeId;
  c2.room.voteChallenge(c2.ids[1], ch2, false, c2.now);
  c2.room.voteChallenge(c2.ids[2], ch2, false, c2.now);
  c2.room.voteChallenge(c2.ids[3], ch2, true, c2.now);
  assert.equal(c2.room.round.challenges[0].status, 'lost');
  assert.equal(c2.p(c2.host).score, b2);
});

test('RV-11 challenge votes show counts only, never who voted', () => {
  const ctx = setup(3);
  playToVoting(ctx);
  voteAll(ctx, () => false);
  const { challengeId } = ctx.room.raiseChallenge(ctx.ids[1], 'name', ctx.now);
  ctx.room.voteChallenge(ctx.ids[2], challengeId, true, ctx.now);
  const ch = ctx.room.viewFor(ctx.ids[0], ctx.now).results.challenges[0];
  assert.equal(ch.up, 1);
  assert.equal(ch.down, 0);
  assert.equal(JSON.stringify(ch).includes(ctx.ids[2]), false);
});

test('RV-12 a tied vote goes to the host; if the host challenged, the next-in-line decides', () => {
  const ctx = setup(3);
  playToVoting(ctx);
  voteAll(ctx, () => false);
  const guest = ctx.ids[1];
  const { challengeId } = ctx.room.raiseChallenge(guest, 'name', ctx.now);
  ctx.room.voteChallenge(ctx.ids[0], challengeId, true, ctx.now);
  ctx.room.voteChallenge(ctx.ids[2], challengeId, false, ctx.now);
  const ch = ctx.room.round.challenges[0];
  assert.equal(ch.status, 'tie');
  assert.equal(ch.decider, ctx.host);
  assert.equal(ctx.room.decideTie(ctx.ids[2], challengeId, true, ctx.now).error, 'not_decider');
  assert.equal(ctx.room.decideTie(ctx.host, challengeId, true, ctx.now).ok, true);
  assert.equal(ch.status, 'won');

  const hostCh = ctx.room.raiseChallenge(ctx.host, 'food', ctx.now).challengeId;
  ctx.room.voteChallenge(ctx.ids[1], hostCh, true, ctx.now);
  ctx.room.voteChallenge(ctx.ids[2], hostCh, false, ctx.now);
  const ch2 = ctx.room.round.challenges[1];
  assert.equal(ch2.status, 'tie');
  assert.equal(ch2.decider, ctx.ids[1]); // longest-joined after the host
});

test('RV-13 challenges must be raised within the challenge window', () => {
  const ctx = setup(2);
  playToVoting(ctx);
  voteAll(ctx, () => false);
  ctx.now += 29_000;
  assert.equal(ctx.room.raiseChallenge(ctx.host, 'name', ctx.now).ok, true);
  ctx.now += 1_000;
  assert.equal(ctx.room.raiseChallenge(ctx.host, 'food', ctx.now).error, 'window_closed');
});

test('RV-14 voting closes 30s after the first voter finishes; unreviewed sets are pended', () => {
  const ctx = setup(3);
  playToVoting(ctx);
  const r = ctx.room.round;
  const [firstAuthor, firstReviewer] = [...r.assignments][0];
  ctx.room.submitVotes(firstReviewer, firstAuthor, Object.fromEntries(CATEGORIES.map((c) => [c, true])), ctx.now);
  ctx.adv(29);
  assert.equal(ctx.room.phase, 'voting');
  ctx.adv(1);
  assert.equal(ctx.room.phase, 'challenge');
  assert.equal(ctx.room.pended.length, 2);
  assert.equal(r.results.get(firstAuthor).status, 'reviewed');
  for (const item of ctx.room.pended) assert.equal(r.results.get(item.authorId).status, 'pended');
});

function pendOneSet(ctx) {
  playToVoting(ctx);
  const r = ctx.room.round;
  const entries = [...r.assignments];
  for (const [author, reviewer] of entries.slice(1)) {
    ctx.room.submitVotes(reviewer, author, Object.fromEntries(CATEGORIES.map((c) => [c, true])), ctx.now);
  }
  const [pendedAuthor, lazyReviewer] = entries[0];
  ctx.adv(ctx.room.settings.reviewFallback);
  return { pendedAuthor, lazyReviewer };
}

test('RV-15 pended sets are randomly assigned at game end, never to the author', () => {
  const reviewers = new Set();
  for (let seed = 1; seed <= 25; seed++) {
    const ctx = setup(5, { seed });
    const { pendedAuthor } = pendOneSet(ctx);
    finishRound(ctx);
    ctx.room.endGame(ctx.host, ctx.now);
    assert.equal(ctx.room.phase, 'pended');
    const item = ctx.room.pended[0];
    assert.notEqual(item.reviewer, pendedAuthor);
    reviewers.add(ctx.room.players.get(item.reviewer).seq);
  }
  assert.ok(reviewers.size >= 2, 'assignment should vary between games');
});

test('RV-16 a pended set is not assigned back to the player who failed to review it', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const ctx = setup(4, { seed });
    const { pendedAuthor, lazyReviewer } = pendOneSet(ctx);
    finishRound(ctx);
    ctx.room.endGame(ctx.host, ctx.now);
    const item = ctx.room.pended[0];
    assert.notEqual(item.reviewer, pendedAuthor);
    assert.notEqual(item.reviewer, lazyReviewer);
  }
});

// ---------- 6. Scoring ----------
test('SC-01 each accepted answer scores 1 point, max 5 per round', () => {
  const ctx = setup(2);
  playToVoting(ctx);
  voteAll(ctx, (a, c) => (a === ctx.host ? c !== 'thing' : true));
  assert.equal(ctx.p(ctx.host).score, 4);
  assert.equal(ctx.p(ctx.ids[1]).score, 5);
});

test('SC-02 blank, rejected and lost-challenge answers score 0', () => {
  const ctx = setup(3);
  playToVoting(ctx, 'V', (id) => (id === ctx.host ? fill('V', { name: '' }) : null));
  voteAll(ctx, (a, c) => !(a === ctx.host && ['food', 'animal'].includes(c)));
  const ch = ctx.room.raiseChallenge(ctx.host, 'food', ctx.now).challengeId;
  ctx.room.voteChallenge(ctx.ids[1], ch, false, ctx.now);
  ctx.room.voteChallenge(ctx.ids[2], ch, false, ctx.now);
  assert.equal(ctx.p(ctx.host).score, 2); // place + thing only
});

test('SC-03 pended answers are scored before the final leaderboard', () => {
  const ctx = setup(3);
  const { pendedAuthor } = pendOneSet(ctx);
  finishRound(ctx);
  const before = ctx.p(pendedAuthor).score;
  ctx.room.endGame(ctx.host, ctx.now);
  const item = ctx.room.pended[0];
  ctx.room.submitPendedVotes(item.reviewer, item.id, Object.fromEntries(CATEGORIES.map((c) => [c, true])), ctx.now);
  assert.equal(ctx.room.phase, 'final');
  assert.equal(ctx.p(pendedAuthor).score, before + 5);
  assert.equal(ctx.room.final.leaderboard.find((l) => l.id === pendedAuthor).score, before + 5);
});

// ---------- 7. Winners ----------
test('WN-01 the highest total wins', () => {
  const ctx = setup(3);
  playFullRound(ctx, (a) => a === ctx.ids[2]);
  ctx.room.endGame(ctx.host, ctx.now);
  assert.deepEqual(ctx.room.final.winners, [ctx.ids[2]]);
});

test('WN-02 the final leaderboard lists every player with rank, name and total, highest first', () => {
  const ctx = setup(3);
  playFullRound(ctx, (a, c) => (a === ctx.ids[1] ? true : a === ctx.ids[2] ? c === 'name' : false));
  ctx.room.endGame(ctx.host, ctx.now);
  const board = ctx.room.final.leaderboard;
  assert.deepEqual(board.map((b) => [b.rank, b.name, b.score]), [[1, 'P2', 5], [2, 'P3', 1], [3, 'P1', 0]]);
});

test('WN-03 tied players share the win', () => {
  const ctx = setup(3);
  playFullRound(ctx, (a) => a !== ctx.ids[2]);
  ctx.room.endGame(ctx.host, ctx.now);
  assert.deepEqual(new Set(ctx.room.final.winners), new Set([ctx.ids[0], ctx.ids[1]]));
  assert.deepEqual(ctx.room.final.leaderboard.slice(0, 2).map((b) => b.rank), [1, 1]);
});

test('WN-04 play again returns everyone to the lobby with the same settings', () => {
  const ctx = setup(2);
  ctx.room.updateSettings(ctx.host, { answerTime: 35, pickTime: 15 });
  playFullRound(ctx);
  ctx.room.endGame(ctx.host, ctx.now);
  assert.equal(ctx.room.playAgain(ctx.ids[1], ctx.now).ok, true);
  assert.equal(ctx.room.phase, 'lobby');
  assert.equal(ctx.room.settings.answerTime, 35);
  assert.equal(ctx.room.settings.pickTime, 15);
  assert.equal(ctx.p(ctx.host).score, 0);
});

test('WN-05 highlights name every player tied on most thumbs up', () => {
  const ctx = setup(3);
  playFullRound(ctx, (a) => a !== ctx.ids[2]);
  ctx.room.endGame(ctx.host, ctx.now);
  assert.deepEqual(new Set(ctx.room.final.highlights.mostThumbs.playerIds), new Set([ctx.ids[0], ctx.ids[1]]));
});

test('WN-05 highlights show most thumbs up and most challenged answer', () => {
  const ctx = setup(3);
  playToVoting(ctx, 'S', (id) => (id === ctx.ids[1] ? fill('S', { food: 'Snake' }) : null));
  voteAll(ctx, (a, c) => (a === ctx.ids[1] ? c !== 'food' : c === 'name'));
  const ch = ctx.room.raiseChallenge(ctx.ids[1], 'food', ctx.now).challengeId;
  ctx.room.voteChallenge(ctx.ids[0], ch, true, ctx.now);
  ctx.room.voteChallenge(ctx.ids[2], ch, true, ctx.now);
  finishRound(ctx);
  ctx.room.endGame(ctx.host, ctx.now);
  const h = ctx.room.final.highlights;
  assert.deepEqual(h.mostThumbs.playerIds, [ctx.ids[1]]);
  assert.equal(h.mostThumbs.count, 5);
  assert.equal(h.mostChallenged.answer, 'Snake');
  assert.equal(h.mostChallenged.votes, 2);
});

// ---------- 8. Gameplay ----------
test('GP-01 the host can start once 2 players are in the lobby', () => {
  const ctx = setup(1);
  assert.equal(ctx.room.start(ctx.host, ctx.now).error, 'not_enough_players');
  ctx.room.addPlayer('Ade', ctx.now);
  assert.equal(ctx.room.start(ctx.host, ctx.now).ok, true);
});

test('GP-02 players take turns picking the letter in join order', () => {
  const ctx = setup(3);
  const pickers = [];
  for (let i = 0; i < 4; i++) {
    if (ctx.room.phase === 'lobby') ctx.room.start(ctx.host, ctx.now);
    pickers.push(ctx.room.pickerId);
    playFullRound(ctx);
  }
  assert.deepEqual(pickers, [ctx.ids[0], ctx.ids[1], ctx.ids[2], ctx.ids[0]]);
});

test('GP-03 used letters cannot be picked again until the game restarts', () => {
  const ctx = setup(2);
  playFullRound(ctx, undefined, 'V');
  assert.equal(ctx.room.pickLetter(ctx.room.pickerId, 'V', ctx.now).error, 'letter_used');
  assert.deepEqual(ctx.room.viewFor(ctx.host, ctx.now).room.usedLetters, ['V']);
  ctx.room.endGame(ctx.host, ctx.now);
  ctx.room.restart(ctx.host, ctx.now);
  assert.equal(ctx.room.pickLetter(ctx.room.pickerId, 'V', ctx.now).ok, true);
});

test('GP-04 the picker has 20 seconds, then the turn passes', () => {
  const ctx = setup(3);
  ctx.room.start(ctx.host, ctx.now);
  assert.equal(ctx.room.pickerId, ctx.ids[0]);
  ctx.adv(19);
  assert.equal(ctx.room.pickerId, ctx.ids[0]);
  ctx.adv(1);
  assert.equal(ctx.room.pickerId, ctx.ids[1]);
  ctx.adv(20);
  assert.equal(ctx.room.pickerId, ctx.ids[2]);
});

test('GP-05 the letter is revealed to everyone at once and the answer timer starts', () => {
  const ctx = setup(3);
  ctx.room.start(ctx.host, ctx.now);
  ctx.room.pickLetter(ctx.host, 'K', ctx.now);
  for (const id of ctx.ids) {
    const v = ctx.room.viewFor(id, ctx.now);
    assert.equal(v.room.phase, 'answering');
    assert.equal(v.room.letter, 'K');
    assert.equal(v.room.deadline, ctx.now + 50_000);
  }
});

test('GP-06 no ready vote: the game moves on once voting and the challenge window are done', () => {
  const ctx = setup(3);
  playToVoting(ctx);
  voteAll(ctx);
  assert.equal(ctx.room.phase, 'challenge');
  ctx.adv(30);
  assert.equal(ctx.room.phase, 'results');
  ctx.adv(8);
  assert.equal(ctx.room.phase, 'picking');
});

test('GP-07 the leaderboard is shown after each round, before the next letter pick', () => {
  const ctx = setup(2);
  playToVoting(ctx);
  voteAll(ctx);
  ctx.adv(30);
  const v = ctx.room.viewFor(ctx.ids[1], ctx.now);
  assert.equal(v.room.phase, 'results');
  assert.equal(v.leaderboard.length, 2);
  assert.equal(v.leaderboard[0].score, 5);
});

test('GP-08 the leaderboard is available in every phase', () => {
  const ctx = setup(2);
  const phases = new Set();
  const check = () => { phases.add(ctx.room.phase); assert.equal(ctx.room.viewFor(ctx.host, ctx.now).leaderboard.length, 2); };
  check();
  ctx.room.start(ctx.host, ctx.now); check();
  ctx.room.pickLetter(ctx.host, 'B', ctx.now); check();
  for (const id of ctx.ids) ctx.room.setAnswer(id, 'food', 'Bread', ctx.now);
  ctx.room.setDone(ctx.ids[0], true, ctx.now); ctx.room.setDone(ctx.ids[1], true, ctx.now); check();
  voteAll(ctx); check();
  ctx.adv(30); check();
  ctx.room.endGame(ctx.host, ctx.now); check();
  assert.deepEqual([...phases], ['lobby', 'picking', 'answering', 'voting', 'challenge', 'results', 'final']);
});

test('GP-09 the game ends after 26 letters, or when the host ends it', () => {
  const ctx = setup(2);
  for (const L of LETTERS) playFullRound(ctx, () => true, L);
  assert.equal(ctx.room.phase, 'final');
  assert.equal(ctx.room.final.alphabetComplete, true);
  assert.equal(ctx.p(ctx.host).score, 26 * 5);
  const c2 = setup(2);
  c2.room.start(c2.host, c2.now);
  c2.room.pickLetter(c2.host, 'A', c2.now);
  assert.equal(c2.room.endGame(c2.host, c2.now).ok, true);
  assert.equal(c2.room.phase, 'final');
  assert.equal(c2.room.final.alphabetComplete, false);
});

test('GP-10 pended review runs before the final leaderboard and is skipped when empty', () => {
  const ctx = setup(3);
  pendOneSet(ctx);
  finishRound(ctx);
  ctx.room.endGame(ctx.host, ctx.now);
  assert.equal(ctx.room.phase, 'pended');
  const c2 = setup(2);
  playFullRound(c2);
  c2.room.endGame(c2.host, c2.now);
  assert.equal(c2.room.phase, 'final');
});

test('GP-11 restarting after 26 letters refreshes letters, zeroes scores and resets challenges', () => {
  const ctx = setup(2);
  for (const L of LETTERS) playFullRound(ctx, () => true, L);
  ctx.p(ctx.host).challengesLeft = 1;
  assert.equal(ctx.room.restart(ctx.host, ctx.now).ok, true);
  assert.equal(ctx.room.usedLetters.size, 0);
  for (const id of ctx.ids) { assert.equal(ctx.p(id).score, 0); assert.equal(ctx.p(id).challengesLeft, 4); }
});

test('GP-12 disconnected players are skipped for picking, their review is reassigned, and they score 0', () => {
  const ctx = setup(3);
  ctx.room.start(ctx.host, ctx.now);
  ctx.room.disconnect(ctx.ids[1], ctx.now);
  playFullRound(ctx, () => true); // P1 picks, P2 is away for the whole round
  assert.equal(ctx.room.pickerId, ctx.ids[2]); // P2 skipped
  assert.equal(ctx.room.lastRoundPoints[ctx.ids[1]], 0);
  assert.equal(ctx.p(ctx.ids[1]).score, 0);
  // review reassignment when a reviewer drops mid-vote
  const c2 = setup(4);
  playToVoting(c2);
  const [author, reviewer] = [...c2.room.round.assignments][0];
  c2.room.disconnect(reviewer, c2.now);
  const newReviewer = c2.room.round.assignments.get(author);
  assert.ok(newReviewer && newReviewer !== reviewer && newReviewer !== author);
});

// ---------- 9. Misc ----------
test('MS-04 offensive display and room names are rejected', () => {
  const ctx = setup(1);
  for (const bad of ['shithead', 'sh1t', 'f u c k']) assert.equal(ctx.room.addPlayer(bad, ctx.now).error, 'name_blocked', bad);
  assert.equal(ctx.room.addPlayer('Scunthorpe', ctx.now).ok, true);
  assert.equal(ctx.room.updateSettings(ctx.host, { roomName: 'Naming Game' }).ok, true); // regression: false positive
  assert.equal(ctx.room.updateSettings(ctx.host, { roomName: 'fuck this' }).error, 'name_blocked');
  const reg = new Registry({ isOffensive });
  assert.equal(reg.create({ hostName: 'Ste', roomName: 'shit room', now: 0 }).error, 'name_blocked');
});
