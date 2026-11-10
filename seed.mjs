// Fills the API with a week of demo slots (weekdays, 9:00 to 13:00 Lagos time, two doctors).
// Usage: BASE_URL=https://your-app.vercel.app API_KEY=... node scripts/seed.mjs
const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const providers = ['Dr Ade', 'Dr Bello'];
const slots = [];
const day = new Date();
day.setUTCHours(0, 0, 0, 0);

for (let d = 1; slots.length < 64 && d <= 14; d++) {
  const date = new Date(day.getTime() + d * 86400000);
  if ([0, 6].includes(date.getUTCDay())) continue; // weekdays only
  for (const provider of providers) {
    for (let h = 8; h < 12; h++) { // 08:00 to 12:00 UTC = 9:00 to 13:00 Lagos
      for (const m of [0, 30]) {
        const start = new Date(date.getTime() + (h * 60 + m) * 60000);
        const end = new Date(start.getTime() + 30 * 60000);
        const iso = (t) => t.toISOString().replace('.000Z', 'Z');
        slots.push({ id: `${provider.split(' ')[1].toLowerCase()}-${iso(start).slice(0, 16).replace(/[-:T]/g, '')}`, provider, start: iso(start), end: iso(end) });
      }
    }
  }
}

const res = await fetch(`${BASE}/reset`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.API_KEY },
  body: JSON.stringify({ slots }),
});
console.log(res.status, await res.text());
