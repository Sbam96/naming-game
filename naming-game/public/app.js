(() => {
  'use strict';
  const CATS = ['name', 'food', 'animal', 'place', 'thing'];
  const LABEL = { name: 'Name', food: 'Food', animal: 'Animal', place: 'Place', thing: 'Thing' };
  const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  const $ = (s, el = document) => el.querySelector(s);
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };

  const S = {
    view: null, offset: 0, screen: 'home', data: {}, votes: {}, answers: {}, answersRound: null,
    muted: store.get('ng.muted', false), revealed: null, lastPhase: null, beeped: new Set(),
  };
  window.__ng = S;
  window.__soundLog = [];

  const ERR = {
    name_required: 'Enter a display name first.',
    name_blocked: "That name isn't allowed. Choose another.",
    full: 'This room is full.',
    in_progress: "This game has already started, so new players can't join.",
    closed: 'This room has closed.',
    not_found: 'No room found with that code.',
    no_public_rooms: 'No public rooms are waiting right now. Create one instead.',
    not_enough_players: 'You need at least 2 players to start.',
    too_many_words: '3 words max.',
    too_many_characters: '25 characters max.',
    letter_used: 'That letter has been used.',
    not_your_turn: "It's not your turn to pick.",
    window_closed: 'The challenge window has closed.',
    no_challenges_left: 'You have no challenges left.',
    incomplete_votes: 'Vote on every answer first.',
    settings_locked: 'Settings are locked once the game starts.',
    unknown_player: 'Your seat in this room has gone.',
  };
  const SETTING_NAMES = { maxPlayers: 'Max players', answerTime: 'Answer time', pickTime: 'Letter pick time',
    reviewFallback: 'Review wait', challengeTime: 'Challenge window' };
  const errText = (r) => {
    if (r.error === 'invalid_setting' && r.key) {
      return r.min !== undefined ? `${SETTING_NAMES[r.key] || r.key} must be between ${r.min} and ${r.max}.` : `${SETTING_NAMES[r.key] || r.key} isn't valid.`;
    }
    return ERR[r.error] || 'Something went wrong. Try again.';
  };

  // ---------- socket ----------
  const socket = io();
  window.__ngSocket = socket; // used by browser tests
  const emit = (ev, payload) => new Promise((res) => socket.emit(ev, payload, res));
  const act = (type, payload = {}) => emit('game:action', { type, ...payload }).then((r) => { if (!r.ok) toast(errText(r)); return r; });

  let booted = false;
  socket.on('connect', () => {
    if (!booted) { booted = true; boot(); return; }
    const sess = store.get('ng.session', null);
    if (sess && S.view) emit('room:rejoin', sess).then((r) => { if (!r.ok) removed(r.error); });
  });
  socket.on('state', (v) => {
    S.offset = v.now - Date.now();
    const prevPhase = S.view?.room.phase;
    S.view = v;
    S.screen = 'game';
    if (location.pathname !== `/r/${v.room.code}`) history.replaceState(null, '', `/r/${v.room.code}`);
    if (prevPhase !== v.room.phase || S.lastRound !== v.room.roundNo) announce(v);
    if (prevPhase && prevPhase !== 'final' && v.room.phase === 'final') setTimeout(confetti, 50);
    S.lastRound = v.room.roundNo;
    render();
  });
  socket.on('removed', ({ reason }) => removed(reason));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !socket.connected) socket.connect();
  });

  function removed(reason) {
    store.del('ng.session');
    S.view = null;
    history.replaceState(null, '', '/');
    show('message', { kind: reason });
  }

  const saveSession = (r) => { if (r.ok) store.set('ng.session', { code: r.code, token: r.token }); return r; };

  async function boot() {
    const m = location.pathname.match(/^\/r\/([A-Za-z0-9]+)/);
    const code = m ? m[1].toUpperCase() : null;
    const sess = store.get('ng.session', null);
    if (sess && (!code || sess.code === code)) {
      const r = await emit('room:rejoin', sess);
      if (r.ok) return;
      store.del('ng.session');
    }
    if (code) {
      const st = await fetch(`/api/room/${code}`).then((r) => r.json()).catch(() => ({ status: 'not_found' }));
      if (st.status === 'waiting') show('join', { code, roomName: st.name });
      else show('message', { kind: st.status, code });
    } else {
      show('home');
    }
  }

  function show(screen, data = {}) {
    S.screen = screen;
    S.data = data;
    render();
  }

  // ---------- helpers ----------
  const serverNow = () => Date.now() + S.offset;
  const secondsLeft = (deadline) => Math.max(0, Math.ceil((deadline - serverNow()) / 1000));
  const nameOf = (id) => S.view?.players.find((p) => p.id === id)?.name || 'Someone';
  const joinNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
  const roomLink = () => `${location.origin}/r/${S.view.room.code}`;
  const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
  const nameValue = () => ($('#nameInput')?.value || store.get('ng.name', '')).trim();

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.hidden = true; }, 3200);
  }

  function announce(v) {
    const r = v.room;
    const msg = {
      lobby: 'Lobby. Waiting for the host to start.',
      picking: r.pickerId === v.you?.id ? 'Your turn to pick a letter.' : `${nameOf(r.pickerId)} is picking a letter.`,
      answering: `The letter is ${r.letter}. Fill in your answers.`,
      voting: 'Time is up. Review your assigned answers.',
      challenge: 'Votes are in. You can challenge your rejected answers now.',
      results: 'Round scores are in.',
      pended: 'Review the leftover answers before the final scores.',
      final: 'The game is over. Final leaderboard.',
    }[r.phase];
    if (msg) $('#announcer').textContent = msg;
    if (r.phase === 'answering') beep(880, 0.12);
  }

  // ---------- sound (MS-05) ----------
  let audio;
  function beep(freq = 660, dur = 0.08) {
    if (S.muted) return;
    window.__soundLog.push({ freq, at: Date.now() });
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = freq;
      g.gain.value = 0.06;
      o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + dur);
    } catch { /* audio unavailable */ }
  }
  function syncMute() {
    const b = $('#muteBtn');
    b.textContent = S.muted ? 'Sound off' : 'Sound on';
    b.setAttribute('aria-pressed', String(S.muted));
    b.setAttribute('aria-label', S.muted ? 'Sound is off. Turn sound on' : 'Sound is on. Mute sound');
  }

  // ---------- timer ----------
  setInterval(() => {
    const el = $('#timer');
    const v = S.view;
    if (!el || !v || !v.room.deadline) return;
    const s = secondsLeft(v.room.deadline);
    el.textContent = `${s}s`;
    el.classList.toggle('low', s <= 5);
    if (v.room.phase === 'answering' && s <= 5 && s > 0) {
      const key = `${v.room.roundNo}:${s}`;
      if (!S.beeped.has(key)) { S.beeped.add(key); beep(s === 1 ? 990 : 660); }
    }
  }, 250);

  // ---------- render ----------
  function render() {
    const active = document.activeElement;
    const focusId = active && active.id;
    const sel = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

    const v = S.view;
    const inRoom = S.screen === 'game' && v;
    $('#roomChip').hidden = !inRoom;
    if (inRoom) $('#roomChip').textContent = v.room.code;
    $('#boardBtn').hidden = !(inRoom && v.room.phase !== 'lobby');
    syncMute();

    let html = '';
    if (inRoom) html = renderGame(v);
    else if (S.screen === 'join') html = renderJoin();
    else if (S.screen === 'browse') html = renderBrowse();
    else if (S.screen === 'message') html = renderMessage();
    else html = renderHome();
    app.innerHTML = html;

    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus({ preventScroll: true });
        if (sel && 'setSelectionRange' in el) { try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not text */ } }
      }
    }
    if ($('#boardDialog').open) fillBoard();
  }

  const nameField = (label = 'Your name') => `
    <div class="field"><label for="nameInput">${label}</label>
      <input id="nameInput" type="text" maxlength="20" autocomplete="nickname" value="${esc(store.get('ng.name', ''))}"></div>`;

  const TILE_COLOURS = ['c-name', 'c-food', 'c-animal', 'c-place', 'c-thing'];
  const letterColour = (L) => TILE_COLOURS[(L.charCodeAt(0) - 65) % 5];

  function renderHome() {
    const word = [...'ALPHABET'].map((L, i) => `<span class="tile hero-tile ${TILE_COLOURS[i % 5]}" style="--i:${i}">${L}</span>`).join('');
    const steps = [
      ['Make a room', 'Create a room and send the link, code or QR code to your friends. You need at least 2 players.'],
      ['Pick a letter', 'Players take turns choosing the letter. Each letter can only be played once per game.'],
      ['Beat the clock', 'Write a Name, Food, Animal, Place and Thing starting with that letter before the timer runs out. Up to 3 words each.'],
      ['Judge a friend', "You're given one other player's answers. Thumbs up if it counts, thumbs down if it doesn't."],
      ['Challenge it', 'Think a thumbs down was unfair? Challenge it and the whole group votes. You get 4 challenges a game.'],
      ['Win', 'Every thumbs up is a point. Whoever has the most after 26 letters, or when the host ends the game, wins.'],
    ];
    return `
      <h1 class="hero" aria-label="Alphabet Challenge"><span class="hero-word" aria-hidden="true">${word}</span><span class="hero-sub" aria-hidden="true">Challenge</span></h1>
      <p class="lede">Pick a letter. Beat the clock. Let your friends be the judge.</p>
      <div class="cat-strip" aria-hidden="true">${CATS.map((c) => `<span class="chip chip-${c}">${LABEL[c]}</span>`).join('')}</div>
      ${nameField()}
      <div class="row">
        <button class="btn" data-action="create">Create room</button>
        <button class="btn ghost" data-action="quickplay">Quick play</button>
        <button class="btn ghost" data-action="go-browse">Browse public rooms</button>
      </div>
      <h2>Got a room code?</h2>
      <div class="row">
        <label class="sr-only" for="codeInput">Room code</label>
        <input id="codeInput" type="text" maxlength="5" placeholder="Room code" autocapitalize="characters" style="max-width:170px">
        <button class="btn ghost" data-action="join-code">Join room</button>
      </div>
      <section class="howto" aria-labelledby="howto-title">
        <h2 id="howto-title">How to play</h2>
        <ol class="steps">${steps.map(([t, d], i) => `<li><span class="tile step-tile ${TILE_COLOURS[i % 5]}" aria-hidden="true">${i + 1}</span><div><h3>${t}</h3><p>${d}</p></div></li>`).join('')}</ol>
      </section>`;
  }

  function renderJoin() {
    return `
      <h1>Join ${esc(S.data.roomName)}</h1>
      <p class="muted">Room ${esc(S.data.code)}. Pick the name other players will see.</p>
      ${nameField()}
      <div class="row"><button class="btn" data-action="join-link">Join room</button>
      <a class="btn ghost" href="/">Back</a></div>`;
  }

  function renderBrowse() {
    const rooms = S.data.rooms;
    const list = !rooms ? '<p class="muted">Loading rooms…</p>'
      : !rooms.length ? '<p>No public rooms are waiting right now. Create one and invite people in.</p>'
        : `<ul class="rooms">${rooms.map((r) => `
          <li><div><strong>${esc(r.name)}</strong><br>
            <span class="muted small">${r.playerCount} of ${r.maxPlayers} players, ${r.settings.answerTime}s to answer</span></div>
            <button class="btn small" data-action="join-public" data-code="${esc(r.code)}" ${r.playerCount >= r.maxPlayers ? 'disabled' : ''}>Join</button></li>`).join('')}</ul>`;
    return `
      <h1>Public rooms</h1>
      <p class="muted">Rooms waiting to start. Games in progress can't be joined.</p>
      ${nameField()}
      ${list}
      <div class="row"><button class="btn ghost" data-action="go-browse">Refresh</button><button class="btn" data-action="create">Create room</button><a class="btn ghost" href="/">Back</a></div>`;
  }

  function renderMessage() {
    const k = S.data.kind;
    const code = S.data.code ? ` ${esc(S.data.code)}` : '';
    const copy = {
      closed: ['This room has closed', `Room${code} has ended and its link no longer works.`],
      in_progress: ['This game has already started', "New players can't join a game in progress. Start your own room instead."],
      full: ['This room is full', 'Every seat is taken. Start your own room instead.'],
      not_found: ['No room found', `There's no room with the code${code}. Check the code, or start your own room.`],
      kicked: ['You were removed from the room', 'The host removed you. You can start your own room.'],
    }[k] || ['You left the room', 'Start a new room or join another.'];
    return `
      <h1>${copy[0]}</h1>
      <p>${copy[1]}</p>
      ${nameField()}
      <div class="row"><button class="btn" data-action="create">Create room</button><a class="btn ghost" href="/">Home</a></div>`;
  }

  function renderGame(v) {
    const r = v.room;
    const body = {
      lobby: renderLobby, picking: renderPicking, answering: renderAnswering, voting: renderVoting,
      challenge: renderResults, results: renderRoundScores, pended: renderPended, final: renderFinal,
    }[r.phase](v);
    const hostBar = v.you?.isHost && !['lobby', 'final', 'pended'].includes(r.phase)
      ? '<button class="btn warn small" data-action="end-game">End game</button>' : '';
    const settings = r.phase === 'lobby' ? '' : `
      <details class="field"><summary>Game settings</summary>${settingsForm(v, true)}</details>`;
    const leave = '<button class="linkish" data-action="leave">Leave room</button>';
    return `${body}${settings}<div class="row">${hostBar}${leave}</div>`;
  }

  function settingsForm(v, locked) {
    const s = v.room.settings;
    const lim = v.limits.settings;
    const dis = locked ? 'disabled' : '';
    const num = (key, label, unit) => `
      <div class="field"><label for="set-${key}">${label}${unit ? ` (${unit})` : ''}</label>
      <input id="set-${key}" type="number" inputmode="numeric" min="${lim[key][0]}" max="${lim[key][1]}" value="${s[key]}" ${dis}>
      <p class="hint">${lim[key][0]} to ${lim[key][1]}</p></div>`;
    return `
      <form id="settingsForm" onsubmit="return false">
        <div class="field"><label for="set-roomName">Room name</label>
          <input id="set-roomName" type="text" maxlength="30" value="${esc(v.room.name)}" ${dis}></div>
        <fieldset><legend>Who can find this room</legend>
          <label class="radio"><input type="radio" name="visibility" value="private" ${v.room.visibility === 'private' ? 'checked' : ''} ${dis}> Private (link or code only)</label>
          <label class="radio"><input type="radio" name="visibility" value="public" ${v.room.visibility === 'public' ? 'checked' : ''} ${dis}> Public (listed in public rooms)</label>
        </fieldset>
        ${num('maxPlayers', 'Max players')}
        ${num('answerTime', 'Answer time', 'seconds')}
        ${num('pickTime', 'Letter pick time', 'seconds')}
        ${num('reviewFallback', 'Review wait after first voter', 'seconds')}
        ${num('challengeTime', 'Challenge window', 'seconds')}
        ${locked ? '<p class="muted small">Settings are locked once the game starts.</p>' : '<button class="btn ghost" type="button" data-action="save-settings">Save settings</button>'}
      </form>`;
  }

  function renderLobby(v) {
    const r = v.room;
    const host = v.you.isHost;
    const connected = v.players.filter((p) => p.connected).length;
    const players = v.players.map((p) => `
      <li><span>${esc(p.name)}${p.id === v.you.id ? ' <span class="muted">(you)</span>' : ''}${p.isHost ? '<span class="badge">Host</span>' : ''}${p.connected ? '' : '<span class="badge off">Away</span>'}</span>
      ${host && p.id !== v.you.id ? `<button class="btn ghost small" data-action="kick" data-id="${p.id}" aria-label="Remove ${esc(p.name)}">Remove</button>` : ''}</li>`).join('');
    const s = r.settings;
    const readOnly = `
      <ul class="players">
        <li><span>Visibility</span><span>${r.visibility === 'public' ? 'Public' : 'Private'}</span></li>
        <li><span>Answer time</span><span>${s.answerTime}s</span></li>
        <li><span>Letter pick</span><span>${s.pickTime}s</span></li>
        <li><span>Review wait</span><span>${s.reviewFallback}s</span></li>
        <li><span>Challenge window</span><span>${s.challengeTime}s</span></li>
      </ul>`;
    return `
      <h1>${esc(r.name)}</h1>
      <p class="muted">Share the link or room code. The room locks once the game starts.</p>
      <div class="code-big" aria-label="Room code ${[...r.code].join(' ')}">${esc(r.code)}</div>
      <p class="link-text" id="roomLink">${esc(roomLink())}</p>
      <div class="row">
        <button class="btn ghost small" data-action="copy-link">Copy link</button>
        <button class="btn ghost small" data-action="share-link">Share</button>
        <button class="btn ghost small" data-action="show-qr">Show QR code</button>
      </div>
      <h2>Players (${v.players.length} of ${s.maxPlayers})</h2>
      <ul class="players">${players}</ul>
      <h2>Settings</h2>
      ${host ? settingsForm(v, false) : readOnly}
      ${host ? `<div class="row"><button class="btn" id="startBtn" data-action="start" ${connected < 2 ? 'disabled' : ''}>Start game</button>
        ${connected < 2 ? '<span class="hint">You need at least 2 players to start.</span>' : ''}</div>`
        : `<p class="muted">Waiting for ${esc(nameOf(r.hostId))} to start the game.</p>`}`;
  }

  function renderPicking(v) {
    const r = v.room;
    const mine = r.pickerId === v.you.id;
    const used = new Set(r.usedLetters);
    const tiles = LETTERS.map((L) => {
      const isUsed = used.has(L);
      const label = isUsed ? `${L}, already used` : L;
      if (mine) return `<button class="tile ${letterColour(L)}" data-action="pick" data-letter="${L}" ${isUsed ? 'disabled' : ''} aria-label="${label}">${L}</button>`;
      return `<button class="tile ${letterColour(L)}" ${isUsed ? 'disabled' : 'aria-disabled="true"'} tabindex="-1" aria-label="${label}">${L}</button>`;
    }).join('');
    return `
      <div class="status"><h1>${mine ? 'Your pick' : `${esc(nameOf(r.pickerId))} is picking`}</h1><span class="timer" id="timer" role="timer" aria-label="Seconds left"></span></div>
      <p class="muted">Round ${r.roundNo + 1}. ${mine ? 'Choose the letter everyone plays this round.' : 'The letter appears for everyone at the same moment.'} Greyed letters have been used.</p>
      <div class="alphabet ${mine ? '' : 'watch'}" role="group" aria-label="Letters">${tiles}</div>`;
  }

  function renderAnswering(v) {
    const r = v.room;
    const a = v.answering;
    if (S.answersRound !== r.roundNo) {
      S.answersRound = r.roundNo;
      S.answers = { ...(a.answers || {}) };
    }
    const reveal = S.revealed !== r.roundNo;
    S.revealed = r.roundNo;
    if (!a.inRound) {
      return `<div class="tile big" aria-label="Letter ${r.letter}">${r.letter}</div>
        <p>This round started while you were away. You'll play from the next round.</p>
        <span class="timer" id="timer" role="timer"></span>`;
    }
    const rows = CATS.map((c) => {
      const val = S.answers[c] || '';
      const warn = val && val[0].toUpperCase() !== r.letter;
      return `<div class="sheet-row"><label for="ans-${c}" class="chip chip-${c}">${LABEL[c]}</label>
        <input id="ans-${c}" data-cat="${c}" type="text" maxlength="${v.limits.maxChars}" value="${esc(val)}" autocomplete="off" autocapitalize="words" spellcheck="false" aria-describedby="hint-${c}">
        <p class="hint ${warn ? 'warn' : ''}" id="hint-${c}">${warn ? `Doesn't start with ${r.letter}` : ''}</p></div>`;
    }).join('');
    return `
      <div class="status"><span class="timer" id="timer" role="timer" aria-label="Seconds left"></span><span class="muted">${a.doneCount} of ${a.participantCount} done</span></div>
      <div class="tile big ${letterColour(r.letter)} ${reveal ? 'reveal' : ''}" role="img" aria-label="Letter ${r.letter}">${r.letter}</div>
      <form id="sheet" autocomplete="off" onsubmit="return false">${rows}</form>
      <p class="muted small">Up to ${v.limits.maxWords} words and ${v.limits.maxChars} characters each. You can edit until the timer runs out.</p>
      <div class="row"><button class="btn" data-action="toggle-done" aria-pressed="${a.done}">${a.done ? 'Keep editing' : "I'm done"}</button></div>`;
  }

  function reviewSet(set, key, letter) {
    const chosen = S.votes[key] || {};
    const rows = CATS.map((c) => {
      const ans = set.answers[c];
      if (!ans) return `<div class="review-row"><span class="cat chip chip-${c}">${LABEL[c]}</span><span class="ans muted">No answer</span><span class="muted small">0 points</span></div>`;
      return `<div class="review-row"><span class="cat chip chip-${c}">${LABEL[c]}</span><span class="ans">${esc(ans)}</span>
        <span class="thumbs">
          <button class="thumb up" data-action="vote" data-key="${key}" data-cat="${c}" data-up="1" aria-pressed="${chosen[c] === true}" aria-label="Accept ${esc(ans)} for ${LABEL[c]}">👍</button>
          <button class="thumb down" data-action="vote" data-key="${key}" data-cat="${c}" data-up="0" aria-pressed="${chosen[c] === false}" aria-label="Reject ${esc(ans)} for ${LABEL[c]}">👎</button>
        </span></div>`;
    }).join('');
    const complete = CATS.every((c) => !set.answers[c] || typeof chosen[c] === 'boolean');
    return { rows, complete };
  }

  function renderVoting(v) {
    const r = v.room;
    const sets = v.voting.assigned;
    const blank = (s) => CATS.every((c) => !s.answers[c]);
    const blocks = sets.map((s) => {
      if (s.completed && blank(s)) return `<h2>${esc(s.name)}'s answers</h2><p>${esc(s.name)} didn't write any answers this round, so there's nothing for you to review. They score 0.</p>`;
      if (s.completed) return `<h2>${esc(s.name)}'s answers</h2><p>Votes in. Thanks.</p>`;
      const key = `r${r.roundNo}:${s.authorId}`;
      const { rows, complete } = reviewSet(s, key, r.letter);
      return `<section aria-labelledby="h-${s.authorId}"><h2 id="h-${s.authorId}">${esc(s.name)}'s answers</h2>${rows}
        <div class="row"><button class="btn" data-action="submit-votes" data-author="${s.authorId}" data-key="${key}" ${complete ? '' : 'disabled'}>Submit votes</button></div></section>`;
    }).join('');
    return `
      <div class="status"><h1>Review</h1>${v.voting.closing ? '<span class="muted">Closes in</span> <span class="timer" id="timer" role="timer" aria-label="Seconds left"></span>' : ''}</div>
      ${v.voting.closing ? '' : `<p class="muted small">Voting closes ${v.voting.fallbackSeconds} seconds after the first player submits.</p>`}
      <p class="muted">Letter ${r.letter}. Give a thumbs up if the answer fits the category and starts with ${r.letter}.</p>
      ${blocks || '<p>Nothing for you to review this round.</p>'}
      ${v.voting.waitingOnAway ? '<p><strong>A player has lost connection. Waiting up to 45 seconds for them to come back and review.</strong></p>'
        : sets.every((x) => x.completed) ? '<p><strong>Waiting for the other players to finish reviewing.</strong></p>' : ''}
      <p class="muted">${v.voting.completedCount} of ${v.voting.total} answer sets reviewed.</p>`;
  }

  function resultsTable(v, allowChallenge) {
    const res = v.results;
    const challenged = new Set(res.challenges.map((c) => `${c.authorId}:${c.category}`));
    const rows = res.sets.map((s) => {
      const cells = CATS.map((c) => {
        const ans = s.answers[c];
        if (s.status === 'pended') return `<td class="blank">${ans ? `${esc(ans)}<br><span class="small">Pending review</span>` : 'No answer'}</td>`;
        if (!ans) return '<td class="blank">No answer</td>';
        const yes = s.votes[c] === true;
        const canChallenge = allowChallenge && s.authorId === v.you.id && !yes && res.windowOpen
          && v.you.challengesLeft > 0 && !challenged.has(`${s.authorId}:${c}`);
        return `<td class="${yes ? 'yes' : 'no'}"><span class="mark" aria-label="${yes ? 'Accepted' : 'Rejected'}">${yes ? '✓' : '✗'}</span><span class="ans">${esc(ans)}</span>
          ${canChallenge ? `<br><button class="btn ghost small" data-action="challenge" data-cat="${c}" aria-label="Challenge ${esc(ans)} for ${LABEL[c]}">Challenge</button>` : ''}</td>`;
      }).join('');
      return `<tr class="${s.authorId === v.you.id ? 'you' : ''}"><th scope="row">${esc(s.name)}</th>${cells}<td>${s.status === 'pended' ? '–' : s.points}</td></tr>`;
    }).join('');
    return `<div class="scroll-x" tabindex="0" role="region" aria-label="Round answers"><table>
      <thead><tr><th scope="col">Player</th>${CATS.map((c) => `<th scope="col">${LABEL[c]}</th>`).join('')}<th scope="col">Points</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function renderResults(v) {
    const r = v.room;
    const res = v.results;
    const chal = res.challenges.map((c) => {
      const status = { open: 'Voting now', tie: 'Tied', won: 'Upheld: point awarded', lost: 'Rejected: no point' }[c.status];
      const buttons = c.canVote ? `<div class="row">
          <button class="btn small" data-action="challenge-vote" data-id="${c.id}" data-up="1">👍 It counts</button>
          <button class="btn ghost small" data-action="challenge-vote" data-id="${c.id}" data-up="0">👎 It doesn't</button></div>`
        : c.youDecide ? `<p><strong>The vote tied. You decide.</strong></p><div class="row">
          <button class="btn small" data-action="decide-tie" data-id="${c.id}" data-up="1">Award the point</button>
          <button class="btn ghost small" data-action="decide-tie" data-id="${c.id}" data-up="0">No point</button></div>`
          : c.youVoted ? '<p class="muted small">You voted.</p>' : '';
      return `<div class="chal"><p style="margin:0"><strong>${esc(c.authorName)}</strong> says <strong>${esc(c.answer)}</strong> counts as ${LABEL[c.category].toLowerCase() === 'animal' ? 'an' : 'a'} ${LABEL[c.category]}.</p>
        <p class="small" style="margin:0">${c.up} up, ${c.down} down. ${status}.</p>${buttons}</div>`;
    }).join('');
    return `
      <div class="status"><h1>Round ${r.roundNo}: ${esc(r.letter)}</h1><span class="timer" id="timer" role="timer" aria-label="Seconds left"></span></div>
      <p class="muted">${!res.windowOpen ? 'The challenge window has closed.'
        : res.youCanChallenge ? `Think a thumbs down was wrong? Challenge it. You have ${v.you.challengesLeft} of 4 challenges left this game.`
          : v.you.challengesLeft > 0 ? "You've nothing to challenge this round. Waiting for the others to decide."
            : "You've used all 4 challenges this game. Waiting for the others to decide."}</p>
      ${resultsTable(v, true)}
      <h2>Challenges</h2>
      ${chal || '<p class="muted">No challenges yet.</p>'}`;
  }

  const boardList = (v, winners = []) => `<ol class="leader">${v.leaderboard.map((p) => `
    <li class="${winners.includes(p.id) ? 'win' : ''}"><span class="rank">${p.rank}</span><span>${esc(p.name)}${p.id === v.you?.id ? ' <span class="muted">(you)</span>' : ''}</span><span class="pts">${p.score}</span></li>`).join('')}</ol>`;

  function renderRoundScores(v) {
    const r = v.room;
    const pts = r.lastRoundPoints || {};
    const list = v.players.map((p) => `<li><span></span><span>${esc(p.name)}</span><span class="pts">+${pts[p.id] || 0}</span></li>`).join('');
    return `
      <h1>Round ${r.roundNo} scores</h1>
      <ul class="leader">${list}</ul>
      <h2>Leaderboard</h2>
      ${boardList(v)}
      <p class="muted">Next letter in <span class="timer" id="timer" role="timer"></span></p>`;
  }

  function renderPended(v) {
    const p = v.pended;
    const blocks = p.assigned.map((s) => {
      const key = `p:${s.id}`;
      const { rows, complete } = reviewSet(s, key, s.letter);
      return `<section><h2>${esc(s.name)}'s answers for ${esc(s.letter)}</h2>${rows}
        <div class="row"><button class="btn" data-action="submit-pended" data-item="${s.id}" data-key="${key}" ${complete ? '' : 'disabled'}>Submit votes</button></div></section>`;
    }).join('');
    return `
      <div class="status"><h1>Leftover answers</h1><span class="timer" id="timer" role="timer" aria-label="Seconds left"></span></div>
      <p class="muted">Some answers weren't reviewed during the game. They're scored now, before the final leaderboard.</p>
      ${blocks || `<p>Waiting for others to finish (${p.remaining} of ${p.total} left).</p>`}`;
  }

  function renderFinal(v) {
    const f = v.final;
    const names = f.winners.map(nameOf);
    const h = f.highlights;
    const thumbs = h.mostThumbs ? `<p>Most thumbs up: <strong>${esc(joinNames(h.mostThumbs.playerIds.map(nameOf)))}</strong> with ${h.mostThumbs.count}${h.mostThumbs.playerIds.length > 1 ? ' each' : ''}.</p>` : '';
    const chal = h.mostChallenged
      ? `<p>Most challenged answer: <strong>${esc(h.mostChallenged.answer)}</strong> as ${LABEL[h.mostChallenged.category]} by ${esc(nameOf(h.mostChallenged.playerId))}, ${h.mostChallenged.votes} ${h.mostChallenged.votes === 1 ? 'vote' : 'votes'}, ${h.mostChallenged.outcome === 'won' ? 'upheld' : 'rejected'}.</p>`
      : '<p class="muted">No challenges this game.</p>';
    const connected = v.players.filter((p) => p.connected).length;
    return `
      <h1 id="winnerHeading">${names.length > 1 ? `Joint winners: ${esc(joinNames(names))}` : `${esc(names[0] || 'Nobody')} wins`}</h1>
      <p class="muted">${f.alphabetComplete ? 'All 26 letters played.' : 'The host ended the game.'}</p>
      <h2>Final leaderboard</h2>
      ${boardList(v, f.winners)}
      <h2>Highlights</h2>
      <div id="highlights">${thumbs}${chal}</div>
      <div class="row">
        <button class="btn" data-action="play-again">Play again</button>
        ${v.you.isHost ? `<button class="btn ghost" data-action="restart" ${connected < 2 ? 'disabled' : ''}>Restart game</button>` : ''}
      </div>`;
  }

  function confetti() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const box = document.createElement('div');
    box.className = 'confetti';
    box.setAttribute('aria-hidden', 'true');
    const colours = ['#FFE45C', '#FFB866', '#7FE3B4', '#93CBFF', '#FF9BCB'];
    for (let i = 0; i < 70; i++) {
      const b = document.createElement('i');
      b.style.left = `${Math.random() * 100}%`;
      b.style.background = colours[i % 5];
      b.style.animationDelay = `${Math.random() * 0.6}s`;
      b.style.animationDuration = `${2.2 + Math.random() * 1.6}s`;
      b.style.transform = `rotate(${Math.random() * 360}deg)`;
      box.appendChild(b);
    }
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 4500);
  }

  function fillBoard() {
    if (S.view) $('#boardBody').innerHTML = boardList(S.view);
  }

  // ---------- actions ----------
  async function withName(fn) {
    const name = nameValue();
    if (!name) { toast(ERR.name_required); $('#nameInput')?.focus(); return; }
    store.set('ng.name', name);
    const r = saveSession(await fn(name));
    if (!r.ok) {
      if (['closed', 'in_progress', 'full', 'not_found'].includes(r.error) && S.screen !== 'home') show('message', { kind: r.error, code: S.data.code });
      else toast(errText(r));
    }
  }

  async function loadRooms() {
    show('browse', { rooms: null });
    const rooms = await fetch('/api/rooms').then((r) => r.json()).catch(() => []);
    if (S.screen === 'browse') show('browse', { rooms });
  }

  const handlers = {
    create: () => withName((name) => emit('room:create', { name })),
    quickplay: () => withName((name) => emit('room:quickplay', { name })),
    'go-browse': () => loadRooms(),
    'join-code': () => {
      const code = ($('#codeInput')?.value || '').trim().toUpperCase();
      if (!code) { toast('Enter a room code.'); return; }
      withName((name) => emit('room:join', { code, name })).then(() => {
        if (S.screen === 'home' && !S.view) { /* toast already shown */ }
      });
    },
    'join-link': () => withName((name) => emit('room:join', { code: S.data.code, name })),
    'join-public': (el) => withName((name) => emit('room:join', { code: el.dataset.code, name })),
    leave: async () => {
      await emit('room:leave');
      store.del('ng.session');
      S.view = null;
      history.replaceState(null, '', '/');
      show('home');
    },
    'toggle-mute': () => { S.muted = !S.muted; store.set('ng.muted', S.muted); syncMute(); },
    'open-board': () => { fillBoard(); $('#boardDialog').showModal(); },
    'copy-link': async () => {
      try { await navigator.clipboard.writeText(roomLink()); toast('Link copied'); } catch { toast(`Copy this link: ${roomLink()}`); }
    },
    'share-link': async () => {
      if (navigator.share) {
        try { await navigator.share({ title: 'Join my Alphabet Challenge', text: `Room ${S.view.room.code}`, url: roomLink() }); } catch { /* dismissed */ }
      } else {
        handlers['copy-link']();
      }
    },
    'show-qr': () => {
      $('#qrImg').src = `/qr/${S.view.room.code}.png`;
      $('#qrLink').textContent = roomLink();
      $('#qrDialog').showModal();
    },
    kick: (el) => act('kick', { playerId: el.dataset.id }),
    'save-settings': () => {
      const patch = { roomName: $('#set-roomName').value, visibility: document.querySelector('input[name=visibility]:checked')?.value };
      for (const k of ['maxPlayers', 'answerTime', 'pickTime', 'reviewFallback', 'challengeTime']) patch[k] = Number($(`#set-${k}`).value);
      act('settings', { patch }).then((r) => { if (r.ok) toast('Settings saved'); });
    },
    start: () => act('start'),
    pick: (el) => act('pick', { letter: el.dataset.letter }),
    'toggle-done': () => act('done', { done: !S.view.answering.done }),
    vote: (el) => {
      const { key, cat } = el.dataset;
      S.votes[key] = { ...(S.votes[key] || {}), [cat]: el.dataset.up === '1' };
      render();
    },
    'submit-votes': (el) => act('votes', { authorId: el.dataset.author, votes: S.votes[el.dataset.key] || {} }),
    'submit-pended': (el) => act('pendedVotes', { itemId: el.dataset.item, votes: S.votes[el.dataset.key] || {} }),
    challenge: (el) => act('challenge', { category: el.dataset.cat }),
    'challenge-vote': (el) => act('challengeVote', { challengeId: el.dataset.id, up: el.dataset.up === '1' }),
    'decide-tie': (el) => act('decideTie', { challengeId: el.dataset.id, up: el.dataset.up === '1' }),
    'end-game': () => { if (confirm('End the game now for everyone?')) act('end'); },
    'play-again': () => act('playAgain'),
    restart: () => {
      if (S.view.final?.alphabetComplete) $('#restartDialog').showModal();
      else act('restart');
    },
    'restart-confirm': () => { $('#restartDialog').close(); act('restart'); },
    'restart-cancel': () => $('#restartDialog').close(),
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    const h = handlers[el.dataset.action];
    if (h) { e.preventDefault(); h(el); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'nameInput') {
      if (S.screen === 'join') handlers['join-link']();
      else if (S.screen === 'home') handlers.create();
    }
    if (e.target.id === 'codeInput') handlers['join-code']();
  });

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.dataset || !el.dataset.cat || el.tagName !== 'INPUT') return;
    const cat = el.dataset.cat;
    const hint = $(`#hint-${cat}`);
    const letter = S.view?.room.letter || '';
    if (words(el.value) > 3) {
      const pos = Math.max(0, el.selectionStart - 1);
      el.value = S.answers[cat] || '';
      el.setSelectionRange(pos, pos);
      hint.textContent = '3 words max.';
      hint.classList.add('warn');
      return;
    }
    S.answers[cat] = el.value;
    if (el.value.length >= 25) { hint.textContent = '25 characters max.'; hint.classList.add('warn'); }
    else if (el.value.trim() && el.value.trim()[0].toUpperCase() !== letter) { hint.textContent = `Doesn't start with ${letter}`; hint.classList.add('warn'); }
    else { hint.textContent = ''; hint.classList.remove('warn'); }
    act('answer', { category: cat, text: el.value });
  });

  syncMute();
})();
