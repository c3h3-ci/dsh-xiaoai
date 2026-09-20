/**
 * DSH 桥接层 —— 把语音文字注入 DSH 会话，取回最终回复。
 *
 * 事件流（已从真实 session log 验证）：
 *   user/message → turn/start → step/start → assistant/chunk* → assistant/message
 *                → step/end → turn/end
 *
 * 用 `agent.followup()` 注入用户消息，收集 `assistant/message`，
 * 在 `turn/end` 时收尾。
 */

/** 从任意消息/事件载荷里抽取纯文本。 */
export function extractText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).filter(Boolean).join("");
  if (typeof node !== "object") return "";

  for (const key of ["text", "content", "parts", "message"]) {
    if (key in node) {
      const t = extractText(node[key]);
      if (t) return t;
    }
  }
  return "";
}

export class SessionBridge {
  #agent = null;
  #offs = [];

  constructor({ ctx, cwd, sessionId, logger }) {
    this.ctx = ctx;
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.log = logger ?? (() => {});
  }

  /** 建立（或复用）专用会话。 */
  async connect() {
    const created = await this.ctx.agents.create({
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      meta: { cwd: this.cwd },
    });
    this.#agent = created.agent;
    this.sessionId = this.#agent.id ?? this.sessionId;
    this.log(`会话就绪: ${this.sessionId}`);
    return this.#agent;
  }

  get agent() {
    return this.#agent;
  }

  get busy() {
    return this.#agent?.status === "running";
  }

  /**
   * 发一条用户消息，等本轮结束，返回助手最终文本。
   * @param {string} text
   * @param {number} [timeoutMs]
   */
  async ask(text, timeoutMs = 240_000) {
    if (!this.#agent) throw new Error("会话未建立");
    if (this.busy) throw new Error("会话正忙，忽略本次语音");

    const chunks = [];
    const finished = Promise.withResolvers();
    const agent = this.#agent;

    const offEvent =
      this.ctx.on?.("session/event", (subject, event) => {
        if (subject !== agent.session && subject?.id !== this.sessionId) return;
        const type = String(event?.type ?? "");
        if (type === "assistant/message") {
          const t = extractText(event.data);
          if (t) chunks.push(t);
        } else if (type === "turn/end") {
          finished.resolve();
        }
      }) ?? (() => {});

    const offStatus =
      agent.on?.("agent/status", ({ status }) => {
        if (status === "idle") finished.resolve();
      }) ?? (() => {});

    const timer = setTimeout(() => finished.resolve(), timeoutMs);
    try {
      agent.followup({ role: "user", content: text });
      await finished.promise;
      // 给事件流一点时间把最后一条 assistant 消息落地
      await new Promise((r) => setTimeout(r, 800));
    } finally {
      clearTimeout(timer);
      offEvent();
      offStatus();
    }

    return chunks.join("\n").trim();
  }

  dispose() {
    for (const off of this.#offs) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.#offs = [];
  }
}
