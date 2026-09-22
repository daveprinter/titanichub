import { fetchAppMarkupPct, type DerivWS } from "./deriv";

export type ContractType = "DIGITDIFF" | "DIGITOVER" | "DIGITUNDER" | "DIGITEVEN" | "DIGITODD";
export type RecoveryKind = "over" | "under" | "even" | "odd";
export type Transition = "onloss" | "random" | "sequential";
export type SpeedMode = "normal" | "everytick";

export interface DigitSelection {
  mode: "single" | "multi";
  digit: number;
  digits: number[];
  transition: Transition;
}

export interface RecoveryConfig {
  enabled: boolean;
  kinds: RecoveryKind[];
  kindTransition: Exclude<Transition, "random"> | "random";
  over: DigitSelection;
  under: DigitSelection;
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
};

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
  }[] = [];

  private currentStake = 0;
  private stats = emptyStats();
  private skipTick = false;


  // selection cursors
  private differIdx = 0;
  private recoveryKindIdx = 0;
  private recoveryDigitIdx = 0;
  private inRecovery = false;

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
    this.cb.onStake(this.currentStake);
    this.inRecovery = false;
    this.differIdx = 0;
    this.recoveryKindIdx = 0;
    this.recoveryDigitIdx = 0;
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
    this.cb.onStatus(this.inRecovery ? "Recovery mode" : "Running");
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

    // Settle the in-flight contract on the FIRST tick after purchase (1 tick
    // duration), so every-tick mode trades on consecutive ticks.
    if (this.pendings.length > 0) {
      const p = this.pendings.shift()!;
      const win = isWinFor(p.type, digit, p.barrier);
      const profit = win ? round2(p.payout - p.buyPrice) : -p.buyPrice;
      this.processResult(win, profit, digit, p, priceStr);
      if (!this.running) return;
      if (!everyTick) this.skipTick = true;
    }

    if (!this.running || this.paused || this.switching) return;
    if (this.buying || this.pendings.length > 0) return;

    if (!everyTick && this.skipTick) {
      this.skipTick = false;
      return;
    }

    // Every-tick mode re-enters on the SAME tick that settled the previous
    // contract, using the freshly updated (martingale) stake.
    this.skipTick = false;
    void this.placeTrade();
  }



  private nextContract(): { type: ContractType; barrier: number | null } {
    if (this.inRecovery && this.cfg.recovery.enabled && this.cfg.recovery.kinds.length) {
      const kinds = this.cfg.recovery.kinds;
      if (this.cfg.recovery.kindTransition === "random")
        this.recoveryKindIdx = Math.floor(Math.random() * kinds.length);
      const kind = kinds[this.recoveryKindIdx % kinds.length]!;
      if (kind === "even") return { type: "DIGITEVEN", barrier: null };
      if (kind === "odd") return { type: "DIGITODD", barrier: null };
      const sel = kind === "over" ? this.cfg.recovery.over : this.cfg.recovery.under;
      return {
        type: kind === "over" ? "DIGITOVER" : "DIGITUNDER",
        barrier: this.pickDigit(sel, "recovery"),
      };
    }
    return { type: "DIGITDIFF", barrier: this.pickDigit(this.cfg.differ, "differ") };
  }

  private pickDigit(sel: DigitSelection, scope: "differ" | "recovery"): number {
    if (sel.mode === "single" || sel.digits.length === 0) return sel.digit;
    const list = sel.digits;
    if (sel.transition === "random") return list[Math.floor(Math.random() * list.length)]!;
    const idx = scope === "differ" ? this.differIdx : this.recoveryDigitIdx;
    return list[idx % list.length]!;
  }

  private advanceCursors(win: boolean) {
    const differ = this.cfg.differ;
    if (differ.mode === "multi" && differ.digits.length > 1) {
      if (differ.transition === "sequential") this.differIdx++;
      else if (differ.transition === "onloss" && !win) this.differIdx++;
    }
    if (this.cfg.recovery.enabled) {
      const rec = this.cfg.recovery;
      const kind = rec.kinds[this.recoveryKindIdx % Math.max(rec.kinds.length, 1)];
      const sel = kind === "over" ? rec.over : kind === "under" ? rec.under : null;
      if (sel && sel.mode === "multi" && sel.digits.length > 1) {
        if (sel.transition === "sequential") this.recoveryDigitIdx++;
        else if (sel.transition === "onloss" && !win) this.recoveryDigitIdx++;
      }
      if (rec.kinds.length > 1) {
        if (rec.kindTransition === "sequential") this.recoveryKindIdx++;
        else if (rec.kindTransition === "onloss" && !win) this.recoveryKindIdx++;
      }
    }
  }

  private processResult(
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

    const wasRecovery = this.inRecovery;

    // Martingale (synchronous)
    const base = round2(this.cfg.stake);
    const multiplier = this.cfg.martingale;
    if (win) {
      this.currentStake = base;
    } else if (!isNaN(multiplier) && multiplier > 1) {
      this.currentStake = round2(this.currentStake * multiplier);
    }
    this.cb.onStake(this.currentStake);

    // Recovery state machine
    if (this.cfg.recovery.enabled && this.cfg.recovery.kinds.length) {
      if (!wasRecovery && !win) {
        this.inRecovery = true;
        this.recoveryKindIdx = 0;
        this.recoveryDigitIdx = 0;
        this.cb.onStatus("Recovery mode");
      } else if (wasRecovery && win) {
        this.inRecovery = false;
        this.cb.onStatus("Running");
      }
    }

    this.advanceCursors(win);

    if (this.cfg.takeProfit > 0 && this.stats.profit >= this.cfg.takeProfit) {
      this.stop("Take profit reached");
      this.cb.onStop("Take profit reached");
      return;
    }
    if (this.cfg.stopLoss > 0 && this.stats.profit <= -this.cfg.stopLoss) {
      this.stop("Stop loss reached");
      this.cb.onStop("Stop loss reached");
      return;
    }

    this.evaluateSwitch(win);
  }

  private evaluateSwitch(win: boolean) {
    const sw = this.cfg.switcher;
    this.marketRuns++;
    if (win) this.marketStreak = 0;
    else {
      this.marketLosses++;
      this.marketStreak++;
    }
    if (!sw?.enabled || sw.markets.length < 2 || !this.running) return;
    const count = Math.max(1, Math.floor(sw.count || 0));
    const hit =
      sw.mode === "runs"
        ? this.marketRuns >= count
        : sw.mode === "losses"
          ? this.marketLosses >= count
          : this.marketStreak >= count;
    if (!hit) return;

    const idx = sw.markets.indexOf(this.cfg.symbol);
    const next = sw.markets[(idx + 1) % sw.markets.length]!;
    if (next === this.cfg.symbol) {
      this.resetMarketCounters();
      return;
    }
    this.resetMarketCounters();
    this.switching = true;
    this.cfg = { ...this.cfg, symbol: next };
    this.cb.onStatus(`Switching market…`);
    void this.subscribeTicks(next)
      .then(() => {
        this.cb.onMarketSwitch?.(next);
        this.cb.onStatus(this.inRecovery ? "Recovery mode" : "Running");
      })
      .catch((e: any) => {
        this.stop(e?.message || "Market switch failed");
        this.cb.onStop(e?.message || "Market switch failed");
      })
      .finally(() => {
        this.switching = false;
      });
  }


  private async placeTrade() {
    if (this.buying || !this.running || this.paused || this.switching) return;
    this.buying = true;
    const stake = round2(this.currentStake);
    const { type, barrier } = this.nextContract();
    const entrySpot = this.lastPrice;

    const contractParams: Record<string, any> = {
      amount: stake,
      basis: "stake",
      contract_type: type,
      currency: this.cfg.currency || "USD",
      duration: 1,
      duration_unit: "t",
    };
    if (barrier !== null) contractParams["barrier"] = String(barrier);

    try {
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
      this.pendings.push({
        buyPrice: Number(buy.buy_price ?? stake),
        payout: Number(buy.payout ?? 0),
        type,
        barrier,
        entrySpot,
      });
      this.buying = false;
    } catch (error: any) {
      this.buying = false;
      this.stop(error?.message || "Trade failed");
      this.cb.onStop(error?.message || "Trade failed");
    }
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
