/* Sidewinder: API for the family leaderboard + static site.
   Everything outside /api/ is served from ./public by the assets binding.

   A family is identified only by an 8-character random code and holds up to 12 players.
   A player is { id, n: name, c: colour index, b: { <board>: { s: score, sp: speed, lv: level, len: length, at: time } } }.
   The server keeps each player's best run per board, so any device that plays as that player sees the same bests.
   Storage: D1 (binding DB). Tables are created on first use, so a fresh database needs no migration step. */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const PID_RE = /^[A-Za-z0-9]{6,32}$/;
const BOARDS = new Set(["dunes", "open", "corral", "canyon", "cross", "rails", "pueblo"]);
const MAX_PLAYERS = 12;
const NAME_MAX = 16;
const COLOURS = 8;
const MAX_SCORE = 10_000_000;
const MAX_BODY = 2000;
const HOUR = 3600e3;

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch([
      db.prepare("CREATE TABLE IF NOT EXISTS families (code TEXT PRIMARY KEY, created INTEGER NOT NULL, seen INTEGER NOT NULL)"),
      db.prepare("CREATE TABLE IF NOT EXISTS players (code TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, colour INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (code, id))"),
      db.prepare("CREATE TABLE IF NOT EXISTS bests (code TEXT NOT NULL, pid TEXT NOT NULL, board TEXT NOT NULL, score INTEGER NOT NULL, speed INTEGER NOT NULL, level INTEGER NOT NULL, len INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (code, pid, board))"),
      db.prepare("CREATE TABLE IF NOT EXISTS limits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, t INTEGER NOT NULL)"),
    ]).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const fail = (status, error) => json({ error }, status);

/* Fixed-window counter in D1. Returns true while the key is under its limit. */
async function allow(db, key, max, windowMs) {
  const now = Date.now();
  const row = await db
    .prepare(
      "INSERT INTO limits (k, n, t) VALUES (?1, 1, ?2) ON CONFLICT(k) DO UPDATE SET " +
        "n = CASE WHEN limits.t < ?3 THEN 1 ELSE limits.n + 1 END, " +
        "t = CASE WHEN limits.t < ?3 THEN ?2 ELSE limits.t END RETURNING n"
    )
    .bind(key, now, now - windowMs)
    .first();
  if (Math.random() < 0.01) await db.prepare("DELETE FROM limits WHERE t < ?1").bind(now - 2 * 24 * HOUR).run();
  return !row || row.n <= max;
}

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

function cleanName(v) {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return s && [...s].length <= NAME_MAX ? s : null;
}

async function familyExists(db, code) {
  const row = await db.prepare("SELECT seen FROM families WHERE code = ?1").bind(code).first();
  if (!row) return false;
  if (Date.now() - row.seen > 6 * HOUR) await db.prepare("UPDATE families SET seen = ?2 WHERE code = ?1").bind(code, Date.now()).run();
  return true;
}

async function listPlayers(db, code) {
  const [players, bests] = await db.batch([
    db.prepare("SELECT id, name, colour FROM players WHERE code = ?1 ORDER BY created, id").bind(code),
    db.prepare("SELECT pid, board, score, speed, level, len, at FROM bests WHERE code = ?1").bind(code),
  ]);
  const byId = new Map();
  const out = players.results.map((p) => {
    const o = { id: p.id, n: p.name, c: p.colour, b: {} };
    byId.set(p.id, o);
    return o;
  });
  for (const r of bests.results) {
    const p = byId.get(r.pid);
    if (p) p.b[r.board] = { s: r.score, sp: r.speed, lv: r.level, len: r.len, at: r.at };
  }
  return out;
}

async function api(request, env, url) {
  const db = env.DB;
  if (!db) return fail(503, "storage not configured");
  await ensureSchema(db);
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

  // POST /api/families -> { code }
  if (parts.length === 2 && parts[1] === "families") {
    if (request.method !== "POST") return fail(405, "method");
    if (!(await allow(db, "new:" + ip, 10, HOUR))) return fail(429, "too many new families");
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      const r = await db.prepare("INSERT OR IGNORE INTO families (code, created, seen) VALUES (?1, ?2, ?2)").bind(code, Date.now()).run();
      if (r.meta && r.meta.changes === 1) return json({ code }, 201);
    }
    return fail(500, "could not create a code");
  }

  // /api/f/:code/players[/:id[/scores]]
  if (parts[1] !== "f" || parts[3] !== "players" || parts.length > 6) return fail(404, "not found");
  const code = String(parts[2] || "").toUpperCase();
  if (!CODE_RE.test(code)) return fail(404, "no such family");
  if (!(await familyExists(db, code))) return fail(404, "no such family");

  // GET /api/f/:code/players -> { players }
  if (parts.length === 4) {
    if (request.method !== "GET") return fail(405, "method");
    return json({ players: await listPlayers(db, code) });
  }

  const id = parts[4];
  if (!PID_RE.test(id)) return fail(400, "bad player id");
  if (!(await allow(db, "wr:" + code, 240, 15 * 60e3))) return fail(429, "slow down");

  // POST /api/f/:code/players/:id/scores { board, score, speed, level, len } -> { best, improved }
  if (parts.length === 6) {
    if (parts[5] !== "scores") return fail(404, "not found");
    if (request.method !== "POST") return fail(405, "method");
    const body = await readJson(request);
    if (!body) return fail(400, "bad score");
    const board = BOARDS.has(body.board) ? body.board : null;
    const score = int(body.score, 1, MAX_SCORE);
    const speed = int(body.speed, 1, 9);
    const level = int(body.level, 1, 999);
    const len = int(body.len, 1, 10000);
    if (!board || score === null || speed === null || level === null || len === null) return fail(400, "bad score");
    const player = await db.prepare("SELECT 1 FROM players WHERE code = ?1 AND id = ?2").bind(code, id).first();
    if (!player) return fail(404, "no such player");
    const now = Date.now();
    const r = await db
      .prepare(
        "INSERT INTO bests (code, pid, board, score, speed, level, len, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) " +
          "ON CONFLICT(code, pid, board) DO UPDATE SET score = excluded.score, speed = excluded.speed, level = excluded.level, " +
          "len = excluded.len, at = excluded.at WHERE excluded.score > bests.score"
      )
      .bind(code, id, board, score, speed, level, len, now)
      .run();
    const best = await db.prepare("SELECT score FROM bests WHERE code = ?1 AND pid = ?2 AND board = ?3").bind(code, id, board).first();
    return json({ best: best ? best.score : score, improved: !!(r.meta && r.meta.changes) });
  }

  // PUT /api/f/:code/players/:id { name, colour } -> create or rename
  if (request.method === "PUT") {
    const body = await readJson(request);
    const name = body && cleanName(body.name);
    const colour = body && int(body.colour, 0, COLOURS - 1);
    if (!name || colour === null) return fail(400, "bad player");
    const exists = await db.prepare("SELECT 1 FROM players WHERE code = ?1 AND id = ?2").bind(code, id).first();
    if (!exists) {
      const { n } = await db.prepare("SELECT COUNT(*) AS n FROM players WHERE code = ?1").bind(code).first();
      if (n >= MAX_PLAYERS) return fail(409, "board is full");
    }
    const now = Date.now();
    await db
      .prepare(
        "INSERT INTO players (code, id, name, colour, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?5) " +
          "ON CONFLICT(code, id) DO UPDATE SET name = ?3, colour = ?4, updated = ?5"
      )
      .bind(code, id, name, colour, now)
      .run();
    return json({ ok: true });
  }

  // DELETE /api/f/:code/players/:id -> removes the player and their scores
  if (request.method === "DELETE") {
    await db.batch([
      db.prepare("DELETE FROM bests WHERE code = ?1 AND pid = ?2").bind(code, id),
      db.prepare("DELETE FROM players WHERE code = ?1 AND id = ?2").bind(code, id),
    ]);
    return json({ ok: true });
  }

  return fail(405, "method");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(request, env, url);
      } catch (e) {
        console.error(e);
        return fail(500, "server error");
      }
    }
    return env.ASSETS.fetch(request);
  },
};
