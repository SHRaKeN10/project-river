// Closed-alpha load test. node _load.mjs [tables] [playersPerTable] [seconds]
import { readFileSync } from 'node:fs';
import { io } from 'socket.io-client';

const SEEDED = JSON.parse(readFileSync(new URL('./tokens.json', import.meta.url)));

const BASE = 'http://localhost:3000';
const PW = 'a-strong-passphrase';
const NT = Number(process.argv[2] ?? 10);
const PPT = Number(process.argv[3] ?? 5);
const SECS = Number(process.argv[4] ?? 60);
const sfx = 'load' + Date.now().toString(36);

async function http(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const connect = (token) =>
  new Promise((res, rej) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
    s.once('connect', () => res(s));
    s.once('connect_error', rej);
  });
const rnd = (n) => Math.floor(Math.random() * n);

// --- metrics ---
let msgsIn = 0,
  msgsOut = 0,
  handsDone = 0,
  actionsSent = 0,
  errors = 0;
const latencies = []; // action emit -> ack

async function main() {
  console.log(`load: ${NT} tables x ${PPT} players, ${SECS}s`);
  // admin user + tables (loadadm must be pre-promoted to ADMIN in the DB)
  const admin = (
    await http('/api/auth/login', {
      method: 'POST',
      body: { emailOrUsername: 'loadadm', password: PW },
    })
  ).json;
  let tables = [];
  const mk = await http('/api/tables', {
    method: 'POST',
    token: admin.tokens.accessToken,
    body: {
      name: `${sfx} t0`,
      smallBlind: 5,
      bigBlind: 10,
      maxSeats: PPT + 1,
      minBuyIn: 200,
      maxBuyIn: 2000,
    },
  });
  if (mk.status === 201) {
    tables.push(mk.json.id);
    for (let i = 1; i < NT; i++) {
      const r = await http('/api/tables', {
        method: 'POST',
        token: admin.tokens.accessToken,
        body: {
          name: `${sfx} t${i}`,
          smallBlind: 5,
          bigBlind: 10,
          maxSeats: PPT + 1,
          minBuyIn: 200,
          maxBuyIn: 2000,
        },
      });
      if (r.status === 201) tables.push(r.json.id);
    }
  }
  if (tables.length === 0) {
    console.log('  (not admin - falling back to seeded tables)');
    const lob = (await http('/api/lobby', { token: admin.tokens.accessToken })).json;
    tables = lob.slice(0, NT).map((t) => t.id);
  }
  console.log(`  using ${tables.length} tables`);

  // players: pre-seeded tokens (skips register/login throttles)
  const total = tables.length * PPT;
  if (SEEDED.length < total)
    throw new Error(`need ${total} seeded users, have ${SEEDED.length}. run _seedusers.mjs`);
  const players = SEEDED.slice(0, total);
  console.log(`  using ${players.length} pre-seeded players`);

  // connect + seat everyone, attach a driver
  const sockets = [];
  let p = 0;
  for (const tableId of tables) {
    for (let seat = 0; seat < PPT; seat++) {
      const pl = players[p++];
      const s = await connect(pl.token);
      sockets.push(s);
      let seq = 0;
      s.on('table:state', (st) => {
        msgsIn++;
        if (!st.handId || st.actingSeat !== st.youAreSeat || !st.legalActions?.length) return;
        const kinds = st.legalActions.map((o) => o.kind);
        let act;
        const roll = Math.random();
        if (kinds.includes('CHECK'))
          act =
            roll < 0.9
              ? { type: 'CHECK' }
              : { type: kinds.includes('BET') ? 'BET' : 'CHECK', amount: st.bigBlind * 2 };
        else if (kinds.includes('CALL'))
          act =
            roll < 0.75
              ? { type: 'CALL' }
              : roll < 0.92
                ? { type: 'FOLD' }
                : {
                    type: kinds.includes('RAISE') ? 'RAISE' : 'CALL',
                    amount: (st.currentBet || st.bigBlind) * 2 + st.bigBlind,
                  };
        else act = { type: 'FOLD' };
        const t0 = performance.now();
        actionsSent++;
        msgsOut++;
        s.emit(
          'player:action',
          { tableId, handId: st.handId, clientSeq: ++seq, action: act },
          (r) => {
            latencies.push(performance.now() - t0);
            if (r && r.error) errors++;
          },
        );
      });
      s.on('hand:end', () => {
        handsDone++;
      });
      s.on('error', () => {
        errors++;
      });
      const j = await s.emit('table:join', { tableId, seatNumber: seat, buyIn: 1000 }, () => {});
      msgsOut++;
    }
  }
  console.log(`  seated ${sockets.length} sockets; running for ${SECS}s...`);

  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, SECS * 1000));
  const elapsed = (performance.now() - t0) / 1000;

  // teardown
  for (const s of sockets) {
    try {
      s.close();
    } catch {}
  }

  latencies.sort((a, b) => a - b);
  const pct = (q) =>
    latencies.length
      ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))].toFixed(1)
      : 'n/a';
  console.log('\n=== RESULTS ===');
  console.log(`elapsed:            ${elapsed.toFixed(1)}s`);
  console.log(`concurrent tables:  ${tables.length}`);
  console.log(`concurrent players: ${sockets.length}`);
  console.log(`hands completed:    ${handsDone}  (${(handsDone / elapsed).toFixed(1)}/s)`);
  console.log(`actions sent:       ${actionsSent}  (${(actionsSent / elapsed).toFixed(1)}/s)`);
  console.log(`msgs in (state):    ${msgsIn}  (${(msgsIn / elapsed).toFixed(0)}/s)`);
  console.log(`msgs out:           ${msgsOut}  (${(msgsOut / elapsed).toFixed(0)}/s)`);
  console.log(
    `action->ack  p50:   ${pct(0.5)}ms   p95: ${pct(0.95)}ms   p99: ${pct(0.99)}ms   max: ${latencies.at(-1)?.toFixed(1) ?? 'n/a'}ms`,
  );
  console.log(`errors:             ${errors}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
