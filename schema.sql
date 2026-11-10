-- Clinic booking API schema (Postgres). Safe to run many times.

CREATE TABLE IF NOT EXISTS slots (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  start_at    TIMESTAMPTZ NOT NULL,   -- used for sorting and "already started" checks
  end_at      TIMESTAMPTZ NOT NULL,
  start_text  TEXT NOT NULL,          -- the exact string the client sent, returned unchanged
  end_text    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  seq         BIGSERIAL PRIMARY KEY,  -- internal order, used for cursor pagination
  id          TEXT NOT NULL UNIQUE,   -- public booking id
  slot_id     TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,          -- stored trimmed and lower case
  status      TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Level 3: the database itself refuses a second confirmed booking for a slot,
-- so two requests arriving at the same moment can never both succeed.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_by_email ON bookings (email, seq);

-- Level 4: remembers the response for each Idempotency-Key.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  request_hash  TEXT NOT NULL,
  status_code   INT NOT NULL,
  response      JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Level 5: one row per booking attempt, for the per-email rate limit.
CREATE TABLE IF NOT EXISTS booking_attempts (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS booking_attempts_by_email ON booking_attempts (email, attempted_at);
