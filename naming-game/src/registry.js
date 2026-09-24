'use strict';
const crypto = require('crypto');
const { Room } = require('./engine');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_LENGTH = 5;

class Registry {
  constructor({ isOffensive = () => false, rng = Math.random } = {}) {
    this.rooms = new Map();
    this.closedCodes = new Set();
    this.isOffensive = isOffensive;
    this.rng = rng;
  }

  newCode() {
    for (;;) {
      let code = '';
      const bytes = crypto.randomBytes(CODE_LENGTH);
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
      if (!this.rooms.has(code) && !this.closedCodes.has(code)) return code;
    }
  }

  create({ hostName, roomName, visibility, now = Date.now() }) {
    if (roomName && this.isOffensive(String(roomName))) return { ok: false, error: 'name_blocked' };
    const code = this.newCode();
    const room = new Room({ code, roomName, visibility, now, rng: this.rng, isOffensive: this.isOffensive });
    const res = room.addPlayer(hostName, now);
    if (!res.ok) return res;
    this.rooms.set(code, room);
    return { ok: true, room, player: res.player };
  }

  get(code) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    return room && !room.closed ? room : null;
  }

  status(code) {
    const c = String(code || '').toUpperCase();
    const room = this.rooms.get(c);
    if (!room || room.closed) return { status: this.closedCodes.has(c) || room ? 'closed' : 'not_found' };
    if (room.phase !== 'lobby') return { status: 'in_progress', name: room.name };
    if (room.players.size >= room.settings.maxPlayers) return { status: 'full', name: room.name };
    return { status: 'waiting', name: room.name, playerCount: room.players.size };
  }

  sweep() {
    for (const [code, room] of this.rooms) {
      if (room.closed) { this.rooms.delete(code); this.closedCodes.add(code); }
    }
  }

  publicRooms() {
    return [...this.rooms.values()]
      .filter((r) => !r.closed && r.visibility === 'public' && r.phase === 'lobby')
      .map((r) => r.summary());
  }

  quickPlayRoom() {
    const open = [...this.rooms.values()].filter((r) => !r.closed && r.visibility === 'public'
      && r.phase === 'lobby' && r.players.size < r.settings.maxPlayers);
    if (!open.length) return null;
    return open[Math.floor(this.rng() * open.length)];
  }
}

module.exports = { Registry, CODE_ALPHABET, CODE_LENGTH };
