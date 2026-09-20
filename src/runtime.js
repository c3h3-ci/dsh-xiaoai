/**
 * XIAOAI_RUNTIME —— 插件的服务端单例。
 *
 * 职责：
 *   - 持有 XiaomiSpeaker 连接
 *   - 运行轮询循环（语音 → DSH → TTS）
 *   - 维护可观测状态（供 UI 展示）
 *   - 从 DSH settings 读取配置（带默认值）
 *
 * 不负责：UI、RPC 注册、插件生命周期（那在 src/index.js）。
 * 契约见 contract/INTERFACE.md
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, realpathSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { resolveMiStorePath } from "./bootstrap.js";   // 必须最先：见该文件头部说明
import { randomUUID } from "node:crypto";
import { XiaomiSpeaker } from "./xiaomi.js";
import { mergeFreshTokens } from "./token-refresh.js";

/** 设置默认值（契约 §2）。 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  userId: "",
  password: "",
  did: "",
  pollIntervalMs: 4000,
  replyTimeoutMs: 240000,
  maxReplyChars: 400,
  triggerKeywords: [],
  ignorePatterns: ["^小爱同学$"],
  dshApiUrl: "http://127.0.0.1:3082/api/session",
  dshApiToken: process.env.DSH_API_TOKEN ?? "",
  verboseLog: false,
  // ── 会话绑定（见 src/index.js 的 buildSettingsSchema） ──
  workspace: "",
  agentPreset: "",
  provider: "",
  model: "",
  sessionReuse: true,
  // ── 音箱侧：唤醒与 AI 模式（参考 MiGPT v4.2.0） ──
  //
  // 三类关键词语义不同，别混用：
  //   callAIKeywords —— 「直接问」：命中即刻交 DSH，不改变模式
  //   wakeUpKeywords —— 「进入 AI 模式」：之后所有话都交 DSH，无需重复喊
  //   exitKeywords   —— 「退出 AI 模式」：回到 idle，普通话不再处理
  aiModeEnabled: true,
  callAIKeywords: [],
  wakeUpKeywords: [],
  exitKeywords: [],
  exitKeepAliveAfter: 30,
  /** 本地快速路径：音量/时间/停止这类高频指令本机处理，不走 LLM。 */
  localCommandsEnabled: true,
  // ── 提示语（空数组 = 不播报）──
  onEnterAI: ["AI模式已开启"],
  onExitAI: ["已退出AI模式"],
  onAIAsking: ["让我想想"],
  onAIReplied: [],
  /** 长任务进度安抚语（任务超过 progressAfterSeconds 秒未完成时播一次）。 */
  onAIProgress: ["还在处理，请稍等一下"],
  /** 多久没结果就播进度语（秒，最小 10）。 */
  progressAfterSeconds: 35,
  /** 保留多少轮对话历史（供 UI 查看）。 */
  historyLimit: 20,
  onAIError: ["抱歉，出错了"],
  // ── 分类错误提示（按错误类型播报，比笼统的「出错了」有用得多）──
  // 未配置时回退到 onAIError。
  onAIErrorNetwork: ["网络好像不太好，等一下再试试"],
  onAIErrorAuth: ["小米账号可能需要重新登录，请在设置面板检查"],
  onAIErrorTimeout: ["这个问题有点复杂，我还没想完，请再问一次"],
});

/**
 * DSH 默认 IM 工作区 —— 与官方 dsh-im 的 `defaultImWorkspace()` 对齐
 * （`src/channels/shared/default-workspace.mjs:5-8` 是 `resolve(dshHome, "im")`）。
 *
 * 为什么不用旧的 `~/.dsh/xiaoai-workspace`：
 *   1) 那个目录是插件自己造的，用户从 DSH Web 的会话列表里根本看不到它，
 *      于是 UI 显示「工作目录未知」—— 正是本次要修的症状之一；
 *   2) `~/.dsh/im` 是 DSH 的约定式"无工作区"落点（ungrouped workspace），
 *      任何没有显式工作区的入口（webhook / im）都落在那里，
 *      语音会话落在同一处，用户在 UI 里一眼能找到。
 */
function defaultImWorkspace(dshHome = process.env.DSH_HOME ?? "/data/dsh") {
  return `${dshHome.replace(/\/+$/, "")}/im`;
}

/** 会话状态文件名（放在 stateDir 下，与 xiaoai-lasttime.json 同级）。 */
const SESSION_STATE_FILE = "session.json";

/** 会话复用 key。音箱无"发件人"概念，因此按语音通道做单例。 */
function sessionKeyFor(did) {
  return `xiaoai:${did || "default"}`;
}

/** 轮询间隔下限，避免打爆小米接口（见 runtime 硬化报告）。 */
const MIN_POLL_MS = 2000;


/** 日志文件超过该字节数就轮转（保留最近一半），避免无限增长。 */
const LOG_ROTATE_BYTES = 1024 * 1024;

/** 从会话事件的任意载荷里抽取纯文本。 */
function extractText(node) {
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

export class XiaoaiRuntime {
  #speaker = null;
  #loop = null;
  #stopped = true;
  #config = { ...DEFAULTS };
  #logLines = [];
  #lastTime = 0;
  #lastTimeFile = null;
  #firstPoll = true;
  #seen = new Set();
  #onStatus = null;
  #settingsScope = null;
  #consecutiveErrors = 0;
  #generation = 0;
  #sleepResolve = null;
  #sleepTimer = null;
  #startChain = null;
  #restartTimes = [];
  #restartFailures = 0;
  #logFile = null;
  #logBytes = 0;
  #askChain = null;
  #miStorePath = null;
  #agentCtx = null;
  #agentCwd = null;
  #agent = null;
  #diagEvents = 0;
  #stateDir = null;
  #sessionFile = null;
  /** 本次进程实际绑定成功的 sessionId（落盘用）。 */
  #boundSessionId = null;
  /** 本次进程实际 attach 的 workspaceId（诊断用）。 */
  #boundWorkspaceId = null;
  /** 本次进程使用的对话 key（诊断/落盘用）。 */
  #conversationKey = null;

  // ── 音箱侧：AI 模式状态机（见 #resolveIntent / #advanceAiMode）──
  /** 当前模式："idle" | "active" | "thinking" | "replying"。 */
  #aiMode = "idle";
  /** 「无对话自动退出」的倒计时句柄。 */
  #keepAliveTimer = null;

  /** 对话历史环形缓冲（元素 {query, reply, at}）。 */
  #history = [];
  /** 保留多少轮（见 DEFAULTS.historyLimit）。 */
  #historyLimit = 20;

  constructor({ logger, stateDir } = {}) {
    this.logger = logger ?? ((m) => console.log(`[xiaoai] ${m}`));
    // 插件版本只往内存 + console 写日志，文件里什么都没有 —— 而 DSH 的
    // stdout 会被 run.sh 用 `>` 截断重定向，导致「出事后无处可查」。
    // 这里额外落一份到持久化文件，与内存环形缓冲互补（内存只有最近 500 条）。
    this.#logFile = stateDir ? `${stateDir}/xiaoai.log` : null;
    this.#lastTimeFile = stateDir ? `${stateDir}/xiaoai-lasttime.json` : null;
    this.#stateDir = stateDir ?? null;
    this.#sessionFile = stateDir ? `${stateDir}/${SESSION_STATE_FILE}` : null;
    // ⚠️ 必须用 bootstrap 的同一个解析函数：vendored 库在 import 时就把
    // XIAOAI_MI_STORE 定死了，若这里算出另一个路径，storePathHonored 会为 false
    // → connect 抛错 →（token 已刷新）→ 触发无限重启。台式DSH 死机就是这么来的。
    this.#miStorePath = resolveMiStorePath();
    this.status = {
      phase: "stopped",
      lastError: null,
      speaker: { connected: false, name: null, model: null, did: null },
      dsh: { reachable: false },
      lastHeard: null,
      lastReply: null,
      /** 最近若干轮对话（环形，供 UI 查看/复制）。 */
      history: [],
      lastSpokenAt: null,
      handledCount: 0,
      consecutiveErrors: 0,
      /** 音箱侧模式：idle | active | thinking | replying（供 UI 展示）。 */
      aiMode: "idle",
      sessionId: null,
      workspaceId: null,
      workspacePath: null,
      boundVia: null,
      startedAt: null,
    };
  }

  // ───────────────────────── 日志 ─────────────────────────

  log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    this.#logLines.push(line);
    if (this.#logLines.length > 500) this.#logLines = this.#logLines.slice(-300);
    this.logger(msg);
    // 落盘：失败不能影响主流程（磁盘满/权限问题都只忽略）
    if (this.#logFile) {
      try {
        if (this.#logBytes > LOG_ROTATE_BYTES) {
          // 简单轮转：超过 1MB 就保留最后一半，避免无限增长
          const kept = this.#logLines.slice(-150).join("\n") + "\n";
          writeFileSync(this.#logFile, kept);
          this.#logBytes = Buffer.byteLength(kept);
        }
        appendFileSync(this.#logFile, line + "\n");
        this.#logBytes += Buffer.byteLength(line) + 1;
      } catch {
        /* 日志落盘失败不影响插件运行 */
      }
    }
  }

  getLogs(limit = 100) {
    return this.#logLines.slice(-Math.max(1, Math.min(limit, 500)));
  }

  // ───────────────────── 状态订阅（给 UI） ─────────────────────

  /** 注册状态变更回调；返回取消函数。 */
  onStatus(cb) {
    this.#onStatus = cb;
    return () => {
      if (this.#onStatus === cb) this.#onStatus = null;
    };
  }

  #emit() {
    try {
      this.#onStatus?.(this.status);
    } catch {
      /* UI 回调异常不影响运行时 */
    }
  }

  #patch(partial) {
    Object.assign(this.status, partial);
    this.#emit();
  }

  // ───────────────────────── 配置 ─────────────────────────

  /** 绑定 DSH settings scope；之后 applyConfig() 会从中读取。 */
  bindSettings(scope) {
    this.#settingsScope = scope;
  }

  /** 从 settings scope 读取配置并缓存。 */
  applyConfig() {
    if (!this.#settingsScope) return this.#config;
    const raw = this.#settingsScope.get?.() ?? {};
    const next = { ...DEFAULTS, ...raw };
    next.pollIntervalMs = Math.max(MIN_POLL_MS, Number(next.pollIntervalMs) || DEFAULTS.pollIntervalMs);
    next.replyTimeoutMs = Math.max(5000, Number(next.replyTimeoutMs) || DEFAULTS.replyTimeoutMs);
    next.maxReplyChars = Math.max(20, Number(next.maxReplyChars) || DEFAULTS.maxReplyChars);
    if (!Array.isArray(next.triggerKeywords)) next.triggerKeywords = [];
    if (!Array.isArray(next.ignorePatterns)) next.ignorePatterns = DEFAULTS.ignorePatterns;
    this.#config = next;
    return next;
  }

  get config() {
    return this.#config;
  }

  // ─────────────── 断点持久化（防冷启动重放，REPORT §8） ───────────────

  #loadLastTime() {
    if (!this.#lastTimeFile) return 0;
    try {
      const raw = JSON.parse(readFileSync(this.#lastTimeFile, "utf8"));
      return Number(raw?.lastTime) || 0;
    } catch {
      return 0;
    }
  }

  #saveLastTime() {
    if (!this.#lastTimeFile) return;
    try {
      mkdirSync(dirname(this.#lastTimeFile), { recursive: true });
      writeFileSync(this.#lastTimeFile, JSON.stringify({ lastTime: this.#lastTime }));
    } catch (err) {
      this.log(`断点保存失败: ${err?.message ?? err}`);
    }
  }

  // ───────────────────── 会话状态持久化（重启复用） ─────────────────────
  //
  // 旧实现把 sessionId 只放在内存（this.status.sessionId），进程一重启就丢，
  // 于是每次重启都新建一个语音会话 —— 上下文清零、UI 里堆一串孤儿会话。
  //
  // 结构对齐 dsh-im 的 state.json（`conversation-state-store.mjs:13-40`）：
  //   { "version": 1, "sessions": { "xiaoai:<did>": "session-xxx" } }
  // 写入是原子的（.tmp + rename），避免半截文件把下次启动带崩。

  #loadSessionState() {
    if (!this.#sessionFile) return { version: 1, sessions: {} };
    try {
      const raw = JSON.parse(readFileSync(this.#sessionFile, "utf8"));
      const sessions = raw?.sessions && typeof raw.sessions === "object" ? raw.sessions : {};
      return { version: 1, sessions };
    } catch {
      return { version: 1, sessions: {} };
    }
  }

  #saveSessionState(state) {
    if (!this.#sessionFile) return;
    const tmp = `${this.#sessionFile}.tmp`;
    try {
      mkdirSync(dirname(this.#sessionFile), { recursive: true });
      writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      renameSync(tmp, this.#sessionFile);
    } catch (err) {
      this.log(`会话状态保存失败: ${err?.message ?? err}`);
    }
  }

  /** 读回该对话 key 上次绑定的 sessionId（无则 null）。 */
  #storedSessionId(key) {
    if (!this.#config.sessionReuse) return null;
    const id = this.#loadSessionState().sessions?.[key];
    return typeof id === "string" && id ? id : null;
  }

  /** 记住 key → sessionId 的绑定。 */
  #storeSessionId(key, sessionId) {
    const state = this.#loadSessionState();
    state.sessions = { ...state.sessions, [key]: sessionId };
    this.#saveSessionState(state);
  }

  /** 探活：该 sessionId 在本进程里是否还活着（Host 的活会话表）。 */
  #sessionAlive(sessionId) {
    try {
      const agents = this.#agentCtx?.agents;
      // AgentRegistry.get(id) 返回 live agent 或 undefined —— 最轻的探活方式。
      if (agents && typeof agents.get === "function") return Boolean(agents.get(sessionId));
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 解析本次使用的工作区目录（绝对路径）。
   *
   * 优先级：settings.workspace > 环境变量 DSH_XIAOAI_CWD > 默认 IM 工作区。
   */
  #resolveWorkspacePath() {
    const configured = String(this.#config.workspace ?? "").trim();
    if (configured) return resolvePath(configured);
    if (this.#agentCwd) return resolvePath(this.#agentCwd);
    return defaultImWorkspace();
  }

  // ───────────────────── DSH 调用（首选 in-process agent） ─────────────────────

  /**
   * 绑定 DSH 的宿主服务，之后 askDsh 会走【进程内会话】而不是 HTTP 桥接。
   *
   * 为什么：/api_server.js 的 /api/session 是【全局单飞】且共用主会话，
   * 主对话一忙语音就全部 429，且每个请求要跑满 120s（见 contract §7）。
   * 进程内自建会话彻底绕开这个瓶颈，且语音对话与主对话上下文互相隔离。
   *
   * @param {{ctx: object, cwd?: string|null, stateDir?: string}} deps
   */
  bindAgentFactory({ ctx, cwd, stateDir }) {
    this.#agentCtx = ctx;
    this.#agentCwd = cwd ?? null;
    if (stateDir && !this.#sessionFile) {
      this.#stateDir = stateDir;
      this.#sessionFile = `${stateDir}/${SESSION_STATE_FILE}`;
    }
  }

  /**
   * 取得（或创建）一个 **已绑定工作区** 的语音会话。
   *
   * ════════════════════════════════════════════════════════════════════════
   * 为什么不能用 `ctx.agents.create()`（旧实现，已废弃）
   * ════════════════════════════════════════════════════════════════════════
   * `agents.create()` 是**最底层**的 agent 工厂，它只做一件事：
   * 用给定的 cwd 造一个 agent。它 **不会** 调 `workspace.attachSession()`，
   * 因此：
   *   - 会话不进任何工作区 → DSH Web 的会话列表里看不到它
   *   - UI 显示「工作目录未知」
   *   - 没有 preset/mount 语义、没有会话级模型选择
   *
   * 正确的入口是 Host 的 `session.create`（实现见
   * `@deepseek-ai/dsh-api-session-controller/lib/index.js:574-601`），
   * 它对 `workspaceId` 的处理是：
   *     workspace = ctx.workspaceRegistry.get(workspaceId)
   *     cwd       = workspace.path
   *     await agents.ensureSession(sessionId, cwd, adopt, agentPreset)
   *     await workspace.attachSession(sessionId)        ← 绑定发生在这里
   * 即 **attachSession 是 session.create 的副作用**，插件不需要自己调。
   *
   * ⚠️ `workspaceId` 与 `cwd` **互斥**（controller :589-591 会抛
   *    "session.create accepts workspaceId or cwd, not both"）。
   * ⚠️ `attachSession` 会把会话 header 的 cwd 与工作区路径做 **realpath 全等**
   *    比较（`@deepseek-ai/dsh-workspace/lib/index.js:111-127`），不等就抛
   *    "its cwd resolves to ..."。所以 cwd 必须是工作区目录 **本身**。
   * ════════════════════════════════════════════════════════════════════════
   */
  async #ensureAgent() {
    if (this.#agent) return this.#agent;
    if (!this.#agentCtx) return null;

    const key = sessionKeyFor(this.#config.did);
    this.#conversationKey = key;

    // ── ① 解析工作区目录，并确保它 **存在** ──
    //
    // workspaceRegistry.create(path) 对不存在的目录直接抛原始 ENOENT
    // （`dsh-workspace/lib/index.js:38-50` 的 realpathNormalize 注释：
    //  "A path that does not exist rejects with the original ENOENT"），
    // 所以必须先 mkdir。dsh-im 只在 ungrouped 分支 mkdir
    // （`harness-client.mjs:1089`），这里统一做，更省心。
    const cwd = this.#resolveWorkspacePath();
    try {
      mkdirSync(cwd, { recursive: true });
    } catch (err) {
      this.log(`创建工作区目录失败 ${cwd}: ${err?.message ?? err}`);
    }

    // ── ② 复用上次会话（探活通过才复用）──
    const stored = this.#storedSessionId(key);
    if (stored) {
      if (this.#sessionAlive(stored)) {
        const reused = await this.#adoptAgent(stored);
        if (reused) {
          this.log(`复用已绑定会话: ${stored}`);
          return reused;
        }
      }
      this.log(`上次会话 ${stored} 已失效（进程重启/已归档），将新建`);
    }

    // ── ③ 建工作区 → 建会话 → 选模型（三件套）──
    const { agent, sessionId, workspaceId, via } = await this.#createBoundSession(cwd, key);
    void sessionId;
    void workspaceId;
    void via;
    return agent;
  }

  /**
   * 走 `session.create` 建立并绑定会话。返回 agent 句柄。
   *
   * 三条路线按顺序尝试，**实测结论记录在每条注释里**：
   *   A. `sessionController.create()`  —— 同进程直调 Host 实现（最快、最稳）
   *   B. `typertGateway.invoke()`     —— 官方 RPC 网关（跨 Remote 边界的等价物）
   *   C. `agents.create` + 手动 `workspace.attachSession()` —— 官方 webhook 路线（兜底）
   */
  async #createBoundSession(cwd, key) {
    const ctx = this.#agentCtx;
    const preset = String(this.#config.agentPreset ?? "").trim();

    // ── A. 直调 sessionController.create （首选） ──
    // 实测：本插件 ctx 通过 hostService 借 agents.ctx 能拿到该服务；
    // 它的 create() 就是 session.create 的实现本体，省掉 wire 编解码。
    const controller = ctx.sessionController;
    if (controller && typeof controller.create === "function") {
      try {
        const result = await this.#viaSessionController(controller, cwd, preset, key);
        if (result) return { ...result, via: "sessionController.create" };
      } catch (err) {
        this.log(`[会话] sessionController 路线失败，尝试网关: ${err?.message ?? err}`);
      }
    } else {
      this.log("[诊断] sessionController 不可用，尝试 typertGateway");
    }

    // ── B. typertGateway.invoke （官方 RPC 路径） ──
    // ⚠️ 实测：网关的 resolveDescriptor 依赖 ctx.typert.local 严格定义表，
    // 而插件侧 ctx 未必挂载该表 → 常见失败是
    // "gateway/invocation-unavailable" / "definition-unavailable"。
    // 因此它只作为第二选择。
    const gateway = ctx.typertGateway;
    if (gateway && typeof gateway.invoke === "function") {
      try {
        const result = await this.#viaGateway(gateway, cwd, preset, key);
        if (result) return { ...result, via: "typertGateway.invoke" };
      } catch (err) {
        this.log(`[会话] typertGateway 路线失败，回退 agents.create: ${err?.message ?? err}`);
      }
    }

    // ── C. agents.create + 手动 attach（官方 webhook 路线，兜底） ──
    return await this.#viaAgentsCreate(cwd, preset, key);
  }

  /** 路线 A：sessionController.create（+ selectModel）。 */
  async #viaSessionController(controller, cwd, preset, key) {
    const workspaceId = await this.#getOrCreateWorkspace(cwd);
    if (!workspaceId) throw new Error("无法取得 workspaceId");

    const request = { workspaceId };
    if (preset) request.agentPreset = preset;

    const created = await controller.create(request);
    const sessionId = created?.sessionId;
    if (!sessionId) throw new Error("session.create 未返回 sessionId");

    await this.#applyModelSelection(controller, sessionId);
    await this.#afterBind(sessionId, workspaceId, key, cwd);
    return { agent: await this.#attachAgent(sessionId, cwd, preset), sessionId, workspaceId };
  }

  /** 路线 B：typertGateway.invoke('session','create')。 */
  async #viaGateway(gateway, cwd, preset, key) {
    const workspaceId = await this.#getOrCreateWorkspace(cwd);
    if (!workspaceId) throw new Error("无法取得 workspaceId");

    const request = { workspaceId };
    if (preset) request.agentPreset = preset;

    // ⚠️ args 必须【恰好】匹配方法形参名（gateway 的 assertExactArguments 会校验），
    // create(request) 只有一个形参，所以是 { request }。
    const created = await gateway.invoke({ namespace: "session", method: "create", args: { request } });
    const sessionId = created?.sessionId;
    if (!sessionId) throw new Error("session.create 未返回 sessionId");

    await this.#applyModelSelection(null, sessionId, gateway);
    await this.#afterBind(sessionId, workspaceId, key, cwd);
    return { agent: await this.#attachAgent(sessionId, cwd, preset), sessionId, workspaceId };
  }

  /** 路线 C：agents.create + 手动 workspace.attachSession（官方 webhook 做法）。 */
  async #viaAgentsCreate(cwd, preset, key) {
    const ctx = this.#agentCtx;
    const workspace = await this.#getOrCreateWorkspaceEntity(cwd);

    const sessionId = `session-xiaoai-${randomUUID()}`;
    // ① agentOptions 必须带 provider/model —— 不带时 agent 构造不完整，
    //    收到消息后十余毫秒就 turn/end，没有任何 assistant/message（空回复）。
    const agentOptions = this.#resolveModelSelection();
    if (!agentOptions) throw new Error("无法确定 provider/model（agentDefaultModel 不可用）");

    const createOptions = {
      sessionId,
      meta: { cwd, ...(preset ? { agentPreset: preset } : {}) },
      agentOptions,
    };

    // ② setup 里挂载预设 + 安装模型选择（官方 composeAgent 的等价物）。
    const presets = ctx.agentPresets;
    createOptions.setup = async (agentCtx, agent) => {
      try {
        const install = ctx.installSelection;
        if (typeof install === "function") install(agent);
      } catch (err) {
        this.log(`installSelection 失败（忽略）: ${err?.message ?? err}`);
      }
      try {
        if (presets && typeof presets.mount === "function") {
          const resolved = await presets.resolve(preset || undefined);
          if (resolved?.id) await presets.mount(agentCtx, resolved.id);
        }
      } catch (err) {
        this.log(`挂载 Agent 预设失败（忽略）: ${err?.message ?? err}`);
      }

      // 注入「语音播报」约束。
      //
      // 为什么必须有：agent 默认面向屏幕输出，会用 Markdown、代码块、
      // 实体 ID、英文标识符 —— 这些被 TTS 念出来是灾难。实测例子：
      //   "已打开，状态确认为 **on（开）**（switch.chu_cang_shi_deng_kai_guan）"
      // 音箱会逐字念出星号、下划线、点号和英文变量名，用户完全听不懂。
      //
      // 做法：往 agentCtx 挂一个 agent/request 监听（与官方 webhook 的
      // installInitialModelSelection 同一手法，见 dsh-webhook/lib/index.js:68-78），
      // 在请求发往模型前把 system 段落追加进去。
      this.#installVoiceGuidance(agentCtx);
    };

    const created = await ctx.agents.create(createOptions);

    // ③ 手动 attach —— 这一步就是 agents.create 缺失的那个副作用。
    if (workspace && typeof workspace.attachSession === "function") {
      try {
        await workspace.attachSession(sessionId);
      } catch (err) {
        this.log(`attachSession 失败（会话可用但未绑定工作区）: ${err?.message ?? err}`);
      }
    }

    await this.#afterBind(sessionId, workspace?.id ?? null, key, cwd);
    return { agent: created.agent, sessionId, workspaceId: workspace?.id ?? null, via: "agents.create+attach" };
  }

  /**
   * 取 workspaceId：先 `list()` 查（按 path 全等），miss 才 `create(path)`。
   * 与 dsh-im `workspaceId()`（`harness-client.mjs:1076-1083`）同一策略。
   */
  async #getOrCreateWorkspace(cwd) {
    const workspace = await this.#getOrCreateWorkspaceEntity(cwd);
    return workspace?.id ?? null;
  }

  /** 同上，但返回 workspace 实体（路线 C 需要 attachSession）。 */
  async #getOrCreateWorkspaceEntity(cwd) {
    const registry = this.#agentCtx?.workspaceRegistry;
    if (!registry) {
      this.log("[诊断] workspaceRegistry 不可用 —— 将退回 cwd 模式（UI 会显示工作目录未知）");
      return null;
    }
    try {
      // ⚠️ 注册表存的是 realpath 规范化后的路径，配置里的路径可能带软链/相对段，
      // 因此比较前先 realpath 一次，避免"查不到 → 重复 create"。
      let canonical = cwd;
      try {
        canonical = realpathSync(cwd);
      } catch {
        /* 目录刚建好但 realpath 失败时不致命，用原路径比较 */
      }
      const hit = registry.list().find((w) => w.path === canonical);
      if (hit) {
        this.log(`复用工作区: ${hit.path} (${hit.id})`);
        return hit;
      }
      const created = await registry.create(canonical);
      this.log(`已注册工作区: ${created.path} (${created.id})`);
      return created;
    } catch (err) {
      this.log(`工作区解析失败: ${err?.message ?? err}`);
      return null;
    }
  }

  /** 解析要用的 provider/model：settings 显式配置优先，否则读宿主默认。 */
  #resolveModelSelection() {
    const p = String(this.#config.provider ?? "").trim();
    const m = String(this.#config.model ?? "").trim();
    if (p && m) return { provider: p, model: m };
    try {
      const sel = this.#agentCtx?.agentDefaultModel?.currentSelection?.();
      if (sel && typeof sel.provider === "string" && typeof sel.model === "string") {
        return { provider: sel.provider, model: sel.model };
      }
    } catch (err) {
      this.log(`读取默认模型失败（交给宿主决定）: ${err?.message ?? err}`);
    }
    return null;
  }

  /**
   * 设置会话级模型（`session.selectModel` 的等价物）。
   *
   * ⚠️ 这是旧实现 **完全缺失** 的一环。不设时 agent 走
   * `agentDefaultModel.currentSelection()`；若宿主没有默认模型，
   * agent-loop 会在 `prepareRequest` 抛
   *   `agent "..." has no provider/model: set AgentOptions.provider and
   *    AgentOptions.model or supply both via the agent/request waterfall`
   * （`dsh-agent-loop/lib/index.js:1147`），表现为 turn 立刻 error、空回复。
   */
  async #applyModelSelection(controller, sessionId, gateway) {
    const selection = this.#resolveModelSelection();
    if (!selection) {
      this.log("[诊断] 未显式配置模型，沿用宿主默认");
      return;
    }
    const request = { sessionId, provider: selection.provider, model: selection.model };
    try {
      if (controller && typeof controller.selectModel === "function") {
        await controller.selectModel(request);
      } else if (gateway && typeof gateway.invoke === "function") {
        await gateway.invoke({ namespace: "session", method: "selectModel", args: { request } });
      } else {
        this.log("[诊断] selectModel 通道不可用，仅依赖 agentOptions");
        return;
      }
      this.log(`已设置会话模型: ${selection.provider}/${selection.model}`);
    } catch (err) {
      this.log(`设置会话模型失败（沿用默认）: ${err?.message ?? err}`);
    }
  }

  /** 绑定成功后：记状态 + 落盘 + 把 agent 句柄取回来。 */
  async #afterBind(sessionId, workspaceId, key, cwd) {
    this.#boundSessionId = sessionId;
    this.#boundWorkspaceId = workspaceId ?? null;
    this.#storeSessionId(key, sessionId);
    this.#patch({
      sessionId,
      workspaceId: workspaceId ?? null,
      workspacePath: cwd,
    });
    this.log(`语音会话就绪: ${sessionId}（工作区 ${cwd}${workspaceId ? ` / ${workspaceId}` : " / 未绑定"}）`);
  }

  /** 从 Host 的活 agent 表里取回刚建好的 agent 句柄。 */
  async #attachAgent(sessionId, cwd, preset) {
    const agents = this.#agentCtx?.agents;
    let agent = agents?.get?.(sessionId);
    if (agent) {
      this.#agent = agent;
      return agent;
    }
    // 极少数情况下 session.create 只落了会话没起 agent（延迟激活），
    // 这里用 ensureSession 幂等唤醒（adopt=true 表示认领已有会话）。
    if (typeof agents?.ensureSession === "function") {
      const adopted = await agents.ensureSession(sessionId, cwd, true, preset || undefined);
      agent = adopted?.agent ?? adopted;
      if (agent) {
        this.#agent = agent;
        return agent;
      }
    }
    throw new Error(`会话 ${sessionId} 已建但拿不到 agent 句柄`);
  }

  /** 复用路线：把已存在的 sessionId 重新认领为 Live agent。 */
  async #adoptAgent(sessionId) {
    try {
      const agents = this.#agentCtx?.agents;
      if (typeof agents?.ensureSession !== "function") return null;
      const cwd = this.#resolveWorkspacePath();
      const preset = String(this.#config.agentPreset ?? "").trim();
      const adopted = await agents.ensureSession(sessionId, cwd, true, preset || undefined);
      const agent = adopted?.agent ?? adopted;
      if (!agent) return null;
      this.#agent = agent;
      await this.#afterBind(sessionId, this.#storedWorkspaceId(sessionId), this.#conversationKey, cwd);
      return agent;
    } catch (err) {
      this.log(`复用会话失败: ${err?.message ?? err}`);
      return null;
    }
  }

  /** 反查 sessionId 所属的 workspaceId（重启后 status 展示用）。 */
  #storedWorkspaceId(sessionId) {
    try {
      const registry = this.#agentCtx?.workspaceRegistry;
      const hit = registry?.list?.().find((w) => w.sessionIds?.includes(sessionId));
      return hit?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 调用 DSH 取回复。
   * 优先走 in-process agent（bindAgentFactory 已绑定时），否则回退到 HTTP 桥接。
   */
  async askDsh(text) {
    // ── P1-5(b)：串行化 ──
    //
    // xiaoai.test（RPC）与 #tick（轮询）会共用同一个 agent。若并发调用
    // #askDshAgent，两个调用各自挂一份 session/event 监听，A 收到的回复
    // 会被 B 的收集器一起收走（串话），甚至互相把对方提前 resolve。
    // 这里用 promise 链把它们排成队，任一时刻只有一个在等回复。
    const previous = this.#askChain;
    let release;
    this.#askChain = new Promise((r) => { release = r; });
    try {
      if (previous) await previous.catch(() => {});
      return this.#agentCtx ? await this.#askDshAgent(text) : await this.#askDshHttp(text);
    } finally {
      release();
    }
  }

  /** 进程内：注入消息 → 收集 assistant/message → 等 turn/end。 */
  async #askDshAgent(text) {
    const agent = await this.#ensureAgent();
    if (!agent) throw new Error("无法创建语音会话");

    const { replyTimeoutMs } = this.#config;
    const chunks = [];
    const finished = Promise.withResolvers();

    // ── P1-5(a)：严格的会话归属判定 ──
    //
    // 原判断是 `subject !== agent.session && subject?.id !== status.sessionId`
    // —— 用的是 &&（或语义）：只要 subject.id 碰巧等于 status.sessionId 就会收，
    // 而「两者 id 相同」是当时的约定、不是保证。这会收进别的会话的事件。
    // 改为【引用比对】：只认自己这一个 agent/session 对象。
    const ownSession = agent.session;
    const offEvent =
      this.#agentCtx.on?.("session/event", (subject, event) => {
        const type = String(event?.type ?? "");
        // 诊断：记录本会话事件（含 turn/end 的 reason，用于定位空回复）
        if (subject === ownSession) {
          this.#diagEvents = (this.#diagEvents ?? 0) + 1;
          if (this.#diagEvents <= 25) {
            let brief = "";
            try {
              brief = JSON.stringify(event?.data ?? null)?.slice(0, 240) ?? "";
            } catch {
              brief = "(无法序列化)";
            }
            this.log(`[诊断] 事件#${this.#diagEvents} ${type} ${brief}`);
          }
        }
        if (subject !== ownSession) return;
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

    const timer = setTimeout(() => finished.resolve(), replyTimeoutMs);
    try {
      // 【2026-09-20 关键修复】消息必须是【结构化 content 数组】，不是裸字符串。
      //
      // 症状：`turn/end reason={kind:"error", error:{message:
      //   "Cannot read properties of undefined (reading 'kind')"}}`
      // （抛在 dsh-agent-loop/lib/index.js:1077-1080，`live.finish` 为 undefined，
      //  即 LLM 流没产出 finish —— 因为收到的是畸形消息）。
      //
      // 依据：dsh-im（同构且已跑通的实现）在
      //   plugin-src/host/harness-session-coordinator.mjs:58-66 构造消息为
      //     { id, role:"user", content:[{type:"text", text}], source:{kind:"user", rpcId} }
      // 并在 :90 用 `agent.inject(msg)` 投递。我们之前用
      //   `agent.followup({ role:"user", content: text })` —— content 是字符串，
      // 与 DSH 期望的 `[{type:"text",text}]` 不符。
      const message = {
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: String(text ?? "") }],
        source: { kind: "user", rpcId: `xiaoai-${randomUUID()}` },
      };

      // 【2026-09-20 关键修复·第二步】用 followup 而不是 inject。
      //
      // dsh-agent-loop/lib/index.js:787-793 定义了三个投递方法，区别在第二、
      // 三个参数（target 与 wake）：
      //     followup(input) { this.send(input, "next-turn", true ); }  // 唤醒 + 排下一轮
      //     steer   (input) { this.send(input, "next-step", true ); }  // 唤醒 + 插当前轮
      //     inject  (input) { this.send(input, "next-step", false); }  // 不唤醒，仅插话
      //
      // dsh-im 用 inject 是因为它只做「给正在跑的 turn 插话」（steering）；
      // 而我们是要【发起一次对话】—— 用 inject 的话消息虽然入了 next-step 队列，
      // 但 wake=false，空闲的 agent 不会被唤醒，于是永远等不到 turn/start，
      // 表现为「消息进去了但没回复」。
      //
      // 因此这里改用 followup：既能唤醒空闲 agent，又接受结构化消息。
      // （消息结构不变，仍是 dsh-im 的形状：content 为 [{type:"text",text}] 数组，
      //  带 source.kind/source.rpcId —— 缺了它们 LLM 会收到畸形输入。）
      if (typeof agent.followup !== "function") {
        throw new Error("agent 没有 followup 方法，无法发起对话");
      }
      await agent.followup(message);

      // 长任务进度播报：等 35 秒还没结果就再播一句安抚语。
      //
      // 为什么需要：复杂任务（写报告、查大量数据）可能跑 1-2 分钟，
      // 而「让我想想」只能撑住前十几秒的耐心。之后全程静音，用户会以为
      // 音箱卡死或没听懂，往往会重复说话，反而让 agent 更忙。
      //
      // 只播一次（不做循环）：反复播报本身就是噪音，且会占用 TTS 通道，
      // 万一此时答案回来了，两句还会叠在一起。一次提醒已经足够表达
      // 「我在处理，别急」。
      let progressTimer = null;
      const progressPhrases = this.#config.onAIProgress;
      if (Array.isArray(progressPhrases) && progressPhrases.length > 0) {
        progressTimer = setTimeout(() => {
          void this.#sayPhrase(progressPhrases, "进度");
        }, Math.max(10, Number(this.#config.progressAfterSeconds) || 35) * 1000);
        progressTimer.unref?.();
      }

      try {
        await finished.promise;
      } finally {
        if (progressTimer) clearTimeout(progressTimer);
      }
      // 给事件流一点落地时间，确保最后一条 assistant 消息被收到
      await new Promise((r) => setTimeout(r, 600));
    } finally {
      clearTimeout(timer);
      offEvent();
      offStatus();
    }
    this.#patch({ dsh: { reachable: true } });
    return chunks.join("\n").trim();
  }

  /** HTTP 回退：调桥接 API（仅在无法使用进程内 agent 时）。 */
  async #askDshHttp(text) {
    const { dshApiUrl, dshApiToken, replyTimeoutMs } = this.#config;
    const body = { message: text };
    if (this.status.sessionId) body.session = this.status.sessionId;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), replyTimeoutMs);
    try {
      const res = await fetch(dshApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(dshApiToken ? { Authorization: `Bearer ${dshApiToken}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
      const data = JSON.parse(raw);
      this.#patch({ dsh: { reachable: true }, sessionId: data.sessionId ?? this.status.sessionId });
      return String(data.text ?? "").trim();
    } catch (err) {
      this.#patch({ dsh: { reachable: false } });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ───────────────────────── 过滤 ─────────────────────────

  /** 这条语音是否该交给 DSH。 */
  shouldHandle(text) {
    if (!text) return false;
    for (const pat of this.#config.ignorePatterns) {
      try {
        if (new RegExp(pat).test(text)) return false;
      } catch {
        /* 非法正则忽略 */
      }
    }
    if (this.#config.triggerKeywords.length === 0) return true;
    return this.#config.triggerKeywords.some((k) => text.startsWith(k));
  }

  // ─────────────────── 音箱侧：AI 模式状态机 ───────────────────
  //
  // 参考 MiGPT v4.2.0 的 speaker 侧设计。为什么要它：
  // 没有模式概念时，用户每句话都得带上触发词，体验像命令行而不是语音助手。
  //
  //   [idle] --wakeUp--> [active] --说话--> [thinking] --> [replying]
  //     ↑                    ↑                                  │
  //     │               exitKeyword                             │
  //     └──────── 超时 exitKeepAliveAfter 秒 ───────────────────┘
  //
  // 向后兼容：aiModeEnabled=false 时完全走旧的 shouldHandle 逻辑。

  /** 命中任一前缀关键词。用 startsWith 而非 includes，避免句中误触发。 */
  #matchesAny(text, keywords) {
    if (!Array.isArray(keywords) || keywords.length === 0) return false;
    const t = String(text ?? "").trim();
    if (!t) return false;
    return keywords.some((k) => {
      const kw = String(k ?? "").trim();
      return kw && t.startsWith(kw);
    });
  }

  /** 从提示语数组里随机取一条；空数组返回 null（表示不播报）。 */
  #pickPhrase(phrases) {
    if (!Array.isArray(phrases) || phrases.length === 0) return null;
    const list = phrases.filter((p) => String(p ?? "").trim());
    if (list.length === 0) return null;
    return String(list[Math.floor(Math.random() * list.length)]);
  }

  /** 播报一条提示语（失败只记日志，不影响主流程）。 */
  async #sayPhrase(phrases, label) {
    const text = this.#pickPhrase(phrases);
    if (!text) return;
    try {
      await this.#speaker?.say(text);
      this.log(`🔊 [${label}] ${text}`);
    } catch (err) {
      this.log(`提示语播报失败（${label}）: ${err?.message ?? err}`);
    }
  }

  /**
   * 记一轮对话到历史（环形缓冲）。
   *
   * 为什么值得存：音箱没有屏幕，用户事后想问「刚才那个是多少」时，
   * 唯一的线索就是面板上的最近一条。保留 N 轮让用户能在面板里回看、
   * 复制，也能帮助我们排查「它到底听到了什么」。
   *
   * @param {string} query 用户说的原话
   * @param {string|null} reply 播报的回复（失败时为 null）
   * @param {number} at 时间戳（毫秒）
   */
  #pushHistory(query, reply, at) {
    const limit = Math.max(1, Number(this.#config.historyLimit) || 20);
    this.#historyLimit = limit;
    this.#history.push({
      query: String(query ?? ""),
      reply: reply === null || reply === undefined ? null : String(reply),
      at: Number(at) || Date.now(),
    });
    // 环形：超限时丢弃最旧的
    if (this.#history.length > limit) {
      this.#history = this.#history.slice(-limit);
    }
    // 同步进 status 供 UI 读取（深拷贝，避免外部改到内部数组）
    this.#patch({ history: this.#history.map((x) => ({ ...x })) });
  }

  /**
   * 给语音会话注入「输出必须能听」的约束。
   *
   * 手法与官方 webhook 的 installInitialModelSelection 一致
   * （dsh-webhook/lib/index.js:68-78）：在 agentCtx 上注册
   * `agent/request` 中间件，在请求发往模型前改写 system 段。
   *
   * 为什么不做 TTS 前的文本清洗就够：清洗只能删掉符号，删不掉「实体 ID」
   * 「英文变量名」这类**内容**层面的问题 —— 而模型如果不被告知，会一直写。
   * 从源头约束才治本；`maxReplyChars` 截断只是兜底。
   */
  #installVoiceGuidance(agentCtx) {
    if (!agentCtx || typeof agentCtx.on !== "function") return;
    try {
      agentCtx.on("agent/request", async (payload, next) => {
        const resolved = await next();
        const guidance = [
          "【重要：你现在通过智能音箱与用户对话】",
          "你的回复会被语音合成念出来，因此：",
          "1. 不要使用任何 Markdown（**加粗**、`代码`、# 标题、表格、列表符号）。",
          "2. 不要使用 emoji 或颜文字。",
          "3. 不要念出实体 ID、变量名、英文标识符、URL、文件路径。",
          "   要指代设备就用它的中文名（如「储藏室灯」而不是 switch.chu_cang_shi_deng）。",
          "4. 保持简短口语化，一般 1-3 句；用户问细节再展开。",
          "5. 数字和单位用自然口语（「二十九度」而不是「29℃」）。",
          "6. 执行完操作后直接说结果（「已经打开了」），不要罗列调用过程。",
        ].join("\n");

        // system 字段形状随版本而异，兼容 string / 数组两种。
        if (typeof resolved?.system === "string") {
          return { ...resolved, system: `${resolved.system}\n\n${guidance}` };
        }
        if (Array.isArray(resolved?.system)) {
          return { ...resolved, system: [...resolved.system, { type: "text", text: guidance }] };
        }
        return { ...resolved, system: guidance };
      });
      this.log("已注入语音播报约束（agent/request 中间件）");
    } catch (err) {
      // 注入失败不能让会话建不起来 —— 没有约束也能用，只是回复会长一些。
      this.log(`注入语音约束失败（忽略，回复可能含 Markdown）: ${err?.message ?? err}`);
    }
  }

  /**
   * 按错误类型挑一组提示语。
   *
   * 为什么值得单独做：一句「抱歉，出错了」无法让用户判断下一步该做什么 ——
   * 网络抖动应该重试、凭据过期要去面板重新登录、LLM 超时要换个说法。
   * 分类后每类给一句可操作的提示。
   *
   * 匹配依据是错误消息文本（DSH 的错误多为 HTTP 状态码或英文 message），
   * 匹配不到就回退到 onAIError。分类是尽力而为，不能因为分类失败就不播报。
   */
  #classifyErrorPhrases(err) {
    const msg = String(err?.message ?? err ?? "").toLowerCase();
    const cfg = this.#config;

    const pick = (specific, fallback = cfg.onAIError) =>
      Array.isArray(specific) && specific.length > 0 ? specific : fallback;

    // 鉴权类：401/403、token、认证、登录
    if (/\b401\b|\b403\b|unauthor|forbidden|token.*(expired|invalid)|认证|未授权|登录/.test(msg)) {
      return pick(cfg.onAIErrorAuth);
    }
    // 网络类：超时之外的连接问题
    if (/econnrefused|econnreset|enotfound|network|socket|fetch failed|无法连接|网络/.test(msg)) {
      return pick(cfg.onAIErrorNetwork);
    }
    // 超时类：aborted / timeout
    if (/timeout|aborted|超时|timed out/.test(msg)) {
      return pick(cfg.onAIErrorTimeout);
    }
    return cfg.onAIError;
  }

  /** 把模式重置为 idle 并清掉计时器。 */
  #resetAiMode(reason) {
    if (this.#keepAliveTimer) {
      clearTimeout(this.#keepAliveTimer);
      this.#keepAliveTimer = null;
    }
    if (this.#aiMode !== "idle") {
      this.#aiMode = "idle";
      this.#patch({ aiMode: "idle" });
      this.log(`AI 模式退出（${reason}）`);
    }
  }

  /** 每次成功处理一条语音后调用，重置「无对话自动退出」倒计时。 */
  #touchKeepAlive() {
    if (this.#keepAliveTimer) clearTimeout(this.#keepAliveTimer);
    const seconds = Math.max(5, Number(this.#config.exitKeepAliveAfter) || 30);
    this.#keepAliveTimer = setTimeout(() => {
      const wasActive = this.#aiMode !== "idle";
      this.#resetAiMode("超时无对话");
      if (wasActive) void this.#sayPhrase(this.#config.onExitAI, "退出");
    }, seconds * 1000);
    this.#keepAliveTimer.unref?.();
  }

  /**
   * 判定一条语音该怎么处理。
   *
   * @param {string} text 识别到的文字
   * @returns {{action: "ignore"|"enter"|"exit"|"ask", text: string}}
   */
  #resolveIntent(text) {
    const raw = String(text ?? "").trim();

    // 黑名单永远优先（如 "小爱同学" 这类唤醒词本身的回声）
    for (const pat of this.#config.ignorePatterns) {
      try {
        if (new RegExp(pat).test(raw)) return { action: "ignore", text: raw };
      } catch {
        /* 非法正则忽略 */
      }
    }
    if (!raw) return { action: "ignore", text: raw };

    // 未启用模式机 → 旧的逐条匹配行为
    if (!this.#config.aiModeEnabled) {
      return this.shouldHandle(raw) ? { action: "ask", text: raw } : { action: "ignore", text: raw };
    }

    if (this.#aiMode === "idle") {
      if (this.#matchesAny(raw, this.#config.wakeUpKeywords)) return { action: "enter", text: raw };
      // idle 时：命中「直接问」关键词才处理，否则一律不理
      // idle 时的「直接问」判定。
      //
      // ⚠️ 边界（重要）：不能简单地「关键词全空 = 全部放行」——那样音箱会把
      // 所有听到的话都灌给 DSH（包括「小爱同学，放首歌」这类本该由小爱自己
      // 处理的指令），既费钱又答非所问。
      //
      // 规则：
      //   · 配了 callAIKeywords 或 triggerKeywords → 只认这些（前缀匹配）
      //   · 都没配 → 视为「用户还没配好」，此时【保持旧行为】（全放行），
      //     因为 aiModeEnabled 默认 true，若一律 ignore 会让升级后的老用户
      //     突然失灵。旧行为 + 空关键词 == 原来就是这样，无损。
      const hasAnyKeyword = this.#config.callAIKeywords.length > 0
        || this.#config.triggerKeywords.length > 0;
      if (!hasAnyKeyword) {
        // 与旧版一致：无关键词时全部转发（老用户升级后行为不变）
        return { action: "ask", text: raw };
      }
      const direct = this.#matchesAny(raw, this.#config.callAIKeywords)
        || this.#matchesAny(raw, this.#config.triggerKeywords);
      if (direct) return { action: "ask", text: raw };

      // 有唤醒词但没命中：若用户在 idle 且**只**配了 wakeUpKeywords，
      // 则这句话既不进模式也不直接问 → 忽略（这正是「等唤醒词」的语义）。
      return { action: "ignore", text: raw };
    }

    // active / thinking / replying：模式内所有话都处理，除非命中退出词
    if (this.#matchesAny(raw, this.#config.exitKeywords)) return { action: "exit", text: raw };
    return { action: "ask", text: raw };
  }

  /**
   * 按 intent 推进状态机，返回是否要把这条交给 DSH。
   * 副作用（播报提示语、改模式、重置计时器）都在这里。
   */
  async #advanceAiMode(text) {
    const { action } = this.#resolveIntent(text);

    if (action === "ignore") return false;

    if (action === "enter") {
      this.#aiMode = "active";
      this.#patch({ aiMode: "active" });
      this.log("AI 模式已开启");
      await this.#sayPhrase(this.#config.onEnterAI, "进入");
      this.#touchKeepAlive();
      return false; // 进入语本身不需要再问 DSH
    }

    if (action === "exit") {
      this.#resetAiMode("用户退出");
      await this.#sayPhrase(this.#config.onExitAI, "退出");
      return false;
    }

    // action === "ask"
    //
    // 先试「本地快速路径」：音量、时间这类高频指令不必惊动 LLM。
    // 实测走 DSH 需要 5-20 秒（轮询 + 推理），而这类指令本机 0.1 秒就能做 ——
    // 用户说「声音小一点」等十几秒是很糟的体验。
    if (await this.#tryLocalCommand(text)) {
      this.#touchKeepAlive();
      return false; // 本地已处理，不再交给 DSH
    }

    this.#aiMode = "thinking";
    this.#patch({ aiMode: "thinking" });

    // 即时反馈：先播「让我想想」再问 DSH。
    //
    // 这是体验上很重要的一步 —— 轮询本身有 0-4 秒延迟，LLM 又要几秒到几十秒，
    // 如果全程静默，用户会以为音箱没听见，于是重复说话，反而更慢。
    //
    // 【但必须等它播完再往下走】：TTS 和后续答案共用音箱的播放通道，
    // 若这里不 await，LLM 秒回时「让我想想」会和答案叠在一起播，
    // 用户听到的是两句话糊在一起。await 的代价是多等 1-2 秒（TTS 时长），
    // 换来的是一句完整可听的提示，值得。
    //
    // 例外：提示语为空数组（用户关了提示）时 sayPhrase 立即返回，无开销。
    await this.#sayPhrase(this.#config.onAIAsking, "思考");

    this.#touchKeepAlive();
    return true;
  }

  /**
   * 本地快速路径：高频、确定性的指令直接本机执行，不经 LLM。
   *
   * 为什么值得做：语音助手最高频的几条指令（音量、时间、停止）都是
   * 「本机零点几秒能做完」的事，走 DSH 却要 5-20 秒。用户说
   * 「声音小一点」然后等十几秒，体验上的落差极大。
   *
   * 设计取舍：
   *   · 只在明确命中时接管，**任一不确定就返回 false** 交给 DSH ——
   *     宁可慢一点，也不要把「把客厅灯调到50%」误当成音量指令。
   *   · 指令表用正则精确匹配（数字/相对词都可），不做模糊推断。
   *
   * @returns {Promise<boolean>} true = 已在本地处理完（调用方不要再问 DSH）
   */
  async #tryLocalCommand(text) {
    if (!this.#config.localCommandsEnabled) return false;
    const t = String(text ?? "").trim();
    if (!t) return false;

    // ── 音量：绝对（调到50 / 音量50）──
    const absVol = t.match(/^(?:请|帮我)?(?:把)?(?:音量|声音|音量调|声音调)(?:调到|调成|设为|设成|调整到)?\s*(\d{1,3})\s*%?$/);
    if (absVol) {
      const want = Number(absVol[1]);
      if (want >= 0 && want <= 100) {
        const r = await this.#speaker?.setVolume(want);
        const cur = r?.volume ?? want;
        this.log(`🔊 [本地] 音量设为 ${cur}`);
        await this.#speaker?.say(`音量已经调到${cur}`);
        return true;
      }
      return false;
    }

    // ── 音量：相对（大声点/小一点/音量+10）──
    const relWord = t.match(/^(?:请|帮我)?(?:把)?(?:声音|音量)?(大声|小声|大一点|小一点|大点|小点|调大|调小|调高|调低)/);
    const relNum = t.match(/^(?:请|帮我)?(?:把)?(?:音量|声音)(?:调大|调高|\+|加)\s*(\d{1,3})/);
    const relNumDown = t.match(/^(?:请|帮我)?(?:把)?(?:音量|声音)(?:调小|调低|-|减)\s*(\d{1,3})/);
    if (relWord || relNum || relNumDown) {
      let delta = 10;
      if (relNum) delta = Number(relNum[1]) || 10;
      else if (relNumDown) delta = -(Number(relNumDown[1]) || 10);
      else if (/小|低/.test(relWord[1])) delta = -10;
      const r = await this.#speaker?.adjustVolume(delta);
      const cur = r?.volume ?? '?';
      this.log(`🔊 [本地] 音量 ${delta > 0 ? '+' : ''}${delta} → ${cur}`);
      await this.#speaker?.say(`音量${delta > 0 ? '已经调大' : '已经调小'}，现在是${cur}`);
      return true;
    }

    // ── 当前时间 ──
    if (/^(?:请|帮我)?(?:现在)?(?:几点|几点了|什么时间|报时|当前时间)$/.test(t)) {
      const now = new Date();
      const hh = now.getHours();
      const mm = now.getMinutes();
      const period = hh < 6 ? '凌晨' : hh < 12 ? '上午' : hh < 14 ? '中午' : hh < 18 ? '下午' : '晚上';
      const h12 = hh % 12 === 0 ? 12 : hh % 12;
      const line = `现在是${period}${h12}点${mm === 0 ? '整' : mm + '分'}`;
      this.log(`🔊 [本地] ${line}`);
      await this.#speaker?.say(line);
      return true;
    }

    // ── 停止播放（"别说了"用暂停，避免把 TTS 也停掉导致后续无法播报）──
    if (/^(?:请|帮我)?(?:先)?(?:别说了|安静|停一下|停止播放|暂停播放|停)($|吧|一下)/.test(t)) {
      const r = await this.#speaker?.pause();
      this.log(`🔊 [本地] 暂停播放 ok=${r?.ok}`);
      return true;
    }

    return false;
  }

  // ───────────────────────── 生命周期 ─────────────────────────

  /** 建立音箱连接并启动轮询。可重复调用（会先停）。 */
  async start() {
    // 互斥：并发 start()（用户连点保存/重启）会让多个轮询循环并存，
    // 各自 #tick() → 重复调 getConversations、重复 say()，#seen/#lastTime
    // 交错更新。这里用 promise 链把调用串行化。
    const previous = this.#startChain;
    let release;
    this.#startChain = new Promise((r) => { release = r; });
    try {
      if (previous) await previous.catch(() => {});
      return await this.#startInner();
    } finally {
      release();
    }
  }

  async #startInner() {
    await this.stop();
    this.applyConfig();
    this.#patch({ phase: "starting", lastError: null });

    if (!this.#config.enabled) {
      this.log("已禁用，不启动");
      this.#patch({ phase: "stopped" });
      return;
    }
    // ── 配置校验：区分缺哪个字段 ──
    //
    // 旧实现把三种情况合并成同一句「缺少小米账号或设备 ID」，排查时极易误导
    // —— 实测时 password 为空却报「缺少账号」，白查了很久（台式DSH 反馈）。
    //
    // 另外 password 本身【不是必需的】：vendor 补丁会复用凭据文件里的
    // serviceToken 直接跳过登录流程，password 只是传给 mi-service-lite 做
    // 接口兼容的占位符。实测给一个完全假的密码照样能连上。
    // 因此这里只强制 userId + did；password 缺失时仅在「凭据里也没有
    // serviceToken」时才提示需要密码（那条路径才真的需要密码登录）。
    const missing = [];
    if (!this.#config.userId) missing.push("小米账号 ID（userId）");
    if (!this.#config.did) missing.push("音箱设备 ID（did）");
    if (missing.length > 0) {
      const msg = `缺少配置：${missing.join("、")}。请在「设置 → 小爱语音」中填写`;
      this.log(msg);
      this.#patch({ phase: "error", lastError: msg });
      return;
    }

    if (!this.#config.password) {
      // password 缺失不致命 —— 只要凭据文件里有 serviceToken 就能跑。
      // 这里只记录一条提示，等真正连接失败时再暴露出「可能需要密码」。
      this.log("未配置密码；将依赖凭据文件中的 serviceToken（若连接失败，请补充密码）");
    }

    // 连接前先从 HA 的 xiaomi_miot 缓存里同步一次新鲜 token。
    // 小米的 serviceToken 约 15~24 小时过期，过期后表现为「听不到你说话」，
    // 而 HA 侧一直在维持登录态，直接借用即可（见 token-refresh.js）。
    if (this.#miStorePath) {
      try {
        const r = mergeFreshTokens(this.#miStorePath, this.#config.userId, (m) => this.log(m));
        if (!r.refreshed && r.reason !== "token 未变化") this.log(`凭据同步: ${r.reason}`);
      } catch (err) {
        this.log(`凭据同步失败（继续用现有凭据）: ${err?.message ?? err}`);
      }
    }

    try {
      this.#speaker = new XiaomiSpeaker({
        userId: this.#config.userId,
        password: this.#config.password,
        did: this.#config.did,
        // 凭据缓存放在持久化的 state 目录，绝不依赖 cwd。
        miStorePath: this.#miStorePath,
        logger: (m) => this.#config.verboseLog && this.log(m),
      });
      const device = await this.#speaker.connect();
      this.#patch({
        speaker: {
          connected: true,
          name: device?.name ?? null,
          model: device?.hardware ?? null,
          did: String(device?.miotDID ?? this.#config.did),
        },
      });
      this.log(`已连接音箱: ${device?.name} (${device?.hardware})`);
    } catch (err) {
      const msg = `连接音箱失败: ${err?.message ?? err}`;
      this.log(msg);
      this.#patch({ phase: "error", lastError: msg, speaker: { ...this.status.speaker, connected: false } });
      return;
    }

    this.#lastTime = this.#loadLastTime();
    this.#firstPoll = true;
    this.#stopped = false;
    this.#patch({ phase: "running", startedAt: Date.now() });
    this.log("开始监听语音…");
    this.#loop = this.#runLoop(this.#generation);
  }

  /**
   * 可中断的睡眠。
   *
   * 原来的 `await new Promise(r => setTimeout(r, pollIntervalMs))` 不可打断，
   * 导致 stop() 必须等这一觉睡完 —— pollIntervalMs 大时 UI 转圈数分钟，
   * 且 #runLoop 内部 `await this.stop()` 会 await 到自己身上（死等）。
   */
  #sleep(ms) {
    return new Promise((resolve) => {
      this.#sleepResolve = resolve;
      this.#sleepTimer = setTimeout(() => {
        this.#sleepTimer = null;
        this.#sleepResolve = null;
        resolve();
      }, ms);
    });
  }

  /** 立即唤醒正在睡眠的循环。 */
  #wake() {
    if (this.#sleepTimer) {
      clearTimeout(this.#sleepTimer);
      this.#sleepTimer = null;
    }
    const r = this.#sleepResolve;
    this.#sleepResolve = null;
    r?.();
  }

  /**
   * 停止轮询（不销毁 speaker 引用）。
   *
   * 用 generation 令牌而非简单布尔量：stop() 递增令牌后，旧循环的
   * `while (gen === this.#generation)` 立即失败并退出，无需等它跑完一轮。
   */
  async stop() {
    this.#stopped = true;
    this.#generation += 1;   // 让在跑的循环立刻失效
    this.#wake();            // 打断睡眠

    const running = this.#loop;
    this.#loop = null;
    if (running) {
      try {
        await running;
      } catch {
        /* 循环内部已捕获 */
      }
    }
    this.#patch({ phase: "stopped", startedAt: null });
  }

  async #runLoop(generation) {
    // 只在自己这一代仍然有效时继续跑。stop()/新的 start() 会递增
    // #generation，旧循环随即退出 —— 这堵住了「并发 start() 产生多个
    // 轮询循环、重复拉对话并重复 TTS」的隐患。
    while (!this.#stopped && generation === this.#generation) {
      try {
        await this.#tick();
        this.#consecutiveErrors = 0;
      } catch (err) {
        const msg = String(err?.message ?? err);
        this.#consecutiveErrors += 1;
        this.log(`轮询出错(${this.#consecutiveErrors}): ${msg}`);
        this.#patch({ lastError: msg, consecutiveErrors: this.#consecutiveErrors });

        // 连续失败多半是 token 过期 —— 尝试从 HA 同步一次并重连。
        // 第 3 次失败时动手，避免偶发抖动就触发重连。
        if (this.#consecutiveErrors === 3 && this.#miStorePath) {
          this.log("连续失败，尝试从 HA 同步凭据并重连…");
          try {
            const r = mergeFreshTokens(this.#miStorePath, this.#config.userId, (m) => this.log(m));
            this.log(r.refreshed ? "凭据已更新，重连中" : `凭据未更新（${r.reason}）`);
            if (r.refreshed) {
              // ── 🚨 重启必须【限流 + 退避】，否则会打死机器 ──
              //
              // 事故（台式DSH 死机）：凭据刷新成功 → 重启 → 连接又失败 →
              // 又刷新成功 → 又重启 …… 而旧代码用的是 setTimeout(0)，
              // 每轮几乎无间隔地新建小米连接、写文件、调 API，
              // 结果 CPU 打满、内存暴涨、整机死机。
              //
              // 三重防护：
              //  1) 计数窗口：1 分钟内最多重启 3 次，超过就放弃并停下等人工介入
              //  2) 指数退避：5s → 10s → 20s，绝不使用 0
              //  3) 失败即停：放弃后 phase=error，不再自动重试
              const now = Date.now();
              this.#restartTimes = this.#restartTimes.filter((t) => now - t < 60_000);
              if (this.#restartTimes.length >= 3) {
                const msg =
                  "凭据刷新后连接仍反复失败，已停止自动重连（1 分钟内已达 3 次上限）。请检查账号/设备配置。";
                this.log(msg);
                this.#patch({ phase: "error", lastError: msg });
                this.#stopped = true;
                return;
              }
              this.#restartTimes.push(now);
              const delay = 5000 * 2 ** (this.#restartTimes.length - 1);   // 5s / 10s / 20s
              this.log(`凭据已更新，将在 ${delay / 1000}s 后重连（第 ${this.#restartTimes.length} 次）`);

              const genAtSchedule = this.#generation + 1;
              this.#stopped = true;
              this.#generation += 1;
              setTimeout(() => {
                // 代际已变（可能被 stop/start 抢占）则放弃这次重启
                if (this.#stopped !== true && this.#generation === genAtSchedule) return;
                this.#restartFailures += 1;
                void this.start().catch((e) => this.log(`重连失败: ${e?.message ?? e}`));
              }, delay).unref?.();
              return;
            }
          } catch (e) {
            this.log(`凭据同步失败: ${e?.message ?? e}`);
          }
        }

        if (this.#consecutiveErrors === 5) {
          await this.#safeSay("灵犀和音箱的连接出了问题，请检查设置");
        }
      }
      await this.#sleep(this.#config.pollIntervalMs);
    }
  }

  async #tick() {
    if (!this.#speaker) return;
    const records = await this.#speaker.fetchConversations(5);

    // 冷启动保护：首次拉取只对齐水位线，绝不回放历史（否则会把陈年旧话念出来）
    if (this.#firstPoll) {
      this.#firstPoll = false;
      const newest = records.reduce((m, r) => Math.max(m, Number(r.time) || 0), this.#lastTime);
      if (newest > this.#lastTime) {
        this.#lastTime = newest;
        this.#saveLastTime();
      }
      this.log(`水位线对齐至 ${new Date(this.#lastTime).toISOString()}（不回放历史）`);
      return;
    }

    const fresh = records.filter((r) => r.time && r.time > this.#lastTime).reverse();

    for (const rec of fresh) {
      if (rec.time > this.#lastTime) {
        this.#lastTime = rec.time;
        this.#saveLastTime();
      }
      const key = `${rec.time}|${rec.query}`;
      if (this.#seen.has(key)) continue;
      this.#seen.add(key);
      if (this.#seen.size > 1000) this.#seen = new Set([...this.#seen].slice(-300));

      // 音箱侧状态机：判断这条语音怎么处理（ignore/enter/exit/ask）。
      // aiModeEnabled=false 时退化为旧的 shouldHandle 行为，老配置无感。
      if (!(await this.#advanceAiMode(rec.query))) continue;

      this.#patch({ lastHeard: { text: rec.query, at: rec.time } });
      this.log(`🎤 ${rec.query}`);
      try {
        const reply = await this.#handleOne(rec.query);
        this.#patch({ handledCount: this.status.handledCount + 1 });
        this.#pushHistory(rec.query, reply, rec.time);
        void reply;
      } catch (err) {
        this.log(`❌ 处理失败: ${err?.message ?? err}`);
        this.#patch({ lastError: String(err?.message ?? err) });
        this.#pushHistory(rec.query, null, rec.time);
        // 按错误类型播报更具体的提示 —— 「抱歉，出错了」对用户毫无信息量，
        // 用户无法据此判断该重试、该重新登录、还是该换个说法。
        await this.#sayPhrase(this.#classifyErrorPhrases(err), "错误");
        if (this.#aiMode !== "idle") this.#touchKeepAlive();
      }
    }
  }

  /** 一条语音的完整处理：DSH → 截断 → 播报。 */
  async #handleOne(text) {
    const raw = await this.askDsh(text);
    let reply = raw || "我收到了，但没想出怎么回答";
    if (reply.length > this.#config.maxReplyChars) {
      reply = reply.slice(0, this.#config.maxReplyChars) + "……先说这么多";
    }
    this.log(`🔊 ${reply.slice(0, 120)}`);
    await this.#safeSay(reply);
    this.#patch({ lastReply: { text: reply, at: Date.now() }, lastSpokenAt: Date.now() });
    return reply;
  }

  async #safeSay(text) {
    try {
      await this.#speaker?.say(text);
    } catch (err) {
      this.log(`TTS 失败: ${err?.message ?? err}`);
    }
  }

  /** 自检：走完整链路但不播报（契约 §4 xiaoai.test）。 */
  async test(text) {
    const reply = await this.askDsh(text);
    return { ok: true, reply };
  }

  /** 直接让音箱念一段（契约 §4 xiaoai.speak）。 */
  async speak(text) {
    if (!this.#speaker) throw new Error("未连接音箱");
    await this.#speaker.say(text);
    this.#patch({ lastSpokenAt: Date.now() });
    return { ok: true };
  }
}
