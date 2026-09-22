import { cn } from "@/lib/utils";

interface Props {
  selected: number[];
  onToggle: (digit: number) => void;
}

export function DigitGrid({ selected, onToggle }: Props) {
  return (
    <div className="grid grid-cols-5 gap-2">
      {Array.from({ length: 10 }, (_, d) => {
        const active = selected.includes(d);
        const order = selected.indexOf(d) + 1;
        return (
          <button
            key={d}
            type="button"
            onClick={() => onToggle(d)}
            className={cn(
              "relative rounded-lg border py-2 text-sm font-semibold transition-colors",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-foreground hover:border-primary/50 hover:bg-accent",
            )}
          >
            {d}
            {active && (
              <span className="absolute right-1 top-0.5 text-[10px] opacity-80">{order}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
