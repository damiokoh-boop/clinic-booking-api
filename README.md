# Clinic Booking API

An API that lets patients book clinic appointment slots, plus a simple web page that uses it: see available slots, book one, and see the confirmation. Built for Task 1 of the Koya Cohort 4 assessment, following the published OpenAPI spec.

**Stack:** Node.js 20, Express, Postgres (Neon), deployed on Vercel.

## Endpoints

Every request needs the `X-API-Key` header. Every error is `{"error": "<message>"}`.

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/reset` | Deletes every booking and replaces all slots |
| GET | `/slots?provider=` | Every slot, earliest first, with `available` |
| POST | `/bookings` | Books a slot (supports `Idempotency-Key`) |
| GET | `/bookings?email=&limit=&cursor=` | One person's bookings, oldest first, cursor paginated |
| GET | `/bookings/{id}` | One booking |
| DELETE | `/bookings/{id}` | Cancels a booking and frees the slot |

The web page is served at `/`.

## How each level is handled

**Level 1 – list, book, look up.** Two tables, `slots` and `bookings`. A slot's `available` flag is worked out live: it is false while a confirmed booking exists. Slot times are returned exactly as they were sent.

**Level 2 – API key and validation.** A middleware compares `X-API-Key` with the `API_KEY` environment variable using a constant-time comparison and returns 401 otherwise. Name and email are trimmed and the email is stored in lower case. Missing or empty fields or an invalid email return 400, an unknown slot 404, and a slot that has already started 400.

**Level 3 – no double booking, cancellation.** A partial unique index allows only one *confirmed* booking per slot:

```sql
CREATE UNIQUE INDEX one_confirmed_booking_per_slot ON bookings (slot_id) WHERE status = 'confirmed';
```

The database is the single source of truth, so even many requests at the exact same moment cannot all succeed. The loser's insert fails with a unique violation, which becomes a 409. Cancelling sets `status = 'cancelled'`, which takes the row out of the index and frees the slot. Cancelling twice returns 409.

**Level 4 – idempotent retries and pagination.** With an `Idempotency-Key`, the request takes a Postgres advisory lock on that key, so simultaneous retries queue behind the first one. The first response (status code and body) is stored with a hash of the request body. A later request with the same key and the same body gets the stored response back, and never a second booking. The same key with a different body gets 422. `GET /bookings` uses keyset pagination on an internal sequence number. The cursor is opaque (base64url), pages are stable even while new bookings arrive, and the last page returns `next_cursor: null`. `limit` must be a whole number from 1 to 50.

**Level 5 – rate limiting.** Every booking attempt for an email, including failed ones, is recorded. Under a per-email advisory lock, the API counts attempts in the last 60 seconds. The 6th returns 429 with `Retry-After` set to the whole seconds until the oldest attempt leaves the window. Other emails are not affected. Rate-limited responses are not stored as idempotent responses, so a client can retry later with the same key.

Each booking runs in a single database transaction (with a savepoint around the insert). This keeps the rate-limit record, the booking and the stored idempotent response consistent.

## Run locally

```bash
npm install
export DATABASE_URL=postgres://...  API_KEY=choose-a-key
npm start                      # http://localhost:3000
BASE_URL=http://localhost:3000 API_KEY=$API_KEY npm test   # 65 end-to-end checks
BASE_URL=http://localhost:3000 API_KEY=$API_KEY node scripts/seed.mjs   # demo slots
```

Tables are created automatically on first request (`src/schema.sql`).

## Deploy (Vercel + Neon)

1. Create a Neon project and copy the **pooled** connection string.
2. Import this repo in Vercel and add the environment variables `DATABASE_URL` and `API_KEY`.
3. Deploy. All paths are routed to the Express app (`vercel.json`), which also serves the web page.

## Project layout

```
api/index.js      Vercel entry point
src/app.js        Routes and booking logic
src/db.js         Postgres pool and transaction helper
src/schema.sql    Tables and indexes
src/page.html     The web page
test/run.mjs      End-to-end tests for every level
scripts/seed.mjs  Demo slots
```

## Built with AI

I built this with Claude as a pair programmer. I set the requirements from the spec, chose the stack and reviewed the design decisions, and tested everything against the spec with the end-to-end suite in `test/run.mjs`.
