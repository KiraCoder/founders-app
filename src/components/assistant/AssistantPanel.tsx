"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";

/**
 * The AI assistant drawer (right side on desktop, full screen on phones). Opened with Ctrl/⌘+J
 * from anywhere, or the shell button. Writes always come as a card: nothing is saved until the
 * founder presses its button (the server checks the card's one-time token).
 */

export interface ActionView {
  id: string;
  tool: string;
  title: string;
  fields: { label: string; value: string }[];
  confirm: string;
  status: string;
  result: string | null;
  token?: string;
}

export interface ChatMessageView {
  id: string;
  role: "user" | "assistant" | "action" | "error" | "cmd" | "local";
  text: string;
  createdAt: string;
  action?: ActionView;
}

export const OPEN_EVENT = "assistant:open";

const TOKENS_KEY = "assistant-card-tokens";

function loadTokens(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(TOKENS_KEY) ?? "{}") as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

function saveTokens(t: Record<string, string>) {
  try {
    sessionStorage.setItem(TOKENS_KEY, JSON.stringify(t));
  } catch {
    /* private mode: tokens live in memory only */
  }
}

/** Plain text with [label](/path) links (relative or http(s) only) and line breaks. */
export function RichText({
  text,
  onNavigate,
}: {
  text: string;
  onNavigate?: () => void;
}) {
  const parts: React.ReactNode[] = [];
  const re = /\[([^\]]{1,200})\]\(((?:\/|https?:\/\/)[^)\s]{0,500})\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last)
      parts.push(<Fragment key={i++}>{text.slice(last, m.index)}</Fragment>);
    const href = m[2]!;
    parts.push(
      href.startsWith("/") ? (
        <Link
          key={i++}
          href={href}
          onClick={onNavigate}
          className="text-accent hover:underline"
        >
          {m[1]}
        </Link>
      ) : (
        <a
          key={i++}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent hover:underline"
        >
          {m[1]}
        </a>
      ),
    );
    last = m.index + m[0].length;
  }
  if (last < text.length)
    parts.push(<Fragment key={i++}>{text.slice(last)}</Fragment>);
  return <span className="whitespace-pre-wrap break-words">{parts}</span>;
}

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  done: { label: "Saved", cls: "tag-ok" },
  cancelled: { label: "Cancelled", cls: "" },
  failed: { label: "Not saved", cls: "tag-risk" },
  expired: { label: "Expired — ask again", cls: "tag-warn" },
  running: { label: "Saving…", cls: "tag-info" },
};

function ActionCard({
  a,
  token,
  busy,
  onDecide,
  onChange,
  onNavigate,
}: {
  a: ActionView;
  token: string | undefined;
  busy: boolean;
  onDecide: (decision: "confirm" | "cancel") => void;
  onChange: () => void;
  onNavigate: () => void;
}) {
  const pending = a.status === "pending";
  const st = STATUS_LABEL[a.status];
  return (
    <div className="card w-full p-3 text-[13px]" data-testid="assistant-card">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold">{a.title}</span>
        {st && <span className={`tag ml-auto ${st.cls}`}>{st.label}</span>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {a.fields.map((f, i) => (
          <Fragment key={i}>
            <dt className="text-muted">{f.label}</dt>
            <dd className="whitespace-pre-wrap break-words">{f.value}</dd>
          </Fragment>
        ))}
      </dl>
      {a.result && (
        <p
          className={`mt-2 text-[12px] ${a.status === "failed" ? "text-risk" : "text-muted"}`}
        >
          <RichText text={a.result.split("\n")[0]!} onNavigate={onNavigate} />
        </p>
      )}
      {pending &&
        (token ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => onDecide("confirm")}
            >
              {a.confirm}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={onChange}
            >
              Change
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => onDecide("cancel")}
            >
              Cancel
            </button>
          </div>
        ) : (
          <p className="mt-2 text-[12px] text-muted">
            Opened in another tab — ask again here to get a fresh card.
          </p>
        ))}
    </div>
  );
}

export function AssistantPanel() {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [busyCard, setBusyCard] = useState<string | null>(null);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rememberTokens = useCallback((msgs: ChatMessageView[]) => {
    const fresh = msgs
      .filter((m) => m.action?.token)
      .map((m) => [m.action!.id, m.action!.token!] as const);
    if (!fresh.length) return;
    setTokens((t) => {
      const next = { ...t, ...Object.fromEntries(fresh) };
      saveTokens(next);
      return next;
    });
  }, []);

  // Ctrl/⌘+J anywhere (also while typing), the shell button (custom event), Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "j"
      ) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") setOpen(false);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    if (loaded) return;
    setTokens(loadTokens());
    fetch("/api/v1/assistant")
      .then((r) => r.json())
      .then(
        (j: {
          data?: {
            configured: boolean;
            notice: string | null;
            messages: ChatMessageView[];
          };
        }) => {
          if (!j.data) return;
          setMessages(j.data.messages);
          setConfigured(j.data.configured);
          setNotice(j.data.notice);
          setLoaded(true);
        },
      )
      .catch(() => setNotice("Couldn't load the chat. Try again."));
  }, [open, loaded]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, open]);

  const send = async (raw?: string) => {
    const t = (raw ?? text).trim();
    if (!t || sending) return;
    setSending(true);
    setText("");
    const temp: ChatMessageView = {
      id: `tmp-${Date.now()}`,
      role: "user",
      text: t,
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, temp]);
    try {
      const res = await fetch("/api/v1/assistant/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t }),
      });
      const j = (await res.json()) as {
        data?: { messages: ChatMessageView[]; notice: string | null };
        error?: { message: string };
      };
      if (!j.data) throw new Error(j.error?.message ?? "Request failed");
      rememberTokens(j.data.messages);
      setMessages((m) => [
        ...m.filter((x) => x.id !== temp.id),
        ...j.data!.messages,
      ]);
      if (j.data.notice) setNotice(j.data.notice);
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          id: `err-${Date.now()}`,
          role: "error",
          text: err instanceof Error ? err.message : "Something went wrong",
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const decide = async (a: ActionView, decision: "confirm" | "cancel") => {
    const token = tokens[a.id];
    if (!token) return;
    setBusyCard(a.id);
    try {
      const res = await fetch(`/api/v1/assistant/actions/${a.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, decision }),
      });
      const j = (await res.json()) as {
        data?: ActionView;
        error?: { message: string };
      };
      const updated: ActionView = j.data ?? {
        ...a,
        status: "failed",
        result: j.error?.message ?? "Not saved",
      };
      setMessages((m) =>
        m.map((x) => (x.action?.id === a.id ? { ...x, action: updated } : x)),
      );
    } finally {
      setBusyCard(null);
    }
  };

  const change = async (a: ActionView) => {
    await decide(a, "cancel");
    setText("Change it: ");
    inputRef.current?.focus();
  };

  const clear = async () => {
    if (
      !window.confirm(
        "Clear the whole chat? Cards not yet saved are cancelled.",
      )
    )
      return;
    await fetch("/api/v1/assistant", { method: "DELETE" });
    setMessages([]);
    setTokens({});
    saveTokens({});
  };

  const close = () => setOpen(false);

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost px-2.5"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="assistant-panel"
        title="AI assistant (Ctrl/⌘ J)"
      >
        <Icon name="sparkles" />
        <span className="hidden sm:inline">Ask AI</span>
      </button>

      {/* Rendered into <body>: the top bar uses backdrop-blur, which would trap "fixed" children inside the
          56px header (the drawer then showed up squeezed into the top bar). */}
      {mounted &&
        createPortal(
          <>
            {open && (
              <div
                className="fixed inset-0 z-40 hidden bg-black/20 md:block"
                onClick={close}
                aria-hidden="true"
              />
            )}
            {/* Clip box: the closed drawer sits off-screen to the right; without this it widened the page on phones. */}
            <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
              <aside
                id="assistant-panel"
                aria-label="AI assistant"
                aria-hidden={!open}
                className={`absolute inset-0 flex flex-col bg-surface transition-transform duration-200 md:inset-y-0 md:left-auto md:right-0 md:w-[420px] md:border-l md:border-line md:shadow-card ${
                  open
                    ? "pointer-events-auto translate-x-0"
                    : "invisible translate-x-full"
                }`}
              >
                <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
                  <Icon name="sparkles" />
                  <span className="font-semibold">Assistant</span>
                  <kbd className="hidden rounded border border-line bg-sunk px-1.5 py-0.5 text-[10px] text-muted md:inline">
                    Ctrl/⌘ J
                  </kbd>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm ml-auto"
                    onClick={clear}
                    disabled={!messages.length}
                  >
                    Clear chat
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost px-2"
                    onClick={close}
                    aria-label="Close assistant"
                  >
                    <Icon name="close" />
                  </button>
                </div>

                {notice && (
                  <div
                    role="status"
                    className="mx-4 mt-3 rounded-[10px] border border-line bg-sunk p-3 text-[12px]"
                    data-testid="assistant-notice"
                  >
                    {notice}
                  </div>
                )}

                <div
                  ref={listRef}
                  className="flex flex-1 flex-col gap-2 overflow-y-auto p-4"
                >
                  {loaded && messages.length === 0 && (
                    <div className="text-[13px] text-muted">
                      <p>
                        Ask in English, Russian or Kyrgyz — typos are fine.
                        Examples:
                      </p>
                      <ul className="mt-1 list-disc pl-5">
                        <li>What&apos;s overdue for Elmurat?</li>
                        <li>Did Asan finish today&apos;s checklist?</li>
                        <li>
                          Элмурат каждый день в 15:00 вносит 1С, чеклист: Kiwi,
                          Upsell
                        </li>
                      </ul>
                      <p className="mt-2">
                        I show a card before saving anything. Quick commands:
                        /tasks, /overdue, /routines, /help.
                      </p>
                    </div>
                  )}
                  {messages.map((m) =>
                    m.action ? (
                      <ActionCard
                        key={m.id}
                        a={m.action}
                        token={tokens[m.action.id]}
                        busy={busyCard === m.action.id}
                        onDecide={(d) => decide(m.action!, d)}
                        onChange={() => change(m.action!)}
                        onNavigate={close}
                      />
                    ) : (
                      <div
                        key={m.id}
                        className={`max-w-[85%] rounded-[12px] px-3 py-2 text-[13px] ${
                          m.role === "user" || m.role === "cmd"
                            ? "self-end bg-accent text-accent-ink"
                            : m.role === "error"
                              ? "self-start border border-line bg-sunk text-risk"
                              : "self-start bg-sunk"
                        }`}
                      >
                        <RichText text={m.text} onNavigate={close} />
                      </div>
                    ),
                  )}
                  {sending && (
                    <div className="self-start rounded-[12px] bg-sunk px-3 py-2 text-[13px] text-muted">
                      Thinking…
                    </div>
                  )}
                </div>

                <form
                  className="flex shrink-0 items-end gap-2 border-t border-line p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <textarea
                    ref={inputRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    rows={2}
                    maxLength={2000}
                    placeholder={
                      configured
                        ? "Ask or tell me what to do…"
                        : "Quick commands work: /tasks, /overdue, /routines"
                    }
                    aria-label="Message the assistant"
                    className="input min-h-[44px] flex-1 resize-none py-2"
                  />
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={sending || !text.trim()}
                  >
                    Send
                  </button>
                </form>
              </aside>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
