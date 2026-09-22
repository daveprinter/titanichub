const CANDLES = [
  { left: "3%", height: 54, wick: 88, delay: "-1s", duration: "8s", down: false },
  { left: "11%", height: 82, wick: 118, delay: "-5s", duration: "11s", down: true },
  { left: "19%", height: 42, wick: 76, delay: "-8s", duration: "9s", down: false },
  { left: "27%", height: 96, wick: 136, delay: "-3s", duration: "12s", down: false },
  { left: "36%", height: 64, wick: 104, delay: "-10s", duration: "10s", down: true },
  { left: "45%", height: 112, wick: 154, delay: "-6s", duration: "13s", down: false },
  { left: "55%", height: 74, wick: 112, delay: "-2s", duration: "9s", down: true },
  { left: "64%", height: 126, wick: 170, delay: "-9s", duration: "14s", down: false },
  { left: "73%", height: 58, wick: 94, delay: "-4s", duration: "8s", down: false },
  { left: "82%", height: 92, wick: 132, delay: "-7s", duration: "12s", down: true },
  { left: "91%", height: 68, wick: 108, delay: "-11s", duration: "10s", down: false },
] as const;

export function CandlestickBackdrop() {
  return (
    <div aria-hidden="true" className="license-market-bg">
      <div className="license-market-grid" />
      <div className="license-market-line" />
      {CANDLES.map((candle, index) => (
        <span
          key={candle.left}
          className={`license-candle ${candle.down ? "license-candle-down" : ""}`}
          style={{
            "--candle-left": candle.left,
            "--candle-height": `${candle.height}px`,
            "--wick-height": `${candle.wick}px`,
            "--candle-delay": candle.delay,
            "--candle-duration": candle.duration,
            "--candle-offset": `${(index % 4) * 13}px`,
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
}