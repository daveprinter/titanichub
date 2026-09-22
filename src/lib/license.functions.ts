import { createServerFn } from "@tanstack/react-start";

export type LicenseCheck = {
  ok: boolean;
  reason?: "not_found" | "revoked" | "suspended" | "inactive" | "expired" | "device_mismatch";
  message?: string;
  license?: {
    code: string;
    customer_label: string;
    plan: string;
    status: string;
    expires_at: string | null;
  };
};

type Input = { code: string; deviceHash: string; deviceName?: string };

const validate = (input: unknown): Input => {
  const v = input as Input;
  if (!v || typeof v.code !== "string" || typeof v.deviceHash !== "string") {
    throw new Error("Invalid request");
  }
  return {
    code: v.code.trim().toUpperCase(),
    deviceHash: v.deviceHash.trim().slice(0, 128),
    deviceName: (v.deviceName ?? "").slice(0, 200),
  };
};

/** Activates a license on the current device (binds it) or validates an existing binding. */
export const activateLicense = createServerFn({ method: "POST" })
  .inputValidator(validate)
  .handler(async ({ data }): Promise<LicenseCheck> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: license } = await supabaseAdmin
      .from("licenses")
      .select("*")
      .eq("code", data.code)
      .maybeSingle();

    const log = async (event: string, detail: string) => {
      await supabaseAdmin.from("license_events").insert({
        license_id: license?.id ?? null,
        license_code: data.code,
        device_hash: data.deviceHash,
        event,
        detail,
      });
    };

    if (!license) {
      await log("activation_failed", "License key not found");
      return { ok: false, reason: "not_found", message: "This license key does not exist." };
    }
    if (license.status === "revoked") {
      await log("activation_failed", "License revoked");
      return { ok: false, reason: "revoked", message: "This license key has been revoked. Please contact the developer." };
    }
    if (license.status === "suspended") {
      await log("activation_failed", "License suspended");
      return { ok: false, reason: "suspended", message: "This license key is suspended. Please contact the developer." };
    }
    if (license.status !== "active") {
      await log("activation_failed", "License inactive");
      return { ok: false, reason: "inactive", message: "This license key is not active. Please contact the developer." };
    }
    if (license.expires_at && new Date(license.expires_at).getTime() < Date.now()) {
      await log("activation_failed", "License expired");
      return { ok: false, reason: "expired", message: "This license key has expired. Please renew to continue." };
    }

    const { data: devices } = await supabaseAdmin
      .from("license_devices")
      .select("*")
      .eq("license_id", license.id);

    const existing = (devices ?? []).find((d) => d.device_hash === data.deviceHash);

    const unlimited = license.max_activations <= 0;

    if (!existing) {
      if (!unlimited && (devices ?? []).length >= license.max_activations) {
        await log("device_blocked", "Another device is already registered");
        return {
          ok: false,
          reason: "device_mismatch",
          message: "This device is not registered with this license key. Please contact the developer.",
        };
      }
      await supabaseAdmin.from("license_devices").insert({
        license_id: license.id,
        device_hash: data.deviceHash,
        device_name: data.deviceName ?? "",
      });
      await log("activated", "Device registered");
    } else {
      await supabaseAdmin
        .from("license_devices")
        .update({ last_seen_at: new Date().toISOString(), device_name: data.deviceName ?? existing.device_name })
        .eq("id", existing.id);
      await log("login", "Device verified");
    }

    return {
      ok: true,
      license: {
        code: license.code,
        customer_label: license.customer_label,
        plan: license.plan,
        status: license.status,
        expires_at: license.expires_at,
      },
    };
  });

/** Lightweight heartbeat so the admin panel can show who is online right now. */
export const licenseHeartbeat = createServerFn({ method: "POST" })
  .inputValidator(validate)
  .handler(async ({ data }): Promise<LicenseCheck> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: license } = await supabaseAdmin
      .from("licenses")
      .select("*")
      .eq("code", data.code)
      .maybeSingle();

    if (!license) return { ok: false, reason: "not_found", message: "This license key does not exist." };
    if (license.status === "revoked")
      return { ok: false, reason: "revoked", message: "This license key has been revoked. Please contact the developer." };
    if (license.status === "suspended")
      return { ok: false, reason: "suspended", message: "This license key is suspended. Please contact the developer." };
    if (license.status !== "active")
      return { ok: false, reason: "inactive", message: "This license key is not active. Please contact the developer." };
    if (license.expires_at && new Date(license.expires_at).getTime() < Date.now())
      return { ok: false, reason: "expired", message: "This license key has expired. Please renew to continue." };

    const { data: device } = await supabaseAdmin
      .from("license_devices")
      .select("id")
      .eq("license_id", license.id)
      .eq("device_hash", data.deviceHash)
      .maybeSingle();

    if (!device) {
      if (license.max_activations <= 0) {
        // Universal license: any device is allowed until the key is revoked.
        await supabaseAdmin.from("license_devices").insert({
          license_id: license.id,
          device_hash: data.deviceHash,
          device_name: data.deviceName ?? "",
        });
      } else {
        return {
          ok: false,
          reason: "device_mismatch",
          message: "This device is not registered with this license key. Please contact the developer.",
        };
      }
    } else {
      await supabaseAdmin
        .from("license_devices")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", device.id);
    }

    return {
      ok: true,
      license: {
        code: license.code,
        customer_label: license.customer_label,
        plan: license.plan,
        status: license.status,
        expires_at: license.expires_at,
      },
    };
  });
