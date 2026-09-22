const DEVICE_ID_KEY = "pluto:device-id";

export const WHATSAPP_NUMBER = "254713206306";

export function whatsappLink(message: string) {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

export function openWhatsApp(message: string) {
  window.open(whatsappLink(message), "_blank", "noopener,noreferrer");
}

function localId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Browsers cannot read a MAC address, so a device is identified by a stable
 * hardware/browser fingerprint combined with a persistent per-device id.
 */
export async function getDeviceHash() {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const parts = [
    localId(),
    navigator.userAgent,
    navigator.language,
    String(navigator.hardwareConcurrency ?? 0),
    String(nav.deviceMemory ?? 0),
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  return sha256(parts.join("|"));
}

export function getDeviceName() {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/i.test(ua)
      ? "iOS"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Mac OS/i.test(ua)
          ? "macOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "Unknown";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Safari\//.test(ua)
        ? "Safari"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : "Browser";
  return `${os} · ${browser}`;
}
