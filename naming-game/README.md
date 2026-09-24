# Naming Game

Name, Food, Animal, Place, Thing: the pen-and-paper game, played live in the browser. Built to the
"Naming Game — Requirements v1.0" spec.

## Run it

Needs Node 18 or later.

```
npm install
npm start          # http://localhost:3000
```

Open two browser windows (or a phone on the same network) to play against yourself.

## Test it

```
npm test           # engine + server tests (72)
npm run test:e2e   # browser tests (26); needs Python 3 and Playwright with Chromium
```

Test names start with the requirement ID they prove, e.g. `RV-12 a tied vote goes to the host`.
`test/e2e.py` writes `test/e2e-results.json`.

## How it's put together

- `src/engine.js` holds every game rule. It never reads the clock itself, which is why timers can be tested
  instantly.
- `src/registry.js` handles room codes, the public room list and quick play.
- `src/server.js` is Express plus Socket.IO. The server owns the game state and each player only receives
  what they're allowed to see (answers stay hidden until the round closes).
- `public/` is the browser client, plain HTML, CSS and JavaScript with no build step.

## Deploying

The game keeps a live WebSocket open to every player, so it needs a host that runs a long-lived Node process:
Render, Railway or Fly.io all work. Vercel's serverless functions don't keep sockets open, so they aren't a fit
for this server. Set `PORT` if your host requires it.

Rooms live in memory, so a restart ends any games in progress, and it runs as a single instance. Moving state to
Redis (or Supabase) is the step to take before running more than one instance.

`NG_TEST_HOOKS=1` enables test-only timer controls. Never set it in production.
