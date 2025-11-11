import React, { useCallback, useMemo, useState } from "react";

type ChatMessage = {
  id: string;
  role: "user" | "model" | "system";
  text: string;
};

const createId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
};

export default function LlmGatewayPanel() {
  const [bffUrl, setBffUrl] = useState("");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);

  const normalizedUrl = useMemo(() => bffUrl.trim().replace(/\/+$/, ""), [bffUrl]);

  const sendMessage = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      alert("テキストを入力してください");
      return;
    }
    if (!normalizedUrl) {
      alert("BFF の URL を入力してください");
      return;
    }

    const userEntry: ChatMessage = { id: createId(), role: "user", text: trimmed };
    setMessages((prev) => [...prev, userEntry]);
    setSending(true);
    setText("");

    try {
      const response = await fetch(`${normalizedUrl}/llm/gateway`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });

      if (!response.ok) {
        const fallback = await response.text().catch(() => "");
        throw new Error(`LLM Gateway error: ${response.status} ${fallback}`);
      }

      const payload = await response.json();
      const replyText = typeof payload.reply === "string" ? payload.reply.trim() : "";
      const messageText = replyText || "⚠ 応答が空でした";
      const aiEntry: ChatMessage = {
        id: createId(),
        role: "model",
        text: messageText,
      };
      setMessages((prev) => [...prev, aiEntry]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setMessages((prev) => [
        ...prev,
        {
          id: createId(),
          role: "system",
          text: `⚠ エラー発生: ${errorMessage}`,
        },
      ]);
    } finally {
      setSending(false);
    }
  }, [normalizedUrl, text]);

  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void sendMessage();
    }
  };

  return (
    <section className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-lg dark:border-zinc-700 dark:bg-[#101022]">
      <div className="flex flex-col gap-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            LLM Gateway
          </div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            /llm/gateway テストコンソール
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Cloud Run の BFF URL を入力して、LLM Gateway API に直接アクセスできます。
          </p>
        </div>

        <label className="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
          BFF URL
        </label>
        <input
          value={bffUrl}
          onChange={(event) => setBffUrl(event.target.value)}
          placeholder="https://izakaya-bff-xxxx.run.app"
          className="w-full rounded-2xl border border-zinc-300 px-3 py-2 text-sm focus:border-rose-300 focus:outline-none focus:ring-2 focus:ring-rose-200 dark:border-zinc-700 dark:bg-[#141425] dark:text-zinc-100 dark:focus:border-purple-500 dark:focus:ring-purple-500/40"
        />

        <label className="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
          メッセージ
        </label>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          placeholder="LLMに送る内容を入力してください…"
          onKeyDown={handleKeyDown}
          className="w-full rounded-2xl border border-zinc-300 px-3 py-2 text-sm focus:border-rose-300 focus:outline-none focus:ring-2 focus:ring-rose-200 dark:border-zinc-700 dark:bg-[#141425] dark:text-zinc-100 dark:focus:border-purple-500 dark:focus:ring-purple-500/40"
        />
        <div className="flex justify-end gap-3 text-sm">
          <button
            onClick={() => {
              setMessages([]);
              setText("");
            }}
            className="rounded-full border border-zinc-300 px-4 py-2 font-medium text-zinc-600 hover:border-zinc-400 hover:text-zinc-800 dark:border-zinc-600 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:text-zinc-100"
          >
            リセット
          </button>
          <button
            onClick={() => void sendMessage()}
            disabled={sending}
            className="rounded-full bg-rose-500 px-4 py-2 font-semibold text-white shadow hover:bg-rose-600 disabled:opacity-60"
          >
            {sending ? "送信中…" : "送信"}
          </button>
        </div>

        <div className="rounded-2xl border border-zinc-100 bg-zinc-50 p-3 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-[#141425] dark:text-zinc-200">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            レスポンス
          </div>
          <div className="space-y-3">
            {messages.length === 0 ? (
              <p className="text-sm text-zinc-500">送信結果がここに表示されます。</p>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={`rounded-2xl border px-3 py-2 text-sm ${
                    message.role === "user"
                      ? "border-zinc-200 bg-white dark:border-zinc-600 dark:bg-[#181828]"
                      : message.role === "model"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-900/20 dark:text-emerald-200"
                      : "border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-500/40 dark:bg-rose-900/20 dark:text-rose-200"
                  }`}
                >
                  <div className="text-xs font-semibold uppercase tracking-wide">
                    {message.role === "user" ? "User" : message.role === "model" ? "AI" : "System"}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap leading-relaxed">{message.text}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
