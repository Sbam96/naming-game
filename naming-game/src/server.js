'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { RegExpMatcher, englishDataset, englishRecommendedTransformers } = require('obscenity');
const { Registry } = require('./registry');

const dataset = englishDataset.build();
// "Naming Game", "Evening Gala": the letters across "-ing ga-" look like a slur variant to the filter.
dataset.whitelistedTerms = [...(dataset.whitelistedTerms || []), 'ing ga', 'ingga'];
const matcher = new RegExpMatcher({ ...dataset, ...englishRecommendedTransformers });
// Also check with spacing/punctuation removed so "f u c k" or "s.h.i.t" can't slip through.
const isOffensive = (s) => {
  const text = String(s || '');
  return matcher.hasMatch(text) || matcher.hasMatch(text.replace(/[\s._\-*]+/g, ''));
};

function createServer({ port = process.env.PORT || 3000, tickMs = 200, testHooks = process.env.NG_TEST_HOOKS === '1' } = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });
  const registry = new Registry({ isOffensive });
  const sockets = new Map(); // code -> Set(socket)
  const publicDir = path.join(__dirname, '..', 'public');

  const origin = (req) => `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`;

  app.get('/api/rooms', (req, res) => res.json(registry.publicRooms()));
  app.get('/api/room/:code', (req, res) => res.json(registry.status(req.params.code)));
  app.get('/qr/:code.png', async (req, res) => {
    const code = String(req.params.code).toUpperCase();
    if (!registry.get(code)) return res.status(404).end();
    const png = await QRCode.toBuffer(`${origin(req)}/r/${code}`, { margin: 1, width: 280 });
    res.type('png').send(png);
  });
  app.get('/r/:code', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.use(express.static(publicDir));

  const track = (socket, room, player) => {
    socket.data.code = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    if (!sockets.has(room.code)) sockets.set(room.code, new Set());
    sockets.get(room.code).add(socket);
  };
  const untrack = (socket) => {
    const set = sockets.get(socket.data.code);
    if (set) set.delete(socket);
    if (socket.data.code) socket.leave(socket.data.code);
    socket.data.code = null;
    socket.data.playerId = null;
  };

  const broadcast = (room) => {
    const now = Date.now();
    for (const s of sockets.get(room.code) || []) {
      if (!room.players.has(s.data.playerId)) {
        s.emit('removed', { reason: room.closed ? 'closed' : 'kicked' });
        untrack(s);
        continue;
      }
      s.emit('state', room.viewFor(s.data.playerId, now));
    }
  };

  const welcome = (socket, room, player, ack) => {
    track(socket, room, player);
    ack({ ok: true, code: room.code, token: player.token, playerId: player.id });
    broadcast(room);
  };

  io.on('connection', (socket) => {
    const safeAck = (ack) => (typeof ack === 'function' ? ack : () => {});

    socket.on('room:create', (msg = {}, ack) => {
      ack = safeAck(ack);
      if (socket.data.code) return ack({ ok: false, error: 'already_in_room' });
      const res = registry.create({ hostName: msg.name, roomName: msg.roomName, visibility: msg.visibility });
      if (!res.ok) return ack(res);
      welcome(socket, res.room, res.player, ack);
    });

    socket.on('room:join', (msg = {}, ack) => {
      ack = safeAck(ack);
      if (socket.data.code) return ack({ ok: false, error: 'already_in_room' });
      const room = registry.get(msg.code);
      if (!room) return ack({ ok: false, error: registry.status(msg.code).status });
      const res = room.addPlayer(msg.name, Date.now());
      if (!res.ok) return ack(res);
      welcome(socket, room, res.player, ack);
    });

    socket.on('room:rejoin', (msg = {}, ack) => {
      ack = safeAck(ack);
      const room = registry.get(msg.code);
      if (!room) return ack({ ok: false, error: registry.status(msg.code).status });
      const res = room.rejoin(msg.token, Date.now());
      if (!res.ok) return ack(res);
      if (socket.data.code) untrack(socket);
      welcome(socket, room, res.player, ack);
    });

    socket.on('room:quickplay', (msg = {}, ack) => {
      ack = safeAck(ack);
      if (socket.data.code) return ack({ ok: false, error: 'already_in_room' });
      const room = registry.quickPlayRoom();
      if (!room) return ack({ ok: false, error: 'no_public_rooms' });
      const res = room.addPlayer(msg.name, Date.now());
      if (!res.ok) return ack(res);
      welcome(socket, room, res.player, ack);
    });

    socket.on('room:leave', (msg, ack) => {
      ack = safeAck(ack);
      const room = registry.get(socket.data.code);
      if (room) {
        room.leave(socket.data.playerId, Date.now());
        untrack(socket);
        broadcast(room);
        registry.sweep();
      }
      ack({ ok: true });
    });

    socket.on('game:action', (msg = {}, ack) => {
      ack = safeAck(ack);
      const room = registry.get(socket.data.code);
      const id = socket.data.playerId;
      if (!room || !id) return ack({ ok: false, error: 'not_in_room' });
      const now = Date.now();
      let res;
      switch (msg.type) {
        case 'settings': res = room.updateSettings(id, msg.patch); break;
        case 'start': res = room.start(id, now); break;
        case 'kick': res = room.kick(id, msg.playerId, now); break;
        case 'pick': res = room.pickLetter(id, msg.letter, now); break;
        case 'answer': res = room.setAnswer(id, msg.category, msg.text, now); break;
        case 'done': res = room.setDone(id, !!msg.done, now); break;
        case 'votes': res = room.submitVotes(id, msg.authorId, msg.votes, now); break;
        case 'challenge': res = room.raiseChallenge(id, msg.category, now); break;
        case 'challengeVote': res = room.voteChallenge(id, msg.challengeId, msg.up, now); break;
        case 'decideTie': res = room.decideTie(id, msg.challengeId, msg.up, now); break;
        case 'pendedVotes': res = room.submitPendedVotes(id, msg.itemId, msg.votes, now); break;
        case 'end': res = room.endGame(id, now); break;
        case 'restart': res = room.restart(id, now); break;
        case 'playAgain': res = room.playAgain(id, now); break;
        default: res = { ok: false, error: 'unknown_action' };
      }
      ack(res);
      // answers are private until the round closes, so typing doesn't need a broadcast
      if (res.ok && msg.type !== 'answer') broadcast(room);
    });

    // Test-only controls (off unless NG_TEST_HOOKS=1): fast-forward timers so browser tests don't wait.
    if (testHooks) {
      socket.on('test:hook', (msg = {}, ack) => {
        ack = safeAck(ack);
        const room = registry.get(socket.data.code);
        if (!room) return ack({ ok: false });
        const now = Date.now();
        if (msg.action === 'useLetters') for (const L of msg.letters || []) room.usedLetters.add(L);
        if (msg.action === 'deadlineIn') {
          room.deadline = now + (msg.ms || 0);
          if (room.round && room.round.challengeDeadline) room.round.challengeDeadline = room.deadline;
        }
        room.bump();
        broadcast(room);
        ack({ ok: true });
      });
    }

    socket.on('disconnect', () => {
      const room = registry.get(socket.data.code);
      if (room && room.players.has(socket.data.playerId)) {
        room.disconnect(socket.data.playerId, Date.now());
        broadcast(room);
      }
      untrack(socket);
    });
  });

  const timer = setInterval(() => {
    const now = Date.now();
    for (const room of registry.rooms.values()) {
      if (room.tick(now)) broadcast(room);
    }
    registry.sweep();
  }, tickMs);

  return {
    app, io, registry, server,
    listen: () => new Promise((resolve) => server.listen(port, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { clearInterval(timer); io.close(() => resolve()); }),
  };
}

if (require.main === module) {
  createServer().listen().then((port) => console.log(`Naming Game running on http://localhost:${port}`));
}

module.exports = { createServer, isOffensive };
