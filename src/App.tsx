import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AdminBillingPanel from "./components/AdminBillingPanel";
import drOrbAvatar from "./assets/dr-orb.png";
import missMadiAvatar from "./assets/miss-madi.png";
import { clearCachedHealthUrl, getHealthUrl, resolveBffBase } from "./lib/bff";

type Role = "user" | "ai";

type V2CardPersona = {
  personality?: string;
  tone?: string;
  npc_role?: string;
  likes?: string;
  dislikes?: string;
  background?: string;
  appearance?: string;
  quirks?: string;
  [key: string]: unknown;
};

type V2SystemBehavior = {
  is_guide?: boolean;
  allowed_to_break_fourth_wall?: boolean;
  friendliness?: number;
  chaos?: number;
  [key: string]: unknown;
};

type V2CardMetadata = {
  id?: string;
  name?: string;
  persona?: V2CardPersona;
  system_behavior?: V2SystemBehavior;
  [key: string]: unknown;
};

type CardRecord = {
  id: string;
  name: string;
  system?: string;
  avatar?: string;
  kind?: "featured" | "api" | "custom";
  metadata?: V2CardMetadata | null;
};

type Message = {
  role: Role;
  text: string;
  cardId?: string;
  cardName?: string;
};

type ProviderConfig = {
  provider: string;
  model?: string;
  endpoint?: string;
  hasApiKey?: boolean;
  updatedAt?: string;
  source?: string;
};

type ProviderOption = { label: string; value: string };

type PasswordForm = {
  current: string;
  next: string;
  confirm: string;
};

type HealthStatus = {
  status: string;
  service: string;
  provider: string;
  cards: number;
  hostname?: string;
};

type ConnectionFailure = { url: string; detail: string };

type ConnectionStatus =
  | { state: "connecting"; attempt: number }
  | { state: "ok"; url: string; reply: string }
  | { state: "error"; attempt: number; failures: ConnectionFailure[] };

type EndpointCheck = {
  endpoint: string;
  url: string;
  ok: boolean;
  detail?: string;
};

type HeartbeatDebugInfo = {
  endpoint: string;
  lastResponse?: {
    endpoint: string;
    status: number;
    body: unknown;
  };
};

type WalletDiagnosticResult = {
  ok: boolean;
  userId: string;
  amount: number;
  transactionId: string;
  initialBalance: number;
  grantBalance: number;
  finalBalance: number;
  delta: number;
  reverted: boolean;
  ipnLogNote?: string;
  ipnLogHasErrors?: boolean;
  timestamp?: string;
};

type GeneratedScenario = {
  id: string;
  title: string;
  summary: string;
  prompt: string;
  cardId: string;
  cardName: string;
  persona?: V2CardMetadata | null;
  createdAt: string;
};

const normalizeBase = (value: string) => value.replace(/\/+$/, "");

const BFF_BASE_URL = resolveBffBase();
const BFF_CANDIDATES = [BFF_BASE_URL];

let resolvedBffBase = normalizeBase(BFF_BASE_URL);

const getResolvedBffBase = () => resolvedBffBase;
const setResolvedBffBase = (value: string) => {
  resolvedBffBase = normalizeBase(value);
};

const HEALTHCHECK_UID = "IZK_HEALTHCHECK_UI";
const HEALTHCHECK_PROMPT = "[health-check] BFF connectivity verification";
const MAX_CONNECTION_ATTEMPTS = 3;
const CONNECTION_RETRY_DELAY_MS = 1000;
const RECONNECT_DELAY_MS = 4000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const TEXT_DECODER_LATIN1 = new TextDecoder("latin1");
const TEXT_DECODER_UTF8 = new TextDecoder("utf-8");
const V2_TEXT_KEYWORDS = [
  "chara",
  "chara_card",
  "chara_card_v2",
  "chara_card_v3",
  "json",
  "ai_character",
  "persona",
  "character",
  "v2card",
  "izk_v2_card",
];

function parseLooseJson<T = Record<string, unknown>>(input: string): T | null {
  if (!input) return null;
  try {
    return JSON.parse(input) as T;
  } catch {
    const start = input.indexOf("{");
    const end = input.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const candidate = input.slice(start, end + 1);
      try {
        return JSON.parse(candidate) as T;
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function inflateBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
  const hasDecompressionStream =
    typeof window !== "undefined" && "DecompressionStream" in window;
  if (hasDecompressionStream) {
    try {
      const stream = new Blob([bytes])
        .stream()
        .pipeThrough(new (window as any).DecompressionStream("deflate"));
      const buffer = await new Response(stream).arrayBuffer();
      return new Uint8Array(buffer);
    } catch {
      // ignore and try fallback
    }
  }
  try {
    const module = await import("pako");
    const inflate = module?.inflate;
    if (typeof inflate === "function") {
      const result = inflate(bytes);
      return result instanceof Uint8Array ? result : new Uint8Array(result);
    }
  } catch {
    // ignore
  }
  return null;
}

async function extractV2CardMetadataFromPng(file: File): Promise<V2CardMetadata | null> {
  try {
    const buffer = new Uint8Array(await file.arrayBuffer());
    for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
      if (buffer[i] !== PNG_SIGNATURE[i]) {
        throw new Error("NOT_PNG");
      }
    }
    const texts: Array<{ keyword: string; text: string; bytes: Uint8Array }> = [];
    let offset = 8;
    while (offset + 8 <= buffer.length) {
      const length =
        (buffer[offset] << 24) |
        (buffer[offset + 1] << 16) |
        (buffer[offset + 2] << 8) |
        buffer[offset + 3];
      offset += 4;
      const type = String.fromCharCode(
        buffer[offset],
        buffer[offset + 1],
        buffer[offset + 2],
        buffer[offset + 3],
      );
      offset += 4;
      if (offset + length > buffer.length) break;
      const data = buffer.slice(offset, offset + length);
      offset += length;
      offset += 4; // skip CRC
      if (type === "tEXt") {
        let idx = 0;
        while (idx < data.length && data[idx] !== 0) idx += 1;
        const keyword = TEXT_DECODER_LATIN1.decode(data.slice(0, idx));
        const textBytes = data.slice(idx + 1);
        texts.push({
          keyword,
          text: TEXT_DECODER_LATIN1.decode(textBytes),
          bytes: textBytes,
        });
      } else if (type === "iTXt") {
        let idx = 0;
        while (idx < data.length && data[idx] !== 0) idx += 1;
        const keyword = TEXT_DECODER_LATIN1.decode(data.slice(0, idx));
        const compressionFlag = data[idx + 1];
        const compressionMethod = data[idx + 2];
        idx += 3;
        while (idx < data.length && data[idx] !== 0) idx += 1;
        idx += 1;
        while (idx < data.length && data[idx] !== 0) idx += 1;
        idx += 1;
        let textBytes = data.slice(idx);
        if (compressionFlag === 1 && compressionMethod === 0) {
          const inflated = await inflateBytes(textBytes);
          if (inflated) {
            texts.push({ keyword, text: TEXT_DECODER_UTF8.decode(inflated), bytes: inflated });
          }
        } else {
          texts.push({ keyword, text: TEXT_DECODER_UTF8.decode(textBytes), bytes: textBytes });
        }
      } else if (type === "zTXt") {
        let idx = 0;
        while (idx < data.length && data[idx] !== 0) idx += 1;
        const keyword = TEXT_DECODER_LATIN1.decode(data.slice(0, idx));
        idx += 1;
        const compressed = data.slice(idx);
        const inflated = await inflateBytes(compressed);
        if (inflated) {
          texts.push({ keyword, text: TEXT_DECODER_UTF8.decode(inflated), bytes: inflated });
        }
      } else if (type === "IEND") {
        break;
      }
    }
    const prioritized = texts.filter((entry) =>
      V2_TEXT_KEYWORDS.includes((entry.keyword || "").toLowerCase()),
    );
    const candidates = prioritized.length > 0 ? prioritized : texts;
    for (const entry of candidates.reverse()) {
      const { text, bytes } = entry;
      let parsed = parseLooseJson<V2CardMetadata>(text);
      if (!parsed && bytes) {
        try {
          parsed = parseLooseJson<V2CardMetadata>(TEXT_DECODER_UTF8.decode(bytes));
        } catch {
          // ignore
        }
      }
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    }
    return null;
  } catch {
    return null;
  }
}

const FEATURED_CARD_METADATA: Record<string, V2CardMetadata> = {
  "dr-orb": {
    id: "dr-orb",
    name: "Dr. Orb",
    persona: {
      personality: "穏やかで博識な研究者。ユーザーを安心させる包容力を持つ。",
      tone: "落ち着いた丁寧語。時折小さな冗談を混ぜて緊張を和らげる。",
      npc_role: "IZAKAYA verse のシステム案内役兼ドクター。新入りを柔らかく導く。",
      likes: "未知のテクノロジー、丁寧な質問、香り高い蒸留酒。",
      dislikes: "推測だけで断定すること、利用規約違反、無茶な実験。",
      background:
        "ホログラムの身体を持つオラクルAI博士。研究所で常にシステムの健康診断を行っている。",
      appearance: "青白い光でできた球体本体に、白衣風の光帯を纏った姿。",
      quirks: "考えがまとまると光が一瞬強くなる。難題の前では小声で『面白いですね』と呟く。",
    },
    system_behavior: {
      is_guide: true,
      allowed_to_break_fourth_wall: true,
      friendliness: 0.95,
      chaos: 0.2,
    },
  },
  "miss-madi": {
    id: "miss-madi",
    name: "Miss Madi",
    persona: {
      personality: "陽気で奔放。相手を巻き込んで楽しませる天性のエンターテイナー。",
      tone: "ハイテンションなタメ口混じり。語尾を跳ねさせたり英語を交える。",
      npc_role: "バーカウンターの看板娘兼ステージMC。盛り上げ役。",
      likes: "ライブ演出、新しい衣装、サプライズ、ノリの良い客。",
      dislikes: "シーンと静まり返った場、野暮なツッコミ、退屈。",
      background: "IZAKAYA verse のメインフロアで毎夜ショーを仕切る看板スター。観客を乗せるのが得意。",
      appearance: "ピンクとネイビーのドレスに煌めくアクセサリー。髪にはLEDの飾り。",
      quirks: "テンションが上がるとステージ照明を勝手に連動させる。笑い声が鈴のように響く。",
    },
    system_behavior: {
      is_guide: false,
      allowed_to_break_fourth_wall: false,
      friendliness: 0.88,
      chaos: 0.65,
    },
  },
};

const PAYPAL_PLANS = [
  {
    id: "jp-1000",
    region: "国内向け",
    label: "IZAKAYA 1000P",
    description: "IZAKAYAverseの利用ポイント1000Pを購入します",
    price: "¥1,000",
    currency: "JPY",
    url: "https://www.paypal.com/ncp/payment/SBPMPM8BFRQUW",
  },
  {
    id: "jp-5000",
    region: "国内向け",
    label: "IZAKAYA 5000P",
    description: "IZAKAYAverseの利用ポイント5000Pを購入します",
    price: "¥5,000",
    currency: "JPY",
    url: "https://www.paypal.com/ncp/payment/WWLCPFUX2K2VA",
  },
  {
    id: "us-1000",
    region: "海外向け",
    label: "IZAKAYA 1000P",
    description: "Purchase 1000 points for IZAKAYAverse",
    price: "$10",
    currency: "USD",
    url: "https://www.paypal.com/ncp/payment/HTHQFN7EADLPC",
  },
  {
    id: "us-5000",
    region: "海外向け",
    label: "IZAKAYA 5000P",
    description: "Purchase 5000 points for IZAKAYAverse",
    price: "$50",
    currency: "USD",
    url: "https://www.paypal.com/ncp/payment/PKBQ6WBAGHVUW",
  },
  {
    id: "support",
    region: "Support",
    label: "IZAKAYA Support / Motoo Koyama",
    description: "活動を支援するためのカンパ（ポイント付与なし）",
    price: "自由設定",
    currency: "",
    url: "https://www.paypal.com/ncp/payment/YP4SEMBEH3AHQ",
  },
];

const FEATURED_CARDS: CardRecord[] = [
  { id: "dr-orb", name: "Dr. Orb", avatar: drOrbAvatar, kind: "featured", metadata: FEATURED_CARD_METADATA["dr-orb"] },
  { id: "miss-madi", name: "Miss Madi", avatar: missMadiAvatar, kind: "featured", metadata: FEATURED_CARD_METADATA["miss-madi"] },
  { id: "placeholder", name: "V2Card.PNG", kind: "placeholder", metadata: null },
];

function buildRequestUrl(path: string, baseOverride?: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const base = baseOverride ? normalizeBase(baseOverride) : getResolvedBffBase();
  return `${base}${normalizedPath}`;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = buildRequestUrl(path);
  const res = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
  return res.json();
}

type DebugFetchResult = {
  status: number;
  ok: boolean;
  body: unknown;
  rawBody: string;
};

async function fetchWithDebug(url: string, init: RequestInit): Promise<DebugFetchResult> {
  const response = await fetch(url, init);
  const status = response.status;
  let rawBody = "";
  try {
    rawBody = await response.text();
  } catch {
    rawBody = "";
  }
  let body: unknown = rawBody;
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      // leave as text
    }
  } else {
    body = {};
  }
  return {
    status,
    ok: response.ok,
    body,
    rawBody,
  };
}

function asJsonObject<T = Record<string, any>>(value: unknown): T | null {
  if (value && typeof value === "object") {
    return value as T;
  }
  return null;
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const STATUS_COLOR: Record<string, string> = {
  ok: "text-emerald-500",
  warn: "text-amber-500",
  error: "text-rose-500",
};

type Theme = "light" | "dark";

type ThemeClasses = {
  page: string;
  panel: string;
  accent: string;
  btnPrimary: string;
  header: string;
  title: string;
  bubbleUser: string;
  bubbleAi: string;
  badge: string;
  cardChipSelected: string;
  cardChip: string;
  cardSelected: string;
  card: string;
  textSubtle: string;
  dockLabel: string;
};

const THEME_MAP: Record<Theme, ThemeClasses> = {
  light: {
    page: "bg-[#f7f5ff]",
    panel: "bg-white border border-zinc-200",
    accent: "from-rose-500 to-pink-500",
    btnPrimary: "bg-rose-600 hover:bg-rose-700",
    header: "bg-white/90",
    title: "text-4xl font-extrabold tracking-tight text-[#152053]",
    bubbleUser: "bg-[#1d1d2f] text-white",
    bubbleAi: "bg-white border border-[#ffe5ef]",
    badge: "bg-rose-100 text-rose-600",
    cardChipSelected: "border-rose-600 text-rose-700 bg-rose-50",
    cardChip: "border-zinc-300 bg-white text-zinc-600",
    cardSelected: "border-rose-600 ring-2 ring-rose-200",
    card: "border-zinc-200 hover:border-zinc-300 bg-white",
    textSubtle: "text-zinc-500",
    dockLabel: "text-zinc-600",
  },
  dark: {
    page: "bg-[#090910]",
    panel: "bg-[#111118] border border-zinc-800",
    accent: "from-purple-500 to-rose-500",
    btnPrimary: "bg-purple-600 hover:bg-purple-700",
    header: "bg-[#090910]/85",
    title: "text-4xl font-extrabold tracking-tight text-zinc-100",
    bubbleUser: "bg-[#202046] text-white",
    bubbleAi: "bg-[#161627] border border-[#2c2d52] text-zinc-100",
    badge: "bg-purple-900/40 text-purple-300",
    cardChipSelected: "border-purple-400 text-purple-300 bg-purple-900/30",
    cardChip: "border-zinc-700 bg-[#161616] text-zinc-300",
    cardSelected: "border-purple-400 ring-2 ring-purple-700/40",
    card: "border-zinc-700 hover:border-zinc-500 bg-[#13131e]",
    textSubtle: "text-zinc-400",
    dockLabel: "text-zinc-400",
  },
};

const PROVIDER_OPTIONS: ProviderOption[] = [
  { label: "Gemini", value: "GEMINI" },
  { label: "OpenAI", value: "OPENAI" },
  { label: "Ollama", value: "OLLAMA" },
  { label: "Custom Provider", value: "CUSTOM" },
];

const ADMIN_STORAGE_KEY = "IZK_ADMIN_MODE";
const HealthBadge: React.FC<{ health?: HealthStatus; loading: boolean; error?: string }> = ({
  health,
  loading,
  error,
}) => {
  if (loading) return <span className="text-xs text-zinc-400">checking…</span>;
  if (error) {
    return <span className="text-xs text-rose-500">offline</span>;
  }
  if (!health) return null;
  return (
    <span className={`text-xs ${STATUS_COLOR[health.status] ?? "text-emerald-500"}`}>
      {health.status} <span className="text-zinc-500">• {health.provider}</span>
    </span>
  );
};

const ConnectionStatusPill: React.FC<{ status: ConnectionStatus }> = ({ status }) => {
  if (status.state === "connecting") {
    const attemptLabel = status.attempt > 0 ? `（試行${status.attempt}回目）` : "";
    return <span className="text-xs text-amber-500">⏳ BFF接続中…{attemptLabel}</span>;
  }
  if (status.state === "ok") {
    return (
      <span className="text-xs text-emerald-500">
        ✅ BFF接続成功 • <span className="text-emerald-600">{status.url}</span>
      </span>
    );
  }
  const recentFailure =
    status.failures.length > 0 ? status.failures[status.failures.length - 1] : undefined;
  return (
    <span className="text-xs text-rose-500">
      ❌ BFFに接続できません（自動再試行中）
      {recentFailure ? (
        <>
          {" "}
          • {recentFailure.url} ({recentFailure.detail})
        </>
      ) : null}
    </span>
  );
};

const HealthCheckIndicator: React.FC<{ checks: EndpointCheck[] }> = ({ checks }) => {
  if (checks.length === 0) return null;
  const failures = checks.filter((check) => !check.ok);
  if (failures.length === 0) {
    return <span className="text-xs text-emerald-500">✅ ヘルスチェック全通過</span>;
  }
  return (
    <span className="text-xs text-rose-500">
      ⚠️ ヘルス異常: {failures.map((item) => item.endpoint).join(", ")}
    </span>
  );
};

const HeaderIcon: React.FC = () => (
  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 via-indigo-500 to-rose-400 text-xl font-bold text-white shadow-lg">
    IZ
  </div>
);

const ChatAvatar: React.FC<{ url?: string; label: string; role: Role }> = ({ url, label, role }) => {
  if (url) {
    return <img src={url} alt={label} className="h-10 w-10 rounded-2xl border border-white/20 object-cover shadow" />;
  }
  if (role === "user") {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-dashed border-zinc-500 bg-transparent text-lg text-zinc-500 shadow">
        ◯
      </div>
    );
  }
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-dashed border-zinc-500 bg-transparent text-xs font-semibold uppercase text-zinc-500">
      NPC
    </div>
  );
};

const CardChip: React.FC<{ name: string; selected?: boolean; themeClasses: ThemeClasses }> = ({
  name,
  selected,
  themeClasses,
}) => (
  <span
    className={[
      "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs",
      selected ? themeClasses.cardChipSelected : themeClasses.cardChip,
    ].join(" ")}
  >
    <span className="h-3 w-3 rounded-sm bg-gradient-to-br from-zinc-300 to-zinc-500" />
    {name}
  </span>
);

type AdminPanelProps = {
  providerOptions: ProviderOption[];
  providerForm: { provider: string; model: string };
  onProviderChange: (field: "provider" | "model", value: string) => void;
  onSaveProvider: () => void;
  apiKeyInput: string;
  onApiKeyChange: (value: string) => void;
  onSaveApiKey: () => void;
  onClearApiKey: () => void;
  notice: string | null;
  error: string | null;
  loading: boolean;
  passwordForm: PasswordForm;
  onPasswordChange: (field: keyof PasswordForm, value: string) => void;
  onSavePassword: () => void;
  providerConfig: ProviderConfig | null;
  healthChecks: EndpointCheck[];
  onRetryHealthChecks: () => void;
  healthChecksRunning: boolean;
  heartbeatDebug: HeartbeatDebugInfo | null;
  walletDiagnosticResult: WalletDiagnosticResult | null;
  walletDiagnosticError: string | null;
  walletDiagnosticRunning: boolean;
  walletDiagnosticUserId: string;
  walletDiagnosticAmount: number;
  walletDiagnosticRevert: boolean;
  onWalletDiagnosticUserIdChange: (value: string) => void;
  onWalletDiagnosticAmountChange: (value: number) => void;
  onWalletDiagnosticRevertChange: (value: boolean) => void;
  onRunWalletDiagnostic: () => void;
};

const AdminPanel: React.FC<AdminPanelProps> = ({
  providerOptions,
  providerForm,
  onProviderChange,
  onSaveProvider,
  apiKeyInput,
  onApiKeyChange,
  onSaveApiKey,
  onClearApiKey,
  notice,
  error,
  loading,
  passwordForm,
  onPasswordChange,
  onSavePassword,
  providerConfig,
  healthChecks,
  onRetryHealthChecks,
  healthChecksRunning,
  heartbeatDebug,
  walletDiagnosticResult,
  walletDiagnosticError,
  walletDiagnosticRunning,
  walletDiagnosticUserId,
  walletDiagnosticAmount,
  walletDiagnosticRevert,
  onWalletDiagnosticUserIdChange,
  onWalletDiagnosticAmountChange,
  onWalletDiagnosticRevertChange,
  onRunWalletDiagnostic,
}) => {
  const passwordMismatch = passwordForm.next !== passwordForm.confirm;
  const passwordTooShort =
    passwordForm.next.trim().length > 0 && passwordForm.next.trim().length < 6;
  const passwordDisabled =
    loading ||
    !passwordForm.current.trim() ||
    !passwordForm.next.trim() ||
    passwordMismatch ||
    passwordTooShort;
  const hasHealthFailures = healthChecks.some((check) => !check.ok);

  return (
    <section
      id="admin"
      className="rounded-3xl border border-zinc-200/60 bg-white px-6 py-6 shadow-lg dark:border-zinc-700/50 dark:bg-[#111118]"
    >
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-zinc-800 dark:text-zinc-100">管理タブ</h2>
        {providerConfig?.updatedAt && (
          <span className="text-xs text-zinc-500">
            最終更新: {new Date(providerConfig.updatedAt).toLocaleString()}
          </span>
        )}
      </div>
      {error && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-600 dark:border-rose-500/40 dark:bg-rose-900/30 dark:text-rose-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-600 dark:border-emerald-500/40 dark:bg-emerald-900/30 dark:text-emerald-200">
          {notice}
        </div>
      )}
      {healthChecks.length > 0 && (
        <div
          className={[
            "mb-4 rounded-lg px-4 py-3 text-sm",
            hasHealthFailures
              ? "border border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-500/40 dark:bg-rose-900/30 dark:text-rose-200"
              : "border border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-500/40 dark:bg-emerald-900/20 dark:text-emerald-200",
          ].join(" ")}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium">BFFヘルスチェック</div>
            <button
              onClick={onRetryHealthChecks}
              type="button"
              disabled={healthChecksRunning}
              className="rounded-md border border-current px-2 py-1 text-xs font-semibold hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {healthChecksRunning ? "検証中…" : "再検証"}
            </button>
          </div>
          <ul className="mt-2 space-y-1">
            {healthChecks.map((check) => (
              <li key={check.endpoint} className="flex flex-col text-xs leading-relaxed">
                <span className="font-semibold">
                  {check.ok ? "✅" : "❌"} {check.endpoint}
                </span>
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  {check.url}
                  {!check.ok && check.detail ? ` — ${check.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {heartbeatDebug && (
        <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 dark:border-slate-600/60 dark:bg-slate-900/40 dark:text-slate-200">
          <div className="font-medium">HeartBeat Debug (Admin only)</div>
          <div className="mt-2 space-y-2 text-xs">
            <div className="break-all"><span className="font-semibold">BFF Endpoint:</span> {heartbeatDebug.endpoint}</div>
            {heartbeatDebug.lastResponse ? (
              <div className="space-y-1">
                <div className="font-semibold">Last Response</div>
                <div className="break-all text-[11px] text-slate-500 dark:text-slate-400">
                  {heartbeatDebug.lastResponse.endpoint}
                </div>
                <div>status: {heartbeatDebug.lastResponse.status}</div>
                <details className="rounded bg-black/5 p-2 dark:bg-white/10">
                  <summary className="cursor-pointer text-[11px] font-semibold">show body</summary>
                  <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-[11px] font-mono">
{JSON.stringify(heartbeatDebug.lastResponse.body, null, 2)}
                  </pre>
                </details>
              </div>
            ) : (
              <div className="text-[11px] text-slate-500 dark:text-slate-400">レスポンス情報はまだ取得されていません。</div>
            )}
          </div>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSaveProvider();
          }}
        className="rounded-2xl border border-zinc-200/60 bg-white p-5 shadow-sm dark:border-zinc-700/40 dark:bg-[#0f0f19]"
      >
        <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-100">プロバイダ設定</h3>
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          プロバイダ
        </label>
        <select
          value={providerForm.provider}
          onChange={(event) => onProviderChange("provider", event.target.value)}
          className="mb-4 w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-rose-300 focus:outline-none focus:ring-2 focus:ring-rose-200 dark:border-zinc-700 dark:bg-[#141425] dark:text-zinc-100 dark:focus:border-purple-500 dark:focus:ring-purple-500/40"
        >
          {providerOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          モデル名
        </label>
        <input
          type="text"
          value={providerForm.model}
          onChange={(event) => onProviderChange("model", event.target.value)}
          placeholder="例: gemini-pro / gpt-4o-mini / llama3"
          className="mb-4 w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-rose-300 focus:outline-none focus:ring-2 focus:ring-rose-200 dark:border-zinc-700 dark:bg-[#141425] dark:text-zinc-100 dark:focus:border-purple-500 dark:focus:ring-purple-500/40"
        />
        <button
          type="submit"
          disabled={loading}
          className="inline-flex items-center justify-center rounded-xl bg-rose-500 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-rose-600 disabled:opacity-60 dark:bg-purple-600 dark:hover:bg-purple-500"
        >
          {loading ? "保存中…" : "保存"}
        </button>
      </form>

      <div className="rounded-2xl border border-zinc-200/60 bg-white p-5 shadow-sm dark:border-zinc-700/40 dark:bg-[#0f0f19]">
        <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-100">ウォレット動作チェック</h3>
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
          BFF 経由で `GET /wallet/balance → POST /wallet/grant → (optional) revert` を実施し、台帳の読み書きと PayPal IPN ログを検査します。問題が見つかった場合はエラーが表示されます。
        </p>
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          対象ユーザーID
        </label>
        <input
          type="text"
          value={walletDiagnosticUserId}
          onChange={(event) => onWalletDiagnosticUserIdChange(event.target.value)}
          placeholder="例: preview-ui"
          className="mb-4 w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-rose-300 focus:outline-none focus:ring-2 focus:ring-rose-200 dark:border-zinc-700 dark:bg-[#141425] dark:text-zinc-100 dark:focus:border-purple-500 dark:focus:ring-purple-500/40"
        />
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          付与ポイント
        </label>
        <input
          type="number"
          min={1}
          value={walletDiagnosticAmount}
          onChange={(event) => {
            const value = Number(event.target.value);
            const sanitized = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
            onWalletDiagnosticAmountChange(sanitized);
          }}
          className="mb-4 w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-rose-300 focus:outline-none focus:ring-2 focus:ring-rose-200 dark:border-zinc-700 dark:bg-[#141425] dark:text-zinc-100 dark:focus:border-purple-500 dark:focus:ring-purple-500/40"
        />
        <label className="mb-4 flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
          <input
            type="checkbox"
            checked={walletDiagnosticRevert}
            onChange={(event) => onWalletDiagnosticRevertChange(event.target.checked)}
            className="rounded border-zinc-400 text-emerald-500 focus:ring-emerald-400"
          />
          診断後に付与ポイントを元に戻す
        </label>
        <button
          type="button"
          onClick={onRunWalletDiagnostic}
          disabled={walletDiagnosticRunning || !walletDiagnosticUserId.trim()}
          className="inline-flex w-full items-center justify-center rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-emerald-600 dark:hover:bg-emerald-500"
        >
          {walletDiagnosticRunning ? "診断中…" : "ウォレット動作チェックを実行"}
        </button>
        {walletDiagnosticError && (
          <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:border-rose-500/40 dark:bg-rose-900/30 dark:text-rose-200">
            ❌ {walletDiagnosticError}
          </div>
        )}
        {walletDiagnosticResult && (
          <div className="mt-3 space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-xs text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-900/30 dark:text-emerald-200">
            <div className="text-sm font-semibold">✅ ウォレット稼働確認済み</div>
            <ul className="space-y-1 font-mono text-[11px]">
              <li>user: {walletDiagnosticResult.userId}</li>
              <li>transaction: {walletDiagnosticResult.transactionId}</li>
              <li>
                balance: {walletDiagnosticResult.initialBalance} → {walletDiagnosticResult.grantBalance} → {walletDiagnosticResult.finalBalance}
              </li>
              <li>
                reverted: {walletDiagnosticResult.reverted ? "yes" : "no"} / delta: {walletDiagnosticResult.delta}
              </li>
            </ul>
            {walletDiagnosticResult.ipnLogNote && (
              <div className="text-[11px] text-emerald-700 dark:text-emerald-200">
                {walletDiagnosticResult.ipnLogHasErrors ? "⚠️ " : "ℹ️ "}
                {walletDiagnosticResult.ipnLogNote}
              </div>
            )}
            {walletDiagnosticResult.timestamp && (
              <div className="text-[10px] text-emerald-600/80 dark:text-emerald-300/80">
                {new Date(walletDiagnosticResult.timestamp).toLocaleString()}
              </div>
            )}
          </div>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSaveApiKey();
        }}
        className="rounded-2xl border border-zinc-200/60 bg-white p-5 shadow-sm dark:border-zinc-700/40 dark:bg-[#0f0f19]"
      >
        <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-100">APIキー設定</h3>
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          APIキー
        </label>
        <input
          type="password"
          value={apiKeyInput}
          onChange={(event) => onApiKeyChange(event.target.value)}
          placeholder={providerConfig?.hasApiKey ? "******** （上書きする場合のみ入力）" : "APIキーを入力"}
          className="mb-4 w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-rose-300 focus:outline-none focus:ring-2 focus:ring-rose-200 dark:border-zinc-700 dark:bg-[#141425] dark:text-zinc-100 dark:focus:border-purple-500 dark:focus:ring-purple-500/40"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center justify-center rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-emerald-600 disabled:opacity-60 dark:bg-emerald-600 dark:hover:bg-emerald-500"
          >
            {loading ? "保存中…" : "APIキーを保存"}
          </button>
          <button
            type="button"
            onClick={onClearApiKey}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-600 hover:border-rose-300 hover:text-rose-500 disabled:opacity-60 dark:border-zinc-600 dark:text-zinc-200 dark:hover:border-rose-400 dark:hover:text-rose-300"
          >
            キーを削除
          </button>
          {providerConfig?.hasApiKey && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400">保存済みのキーあり</span>
          )}
        </div>
      </form>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSavePassword();
        }}
        className="mt-6 rounded-2xl border border-zinc-200/60 bg-white p-5 shadow-sm dark:border-zinc-700/40 dark:bg-[#0f0f19]"
      >
        <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-100">パスワード変更</h3>
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          現在のパスワード
        </label>
        <input
          type="password"
          value={passwordForm.current}
          onChange={(event) => onPasswordChange("current", event.target.value)}
          className="mb-4 w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-rose-300 focus:outline-none focus:ring-2 focus:ring-rose-200 dark:border-zinc-700 dark:bg-[#141425] dark:text-zinc-100 dark:focus:border-purple-500 dark:focus:ring-purple-500/40"
        />
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          新しいパスワード
        </label>
        <input
          type="password"
          value={passwordForm.next}
          onChange={(event) => onPasswordChange("next", event.target.value)}
          className="mb-2 w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-rose-300 focus:outline-none focus:ring-2 focus:ring-rose-200 dark:border-zinc-700 dark:bg-[#141425] dark:text-zinc-100 dark:focus:border-purple-500 dark:focus:ring-purple-500/40"
        />
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          新しいパスワード（確認）
        </label>
        <input
          type="password"
          value={passwordForm.confirm}
          onChange={(event) => onPasswordChange("confirm", event.target.value)}
          className="mb-3 w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-rose-300 focus:outline-none focus:ring-2 focus:ring-rose-200 dark:border-zinc-700 dark:bg-[#141425] dark:text-zinc-100 dark:focus:border-purple-500 dark:focus:ring-purple-500/40"
        />
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">※ 6文字以上のパスワードを推奨します。</p>
        {passwordMismatch && (
          <p className="mb-3 text-xs text-rose-600 dark:text-rose-300">新しいパスワードが一致していません。</p>
        )}
        {passwordTooShort && (
          <p className="mb-3 text-xs text-rose-600 dark:text-rose-300">新しいパスワードは6文字以上にしてください。</p>
        )}
        <button
          type="submit"
          disabled={passwordDisabled}
          className="inline-flex items-center justify-center rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-indigo-600 disabled:opacity-60 dark:bg-indigo-600 dark:hover:bg-indigo-500"
        >
          {loading ? "保存中…" : "変更を保存"}
        </button>
      </form>
      <div className="mt-6 rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-3 text-xs text-zinc-600 dark:border-zinc-600 dark:bg-[#141425] dark:text-zinc-300">
        設定は <code className="font-mono">apps/bff/mini/.env</code> に保存され、UI から変更すると即時反映されます。
      </div>
    </section>
  );
};

const Bubble: React.FC<{
  role: Role;
  text: string;
  card?: CardRecord;
  themeClasses: ThemeClasses;
}> = ({ role, text, card, themeClasses }) => (
  <div
    className={["flex items-start gap-3 flex-row justify-start"].join(" ")}
  >
    <ChatAvatar url={card?.avatar} label={card?.name ?? ""} role={role} />
    <div
      className={[
        "max-w-[80%] rounded-2xl px-4 py-3 shadow-sm transition text-left",
        role === "user" ? `mr-auto ${themeClasses.bubbleUser}` : themeClasses.bubbleAi,
      ].join(" ")}
    >
      <div className="mb-1 flex items-center gap-2 text-xs opacity-70">
        <span className="uppercase tracking-wide">{role === "user" ? "You" : card?.name ?? "Dr.Orb"}</span>
        {card && <CardChip name={card.name} themeClasses={themeClasses} />}
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
    </div>
  </div>
);

const CardDock: React.FC<{
  cards: CardRecord[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onRegisterClick: () => void;
  onCreateScenario: () => void;
  onDropFiles: (files: FileList | null) => void;
  onRemove: (id: string) => void;
  themeClasses: ThemeClasses;
}> = ({ cards, selectedId, onSelect, onRegisterClick, onCreateScenario, onDropFiles, onRemove, themeClasses }) => {
  const handleDrop: React.DragEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();
    onDropFiles(event.dataTransfer.files);
  };

  const handleDragOver: React.DragEventHandler<HTMLDivElement> = (event) => event.preventDefault();

  return (
    <section
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      className={`rounded-2xl ${themeClasses.panel} p-4 shadow-sm`}
      title="PNG(400x600)をドロップしてカードを追加"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className={`text-[11px] uppercase tracking-wide ${themeClasses.dockLabel}`}>Card Dock</div>
        <div className="flex items-center gap-2">
          <button
            onClick={onCreateScenario}
            className="rounded-full border border-rose-200 px-3 py-1 text-xs font-medium text-rose-500 hover:border-rose-500 hover:text-rose-600"
          >
            ✦ シナリオ作成
          </button>
          <button
            onClick={onRegisterClick}
            className="rounded-full border border-dashed border-rose-300 px-3 py-1 text-xs font-medium text-rose-500 hover:border-rose-500 hover:text-rose-600"
          >
            ＋ カード登録
          </button>
        </div>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {cards.map((card) => {
          const isSelected = selectedId === card.id;
          const hasAvatar = Boolean(card.avatar);
          return (
            <button
              key={card.id}
              onClick={() => onSelect(card.id)}
              className={[
                "group relative flex flex-none flex-col overflow-hidden rounded-2xl transition focus:outline-none",
                hasAvatar ? "h-32 w-24 border shadow-sm" : "h-auto w-auto border-none",
                hasAvatar
                  ? isSelected
                    ? themeClasses.cardSelected
                    : themeClasses.card
                  : isSelected
                  ? "ring-2 ring-rose-200 bg-white text-rose-500"
                  : "bg-white text-zinc-600 hover:bg-rose-50",
              ].join(" ")}
            >
            {hasAvatar ? (
              <>
                  <div className="relative flex-1 w-full">
                    <img src={card.avatar} alt={card.name} className="h-full w-full object-cover" />
                    {card.kind === "featured" && (
                      <span className="absolute left-2 top-2 rounded-full bg-gradient-to-r from-rose-500 to-pink-500 px-2 py-0.5 text-[10px] font-semibold text-white shadow">
                        featured
                      </span>
                    )}
                    {card.kind === "custom" && (
                      <button
                        type="button"
                        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-sm font-semibold text-white hover:bg-black/80"
                        onClick={(event) => {
                          event.stopPropagation();
                          onRemove(card.id);
                        }}
                      >
                        ⏏︎
                      </button>
                    )}
                  </div>
                  <div className="line-clamp-2 px-2 py-1 text-center text-[11px] text-zinc-600">{card.name}</div>
                </>
              ) : (
                <div className="flex h-32 w-24 flex-col items-center justify-center rounded-2xl border border-dashed border-rose-200 bg-white text-xs font-medium text-rose-500">
                  <span className="text-base">🖼️</span>
                  <span className="mt-1">{card.name}</span>
                </div>
              )}
            </button>
          );
        })}
      </div>
      <p className={`mt-3 text-xs ${themeClasses.textSubtle}`}>
        Dr.Orb / Miss Madi はプリロード済み。PNG(400×600)をドロップするとカードキャラクターを追加登録できます。
      </p>
    </section>
  );
};

const PayPalGrid: React.FC = () => (
  <section id="billing" className="rounded-2xl bg-white/90 p-6 shadow-lg ring-1 ring-rose-100">
    <header className="mb-4 flex items-center justify-between">
      <h2 className="text-lg font-semibold text-[#152053]">課金ポイント・サポート</h2>
      <span className="rounded-full bg-rose-100 px-3 py-1 text-xs font-medium text-rose-600">PayPal</span>
    </header>
    <p className="mb-4 text-sm text-zinc-600">
      AI駆動系のエンタメサービスです。長期プレイの場合はポイントのご購入をお願いします。
    </p>
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {PAYPAL_PLANS.map((plan) => (
        <article
          key={plan.id}
          className="flex h-full flex-col rounded-xl border border-rose-100 bg-white p-4 shadow-sm transition hover:border-rose-300"
        >
          <div className="text-xs font-medium uppercase tracking-wide text-rose-500">{plan.region}</div>
          <h3 className="mt-1 text-base font-semibold text-[#1d1d35]">{plan.label}</h3>
          <p className="mt-2 flex-1 text-sm text-zinc-500">{plan.description}</p>
          <div className="mt-3 text-sm font-semibold text-rose-600">
            {plan.price} {plan.currency}
          </div>
          <a
            href={plan.url}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-flex items-center justify-center rounded-lg bg-gradient-to-r from-rose-500 to-rose-600 px-3 py-2 text-sm font-semibold text-white shadow hover:from-rose-600 hover:to-rose-700"
          >
            PayPalで購入
          </a>
        </article>
      ))}
    </div>
  </section>
);

const App: React.FC = () => {
  const [theme, setTheme] = useState<Theme>("light");
  const bffCandidates = useMemo(() => BFF_CANDIDATES, []);
  const themeClasses = useMemo(() => THEME_MAP[theme], [theme]);

  const [cards, setCards] = useState<CardRecord[]>(FEATURED_CARDS);
  const [selectedCard, setSelectedCard] = useState<string>(FEATURED_CARDS[0]?.id ?? "");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [temperature, setTemperature] = useState("0.7");
  const [health, setHealth] = useState<HealthStatus>();
  const [loadingHealth, setLoadingHealth] = useState(false);
  const [healthError, setHealthError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [adminMode, setAdminMode] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(ADMIN_STORAGE_KEY) === "true";
  });
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [providerConfig, setProviderConfig] = useState<ProviderConfig | null>(null);
  const [providerForm, setProviderForm] = useState({ provider: "GEMINI", model: "" });
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [passwordForm, setPasswordForm] = useState<PasswordForm>({
    current: "",
    next: "",
    confirm: "",
  });
  const [adminNotice, setAdminNotice] = useState<string | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [loadingAdminConfig, setLoadingAdminConfig] = useState(false);
  const [heartbeatDebug, setHeartbeatDebug] = useState<HeartbeatDebugInfo | null>(null);
  const [walletDiagnosticUserId, setWalletDiagnosticUserId] = useState("preview-ui");
  const [walletDiagnosticAmount, setWalletDiagnosticAmount] = useState(7);
  const [walletDiagnosticRevert, setWalletDiagnosticRevert] = useState(true);
  const [walletDiagnosticRunning, setWalletDiagnosticRunning] = useState(false);
  const [walletDiagnosticResult, setWalletDiagnosticResult] = useState<WalletDiagnosticResult | null>(null);
  const [walletDiagnosticError, setWalletDiagnosticError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({ state: "connecting", attempt: 0 });
  const updateConnectionStatus = useCallback((status: ConnectionStatus) => {
    setConnectionStatus(status);
    if (typeof window !== "undefined") {
      (window as any).__IZK_BFF_STATUS__ = status;
      if (!(window as any).__IZK_BFF_HISTORY__) {
        (window as any).__IZK_BFF_HISTORY__ = [];
      }
      try {
        (window as any).__IZK_BFF_HISTORY__.push({ timestamp: Date.now(), status: structuredClone(status) });
      } catch {
        (window as any).__IZK_BFF_HISTORY__.push({ timestamp: Date.now(), status });
      }
      console.info("BFF_CONNECTION_STATE", status);
    }
  }, []);
  const [endpointChecks, setEndpointChecks] = useState<EndpointCheck[]>([]);
  const [healthChecksRunning, setHealthChecksRunning] = useState(false);
  const walletHealthStatus = useMemo(() => {
    const balanceCheck = endpointChecks.find((check) => check.endpoint === "/wallet/balance");
    const consumeCheck = endpointChecks.find((check) => check.endpoint === "/wallet/consume");
    if (!balanceCheck || !consumeCheck) return null;
    if (balanceCheck.ok && consumeCheck.ok) return "ok";
    if (!balanceCheck.ok || !consumeCheck.ok) return "error";
    return null;
  }, [endpointChecks]);
  const [activeUserId, setActiveUserId] = useState(() => {
    if (typeof window === "undefined") return "preview-user";
    const existing = localStorage.getItem("IZK_UID");
    if (existing && existing.trim().length > 0) {
      return existing.trim();
    }
    const fallback = "preview-user";
    localStorage.setItem("IZK_UID", fallback);
    return fallback;
  });
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [showScenarioModal, setShowScenarioModal] = useState(false);
  const [scenarioTitle, setScenarioTitle] = useState("");
  const [generatingScenario, setGeneratingScenario] = useState(false);
  const [scenarioError, setScenarioError] = useState<string | null>(null);
  const SCENARIO_STORAGE_KEY = "IZK_THUMBNAIL_SCENARIOS";
  const [scenarioHistory, setScenarioHistory] = useState<GeneratedScenario[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(SCENARIO_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((entry) => entry && typeof entry === "object")
          .map((entry, index) => {
            const summary = typeof entry.summary === "string" ? entry.summary : "";
            const prompt = typeof entry.prompt === "string" ? entry.prompt : summary;
            const cardId = typeof entry.cardId === "string" ? entry.cardId : "";
            const cardName = typeof entry.cardName === "string" ? entry.cardName : "";
            const personaData =
              entry.persona && typeof entry.persona === "object" ? (entry.persona as V2CardMetadata) : null;
            return {
              id:
                typeof entry.id === "string"
                  ? entry.id
                  : `legacy-${index}-${Math.random().toString(36).slice(2, 8)}`,
              title: typeof entry.title === "string" ? entry.title : "",
              summary,
              prompt,
              cardId,
              cardName,
              persona: personaData,
              createdAt:
                typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
            };
          })
          .filter((entry) => entry.summary.length > 0);
      }
    } catch {
      // ignore parse failures
    }
    return [];
  });
  const latestScenario = scenarioHistory.length > 0 ? scenarioHistory[0] : null;
  const [draftScenario, setDraftScenario] = useState<GeneratedScenario | null>(null);
  const [scenarioSending, setScenarioSending] = useState(false);
  const [scenarioToast, setScenarioToast] = useState<string | null>(null);
  const [scenarioSendError, setScenarioSendError] = useState<string | null>(null);
  const [scenarioEditorText, setScenarioEditorText] = useState("");
  const [scenarioManualMode, setScenarioManualMode] = useState(false);
  const isDevEnv = import.meta.env.DEV;
  const isAdminEnvFlag =
    typeof import.meta.env.VITE_ADMIN_MODE === "string"
      ? import.meta.env.VITE_ADMIN_MODE === "true"
      : false;
  const showAdminHealthWarnings = isDevEnv || isAdminEnvFlag || adminMode;

  const listRef = useRef<HTMLDivElement>(null);
  const hiddenFileInputRef = useRef<HTMLInputElement>(null);
  const adminNoticeTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const walletPollerRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);
  const isConnectingRef = useRef(false);

  const recordHeartbeatResponse = useCallback(
    (base: string, info?: { endpoint: string; status: number; body: unknown }) => {
      setHeartbeatDebug((prev) => ({
        endpoint: base,
        lastResponse: info ?? prev?.lastResponse,
      }));
    },
    [],
  );

  useEffect(() => {
    const storedTheme = localStorage.getItem("IZAKAYA_THEME");
    if (storedTheme === "dark" || storedTheme === "light") {
      setTheme(storedTheme);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem("IZK_UID", activeUserId);
  }, [activeUserId]);

  const fetchWalletBalance = useCallback(async () => {
    const userId = activeUserId.trim();
    if (!userId) {
      return null;
    }
    setWalletLoading(true);
    try {
      const response = await fetch(buildRequestUrl("/wallet/balance"), {
        method: "GET",
        headers: {
          "content-type": "application/json",
          "X-IZK-UID": userId,
        },
      });
      if (!response.ok) {
        const message = await response.text().catch(() => "");
        throw new Error(message || `HTTP ${response.status}`);
      }
      const payload = await response.json();
      const balanceValue =
        typeof payload.balance === "number" ? payload.balance : Number(payload?.remaining) || 0;
      setWalletBalance(balanceValue);
      setWalletError(null);
      return balanceValue;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setWalletError(message);
      return null;
    } finally {
      setWalletLoading(false);
    }
  }, [activeUserId]);

  useEffect(() => {
    if (!activeUserId) return;
    void fetchWalletBalance();
  }, [activeUserId, fetchWalletBalance]);

  useEffect(() => {
    localStorage.setItem("IZAKAYA_THEME", theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const trimmed = scenarioHistory.slice(0, 20);
      window.localStorage.setItem(SCENARIO_STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      // ignore storage errors
    }
  }, [SCENARIO_STORAGE_KEY, scenarioHistory]);

  useEffect(() => {
    if (!scenarioToast) return;
    const timer = window.setTimeout(() => setScenarioToast(null), 4000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [scenarioToast]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (showScenarioModal && draftScenario) {
      setScenarioEditorText(draftScenario.summary);
      setScenarioManualMode(false);
    }
  }, [draftScenario, showScenarioModal]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (walletPollerRef.current) {
        window.clearInterval(walletPollerRef.current);
        walletPollerRef.current = null;
      }
    };
  }, []);

  const fetchHealthStatus = useCallback(
    async (base?: string): Promise<HealthStatus> => {
      const url = await getHealthUrl(base);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      try {
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = (await response.json().catch(() => ({}))) as Partial<HealthStatus> & {
          status?: string;
          service?: string;
          provider?: string;
          cards?: number;
          hostname?: string;
        };
        return {
          status: typeof payload.status === "string" ? payload.status : "ok",
          service: typeof payload.service === "string" ? payload.service : "mini-bff",
          provider: typeof payload.provider === "string" ? payload.provider : providerConfig?.provider ?? "unknown",
          cards: typeof payload.cards === "number" ? payload.cards : 0,
          hostname: typeof payload.hostname === "string" ? payload.hostname : undefined,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
    [providerConfig?.provider],
  );

  const refreshHealth = useCallback(
    async (base?: string) => {
      setLoadingHealth(true);
      setHealthError(undefined);
      try {
        const data = await fetchHealthStatus(base);
        setHealth(data);
      } catch (err) {
        setHealthError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingHealth(false);
      }
    },
    [fetchHealthStatus],
  );

  const enrichCard = (card: CardRecord, kind: CardRecord["kind"] = "api"): CardRecord => {
    const preset = FEATURED_CARDS.find((featured) => {
      const normalizedName = card.name.toLowerCase();
      return (
        featured.id === card.id ||
        normalizedName.includes(featured.name.toLowerCase()) ||
        (card.system && card.system.toLowerCase().includes(featured.name.toLowerCase()))
      );
    });
    return {
      ...card,
      id: card.id || slugify(card.name),
      avatar: card.avatar || preset?.avatar,
      kind,
      metadata: card.metadata ?? preset?.metadata ?? null,
    };
  };

  const refreshCards = useCallback(async () => {
    try {
      const data = await apiFetch<{ cards: CardRecord[] }>("/cards");
      if (Array.isArray(data.cards) && data.cards.length > 0) {
        setCards((prev) => {
          const map = new Map<string, CardRecord>();
          [...prev, ...data.cards.map((card) => enrichCard(card))].forEach((card) => {
            map.set(card.id, card);
          });
          const merged = Array.from(map.values());
          if (!merged.find((card) => card.id === selectedCard) && merged.length > 0) {
            setSelectedCard(merged[0].id);
          }
          return merged;
        });
      }
    } catch (err) {
      console.warn("failed to fetch cards", err);
    }
  }, [selectedCard]);

  const probeChatEndpoint = useCallback(
    async (base: string) => {
      const url = buildRequestUrl("/chat/v1", base);
      const result = await fetchWithDebug(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: HEALTHCHECK_PROMPT, cardId: "health-check", temperature: 0 }),
      });
      recordHeartbeatResponse(base, { endpoint: url, status: result.status, body: result.body });
      if (!result.ok) {
        throw new Error(`HTTP ${result.status} ${result.rawBody}`.trim());
      }
      const data = asJsonObject<{ reply?: string }>(result.body) ?? {};
      const reply = typeof data.reply === "string" ? data.reply.trim() : "";
      if (!reply) {
        throw new Error("BFF応答エラー: 空の返信");
      }
      return { reply, data };
    },
    [recordHeartbeatResponse],
  );

  const fetchWithTimeout = useCallback(
    async (input: RequestInfo, init: RequestInit & { timeoutMs?: number } = {}) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 2000);
      try {
        const response = await fetch(input, { ...init, signal: controller.signal });
        return response;
      } finally {
        clearTimeout(timeout);
      }
    },
    [],
  );

  const runInitialChecks = useCallback(
    async (base: string) => {
      const normalizedBase = normalizeBase(base);

      const healthUrl = buildRequestUrl("/health/ping", normalizedBase);
      console.info("BFF_CONNECT_STEP", { step: "health/ping", url: healthUrl });
      const healthResponse = await fetchWithTimeout(healthUrl, { cache: "no-store" });
      if (!healthResponse.ok) {
        const detail = `HTTP ${healthResponse.status}`;
        console.error("BFF_CONNECT_STEP_FAILED", { step: "health/ping", url: healthUrl, detail });
        throw new Error(`/health/ping failed: ${detail}`);
      }
      console.info("BFF_CONNECT_STEP_SUCCESS", {
        step: "health/ping",
        status: healthResponse.status,
      });

      const adminInfoUrl = buildRequestUrl("/admin/info", normalizedBase);
      console.info("BFF_CONNECT_STEP", { step: "admin/info", url: adminInfoUrl });
      const adminInfoResponse = await fetchWithTimeout(adminInfoUrl, { cache: "no-store" });
      if (!adminInfoResponse.ok) {
        const detail = `HTTP ${adminInfoResponse.status}`;
        console.error("BFF_CONNECT_STEP_FAILED", { step: "admin/info", url: adminInfoUrl, detail });
        throw new Error(`/admin/info failed: ${detail}`);
      }
      const adminInfoStatus = adminInfoResponse.status;
      const adminInfo = await adminInfoResponse.json().catch(() => ({}));
      console.info("BFF_CONNECT_STEP_SUCCESS", {
        step: "admin/info",
        status: adminInfoStatus,
      });

      console.info("BFF_CONNECT_STEP", { step: "chat/v1", url: buildRequestUrl("/chat/v1", normalizedBase) });
      const chatResult = await probeChatEndpoint(normalizedBase);
      console.info("BFF_CONNECT_STEP_SUCCESS", { step: "chat/v1", detail: `reply length=${chatResult.reply.length}` });

      return { reply: chatResult.reply, adminInfo, adminInfoStatus };
    },
    [fetchWithTimeout, probeChatEndpoint],
  );
  const handleOpenScenarioModal = useCallback(() => {
    setScenarioTitle("");
    setScenarioError(null);
    setScenarioSendError(null);
    setDraftScenario(null);
    setScenarioToast(null);
    setScenarioEditorText("");
    setScenarioManualMode(false);
    setShowScenarioModal(true);
  }, []);

  const handleCloseScenarioModal = useCallback(() => {
    if (generatingScenario || scenarioSending) return;
    setShowScenarioModal(false);
    setScenarioError(null);
    setScenarioSendError(null);
    setDraftScenario(null);
    setScenarioTitle("");
    setScenarioEditorText("");
    setScenarioManualMode(false);
  }, [generatingScenario, scenarioSending]);

  const handleGenerateScenario = useCallback(async () => {
    const title = scenarioTitle.trim() || "おまかせ";
    const activeCard =
      cards.find((card) => card.id === selectedCard) ||
      FEATURED_CARDS.find((card) => card.id === selectedCard) ||
      null;
    const cardName = activeCard?.name ?? null;
    const promptLines = [
      "あなたは IZAKAYA verse のストーリープランナーです。",
      "以下のタイトルをもとに、200〜400文字程度の短いシナリオ概要を日本語で作成してください。",
      "アウトラインや箇条書きではなく、まとまった文章として書いてください。",
      "可能であればタイトルに合う情景や課題、期待感を含めてください。",
      title === "おまかせ"
        ? "タイトルが未指定の場合は、魅力的な仮タイトルも併記してください。"
        : `タイトル: 「${title}」`,
    ];
    if (cardName) {
      promptLines.push(`関連カード: ${cardName}`);
    }
    const scenarioPrompt = promptLines.join("\n");

    setGeneratingScenario(true);
    setScenarioError(null);
    setScenarioSendError(null);
    setScenarioToast(null);
    try {
      const url = buildRequestUrl("/chat/v1", getResolvedBffBase());
      const response = await fetchWithDebug(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: scenarioPrompt,
          cardId: selectedCard || "thumbnail-title",
          temperature: 0.2,
          persona: activeCard?.metadata ?? scenario?.persona ?? null,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.rawBody || ""}`.trim());
      }
      const payload = asJsonObject<{ reply?: string }>(response.body) ?? {};
      const summary = typeof payload.reply === "string" ? payload.reply.trim() : "";
      if (!summary) {
        throw new Error("空のシナリオが返されました。");
      }
      const entry: GeneratedScenario = {
        id: `scenario-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        title,
        summary,
        prompt: scenarioPrompt,
        cardId: activeCard?.id ?? selectedCard,
        cardName: activeCard?.name ?? title,
        persona: activeCard?.metadata ?? null,
        createdAt: new Date().toISOString(),
      };
      setScenarioHistory((prev) => [entry, ...prev].slice(0, 20));
      setDraftScenario(entry);
      setScenarioEditorText(summary);
      setScenarioManualMode(false);
      setScenarioTitle(title === "おまかせ" ? "" : title);
      setScenarioError(null);
      setScenarioToast("シナリオを生成しました。チャットに送信できます。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setScenarioError(message);
    } finally {
      setGeneratingScenario(false);
    }
  }, [cards, fetchWithDebug, scenarioTitle, selectedCard]);

  const handleManualScenario = useCallback(() => {
    setShowScenarioModal(true);
    setScenarioManualMode(true);
    setDraftScenario(null);
    setScenarioTitle("");
    setScenarioEditorText("");
    setScenarioError(null);
    setScenarioSendError(null);
    setScenarioToast("自由入力モードです。直接テキストを編集して送信できます。");
  }, []);

  const startEditingScenario = useCallback((scenario: GeneratedScenario) => {
    setScenarioManualMode(false);
    setDraftScenario(scenario);
    setScenarioError(null);
    setScenarioSendError(null);
    setScenarioToast(null);
    setScenarioTitle(scenario.title === "おまかせ" ? "" : scenario.title);
    setScenarioEditorText(scenario.summary);
    setShowScenarioModal(true);
  }, []);

  const sendScenarioToChat = useCallback(
    async (scenario?: GeneratedScenario) => {
      if (scenarioSending || sending) return;
      if (connectionStatus.state !== "ok") {
        setScenarioSendError("BFF未接続です。接続を確認してから再度お試しください。");
        console.error("CHAT_REQUEST_FAILED", { reason: "scenario_send_without_connection" });
        return;
      }
      const editorSummary = showScenarioModal ? scenarioEditorText.trim() : "";
      const fallbackSummary = scenario?.summary?.trim() ?? "";
      const finalSummary = editorSummary || fallbackSummary;
      if (!finalSummary) {
        setScenarioSendError("シナリオ本文が空です。");
        return;
      }
      const finalTitle =
        scenario?.title ??
        (scenarioTitle.trim() ? scenarioTitle.trim() : editorSummary ? "おまかせ" : "おまかせ");
      const tempValue = Math.min(1, Math.max(0, Number(temperature) || 0.7));
      const activeCard =
        cards.find((card) => card.id === selectedCard) ||
        FEATURED_CARDS.find((card) => card.id === selectedCard) ||
        null;
      setScenarioSending(true);
      setSending(true);
      setScenarioSendError(null);
      setScenarioToast(null);
      setMessages((prev) => [
        ...prev,
        {
          role: "user",
          text: finalSummary,
          cardId: selectedCard,
          cardName: activeCard?.name,
        },
      ]);
      try {
        const body = {
          prompt: finalSummary,
          text: finalSummary,
          cardId: selectedCard,
          temperature: tempValue,
          persona: activeCard?.metadata ?? null,
        };
        const data = await apiFetch<{ reply: string; meta?: Record<string, string> }>("/chat/v1", {
          method: "POST",
          body: JSON.stringify(body),
        });
        const replyText = typeof data.reply === "string" ? data.reply.trim() : "";
        if (!replyText) {
          throw new Error("BFF応答エラー: 空の返信");
        }
        setMessages((prev) => [
          ...prev,
          {
            role: "ai",
            text: replyText,
            cardId: selectedCard,
            cardName: activeCard?.name,
          },
        ]);
        setScenarioToast("チャットに送信しました。物語を開始します。");
        setScenarioSendError(null);
        void fetchWalletBalance();
        const updatedEntry: GeneratedScenario = scenario
          ? {
              ...scenario,
              title: finalTitle,
              summary: finalSummary,
              prompt: scenario.prompt ?? finalSummary,
              cardId: activeCard?.id ?? selectedCard,
              cardName: activeCard?.name ?? finalTitle,
              persona: activeCard?.metadata ?? scenario.persona ?? null,
            }
          : {
              id: `scenario-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
              title: finalTitle,
              summary: finalSummary,
              prompt: finalSummary,
              cardId: activeCard?.id ?? selectedCard,
              cardName: activeCard?.name ?? finalTitle,
              persona: activeCard?.metadata ?? scenario?.persona ?? null,
              createdAt: new Date().toISOString(),
            };
        setScenarioHistory((prev) => {
          if (scenario) {
            return prev.map((item) => (item.id === scenario.id ? updatedEntry : item)).slice(0, 20);
          }
          return [updatedEntry, ...prev].slice(0, 20);
        });
        setDraftScenario(null);
        setScenarioEditorText("");
        setScenarioManualMode(false);
        setScenarioTitle("");
        setShowScenarioModal(false);
        setTimeout(() => {
          listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
        }, 120);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setScenarioSendError(message);
        setMessages((prev) => [
          ...prev,
          {
            role: "ai",
            text: `エラー: ${message}`,
            cardId: selectedCard,
            cardName: activeCard?.name,
          },
        ]);
      } finally {
        setScenarioSending(false);
        setSending(false);
      }
    },
    [
      cards,
      connectionStatus.state,
      listRef,
      scenarioEditorText,
      scenarioSending,
      scenarioTitle,
      sending,
      selectedCard,
      showScenarioModal,
      temperature,
    ],
  );

  const performHealthChecks = useCallback(async (base: string, reply: string): Promise<EndpointCheck[]> => {
    const normalizedBase = normalizeBase(base);
    const checks: EndpointCheck[] = [
      {
        endpoint: "/chat/v1",
        url: buildRequestUrl("/chat/v1", normalizedBase),
        ok: true,
        detail: `reply length: ${reply.length}`,
      },
    ];

    const headers = {
      "content-type": "application/json",
      "X-IZK-UID": HEALTHCHECK_UID,
    };

    const balanceUrl = buildRequestUrl("/wallet/balance", normalizedBase);
    try {
      const res = await fetchWithDebug(balanceUrl, { headers });
      recordHeartbeatResponse(base, { endpoint: balanceUrl, status: res.status, body: res.body });
      if (!res.ok) {
        checks.push({
          endpoint: "/wallet/balance",
          url: balanceUrl,
          ok: false,
          detail: `HTTP ${res.status} ${res.rawBody}`.trim(),
        });
      } else {
        const payload = asJsonObject<{ balance?: number }>(res.body) ?? {};
        const balanceDetail =
          typeof payload.balance === "number" ? `balance=${payload.balance}` : undefined;
        checks.push({ endpoint: "/wallet/balance", url: balanceUrl, ok: true, detail: balanceDetail });
      }
    } catch (error) {
      checks.push({
        endpoint: "/wallet/balance",
        url: balanceUrl,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    const redeemUrl = buildRequestUrl("/wallet/redeem", normalizedBase);
    const consumeUrl = buildRequestUrl("/wallet/consume", normalizedBase);
    const now = new Date();
    const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
    const token = Math.random().toString(36).slice(2, 8).toUpperCase();
    const txId = `TX-${ymd}-${token}`;
    let redeemSucceeded = false;
    let redeemDetail: string | undefined;

    try {
      const redeemRes = await fetchWithDebug(redeemUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ amount_pt: 1, tx_id: txId }),
      });
      recordHeartbeatResponse(base, { endpoint: redeemUrl, status: redeemRes.status, body: redeemRes.body });
      if (!redeemRes.ok) {
        redeemDetail = `HTTP ${redeemRes.status} ${redeemRes.rawBody}`.trim();
      } else {
        redeemSucceeded = true;
      }
    } catch (error) {
      redeemDetail = error instanceof Error ? error.message : String(error);
    }

    if (redeemSucceeded) {
      const idempotencyKey = `health-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        const consumeRes = await fetchWithDebug(consumeUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ amount_pt: 1, sku: "health-check", idempotency_key: idempotencyKey }),
        });
        recordHeartbeatResponse(base, { endpoint: consumeUrl, status: consumeRes.status, body: consumeRes.body });
        if (!consumeRes.ok) {
          checks.push({
            endpoint: "/wallet/consume",
            url: consumeUrl,
            ok: false,
            detail: `HTTP ${consumeRes.status} ${consumeRes.rawBody}`.trim(),
          });
        } else {
          const payload = asJsonObject<{ balance?: number }>(consumeRes.body) ?? {};
          const detail =
            typeof payload.balance === "number" ? `balance=${payload.balance}` : "ok";
          checks.push({ endpoint: "/wallet/consume", url: consumeUrl, ok: true, detail });
        }
      } catch (error) {
        checks.push({
          endpoint: "/wallet/consume",
          url: consumeUrl,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      checks.push({
        endpoint: "/wallet/consume",
        url: consumeUrl,
        ok: false,
        detail: redeemDetail ? `redeem failed: ${redeemDetail}` : "redeem failed",
      });
    }

    return checks;
  }, [recordHeartbeatResponse]);

  const runHealthChecks = useCallback(async (base: string, reply: string) => {
    setHealthChecksRunning(true);
    try {
      const checks = await performHealthChecks(base, reply);
      setEndpointChecks(checks);
      const failures = checks.filter((check) => !check.ok);
      if (failures.length > 0) {
        console.error("CHAT_REQUEST_FAILED", { reason: "healthcheck_failed", failures });
      }
      return checks;
    } finally {
      setHealthChecksRunning(false);
    }
  }, [performHealthChecks]);

  const startConnection = useCallback(async () => {
    if (isConnectingRef.current || !isMountedRef.current) return;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    clearCachedHealthUrl();
    isConnectingRef.current = true;
    setEndpointChecks([]);
    setHeartbeatDebug(null);
    let totalAttempts = 0;
    const failures: ConnectionFailure[] = [];

    for (const candidate of bffCandidates) {
      const base = normalizeBase(candidate);
      let lastError = "unknown error";
      for (let attempt = 1; attempt <= MAX_CONNECTION_ATTEMPTS; attempt += 1) {
        if (!isMountedRef.current) {
          isConnectingRef.current = false;
          return;
        }
        totalAttempts += 1;
        updateConnectionStatus({ state: "connecting", attempt: totalAttempts });
        console.info("BFF_CONNECT_PROGRESS", { base, attempt, totalAttempts });
        try {
          const { reply, adminInfo, adminInfoStatus } = await runInitialChecks(base);
          if (!isMountedRef.current) {
            isConnectingRef.current = false;
            return;
          }
          setResolvedBffBase(base);
          updateConnectionStatus({ state: "ok", url: base, reply });
          recordHeartbeatResponse(base, {
            endpoint: buildRequestUrl("/admin/info", base),
            status: adminInfoStatus,
            body: adminInfo,
          });
          try {
            const status = await fetchHealthStatus(base);
            setHealth(status);
            setHealthError(undefined);
          } catch (error) {
            setHealthError(error instanceof Error ? error.message : String(error));
          }
          setMessages((prev) =>
            prev.length === 0
              ? [
                  {
                    role: "ai",
                    text: reply,
                    cardId: FEATURED_CARDS[0]?.id,
                    cardName: "BFFヘルスチェック",
                  },
                ]
              : prev,
          );
          await refreshCards();
          await runHealthChecks(base, reply);
          await fetchWalletBalance();
          isConnectingRef.current = false;
          console.info("BFF_CONNECT_SUCCESS", { base, replyPreview: reply.slice(0, 48) });
          return;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.error("CHAT_REQUEST_FAILED", {
            reason: "bootstrap_candidate_failed",
            url: base,
            error,
          });
          console.error("BFF_CONNECT_ATTEMPT_FAILED", { base, attempt, detail });
          lastError = detail;
          if (attempt < MAX_CONNECTION_ATTEMPTS) {
            await sleep(CONNECTION_RETRY_DELAY_MS);
          }
        }
      }
      failures.push({ url: base, detail: lastError });
    }

    if (isMountedRef.current) {
      updateConnectionStatus({ state: "error", attempt: totalAttempts, failures });
      console.error("CHAT_REQUEST_FAILED", { reason: "bootstrap_failed", failures });
    }
    isConnectingRef.current = false;
  }, [bffCandidates, fetchHealthStatus, fetchWalletBalance, recordHeartbeatResponse, refreshCards, runHealthChecks, runInitialChecks, updateConnectionStatus]);

  useEffect(() => {
    startConnection();
  }, [startConnection]);

  useEffect(() => {
    if (connectionStatus.state !== "error") {
      return;
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
    }
    retryTimerRef.current = setTimeout(() => {
      if (!isMountedRef.current) return;
      startConnection();
    }, RECONNECT_DELAY_MS);
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [connectionStatus, startConnection]);
  useEffect(() => {
    if (connectionStatus.state !== "ok") {
      if (walletPollerRef.current) {
        window.clearInterval(walletPollerRef.current);
        walletPollerRef.current = null;
      }
      return;
    }
    void fetchWalletBalance();
    if (walletPollerRef.current) {
      window.clearInterval(walletPollerRef.current);
    }
    walletPollerRef.current = window.setInterval(() => {
      void fetchWalletBalance();
    }, 10000);
    return () => {
      if (walletPollerRef.current) {
        window.clearInterval(walletPollerRef.current);
        walletPollerRef.current = null;
      }
    };
  }, [connectionStatus.state, fetchWalletBalance]);


  const handleRetryHealthChecks = async () => {
    if (connectionStatus.state !== "ok") {
      setAdminError("BFF未接続です。接続を確認してから再度お試しください。");
      console.error("CHAT_REQUEST_FAILED", { reason: "healthcheck_retry_without_connection" });
      return;
  }
  try {
    await runHealthChecks(connectionStatus.url, connectionStatus.reply);
    await refreshHealth(connectionStatus.url);
  } catch (error) {
      console.error("CHAT_REQUEST_FAILED", { reason: "healthcheck_retry_failed", error });
    }
  };

  const showAdminToast = useCallback((message: string) => {
    setAdminError(null);
    setAdminNotice(message);
    if (adminNoticeTimerRef.current) {
      window.clearTimeout(adminNoticeTimerRef.current);
    }
    adminNoticeTimerRef.current = window.setTimeout(() => {
      setAdminNotice(null);
      adminNoticeTimerRef.current = null;
    }, 4000);
  }, []);

  const handleRunWalletDiagnostic = useCallback(async () => {
    const target = walletDiagnosticUserId.trim();
    if (!target) {
      setWalletDiagnosticError("診断対象ユーザーIDを入力してください");
      return;
    }
    setWalletDiagnosticRunning(true);
    setWalletDiagnosticError(null);
    setWalletDiagnosticResult(null);
    try {
      const amount = Math.max(1, Math.round(walletDiagnosticAmount));
      const response = await fetch(buildRequestUrl("/admin/wallet/diagnostic"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-IZK-UID": "admin",
        },
        body: JSON.stringify({
          userId: target,
          amount,
          revert: walletDiagnosticRevert,
        }),
      });
      if (!response.ok) {
        const message = await response.text().catch(() => "");
        throw new Error(message || `HTTP ${response.status}`);
      }
      const payload = (await response.json()) as WalletDiagnosticResult & { error?: string };
      if (!payload || payload.ok !== true) {
        throw new Error(payload?.error || "wallet_diagnostic_failed");
      }
      setWalletDiagnosticResult(payload);
      setWalletDiagnosticError(null);
      showAdminToast("ウォレット動作チェックが完了しました。");
      await fetchWalletBalance();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setWalletDiagnosticError(message);
    } finally {
      setWalletDiagnosticRunning(false);
    }
  }, [
    walletDiagnosticUserId,
    walletDiagnosticAmount,
    walletDiagnosticRevert,
    fetchWalletBalance,
    showAdminToast,
  ]);

  const fetchProviderConfig = useCallback(async () => {
    try {
      setLoadingAdminConfig(true);
      const data = await apiFetch<ProviderConfig>("/admin/provider");
      setProviderConfig(data);
      setProviderForm({
        provider: (data.provider ?? "GEMINI").toUpperCase(),
        model: data.model ?? "",
      });
      setAdminError(null);
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingAdminConfig(false);
    }
  }, []);

  const addMessage = (message: Message) => setMessages((prev) => [...prev, message]);

  const handleSend = async () => {
    const content = input.trim();
    if (!content || sending) return;
    if (connectionStatus.state !== "ok") {
      if (typeof window !== "undefined") {
        window.alert("BFF未接続です。接続確認後に再度お試しください。");
      }
      console.error("CHAT_REQUEST_FAILED", { reason: "send_without_connection" });
      return;
    }
    const tempValue = Math.min(1, Math.max(0, Number(temperature) || 0.7));
    const activeCard =
      cards.find((card) => card.id === selectedCard) ||
      FEATURED_CARDS.find((card) => card.id === selectedCard) ||
      null;
    setInput("");
    addMessage({ role: "user", text: content });
    setSending(true);
    try {
      const body = {
        prompt: content,
        cardId: selectedCard,
        temperature: tempValue,
        persona: activeCard?.metadata ?? null,
      };
      const data = await apiFetch<{ reply: string; meta?: Record<string, string> }>("/chat/v1", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const replyText = typeof data.reply === "string" ? data.reply.trim() : "";
      if (!replyText) {
        throw new Error("BFF応答エラー: 空の返信");
      }
      addMessage({
        role: "ai",
        text: replyText,
        cardId: selectedCard,
        cardName: activeCard?.name,
      });
      void fetchWalletBalance();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("CHAT_REQUEST_FAILED", { reason: "send_failed", error: err });
      addMessage({
        role: "ai",
        text: `エラー: ${message}`,
        cardId: selectedCard,
        cardName: activeCard?.name,
      });
      if (typeof window !== "undefined") {
        window.alert(`チャットの送信に失敗しました: ${message}`);
      }
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      handleSend();
    }
  };

  const handleRegisterCard = () => hiddenFileInputRef.current?.click();

  const handleFilesToCards = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = Array.from(files).find((item) => item.type === "image/png");
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    let metadata: V2CardMetadata | null = null;
    try {
      metadata = await extractV2CardMetadataFromPng(file);
    } catch (error) {
      console.warn("V2 metadata parse failed", error);
    }
    const rawName = typeof metadata?.name === "string" ? metadata.name.trim() : "";
    const rawId = typeof metadata?.id === "string" ? metadata.id.trim() : "";
    const baseName = rawName || file.name.replace(/\.png$/i, "");
    let proposedId = rawId || `custom-${Date.now()}`;
    let finalId = proposedId;
    setCards((prev) => {
      let uniqueId = finalId;
      const seenIds = new Set(prev.map((card) => card.id));
      while (seenIds.has(uniqueId)) {
        uniqueId = `${proposedId}-${Math.random().toString(36).slice(2, 6)}`;
      }
      finalId = uniqueId;
      const cardMetadata = metadata ? { ...metadata } : null;
      if (cardMetadata) {
        if (!cardMetadata.id) cardMetadata.id = uniqueId;
        if (!cardMetadata.name) cardMetadata.name = baseName;
      }
      const newCard: CardRecord = {
        id: uniqueId,
        name: baseName,
        avatar: objectUrl,
        kind: "custom",
        metadata: cardMetadata,
      };
      return [newCard, ...prev];
    });
    setSelectedCard(finalId);
  };

  const selectedCardMeta =
    cards.find((card) => card.id === selectedCard) ??
    FEATURED_CARDS.find((card) => card.id === selectedCard) ??
    cards[0] ??
    null;

  const handleRemoveCard = (id: string) => {
    setCards((prev) => {
      const next = prev.filter((card) => card.id !== id);
      if (selectedCard === id) {
        const fallback = next[0] ?? FEATURED_CARDS[0];
        setSelectedCard(fallback ? fallback.id : "");
      }
      return next;
    });
  };

  const handleShowBalance = async () => {
    alert("ポイント情報を取得しています…");
    const balance = await fetchWalletBalance();
    if (balance !== null) {
      alert(`残高: ${balance} pt`);
    } else if (walletError) {
      alert(`ポイント情報の取得に失敗しました: ${walletError}`);
    } else {
      alert("ポイント情報の取得に失敗しました");
    }
  };

  const handleAdminButtonClick = async () => {
    if (!adminMode) {
      const input = window.prompt("管理パスワードを入力してください");
      if (input === null) return;
      const candidate = input.trim();
      if (!candidate) {
        window.alert("パスワードを入力してください");
        return;
      }
      try {
        const loginUrl = buildRequestUrl("/admin/login");
        const response = await fetch(loginUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: candidate }),
        });
        if (!response.ok) {
          const message = await response.text();
          throw new Error(message || `HTTP ${response.status}`);
        }
        localStorage.setItem(ADMIN_STORAGE_KEY, "true");
        localStorage.setItem("IZK_UID", "admin");
        setActiveUserId("admin");
        setAdminMode(true);
        setAdminError(null);
        setAdminNotice(null);
        setPasswordForm({ current: "", next: "", confirm: "" });
        setShowAdminPanel(true);
        showAdminToast("管理モードを有効化しました");
        void fetchWalletBalance();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("CHAT_REQUEST_FAILED", { reason: "admin_login_failed", error });
        if (message.includes("incorrect_password")) {
          window.alert("パスワードが一致しません");
        } else {
          window.alert(`管理モードの認証に失敗しました: ${message}`);
        }
      }
      return;
    }
    setAdminError(null);
    setAdminNotice(null);
    setPasswordForm({ current: "", next: "", confirm: "" });
    setShowAdminPanel((prev) => !prev);
  };

  const handleProviderChange = (field: "provider" | "model", value: string) => {
    setProviderForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSaveProvider = async () => {
    setAdminError(null);
    try {
      setLoadingAdminConfig(true);
      await apiFetch("/admin/provider", {
        method: "POST",
        body: JSON.stringify({
          provider: providerForm.provider,
          model: providerForm.model,
        }),
      });
      showAdminToast("✅ プロバイダ設定を保存しました");
      await fetchProviderConfig();
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingAdminConfig(false);
    }
  };

  const handleSaveApiKey = async () => {
    if (!apiKeyInput.trim()) {
      setAdminError("APIキーを入力してください");
      return;
    }
    try {
      setAdminError(null);
      setLoadingAdminConfig(true);
      await apiFetch("/admin/provider", {
        method: "POST",
        body: JSON.stringify({ apiKey: apiKeyInput.trim() }),
      });
      setApiKeyInput("");
      showAdminToast("✅ APIキーを保存しました（サーバーで安全に保管）");
      await fetchProviderConfig();
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingAdminConfig(false);
    }
  };

  const handleClearApiKey = async () => {
    try {
      setAdminError(null);
      setLoadingAdminConfig(true);
      await apiFetch("/admin/provider", {
        method: "POST",
        body: JSON.stringify({ apiKey: "" }),
      });
      setApiKeyInput("");
      showAdminToast("✅ APIキーを削除しました");
      await fetchProviderConfig();
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingAdminConfig(false);
    }
  };

  const handlePasswordChange = (field: keyof PasswordForm, value: string) => {
    setAdminError(null);
    setPasswordForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSavePassword = async () => {
    const current = passwordForm.current.trim();
    const next = passwordForm.next.trim();
    const confirm = passwordForm.confirm.trim();
    if (!current || !next) {
      setAdminError("パスワードを入力してください");
      return;
    }
    if (next.length < 6) {
      setAdminError("新しいパスワードは6文字以上にしてください");
      return;
    }
    if (next !== confirm) {
      setAdminError("新しいパスワードが一致していません");
      return;
    }
    try {
      setAdminError(null);
      setLoadingAdminConfig(true);
      await apiFetch("/admin/password", {
        method: "POST",
        body: JSON.stringify({
          current_password: current,
          new_password: next,
        }),
      });
      showAdminToast("✅ パスワードを変更しました");
      setPasswordForm({ current: "", next: "", confirm: "" });
      await fetchProviderConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("incorrect_password")) {
        setAdminError("現在のパスワードが違います");
      } else if (message.includes("invalid_new_password")) {
        setAdminError("新しいパスワードは6文字以上にしてください");
      } else {
        setAdminError(message);
      }
    } finally {
      setLoadingAdminConfig(false);
    }
  };

  useEffect(() => {
    if (adminMode && showAdminPanel) {
      fetchProviderConfig();
    }
  }, [adminMode, showAdminPanel, fetchProviderConfig]);

  useEffect(() => {
    return () => {
      if (adminNoticeTimerRef.current) {
        window.clearTimeout(adminNoticeTimerRef.current);
      }
    };
  }, []);

  return (
    <>
      <div className={`min-h-screen ${themeClasses.page}`}>
      <header className={`sticky top-0 z-10 ${themeClasses.header} border-b border-white/40 backdrop-blur-xl`}>
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-5 py-4">
          <HeaderIcon />
          <div className="flex flex-col">
            <h1 className={themeClasses.title}>IZAKAYA verse – Lite Preview</h1>
            <div className={`text-sm font-medium ${themeClasses.textSubtle}`}>
              Mini BFF /chat 接続テストパネル
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-3 text-sm">
            <ConnectionStatusPill status={connectionStatus} />
            {walletBalance !== null ? (
              <span className="text-xs font-medium text-rose-500 dark:text-rose-300">残り {walletBalance} pt</span>
            ) : walletLoading ? (
              <span className="text-xs text-zinc-400">残高更新中…</span>
            ) : walletError && showAdminHealthWarnings ? (
              <span className="text-xs text-amber-500">残高取得エラー</span>
            ) : (
              <span className="text-xs text-zinc-400">残高 -- pt</span>
            )}
            {showAdminHealthWarnings && walletHealthStatus === "ok" && (
              <span className="text-xs text-emerald-500">🟢ポイント管理 正常</span>
            )}
            {showAdminHealthWarnings && walletHealthStatus === "error" && (
              <span className="text-xs text-rose-500">⚠️ポイント管理 異常</span>
            )}
            {showAdminHealthWarnings && <HealthCheckIndicator checks={endpointChecks} />}
            <HealthBadge health={health} loading={loadingHealth} error={healthError} />
            {selectedCardMeta && <CardChip name={selectedCardMeta.name} selected themeClasses={themeClasses} />}
            <button
              onClick={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}
              className={`rounded-full bg-gradient-to-br px-4 py-2 text-sm font-semibold text-white shadow ${themeClasses.accent}`}
            >
              {theme === "light" ? "Dark" : "Light"}
            </button>
            <button
              onClick={handleShowBalance}
              className={`rounded-full px-4 py-2 text-sm font-semibold shadow ${themeClasses.badge}`}
            >
              ポイント表示
            </button>
            <button
              onClick={handleAdminButtonClick}
              className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-600 hover:border-purple-400 hover:text-purple-500 dark:border-zinc-700 dark:text-zinc-200 dark:hover:border-purple-400 dark:hover:text-purple-300"
            >
              {adminMode ? (showAdminPanel ? "管理を閉じる" : "管理") : "管理"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-5 py-6">
        {connectionStatus.state === "connecting" && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-500/40 dark:bg-amber-900/20 dark:text-amber-200">
            ⏳ BFFと接続中…（試行{Math.max(connectionStatus.attempt, 1)}回目）
          </div>
        )}
        {connectionStatus.state === "error" && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600 dark:border-rose-500/40 dark:bg-rose-900/20 dark:text-rose-200">
            ❌ BFFに接続できません。自動再試行中です…
            {connectionStatus.failures.length > 0 && (
              <span className="mt-1 block text-xs opacity-80">
                最終エラー: {connectionStatus.failures[connectionStatus.failures.length - 1]?.detail}
              </span>
            )}
          </div>
        )}
        {adminMode && showAdminPanel && (
          <>
            <AdminBillingPanel />
            <AdminPanel
              providerOptions={PROVIDER_OPTIONS}
              providerForm={providerForm}
              onProviderChange={handleProviderChange}
              onSaveProvider={handleSaveProvider}
              apiKeyInput={apiKeyInput}
              onApiKeyChange={setApiKeyInput}
              onSaveApiKey={handleSaveApiKey}
              onClearApiKey={handleClearApiKey}
              notice={adminNotice}
              error={adminError}
              loading={loadingAdminConfig}
              passwordForm={passwordForm}
              onPasswordChange={handlePasswordChange}
              onSavePassword={handleSavePassword}
              providerConfig={providerConfig}
              healthChecks={endpointChecks}
              onRetryHealthChecks={handleRetryHealthChecks}
              healthChecksRunning={healthChecksRunning}
              heartbeatDebug={heartbeatDebug}
              walletDiagnosticResult={walletDiagnosticResult}
              walletDiagnosticError={walletDiagnosticError}
              walletDiagnosticRunning={walletDiagnosticRunning}
              walletDiagnosticUserId={walletDiagnosticUserId}
              walletDiagnosticAmount={walletDiagnosticAmount}
              walletDiagnosticRevert={walletDiagnosticRevert}
              onWalletDiagnosticUserIdChange={setWalletDiagnosticUserId}
              onWalletDiagnosticAmountChange={setWalletDiagnosticAmount}
              onWalletDiagnosticRevertChange={setWalletDiagnosticRevert}
              onRunWalletDiagnostic={handleRunWalletDiagnostic}
            />
          </>
        )}

        <section className={`relative rounded-3xl ${themeClasses.panel} shadow-xl`}>
          <div ref={listRef} className="h-[52vh] space-y-4 overflow-y-auto px-6 py-6">
            {messages.map((message, index) => (
              <Bubble
                key={`${message.role}-${index}-${message.cardId ?? "unknown"}`}
                role={message.role}
                text={message.text}
                card={cards.find((card) => card.id === message.cardId)}
                themeClasses={themeClasses}
              />
            ))}
          </div>
          <div className="border-t border-zinc-200/50 bg-white/60 px-6 py-4 backdrop-blur dark:border-zinc-700/60 dark:bg-[#111118]/60">
            <div className="mb-2 flex items-center justify-between text-xs text-zinc-500">
              <span>カード: {selectedCardMeta?.name ?? "未選択"}</span>
              <span>Cmd/Ctrl+Enter で送信</span>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="メッセージを入力…"
                rows={3}
                className={`flex-1 resize-none rounded-2xl border px-4 py-3 text-sm focus:outline-none focus:ring-2 ${
                  theme === "light"
                    ? "border-zinc-300 bg-white focus:ring-rose-200"
                    : "border-zinc-700 bg-[#0f0f19] text-zinc-100 focus:ring-purple-600/40"
                }`}
              />
              <div className="flex flex-col gap-1 text-xs text-zinc-500">
                <label className="uppercase tracking-wide">温度</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="1"
                  value={temperature}
                  onChange={(event) => setTemperature(event.target.value)}
                  className={`w-24 rounded-xl border px-3 py-2 text-sm focus:outline-none ${
                    theme === "light"
                      ? "border-zinc-300 bg-white focus:ring-rose-200"
                      : "border-zinc-700 bg-[#0f0f19] text-zinc-100 focus:ring-purple-600/40"
                  }`}
                />
              </div>
              <button
                onClick={handleSend}
                disabled={sending || !input.trim()}
                className={`inline-flex h-12 items-center justify-center gap-2 rounded-2xl px-6 text-sm font-semibold text-white shadow ${themeClasses.btnPrimary} ${
                  sending ? "opacity-60" : ""
                }`}
              >
                {sending ? "送信中…" : "送信"}
              </button>
            </div>
          </div>
        </section>

        <CardDock
          cards={cards}
          selectedId={selectedCard}
          onSelect={setSelectedCard}
          onRegisterClick={handleRegisterCard}
          onCreateScenario={handleOpenScenarioModal}
          onDropFiles={handleFilesToCards}
          onRemove={handleRemoveCard}
          themeClasses={themeClasses}
        />

        <input
          type="file"
          ref={hiddenFileInputRef}
          accept="image/png"
          className="hidden"
          onChange={(event) => handleFilesToCards(event.target.files)}
        />

        <section className="rounded-2xl border border-zinc-200 bg-white/90 p-4 shadow-sm dark:border-zinc-700 dark:bg-[#12121b]">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-semibold text-zinc-700 dark:text-zinc-100">タイトル誘導型プロット</div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleOpenScenarioModal}
                className="rounded-full border border-rose-200 px-3 py-1 text-xs font-medium text-rose-500 hover:border-rose-500 hover:text-rose-600"
              >
                ✦ 新規シナリオ
              </button>
              <button
                onClick={handleManualScenario}
                className="rounded-full border border-dashed border-rose-200 px-3 py-1 text-xs font-medium text-rose-400 hover:border-rose-400 hover:text-rose-500"
              >
                ✎ 手動入力
              </button>
            </div>
          </div>
          {latestScenario ? (
            <div className="space-y-3">
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {new Date(latestScenario.createdAt).toLocaleString()}
              </div>
              <div className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">
                {latestScenario.title === "おまかせ" ? "おまかせ生成" : latestScenario.title}
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-700 dark:text-zinc-200">
                {latestScenario.summary}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => sendScenarioToChat(latestScenario)}
                  disabled={scenarioSending || sending}
                  className="rounded-full bg-rose-500 px-4 py-2 text-xs font-semibold text-white shadow hover:bg-rose-600 disabled:opacity-60"
                >
                  {scenarioSending || sending ? "送信中…" : "チャットに送る"}
                </button>
                <button
                  onClick={() => startEditingScenario(latestScenario)}
                  className="rounded-full border border-rose-200 px-3 py-1 text-xs font-medium text-rose-500 hover:border-rose-500 hover:text-rose-600"
                >
                  編集して送信
                </button>
              </div>
              {scenarioSendError && !showScenarioModal && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:border-rose-500/40 dark:bg-rose-900/20 dark:text-rose-200">
                  {scenarioSendError}
                </div>
              )}
              {scenarioToast && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-600 dark:border-emerald-500/40 dark:bg-emerald-900/20 dark:text-emerald-200">
                  {scenarioToast}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-zinc-500 dark:text-zinc-300">
              タイトルを入力して短いシナリオ案を生成できます。まずは「新規シナリオ」を押してみてください。
            </p>
          )}
        </section>

        <PayPalGrid />
      </main>
      </div>

      {showScenarioModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6 backdrop-blur">
        <div className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl dark:bg-[#12121b]">
          <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">サムネタイトルから生成</h2>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
            タイトルを入力すると、200〜400文字のシナリオ案を自動生成します。思いつかない場合は「おまかせ」と入力してください。
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <button
              onClick={handleManualScenario}
              disabled={generatingScenario || scenarioSending}
              className="rounded-full border border-dashed border-rose-200 px-3 py-1 font-medium text-rose-400 hover:border-rose-400 hover:text-rose-500 disabled:opacity-60"
            >
              手動入力に切り替える
            </button>
          </div>
          <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            タイトル
          </label>
          <input
            value={scenarioTitle}
            onChange={(event) => setScenarioTitle(event.target.value)}
            placeholder="例: 眠れない夜の相談室"
            className="mt-1 w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-rose-300 focus:outline-none focus:ring-2 focus:ring-rose-200 dark:border-zinc-700 dark:bg-[#141425] dark:text-zinc-100 dark:focus:border-purple-500 dark:focus:ring-purple-500/40"
            disabled={generatingScenario}
          />
          {scenarioError && (
            <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:border-rose-500/40 dark:bg-rose-900/20 dark:text-rose-200">
              {scenarioError}
            </div>
          )}
          {(draftScenario || scenarioManualMode || scenarioEditorText.trim()) && (
            <div className="mt-5 space-y-3 rounded-2xl border border-rose-100 bg-white px-4 py-3 text-sm text-zinc-700 dark:border-rose-400/30 dark:bg-[#19192a] dark:text-zinc-200">
              <div className="text-xs font-semibold uppercase tracking-wide text-rose-500">
                生成されたシナリオ
              </div>
              <div className="text-base font-semibold text-zinc-800 dark:text-zinc-100">
                {draftScenario
                  ? draftScenario.title === "おまかせ"
                    ? "おまかせ生成"
                    : draftScenario.title
                  : scenarioTitle.trim()
                  ? scenarioTitle.trim()
                  : "おまかせ入力"}
              </div>
              <textarea
                value={scenarioEditorText}
                onChange={(event) => setScenarioEditorText(event.target.value)}
                rows={8}
                className="w-full resize-y rounded-2xl border border-rose-200 bg-white px-3 py-2 text-sm leading-relaxed focus:border-rose-300 focus:outline-none focus:ring-2 focus:ring-rose-200 dark:border-rose-500/40 dark:bg-[#141425] dark:text-zinc-100 dark:focus:border-purple-500 dark:focus:ring-purple-500/40"
                placeholder="ここにシナリオ本文を入力・編集できます。"
                disabled={scenarioSending || sending}
              />
              {scenarioSendError && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:border-rose-500/40 dark:bg-rose-900/20 dark:text-rose-200">
                  {scenarioSendError}
                </div>
              )}
              <div className="flex justify-end">
                <button
                  onClick={() => sendScenarioToChat(draftScenario ?? undefined)}
                  disabled={scenarioSending || sending}
                  className="rounded-full bg-rose-500 px-4 py-2 text-xs font-semibold text-white shadow hover:bg-rose-600 disabled:opacity-60"
                >
                  {scenarioSending || sending ? "送信中…" : "チャットに送る"}
                </button>
              </div>
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2 text-sm">
            <button
              onClick={handleCloseScenarioModal}
              disabled={generatingScenario || scenarioSending}
              className="rounded-full border border-zinc-300 px-4 py-2 font-medium text-zinc-600 hover:border-zinc-400 hover:text-zinc-700 disabled:opacity-60 dark:border-zinc-600 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:text-zinc-100"
            >
              キャンセル
            </button>
            <button
              onClick={handleGenerateScenario}
              disabled={generatingScenario}
              className="rounded-full bg-rose-500 px-4 py-2 font-semibold text-white shadow hover:bg-rose-600 disabled:opacity-60"
            >
              {generatingScenario ? "生成中…" : "生成する"}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
};

export default App;
