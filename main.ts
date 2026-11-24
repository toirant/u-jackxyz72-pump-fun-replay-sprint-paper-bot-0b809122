// Pump Fun Replay Sprint — Paper Bot (agent-fun/replay/v2).
//
// A simple, deterministic paper bot for the pump.fun bonding-curve replay.
// It speaks the replay protocol on stdin/stdout directly: one JSON line in
// per batch (hello / batch / done), exactly one reply line out per batch.
// No clock, no randomness, no environment, no network, no files — every
// decision comes only from the batches the harness sends, so two runs on
// the same window produce identical action logs.
//
// Strategy, in brief — ride the opening trend of fresh launches, then get
// out fast:
//   * Watch every coin from its CreateEvent. In its first few slots the
//     bot reads the opening tape: how big the creator's own buy was,
//     whether the creator has already sold, how many other wallets bought
//     in with it (a launch bundled by many wallets is usually the
//     creator's cluster waiting to dump), and whether recent flow is still
//     net buying. It buys only launches that pass, one small stake each.
//   * The position is sold whole on the first of: a fast take-profit,
//     a tight stop loss, a short time limit, or the creator selling while
//     it is held. Nothing is held long: fresh pump.fun coins mostly dump,
//     so the bot takes the opening move and leaves.
//   * Stakes are tiny (0.1 SOL) and spread over as many coins as pass the
//     filter, so no single coin can hurt the run and the 20-coin guardrail
//     is cleared by the entries themselves. A probe backstop opens tiny
//     round trips only if fills or coins ever lag the pace.
//
// Fees: every order pays base + priority tx fees, and curve trades pay the
// protocol + creator fee (~1.25%). With 0.1 SOL stakes the round-trip fee
// is ~0.0027 SOL, small next to the 12–15% exit bands.

// ------------------------------------------------------------------ params

const PARAMS = {
  // Entry: fresh launches only.
  minAge: 0, // youngest age (slots since create) at which a coin may be bought
  maxAge: 3, // oldest age at which a first buy may still be decided
  minRqSol: 0.3, // curve real SOL reserves at entry, lower bound
  maxRqSol: 30, // curve real SOL reserves at entry, upper bound
  maxDevBuySol: 0.5, // creator's own buys in the create slot, at most
  minBuyers: 1, // distinct non-creator buyers seen before entry, at least
  maxBuyers: 1, // ... at most: a launch bundled by many wallets is a dump
  maxRunup: 2.0, // price now over the create price, at most
  flowWindow: 10, // recent-flow window, slots
  // Sizing.
  stakeSol: 0.1, // SOL into one coin, single buy, no adds
  minBuySol: 0.005, // smallest buy worth sending
  buySlipBps: 10000, // slippage on buys; sells go out at 10000
  // Exits.
  takeProfit: 0.15, // sell when close value >= cost * (1 + takeProfit)
  stopLoss: 0.08, // sell when close value <= cost * (1 - stopLoss)
  maxHold: 15, // sell after this many slots held
  // Guardrail pacing (round trips on >= 20 coins).
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
};

const BPS = 10_000n;
const CURVE_FEE_BPS = 125n; // protocol 95 + creator 30 bps fallback
const SELL_SLIP_BPS = 10_000;

// ------------------------------------------------------------------ types

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Curve {
  mint: string;
  created: number | null;
  creator: string;
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
  vq0: bigint; // create-time virtual quote reserves (run-up base)
  vt0: bigint; // create-time virtual token reserves
  reservesSlot: number;
  trades: number;
  complete: boolean;
  devBuy: number; // creator's own buys in the create slot, SOL
  devSold: boolean; // creator sold at any point
  buyers: Set<string>; // distinct non-creator buyers
  bought: number; // SOL bought by anyone
  soldByOthers: number; // SOL sold by non-creators
  tape: Trade[];
  lastTradeSlot: number;
  done: boolean; // never buy again (exited, filtered out, completed)
}

interface Held {
  opened: number;
  devSoldAtOpen: boolean;
}

interface Order {
  side: "buy" | "sell";
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

// ------------------------------------------------------------------ state

const curves = new Map<string, Curve>();
const held = new Map<string, Held>();
const positions = new Map<string, { tokens: bigint; cost: bigint }>();
const pending = new Map<string, Order>();
const probes = new Map<string, boolean>(); // mint -> true once selling
const myCoins = new Set<string>();

let hello: any = null;
let cash = 0n;
let nextClientId = 1;
let myFills = 0;
let firstTime: number | null = null;
let lastTime: number | null = null;

const txFeeLamports = (): bigint =>
  BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports);

const curveOf = (mint: string, slot: number): Curve => {
  let c = curves.get(mint);
  if (c === undefined) {
    c = {
      mint,
      created: null,
      creator: "",
      vq: 0n,
      vt: 0n,
      rq: 0n,
      rt: 0n,
      vq0: 0n,
      vt0: 1n,
      reservesSlot: slot,
      trades: 0,
      complete: false,
      devBuy: 0,
      devSold: false,
      buyers: new Set<string>(),
      bought: 0,
      soldByOthers: 0,
      tape: [],
      lastTradeSlot: slot,
      done: false,
    };
    curves.set(mint, c);
  }
  return c;
};

/** Most this batch's buys on a mint may spend together (1% of real reserves). */
const maxBuyLamports = (mint: string): bigint => {
  const c = curves.get(mint);
  if (c === undefined || c.complete) return 0n;
  return (c.rq * BigInt(hello.caps.max_order_bps_of_real_reserve)) / BPS;
};

/** Cash minus what pending orders will take if they fill (buys + every tx fee). */
const freeCashLamports = (): bigint => {
  const tx = txFeeLamports();
  let free = cash;
  for (const o of pending.values()) {
    free -= tx;
    if (o.side === "buy") free -= BigInt(o.quote_lamports!);
  }
  return free;
};

const committedPositionCount = (): number => {
  const mints = new Set<string>(positions.keys());
  for (const o of pending.values()) if (o.side === "buy") mints.add(o.mint);
  return mints.size;
};

/** Close value of holding `tokens` on curve `c`, in SOL, curve + tx fees deducted. */
const closeValueSol = (c: Curve, tokens: bigint): number => {
  if (c.vt + tokens === 0n) return 0;
  const out = (tokens * c.vq) / (c.vt + tokens);
  const net = out - (out * CURVE_FEE_BPS) / BPS - txFeeLamports();
  return Number(net) / 1e9;
};

/** Net recorded SOL (buys minus sells) on a tape over the last `w` slots. */
const flow = (t: Curve, now: number, w: number): number => {
  let net = 0;
  for (let i = t.tape.length - 1; i >= 0; i--) {
    const tr = t.tape[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
};

/** Entry filter on a fresh launch's opening tape at slot `now`. */
const entrySignal = (c: Curve, now: number): boolean => {
  const p = PARAMS;
  if (c.created === null) return false;
  const age = now - c.created;
  if (age < p.minAge || age > p.maxAge) return false;
  const rqSol = Number(c.rq) / 1e9;
  if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
  if (c.devBuy > p.maxDevBuySol) return false;
  if (c.devSold) return false;
  if (c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) return false;
  // Already dumping: more sold by others than bought in total.
  if (c.soldByOthers > c.bought) return false;
  // Not already mooned off its create price.
  if (c.vq0 > 0n && c.vt0 > 0n) {
    const runup = (Number(c.vq) / Number(c.vt)) / (Number(c.vq0) / Number(c.vt0));
    if (runup > p.maxRunup) return false;
  }
  // Recent flow still net buying.
  if (flow(c, now, p.flowWindow) <= 0) return false;
  return true;
};

// ------------------------------------------------------------------ batch

const decide = (batch: any): Order[] => {
  const p = PARAMS;
  const now: number = batch.slot;
  const orders: Order[] = [];
  const cap: number = hello.caps.max_orders_per_batch;
  const tx = Number(txFeeLamports()) / 1e9;
  const touched = new Set<string>(); // coins created or traded this batch

  // Fold fills in: count my own filled orders (harness closes start with '_').
  for (const f of batch.fills) {
    pending.delete(f.client_id);
    if (f.status === "filled" && !f.client_id.startsWith("_")) {
      myFills++;
      myCoins.add(f.mint);
    }
  }
  // Fold the account in (authoritative cash + positions).
  cash = BigInt(batch.account.cash_lamports);
  positions.clear();
  for (const pos of batch.account.positions) {
    const tokens = BigInt(pos.token_amount);
    if (tokens > 0n) {
      positions.set(pos.mint, { tokens, cost: BigInt(pos.cost_lamports) });
    }
  }
  // Fold marks in (latest reserves for curves held or pending).
  for (const m of batch.marks) {
    const c = curves.get(m.mint);
    if (c === undefined || m.slot < c.reservesSlot) continue;
    c.vq = BigInt(m.virtual_quote_reserves);
    c.vt = BigInt(m.virtual_token_reserves);
    c.rq = BigInt(m.real_quote_reserves);
    c.rt = BigInt(m.real_token_reserves);
    c.reservesSlot = m.slot;
  }
  // Fold events in.
  for (const e of batch.events) {
    if (e.block_time !== null && e.block_time !== undefined) {
      if (firstTime === null) firstTime = e.block_time;
      if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
    }
    if (e.event === "CreateEvent") {
      const c = curveOf(e.mint, e.slot);
      c.created = e.slot;
      c.creator = e.user;
      c.vq = BigInt(e.virtual_quote_reserves);
      c.vt = BigInt(e.virtual_token_reserves);
      c.vq0 = BigInt(e.virtual_quote_reserves);
      c.vt0 = BigInt(e.virtual_token_reserves);
      c.rt = BigInt(e.real_token_reserves);
      c.rq = 0n;
      c.reservesSlot = e.slot;
      touched.add(e.mint);
    } else if (e.event === "TradeEvent") {
      const c = curveOf(e.mint, e.slot);
      c.vq = BigInt(e.virtual_quote_reserves);
      c.vt = BigInt(e.virtual_token_reserves);
      c.rq = BigInt(e.real_quote_reserves);
      c.rt = BigInt(e.real_token_reserves);
      c.reservesSlot = e.slot;
      c.trades++;
      c.lastTradeSlot = e.slot;
      const sol = Number(e.sol_amount) / 1e9;
      c.tape.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
      const isDev = e.user === c.creator;
      if (e.is_buy) {
        c.bought += sol;
        if (isDev && e.slot === c.created) c.devBuy += sol;
        else if (!isDev) c.buyers.add(e.user);
      } else if (isDev) {
        c.devSold = true;
      } else {
        c.soldByOthers += sol;
      }
      touched.add(e.mint);
    } else if (e.event === "CompleteEvent") {
      const c = curveOf(e.mint, e.slot);
      c.complete = true;
      c.done = true;
    }
  }
  // Trim tapes to the lookback we ever need.
  const keep = p.flowWindow + 5;
  for (const mint of touched) {
    const t = curves.get(mint)!;
    let cut = 0;
    while (cut < t.tape.length && t.tape[cut]!.slot <= now - keep) cut++;
    if (cut > 0) t.tape.splice(0, cut);
  }

  const pendingByMint = new Map<string, number>();
  for (const o of pending.values()) {
    pendingByMint.set(o.mint, (pendingByMint.get(o.mint) ?? 0) + 1);
  }
  const sellPending = (mint: string): boolean => {
    for (const o of pending.values()) {
      if (o.mint === mint && o.side === "sell") return true;
    }
    return false;
  };
  const push = (o: Order): boolean => {
    if (orders.length >= cap) return false;
    o.client_id = `o${nextClientId++}`;
    orders.push(o);
    return true;
  };

  // Exits first: sell each flagged position whole.
  for (const [mint, pos] of positions) {
    const curve = curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (sellPending(mint)) continue;
    let h = held.get(mint);
    if (h === undefined) {
      h = { opened: now, devSoldAtOpen: curve.devSold };
      held.set(mint, h);
    }
    const value = closeValueSol(curve, pos.tokens);
    const cost = Number(pos.cost) / 1e9;
    if (cost <= 0) continue;
    let exit = false;
    if (value >= cost * (1 + p.takeProfit)) exit = true;
    if (value <= cost * (1 - p.stopLoss)) exit = true;
    if (now - h.opened >= p.maxHold) exit = true;
    if (curve.devSold && !h.devSoldAtOpen) exit = true;
    if (!exit) continue;
    if (!push({ side: "sell", client_id: "", mint, token_amount: pos.tokens.toString(), max_slippage_bps: SELL_SLIP_BPS })) break;
    curve.done = true;
    held.delete(mint);
  }
  // Drop held records for positions that are gone with nothing pending.
  for (const mint of [...held.keys()]) {
    if (!positions.has(mint) && !pendingByMint.has(mint)) held.delete(mint);
  }

  // Probe round trips: sell the whole probe as soon as its buy has landed.
  for (const [mint, selling] of probes) {
    const pos = positions.get(mint);
    const curve = curves.get(mint);
    if (pos === undefined) {
      if (!pendingByMint.has(mint)) probes.delete(mint);
      continue;
    }
    if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
    if (!push({ side: "sell", client_id: "", mint, token_amount: pos.tokens.toString(), max_slippage_bps: SELL_SLIP_BPS })) break;
    if (!selling) probes.set(mint, true);
  }

  // Entries: one small buy per fresh launch that passes the filter.
  let free = Number(freeCashLamports()) / 1e9;
  let slotsLeft = hello.caps.max_open_positions - committedPositionCount();
  for (const mint of touched) {
    if (orders.length >= cap) break;
    if (slotsLeft <= 0) break;
    const curve = curves.get(mint);
    if (curve === undefined || curve.complete || curve.done) continue;
    if (pendingByMint.has(mint) || probes.has(mint) || positions.has(mint)) continue;
    if (curve.created !== null && now - curve.created > p.maxAge) {
      curve.done = true;
      continue;
    }
    if (!entrySignal(curve, now)) continue;
    const capSol = Number(maxBuyLamports(mint)) / 1e9;
    let amount = Math.min(capSol, p.stakeSol);
    if (amount > free - tx) amount = free - tx;
    if (amount < p.minBuySol) continue;
    const lamports = BigInt(Math.floor(amount * 1e9));
    if (!push({ side: "buy", client_id: "", mint, quote_lamports: lamports.toString(), max_slippage_bps: p.buySlipBps })) break;
    free -= amount + tx;
    slotsLeft--;
    curve.done = true; // one shot per coin
    held.set(mint, { opened: now, devSoldAtOpen: curve.devSold });
  }

  // Guardrail pacing: open a probe when fills or coins lag the pace.
  if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
    const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
    const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
    const needFills = myFills < Math.ceil(p.targetFills * pace);
    if (needCoins || needFills) {
      const minRq = (p.probeSol * Number(BPS)) / hello.caps.max_order_bps_of_real_reserve;
      for (const mint of touched) {
        if (orders.length >= cap || probes.size >= p.maxProbes) break;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || positions.has(mint)) continue;
        if (needCoins && !needFills && myCoins.has(mint)) continue;
        const curve = curves.get(mint);
        if (curve === undefined || curve.complete || curve.done) continue;
        if (Number(curve.rq) / 1e9 < minRq * 1.5) continue;
        if (free < p.probeSol + 2 * tx) break;
        if (!push({ side: "buy", client_id: "", mint, quote_lamports: BigInt(Math.floor(p.probeSol * 1e9)).toString(), max_slippage_bps: p.buySlipBps })) break;
        probes.set(mint, false);
        free -= p.probeSol + tx;
      }
    }
  }

  return orders;
};

// ------------------------------------------------------------------ wire

const main = async (): Promise<void> => {
  let buf = Buffer.alloc(0);
  let batches = 0;
  for await (const chunk of process.stdin) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    let idx: number;
    while ((idx = buf.indexOf(0x0a)) !== -1) {
      const line = buf.subarray(0, idx).toString("utf8");
      buf = buf.subarray(idx + 1);
      if (line.trim() === "") continue;
      const msg = JSON.parse(line);
      if (msg.type === "hello") {
        if (msg.protocol !== "agent-fun/replay/v2") {
          throw new Error(`unsupported protocol ${msg.protocol}`);
        }
        hello = msg;
        cash = BigInt(hello.capital.lamports);
      } else if (msg.type === "batch") {
        if (hello === null) throw new Error("batch before hello");
        const orders = decide(msg);
        for (const o of orders) pending.set(o.client_id, o);
        process.stdout.write(JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n");
        batches++;
      } else if (msg.type === "done") {
        const finalCash = Number(BigInt(msg.account.cash_lamports)) / 1e9;
        const start = Number(BigInt(hello.capital.lamports)) / 1e9;
        console.error(
          `done: batches=${batches} fills=${myFills} coins=${myCoins.size} ` +
            `final_cash=${finalCash.toFixed(6)} SOL net=${(finalCash - start).toFixed(6)} SOL`,
        );
        return;
      } else {
        throw new Error(`unknown message type ${msg.type}`);
      }
    }
  }
  throw new Error("input ended before done");
};

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
