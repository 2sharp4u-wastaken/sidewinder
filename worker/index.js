/* Sidewinder: API for the family leaderboard + static site.
   Everything outside /api/ is served from ./public by the assets binding.

   A family is identified only by an 8-character random code and holds up to 12 players.
   Each player has a 4-digit PIN. Entering it on a device gives that device a token; playing as the player,
   changing the PIN and removing the player all need the token, so a family code alone is not enough.
   A player as GET returns it:
     { id, n: name, c: colour index, pin: has a PIN,
       b: { <board>: { s: score, sp: speed, lv: level, len: length, at: time } },   best run per board
       g: { <board>: { <speed 1-9>: games played } } }                               finished games
   Storage: D1 (binding DB). Tables are created, and older tables upgraded, on first use. */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const PID_RE = /^[A-Za-z0-9]{6,32}$/;
const PIN_RE = /^[0-9]{4}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const BOARDS = new Set(["dunes", "open", "corral", "canyon", "cross", "rails", "pueblo"]);
const MAX_PLAYERS = 12;
const NAME_MAX = 16;
const COLOURS = 8;
const MAX_SCORE = 10_000_000;
const MAX_BODY = 2000;
const PIN_TRIES = 6; // wrong PINs per player per 15 minutes
const HOUR = 3600e3;

let schemaReady = null;
async function migrate(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS families (code TEXT PRIMARY KEY, created INTEGER NOT NULL, seen INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS players (code TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, colour INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, pin_salt TEXT, pin_hash TEXT, PRIMARY KEY (code, id))"),
    db.prepare("CREATE TABLE IF NOT EXISTS bests (code TEXT NOT NULL, pid TEXT NOT NULL, board TEXT NOT NULL, score INTEGER NOT NULL, speed INTEGER NOT NULL, level INTEGER NOT NULL, len INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (code, pid, board))"),
    db.prepare("CREATE TABLE IF NOT EXISTS games (code TEXT NOT NULL, pid TEXT NOT NULL, board TEXT NOT NULL, speed INTEGER NOT NULL, n INTEGER NOT NULL, last INTEGER NOT NULL, PRIMARY KEY (code, pid, board, speed))"),
    db.prepare("CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, code TEXT NOT NULL, pid TEXT NOT NULL, created INTEGER NOT NULL, used INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS tokens_player ON tokens (code, pid)"),
    db.prepare("CREATE TABLE IF NOT EXISTS limits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, t INTEGER NOT NULL)"),
  ]);
  // The first version's players table had no PIN columns.
  const { results } = await db.prepare("PRAGMA table_info(players)").all();
  const cols = new Set(results.map((r) => r.name));
  for (const col of ["pin_salt", "pin_hash"]) {
    if (!cols.has(col)) await db.prepare(`ALTER TABLE players ADD COLUMN ${col} TEXT`).run();
  }
}
function ensureSchema(db) {
  if (!schemaReady) schemaReady = migrate(db).catch((e) => { schemaReady = null; throw e; });
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

/* True while the key has reached its limit, without counting this call */
async function blocked(db, key, max, windowMs) {
  const row = await db.prepare("SELECT n, t FROM limits WHERE k = ?1").bind(key).first();
  return !!row && row.t >= Date.now() - windowMs && row.n >= max;
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomB64 = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function sha256(text) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}
const pinHash = (salt, pin) => sha256("sidewinder-pin:" + salt + ":" + pin);
function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
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
  const [players, bests, games] = await db.batch([
    db.prepare("SELECT id, name, colour, pin_hash IS NOT NULL AS pin FROM players WHERE code = ?1 ORDER BY created, id").bind(code),
    db.prepare("SELECT pid, board, score, speed, level, len, at FROM bests WHERE code = ?1").bind(code),
    db.prepare("SELECT pid, board, speed, n FROM games WHERE code = ?1").bind(code),
  ]);
  const byId = new Map();
  const out = players.results.map((p) => {
    const o = { id: p.id, n: p.name, c: p.colour, pin: !!p.pin, b: {}, g: {} };
    byId.set(p.id, o);
    return o;
  });
  for (const r of bests.results) {
    const p = byId.get(r.pid);
    if (p) p.b[r.board] = { s: r.score, sp: r.speed, lv: r.level, len: r.len, at: r.at };
  }
  for (const r of games.results) {
    const p = byId.get(r.pid);
    if (p) (p.g[r.board] = p.g[r.board] || {})[r.speed] = r.n;
  }
  return out;
}

/* A new device token for this player. Only its hash is stored. */
async function issueToken(db, code, id) {
  const token = randomB64(24);
  const now = Date.now();
  await db.prepare("INSERT INTO tokens (hash, code, pid, created, used) VALUES (?1, ?2, ?3, ?4, ?4)").bind(await sha256(token), code, id, now).run();
  return token;
}
async function tokenOk(db, request, code, id) {
  const m = /^Bearer (.+)$/.exec(request.headers.get("authorization") || "");
  if (!m || !TOKEN_RE.test(m[1])) return null;
  const hash = await sha256(m[1]);
  const row = await db.prepare("SELECT used FROM tokens WHERE hash = ?1 AND code = ?2 AND pid = ?3").bind(hash, code, id).first();
  if (!row) return null;
  if (Date.now() - row.used > 24 * HOUR) await db.prepare("UPDATE tokens SET used = ?2 WHERE hash = ?1").bind(hash, Date.now()).run();
  return hash;
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

  // /api/f/:code/players[/:id[/unlock|pin|games]]
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
  if (!(await allow(db, "wr:" + code, 300, 15 * 60e3))) return fail(429, "slow down");
  const player = await db.prepare("SELECT pin_salt, pin_hash FROM players WHERE code = ?1 AND id = ?2").bind(code, id).first();
  const action = parts[5] || "";

  // POST /api/f/:code/players/:id/unlock { pin } -> { token }
  // A player from before PINs existed has none yet: the first PIN sent becomes theirs.
  if (action === "unlock") {
    if (request.method !== "POST") return fail(405, "method");
    if (!player) return fail(404, "no such player");
    const body = await readJson(request);
    const pin = body && PIN_RE.test(body.pin || "") ? body.pin : null;
    if (!pin) return fail(400, "bad pin");
    if (!player.pin_hash) {
      const salt = randomB64(12);
      await db.prepare("UPDATE players SET pin_salt = ?3, pin_hash = ?4, updated = ?5 WHERE code = ?1 AND id = ?2 AND pin_hash IS NULL")
        .bind(code, id, salt, await pinHash(salt, pin), Date.now()).run();
      const now = await db.prepare("SELECT pin_salt, pin_hash FROM players WHERE code = ?1 AND id = ?2").bind(code, id).first();
      if (!now || !sameText(now.pin_hash, await pinHash(now.pin_salt, pin))) return fail(403, "wrong pin");
      return json({ token: await issueToken(db, code, id), set: true });
    }
    const tries = "pin:" + code + ":" + id;
    if (await blocked(db, tries, PIN_TRIES, 15 * 60e3)) return fail(429, "too many tries");
    if (!sameText(player.pin_hash, await pinHash(player.pin_salt, pin))) {
      await allow(db, tries, PIN_TRIES, 15 * 60e3);
      return fail(403, "wrong pin");
    }
    return json({ token: await issueToken(db, code, id) });
  }

  // PUT /api/f/:code/players/:id { name, colour, pin } -> { token }   creates a player
  // (an existing player can change name and colour with their token)
  if (action === "" && request.method === "PUT") {
    const body = await readJson(request);
    const name = body && cleanName(body.name);
    const colour = body && int(body.colour, 0, COLOURS - 1);
    if (!name || colour === null) return fail(400, "bad player");
    const now = Date.now();
    if (player) {
      if (!(await tokenOk(db, request, code, id))) return fail(401, "pin needed");
      await db.prepare("UPDATE players SET name = ?3, colour = ?4, updated = ?5 WHERE code = ?1 AND id = ?2").bind(code, id, name, colour, now).run();
      return json({ ok: true });
    }
    const pin = PIN_RE.test(body.pin || "") ? body.pin : null;
    if (!pin) return fail(400, "bad pin");
    const { n } = await db.prepare("SELECT COUNT(*) AS n FROM players WHERE code = ?1").bind(code).first();
    if (n >= MAX_PLAYERS) return fail(409, "board is full");
    const salt = randomB64(12);
    await db
      .prepare("INSERT INTO players (code, id, name, colour, created, updated, pin_salt, pin_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7)")
      .bind(code, id, name, colour, now, salt, await pinHash(salt, pin))
      .run();
    return json({ token: await issueToken(db, code, id) }, 201);
  }

  // Everything below acts as the player, so it needs a token from this player's PIN.
  if (!player) return fail(404, "no such player");
  const tokenHash = await tokenOk(db, request, code, id);
  if (!tokenHash) return fail(401, "pin needed");

  // POST /api/f/:code/players/:id/games { board, speed, score, level, len } -> { best, improved, n }
  // Counts the finished game and keeps the run if it beats the player's best on that board.
  if (action === "games") {
    if (request.method !== "POST") return fail(405, "method");
    const body = await readJson(request);
    if (!body) return fail(400, "bad game");
    const board = BOARDS.has(body.board) ? body.board : null;
    const score = int(body.score, 0, MAX_SCORE);
    const speed = int(body.speed, 1, 9);
    const level = int(body.level, 1, 999);
    const len = int(body.len, 1, 10000);
    if (!board || score === null || speed === null || level === null || len === null) return fail(400, "bad game");
    const now = Date.now();
    const stmts = [
      db.prepare("INSERT INTO games (code, pid, board, speed, n, last) VALUES (?1, ?2, ?3, ?4, 1, ?5) ON CONFLICT(code, pid, board, speed) DO UPDATE SET n = n + 1, last = ?5")
        .bind(code, id, board, speed, now),
    ];
    if (score > 0) {
      stmts.push(
        db.prepare(
          "INSERT INTO bests (code, pid, board, score, speed, level, len, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) " +
            "ON CONFLICT(code, pid, board) DO UPDATE SET score = excluded.score, speed = excluded.speed, level = excluded.level, " +
            "len = excluded.len, at = excluded.at WHERE excluded.score > bests.score"
        ).bind(code, id, board, score, speed, level, len, now)
      );
    }
    const res = await db.batch(stmts);
    const [best, games] = await db.batch([
      db.prepare("SELECT score FROM bests WHERE code = ?1 AND pid = ?2 AND board = ?3").bind(code, id, board),
      db.prepare("SELECT n FROM games WHERE code = ?1 AND pid = ?2 AND board = ?3 AND speed = ?4").bind(code, id, board, speed),
    ]);
    return json({
      best: best.results[0] ? best.results[0].score : 0,
      improved: !!(res[1] && res[1].meta && res[1].meta.changes),
      n: games.results[0] ? games.results[0].n : 1,
    });
  }

  // POST /api/f/:code/players/:id/pin { pin } -> { token }   new PIN; every other device has to enter it again
  if (action === "pin") {
    if (request.method !== "POST") return fail(405, "method");
    const body = await readJson(request);
    const pin = body && PIN_RE.test(body.pin || "") ? body.pin : null;
    if (!pin) return fail(400, "bad pin");
    const salt = randomB64(12);
    await db.batch([
      db.prepare("UPDATE players SET pin_salt = ?3, pin_hash = ?4, updated = ?5 WHERE code = ?1 AND id = ?2").bind(code, id, salt, await pinHash(salt, pin), Date.now()),
      db.prepare("DELETE FROM tokens WHERE code = ?1 AND pid = ?2 AND hash != ?3").bind(code, id, tokenHash),
    ]);
    return json({ ok: true });
  }

  // DELETE /api/f/:code/players/:id -> removes the player, their scores, games and devices
  if (action === "" && request.method === "DELETE") {
    await db.batch([
      db.prepare("DELETE FROM bests WHERE code = ?1 AND pid = ?2").bind(code, id),
      db.prepare("DELETE FROM games WHERE code = ?1 AND pid = ?2").bind(code, id),
      db.prepare("DELETE FROM tokens WHERE code = ?1 AND pid = ?2").bind(code, id),
      db.prepare("DELETE FROM players WHERE code = ?1 AND id = ?2").bind(code, id),
    ]);
    return json({ ok: true });
  }

  return fail(action ? 404 : 405, action ? "not found" : "method");
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
