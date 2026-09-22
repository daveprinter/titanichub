import { useState } from "react";
import { KeyRound, MessageCircle, ShieldAlert, ShieldCheck, ShoppingCart } from "lucide-react";

import { AdminPanel } from "@/components/AdminPanel";
import { HelpAssistant } from "@/components/HelpAssistant";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { openWhatsApp } from "@/lib/device";

export function LicenseGate({
  error,
  busy,
  onActivate,
}: {
  error: string | null;
  busy: boolean;
  onActivate: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const [adminOpen, setAdminOpen] = useState(false);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-md p-6">
        <div className="flex flex-col items-center text-center">
          <img src="/icon-192.png" alt="Pluto Trader logo" className="h-16 w-16 rounded-2xl" />
          <h1 className="mt-4 text-xl font-bold">Pluto AI Trader</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Licensed automated Deriv digit trading hub — $10 per month, per device.
          </p>
        </div>

        <Button
          className="mt-6 w-full"
          size="lg"
          onClick={() => openWhatsApp("Hello, I want to purchase the tool (Pluto AI Trader).")}
        >
          <ShoppingCart className="mr-2 h-4 w-4" /> Buy the tool
        </Button>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Opens WhatsApp with a ready-made message to the developer.
        </p>

        <div className="mt-6 space-y-2">
          <Label htmlFor="licence" className="text-xs uppercase tracking-wide text-muted-foreground">
            Already bought? Enter your license key
          </Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="licence"
              placeholder="PLUTO-XXXX-XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && onActivate(code)}
            />
            <Button onClick={() => onActivate(code)} disabled={busy || !code.trim()}>
              <KeyRound className="mr-2 h-4 w-4" /> {busy ? "Checking…" : "Activate"}
            </Button>
          </div>
        </div>

        {error && (
          <div className="mt-4 space-y-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <p className="flex items-start gap-2 text-destructive">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </p>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() =>
                openWhatsApp(
                  `Hello developer, I have a license key problem with Pluto AI Trader: ${error}${
                    code ? ` (key: ${code})` : ""
                  }`,
                )
              }
            >
              <MessageCircle className="mr-2 h-4 w-4" /> Contact developer on WhatsApp
            </Button>
          </div>
        )}

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Each license key is bound to one device. Need to move devices? Message the developer for a
          device reset.
        </p>

        <Button
          variant="ghost"
          size="sm"
          className="mt-3 w-full text-muted-foreground"
          onClick={() => setAdminOpen(true)}
        >
          <ShieldCheck className="mr-2 h-4 w-4" /> Admin panel
        </Button>
        <AdminPanel open={adminOpen} onOpenChange={setAdminOpen} />
        <HelpAssistant />
      </Card>
    </div>
  );
}
