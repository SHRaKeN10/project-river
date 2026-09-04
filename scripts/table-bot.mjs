// A throwaway opponent so you can watch a real hand play out end to end.
//
//   node scripts/table-bot.mjs                     # joins a "Rookie" table on the deployed server
//   node scripts/table-bot.mjs "Bronze Stakes"     # match a table by name (substring, case-insensitive)
//   node scripts/table-bot.mjs <tableId>           # exact table id
//   node scripts/table-bot.mjs --server http://localhost:3000
//   node scripts/table-bot.mjs --aggressive        # min-raises ~25% of the time instead of just calling
//
// It registers a fresh play-money account each run (riverbot_xxxxxx), sits in the
// first open seat, and plays a passive call-station: checks when it can, calls
// small bets, folds to anything large. Ctrl+C stands it up and deletes nothing -
// the account just lingers with its chips. Play-money only.

import { io } from 'socket.io-client';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const isBool = i + 1 >= args.length || args[i + 1].startsWith('--');
  const val = isBool ? true : args[i + 1];
  args.splice(i, isBool ? 1 : 2);
  return val;
};

const SERVER = flag('--server') ?? 'https://project-river-nick.fly.dev';
const AGGRO = flag('--aggressive') === true;
const TABLE_QUERY = args[0] ?? 'rookie';

// how much of a bet the station will call, as a multiple of the big blind
const CALL_CAP_BB = AGGRO ? 40 : 18;

const rid = () => Math.random().toString(16).slice(2, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(new URL(path, SERVER), {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

function pickSeat(state) {
  for (const s of state.seats) if (s.userId === null) return s.seatNumber;
  return null;
}

function decide(state) {
  const opts = state.legalActions ?? [];
  const kinds = new Set(opts.map((o) => o.kind));
  const bb = state.bigBlind || 1;
  const call = opts.find((o) => o.kind === 'CALL');
  const me = state.seats.find((s) => s.seatNumber === state.youAreSeat);
  const stack = me?.stack ?? 0;

  if (kinds.has('CHECK')) {
    if (AGGRO && kinds.has('BET') && Math.random() < 0.2) {
      const bet = opts.find((o) => o.kind === 'BET');
      const amount = Math.min(bet.max ?? bb * 3, Math.max(bet.min ?? bb * 2, bb * 3));
      return { type: 'BET', amount };
    }
    return { type: 'CHECK' };
  }

  if (call) {
    const amount = call.callAmount ?? 0;
    if (amount > stack) return kinds.has('CHECK') ? { type: 'CHECK' } : { type: 'FOLD' };
    if (amount <= bb * CALL_CAP_BB) {
      if (AGGRO && kinds.has('RAISE') && Math.random() < 0.25) {
        const raise = opts.find((o) => o.kind === 'RAISE');
        const amt = Math.min(
          raise.max ?? amount + bb * 2,
          Math.max(raise.min ?? amount + bb, amount + bb * 2),
        );
        return { type: 'RAISE', amount: amt };
      }
      return { type: 'CALL' };
    }
    return { type: 'FOLD' };
  }

  return kinds.has('CHECK') ? { type: 'CHECK' } : { type: 'FOLD' };
}

async function main() {
  const tag = rid();
  const cred = {
    email: `riverbot+${tag}@example.com`,
    username: `riverbot_${tag}`,
    password: `bot-${rid()}${rid()}${rid()}`,
  };

  console.log(`server   ${SERVER}`);
  console.log(`register ${cred.username}`);
  const auth = await api('/api/auth/register', { method: 'POST', body: cred });
  const token = auth.tokens.accessToken;

  const lobby = await api('/api/lobby', { token });
  const q = TABLE_QUERY.toLowerCase();
  const table =
    lobby.find((t) => t.id === TABLE_QUERY) ??
    lobby.find((t) => t.name.toLowerCase().includes(q)) ??
    lobby[0];
  if (!table) throw new Error('no tables in the lobby');
  console.log(
    `table    ${table.name}  (${table.smallBlind}/${table.bigBlind}, ${table.seatedCount}/${table.maxSeats} seated)`,
  );

  const buyIn = Math.min(table.maxBuyIn, Math.max(table.minBuyIn, table.bigBlind * 100));

  const socket = io(SERVER, { auth: { token }, transports: ['websocket'], forceNew: true });

  socket.on('connect', () => console.log('socket   connected\n'));
  socket.on('connect_error', (e) => console.error('connect_error:', e.message));
  socket.on('error', (e) => console.error('ws error:', JSON.stringify(e)));

  let seat = null;
  let seq = 0;
  let acted = ''; // betting node we last acted on, so a re-sent state doesn't double-act
  let acting = false; // in-flight guard across the pre-action delay
  let lastLine = '';

  const join = async (state) => {
    const s = pickSeat(state);
    if (s === null) {
      console.error('table is full - no open seat. try another table.');
      process.exit(1);
    }
    seat = s;
    const ack = await new Promise((res) =>
      socket.emit('table:join', { tableId: table.id, seatNumber: s, buyIn }, res),
    );
    if (ack && ack.error) {
      console.error(`join failed: ${ack.error}`);
      process.exit(1);
    }
    console.log(`seated   seat ${s + 1}, ${buyIn} chips\n`);
  };

  socket.on('table:state', async (state) => {
    if (state.tableId !== table.id) return;

    if (seat === null) {
      await join(state);
      return;
    }

    const board = state.communityCards.length ? state.communityCards.join(' ') : '-';
    const line = `#${state.handNumber} ${state.street.padEnd(9)} pot ${String(state.pot).padStart(5)}  board ${board}`;
    if (line !== lastLine) {
      console.log(line);
      lastLine = line;
    }

    if (state.youAreSeat === state.actingSeat && (state.legalActions?.length ?? 0) > 0) {
      // A betting node is unique per (hand, street, amount-to-call). When the
      // opponent raises, currentBet moves and this becomes a fresh decision.
      const mine = state.seats.find((s) => s.seatNumber === seat)?.currentBet ?? 0;
      const key = `${state.handId}:${state.street}:${state.currentBet}:${mine}`;
      if (acting || key === acted) return;
      acting = true;
      await sleep(400 + Math.random() * 500);
      const action = decide(state);
      seq += 1;
      acted = key;
      socket
        .timeout(8000)
        .emit(
          'player:action',
          { tableId: table.id, handId: state.handId, clientSeq: seq, action },
          (err, ack) => {
            acting = false;
            const amt = action.amount ? ` ${action.amount}` : '';
            const note = err ? '  (no ack)' : ack && ack.error ? `  (rejected: ${ack.error})` : '';
            console.log(`  bot -> ${action.type}${amt}${note}`);
          },
        );
    }
  });

  socket.on('hand:start', () => {
    seq = 0;
    acted = '';
    console.log(`\n--- hand dealt ---`);
  });

  socket.on('hand:update', (ev) => {
    if (ev.type === 'HOLE_CARDS_DEALT') {
      const mine = ev.hands?.find?.((h) => h.seat === seat);
      if (mine?.cards) console.log(`  bot holds ${mine.cards.join(' ')}`);
    } else if (ev.type === 'HAND_REVEALED') {
      const who = ev.seat === seat ? 'bot' : `seat ${ev.seat + 1}`;
      console.log(
        `  showdown: ${who} ${ev.cards?.join(' ') ?? ''} - ${ev.hand?.description ?? ''}`,
      );
    }
  });

  socket.on('hand:end', (h) => {
    const line = (h.results ?? [])
      .map((r) => `seat ${r.seat + 1} ${r.net >= 0 ? '+' : ''}${r.net} (stack ${r.stack})`)
      .join(', ');
    console.log(`--- hand over: ${line} ---\n`);
  });

  socket.emit('table:watch', { tableId: table.id }, (ack) => {
    if (ack && ack.error) {
      console.error(`watch failed: ${ack.error}`);
      process.exit(1);
    }
  });

  const bye = () => {
    console.log('\nstanding up...');
    socket.emit('table:leave', { tableId: table.id }, () => {
      socket.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
