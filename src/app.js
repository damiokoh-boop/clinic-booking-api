import express from 'express';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, ensureSchema, withTransaction } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const RATE_LIMIT = 5;            // attempts per email
const RATE_WINDOW_SECONDS = 60;  // per minute
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A small error type so any handler can stop with a status code and message.
class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const bookingJson = (row) => ({
  id: row.id,
  slot_id: row.slot_id,
  name: row.name,
  email: row.email,
  status: row.status,
  created_at: new Date(row.created_at).toISOString(),
});

const slotJson = (row) => ({
  id: row.id,
  provider: row.provider,
  start: row.start_text,
  end: row.end_text,
  available: row.available,
});

// Wraps async route handlers so thrown errors reach the error handler.
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // CORS, so the web page (or any browser client) can call the API.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Idempotency-Key');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Expose-Headers', 'Retry-After');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // The web page. It is not part of the API, so it does not need the key;
  // the server fills in the key from the environment so it never sits in the code.
  const page = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8');
  app.get(['/', '/index.html'], (req, res) => {
    res.type('html').send(page.replace('__API_KEY__', JSON.stringify(process.env.API_KEY || '')));
  });

  // Every API request needs the X-API-Key header (level 2).
  app.use((req, res, next) => {
    const sent = String(req.get('X-API-Key') || '');
    const expected = String(process.env.API_KEY || '');
    const ok = expected.length > 0 && sent.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
    if (!ok) return next(new HttpError(401, 'missing or invalid API key'));
    next();
  });

  app.use(express.json({ type: () => true, limit: '200kb' }));
  app.use(route(async (req, res, next) => { await ensureSchema(); next(); }));

  // POST /reset: delete every booking and replace all slots (level 1).
  app.post('/reset', route(async (req, res) => {
    const slots = req.body && req.body.slots;
    if (!Array.isArray(slots)) throw new HttpError(400, 'slots must be an array');
    const seen = new Set();
    const clean = slots.map((s, i) => {
      if (!s || typeof s !== 'object') throw new HttpError(400, `slot ${i} is not an object`);
      for (const f of ['id', 'provider', 'start', 'end']) {
        if (typeof s[f] !== 'string' || s[f].trim() === '') throw new HttpError(400, `slot ${i} is missing ${f}`);
      }
      if (Number.isNaN(Date.parse(s.start)) || Number.isNaN(Date.parse(s.end))) {
        throw new HttpError(400, `slot ${i} has an invalid date`);
      }
      if (seen.has(s.id)) throw new HttpError(400, `duplicate slot id ${s.id}`);
      seen.add(s.id);
      return s;
    });

    await withTransaction(async (db) => {
      await db.query('TRUNCATE bookings, slots, idempotency_keys, booking_attempts RESTART IDENTITY');
      if (clean.length) {
        await db.query(
          `INSERT INTO slots (id, provider, start_at, end_at, start_text, end_text)
           SELECT * FROM UNNEST($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[], $5::text[], $6::text[])`,
          [clean.map((s) => s.id), clean.map((s) => s.provider), clean.map((s) => s.start),
            clean.map((s) => s.end), clean.map((s) => s.start), clean.map((s) => s.end)],
        );
      }
    });
    res.status(200).json({ status: 'ok', slots: clean.length });
  }));

  // GET /slots: every slot, earliest first, optionally for one provider (level 1).
  app.get('/slots', route(async (req, res) => {
    const provider = typeof req.query.provider === 'string' ? req.query.provider : null;
    const { rows } = await pool.query(
      `SELECT s.*, NOT EXISTS (
                SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed'
              ) AS available
         FROM slots s
        WHERE ($1::text IS NULL OR s.provider = $1)
        ORDER BY s.start_at, s.id`,
      [provider],
    );
    res.json({ slots: rows.map(slotJson) });
  }));

  // POST /bookings: book a slot (levels 1 to 5).
  app.post('/bookings', route(async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const key = String(req.get('Idempotency-Key') || '').trim();

    const result = key
      ? await withIdempotency(key, body)
      : await withTransaction((db) => createBooking(db, body));
    if (result.headers) res.set(result.headers);
    res.status(result.status).json(result.body);
  }));

  // GET /bookings?email=&limit=&cursor=: one person's bookings, oldest first (level 4).
  app.get('/bookings', route(async (req, res) => {
    const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
    if (!email) throw new HttpError(400, 'email is required');

    let limit = 10;
    if (req.query.limit !== undefined) {
      const raw = String(req.query.limit);
      if (!/^\d+$/.test(raw)) throw new HttpError(400, 'limit must be a whole number from 1 to 50');
      limit = Number(raw);
      if (limit < 1 || limit > 50) throw new HttpError(400, 'limit must be a whole number from 1 to 50');
    }

    let after = 0;
    if (req.query.cursor !== undefined && req.query.cursor !== '') {
      after = decodeCursor(String(req.query.cursor));
      if (after === null) throw new HttpError(400, 'invalid cursor');
    }

    const { rows } = await pool.query(
      `SELECT * FROM bookings WHERE email = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [email, after, limit + 1],
    );
    const page = rows.slice(0, limit);
    const more = rows.length > limit;
    res.json({
      bookings: page.map(bookingJson),
      next_cursor: more ? encodeCursor(page[page.length - 1].seq) : null,
    });
  }));

  // GET /bookings/:id: look up one booking (level 1).
  app.get('/bookings/:id', route(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
    if (!rows.length) throw new HttpError(404, 'booking not found');
    res.json(bookingJson(rows[0]));
  }));

  // DELETE /bookings/:id: cancel a booking and free its slot (level 3).
  app.delete('/bookings/:id', route(async (req, res) => {
    const booking = await withTransaction(async (db) => {
      const { rows } = await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!rows.length) throw new HttpError(404, 'booking not found');
      if (rows[0].status === 'cancelled') throw new HttpError(409, 'booking is already cancelled');
      const updated = await db.query(
        `UPDATE bookings SET status = 'cancelled' WHERE id = $1 RETURNING *`, [req.params.id]);
      return updated.rows[0];
    });
    res.json(bookingJson(booking));
  }));

  // Anything else is a JSON 404.
  app.use((req, res, next) => next(new HttpError(404, 'not found')));

  // Every error response is {"error": "<message>"}.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      res.set(err.headers);
      return res.status(err.status).json({ error: err.message });
    }
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'body must be valid JSON' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'body is too large' });
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

// ---------- Booking logic ----------

// Level 4: the same Idempotency-Key with the same body replays the first response;
// with a different body it returns 422. A per-key lock makes simultaneous retries wait
// for the first one instead of booking twice.
async function withIdempotency(key, body) {
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify([body.slot_id ?? null, body.name ?? null, body.email ?? null]))
    .digest('hex');

  return withTransaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`idem:${key}`]);
    const { rows } = await db.query('SELECT * FROM idempotency_keys WHERE key = $1', [key]);
    if (rows.length) {
      if (rows[0].request_hash !== hash) {
        return { status: 422, body: { error: 'Idempotency-Key was already used with a different request body' } };
      }
      return { status: rows[0].status_code, body: rows[0].response };
    }

    const result = await createBooking(db, body);
    // A rate-limited request is not remembered, so the client can retry it later with the same key.
    if (result.status !== 429) {
      await db.query(
        'INSERT INTO idempotency_keys (key, request_hash, status_code, response) VALUES ($1, $2, $3, $4)',
        [key, hash, result.status, result.body],
      );
    }
    return result;
  });
}

// Levels 1, 2, 3 and 5, run inside one transaction (db) that is always committed,
// so a failed attempt still counts towards the rate limit. Returns { status, body, headers }
// instead of throwing, so the idempotency layer can store the exact response.
async function createBooking(db, body) {
  try {
    const slotId = typeof body.slot_id === 'string' ? body.slot_id.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

    // Level 5 runs first, so failed attempts count towards the limit too.
    if (email) await checkRateLimit(db, email);

    if (!slotId) throw new HttpError(400, 'slot_id is required');
    if (!name) throw new HttpError(400, 'name is required');
    if (!email) throw new HttpError(400, 'email is required');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'email is not valid');

    const slot = await db.query('SELECT id, start_at FROM slots WHERE id = $1', [slotId]);
    if (!slot.rows.length) throw new HttpError(404, 'slot not found');
    if (new Date(slot.rows[0].start_at).getTime() <= Date.now()) {
      throw new HttpError(400, 'slot has already started');
    }

    // A savepoint keeps the transaction usable if the insert is refused.
    await db.query('SAVEPOINT insert_booking');
    try {
      const { rows } = await db.query(
        `INSERT INTO bookings (id, slot_id, name, email, status)
         VALUES ($1, $2, $3, $4, 'confirmed') RETURNING *`,
        [crypto.randomUUID(), slotId, name, email],
      );
      await db.query('RELEASE SAVEPOINT insert_booking');
      return { status: 201, body: bookingJson(rows[0]) };
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT insert_booking');
      // 23505 = unique violation: someone else holds a confirmed booking for this slot.
      if (err.code === '23505') throw new HttpError(409, 'slot is already booked');
      // 23503 = the slot was removed (by /reset) a moment ago.
      if (err.code === '23503') throw new HttpError(404, 'slot not found');
      throw err;
    }
  } catch (err) {
    if (err instanceof HttpError) {
      return { status: err.status, body: { error: err.message }, headers: err.headers };
    }
    throw err;
  }
}

// Level 5: at most 5 attempts per email in any 60-second window. A per-email lock makes
// the count exact even when many requests arrive together.
async function checkRateLimit(db, email) {
  {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`rate:${email}`]);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n,
              min(attempted_at) AS oldest,
              clock_timestamp() AS now
         FROM booking_attempts
        WHERE email = $1 AND attempted_at > clock_timestamp() - make_interval(secs => $2)`,
      [email, RATE_WINDOW_SECONDS],
    );
    const { n, oldest, now } = rows[0];
    if (n >= RATE_LIMIT) {
      const waitMs = new Date(oldest).getTime() + RATE_WINDOW_SECONDS * 1000 - new Date(now).getTime();
      const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
      throw new HttpError(429, 'too many booking attempts for this email, try again later',
        { 'Retry-After': String(retryAfter) });
    }
    await db.query('INSERT INTO booking_attempts (email) VALUES ($1)', [email]);
    // Housekeeping: drop attempts that can no longer affect anyone.
    await db.query(
      `DELETE FROM booking_attempts WHERE email = $1 AND attempted_at < clock_timestamp() - make_interval(secs => $2)`,
      [email, RATE_WINDOW_SECONDS * 2],
    );
  }
}

// Cursors are opaque to clients: base64url of the last row's internal sequence number.
function encodeCursor(seq) {
  return Buffer.from(`b:${seq}`).toString('base64url');
}
function decodeCursor(cursor) {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^b:(\d{1,18})$/.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
