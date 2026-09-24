'use strict';
// Alphabet Challenge game engine. Pure logic: every method takes `now` (ms) so timers are testable.
const crypto = require('crypto');

const CATEGORIES = ['name', 'food', 'animal', 'place', 'thing'];
const CATEGORY_LABELS = { name: 'Name', food: 'Food', animal: 'Animal', place: 'Place', thing: 'Thing' };
const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
const LIMITS = {
  maxPlayers: [2, 12],
  answerTime: [20, 60],
  pickTime: [10, 60],
  reviewFallback: [15, 120],
  challengeTime: [15, 120],
};
const DEFAULT_SETTINGS = { maxPlayers: 8, answerTime: 50, pickTime: 20, reviewFallback: 30, challengeTime: 30 };
// Timers not covered by the requirements (flagged as assumptions).
const FIXED = {
  resultsTime: 8,        // round results + leaderboard screen
  challengeVoteTime: 20, // group vote on one challenge
  tieDecisionTime: 20,   // host decision on a tied challenge; original result stands after this
  pendedTime: 60,        // end-of-game pended review
  votingCap: 120,        // voting closes even if nobody finishes
  hostGrace: 20,         // host disconnected this long -> role passes on
  reviewerGrace: 45,     // a reviewer whose connection drops keeps their review this long (phones sleep)
  emptyGrace: 60,        // everyone disconnected this long -> room closes
};
const MAX_WORDS = 3;
const MAX_CHARS = 25;
const CHALLENGES_PER_GAME = 4;

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const blankAnswers = () => Object.fromEntries(CATEGORIES.map((c) => [c, '']));
const cleanText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function validateAnswer(text) {
  const t = cleanText(text);
  if (t.length > MAX_CHARS) return fail('too_many_characters');
  if (t && t.split(' ').length > MAX_WORDS) return fail('too_many_words');
  return ok({ text: t });
}

class Room {
  constructor({ code, roomName, visibility, now = Date.now(), rng = Math.random, isOffensive = () => false }) {
    this.code = code;
    this.name = cleanText(roomName).slice(0, 30) || 'Alphabet Challenge';
    this.visibility = visibility === 'public' ? 'public' : 'private';
    this.rng = rng;
    this.isOffensive = isOffensive;
    this.settings = { ...DEFAULT_SETTINGS };
    this.players = new Map();
    this.seq = 0;
    this.hostId = null;
    this.phase = 'lobby';
    this.closed = false;
    this.createdAt = now;
    this.version = 0;
    this.resetGame();
  }

  // ---------- helpers ----------
  resetGame() {
    this.usedLetters = new Set();
    this.roundNo = 0;
    this.round = null;
    this.lastPickerSeq = 0;
    this.reviewHistory = new Map();
    this.pended = [];
    this.gameEndReason = null;
    this.alphabetComplete = false;
    this.stats = { thumbsUp: new Map(), challenges: [] };
    this.deadline = null;
    this.pickerId = null;
    this.lastRoundPoints = null;
    for (const p of this.players.values()) {
      p.score = 0;
      p.challengesLeft = CHALLENGES_PER_GAME;
    }
  }
  bump() { this.version++; }
  sortedPlayers() { return [...this.players.values()].sort((a, b) => a.seq - b.seq); }
  connectedPlayers() { return this.sortedPlayers().filter((p) => p.connected); }
  isHost(id) { return this.hostId === id; }
  // Connected, or only just dropped (a locked phone) and still within the grace period.
  // During voting the grace runs from whichever is later: the drop, or the start of voting.
  isPresent(id, now) {
    const p = this.players.get(id);
    if (!p) return false;
    if (p.connected) return true;
    if (p.disconnectedAt === null) return false;
    const from = Math.max(p.disconnectedAt, this.round?.votingStartedAt ?? 0);
    return now - from < FIXED.reviewerGrace * 1000;
  }
  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  uniqueName(name) {
    const taken = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    let n = 2;
    while (taken.has(`${name} ${n}`.toLowerCase())) n++;
    return `${name} ${n}`;
  }
  nextInLine(excludeIds = []) {
    return this.connectedPlayers().find((p) => p.id !== this.hostId && !excludeIds.includes(p.id)) || null;
  }
  transferHost() {
    const next = this.connectedPlayers().find((p) => p.id !== this.hostId)
      || this.sortedPlayers().find((p) => p.id !== this.hostId);
    this.hostId = next ? next.id : null;
  }
  inGame() { return !['lobby', 'final'].includes(this.phase); }

  // ---------- membership ----------
  addPlayer(name, now) {
    if (this.closed) return fail('closed');
    if (this.phase !== 'lobby') return fail('in_progress');
    if (this.players.size >= this.settings.maxPlayers) return fail('full');
    const clean = cleanText(name).slice(0, 20);
    if (!clean) return fail('name_required');
    if (this.isOffensive(clean)) return fail('name_blocked');
    const p = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(16).toString('hex'),
      name: this.uniqueName(clean),
      seq: ++this.seq,
      connected: true,
      score: 0,
      challengesLeft: CHALLENGES_PER_GAME,
      joinedAt: now,
      disconnectedAt: null,
    };
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    this.bump();
    return ok({ player: p });
  }

  rejoin(token, now) {
    if (this.closed) return fail('closed');
    const p = [...this.players.values()].find((x) => x.token === token);
    if (!p) return fail(this.phase === 'lobby' ? 'unknown_player' : 'in_progress');
    p.connected = true;
    p.disconnectedAt = null;
    this.bump();
    return ok({ player: p });
  }

  disconnect(id, now) {
    const p = this.players.get(id);
    if (!p || !p.connected) return fail('unknown_player');
    p.connected = false;
    p.disconnectedAt = now;
    this.handleAbsence(p, now);
    this.bump();
    return ok();
  }

  leave(id, now) { return this.removePlayer(id, now); }

  kick(hostId, targetId, now) {
    if (!this.isHost(hostId)) return fail('not_host');
    if (hostId === targetId) return fail('cannot_kick_self');
    if (!this.players.has(targetId)) return fail('unknown_player');
    return this.removePlayer(targetId, now);
  }

  removePlayer(id, now) {
    const p = this.players.get(id);
    if (!p) return fail('unknown_player');
    p.connected = false;
    this.handleAbsence(p, now, true);
    this.players.delete(id);
    if (this.hostId === id) this.transferHost();
    if (this.players.size === 0) this.closed = true;
    this.bump();
    return ok();
  }

  handleAbsence(p, now, removed = false) {
    const r = this.round;
    if (this.phase === 'picking' && this.pickerId === p.id) this.passPicker(now);
    if (this.phase === 'answering' && r) {
      if (removed) { r.participants = r.participants.filter((x) => x !== p.id); delete r.answers[p.id]; }
      this.checkAllDone(now);
    }
    if (this.phase === 'voting' && r) {
      if (removed) {
        r.participants = r.participants.filter((x) => x !== p.id);
        r.assignments.delete(p.id);
      }
      if (removed) this.reassignReviewsOf(p.id, now);
      this.checkVotingComplete(now);
    }
    if (this.phase === 'challenge' && r) {
      for (const ch of r.challenges) {
        if (ch.status === 'tie' && ch.decider === p.id) ch.decider = this.tieDecider(ch.authorId, [p.id]);
        if (ch.status === 'open') this.checkChallenge(ch, now);
      }
    }
    if (this.phase === 'pended') {
      for (const item of this.pended) {
        if (item.reviewer === p.id && !item.completed) item.reviewer = this.pickPendedReviewer(item, [p.id]);
      }
      this.checkPendedComplete(now);
    }
  }

  reassignReviewsOf(reviewerId, now) {
    const r = this.round;
    for (const [author, reviewer] of r.assignments) {
      if (reviewer === reviewerId && !r.completed.has(author)) {
        r.assignments.set(author, this.pickReassignment(author, reviewerId, r, now));
      }
    }
  }

  pickReassignment(authorId, leavingId, r, now) {
    const load = new Map();
    for (const rev of r.assignments.values()) if (rev) load.set(rev, (load.get(rev) || 0) + 1);
    const candidates = this.connectedPlayers()
      .filter((p) => p.id !== authorId && p.id !== leavingId && r.participants.includes(p.id));
    if (!candidates.length) return null;
    candidates.sort((a, b) => (load.get(a.id) || 0) - (load.get(b.id) || 0));
    return candidates[0].id;
  }

  // ---------- settings ----------
  updateSettings(id, patch = {}) {
    if (!this.isHost(id)) return fail('not_host');
    if (this.phase !== 'lobby') return fail('settings_locked');
    const next = { ...this.settings };
    for (const [key, raw] of Object.entries(patch)) {
      if (key === 'visibility') {
        if (!['public', 'private'].includes(raw)) return fail('invalid_setting', { key });
        continue;
      }
      if (key === 'roomName') continue;
      if (!LIMITS[key]) return fail('invalid_setting', { key });
      const v = Number(raw);
      const [min, max] = LIMITS[key];
      if (!Number.isInteger(v) || v < min || v > max) return fail('invalid_setting', { key, min, max });
      next[key] = v;
    }
    if (next.maxPlayers < this.players.size) return fail('invalid_setting', { key: 'maxPlayers' });
    if (patch.roomName !== undefined) {
      const n = cleanText(patch.roomName).slice(0, 30);
      if (n && this.isOffensive(n)) return fail('name_blocked');
      this.name = n || this.name;
    }
    if (patch.visibility) this.visibility = patch.visibility;
    this.settings = next;
    this.bump();
    return ok();
  }

  // ---------- game flow ----------
  start(id, now) {
    if (!this.isHost(id)) return fail('not_host');
    if (this.phase !== 'lobby') return fail('already_started');
    if (this.connectedPlayers().length < 2) return fail('not_enough_players');
    this.resetGame();
    this.beginPicking(now);
    this.bump();
    return ok();
  }

  nextPicker() {
    const list = this.connectedPlayers();
    if (!list.length) return null;
    return (list.find((p) => p.seq > this.lastPickerSeq) || list[0]).id;
  }

  beginPicking(now) {
    this.phase = 'picking';
    this.round = null;
    this.pickerId = this.nextPicker();
    this.deadline = now + this.settings.pickTime * 1000;
  }

  passPicker(now) {
    const cur = this.players.get(this.pickerId);
    if (cur) this.lastPickerSeq = cur.seq;
    this.pickerId = this.nextPicker();
    this.deadline = now + this.settings.pickTime * 1000;
  }

  pickLetter(id, letter, now) {
    if (this.phase !== 'picking') return fail('wrong_phase');
    if (id !== this.pickerId) return fail('not_your_turn');
    const L = String(letter || '').toUpperCase();
    if (!LETTERS.includes(L)) return fail('invalid_letter');
    if (this.usedLetters.has(L)) return fail('letter_used');
    this.usedLetters.add(L);
    this.lastPickerSeq = this.players.get(id).seq;
    this.roundNo++;
    const participants = this.connectedPlayers().map((p) => p.id);
    this.round = {
      no: this.roundNo,
      letter: L,
      pickerId: id,
      participants,
      answers: Object.fromEntries(participants.map((pid) => [pid, blankAnswers()])),
      done: new Set(),
      startedAt: now,
    };
    this.phase = 'answering';
    this.deadline = now + this.settings.answerTime * 1000;
    this.bump();
    return ok({ letter: L });
  }

  setAnswer(id, category, text, now) {
    const r = this.round;
    if (this.phase !== 'answering' || !r) return fail('wrong_phase');
    if (!r.participants.includes(id)) return fail('not_in_round');
    if (now >= this.deadline) return fail('time_up');
    if (!CATEGORIES.includes(category)) return fail('invalid_category');
    const v = validateAnswer(text);
    if (!v.ok) return v;
    r.answers[id][category] = v.text;
    this.bump();
    const warning = v.text && v.text[0].toUpperCase() !== r.letter ? 'wrong_letter' : null;
    return ok({ warning });
  }

  setDone(id, done, now) {
    const r = this.round;
    if (this.phase !== 'answering' || !r) return fail('wrong_phase');
    if (!r.participants.includes(id)) return fail('not_in_round');
    if (done) r.done.add(id); else r.done.delete(id);
    this.checkAllDone(now);
    this.bump();
    return ok();
  }

  checkAllDone(now) {
    const r = this.round;
    const live = r.participants.filter((pid) => this.players.get(pid)?.connected);
    if (live.length && live.every((pid) => r.done.has(pid))) this.closeAnswering(now);
  }

  isBlankSet(answers) { return CATEGORIES.every((c) => !answers[c]); }

  closeAnswering(now) {
    const r = this.round;
    this.phase = 'voting';
    r.votingStartedAt = now;
    r.assignments = new Map(r.participants.map((a) => [a, null]));
    r.votes = new Map();
    r.completed = new Set();
    r.firstCompleteAt = null;
    const reviewers = r.participants.filter((pid) => this.isPresent(pid, now));
    if (reviewers.length >= 2) {
      const map = this.buildAssignment(reviewers);
      for (const [rev, author] of map) r.assignments.set(author, rev);
    }
    // blank sets have nothing to vote on
    for (const a of r.participants) {
      if (this.isBlankSet(r.answers[a]) && r.assignments.get(a)) { r.votes.set(a, {}); r.completed.add(a); }
    }
    this.deadline = now + FIXED.votingCap * 1000;
    this.checkVotingComplete(now);
  }

  // reviewer -> author derangement avoiding repeat pairings (RV-02, RV-03)
  buildAssignment(ids) {
    for (const rev of ids) {
      const h = this.reviewHistory.get(rev) || new Set();
      const others = ids.filter((x) => x !== rev);
      if (others.every((o) => h.has(o))) h.clear();
      this.reviewHistory.set(rev, h);
    }
    const seen = (rev, a) => this.reviewHistory.get(rev).has(a);
    let steps = 0;
    const order = this.shuffle(ids);
    const used = new Set();
    const result = new Map();
    const dfs = (i) => {
      if (i === order.length) return true;
      if (++steps > 20000) return false;
      const rev = order[i];
      for (const a of this.shuffle(ids)) {
        if (a === rev || used.has(a) || seen(rev, a)) continue;
        used.add(a); result.set(rev, a);
        if (dfs(i + 1)) return true;
        used.delete(a); result.delete(rev);
      }
      return false;
    };
    let chosen = dfs(0) ? result : null;
    if (!chosen) {
      let best = null, bestScore = Infinity;
      for (let t = 0; t < 500; t++) {
        const perm = this.shuffle(ids);
        if (perm.some((a, i) => a === ids[i])) continue;
        const score = perm.reduce((s, a, i) => s + (seen(ids[i], a) ? 1 : 0), 0);
        if (score < bestScore) { bestScore = score; best = new Map(ids.map((rev, i) => [rev, perm[i]])); }
        if (score === 0) break;
      }
      chosen = best || new Map(ids.map((rev, i) => [rev, ids[(i + 1) % ids.length]]));
    }
    for (const [rev, a] of chosen) this.reviewHistory.get(rev).add(a);
    return chosen;
  }

  submitVotes(id, authorId, votes, now) {
    const r = this.round;
    if (this.phase !== 'voting' || !r) return fail('wrong_phase');
    if (r.assignments.get(authorId) !== id) return fail('not_assigned');
    if (r.completed.has(authorId)) return fail('already_voted');
    const clean = this.validateVotes(r.answers[authorId], votes);
    if (!clean) return fail('incomplete_votes');
    r.votes.set(authorId, clean);
    r.completed.add(authorId);
    if (r.firstCompleteAt === null) {
      r.firstCompleteAt = now;
      this.deadline = now + this.settings.reviewFallback * 1000;
    }
    this.checkVotingComplete(now);
    this.bump();
    return ok();
  }

  validateVotes(answers, votes = {}) {
    const clean = {};
    for (const c of CATEGORIES) {
      if (!answers[c]) continue;
      if (typeof votes[c] !== 'boolean') return null;
      clean[c] = votes[c];
    }
    return clean;
  }

  checkVotingComplete(now) {
    const r = this.round;
    const outstanding = [...r.assignments].filter(([a, rev]) => rev && !r.completed.has(a)
      && this.isPresent(rev, now));
    if (!outstanding.length) this.closeVoting(now);
  }

  closeVoting(now) {
    const r = this.round;
    r.results = new Map();
    const pts = {};
    for (const a of r.participants) {
      const p = this.players.get(a);
      if (!p) continue;
      if (r.completed.has(a)) {
        const votes = r.votes.get(a) || {};
        const points = Object.values(votes).filter(Boolean).length;
        p.score += points;
        this.addThumbs(a, points);
        r.results.set(a, { status: 'reviewed', votes: { ...votes }, points });
        pts[a] = points;
      } else {
        const item = {
          id: crypto.randomUUID(), authorId: a, roundNo: r.no, letter: r.letter,
          answers: { ...r.answers[a] }, originalReviewer: r.assignments.get(a) || null,
          reviewer: null, completed: false, votes: null, points: 0,
        };
        this.pended.push(item);
        r.results.set(a, { status: 'pended', votes: {}, points: 0 });
        pts[a] = 0;
      }
    }
    for (const p of this.players.values()) if (!(p.id in pts)) pts[p.id] = 0; // missed round (GP-12)
    this.lastRoundPoints = pts;
    r.challenges = [];
    r.challengeDeadline = now + this.settings.challengeTime * 1000;
    this.deadline = r.challengeDeadline;
    this.phase = 'challenge';
    // Nobody has a thumbs-down they could challenge: don't make everyone sit through the window.
    if (!this.anyoneCanChallenge()) this.beginResults(now);
  }

  canChallenge(id) {
    const r = this.round;
    const p = this.players.get(id);
    const res = r && r.results && r.results.get(id);
    if (!p || !p.connected || p.challengesLeft <= 0 || !res || res.status !== 'reviewed') return false;
    return CATEGORIES.some((c) => res.votes[c] === false
      && !r.challenges.some((ch) => ch.authorId === id && ch.cat === c));
  }

  anyoneCanChallenge() {
    return this.round.participants.some((id) => this.canChallenge(id));
  }

  addThumbs(id, n) { this.stats.thumbsUp.set(id, (this.stats.thumbsUp.get(id) || 0) + n); }

  raiseChallenge(id, category, now) {
    const r = this.round;
    if (this.phase !== 'challenge' || !r) return fail('wrong_phase');
    if (now >= r.challengeDeadline) return fail('window_closed');
    const res = r.results.get(id);
    if (!res || res.status !== 'reviewed') return fail('not_challengeable');
    if (res.votes[category] !== false) return fail('not_challengeable');
    if (r.challenges.some((c) => c.authorId === id && c.cat === category)) return fail('already_challenged');
    const p = this.players.get(id);
    if (p.challengesLeft <= 0) return fail('no_challenges_left');
    p.challengesLeft--;
    const ch = {
      id: crypto.randomUUID(), authorId: id, cat: category, answer: r.answers[id][category],
      votes: new Map(), status: 'open', deadline: now + FIXED.challengeVoteTime * 1000,
      decider: null, decidedBy: null,
    };
    r.challenges.push(ch);
    this.stats.challenges.push(ch);
    this.checkChallenge(ch, now);
    this.bump();
    return ok({ challengeId: ch.id });
  }

  eligibleVoters(ch) { return this.connectedPlayers().filter((p) => p.id !== ch.authorId).map((p) => p.id); }

  voteChallenge(id, challengeId, up, now) {
    const r = this.round;
    if (this.phase !== 'challenge' || !r) return fail('wrong_phase');
    const ch = r.challenges.find((c) => c.id === challengeId);
    if (!ch) return fail('unknown_challenge');
    if (ch.status !== 'open') return fail('challenge_closed');
    if (id === ch.authorId) return fail('cannot_vote_own');
    if (!this.eligibleVoters(ch).includes(id)) return fail('not_eligible');
    if (ch.votes.has(id)) return fail('already_voted');
    ch.votes.set(id, !!up);
    this.checkChallenge(ch, now);
    this.bump();
    return ok();
  }

  tally(ch) {
    let up = 0, down = 0;
    for (const v of ch.votes.values()) v ? up++ : down++;
    return { up, down };
  }

  tieDecider(authorId, exclude = []) {
    const host = this.players.get(this.hostId);
    if (host && host.connected && host.id !== authorId && !exclude.includes(host.id)) return host.id;
    return this.nextInLine([authorId, ...exclude])?.id || null;
  }

  checkChallenge(ch, now, force = false) {
    if (ch.status !== 'open') return;
    const eligible = this.eligibleVoters(ch);
    const allIn = eligible.every((v) => ch.votes.has(v));
    if (!allIn && !force) return;
    const { up, down } = this.tally(ch);
    if (up > down) this.resolveChallenge(ch, true, 'group');
    else if (down > up) this.resolveChallenge(ch, false, 'group');
    else {
      ch.status = 'tie';
      ch.decider = this.tieDecider(ch.authorId);
      ch.deadline = now + FIXED.tieDecisionTime * 1000;
      if (!ch.decider) this.resolveChallenge(ch, false, 'timeout');
    }
  }

  resolveChallenge(ch, won, by) {
    ch.status = won ? 'won' : 'lost';
    ch.decidedBy = by;
    if (!won) return;
    const res = this.round.results.get(ch.authorId);
    const p = this.players.get(ch.authorId);
    if (res && p) {
      res.votes[ch.cat] = true;
      res.points += 1;
      p.score += 1;
      this.addThumbs(p.id, 1);
      this.lastRoundPoints[p.id] = (this.lastRoundPoints[p.id] || 0) + 1;
    }
  }

  decideTie(id, challengeId, up, now) {
    const r = this.round;
    if (this.phase !== 'challenge' || !r) return fail('wrong_phase');
    const ch = r.challenges.find((c) => c.id === challengeId);
    if (!ch || ch.status !== 'tie') return fail('not_tied');
    if (ch.decider !== id) return fail('not_decider');
    this.resolveChallenge(ch, !!up, 'host');
    this.bump();
    return ok();
  }

  beginResults(now) {
    this.phase = 'results';
    this.deadline = now + FIXED.resultsTime * 1000;
  }

  afterResults(now) {
    if (this.usedLetters.size >= LETTERS.length) {
      this.alphabetComplete = true;
      this.finishGame(now, 'alphabet');
    } else {
      this.beginPicking(now);
    }
  }

  endGame(id, now) {
    if (!this.isHost(id)) return fail('not_host');
    if (!this.inGame() || this.phase === 'pended') return fail('wrong_phase');
    if (this.phase === 'challenge') {
      for (const ch of this.round.challenges) if (ch.status === 'open' || ch.status === 'tie') this.resolveChallenge(ch, false, 'ended');
    }
    this.finishGame(now, 'host');
    this.bump();
    return ok();
  }

  finishGame(now, reason) {
    this.gameEndReason = reason;
    this.round = null;
    this.pickerId = null;
    if (this.pended.length) this.beginPended(now);
    else this.goFinal(now);
  }

  pickPendedReviewer(item, exclude = []) {
    const candidates = this.connectedPlayers().filter((p) => p.id !== item.authorId && !exclude.includes(p.id));
    const preferred = candidates.filter((p) => p.id !== item.originalReviewer);
    const pool = preferred.length ? preferred : candidates;
    if (!pool.length) return null;
    return pool[Math.floor(this.rng() * pool.length)].id;
  }

  beginPended(now) {
    this.phase = 'pended';
    for (const item of this.pended) {
      item.reviewer = this.pickPendedReviewer(item);
      if (this.isBlankSet(item.answers)) { item.completed = true; item.votes = {}; }
    }
    this.deadline = now + FIXED.pendedTime * 1000;
    this.checkPendedComplete(now);
  }

  submitPendedVotes(id, itemId, votes, now) {
    if (this.phase !== 'pended') return fail('wrong_phase');
    const item = this.pended.find((i) => i.id === itemId);
    if (!item) return fail('unknown_item');
    if (item.reviewer !== id) return fail('not_assigned');
    if (item.completed) return fail('already_voted');
    const clean = this.validateVotes(item.answers, votes);
    if (!clean) return fail('incomplete_votes');
    this.scorePended(item, clean);
    this.checkPendedComplete(now);
    this.bump();
    return ok();
  }

  scorePended(item, votes) {
    item.votes = votes;
    item.completed = true;
    item.points = Object.values(votes).filter(Boolean).length;
    const p = this.players.get(item.authorId);
    if (p) { p.score += item.points; this.addThumbs(p.id, item.points); }
  }

  checkPendedComplete(now, force = false) {
    if (this.phase !== 'pended') return;
    const open = this.pended.filter((i) => !i.completed && i.reviewer && this.players.get(i.reviewer)?.connected);
    if (open.length && !force) return;
    // Anything left unreviewed is accepted (assumption: a missing reviewer shouldn't cost the author).
    for (const item of this.pended) {
      if (!item.completed) {
        const votes = {};
        for (const c of CATEGORIES) if (item.answers[c]) votes[c] = true;
        item.autoAccepted = true;
        this.scorePended(item, votes);
      }
    }
    this.goFinal(now);
  }

  leaderboard() {
    return this.sortedPlayers()
      .sort((a, b) => b.score - a.score || a.seq - b.seq)
      .map((p, i, arr) => ({
        id: p.id, name: p.name, score: p.score,
        rank: arr.findIndex((q) => q.score === p.score) + 1,
      }));
  }

  goFinal(now) {
    this.phase = 'final';
    this.deadline = null;
    const board = this.leaderboard();
    const top = board.length ? board[0].score : 0;
    let mostThumbs = null;
    const present = [...this.stats.thumbsUp].filter(([pid, n]) => this.players.has(pid) && n > 0);
    if (present.length) {
      const count = Math.max(...present.map(([, n]) => n));
      mostThumbs = { playerIds: present.filter(([, n]) => n === count).map(([pid]) => pid), count };
    }
    let mostChallenged = null;
    for (const ch of this.stats.challenges) {
      const votes = ch.votes.size;
      if (!mostChallenged || votes > mostChallenged.votes) {
        mostChallenged = { playerId: ch.authorId, answer: ch.answer, category: ch.cat, votes, outcome: ch.status };
      }
    }
    this.final = {
      leaderboard: board,
      winners: board.filter((b) => b.score === top).map((b) => b.id),
      highlights: { mostThumbs, mostChallenged },
      alphabetComplete: this.alphabetComplete,
    };
  }

  restart(id, now) {
    if (!this.isHost(id)) return fail('not_host');
    if (this.phase !== 'final') return fail('wrong_phase');
    if (this.connectedPlayers().length < 2) return fail('not_enough_players');
    this.resetGame();
    this.beginPicking(now);
    this.bump();
    return ok();
  }

  playAgain(id, now) {
    if (!this.players.has(id)) return fail('unknown_player');
    if (this.phase !== 'final') return fail('wrong_phase');
    this.resetGame();
    this.phase = 'lobby';
    this.bump();
    return ok();
  }

  // ---------- clock ----------
  tick(now) {
    const before = this.version;
    const host = this.players.get(this.hostId);
    if (host && !host.connected && now - host.disconnectedAt >= FIXED.hostGrace * 1000 && this.connectedPlayers().length) {
      this.transferHost();
      this.bump();
    }
    if (this.players.size && !this.connectedPlayers().length) {
      const lastGone = Math.max(...[...this.players.values()].map((p) => p.disconnectedAt || 0));
      if (now - lastGone >= FIXED.emptyGrace * 1000) { this.closed = true; this.bump(); return true; }
    }
    if (this.deadline !== null && this.phase === 'challenge') {
      for (const ch of this.round.challenges) {
        if (ch.status === 'open' && now >= ch.deadline) { this.checkChallenge(ch, now, true); this.bump(); }
        if (ch.status === 'tie' && now >= ch.deadline) { this.resolveChallenge(ch, false, 'timeout'); this.bump(); }
      }
      const unresolved = this.round.challenges.some((c) => c.status === 'open' || c.status === 'tie');
      if (!unresolved && (now >= this.round.challengeDeadline || !this.anyoneCanChallenge())) { this.beginResults(now); this.bump(); }
      return this.version !== before;
    }
    if (this.phase === 'voting' && this.round) {
      const r = this.round;
      let moved = false;
      for (const [author, rev] of r.assignments) {
        if (rev && !r.completed.has(author) && !this.isPresent(rev, now)) {
          r.assignments.set(author, this.pickReassignment(author, rev, r, now));
          moved = true;
        }
      }
      if (moved) { this.checkVotingComplete(now); this.bump(); }
      if (this.phase !== 'voting') return true;
    }
    if (this.deadline === null || now < this.deadline) return this.version !== before;
    switch (this.phase) {
      case 'picking': this.passPicker(now); break;
      case 'answering': this.closeAnswering(now); break;
      case 'voting': this.closeVoting(now); break;
      case 'results': this.afterResults(now); break;
      case 'pended': this.checkPendedComplete(now, true); break;
      default: return this.version !== before;
    }
    this.bump();
    return true;
  }

  // ---------- projections ----------
  playerList() {
    return this.sortedPlayers().map((p) => ({
      id: p.id, name: p.name, score: p.score, connected: p.connected, isHost: p.id === this.hostId,
    }));
  }

  summary() {
    return {
      code: this.code, name: this.name, visibility: this.visibility, phase: this.phase,
      playerCount: this.players.size, maxPlayers: this.settings.maxPlayers,
      settings: { ...this.settings }, closed: this.closed,
    };
  }

  viewFor(id, now) {
    const me = this.players.get(id);
    const r = this.round;
    const view = {
      now,
      room: { ...this.summary(), hostId: this.hostId, deadline: this.deadline, roundNo: this.roundNo,
        usedLetters: [...this.usedLetters], pickerId: this.pickerId, letter: r?.letter || null,
        lastRoundPoints: this.lastRoundPoints, gameEndReason: this.gameEndReason },
      you: me ? { id: me.id, name: me.name, isHost: me.id === this.hostId, challengesLeft: me.challengesLeft,
        score: me.score } : null,
      players: this.playerList(),
      leaderboard: this.leaderboard(),
      categories: CATEGORIES,
      limits: { maxWords: MAX_WORDS, maxChars: MAX_CHARS, settings: LIMITS },
    };
    if (r && this.phase === 'answering') {
      view.answering = {
        inRound: r.participants.includes(id),
        answers: r.answers[id] || null, // only your own (PR-03)
        done: r.done.has(id),
        doneCount: r.done.size,
        participantCount: r.participants.length,
      };
    }
    if (r && this.phase === 'voting') {
      const mine = [...r.assignments].filter(([, rev]) => rev === id).map(([a]) => ({
        authorId: a, name: this.players.get(a)?.name || 'Player', answers: { ...r.answers[a] },
        completed: r.completed.has(a),
      }));
      const assignedTotal = [...r.assignments.values()].filter(Boolean).length;
      const waitingOnAway = [...r.assignments].some(([a, rev]) => rev && !r.completed.has(a)
        && !this.players.get(rev)?.connected && this.isPresent(rev, now));
      view.voting = { assigned: mine, completedCount: r.completed.size, total: assignedTotal, waitingOnAway,
        closing: r.firstCompleteAt !== null, fallbackSeconds: this.settings.reviewFallback };
    }
    if (r && ['challenge', 'results'].includes(this.phase)) {
      view.results = {
        sets: r.participants.filter((a) => this.players.has(a)).map((a) => {
          const res = r.results.get(a);
          return { authorId: a, name: this.players.get(a).name, answers: { ...r.answers[a] },
            status: res.status, votes: { ...res.votes }, points: res.points };
        }),
        challengeDeadline: r.challengeDeadline,
        windowOpen: this.phase === 'challenge' && now < r.challengeDeadline,
        youCanChallenge: this.phase === 'challenge' && now < r.challengeDeadline && this.canChallenge(id),
        challenges: r.challenges.map((ch) => {
          const { up, down } = this.tally(ch);
          return { id: ch.id, authorId: ch.authorId, authorName: this.players.get(ch.authorId)?.name || 'Player',
            category: ch.cat, answer: ch.answer, up, down, status: ch.status, deadline: ch.deadline,
            canVote: ch.status === 'open' && ch.authorId !== id && this.eligibleVoters(ch).includes(id) && !ch.votes.has(id),
            youVoted: ch.votes.has(id), youDecide: ch.status === 'tie' && ch.decider === id,
            decidedBy: ch.decidedBy };
        }),
      };
    }
    if (this.phase === 'pended') {
      view.pended = {
        assigned: this.pended.filter((i) => i.reviewer === id && !i.completed).map((i) => ({
          id: i.id, letter: i.letter, roundNo: i.roundNo, name: this.players.get(i.authorId)?.name || 'Player',
          answers: { ...i.answers } })),
        remaining: this.pended.filter((i) => !i.completed).length,
        total: this.pended.length,
      };
    }
    if (this.phase === 'final') view.final = this.final;
    return view;
  }
}

module.exports = {
  Room, CATEGORIES, CATEGORY_LABELS, LETTERS, LIMITS, DEFAULT_SETTINGS, FIXED,
  MAX_WORDS, MAX_CHARS, CHALLENGES_PER_GAME, validateAnswer,
};
