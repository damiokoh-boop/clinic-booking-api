// End-to-end checks for every level of the spec.
// Usage: BASE_URL=http://localhost:3000 API_KEY=... node test/run.mjs
const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env.API_KEY;
let passed = 0, failed = 0;

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

async function call(method, path, { body, key = KEY, headers = {} } = {}) {
  const h = { ...headers };
  if (key !== null) h['X-API-Key'] = key;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const iso = (minutesFromNow) => new Date(Date.now() + minutesFromNow * 60000).toISOString().replace('.000', '');
function slots(n, provider = 'Dr Ade', startMin = 60 * 24) {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, provider, start: iso(startMin + i * 30), end: iso(startMin + i * 30 + 30) }));
}
const reset = (list) => call('POST', '/reset', { body: { slots: list } });

console.log('Level 1');
{
  const list = [...slots(3, 'Dr Ade'), { id: 'b1', provider: 'Dr Bello', start: iso(60), end: iso(90) }, { id: 'past', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' }];
  const r = await reset(list);
  check('POST /reset returns 200', r.status === 200, JSON.stringify(r.body));
  const all = await call('GET', '/slots');
  check('GET /slots lists every slot including past ones', all.body.slots?.length === 5);
  const starts = all.body.slots.map((s) => Date.parse(s.start));
  check('slots are earliest first', starts.every((t, i) => i === 0 || t >= starts[i - 1]));
  check('slot start is returned exactly as sent', all.body.slots[0].start === '2020-01-01T09:00:00Z');
  check('slots have available: true', all.body.slots.every((s) => s.available === true));
  const bello = await call('GET', '/slots?provider=Dr%20Bello');
  check('provider filter is an exact match', bello.body.slots.length === 1 && bello.body.slots[0].id === 'b1');
  const none = await call('GET', '/slots?provider=dr%20bello');
  check('provider filter is case-sensitive (exact)', none.body.slots.length === 0);
  const b = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' } });
  check('POST /bookings returns 201', b.status === 201, JSON.stringify(b.body));
  check('booking has status confirmed and all fields', b.body.status === 'confirmed' && b.body.id && b.body.slot_id === 's1' && b.body.name === 'Ada Obi' && b.body.email === 'ada@example.com' && !Number.isNaN(Date.parse(b.body.created_at)));
  const g = await call('GET', `/bookings/${b.body.id}`);
  check('GET /bookings/{id} returns the booking', g.status === 200 && g.body.id === b.body.id);
  const missing = await call('GET', '/bookings/does-not-exist');
  check('GET unknown booking returns 404 with error', missing.status === 404 && typeof missing.body.error === 'string');
  const after = await call('GET', '/slots');
  check('booked slot shows available: false', after.body.slots.find((s) => s.id === 's1').available === false);
}

console.log('Level 2');
{
  await reset([...slots(3), { id: 'past', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' }]);
  check('no API key returns 401', (await call('GET', '/slots', { key: null })).status === 401);
  check('wrong API key returns 401', (await call('GET', '/slots', { key: 'wrong' })).status === 401);
  check('wrong key on POST /reset returns 401', (await call('POST', '/reset', { key: 'nope', body: { slots: [] } })).status === 401);
  const e401 = await call('GET', '/slots', { key: null });
  check('401 body is {"error": ...}', typeof e401.body.error === 'string');
  const cases = [
    [{ name: 'A', email: 'a@x.com' }, 'missing slot_id'],
    [{ slot_id: 's1', email: 'a@x.com' }, 'missing name'],
    [{ slot_id: 's1', name: 'A' }, 'missing email'],
    [{ slot_id: '', name: 'A', email: 'a@x.com' }, 'empty slot_id'],
    [{ slot_id: 's1', name: '   ', email: 'a@x.com' }, 'blank name'],
    [{ slot_id: 's1', name: 'A', email: '' }, 'empty email'],
    [{ slot_id: 's1', name: 'A', email: 'not-an-email' }, 'invalid email'],
    [{ slot_id: 's1', name: 'A', email: 'a@b' }, 'email without domain dot'],
  ];
  for (const [body, label] of cases) {
    const r = await call('POST', '/bookings', { body });
    check(`${label} returns 400`, r.status === 400 && typeof r.body.error === 'string', `${r.status} ${JSON.stringify(r.body)}`);
  }
  await reset([...slots(3), { id: 'past', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' }]);
  const nf = await call('POST', '/bookings', { body: { slot_id: 'nope', name: 'A', email: 'z@x.com' } });
  check('unknown slot returns 404', nf.status === 404);
  const past = await call('POST', '/bookings', { body: { slot_id: 'past', name: 'A', email: 'y@x.com' } });
  check('slot already started returns 400', past.status === 400);
  const trimmed = await call('POST', '/bookings', { body: { slot_id: 's2', name: '  Ada Obi  ', email: '  ADA@Example.COM ' } });
  check('name and email are trimmed, email lower case', trimmed.status === 201 && trimmed.body.name === 'Ada Obi' && trimmed.body.email === 'ada@example.com', JSON.stringify(trimmed.body));
  const bad = await fetch(BASE + '/bookings', { method: 'POST', headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' }, body: '{oops' });
  check('malformed JSON returns 400', bad.status === 400);
}

console.log('Level 3');
{
  await reset(slots(2));
  const N = 25;
  const results = await Promise.all(Array.from({ length: N }, (_, i) =>
    call('POST', '/bookings', { body: { slot_id: 's1', name: `P${i}`, email: `p${i}@race.com` } })));
  const ok = results.filter((r) => r.status === 201).length;
  const conflicts = results.filter((r) => r.status === 409).length;
  check(`${N} simultaneous bookings: exactly one succeeds`, ok === 1, `ok=${ok}`);
  check('all the others get 409', conflicts === N - 1, `409s=${conflicts} statuses=${results.map((r) => r.status).join(',')}`);
  const winner = results.find((r) => r.status === 201).body;
  const again = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Late', email: 'late@x.com' } });
  check('booking a taken slot returns 409', again.status === 409 && typeof again.body.error === 'string');
  const del = await call('DELETE', `/bookings/${winner.id}`);
  check('DELETE returns 200 with status cancelled', del.status === 200 && del.body.status === 'cancelled' && del.body.id === winner.id);
  const freed = await call('GET', '/slots');
  check('cancelling frees the slot', freed.body.slots.find((s) => s.id === 's1').available === true);
  const del2 = await call('DELETE', `/bookings/${winner.id}`);
  check('cancelling twice returns 409', del2.status === 409);
  check('cancelling unknown booking returns 404', (await call('DELETE', '/bookings/nope')).status === 404);
  const rebook = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'New', email: 'new@x.com' } });
  check('a freed slot can be booked again', rebook.status === 201);
  const old = await call('GET', `/bookings/${winner.id}`);
  check('cancelled booking is still readable', old.status === 200 && old.body.status === 'cancelled');
}

console.log('Level 4');
{
  await reset(slots(8));
  const body = { slot_id: 's1', name: 'Ada', email: 'ada@x.com' };
  const first = await call('POST', '/bookings', { body, headers: { 'Idempotency-Key': 'key-1' } });
  const second = await call('POST', '/bookings', { body, headers: { 'Idempotency-Key': 'key-1' } });
  check('same key + same body: same status', first.status === 201 && second.status === 201);
  check('same key + same body: same booking id', first.body.id === second.body.id);
  const diff = await call('POST', '/bookings', { body: { ...body, slot_id: 's2' }, headers: { 'Idempotency-Key': 'key-1' } });
  check('same key + different body returns 422', diff.status === 422 && typeof diff.body.error === 'string');
  const par = await Promise.all(Array.from({ length: 10 }, () =>
    call('POST', '/bookings', { body: { slot_id: 's3', name: 'Bo', email: 'bo@x.com' }, headers: { 'Idempotency-Key': 'key-par' } })));
  check('10 simultaneous retries: all 201', par.every((r) => r.status === 201), par.map((r) => r.status).join(','));
  check('10 simultaneous retries: one booking id', new Set(par.map((r) => r.body.id)).size === 1);
  const bo = await call('GET', '/bookings?email=bo@x.com');
  check('retries never create a second booking', bo.body.bookings.length === 1);
  const conflictKey1 = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Zed', email: 'zed@x.com' }, headers: { 'Idempotency-Key': 'key-409' } });
  const conflictKey2 = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Zed', email: 'zed@x.com' }, headers: { 'Idempotency-Key': 'key-409' } });
  check('an error response is replayed too (409 then 409)', conflictKey1.status === 409 && conflictKey2.status === 409);

  // Pagination: 5 bookings for one email (stays within the rate limit).
  await reset(slots(8));
  const ids = [];
  for (let i = 1; i <= 5; i++) {
    const r = await call('POST', '/bookings', { body: { slot_id: `s${i}`, name: 'Pat', email: 'pat@x.com' } });
    ids.push(r.body.id);
  }
  await call('POST', '/bookings', { body: { slot_id: 's6', name: 'Other', email: 'other@x.com' } });
  const p1 = await call('GET', '/bookings?email=PAT@X.com&limit=2');
  check('email match ignores case', p1.status === 200 && p1.body.bookings.length === 2);
  check('first page is oldest first', p1.body.bookings[0].id === ids[0] && p1.body.bookings[1].id === ids[1]);
  check('first page has a next_cursor', typeof p1.body.next_cursor === 'string' && p1.body.next_cursor.length > 0);
  const p2 = await call('GET', `/bookings?email=pat@x.com&limit=2&cursor=${encodeURIComponent(p1.body.next_cursor)}`);
  const p3 = await call('GET', `/bookings?email=pat@x.com&limit=2&cursor=${encodeURIComponent(p2.body.next_cursor)}`);
  const all = [...p1.body.bookings, ...p2.body.bookings, ...p3.body.bookings].map((b) => b.id);
  check('paging returns every booking once, in order', JSON.stringify(all) === JSON.stringify(ids));
  check('last page has next_cursor: null', p3.body.next_cursor === null && p3.body.bookings.length === 1);
  const exact = await call('GET', '/bookings?email=pat@x.com&limit=5');
  check('exact-size page ends with next_cursor: null', exact.body.bookings.length === 5 && exact.body.next_cursor === null);
  const dflt = await call('GET', '/bookings?email=pat@x.com');
  check('default limit works', dflt.status === 200 && dflt.body.bookings.length === 5 && dflt.body.next_cursor === null);
  const empty = await call('GET', '/bookings?email=nobody@x.com');
  check('unknown email returns an empty page', empty.status === 200 && empty.body.bookings.length === 0 && empty.body.next_cursor === null);
  for (const l of ['0', '51', 'abc', '2.5', '-1', '']) {
    const r = await call('GET', `/bookings?email=pat@x.com&limit=${l}`);
    check(`limit=${JSON.stringify(l)} returns 400`, r.status === 400, String(r.status));
  }
  check('limit=50 is allowed', (await call('GET', '/bookings?email=pat@x.com&limit=50')).status === 200);
  check('limit=1 is allowed', (await call('GET', '/bookings?email=pat@x.com&limit=1')).status === 200);
}

console.log('Level 5');
{
  await reset(slots(12));
  const statuses = [];
  for (let i = 1; i <= 4; i++) {
    const r = await call('POST', '/bookings', { body: { slot_id: `s${i}`, name: 'Spam', email: 'spam@x.com' } });
    statuses.push(r.status);
  }
  const failedAttempt = await call('POST', '/bookings', { body: { slot_id: 'missing', name: 'Spam', email: 'SPAM@x.com' } });
  statuses.push(failedAttempt.status);
  check('first 5 attempts go through (one fails with 404)', JSON.stringify(statuses) === '[201,201,201,201,404]', JSON.stringify(statuses));
  const sixth = await call('POST', '/bookings', { body: { slot_id: 's6', name: 'Spam', email: 'spam@x.com' } });
  check('6th attempt returns 429', sixth.status === 429 && typeof sixth.body.error === 'string');
  const ra = sixth.headers.get('retry-after');
  check('429 has a whole-number Retry-After between 1 and 60', /^\d+$/.test(ra || '') && Number(ra) >= 1 && Number(ra) <= 60, String(ra));
  const other = await call('POST', '/bookings', { body: { slot_id: 's7', name: 'Fine', email: 'fine@x.com' } });
  check('other emails are not affected', other.status === 201);
  await reset(slots(12));
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    call('POST', '/bookings', { body: { slot_id: `s${i + 1}`, name: 'B', email: 'burst@x.com' } })));
  const allowed = burst.filter((r) => r.status !== 429).length;
  check('12 simultaneous attempts: exactly 5 let through', allowed === 5, burst.map((r) => r.status).join(','));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
