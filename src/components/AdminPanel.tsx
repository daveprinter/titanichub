import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Ban, Copy, History, Plus, RefreshCw, Settings, ShieldCheck, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  adminDeleteResendKey,
  adminGenerateLicense,
  adminGetSettings,
  adminLicenseAction,
  adminEndSession,
  adminLicenseHistory,
  adminListLicenses,
  adminListResendKeys,
  adminResendCode,
  adminSaveResendKey,
  adminCheckCode,
  adminStart,
  adminUpdateSettings,
  adminVerify,
  type AdminLicenseRow,
  type AdminSettings,
  type EmailDelivery,
  type ResendKeyEntry,
} from "@/lib/admin.functions";

type Step = "code" | "email" | "verify" | "panel";

const ORIGINAL_ADMIN_EMAIL = "vitralparts306@gmail.com";

// Keys that stay fully functional but are not shown in the admin list.
const HIDDEN_RESEND_EMAILS = ["davidkula109@gmail.com", "versity419@gmail.com"];

function ResendKeysCard({ token }: { token: string }) {
  const [entries, setEntries] = useState<ResendKeyEntry[] | null>(null);
  const [email, setEmail] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setEntries(await adminListResendKeys({ data: { token } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load saved keys");
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    setBusy(true);
    try {
      const res = await adminSaveResendKey({ data: { token, email, apiKey } });
      res.ok ? toast.success(res.message) : toast.error(res.message);
      if (res.ok) {
        setEmail("");
        setApiKey("");
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: string) => {
    const res = await adminDeleteResendKey({ data: { token, email: target } });
    res.ok ? toast.success(res.message) : toast.error(res.message);
    await load();
  };

  return (
    <Card className="p-3 space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="h-4 w-4 text-primary" /> Resend API keys per login email
      </div>
      <p className="text-[11px] text-muted-foreground">
        A login email can only receive verification codes once its own Resend key is saved here. Otherwise use{" "}
        <span className="font-medium">{ORIGINAL_ADMIN_EMAIL}</span>.
      </p>
      <div className="space-y-2">
        {entries === null ? (
          <p className="text-xs text-muted-foreground">Loading saved keys…</p>
        ) : entries.filter((e) => !HIDDEN_RESEND_EMAILS.includes(e.email.toLowerCase())).length === 0 ? (
          <p className="text-xs text-muted-foreground">No keys saved yet.</p>
        ) : (
          entries
            .filter((e) => !HIDDEN_RESEND_EMAILS.includes(e.email.toLowerCase()))
            .map((e) => (
              <div key={e.email} className="flex items-center justify-between rounded-md border px-2 py-1.5 text-xs">
                <span className="truncate">
                  <span className="font-medium">{e.email}</span>
                  <span className="ml-2 text-muted-foreground">{e.keyPreview}</span>
                </span>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => remove(e.email)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Input type="email" placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input
          type="password"
          autoComplete="off"
          placeholder="re_…"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value.trim())}
        />
        <Button onClick={add} disabled={busy || !email || !apiKey}>
          <Plus className="mr-2 h-4 w-4" /> Save key
        </Button>
      </div>
    </Card>
  );
}

function AdminSettingsCard({ token }: { token: string }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<AdminSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminCode, setAdminCode] = useState("");
  const [fallbackCode, setFallbackCode] = useState("");
  const [delivery, setDelivery] = useState<EmailDelivery>("resend");
  const [resendApiKey, setResendApiKey] = useState("");

  useEffect(() => {
    if (!open || saved) return;
    adminGetSettings({ data: { token } })
      .then((s) => {
        setSaved(s);
        setAdminEmail(s.adminEmail);
        setAdminCode(s.adminCode);
        setFallbackCode(s.fallbackCode);
        setDelivery(s.delivery);
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Could not load settings"));
  }, [open, saved, token]);

  const emailChanged =
    !!saved && adminEmail.trim().toLowerCase() !== saved.resendOwnerEmail.toLowerCase();
  const needsChoice = emailChanged && delivery === "resend" && !resendApiKey;

  const save = async () => {
    if (!adminCode.trim()) {
      toast.error("A code to open the admin panel is required — you must set one (4–8 digits).");
      return;
    }
    if (needsChoice) {
      toast.error("Pick how codes should reach the new email, or add a Resend key from that email's account.");
      return;
    }

    setBusy(true);
    try {
      const res = await adminUpdateSettings({
        data: {
          token,
          adminEmail,
          adminCode,
          fallbackCode,
          delivery,
          resendApiKey,
          resendOwnerEmail: resendApiKey ? adminEmail : saved?.resendOwnerEmail,
        },
      });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success(res.message);
      setResendApiKey("");
      setSaved(null); // reload
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save settings");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-3">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Settings className="h-4 w-4 text-primary" /> Admin login & email settings
        </span>
        <span className="text-xs text-muted-foreground">{open ? "Hide" : "Change email, codes, Resend key"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-4">
          <Separator />
          {!saved ? (
            <p className="text-xs text-muted-foreground">Loading settings…</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="set-admin-code">Admin panel code (required)</Label>
                  <Input
                    id="set-admin-code"
                    inputMode="numeric"
                    required
                    value={adminCode}
                    onChange={(e) => setAdminCode(e.target.value.replace(/\D/g, ""))}
                    placeholder="0000"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Asked first, before the email code is sent. Cannot be left empty.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="set-fallback-code">Testing verification code</Label>
                  <Input
                    id="set-fallback-code"
                    inputMode="numeric"
                    value={fallbackCode}
                    onChange={(e) => setFallbackCode(e.target.value.replace(/\D/g, ""))}
                    placeholder="Leave empty to disable"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Always accepted instead of the emailed code. Clear it and only the real emailed code will work.
                  </p>
                </div>

              </div>

              <div className="space-y-1.5">
                <Label htmlFor="set-admin-email">Admin email (receives login codes)</Label>
                <Input
                  id="set-admin-email"
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="admin@example.com"
                />
                <p className="text-[11px] text-muted-foreground">
                  Current Resend key delivers to <span className="font-medium">{saved.resendOwnerEmail}</span>
                  {saved.resendKeyPreview ? ` (key ${saved.resendKeyPreview})` : " (no key saved)"}.
                </p>
              </div>

              {emailChanged && (
                <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
                  <p className="text-xs">
                    <span className="font-semibold">New email detected.</span> Resend only delivers to the email that
                    owns its API key, so choose how codes should reach{" "}
                    <span className="font-medium">{adminEmail || "the new address"}</span>:
                  </p>
                  <Select value={delivery} onValueChange={(v) => setDelivery(v as EmailDelivery)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="resend">Resend.com — add a key from the new email's Resend account</SelectItem>
                      <SelectItem value="lovable">Lovable Emails — send to the new email</SelectItem>
                      <SelectItem value="both">Both — Resend to {saved.resendOwnerEmail}, Lovable to the new email</SelectItem>
                    </SelectContent>
                  </Select>
                  {delivery !== "resend" && !saved.lovableEmailReady && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400">
                      Lovable Emails is not activated for this project yet. Ask Lovable to set up the email domain
                      first; until then codes to the new email will not be delivered
                      {delivery === "both" ? ` (the copy to ${saved.resendOwnerEmail} still sends)` : ""}.
                    </p>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="set-resend-key">
                  New Resend.com API token {emailChanged && delivery === "resend" ? "(required)" : "(optional)"}
                </Label>
                <Input
                  id="set-resend-key"
                  type="password"
                  autoComplete="off"
                  value={resendApiKey}
                  onChange={(e) => setResendApiKey(e.target.value.trim())}
                  placeholder="re_…"
                />
                <p className="text-[11px] text-muted-foreground">
                  Paste a token created in the Resend account of{" "}
                  <span className="font-medium">{adminEmail || "the admin email"}</span>. It is validated with Resend and
                  replaces the current key; the admin email becomes the delivery address.
                </p>
              </div>

              <Button onClick={save} disabled={busy} className="w-full sm:w-auto">
                {busy ? "Updating…" : "Update settings"}
              </Button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

export function AdminPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [step, setStep] = useState<Step>("code");
  const [adminCode, setAdminCode] = useState("");
  const [loginEmail, setLoginEmail] = useState(ORIGINAL_ADMIN_EMAIL);
  const [verifyCode, setVerifyCode] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | undefined>();
  const [codeSentAt, setCodeSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [rows, setRows] = useState<AdminLicenseRow[]>([]);
  const [customer, setCustomer] = useState("");
  const [plan, setPlan] = useState("monthly");
  const [days, setDays] = useState("30");
  const [history, setHistory] = useState<{ id: string; event: string; detail: string; created_at: string }[] | null>(
    null,
  );

  const refresh = useCallback(
    async (t: string) => {
      try {
        setRows(await adminListLicenses({ data: { token: t } }));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not load licenses");
        setStep("code");
      }
    },
    [],
  );

  useEffect(() => {
    if (step !== "verify") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [step]);

  useEffect(() => {
    if (step !== "panel" || !token) return;
    const id = setInterval(() => refresh(token), 30_000);
    return () => clearInterval(id);
  }, [step, token, refresh]);

  const submitCode = async () => {
    if (!adminCode.trim()) {
      toast.error("Enter the admin panel code.");
      return;
    }
    setBusy(true);
    try {
      const res = await adminCheckCode({ data: { code: adminCode.trim() } });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      setStep("email");
    } finally {
      setBusy(false);
    }
  };

  const submitEmail = async () => {
    setBusy(true);
    try {
      const res = await adminStart({ data: { code: adminCode.trim(), email: loginEmail.trim() } });
      if (!res.ok || !res.token) {
        toast.error(res.message);
        if (res.message.includes("admin panel code")) setStep("code");
        return;
      }
      setToken(res.token);
      setSentTo(res.sentTo);
      setCodeSentAt(Date.now());
      setVerifyCode("");
      setStep("verify");
      toast.info(res.message);
    } finally {
      setBusy(false);
    }
  };


  const resendCode = async () => {
    setBusy(true);
    try {
      const res = await adminResendCode({ data: { token } });
      if (!res.ok) {
        toast.error(res.message);
        if (res.message.includes("Start again")) setStep("code");
        return;
      }
      setCodeSentAt(Date.now());
      setVerifyCode("");
      toast.success(res.message);
    } finally {
      setBusy(false);
    }
  };

  const CODE_TTL_MS = 30 * 60_000;
  const RESEND_COOLDOWN_MS = 30_000;
  const remainingMs = codeSentAt ? Math.max(0, codeSentAt + CODE_TTL_MS - now) : 0;
  const cooldownMs = codeSentAt ? Math.max(0, codeSentAt + RESEND_COOLDOWN_MS - now) : 0;
  const mmss = (ms: number) =>
    `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

  const submitVerify = async () => {
    setBusy(true);
    try {
      const res = await adminVerify({ data: { token, code: verifyCode } });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      setStep("panel");
      await refresh(token);
      toast.success(res.message);
    } finally {
      setBusy(false);
    }
  };

  const act = async (licenseId: string, action: string, extra?: number) => {
    const res = await adminLicenseAction({ data: { token, licenseId, action, days: extra ?? 30 } });
    res.ok ? toast.success(res.message) : toast.error(res.message);
    await refresh(token);
  };

  const generate = async () => {
    setBusy(true);
    try {
      const created = await adminGenerateLicense({
        data: { token, customer, plan, days: Number(days) || 30 },
      });
      await navigator.clipboard.writeText(created.code).catch(() => {});
      toast.success(`License ${created.code} generated and copied`);
      setCustomer("");
      await refresh(token);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not generate license");
    } finally {
      setBusy(false);
    }
  };

  const showHistory = async (licenseId: string) => {
    setHistory(await adminLicenseHistory({ data: { token, licenseId } }));
  };

  const fmt = (d: string | null) =>
    !d ? "Lifetime" : new Date(d).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });

  /** Closing the panel always ends the admin session — re-verification is required. */
  const handleOpenChange = (v: boolean) => {
    if (!v) {
      if (token) void adminEndSession({ data: { token } }).catch(() => {});
      setStep("code");
      setAdminCode("");
      setLoginEmail(ORIGINAL_ADMIN_EMAIL);
      setVerifyCode("");
      setToken("");
      setSentTo(undefined);
      setCodeSentAt(null);
      setRows([]);
      setHistory(null);
      setBusy(false);
    }
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] w-[96vw] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" /> License management
          </DialogTitle>
          <DialogDescription>
            {step === "code" && "Enter the admin panel code to continue."}
            {step === "email" && "Enter the email that should receive the verification code."}
            {step === "verify" &&
              (sentTo
                ? `Enter the 6-digit code sent to ${sentTo}.`
                : "Enter the verification code sent to the admin email.")}
            {step === "panel" && "Generate, activate, suspend, reset and revoke customer licenses."}
          </DialogDescription>
        </DialogHeader>

        {step === "code" && (
          <div className="space-y-3">
            <Label htmlFor="admin-code">Admin panel code</Label>
            <Input
              id="admin-code"
              type="password"
              value={adminCode}
              onChange={(e) => setAdminCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitCode()}
              placeholder="••••"
            />
            <Button className="w-full" onClick={submitCode} disabled={busy}>
              Continue
            </Button>
          </div>
        )}

        {step === "email" && (
          <div className="space-y-3">
            <Label htmlFor="login-email">Send the verification code to</Label>
            <Input
              id="login-email"
              type="email"
              autoFocus
              value={loginEmail}
              onChange={(e) => setLoginEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitEmail()}
              placeholder={ORIGINAL_ADMIN_EMAIL}
            />
            <p className="text-[11px] text-muted-foreground">
              Only emails with a saved Resend API key can receive codes. If yours isn't saved yet, use{" "}
              <span className="font-medium">{ORIGINAL_ADMIN_EMAIL}</span> and add the key from the admin panel.
            </p>
            <Button className="w-full" onClick={submitEmail} disabled={busy || !loginEmail}>
              {busy ? "Sending…" : "Send verification code"}
            </Button>
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setStep("code")}>
              Back
            </Button>
          </div>
        )}


        {step === "verify" && (
          <div className="space-y-3">
            <Label htmlFor="verify-code">Email verification code</Label>
            <Input
              id="verify-code"
              inputMode="numeric"
              maxLength={6}
              autoFocus
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && submitVerify()}
              placeholder="123456"
            />
            <p className="text-xs text-muted-foreground">
              {remainingMs > 0
                ? `Code expires in ${mmss(remainingMs)}.`
                : "The emailed code has expired — request a new one."}
            </p>
            <Button className="w-full" onClick={submitVerify} disabled={busy}>
              Verify and enter
            </Button>
            <div className="flex items-center justify-between text-xs">
              <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setStep("code")}>
                Back
              </Button>
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={resendCode}
                disabled={busy || cooldownMs > 0}
              >
                {cooldownMs > 0 ? `Resend code in ${Math.ceil(cooldownMs / 1000)}s` : "Resend code"}
              </Button>
            </div>
          </div>
        )}

        {step === "panel" && (
          <div className="space-y-4">
            <AdminSettingsCard token={token} />
            <ResendKeysCard token={token} />
            <Card className="p-3">
              <div className="grid gap-2 sm:grid-cols-[1fr_150px_110px_auto]">
                <Input
                  placeholder="Customer name (optional)"
                  value={customer}
                  onChange={(e) => setCustomer(e.target.value)}
                />
                <Select value={plan} onValueChange={setPlan}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Monthly ($10)</SelectItem>
                    <SelectItem value="custom">Custom days</SelectItem>
                    <SelectItem value="lifetime">Lifetime</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  disabled={plan === "lifetime"}
                />
                <Button onClick={generate} disabled={busy}>
                  <Plus className="mr-2 h-4 w-4" /> Generate license
                </Button>
              </div>
            </Card>

            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[820px] text-left text-xs">
                <thead className="bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="p-2 font-semibold">Customer</th>
                    <th className="p-2 font-semibold">License</th>
                    <th className="p-2 font-semibold">Device</th>
                    <th className="p-2 font-semibold">Status</th>
                    <th className="p-2 font-semibold">Expiry</th>
                    <th className="p-2 font-semibold">Activations</th>
                    <th className="p-2 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-6 text-center text-muted-foreground">
                        No licenses yet — generate the first one above.
                      </td>
                    </tr>
                  )}
                  {rows.map((l) => (
                    <tr key={l.id} className="border-t border-border align-top">
                      <td className="p-2 font-medium">{l.customer_label}</td>
                      <td className="p-2">
                        <button
                          className="font-mono hover:underline"
                          onClick={() => {
                            navigator.clipboard.writeText(l.code).catch(() => {});
                            toast.success("License copied");
                          }}
                        >
                          {l.code} <Copy className="inline h-3 w-3" />
                        </button>
                      </td>
                      <td className="p-2">
                        {l.devices.length === 0 ? (
                          <span className="text-muted-foreground">Not bound</span>
                        ) : (
                          l.devices.map((d) => (
                            <div key={d.id}>
                              <div>{d.device_name || "Device"}</div>
                              <div className="font-mono text-[10px] text-muted-foreground">
                                {d.device_hash.slice(0, 12)}…
                              </div>
                            </div>
                          ))
                        )}
                      </td>
                      <td className="p-2">
                        <span className="flex items-center gap-2">
                          <span
                            className={cn(
                              "inline-block h-2 w-2 rounded-full",
                              l.online ? "animate-pulse bg-emerald-500 shadow-[0_0_8px] shadow-emerald-500" : "bg-muted-foreground/40",
                            )}
                          />
                          <span className="capitalize">{l.status}</span>
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {l.online ? "Online now" : "Offline"}
                        </span>
                      </td>
                      <td className="p-2">{fmt(l.expires_at)}</td>
                      <td className="p-2">
                        {l.devices.length} / {l.max_activations <= 0 ? "∞" : l.max_activations}
                      </td>
                      <td className="p-2">
                        <div className="flex flex-wrap gap-1">
                          <Button size="sm" variant="outline" onClick={() => act(l.id, "activate")}>
                            Activate
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => act(l.id, "deactivate")}>
                            Deactivate
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => act(l.id, "reset_device")}>
                            <RefreshCw className="mr-1 h-3 w-3" /> Reset device
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => act(l.id, l.status === "suspended" ? "unsuspend" : "suspend")}
                          >
                            <Ban className="mr-1 h-3 w-3" />
                            {l.status === "suspended" ? "Unsuspend" : "Suspend"}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => act(l.id, "extend", 30)}>
                            +30 days
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => showHistory(l.id)}>
                            <History className="mr-1 h-3 w-3" /> History
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => act(l.id, "revoke")}>
                            Revoke
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => act(l.id, "delete")}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {history && (
              <Card className="p-3">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Activation & login history</h3>
                  <Button size="sm" variant="ghost" onClick={() => setHistory(null)}>
                    Close
                  </Button>
                </div>
                <Separator className="mb-2" />
                <div className="max-h-56 space-y-1 overflow-y-auto text-xs">
                  {history.length === 0 && <p className="text-muted-foreground">No events yet.</p>}
                  {history.map((h) => (
                    <div key={h.id} className="flex gap-2">
                      <span className="text-muted-foreground">
                        {new Date(h.created_at).toLocaleString()}
                      </span>
                      <span className="font-medium capitalize">{h.event.replace(/_/g, " ")}</span>
                      <span className="text-muted-foreground">{h.detail}</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
