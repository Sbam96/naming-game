'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../src/server');

let srv, base;
test.before(async () => {
  srv = createServer({ port: 0, tickMs: 50 });
  const port = await srv.listen();
  base = `http://localhost:${port}`;
});
test.after(async () => { await srv.close(); });

const clients = [];
test.afterEach(() => { while (clients.length) clients.pop().disconnect(); });

function client() {
  const c = connect(base, { transports: ['websocket'], forceNew: true, reconnection: false });
  clients.push(c);
  c.states = [];
  c.on('state', (s) => { s.receivedAt = performance.now(); c.states.push(s); });
  return c;
}
const call = (c, ev, payload) => new Promise((res) => c.emit(ev, payload, res));
const act = (c, type, extra = {}) => call(c, 'game:action', { type, ...extra });
const lastState = (c) => c.states.at(-1);
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timed out');
};
const api = (path) => fetch(base + path).then((r) => r.json());

async function room(visibility = 'private', n = 2, roomName) {
  const host = client();
  const created = await call(host, 'room:create', { name: 'Host', visibility, roomName });
  assert.equal(created.ok, true);
  const guests = [];
  for (let i = 1; i < n; i++) {
    const g = client();
    assert.equal((await call(g, 'room:join', { code: created.code, name: `G${i}` })).ok, true);
    guests.push(g);
  }
  return { host, guests, code: created.code, token: created.token };
}

test('SL-01 a created room returns a unique link code and the lobby state', async () => {
  const a = await room();
  const b = await room();
  assert.notEqual(a.code, b.code);
  await waitFor(() => lastState(a.host));
  assert.equal(lastState(a.host).room.code, a.code);
  assert.equal((await api(`/api/room/${a.code}`)).status, 'waiting');
});

test('SL-02 the /r/CODE link serves the app', async () => {
  const { code } = await room();
  const html = await fetch(`${base}/r/${code}`).then((r) => r.text());
  assert.match(html, /<main id="app"/);
});

test('SL-06 closed and in-progress rooms report why they cannot be joined', async () => {
  const r = await room('private', 2);
  await act(r.host, 'start');
  assert.equal((await api(`/api/room/${r.code}`)).status, 'in_progress');
  const late = client();
  assert.equal((await call(late, 'room:join', { code: r.code, name: 'Late' })).error, 'in_progress');
  const r2 = await room('private', 1);
  await call(r2.host, 'room:leave');
  assert.equal((await api(`/api/room/${r2.code}`)).status, 'closed');
  assert.equal((await api('/api/room/ZZZZZ')).status, 'not_found');
});

test('GR-08 joining after the game starts is refused', async () => {
  const r = await room('public', 2);
  await act(r.host, 'start');
  const late = client();
  const res = await call(late, 'room:join', { code: r.code, name: 'Late' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'in_progress');
});

test('GR-09 the room closes and its code stops working when the last player leaves', async () => {
  const r = await room('private', 2);
  await call(r.guests[0], 'room:leave');
  assert.equal((await api(`/api/room/${r.code}`)).status, 'waiting');
  await call(r.host, 'room:leave');
  assert.equal((await api(`/api/room/${r.code}`)).status, 'closed');
  const c = client();
  assert.equal((await call(c, 'room:join', { code: r.code, name: 'X' })).error, 'closed');
});

test('JG-01 private rooms are hidden from listings but joinable by code', async () => {
  const r = await room('private', 1, 'Secret');
  const list = await api('/api/rooms');
  assert.equal(list.some((x) => x.code === r.code), false);
  const c = client();
  assert.equal((await call(c, 'room:join', { code: r.code.toLowerCase(), name: 'Friend' })).ok, true);
});

test('JG-02 the public list shows only waiting rooms, with name, count and settings', async () => {
  const waiting = await room('public', 1, 'Open Table');
  const playing = await room('public', 2, 'Busy Table');
  await act(playing.host, 'start');
  const list = await api('/api/rooms');
  const w = list.find((x) => x.code === waiting.code);
  assert.ok(w);
  assert.equal(w.name, 'Open Table');
  assert.equal(w.playerCount, 1);
  assert.equal(w.settings.answerTime, 50);
  assert.equal(list.some((x) => x.code === playing.code), false);
});

test('JG-04 quick play drops a player into a waiting public room with space', async () => {
  // make sure every other public room is gone or full, then open one
  for (const r of srv.registry.rooms.values()) if (r.visibility === 'public') r.visibility = 'private';
  const r = await room('public', 1, 'Quick');
  const c = client();
  const res = await call(c, 'room:quickplay', { name: 'Speedy' });
  assert.equal(res.ok, true);
  assert.equal(res.code, r.code);
});

test('JG-06 a player who drops mid-game rejoins with their token and keeps their seat and score', async () => {
  const r = await room('private', 2);
  await act(r.host, 'start');
  const hostId = (await waitFor(() => lastState(r.host))).you.id;
  const live = srv.registry.get(r.code);
  live.players.get(hostId).score = 7;
  r.host.disconnect();
  await waitFor(() => live.players.get(hostId).connected === false);
  const again = client();
  const res = await call(again, 'room:rejoin', { code: r.code, token: r.token });
  assert.equal(res.ok, true);
  const s = await waitFor(() => lastState(again));
  assert.equal(s.you.id, hostId);
  assert.equal(s.you.score, 7);
  assert.notEqual(s.room.phase, 'lobby');
});

test('MS-01 all players see the letter reveal within 1 second of each other', async () => {
  const r = await room('private', 4);
  const all = [r.host, ...r.guests];
  await act(r.host, 'start');
  await waitFor(() => lastState(r.host)?.room.phase === 'picking');
  const picker = lastState(r.host).room.pickerId;
  const pickerClient = all.find((c) => lastState(c)?.you.id === picker);
  await act(pickerClient, 'pick', { letter: 'M' });
  const times = await waitFor(() => {
    const t = all.map((c) => c.states.find((s) => s.room.phase === 'answering' && s.room.letter === 'M')?.receivedAt);
    return t.every(Boolean) ? t : null;
  });
  const spread = Math.max(...times) - Math.min(...times);
  assert.ok(spread < 1000, `spread ${spread}ms`);
  const deadlines = new Set(all.map((c) => c.states.find((s) => s.room.phase === 'answering').room.deadline));
  assert.equal(deadlines.size, 1);
});

test('MS-03 no account is needed to create or join', async () => {
  const c = client(); // no auth headers, cookies or tokens
  const res = await call(c, 'room:create', { name: 'Anon' });
  assert.equal(res.ok, true);
  const d = client();
  assert.equal((await call(d, 'room:join', { code: res.code, name: 'Anon2' })).ok, true);
});

test('MS-04 offensive names are refused over the wire', async () => {
  const c = client();
  assert.equal((await call(c, 'room:create', { name: 'f u c k' })).error, 'name_blocked');
  assert.equal((await call(c, 'room:create', { name: 'Ste', roomName: 'shit room' })).error, 'name_blocked');
});

test('PR-03 other players never receive your answers while the round is open', async () => {
  const r = await room('private', 2);
  await act(r.host, 'start');
  await waitFor(() => lastState(r.host)?.room.phase === 'picking');
  const pickerId = lastState(r.host).room.pickerId;
  const picker = [r.host, r.guests[0]].find((c) => lastState(c).you.id === pickerId);
  await act(picker, 'pick', { letter: 'Q' });
  await waitFor(() => lastState(r.guests[0])?.room.phase === 'answering');
  await act(r.host, 'answer', { category: 'place', text: 'Quebec' });
  await act(r.guests[0], 'done', { done: true });
  await new Promise((res) => setTimeout(res, 100));
  const seen = r.guests[0].states.filter((s) => s.room.phase === 'answering');
  assert.equal(JSON.stringify(seen).includes('Quebec'), false);
});
