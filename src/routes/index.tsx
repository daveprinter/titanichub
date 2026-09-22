import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  Download,
  Eraser,
  LogOut,
  Menu,
  Moon,
  Pause,
  Play,
  Plug,
  ShieldCheck,
  Shuffle,
  Square,
  Sun,
  TrendingUp,
} from "lucide-react";


import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { DigitGrid } from "@/components/DigitGrid";
import { cn } from "@/lib/utils";
import { useInstallPrompt, usePersistentState, useTheme } from "@/hooks/usePluto";
import {
  MARKETS,
  accountLabel,
  authorizeDerivAccount,
  listDerivAccounts,
  marketLabel,
  type DerivAccount,
  type DerivWS,
} from "@/lib/deriv";

import {
  BotEngine,
  emptyStats,
  type DigitSelection,
  type EngineConfig,
  type EngineStats,
  type RecoveryKind,
  type SwitchMode,
  type TradeLog,
  type Transition,
} from "@/lib/botEngine";
import { AdminPanel } from "@/components/AdminPanel";
import { HelpAssistant } from "@/components/HelpAssistant";
import { LicenseGate } from "@/components/LicenseGate";
import { useLicense } from "@/hooks/useLicense";


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Pluto AI Trader — Deriv Digit Differs Bot" },
      {
        name: "description",
        content:
          "Connect your Deriv PAT token, pick a volatility market and automate digit differs trading with martingale, recovery modes and live stats.",
      },
      { property: "og:title", content: "Pluto AI Trader — Deriv Digit Differs Bot" },
      {
        property: "og:description",
        content:
          "Automated Deriv digit differs trading with martingale, recovery contracts and live profit tracking.",
      },
    ],
  }),
  component: PlutoApp,
});

function PlutoApp() {
  const license = useLicense();

  if (!license.ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Checking your license…
      </div>
    );
  }

  if (!license.licensed) {
    return <LicenseGate error={license.error} busy={license.busy} onActivate={license.activate} />;
  }

  return <PlutoTrader licenseCode={license.code} onSignOut={license.signOut} />;
}


const defaultSelection = (digit: number): DigitSelection => ({
  mode: "single",
  digit,
  digits: [],
  transition: "onloss",
});

const TRANSITIONS: { value: Transition; label: string }[] = [
  { value: "onloss", label: "After one loses" },
  { value: "random", label: "Randomly" },
  { value: "sequential", label: "Sequentially" },
];

const RECOVERY_KINDS: { value: RecoveryKind; label: string }[] = [
  { value: "over", label: "Over prediction" },
  { value: "under", label: "Under prediction" },
  { value: "even", label: "Even prediction" },
  { value: "odd", label: "Odd prediction" },
];

function PlutoTrader({ licenseCode, onSignOut }: { licenseCode: string; onSignOut: () => void }) {
  const { theme, toggle } = useTheme();
  const { canInstall, installed, install } = useInstallPrompt();
  const [adminOpen, setAdminOpen] = useState(false);


  // connection
  const [token, setToken, tokenHydrated] = usePersistentState("token", "");
  const [altToken, setAltToken] = usePersistentState("altToken", "");
  const [accounts, setAccounts] = usePersistentState<DerivAccount[]>("accounts", []);
  const [selectedAccountId, setSelectedAccountId, accountHydrated] = usePersistentState(
    "selectedAccountId",
    "",
  );
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [loginid, setLoginid] = useState("");
  const [currency, setCurrency] = usePersistentState("currency", "USD");
  const [balance, setBalance] = useState(0);
  const wsRef = useRef<DerivWS | null>(null);
  const engineRef = useRef<BotEngine | null>(null);


  // market
  const [symbol, setSymbol] = usePersistentState("symbol", "1HZ10V");
  const [price, setPrice] = useState("—");
  const [lastDigit, setLastDigit] = useState<number | null>(null);

  // trade settings
  const [stake, setStake] = usePersistentState("stake", "0.35");
  const [martingale, setMartingale] = usePersistentState("martingale", "2");
  const [stopLoss, setStopLoss] = usePersistentState("stopLoss", "10");
  const [takeProfit, setTakeProfit] = usePersistentState("takeProfit", "10");
  const [speed, setSpeed] = usePersistentState<"normal" | "everytick">("speed", "normal");
  const [currentStake, setCurrentStake] = useState(0.35);

  // differ config
  const [differMode, setDifferMode] = usePersistentState<"single" | "multi">(
    "differMode",
    "single",
  );
  const [differDigit, setDifferDigit] = usePersistentState("differDigit", "5");
  const [differDigits, setDifferDigits] = usePersistentState<number[]>("differDigits", []);
  const [differTransition, setDifferTransition] = usePersistentState<Transition>(
    "differTransition",
    "onloss",
  );

  // recovery
  const [recoveryOn, setRecoveryOn] = usePersistentState("recoveryOn", false);
  const [recoveryKinds, setRecoveryKinds] = usePersistentState<RecoveryKind[]>(
    "recoveryKinds",
    [],
  );
  const [kindTransition, setKindTransition] = usePersistentState<Transition>(
    "kindTransition",
    "onloss",
  );
  const [overSel, setOverSel] = usePersistentState<DigitSelection>("overSel", defaultSelection(2));
  const [underSel, setUnderSel] = usePersistentState<DigitSelection>(
    "underSel",
    defaultSelection(7),
  );

  // market switcher
  const [switcherOn, setSwitcherOn] = usePersistentState("switcherOn", false);
  const [switchMarkets, setSwitchMarkets] = usePersistentState<string[]>("switchMarkets", []);
  const [switchMode, setSwitchMode] = usePersistentState<SwitchMode>("switchMode", "runs");
  const [switchCount, setSwitchCount] = usePersistentState("switchCount", "5");

  // runtime
  const [markupPct, setMarkupPct] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [logs, setLogs] = usePersistentState<TradeLog[]>("logs", []);
  const [stats, setStats] = usePersistentState<EngineStats>("stats", emptyStats());
  const statsRef = useRef(stats);
  statsRef.current = stats;



  const buildConfig = useCallback(
    (): EngineConfig => ({
      symbol,
      stake: Math.round((parseFloat(stake) || 0.35) * 100) / 100,
      martingale: parseFloat(martingale) || 1,
      stopLoss: parseFloat(stopLoss) || 0,
      takeProfit: parseFloat(takeProfit) || 0,
      speed,
      currency,
      differ: {
        mode: differMode,
        digit: Math.min(9, Math.max(0, parseInt(differDigit, 10) || 0)),
        digits: differDigits,
        transition: differTransition,
      },
      switcher: {
        enabled: switcherOn,
        markets: switchMarkets,
        mode: switchMode,
        count: Math.max(1, parseInt(switchCount, 10) || 1),
      },
      recovery: {
        enabled: recoveryOn,
        kinds: recoveryKinds,
        kindTransition,
        over: overSel,
        under: underSel,
      },
    }),
    [
      symbol,
      stake,
      martingale,
      stopLoss,
      takeProfit,
      speed,
      currency,
      differMode,
      differDigit,
      differDigits,
      differTransition,
      recoveryOn,
      recoveryKinds,
      kindTransition,
      overSel,
      underSel,
      switcherOn,
      switchMarkets,
      switchMode,
      switchCount,
    ],
  );

  useEffect(() => {
    engineRef.current?.updateConfig(buildConfig());
  }, [buildConfig]);

  const pickDefaultAccount = (list: DerivAccount[], preferredId?: string) =>
    list.find((a) => a.id === preferredId) || list.find((a) => a.isDemo) || list[0];

  const connectAccount = async (account: DerivAccount) => {
    setConnecting(true);
    try {
      engineRef.current?.destroy();
      engineRef.current = null;
      wsRef.current?.close();
      setRunning(false);
      setPaused(false);

      const auth = await authorizeDerivAccount(account);
      wsRef.current = auth.ws;
      setConnected(true);
      setLoginid(auth.loginid);
      setCurrency(auth.currency);
      setBalance(auth.balance);
      setSelectedAccountId(account.id);
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === account.id ? { ...a, balance: auth.balance, currency: auth.currency } : a,
        ),
      );

      const engine = new BotEngine(auth.ws, { ...buildConfig(), currency: auth.currency }, {
        onTick: (p, d) => {
          setPrice(p);
          setLastDigit(d);
        },
        onLog: (log) => setLogs((prev) => [log, ...prev].slice(0, 300)),
        onStats: (s) => setStats(s),
        onStake: (s) => setCurrentStake(s),
        onStatus: (s) => setStatus(s),
        onStop: (reason) => {
          setRunning(false);
          setPaused(false);
          toast.info(reason);
        },
        onBalance: (b) => setBalance(b),
        onMarkup: (pct) => setMarkupPct(pct),
        onMarketSwitch: (next) => {
          setSymbol(next);
          setPrice("—");
          setLastDigit(null);
          toast.info(`Switched to ${marketLabel(next)}`);
        },
      });
      engineRef.current = engine;
      engine.hydrateStats(statsRef.current);
      await engine.subscribeTicks(symbol);
      await auth.ws.send({ balance: 1, subscribe: 1 }).catch(() => undefined);
      auth.ws.onClose = () => {
        setConnected(false);
        setRunning(false);
        setStatus("Disconnected");
      };
      toast.success(
        `Connected to ${account.isDemo ? "demo" : "real"} account ${auth.loginid}`,
      );
    } catch (error: any) {
      toast.error(error?.message || "Could not connect to Deriv");
    } finally {
      setConnecting(false);
    }
  };

  /** Fetch demo + real accounts for the saved tokens, then connect the default. */
  const handleConnect = async (autoConnect = true) => {
    if (!token.trim() && !altToken.trim()) {
      toast.error("Enter your Deriv token first");
      return;
    }
    setLoadingAccounts(true);
    try {
      const list = await listDerivAccounts([token, altToken]);
      setAccounts(list);
      const target = pickDefaultAccount(list, selectedAccountId);
      if (target && autoConnect) await connectAccount(target);
      else if (target) setSelectedAccountId(target.id);
    } catch (error: any) {
      toast.error(error?.message || "Could not load your Deriv accounts");
    } finally {
      setLoadingAccounts(false);
    }
  };

  const handleAccountChange = async (id: string) => {
    const account = accounts.find((a) => a.id === id);
    if (!account) return;
    setSelectedAccountId(id);
    if (running) toast.info("Stopping the bot to switch accounts");
    await connectAccount(account);
  };

  // Auto-reconnect with the saved token/account after a refresh or app restart.
  const autoConnectedRef = useRef(false);
  useEffect(() => {
    if (!tokenHydrated || !accountHydrated || autoConnectedRef.current) return;
    if ((!token.trim() && !altToken.trim()) || connected || connecting) return;
    autoConnectedRef.current = true;
    void handleConnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenHydrated, accountHydrated, token, altToken]);




  const handleMarketChange = async (next: string) => {
    setSymbol(next);
    setPrice("—");
    setLastDigit(null);
    const engine = engineRef.current;
    if (engine) {
      engine.updateConfig({ ...buildConfig(), symbol: next });
      try {
        await engine.subscribeTicks(next);
      } catch (e: any) {
        toast.error(e?.message || "Could not subscribe to that market");
      }
    }
  };

  const toggleRun = () => {
    const engine = engineRef.current;
    if (!engine) {
      toast.error("Connect your account first");
      return;
    }
    if (running) {
      engine.stop("Stopped");
      setRunning(false);
      setPaused(false);
      return;
    }
    if (differMode === "multi" && differDigits.length === 0) {
      toast.error("Select at least one digit to differ");
      return;
    }
    if (recoveryOn && recoveryKinds.length === 0) {
      toast.error("Select at least one recovery contract");
      return;
    }
    engine.updateConfig(buildConfig());
    setRunning(true);
    setPaused(false);
    engine.start();
    // Read the live markup configured on Deriv for this app before trading.
    setStatus("Checking markup…");
    void engine.refreshMarkup().then((pct) => {
      setStatus(engine.isRunning ? (engine.isPaused ? "Paused" : "Running") : "Idle");
      if (pct !== null) toast.info(`Deriv app markup: ${pct.toFixed(2)}%`);
    });
  };

  const togglePause = () => {
    const engine = engineRef.current;
    if (!engine || !running) return;
    if (engine.isPaused) {
      engine.resume();
      setPaused(false);
    } else {
      engine.pause();
      setPaused(true);
    }
  };

  useEffect(() => () => engineRef.current?.destroy(), []);

  const toggleDigit = (list: number[], d: number) =>
    list.includes(d) ? list.filter((x) => x !== d) : [...list, d];

  const money = (n: number) => `${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(2)} ${currency}`;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 transform-gpu isolate border-b border-border bg-card [contain:paint]">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
          <img src="/icon-192.png" alt="Pluto Trader logo" className="h-9 w-9 rounded-lg" />
          <div className="mr-auto">
            <h1 className="text-base font-bold leading-tight sm:text-lg">Pluto AI Trader</h1>
            <p className="text-xs text-muted-foreground">
              {connected
                ? `${accounts.find((a) => a.id === loginid)?.isDemo === false ? "Real" : "Demo"} · ${loginid} · ${balance.toFixed(2)} ${currency}`
                : "Not connected"}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
            {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </Button>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open menu">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent className="w-[330px] overflow-y-auto sm:w-[380px]">
              <SheetHeader>
                <SheetTitle>About Pluto AI Trader</SheetTitle>
                <SheetDescription>
                  A trading hub for Deriv synthetic indices.
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-4 pb-6 text-sm text-muted-foreground">
                <p>
                  Connect with a Deriv PAT token, pick a volatility market and the hub streams
                  live ticks straight from your account.
                </p>
                <p>
                  It trades <strong className="text-foreground">Digit Differs</strong> contracts
                  on a single digit or a rotating set of digits, with martingale recovery and
                  automatic two-decimal stake rounding.
                </p>
                <p>
                  Recovery mode lets you fall back to Over, Under, Even or Odd contracts after a
                  loss, and returns to differs as soon as a recovery contract wins.
                </p>
                <p>
                  Stop loss, take profit, live stats and a full trade log keep every run under
                  control.
                </p>
                <Separator />
                <Button
                  className="w-full"
                  onClick={async () => {
                    const outcome = await install();
                    if (outcome === "unavailable")
                      toast.info(
                        installed
                          ? "Pluto Trader is already installed"
                          : "Use your browser menu → Add to Home Screen to install",
                      );
                  }}
                >
                  <Download className="mr-2 h-4 w-4" />
                  {installed ? "Installed" : canInstall ? "Install app" : "Install app"}
                </Button>
                <p className="text-xs">
                  Installs Pluto Trader to your device and opens it full screen, without browser
                  chrome.
                </p>
                <Separator />
                <div className="rounded-md border border-border p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Your license</p>
                  <p className="mt-1 font-mono text-xs text-foreground">{licenseCode}</p>
                  <Button variant="outline" size="sm" className="mt-2 w-full" onClick={onSignOut}>
                    <LogOut className="mr-2 h-4 w-4" /> Remove license from this device
                  </Button>
                </div>
                <Button variant="outline" className="w-full" onClick={() => setAdminOpen(true)}>
                  <ShieldCheck className="mr-2 h-4 w-4" /> Admin panel
                </Button>
              </div>
            </SheetContent>
          </Sheet>

        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          {/* Connection */}
          <Card className="p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Plug className="h-4 w-4 text-primary" /> Deriv connection
            </h2>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="password"
                placeholder="Enter your Deriv token (demo or PAT)"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <Button onClick={() => handleConnect()} disabled={connecting || loadingAccounts}>
                {loadingAccounts
                  ? "Loading accounts…"
                  : connecting
                    ? "Connecting…"
                    : connected
                      ? "Reconnect"
                      : "Connect"}
              </Button>
            </div>
            <Input
              className="mt-2"
              type="password"
              placeholder="Optional: second token (e.g. real account API token)"
              value={altToken}
              onChange={(e) => setAltToken(e.target.value)}
            />
            {accounts.length > 0 && (
              <div className="mt-3">
                <Label className="mb-1.5 block text-xs">Account (demo is the default)</Label>
                <Select value={selectedAccountId} onValueChange={handleAccountChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {accountLabel(a)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {accounts.some((a) => a.isDemo) && accounts.some((a) => !a.isDemo)
                    ? "Demo and real accounts loaded — switch any time."
                    : "Only one account type is reachable with these tokens. Add the other token above to switch."}
                </p>
              </div>
            )}

            {connected && (
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Account" value={loginid} />
                <Stat label="Balance" value={`${balance.toFixed(2)} ${currency}`} />
                <Stat label="Status" value={status} />
              </div>
            )}
          </Card>

          {/* Market */}
          <Card className="p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Activity className="h-4 w-4 text-primary" /> Market
            </h2>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <div>
                <Label className="mb-1.5 block text-xs">Volatility market</Label>
                <Select value={symbol} onValueChange={handleMarketChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MARKETS.map((m) => (
                      <SelectItem key={m.symbol} value={m.symbol}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="rounded-lg border border-border bg-accent/40 px-4 py-2 text-right">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Live price
                </p>
                <p className="font-mono text-xl font-bold text-primary">{price}</p>
                <p className="text-xs text-muted-foreground">
                  Last digit: <span className="font-semibold">{lastDigit ?? "—"}</span>
                </p>
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{marketLabel(symbol)}</p>
          </Card>

          {/* Trade settings */}
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold">Trade settings</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Stake" value={stake} onChange={setStake} />
              <Field label="Martingale" value={martingale} onChange={setMartingale} />
              <Field label="Stop loss" value={stopLoss} onChange={setStopLoss} />
              <Field label="Take profit" value={takeProfit} onChange={setTakeProfit} />
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="mb-1.5 block text-xs">Speed mode</Label>
                <Select value={speed} onValueChange={(v) => setSpeed(v as any)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">Normal speed</SelectItem>
                    <SelectItem value="everytick">Every tick</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <div className="w-full rounded-lg border border-border bg-accent/40 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Next stake
                  </p>
                  <p className="font-mono text-lg font-bold">
                    {currentStake.toFixed(2)} {currency}
                  </p>
                </div>
              </div>
            </div>
          </Card>

          {/* Market switcher */}
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Shuffle className="h-4 w-4 text-primary" /> Market switcher
              </h2>
              <Switch checked={switcherOn} onCheckedChange={setSwitcherOn} />
            </div>
            {switcherOn && (
              <div className="mt-4 space-y-4 rounded-lg border border-primary/30 bg-accent/30 p-3">
                <div>
                  <Label className="mb-1.5 block text-xs">
                    Markets in rotation (tap to add, order matters)
                  </Label>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {MARKETS.map((m) => {
                      const active = switchMarkets.includes(m.symbol);
                      const order = switchMarkets.indexOf(m.symbol) + 1;
                      return (
                        <button
                          key={m.symbol}
                          type="button"
                          onClick={() =>
                            setSwitchMarkets((prev) =>
                              prev.includes(m.symbol)
                                ? prev.filter((x) => x !== m.symbol)
                                : [...prev, m.symbol],
                            )
                          }
                          className={cn(
                            "relative rounded-lg border px-2 py-2 text-[11px] font-semibold transition-colors",
                            active
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-card hover:border-primary/50",
                          )}
                        >
                          {m.label}
                          {active && (
                            <span className="absolute right-1 top-0.5 text-[10px] opacity-80">
                              {order}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="mb-1.5 block text-xs">Switch condition</Label>
                    <Select value={switchMode} onValueChange={(v) => setSwitchMode(v as SwitchMode)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="runs">After X runs on the market</SelectItem>
                        <SelectItem value="losses">After X losses on the market</SelectItem>
                        <SelectItem value="consecutive">After X consecutive losses</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Field
                    label={
                      switchMode === "runs"
                        ? "Number of runs"
                        : switchMode === "losses"
                          ? "Number of losses"
                          : "Consecutive losses"
                    }
                    value={switchCount}
                    onChange={(v) => setSwitchCount(v.replace(/[^0-9]/g, ""))}
                  />
                </div>
                {switchMarkets.length < 2 && (
                  <p className="text-xs text-muted-foreground">
                    Select at least two markets for switching to take effect.
                  </p>
                )}
              </div>
            )}
          </Card>

          {/* Differ contract */}
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold">Differs contract</h2>
            <div className="mb-3 grid grid-cols-2 gap-3">
              <ModeCard
                active={differMode === "multi"}
                title="Multi contract"
                subtitle="Rotate several digits"
                onClick={() => setDifferMode("multi")}
              />
              <ModeCard
                active={differMode === "single"}
                title="Single contract"
                subtitle="Differ one digit"
                onClick={() => setDifferMode("single")}
              />
            </div>
            {differMode === "single" ? (
              <div className="max-w-40">
                <Label className="mb-1.5 block text-xs">Digit to differ</Label>
                <Input
                  inputMode="numeric"
                  value={differDigit}
                  onChange={(e) => setDifferDigit(e.target.value.replace(/[^0-9]/g, "").slice(-1))}
                />
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <Label className="mb-1.5 block text-xs">Digits to differ</Label>
                  <DigitGrid
                    selected={differDigits}
                    onToggle={(d) => setDifferDigits((prev) => toggleDigit(prev, d))}
                  />
                </div>
                <div>
                  <Label className="mb-1.5 block text-xs">Transition mode</Label>
                  <Select
                    value={differTransition}
                    onValueChange={(v) => setDifferTransition(v as Transition)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TRANSITIONS.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </Card>

          {/* Recovery */}
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Recovery mode</h2>
              <Switch checked={recoveryOn} onCheckedChange={setRecoveryOn} />
            </div>
            {recoveryOn && (
              <div className="mt-4 space-y-4 rounded-lg border border-primary/30 bg-accent/30 p-3">
                <div>
                  <Label className="mb-1.5 block text-xs">Recovery contracts</Label>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {RECOVERY_KINDS.map((k) => {
                      const active = recoveryKinds.includes(k.value);
                      const order = recoveryKinds.indexOf(k.value) + 1;
                      return (
                        <button
                          key={k.value}
                          type="button"
                          onClick={() =>
                            setRecoveryKinds((prev) =>
                              prev.includes(k.value)
                                ? prev.filter((x) => x !== k.value)
                                : [...prev, k.value],
                            )
                          }
                          className={cn(
                            "relative rounded-lg border px-2 py-2 text-xs font-semibold transition-colors",
                            active
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-card hover:border-primary/50",
                          )}
                        >
                          {k.label}
                          {active && (
                            <span className="absolute right-1 top-0.5 text-[10px] opacity-80">
                              {order}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {recoveryKinds.length > 1 && (
                  <div>
                    <Label className="mb-1.5 block text-xs">
                      Transition between recovery contracts
                    </Label>
                    <Select
                      value={kindTransition}
                      onValueChange={(v) => setKindTransition(v as Transition)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TRANSITIONS.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {recoveryKinds.includes("over") && (
                  <PredictionPanel
                    title="Over prediction"
                    selection={overSel}
                    onChange={setOverSel}
                    toggleDigit={toggleDigit}
                  />
                )}
                {recoveryKinds.includes("under") && (
                  <PredictionPanel
                    title="Under prediction"
                    selection={underSel}
                    onChange={setUnderSel}
                    toggleDigit={toggleDigit}
                  />
                )}
              </div>
            )}
          </Card>

          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              className="w-full"
              size="lg"
              variant={running ? "destructive" : "default"}
              onClick={toggleRun}
              disabled={!connected}
            >
              {running ? (
                <>
                  <Square className="mr-2 h-4 w-4" /> Stop trading
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" /> Start trading
                </>
              )}
            </Button>
            {running && (
              <Button className="w-full" size="lg" variant="outline" onClick={togglePause}>
                {paused ? (
                  <>
                    <Play className="mr-2 h-4 w-4" /> Resume
                  </>
                ) : (
                  <>
                    <Pause className="mr-2 h-4 w-4" /> Pause
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <TrendingUp className="h-4 w-4 text-primary" /> Stats
              </h2>
              <Button variant="outline" size="sm" onClick={() => {
                engineRef.current?.resetStats();
                setStats(emptyStats());
              }}>
                <Eraser className="mr-1.5 h-3.5 w-3.5" /> Clear
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Total stake" value={stats.totalStake.toFixed(2)} />
              <Stat label="Total payout" value={stats.totalPayout.toFixed(2)} />
              <Stat
                label="Deriv markup"
                value={markupPct === null ? "—" : `${markupPct.toFixed(2)}%`}
              />
              <Stat label="No. of runs" value={String(stats.runs)} />
              <Stat label="Contracts won" value={String(stats.wins)} />
              <Stat label="Contracts lost" value={String(stats.losses)} />
              <Stat
                label="Total profit/loss"
                value={money(stats.profit)}
                tone={stats.profit >= 0 ? "win" : "loss"}
              />
            </div>
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Transactions log</h2>
              <Button variant="outline" size="sm" onClick={() => setLogs([])}>
                <Eraser className="mr-1.5 h-3.5 w-3.5" /> Clear
              </Button>
            </div>
            <div className="grid grid-cols-[1.1fr_1fr_0.9fr] gap-2 border-b border-border pb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Type</span>
              <span>Entry/Exit spot</span>
              <span className="text-right">Buy price and P/L</span>
            </div>
            <div className="max-h-[520px] overflow-y-auto divide-y divide-border">
              {logs.length === 0 && (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  No trades yet. Connect and start trading.
                </p>
              )}
              {logs.map((log) => (
                <div key={log.id} className="grid grid-cols-[1.1fr_1fr_0.9fr] gap-2 py-2 text-xs">
                  <div>
                    <p className="font-semibold">{log.label}</p>
                    <p className="text-muted-foreground">
                      {log.prediction !== null ? `${log.prediction} · ` : ""}
                      {log.time}
                    </p>
                  </div>
                  <div className="font-mono text-[11px]">
                    <p className="flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-full border-2 border-loss" />
                      {log.entrySpot || "—"}
                    </p>
                    <p className="flex items-center gap-1 text-muted-foreground">
                      <span className="inline-block h-2 w-2 rounded-full border-2 border-muted-foreground" />
                      {log.exitSpot}
                    </p>
                  </div>
                  <div className="text-right">
                    <p>{log.stake.toFixed(2)} {currency}</p>
                    <p className={log.win ? "text-win font-semibold" : "text-loss font-semibold"}>
                      {log.profit >= 0 ? "+" : ""}
                      {log.profit.toFixed(2)} {currency}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </main>

      <HelpAssistant />
      <AdminPanel open={adminOpen} onOpenChange={setAdminOpen} />
    </div>

  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "win" | "loss" }) {
  return (
    <div className="rounded-lg border border-border bg-accent/30 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          "truncate text-sm font-bold",
          tone === "win" && "text-win",
          tone === "loss" && "text-loss",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Label className="mb-1.5 block text-xs">{label}</Label>
      <Input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function ModeCard({
  active,
  title,
  subtitle,
  onClick,
}: {
  active: boolean;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-xl border p-3 text-left transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card hover:border-primary/50 hover:bg-accent",
      )}
    >
      <p className="text-sm font-semibold">{title}</p>
      <p className={cn("text-xs", active ? "opacity-80" : "text-muted-foreground")}>{subtitle}</p>
    </button>
  );
}

function PredictionPanel({
  title,
  selection,
  onChange,
  toggleDigit,
}: {
  title: string;
  selection: DigitSelection;
  onChange: (s: DigitSelection) => void;
  toggleDigit: (list: number[], d: number) => number[];
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="mb-2 text-xs font-semibold">{title}</p>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <ModeCard
          active={selection.mode === "multi"}
          title="Multi"
          subtitle="Several digits"
          onClick={() => onChange({ ...selection, mode: "multi" })}
        />
        <ModeCard
          active={selection.mode === "single"}
          title="Single"
          subtitle="One digit"
          onClick={() => onChange({ ...selection, mode: "single" })}
        />
      </div>
      {selection.mode === "single" ? (
        <div className="max-w-40">
          <Label className="mb-1.5 block text-xs">Prediction digit</Label>
          <Input
            inputMode="numeric"
            value={String(selection.digit)}
            onChange={(e) =>
              onChange({
                ...selection,
                digit: Math.min(9, Math.max(0, parseInt(e.target.value.slice(-1), 10) || 0)),
              })
            }
          />
        </div>
      ) : (
        <div className="space-y-3">
          <DigitGrid
            selected={selection.digits}
            onToggle={(d) => onChange({ ...selection, digits: toggleDigit(selection.digits, d) })}
          />
          <div>
            <Label className="mb-1.5 block text-xs">Transition between digits</Label>
            <Select
              value={selection.transition}
              onValueChange={(v) => onChange({ ...selection, transition: v as Transition })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSITIONS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}
