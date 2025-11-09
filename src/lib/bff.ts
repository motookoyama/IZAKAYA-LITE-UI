let cachedHealthUrl: string | null = null;
let cachedHealthBase: string | null = null;

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const DEFAULT_PROD_BASE = "https://izakaya-bff-95139013565.asia-northeast1.run.app";
const DEFAULT_DEV_BASE = "http://localhost:4117";

export function resolveBffBase(): string {
  const candidates = [
    import.meta.env.VITE_REACT_APP_BFF_URL,
    import.meta.env.VITE_BFF_URL,
    import.meta.env.REACT_APP_BFF_URL,
  ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);

  if (candidates.length > 0) {
    return trimTrailingSlash(candidates[0]);
  }

  if (typeof window !== "undefined" && window.location) {
    const origin = window.location.origin.replace(/\/+$/, "");
    if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
      return DEFAULT_DEV_BASE;
    }
  }
  return DEFAULT_PROD_BASE;
}

export function clearCachedHealthUrl(): void {
  cachedHealthUrl = null;
  cachedHealthBase = null;
}

export async function getHealthUrl(baseOverride?: string): Promise<string> {
  const base = trimTrailingSlash(baseOverride ?? resolveBffBase());
  if (cachedHealthUrl && cachedHealthBase === base) {
    return cachedHealthUrl;
  }

  const adminInfoUrl = `${base}/admin/info`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(adminInfoUrl, { signal: controller.signal, cache: "no-store" });
    clearTimeout(timeout);
    if (response.ok) {
      const info = await response.json().catch(() => ({}));
      if (info && typeof info.health_url === "string" && info.health_url.trim()) {
        cachedHealthBase = base;
        cachedHealthUrl = `${base}${info.health_url}`;
        return cachedHealthUrl;
      }
    }
  } catch {
    // ignore failures and fall back
  }

  cachedHealthBase = base;
  cachedHealthUrl = `${base}/health/ping`;
  return cachedHealthUrl;
}
