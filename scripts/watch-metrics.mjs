#!/usr/bin/env node
// Poll GET /api/ops/metrics on a schedule and print a compact line, shouting
// when something needs a look. Node 18+ (uses global fetch). No dependencies.
//
//   API_URL=https://project-river.fly.dev \
//   ADMIN_EMAIL=you@ex.com ADMIN_PASSWORD=... \
//   node scripts/watch-metrics.mjs [intervalSeconds]
//
// Alerts (printed with a "!!" prefix, and the process exits 1 on a hard down):
//   - request failed / non-200        -> API unreachable
//   - tables.stuckTables > 0          -> a runner queue may be wedged
//   - uptimeSeconds went backwards    -> the process restarted / crash-looped

const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
const EVERY = Math.max(5, Number(process.argv[2] ?? 20)) * 1000;

if (!EMAIL || !PASSWORD) {
  console.error('set ADMIN_EMAIL and ADMIN_PASSWORD');
  process.exit(1);
}

let token = null;
let lastUptime = null;

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ emailOrUsername: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${res.status}`);
  token = (await res.json()).tokens.accessToken;
}

async function tick() {
  const ts = new Date().toISOString().slice(11, 19);
  try {
    if (!token) await login();
    let res = await fetch(`${API}/api/ops/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      await login();
      res = await fetch(`${API}/api/ops/metrics`, {
        headers: { authorization: `Bearer ${token}` },
      });
    }
    if (!res.ok) {
      console.log(`${ts}  !! metrics ${res.status}`);
      return;
    }
    const m = await res.json();
    const t = m.tables;
    const line =
      `${ts}  up ${m.uptimeSeconds}s  rss ${m.memoryRssMb}MB  sockets ${m.sockets}  ` +
      `tables ${t.activeTables}  seated ${t.seatedPlayers}  inHand ${t.handsInProgress}  ` +
      `hands/min ${m.handsLastMinute}`;
    const flags = [];
    if (t.stuckTables > 0) flags.push(`STUCK TABLES: ${t.stuckTables}`);
    if (lastUptime !== null && m.uptimeSeconds < lastUptime) flags.push('PROCESS RESTARTED');
    lastUptime = m.uptimeSeconds;
    console.log(flags.length ? `${line}\n${ts}  !! ${flags.join(' · ')}` : line);
  } catch (err) {
    console.log(`${ts}  !! ${err.message} (API unreachable?)`);
  }
}

console.log(`watching ${API}/api/ops/metrics every ${EVERY / 1000}s`);
await tick();
setInterval(tick, EVERY);
