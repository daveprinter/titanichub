import { fetchAppMarkupPct, type DerivWS } from "./deriv";

export type ContractType =
  | "DIGITDIFF"
  | "DIGITOVER"
  | "DIGITUNDER"
  | "DIGITEVEN"
  | "DIGITODD"
  | "RUNHIGH"
  | "RUNLOW"
  | "CALL"
  | "PUT";

/** "up" = Only Ups (RUNHIGH), "down" = Only Downs (RUNLOW). */
export type RecoverySide = "up" | "down" | "rise" | "fall" | "over" | "under";
export type Transition = "xruns" | "random" | "sequential";
export type SpeedMode = "normal" | "everytick";
export type RecoveryStakeMode = "differs" | "custom";
export type AfterLossMode = "different-ticks" | "same-ticks";

export interface DigitSelection {
  mode: "single" | "multi";
  digit: number;
  digits: number[];
  transition: Transition;
  /** Runs per digit before advancing when transition === "xruns". */
  transitionRuns: number;
  reorderOnSwitch: boolean;
}

export type SidePair = Record<RecoverySide, number>;

export interface RecoveryConfig {
  enabled: boolean;
  /** Selected recovery contracts. Both selected = hedge mode. */
  sides: RecoverySide[];
  /** Trade duration in ticks for the first recovery attempt (min 2). */
  duration: SidePair;
  stakeMode: RecoveryStakeMode;
  /** Used when stakeMode is "custom". */
  stake: SidePair;
  barriers: { over: number; under: number };
  /** Number of losing rounds per selected contract before rotating. */
  rotateAfterLosses: number;
  /** When to move to the next recovery contract. Hedge pairs count as one contract. */
  rotateMode: "previous-loss" | "x-losses";
  afterLoss: {
    enabled: boolean;
    mode: AfterLossMode;
    duration: SidePair;
    /** After a hedged recovery loss, recover with a single contract only. */
    singleSide: boolean;
    side: RecoverySide;
  };
}

export type SwitchMode = "runs" | "losses" | "consecutive";

export interface SwitcherConfig {
  enabled: boolean;
  markets: string[];
  mode: SwitchMode;
  count: number;
}

export interface EngineConfig {
  symbol: string;
  stake: number;
  martingale: number;
  stopLoss: number;
  takeProfit: number;
  speed: SpeedMode;
  differ: DigitSelection;
  recovery: RecoveryConfig;
  currency: string;
  switcher: SwitcherConfig;
}


export interface TradeLog {
  id: string;
  time: string;
  label: string;
  contractType: ContractType;
  prediction: number | null;
  entrySpot: string;
  exitSpot: string;
  resultDigit: number;
  stake: number;
  profit: number;
  win: boolean;
}

export interface EngineStats {
  runs: number;
  wins: number;
  losses: number;
  totalStake: number;
  totalPayout: number;
  profit: number;
}

export const emptyStats = (): EngineStats => ({
  runs: 0,
  wins: 0,
  losses: 0,
  totalStake: 0,
  totalPayout: 0,
  profit: 0,
});

export interface EngineCallbacks {
  onTick: (price: string, digit: number) => void;
  onLog: (log: TradeLog) => void;
  onStats: (stats: EngineStats) => void;
  onStake: (stake: number) => void;
  onStatus: (status: string) => void;
  onStop: (reason: string) => void;
  onBalance?: (balance: number) => void;
  onMarketSwitch?: (symbol: string) => void;
  onMarkup?: (pct: number | null) => void;

}

const round2 = (n: number) => Math.round(n * 100) / 100;

const CONTRACT_LABEL: Record<ContractType, string> = {
  DIGITDIFF: "Digit Differs",
  DIGITOVER: "Digit Over",
  DIGITUNDER: "Digit Under",
  DIGITEVEN: "Digit Even",
  DIGITODD: "Digit Odd",
  RUNHIGH: "Only Ups",
  RUNLOW: "Only Downs",
  CALL: "Rise",
  PUT: "Fall",
};

export const SIDE_CONTRACT: Record<RecoverySide, ContractType> = {
  up: "RUNHIGH",
  down: "RUNLOW",
  rise: "CALL",
  fall: "PUT",
  over: "DIGITOVER",
  under: "DIGITUNDER",
};

export const MIN_RECOVERY_TICKS = 2;
export const minRecoveryTicks = (side: RecoverySide) => side === "up" || side === "down" ? MIN_RECOVERY_TICKS : 1;

/**
 * Only account-level problems end a run. Everything else (a rejected proposal,
 * a market hiccup, a slow settlement) is retried on the next tick.
 */
function isFatalTradeError(message: string) {
  const m = message.toLowerCase();
  return (
    m.includes("insufficient") ||
    m.includes("balance") ||
    m.includes("authoriz") ||
    m.includes("authentic") ||
    m.includes("token") ||
    m.includes("not connected") ||
    m.includes("disconnect") ||
    m.includes("account") ||
    m.includes("self-exclusion") ||
    m.includes("not available for this account")
  );
}

function isWinFor(type: ContractType, digit: number, barrier: number | null) {
  switch (type) {
    case "DIGITDIFF":
      return digit !== barrier;
    case "DIGITOVER":
      return digit > (barrier ?? 0);
    case "DIGITUNDER":
      return digit < (barrier ?? 0);
    case "DIGITEVEN":
      return digit % 2 === 0;
    case "DIGITODD":
      return digit % 2 === 1;
    default:
      return false;
  }
}

export class BotEngine {
  private ws: DerivWS;
  private cb: EngineCallbacks;
  cfg: EngineConfig;

  private running = false;
  private buying = false;
  private unsubscribe: (() => void) | null = null;
  private pendings: {
    buyPrice: number;
    payout: number;
    type: ContractType;
    barrier: number | null;
    entrySpot: string;
    tickId: number;
  }[] = [];

  private currentStake = 0;
  private stats = emptyStats();
  private skipTick = false;
  private tickSeq = 0;
  private tickWaiters: Array<() => void> = [];

  /** Resolves on the next incoming tick (used to pace recovery at normal speed). */
  private waitForTick(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.tickWaiters.push(resolve);
    });
  }


  // selection cursors
  private differIdx = 0;
  private differRuns = 0;

  /** 0 = trading differs, 1 = first recovery attempt, 2 = after-loss recovery. */
  private recoveryStage = 0;
  private recoveryBusy = false;
  private recoveryIndex = 0;
  private recoveryLosses = 0;
  private recoveryFinishedForSwitch = false;
  private orderedAfterRecoverySwitch = false;

  // pause + market switching
  private paused = false;
  private switching = false;
  private marketRuns = 0;
  private marketLosses = 0;
  private marketStreak = 0;


  constructor(ws: DerivWS, cfg: EngineConfig, cb: EngineCallbacks) {
    this.ws = ws;
    this.cfg = cfg;
    this.cb = cb;
    this.currentStake = round2(cfg.stake);
  }

  updateConfig(cfg: EngineConfig) {
    // Symbol is owned by the engine (subscribeTicks / auto switching) so a late
    // config push from the UI can never revert an in-flight market switch.
    this.cfg = { ...cfg, symbol: this.cfg.symbol };
  }

  /** Markup (%) currently configured for the trading app on Deriv. */
  markupPct: number | null = null;

  /** Re-read the app markup from Deriv; call before each run so owner changes apply. */
  async refreshMarkup(): Promise<number | null> {
    const pct = await fetchAppMarkupPct(this.ws, this.cfg.symbol, this.cfg.currency || "USD");
    this.markupPct = pct;
    this.cb.onMarkup?.(pct);
    return pct;
  }

  getStats() {
    return this.stats;
  }

  hydrateStats(stats: EngineStats) {
    this.stats = { ...stats };
  }


  resetStats() {
    this.stats = emptyStats();
    this.cb.onStats(this.stats);
  }

  async subscribeTicks(symbol: string) {
    this.cfg = { ...this.cfg, symbol };
    this.unsubscribe?.();
    this.unsubscribe = this.ws.onMessage((msg) => {
      if (msg?.msg_type === "tick" && msg.tick?.symbol === this.cfg.symbol) {
        this.handleTick(msg.tick);
      }
      if (msg?.msg_type === "balance" && msg.balance) {
        this.cb.onBalance?.(Number(msg.balance.balance));
      }
    });
    await this.ws.send({ forget_all: "ticks" }).catch(() => undefined);
    await this.ws.send({ ticks: symbol, subscribe: 1 });
  }

  start() {
    this.currentStake = round2(this.cfg.stake);
    this.recCustomStake = null;

    this.cb.onStake(this.currentStake);
    this.recoveryStage = 0;
    this.differIdx = 0;
    this.differRuns = 0;
    this.recoveryIndex = 0;
    this.recoveryLosses = 0;
    this.orderedAfterRecoverySwitch = false;
    this.resetMarketCounters();
    this.paused = false;
    this.running = true;
    this.cb.onStatus("Running");
  }

  stop(reason = "Stopped") {
    this.running = false;
    this.paused = false;
    this.buying = false;
    this.pendings = [];
    this.recoveryStage = 0;
    this.recoveryFinishedForSwitch = false;
    this.cb.onStatus(reason);
  }


  pause() {
    if (!this.running) return;
    this.paused = true;
    this.cb.onStatus("Paused");
  }

  resume() {
    if (!this.running) return;
    this.paused = false;
    this.cb.onStatus(this.recoveryStage > 0 ? "Recovery mode" : "Running");
    if (this.recoveryStage > 0 && !this.recoveryBusy) void this.runRecovery();
  }

  get isPaused() {
    return this.paused;
  }

  get isRunning() {
    return this.running;
  }

  private resetMarketCounters() {
    this.marketRuns = 0;
    this.marketLosses = 0;
    this.marketStreak = 0;
  }


  private lastPrice = "";

  private handleTick(tick: any) {
    const pipSize = tick.pip_size ?? 2;
    const priceStr = Number(tick.quote).toFixed(pipSize);
    this.lastPrice = priceStr;
    const digit = parseInt(priceStr[priceStr.length - 1]!, 10);
    this.cb.onTick(priceStr, digit);

    const everyTick = this.cfg.speed === "everytick";
    this.tickSeq++;
    this.tickWaiters.splice(0).forEach((resolve) => resolve());

    // Settle every differs contract bought on an earlier tick. In every-tick mode
    // several can be in flight at once, so settle ALL that are due on this tick.
    const due = this.pendings.filter((p) => p.tickId < this.tickSeq);
    if (due.length > 0) {
      this.pendings = this.pendings.filter((p) => p.tickId >= this.tickSeq);
      for (const p of due) {
        const win = isWinFor(p.type, digit, p.barrier);
        const profit = win ? round2(p.payout - p.buyPrice) : -p.buyPrice;
        this.processResult(win, profit, digit, p, priceStr);
        if (!this.running) return;
      }
      if (!everyTick) this.skipTick = true;
    }

    if (!this.running || this.paused || this.switching) return;
    if (this.recoveryStage > 0 || this.recoveryBusy) return;

    if (!everyTick) {
      // Normal speed: one contract at a time, and one idle tick after a result.
      if (this.buying || this.pendings.length > 0) return;
      if (this.skipTick) {
        this.skipTick = false;
        return;
      }
      void this.placeTrade();
      return;
    }

    // Every-tick mode: fire a fresh contract on EVERY tick, using the stake
    // that martingale has just updated, without waiting for older contracts.
    this.skipTick = false;
    void this.placeTrade();
  }


  private pickDigit(sel: DigitSelection): number {
    if (sel.mode === "single" || sel.digits.length === 0) return sel.digit;
    const list = this.orderedAfterRecoverySwitch && sel.transition === "sequential"
      ? [...sel.digits].sort((a, b) => a - b) : sel.digits;
    if (sel.transition === "random") return list[Math.floor(Math.random() * list.length)]!;
    return list[this.differIdx % list.length]!;
  }

  private advanceCursors(win: boolean) {
    const differ = this.cfg.differ;
    if (differ.mode === "multi" && differ.digits.length > 1) {
      if (differ.transition === "sequential") this.differIdx++;
      else if (differ.transition === "xruns") {
        this.differRuns++;
        if (this.differRuns >= Math.max(1, differ.transitionRuns || 1)) {
          this.differRuns = 0;
          this.differIdx++;
        }
      }
    }
  }

  private recordTrade(
    win: boolean,
    profit: number,
    digit: number,
    p: { type: ContractType; barrier: number | null; buyPrice: number; entrySpot: string },
    exitSpot: string,
  ) {
    this.stats = {
      runs: this.stats.runs + 1,
      wins: this.stats.wins + (win ? 1 : 0),
      losses: this.stats.losses + (win ? 0 : 1),
      totalStake: round2(this.stats.totalStake + p.buyPrice),
      totalPayout: round2(this.stats.totalPayout + (win ? p.buyPrice + profit : 0)),
      profit: round2(this.stats.profit + profit),
    };
    this.cb.onStats(this.stats);

    this.cb.onLog({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      time: new Date().toLocaleTimeString(),
      label: CONTRACT_LABEL[p.type],
      contractType: p.type,
      prediction: p.barrier,
      entrySpot: p.entrySpot,
      exitSpot,
      resultDigit: digit,
      stake: p.buyPrice,
      profit,
      win,
    });
  }

  /** Returns false when a stop-loss / take-profit ended the run. */
  private checkTargets(): boolean {
    if (this.cfg.takeProfit > 0 && this.stats.profit >= this.cfg.takeProfit) {
      this.stop("Take profit reached");
      this.cb.onStop("Take profit reached");
      return false;
    }
    if (this.cfg.stopLoss > 0 && this.stats.profit <= -this.cfg.stopLoss) {
      this.stop("Stop loss reached");
      this.cb.onStop("Stop loss reached");
      return false;
    }
    return true;
  }

  private applyMartingale(win: boolean) {
    const base = round2(this.cfg.stake);
    const multiplier = this.cfg.martingale;
    if (win) this.currentStake = base;
    else if (!isNaN(multiplier) && multiplier > 1)
      this.currentStake = round2(this.currentStake * multiplier);
    this.cb.onStake(this.currentStake);
  }

  private processResult(
    win: boolean,
    profit: number,
    digit: number,
    p: { type: ContractType; barrier: number | null; buyPrice: number; entrySpot: string },
    exitSpot: string,
  ) {
    this.recordTrade(win, profit, digit, p, exitSpot);
    this.applyMartingale(win);
    this.advanceCursors(win);

    if (!this.checkTargets()) return;

    // A differs loss hands control to the selected recovery contracts.
    const rec = this.cfg.recovery;
    if (!win && rec.enabled && rec.sides.length > 0) {
      this.recoveryStage = 1;
      this.cb.onStatus("Recovery mode");
      void this.runRecovery();
      return;
    }

    this.evaluateSwitch(win);
  }

  private evaluateSwitch(win: boolean, allowSwitch = true) {
    const sw = this.cfg.switcher;
    this.marketRuns++;
    if (win) this.marketStreak = 0;
    else {
      this.marketLosses++;
      this.marketStreak++;
    }
    if (!allowSwitch || !sw?.enabled || sw.markets.length < 2 || !this.running) return;
    const count = Math.max(1, Math.floor(sw.count || 0));
    const hit =
      sw.mode === "runs"
        ? this.marketRuns >= count
        : sw.mode === "losses"
          ? this.marketLosses >= count
          : this.marketStreak >= count;
    if (!hit) return;

    const idx = sw.markets.indexOf(this.cfg.symbol);
    const next = sw.markets[(idx + 1) % sw.markets.length];
    if (!next) return;
    if (next === this.cfg.symbol) {
      this.resetMarketCounters();
      return;
    }
    this.resetMarketCounters();
    this.switching = true;
    this.cb.onStatus(`Switching market…`);
    void this.subscribeTicks(next)
      .then(() => {
        if (this.recoveryFinishedForSwitch && this.cfg.differ.reorderOnSwitch) {
          this.orderedAfterRecoverySwitch = true;
          this.differIdx = 0;
        }
        this.cb.onMarketSwitch?.(next);
        this.cb.onStatus(this.recoveryStage > 0 ? "Recovery mode" : "Running");
      })
      .catch((e: any) => {
        // Keep trading on the current market instead of ending the run.
        this.reportTradeIssue(e);
      })
      .finally(() => {
        this.switching = false;
        this.recoveryFinishedForSwitch = false;
        if (this.running && !this.paused && this.recoveryStage > 0 && !this.recoveryBusy) void this.runRecovery();
      });
  }


  // ---------------------------------------------------------------- recovery

  private recoveryTicks(n: number, side: RecoverySide) {
    return Math.max(minRecoveryTicks(side), Math.floor(n || minRecoveryTicks(side)));
  }

  /** Live per-side stakes while recovering with a custom (different) stake. */
  private recCustomStake: Partial<SidePair> | null = null;

  private baseCustomStake(side: RecoverySide) {
    const rec = this.cfg.recovery;
    const value = rec.stake[side];
    return round2(Math.max(0.35, value || 0.35));
  }

  private recoveryStake(side: RecoverySide) {
    if (this.cfg.recovery.stakeMode === "custom") {
      if (!this.recCustomStake) this.recCustomStake = {};
      return round2(Math.max(0.35, this.recCustomStake[side] ?? this.baseCustomStake(side)));
    }
    return round2(this.currentStake);
  }

  /** Martingales the recovery stake after a losing recovery round. */
  private applyRecoveryMartingale(win: boolean) {
    if (this.cfg.recovery.stakeMode !== "custom") {
      this.applyMartingale(win);
      return;
    }
    const multiplier = this.cfg.martingale;
    if (win) {
      // Recovery done: back to Differs on its original stake.
      this.recCustomStake = null;
      this.applyMartingale(true);
      return;
    }
    if (!this.recCustomStake) this.recCustomStake = {};
    if (!isNaN(multiplier) && multiplier > 1) {
      for (const side of this.cfg.recovery.sides) {
        this.recCustomStake[side] = round2((this.recCustomStake[side] ?? this.baseCustomStake(side)) * multiplier);
      }
    }
  }


  /** Loops recovery rounds until one comes out in profit (or the run stops). */
  private async runRecovery() {
    if (this.recoveryBusy) return;
    this.recoveryBusy = true;
    try {
      while (this.running && !this.paused && !this.switching && this.recoveryStage > 0) {
        const rec = this.cfg.recovery;
        if (!rec.enabled || rec.sides.length === 0) {
          this.recoveryStage = 0;
          break;
        }

        const stage = this.recoveryStage;
        // Hedge pairs (Only Ups + Only Downs, Digit Over + Digit Under) count as
        // one recovery contract; every other selection is its own contract.
        const units: RecoverySide[][] = [];
        const has = (s: RecoverySide) => rec.sides.includes(s);
        for (const s of rec.sides) {
          if ((s === "up" || s === "down") && has("up") && has("down")) {
            if (!units.some((u) => u.includes("up"))) units.push(["up", "down"]);
          } else if ((s === "over" || s === "under") && has("over") && has("under")) {
            if (!units.some((u) => u.includes("over"))) units.push(["over", "under"]);
          } else units.push([s]);
        }
        const unit = units[this.recoveryIndex % units.length];
        if (!unit) break;
        const hedge = unit.length > 1;
        let sides: RecoverySide[] = unit.slice();
        let durations: SidePair = { ...rec.duration };

        if (stage >= 2 && rec.afterLoss.enabled) {
          if (rec.afterLoss.mode === "different-ticks") durations = { ...rec.afterLoss.duration };
          if (hedge && unit.includes("up") && rec.afterLoss.singleSide) sides = [rec.afterLoss.side];
        }
        // Both hedge legs use the same duration so they exit on the same tick.
        if (sides.length > 1) {
          const [a, b] = sides as [RecoverySide, RecoverySide];
          const shared = Math.max(this.recoveryTicks(durations[a], a), this.recoveryTicks(durations[b], b));
          durations = { ...durations, [a]: shared, [b]: shared };
        }

        let net = 0;
        try {
          // When hedging, net is the difference between the two legs.
          net = await this.runRecoveryRound(sides, durations);
        } catch (error: any) {
          this.reportTradeIssue(error);
          if (!this.running) break;
          await this.waitForTick();
          continue;
        }
        if (!this.running) break;

        if (net > 0) {
          this.recoveryStage = 0;
          this.recoveryIndex = 0;
          this.recoveryLosses = 0;
          this.recoveryFinishedForSwitch = true;
          this.cb.onStatus("Running");
          this.evaluateSwitch(true);
          if (!this.switching) this.recoveryFinishedForSwitch = false;
          break;
        }

        // A losing hedge round is a single loss for the pair.
        this.recoveryLosses++;
        const threshold = rec.rotateMode === "previous-loss" ? 1 : Math.max(1, rec.rotateAfterLosses || 1);
        if (units.length > 1 && this.recoveryLosses >= threshold) {
          this.recoveryIndex = (this.recoveryIndex + 1) % units.length;
          this.recoveryLosses = 0;
        }
        this.evaluateSwitch(false, false);
        if (!this.running) break;
        if (stage === 1 && rec.afterLoss.enabled) this.recoveryStage = 2;
        if (this.switching) break;

        // Recovery follows the selected speed mode: every-tick re-enters straight
        // away, normal speed leaves one idle tick between recovery rounds.
        if (this.cfg.speed !== "everytick" && this.running) await this.waitForTick();
      }
    } finally {
      this.recoveryBusy = false;
    }
  }

  /** Buys the selected recovery contracts (hedged when both) and settles them. */
  private async runRecoveryRound(sides: RecoverySide[], durations: SidePair): Promise<number> {
    const hedge = sides.length > 1;
    const first = sides[0];
    if (!first) return 0;
    const second = sides[1];
    this.cb.onStatus(
      hedge && second
        ? `Recovery · hedge ${CONTRACT_LABEL[SIDE_CONTRACT[first]]} + ${CONTRACT_LABEL[SIDE_CONTRACT[second]]} (${this.recoveryTicks(durations[first], first)} ticks)`
        : `Recovery · ${CONTRACT_LABEL[SIDE_CONTRACT[first]]} (${this.recoveryTicks(durations[first], first)} ticks)`,
    );

    const entrySpot = this.lastPrice;

    // Hedging: both contracts are sent at the same moment, same entry spot.
    const bought = await Promise.all(
      sides.map(async (side) => {
        const stake = this.recoveryStake(side);
        const ticks = this.recoveryTicks(durations[side], side);
        const barrier = side === "over" ? Math.min(8, Math.max(0, Math.floor(this.cfg.recovery.barriers.over)))
          : side === "under" ? Math.min(9, Math.max(1, Math.floor(this.cfg.recovery.barriers.under))) : null;
        const buy = await this.buyContract(SIDE_CONTRACT[side], stake, ticks, barrier);
        return { side, stake, buy, barrier };
      }),
    );

    const settled = await Promise.all(
      bought.map(async (b) => ({
        ...b,
        contract: await this.waitForContract(Number(b.buy.contract_id)),
      })),
    );

    let net = 0;
    for (const s of settled) {
      const profit = round2(Number(s.contract?.profit ?? -Number(s.buy.buy_price ?? s.stake)));
      const win = profit > 0;
      net = round2(net + profit);
      const exitSpot = String(
        s.contract?.exit_tick_display_value ?? s.contract?.current_spot_display_value ?? "—",
      );
      const digit = parseInt(exitSpot[exitSpot.length - 1] ?? "0", 10) || 0;
      this.recordTrade(
        win,
        profit,
        digit,
        {
          type: SIDE_CONTRACT[s.side],
          barrier: s.barrier,
          buyPrice: Number(s.buy.buy_price ?? s.stake),
          entrySpot: String(s.contract?.entry_tick_display_value ?? entrySpot),
        },
        exitSpot,
      );
    }

    // Winning the recovery resets the stake, losing martingales it.
    this.applyRecoveryMartingale(net > 0);
    this.checkTargets();
    return net;
  }

  private waitForContract(contractId: number): Promise<any> {
    return new Promise((resolve, reject) => {
      let off: (() => void) | null = null;
      const timer = setTimeout(() => {
        off?.();
        reject(new Error("Deriv did not settle the recovery contract in time"));
      }, 180000);
      off = this.ws.onMessage((msg: any) => {
        const c = msg?.proposal_open_contract;
        if (msg?.msg_type !== "proposal_open_contract" || !c) return;
        if (Number(c.contract_id) !== contractId) return;
        if (c.is_sold || c.status === "won" || c.status === "lost") {
          clearTimeout(timer);
          off?.();
          resolve(c);
        }
      });
      this.ws
        .send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 })
        .catch((e: any) => {
          clearTimeout(timer);
          off?.();
          reject(new Error(e?.message || "Could not track the recovery contract"));
        });
    });
  }


  private async placeTrade() {
    const everyTick = this.cfg.speed === "everytick";
    if (!this.running || this.paused || this.switching) return;
    // Every-tick mode allows overlapping purchases; normal speed does not.
    if (this.buying && !everyTick) return;
    this.buying = true;
    const stake = round2(this.currentStake);
    const barrier = this.pickDigit(this.cfg.differ);
    const entrySpot = this.lastPrice;

    try {
      const buy = await this.buyContract("DIGITDIFF", stake, 1, barrier);
      // Stamp with the tick that was current when Deriv confirmed the buy, so the
      // contract settles on the next tick — never on a stale one.
      const tickId = this.tickSeq;
      this.pendings.push({
        buyPrice: Number(buy.buy_price ?? stake),
        payout: Number(buy.payout ?? 0),
        type: "DIGITDIFF",
        barrier,
        entrySpot,
        tickId,
      });
      this.buying = false;
    } catch (error: any) {
      this.buying = false;
      // A single rejected purchase must never end the run: only a manual stop,
      // take profit or stop loss does that. Report it and keep trading.
      this.reportTradeIssue(error);
    }
  }

  /** Surfaces a non-fatal trade problem without ending the run. */
  private reportTradeIssue(error: any) {
    const msg = String(error?.message || "Trade could not be placed");
    if (!this.running) return;
    if (isFatalTradeError(msg)) {
      this.stop(msg);
      this.cb.onStop(msg);
      return;
    }
    this.cb.onStatus(`Retrying · ${msg}`);
  }

  private async buyContract(
    type: ContractType,
    stake: number,
    ticks: number,
    barrier: number | null,
  ): Promise<any> {
    const contractParams: Record<string, any> = {
      amount: stake,
      basis: "stake",
      contract_type: type,
      currency: this.cfg.currency || "USD",
      duration: ticks,
      duration_unit: "t",
    };
    if (barrier !== null) contractParams["barrier"] = String(barrier);

    const buyRes: any =
      this.ws.mode === "pat"
        ? await this.buyViaProposal(contractParams, stake)
        : await this.ws.send({
            buy: 1,
            price: stake,
            parameters: { ...contractParams, symbol: this.cfg.symbol },
          });

    const buy = buyRes?.buy;
    if (!buy) throw new Error("Deriv did not confirm the purchase");
    return buy;
  }


  private async buyViaProposal(
    contractParams: Record<string, any>,
    stake: number,
  ): Promise<any> {
    const proposalRes: any = await this.ws.send({
      proposal: 1,
      ...contractParams,
      underlying_symbol: this.cfg.symbol,
    });
    const proposalId = proposalRes?.proposal?.id;
    if (!proposalId) throw new Error("Deriv did not return a proposal ID");
    return this.ws.send({ buy: proposalId, price: stake });
  }

  destroy() {
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
