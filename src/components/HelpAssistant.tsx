import { useState } from "react";
import { ArrowLeft, LifeBuoy, MessageCircle, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { openWhatsApp } from "@/lib/device";
import { cn } from "@/lib/utils";

type Topic = {
  id: string;
  label: string;
  issues: { label: string; message: string }[];
};

const TOPICS: Topic[] = [
  {
    id: "license",
    label: "License key issue",
    issues: [
      { label: "My license key was revoked", message: "My Pluto AI Trader license key has been revoked. Please help me restore it." },
      { label: "My license key is suspended", message: "My Pluto AI Trader license key is suspended. Please help me reactivate it." },
      { label: "It says my device is not registered", message: "Pluto AI Trader says this device is not registered with my license key. Please reset my device." },
      { label: "My license expired / I want to renew", message: "My Pluto AI Trader license has expired. I want to renew my monthly subscription ($10)." },
      { label: "I never received my license key", message: "I paid for Pluto AI Trader but I have not received my license key yet." },
    ],
  },
  {
    id: "purchase",
    label: "Buying & subscription",
    issues: [
      { label: "I want to buy the tool", message: "I want to purchase the tool (Pluto AI Trader)." },
      { label: "I want to add another device", message: "I want to buy an extra device license for Pluto AI Trader." },
      { label: "Payment question", message: "I have a question about paying for the Pluto AI Trader subscription." },
    ],
  },
  {
    id: "connection",
    label: "Deriv token / connection",
    issues: [
      { label: "My Deriv token is not connecting", message: "My Deriv PAT token is not connecting in Pluto AI Trader. Please help." },
      { label: "Balance is not showing", message: "My Deriv balance is not showing in Pluto AI Trader." },
      { label: "Live price is not updating", message: "The live market price is not updating in Pluto AI Trader." },
    ],
  },
  {
    id: "trading",
    label: "Trading & settings",
    issues: [
      { label: "Trades are not being placed", message: "Pluto AI Trader is not placing trades. Please help me check my settings." },
      { label: "Recovery mode question", message: "I need help setting up recovery mode in Pluto AI Trader." },
      { label: "Market switcher question", message: "I need help setting up the market switcher in Pluto AI Trader." },
    ],
  },
];

export function HelpAssistant() {
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState<Topic | null>(null);

  return (
    <>
      {open && (
        <Card className="fixed bottom-24 right-4 z-50 w-[min(92vw,340px)] max-h-[70vh] overflow-y-auto p-4 shadow-xl">
          <div className="mb-3 flex items-center gap-2">
            {topic && (
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setTopic(null)}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <h3 className="mr-auto text-sm font-semibold">
              {topic ? topic.label : "How can we help?"}
            </h3>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setOpen(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            {topic
              ? "Pick your problem — we'll open WhatsApp with the message ready."
              : "Choose the area you need help with."}
          </p>
          <div className="grid gap-2">
            {!topic &&
              TOPICS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTopic(t)}
                  className="rounded-md border border-border bg-card p-3 text-left text-sm font-medium transition-colors hover:border-primary hover:bg-accent"
                >
                  {t.label}
                </button>
              ))}
            {topic &&
              topic.issues.map((i) => (
                <button
                  key={i.label}
                  onClick={() => {
                    openWhatsApp(i.message);
                    setOpen(false);
                    setTopic(null);
                  }}
                  className="flex items-center gap-2 rounded-md border border-border bg-card p-3 text-left text-sm transition-colors hover:border-primary hover:bg-accent"
                >
                  <MessageCircle className="h-4 w-4 shrink-0 text-primary" />
                  {i.label}
                </button>
              ))}
          </div>
        </Card>
      )}
      <Button
        size="lg"
        aria-label="Help & support"
        title="Help & support"
        onClick={() => setOpen((v) => !v)}
        className={cn("fixed bottom-6 right-4 z-50 h-14 gap-2 rounded-full px-5 shadow-lg")}
      >
        <LifeBuoy className="h-6 w-6" />
        <span className="text-sm font-semibold">{open ? "Close" : "Help"}</span>
      </Button>
    </>
  );
}
