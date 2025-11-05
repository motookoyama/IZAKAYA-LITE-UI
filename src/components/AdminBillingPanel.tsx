import React, { useEffect, useState } from "react";

type PricingItem = {
  id: string;
  name: string;
  cost: number;
};

function resolveBffBaseUrl(): string {
  const raw =
    (import.meta.env.VITE_REACT_APP_BFF_URL as string | undefined) ||
    (import.meta.env.VITE_BFF_URL as string | undefined) ||
    (import.meta.env.REACT_APP_BFF_URL as string | undefined);
  const fallback = "http://localhost:4117";
  const selected = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : fallback;
  return selected.replace(/\/+$/, "");
}

const BFF_BASE_URL = resolveBffBaseUrl();

export default function AdminBillingPanel() {
  const [pricing, setPricing] = useState<PricingItem[]>([]);
  const [newItem, setNewItem] = useState<PricingItem>({ id: "", name: "", cost: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPricing = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${BFF_BASE_URL}/wallet/pricing`);
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `HTTP ${response.status}`);
      }
      const data = (await response.json()) as PricingItem[];
      setPricing(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const updateCost = async (id: string, cost: number) => {
    try {
      await fetch(`${BFF_BASE_URL}/wallet/pricing/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, cost }),
      });
      alert("保存しました");
      loadPricing();
    } catch (err) {
      alert(`保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const addContent = async () => {
    if (!newItem.id || !newItem.name) {
      alert("ID と 名称 を入力してください");
      return;
    }
    try {
      await fetch(`${BFF_BASE_URL}/wallet/pricing/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newItem),
      });
      alert("追加しました");
      setNewItem({ id: "", name: "", cost: 0 });
      loadPricing();
    } catch (err) {
      alert(`追加に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  useEffect(() => {
    loadPricing();
  }, []);

  return (
    <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-700 dark:bg-[#0f0f19]">
      <h2 className="mb-4 text-lg font-semibold text-zinc-800 dark:text-zinc-100">ポイント管理パネル</h2>
      {loading && <p className="text-sm text-zinc-500">読み込み中…</p>}
      {error && <p className="text-sm text-rose-500">エラー: {error}</p>}

      <div className="space-y-4">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">コンテンツ一覧（消費ポイント）</h3>
          <div className="space-y-2">
            {pricing.map((item) => (
              <div key={item.id} className="flex items-center gap-3 text-sm">
                <div className="min-w-[160px] text-zinc-700 dark:text-zinc-200">
                  {item.name} <span className="text-xs text-zinc-500">(id: {item.id})</span>
                </div>
                <input
                  type="number"
                  defaultValue={item.cost}
                  className="w-24 rounded border border-zinc-300 px-2 py-1 text-right dark:border-zinc-600 dark:bg-[#141425] dark:text-zinc-100"
                  onBlur={(e) => updateCost(item.id, Number(e.target.value))}
                />
                <span className="text-xs text-zinc-500">pt</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">新規コンテンツの追加</h3>
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <input
              placeholder="ID"
              value={newItem.id}
              onChange={(e) => setNewItem((prev) => ({ ...prev, id: e.target.value }))}
              className="w-32 rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-[#141425] dark:text-zinc-100"
            />
            <input
              placeholder="名称"
              value={newItem.name}
              onChange={(e) => setNewItem((prev) => ({ ...prev, name: e.target.value }))}
              className="w-48 rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-[#141425] dark:text-zinc-100"
            />
            <input
              type="number"
              placeholder="cost"
              value={newItem.cost}
              onChange={(e) => setNewItem((prev) => ({ ...prev, cost: Number(e.target.value) }))}
              className="w-24 rounded border border-zinc-300 px-2 py-1 text-right dark:border-zinc-600 dark:bg-[#141425] dark:text-zinc-100"
            />
            <button
              onClick={addContent}
              className="rounded bg-emerald-500 px-4 py-1 text-sm font-semibold text-white shadow hover:bg-emerald-600"
            >
              追加
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
