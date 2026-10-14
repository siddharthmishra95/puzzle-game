// Twenty-Piece Rush race server.
// Serves the game and runs live race rooms. Room state is kept in a JSON file.
// No dependencies: run it with `node server.js` (Node 18 or newer).

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const TOTAL_PIECES = 20;
const RACE_MS = (Number(process.env.RACE_SECONDS) || 300) * 1000;
const COUNTDOWN_MS = 3000;
const MAX_PLAYERS = 50;
const PICTURE_IDS = ['alpine-dusk', 'harbor-morning', 'city-lights'];
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, they read like 1 and 0
const LOBBY_OFFLINE_MS = 2 * 60 * 1000; // drop players who left the lobby this long ago
const ROOM_IDLE_MS = 30 * 60 * 1000; // delete rooms nobody has touched for this long

// ------------------------------------------------------------------ storage

function loadDb() {
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (data && typeof data.rooms === 'object') return data;
  } catch {
    // Missing or unreadable file: start empty.
  }
  return { rooms: {} };
}

const db = loadDb();
let saveTimer = null;

// Writes are batched and atomic (write a temp file, then rename over the old one).
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 250);
}

// ------------------------------------------------------------------- rooms

const streams = new Map(); // room code -> Set of { res, playerId }

const randomId = (bytes) => crypto.randomBytes(bytes).toString('hex');

function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    if (!db.rooms[code]) return code;
  }
}

function cleanName(value, fallback) {
  const name = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  return name || fallback;
}

function shuffledOrder() {
  const order = Array.from({ length: TOTAL_PIECES }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function addPlayer(room, name) {
  const count = Object.keys(room.players).length;
  const player = {
    id: randomId(4),
    secret: randomId(16),
    name: cleanName(name, `Player ${count + 1}`),
    joinedAt: Date.now(),
    lastSeen: Date.now(),
    placed: 0,
    misses: 0,
    finishedAt: null,
  };
  room.players[player.id] = player;
  return player;
}

function isOnline(code, playerId) {
  const set = streams.get(code);
  if (!set) return false;
  for (const client of set) if (client.playerId === playerId) return true;
  return false;
}

// Finished players by time, then everyone else by pieces placed, then fewest misses.
function standings(room) {
  if (!room.race) return [];
  const { startAt } = room.race;
  return room.race.participants
    .map((id) => room.players[id] || room.race.departed?.[id])
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      name: p.name,
      placed: p.placed,
      misses: p.misses,
      timeMs: p.finishedAt ? p.finishedAt - startAt : null,
      left: !room.players[p.id],
    }))
    .sort((a, b) => {
      if (a.timeMs !== null || b.timeMs !== null) {
        if (a.timeMs === null) return 1;
        if (b.timeMs === null) return -1;
        if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
      }
      return b.placed - a.placed || a.misses - b.misses || a.name.localeCompare(b.name);
    });
}

function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    pictureId: room.pictureId,
    now: Date.now(),
    players: Object.values(room.players)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({ id: p.id, name: p.name, online: isOnline(room.code, p.id) })),
    race: room.race && {
      id: room.race.id,
      pictureId: room.race.pictureId,
      order: room.race.order,
      startAt: room.race.startAt,
      endsAt: room.race.endsAt,
      participants: room.race.participants,
      standings: standings(room),
    },
  };
}

function broadcast(room) {
  const set = streams.get(room.code);
  if (!set) return;
  const payload = `event: state\ndata: ${JSON.stringify(publicRoom(room))}\n\n`;
  for (const client of set) client.res.write(payload);
}

function touch(room) {
  room.updatedAt = Date.now();
  save();
  broadcast(room);
}

function finishRace(room) {
  room.status = 'finished';
  room.race.finishedAt = Date.now();
}

function removePlayer(room, playerId) {
  const player = room.players[playerId];
  if (!player) return;
  // Keep a departed racer on the scoreboard until the race is over.
  if (room.race && room.race.participants.includes(playerId)) {
    room.race.departed = room.race.departed || {};
    room.race.departed[playerId] = { ...player, secret: undefined };
  }
  delete room.players[playerId];
  if (room.hostId === playerId) {
    const next = Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    room.hostId = next ? next.id : null;
  }
  if (!Object.keys(room.players).length) {
    delete db.rooms[room.code];
    save();
    return;
  }
  if (room.status === 'racing' && raceIsDone(room)) finishRace(room);
}

function raceIsDone(room) {
  return room.race.participants.every((id) => {
    const p = room.players[id];
    return !p || p.finishedAt !== null;
  });
}

// ---------------------------------------------------------------- handlers

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function getRoom(code) {
  const room = db.rooms[String(code || '').toUpperCase()];
  if (!room) throw new HttpError(404, 'No race with that code. Check the code and try again.');
  return room;
}

function getPlayer(room, body) {
  const player = room.players[body.playerId];
  if (!player || player.secret !== body.secret) {
    throw new HttpError(403, 'You are not in this race. Join it again with the code.');
  }
  player.lastSeen = Date.now();
  return player;
}

const actions = {
  create(body) {
    const room = {
      code: newCode(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'lobby',
      hostId: null,
      pictureId: PICTURE_IDS.includes(body.pictureId) ? body.pictureId : PICTURE_IDS[0],
      race: null,
      players: {},
    };
    const player = addPlayer(room, body.name);
    room.hostId = player.id;
    db.rooms[room.code] = room;
    touch(room);
    return { code: room.code, playerId: player.id, secret: player.secret };
  },

  join(body, room) {
    if (Object.keys(room.players).length >= MAX_PLAYERS) {
      throw new HttpError(409, `This race is full (${MAX_PLAYERS} players).`);
    }
    const player = addPlayer(room, body.name);
    touch(room);
    return { code: room.code, playerId: player.id, secret: player.secret };
  },

  picture(body, room) {
    const player = getPlayer(room, body);
    if (player.id !== room.hostId) throw new HttpError(403, 'Only the host picks the picture.');
    if (room.status === 'racing') throw new HttpError(409, 'Wait for this race to finish.');
    if (!PICTURE_IDS.includes(body.pictureId)) throw new HttpError(400, 'Races use the built-in pictures.');
    room.pictureId = body.pictureId;
    touch(room);
    return {};
  },

  start(body, room) {
    const player = getPlayer(room, body);
    if (player.id !== room.hostId) throw new HttpError(403, 'Only the host can start the race.');
    if (room.status === 'racing') throw new HttpError(409, 'A race is already running.');
    const participants = Object.values(room.players)
      .filter((p) => p.id === player.id || isOnline(room.code, p.id))
      .map((p) => p.id);
    for (const id of participants) {
      Object.assign(room.players[id], { placed: 0, misses: 0, finishedAt: null });
    }
    const startAt = Date.now() + COUNTDOWN_MS;
    room.race = {
      id: randomId(4),
      pictureId: room.pictureId,
      order: shuffledOrder(),
      startAt,
      endsAt: startAt + RACE_MS,
      participants,
    };
    room.status = 'racing';
    touch(room);
    return {};
  },

  progress(body, room) {
    const player = getPlayer(room, body);
    const race = room.race;
    if (room.status !== 'racing' || !race.participants.includes(player.id) || body.raceId !== race.id) return {};
    const now = Date.now();
    // Allow a little network delay past the deadline, but no later finishes.
    if (now < race.startAt || now > race.endsAt + 1000 || player.finishedAt !== null) return {};
    // Counts only go up and stay in range, so a stale or repeated report changes nothing.
    const placed = Math.min(TOTAL_PIECES, Math.max(0, Math.floor(Number(body.placed) || 0)));
    const misses = Math.min(9999, Math.max(0, Math.floor(Number(body.misses) || 0)));
    player.placed = Math.max(player.placed, placed);
    player.misses = Math.max(player.misses, misses);
    if (player.placed === TOTAL_PIECES) player.finishedAt = Math.min(now, race.endsAt);
    if (raceIsDone(room)) finishRace(room);
    touch(room);
    return {};
  },

  leave(body, room) {
    const player = getPlayer(room, body);
    removePlayer(room, player.id);
    if (db.rooms[room.code]) touch(room);
    return {};
  },
};

function openStream(req, res, room, url) {
  const player = room.players[url.searchParams.get('player')];
  if (!player || player.secret !== url.searchParams.get('secret')) {
    throw new HttpError(403, 'You are not in this race. Join it again with the code.');
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const client = { res, playerId: player.id };
  if (!streams.has(room.code)) streams.set(room.code, new Set());
  streams.get(room.code).add(client);
  player.lastSeen = Date.now();
  broadcast(room);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(heartbeat);
    const set = streams.get(room.code);
    if (set) {
      set.delete(client);
      if (!set.size) streams.delete(room.code);
    }
    const current = db.rooms[room.code];
    if (current?.players[player.id]) {
      current.players[player.id].lastSeen = Date.now();
      broadcast(current);
    }
  });
}

// Ends races whose time is up and clears out players and rooms that are long gone.
setInterval(() => {
  const now = Date.now();
  for (const room of Object.values(db.rooms)) {
    let changed = false;
    if (room.status === 'racing' && now >= room.race.endsAt) {
      finishRace(room);
      changed = true;
    }
    if (room.status !== 'racing') {
      for (const p of Object.values(room.players)) {
        if (!isOnline(room.code, p.id) && now - p.lastSeen > LOBBY_OFFLINE_MS) {
          removePlayer(room, p.id);
          changed = true;
        }
      }
    }
    if (!db.rooms[room.code]) continue;
    if (!streams.has(room.code) && now - room.updatedAt > ROOM_IDLE_MS) {
      delete db.rooms[room.code];
      save();
      continue;
    }
    if (changed) touch(room);
  }
}, 1000);

// ----------------------------------------------------------- static files

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};
const PRIVATE = new Set(['server.js', 'package.json', 'data']);

function serveStatic(url, res) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    throw new HttpError(400, 'Bad request');
  }
  if (!rel) rel = 'index.html';
  const file = path.resolve(ROOT, rel);
  const top = rel.split('/')[0];
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!file.startsWith(ROOT + path.sep) || PRIVATE.has(top) || top.startsWith('.') || !type) {
    throw new HttpError(404, 'Not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ------------------------------------------------------------------ router

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 10_000) {
        reject(new HttpError(413, 'Request too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Request body must be JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      serveStatic(url, res);
      return;
    }
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'rooms', CODE, action]
    if (req.method === 'GET' && parts[1] === 'health') return sendJson(res, 200, { ok: true });
    if (parts[1] !== 'rooms') throw new HttpError(404, 'Not found');

    if (req.method === 'GET' && parts.length === 4 && parts[3] === 'events') {
      openStream(req, res, getRoom(parts[2]), url);
      return;
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const body = await readBody(req);
    if (parts.length === 2) return sendJson(res, 200, actions.create(body));
    const action = actions[parts[3]];
    if (parts.length !== 4 || !action || parts[3] === 'create') throw new HttpError(404, 'Not found');
    return sendJson(res, 200, action(body, getRoom(parts[2])));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server.' : err.message });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Twenty-Piece Rush is running at http://localhost:${PORT}`);
  console.log(`Race rooms are saved in ${path.relative(process.cwd(), DB_FILE) || DB_FILE}`);
});
