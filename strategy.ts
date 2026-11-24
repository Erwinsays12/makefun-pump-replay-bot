// Confirm-then-ride: a pump.fun bonding-curve replay bot (agent-fun/replay/v2).
//
// Thesis, from the dev window's own tape: most fresh curves die flat (median coin: 1 buyer,
// 0.3 SOL of buys in its first 20 slots), while the coins that run to 3x or complete share one
// early signature — several distinct wallets buying, real SOL piling in fast, and the price
// already 25%+ above its create price within the first slots. So this bot does NOT snipe the
// create slot. It watches every curve from birth, waits for that signature to confirm, buys
// small, and then rides the run with a trailing stop while cutting losers fast. Five open slots
// and a 24h window of ~1200 coins mean slots must turn over: positions are exited on a stop,
// a trailing stop, a fade in flow, a big sell, a creator sell, or a time limit, so the bot can
// keep sampling fresh coins instead of sitting on dead ones.
//
// Everything is a pure function of the batches the harness sends: no clock, no randomness, no
// I/O, no environment reads, so the two graded executions produce byte-identical action logs.
// Iteration is always over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Slots of tape looked at for the entry signal. */
  window: number;
  /** Net SOL (buys minus sells) the window must show. */
  minNetSol: number;
  /** Buy trades the window must show. */
  minBuys: number;
  /** Distinct non-creator buyers the window must show. */
  minBuyers: number;
  /** Price now over price at window start, minus 1. */
  minPriceUp: number;
  /** Upper bound on that rise: never chase a curve that already ran away inside one window. */
  maxPriceUp: number;
  /** Price now must be at least this share of the window's high. */
  nearHigh: number;
  /** Largest single non-creator wallet's share of the window's buy SOL, at most. 1 = off. */
  maxBuyerShare: number;
  /** The window's last trade must be a buy (the move is still going, not already reversing). */
  lastMustBeBuy: boolean;
  /** Real SOL reserve window at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed / after which it is too late. */
  minAge: number;
  maxAge: number;
  /** Skip the coin when the creator sold in the entry window. */
  skipCreatorSold: boolean;
  /** SOL for one position in total; first buy and each add-on. */
  stakeSol: number;
  initialSol: number;
  addSol: number;
  /** Smallest buy worth sending (tx fees are ~0.000105 SOL per order). */
  minBuySol: number;
  /** Slippage allowed on buys (bps); sells always go out wide open. */
  buySlipBps: number;
  /** Exits, as fractions of cost / peak value. */
  stopLoss: number;
  trail: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Sell everything once value reaches cost * (1 + takeProfit). 0 = off. */
  takeProfit: number;
  /** Sell tp1Part of the position once value reaches cost * (1 + tp1), let the rest ride. 0 = off. */
  tp1: number;
  tp1Part: number;
  /** Exit when net SOL over fadeWindow slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit when the creator sells while we hold. */
  exitOnCreatorSell: boolean;
  /** Exit after this many slots held, unless the position is up at least holdIfUp. */
  maxHold: number;
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Add to a position while it is up and flow stays strong, up to stakeSol. */
  pyramid: boolean;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  /** Most momentum positions open at once (the rest of the cap is for probes). */
  maxMain: number;
  /**
   * Guardrail pacing: the run must end with round trips of >= 0.01 SOL on >= 20 coins. When
   * the bot's own filled coins lag targetCoins scaled by the share of paceSecs elapsed (block
   * time since the first batch), it opens tiny probe round trips (buy probeSol, sell it as soon
   * as the buy lands) until it is back on pace.
   */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /**
   * Rider entries: a curve whose real SOL reserve crosses riderMinRq is close to completing
   * (on the dev window, 46% of coins that reach 40 SOL complete, 62% at 50, 92% at 80, and a
   * completion pays ~14.7x the create price). Buy riderStake once per coin and ride it with a
   * wide trailing stop; momentum entries fill the remaining slots.
   */
  riderMinRq: number;
  riderStake: number;
  riderTrail: number;
  riderStop: number;
  riderMaxHold: number;
  maxRiders: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 8,
  minNetSol: 5,
  minBuys: 4,
  minBuyers: 8,
  minPriceUp: 0.25,
  maxPriceUp: 2.0,
  nearHigh: 0.97,
  maxBuyerShare: 0.4,
  lastMustBeBuy: true,
  minRqSol: 5,
  maxRqSol: 60,
  minAge: 2,
  maxAge: 60,
  skipCreatorSold: true,
  stakeSol: 0.03,
  initialSol: 0.03,
  addSol: 0.05,
  minBuySol: 0.01,
  buySlipBps: 2000,
  stopLoss: 0.15,
  trail: 0.25,
  trailArm: 0.1,
  takeProfit: 0.15,
  tp1: 0,
  tp1Part: 0.5,
  fadeWindow: 20,
  fadeNetSol: 2,
  bigSellSol: 5,
  exitOnCreatorSell: false,
  maxHold: 300,
  holdIfUp: 0.15,
  cooldown: 120,
  maxEntries: 2,
  pyramid: false,
  addStep: 0.1,
  addNetSol: 0.5,
  maxMain: 5,
  targetCoins: 25,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 6,
  riderMinRq: 40,
  riderStake: 0.2,
  riderTrail: 0.25,
  riderStop: 0.2,
  riderMaxHold: 20000,
  maxRiders: 0,
};

const LAMPORTS = 1e9;
/** Curve fees (protocol 95 bps + creator 30 bps) charged on every fill. */
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string;
  trades: Trade[];
  entries: number;
  lastExit: number;
  /** A rider buy was already taken on this curve. */
  riderEntered: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (curve fees included, tx fees excluded). */
  invested: number;
  exiting: boolean;
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
  /** A partial take-profit was already taken on this position. */
  partialTaken: boolean;
  /** 'rider' positions ride toward completion with wide exits; 'mom' are fast momentum trades. */
  kind: 'rider' | 'mom';
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey, creator = ''): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator, trades: [], entries: 0, lastExit: -1e12, riderEntered: false };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge || now - t.created > p.maxAge) return false;
    const from = now - p.window;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    let lastBuy = false;
    let creatorSold = false;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        if (tr.user !== t.creator) byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
        if (tr.user === t.creator) creatorSold = true;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
      lastBuy = tr.buy;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (p.skipCreatorSold && creatorSold) return false;
    if (p.lastMustBeBuy && !lastBuy) return false;
    if (p.maxBuyerShare < 1) {
      let top = 0;
      for (const v of byUser.values()) if (v > top) top = v;
      if (buySol > 0 && top > p.maxBuyerShare * buySol) return false;
    }
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    return true;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const creatorSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint, e.creator);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
          if (!e.is_buy && e.user === t.creator) creatorSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: stops, trailing stops, fades, big sells, creator sells, time limits.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
        void rqSol;
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        // Partial take-profit: bank part of a runner, let the rest ride (momentum only).
        if (h.kind === 'mom' && !h.partialTaken && p.tp1 > 0 && value >= cost * (1 + p.tp1) && !h.exiting) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (!sellPending && orders.length < cap) {
            const part = BigInt(Math.floor(Number(pos.token_amount) * p.tp1Part));
            if (part > 0n) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              h.partialTaken = true;
              h.peakValue = value * (1 - p.tp1Part);
            }
          }
        }
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (h.kind === 'rider') {
          if (!exit && value < cost * (1 - p.riderStop)) exit = true;
          if (!exit && value < h.peakValue * (1 - p.riderTrail)) exit = true;
          if (!exit && bigSell.has(mint)) exit = true;
          if (!exit && p.exitOnCreatorSell && creatorSell.has(mint)) exit = true;
          if (!exit && now - h.opened > p.riderMaxHold) exit = true;
        } else {
          if (!exit && p.takeProfit > 0 && value >= cost * (1 + p.takeProfit)) exit = true;
          if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
          if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
          if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
          if (!exit && bigSell.has(mint)) exit = true;
          if (!exit && p.exitOnCreatorSell && creatorSell.has(mint)) exit = true;
          if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        }
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and pyramid adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let ridersOpen = 0;
      for (const h of held.values()) if (h.kind === 'rider') ridersOpen++;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        // Rider entry: first cross of riderMinRq real SOL, once per coin; the window stays
        // open while real SOL is still within 1.5x of the threshold, then it is too late.
        if (h === undefined && !t.riderEntered && rqSol >= p.riderMinRq && rqSol <= p.riderMinRq * 1.5) {
          if (slotsLeft > 0 && ridersOpen < p.maxRiders) {
            const capSol = Math.floor(Number(state.maxBuyLamports(mint)) * 0.97) / LAMPORTS;
            let amount = Math.min(capSol, p.riderStake, p.maxExposureSol - exposure);
            if (amount > free - tx) amount = free - tx;
            if (amount >= p.minBuySol) {
              const lamports = BigInt(Math.floor(amount * LAMPORTS));
              orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
              free -= amount + tx;
              exposure += amount;
              t.riderEntered = true;
              held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastAddPrice: price, lastValue: 0, partialTaken: false, kind: 'rider' });
              slotsLeft--;
              mainLeft--;
              ridersOpen++;
              continue;
            }
          }
          continue;
        }
        if (h === undefined && !t.riderEntered && rqSol > p.riderMinRq * 1.5) t.riderEntered = true;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = Math.min(p.initialSol, p.stakeSol);
        } else {
          // Pyramid into strength only: the position is up, the price stepped up from the
          // last add, and net SOL still flows in.
          if (h.kind !== 'mom' || !p.pyramid || h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (h.lastValue < (Number(pos.cost_lamports) / LAMPORTS) * 1.0) continue;
          if (flow(t, now, p.window) < p.addNetSol) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint)) * 0.97) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastAddPrice: price, lastValue: 0, partialTaken: false, kind: 'mom' });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe when the bot's filled coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        if (needCoins) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
