let cachedHealthUrl: string | null = null;
let cachedHealthBase: string | null = null;

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export function resolveBffBase(): string {
  const candidates = [
    typeof import.meta.env.VITE_REACT_APP_BFF_URL === "string" ? import.meta.env.VITE_REACT_APP_BFF_URL : undefined,
    typeof import.meta.env.VITE_BFF_URL === "string" ? import.meta.env.VITE_BFF_URL : undefined,
    typeof import.meta.env.REACT_APP_BFF_URL === "string" ? import.meta.env.REACT_APP_BFF_URL : undefined,
  ];
  const resolved = candidates.find((entry) => entry && entry.trim().length > 0);
  if (resolved) {
    return trimTrailingSlash(resolved.trim());
  }
  return "http://localhost:4117";
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
