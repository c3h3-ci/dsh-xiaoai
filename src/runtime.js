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
import {
  normalizeSettings,
  resolveEffective,
  projectDid,
  SETTINGS_VERSION,
} from "./settings-normalize.js";

/** 设置默认值（契约 §2）。 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  userId: "",
  password: "",
  did: "",
  /**
   * 多音箱设备列表（设计 §3.2）。空数组 = 由 `did` 归一化合成一台。
   * ⚠️ 这是**权威来源**；`did` 只是它的兼容投影。
   */
  speakers: [],
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
  /**
   * 家居意图直通：把"查设备状态/开关设备"直接映射到 ha-mcp 调用，
   * 不经过 agent 的多步工具推理。
   *
   * 为什么默认开：实测 agent 在 ha-mcp 的元工具链上失败率极高
   * （第①步就传空参数），而这两类指令在语音场景很常见。
   */
  haDirectEnabled: true,
  /** ha-mcp 的 MCP 端点（空则不启用直通）。 */
  haMcpUrl: "",
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

/**
 * 把模型输出清洗成「能被念出来」的纯文本。
 *
 * 为什么需要（除了 system 约束之外的兜底）：
 * 我们在 setup 阶段注入过「不要用 Markdown」的约束，但那只对**遵守指令的
 * 模型**有效 —— 模型换了、预设覆盖了、或者它只是偶尔不听话，用户就会听到
 * 「星号星号 加粗 星号星号」「反引号 switch 点 xxx」这种灾难。
 * 播报前再洗一遍是最后一道闸门。
 *
 * 处理项（都是实测出现过或 TTS 明确会念错的）：
 *   · 代码块 / 行内代码的反引号
 *   · 粗体斜体星号、下划线强调
 *   · 标题井号、引用大于号、列表符号
 *   · 表格的竖线与分隔行
 *   · 链接语法保留可读文字、丢掉 URL
 *   · emoji 与颜文字（TTS 会念名字或直接卡住）
 *   · 实体 ID / 英文标识符（形如 switch.xxx、light.xxx）
 *   · 连续空白与多余换行
 *
 * @param {string} text 原始文本
 * @returns {string} 适合播报的文本（可能为空串）
 */
export function cleanForSpeech(text) {
  let s = String(text ?? "");
  if (!s.trim()) return "";

  // 1. 代码块整体去掉围栏，保留内容（内容常是要点）
  s = s.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, "$1");
  // 2. 行内代码
  s = s.replace(/`([^`]*)`/g, "$1");
  // 3. 图片：直接删（念 URL 无意义）
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // 4. 链接：保留文字，丢掉 URL
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // 5. 粗体/斜体（含 __ 与 _）
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/(?<![A-Za-z0-9_])_([^_]+)_(?![A-Za-z0-9_])/g, "$1");
  // 6. 标题 / 引用 / 列表符号（行首）
  s = s.replace(/^[ \t]*#{1,6}[ \t]*/gm, "");
  s = s.replace(/^[ \t]*>[ \t]?/gm, "");
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  s = s.replace(/^[ \t]*\d+[.)][ \t]+/gm, "");
  // 7. 表格：分隔行整行删；数据行的竖线换成顿号（保留可读性）
  s = s.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, "");
  s = s.replace(/[ \t]*\|[ \t]*/g, "、");
  // 8. 实体 ID / 英文标识符（switch.xxx_yyy、light.abc）
  s = s.replace(/\b(?:switch|light|sensor|binary_sensor|climate|cover|fan|lock|media_player|automation|script|scene|input_[a-z]+)\.[a-z0-9_]+/gi, "该设备");
  // 9. 独立的长英文标识符（形如 xxx_yyy_zzz，含下划线且无空格）
  s = s.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}\b/gi, "");
  // 10. 残留的「键: 值」调试对（实测 agent 会把 verified_state: on 这类
  //     内部字段吐进回复里，念出来毫无意义）
  s = s.replace(/\b[a-z][a-z0-9_]*\s*[:：]\s*[a-z0-9_]+\b/gi, "");
  // 11. URL
  s = s.replace(/https?:\/\/\S+/g, "");
  // 12. emoji 与常见符号（保留中文标点）
  s = s.replace(
    /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu,
    ""
  );
  // 13. 归整空白与标点
  s = s.replace(/[ \t]{2,}/g, " ");
  // 【2026-09-21 修复】段落间原来用「；」连接，但：
  //   · 中文的「；」在 TTS 里是明显长停顿，连续两个听起来很怪
  //   · 原文（尤其是列表型回复）本身常带「；」，叠加后出现「。；」「：；」
  //   实测用户听到的是「…想表达什么。；您是想说：；「我以为你知道」…」
  // 改用句号断句 —— 更自然，也不会和正文标点打架。
  s = s.replace(/\n{2,}/g, "。");
  s = s.replace(/\n/g, "，");
  // 清理标点叠加（。；、：；、；；等）与首尾多余标点
  s = s.replace(/[。！？，、；：]{2,}/g, (m) => (m.includes("。") ? "。" : m[0]));
  s = s.replace(/^[，、；。：\s]+|[，、；：\s]+$/g, "");
  s = s.replace(/[，、]{2,}/g, "，");

  return s.trim();
}

/** 从会话事件的任意载荷里抽取纯文本。 */
/**
 * 从对话记录的 `answers` 数组里挑出【小爱真正说的话】。
 *
 * 依据 MiGPT v4.2.0 的 `getMessages`（src/services/speaker/speaker.ts:294-305）：
 *   answers[0].type 必须是 "TTS" 或 "LLM"，且 answers.length === 1
 *   —— 播放音乐时会有 TTS + Audio 两个 answer，那种不算对话。
 * 文本位置：answers[0].tts.text 或 answers[0].llm.text。
 *
 * @param {Array} answers 记录里的 answers 字段
 * @returns {{text: string, type: string}} 提取结果（提取不到时 text 为空串）
 */
function extractAnswerText(answers) {
  if (!Array.isArray(answers) || answers.length === 0) return { text: "", type: "" };
  // 优先找 TTS / LLM 类型（MiGPT 的判定），但放宽 length 限制 ——
  // 实测有记录带多个 answer（如 TTS + Audio），此时第一个 TTS 仍是有效回答。
  const preferred = answers.find((a) => ["TTS", "LLM"].includes(String(a?.type ?? "")));
  const pick = preferred ?? answers[0];
  const text = String(
    pick?.tts?.text ?? pick?.llm?.text ?? pick?.text ?? "",
  ).trim();
  return { text, type: String(pick?.type ?? "") };
}

/** 从会话事件的任意载荷里抽取纯文本。 */
function extractText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).filter(Boolean).join("");
  if (typeof node !== "object") return "";

  // ⚠️ 必须【跳过】推理内容 —— 这是实测踩到的坑（HA 环境 glm-5.3-flash 触发）。
  //
  // 助手的 content 是带 type 的多段数组，例如：
  //   [
  //     { type: "reasoning", text: "The user is asking me to reply with ..." },
  //     { type: "text",      text: "HA版多音箱测试" }        ← 只有这段该念出来
  //   ]
  //
  // 原实现不看 type，把 reasoning 也拼进去 → 音箱念出模型的英文思考过程，
  // 用户听到的是一整段自言自语。有的模型（reasoning 类）会输出 reasoning 段，
  // 有的不会 —— 所以这个 bug 在 deepseek 上恰好没暴露，换模型就炸。
  if (node.type === "reasoning" || node.type === "thinking") return "";

  // 工具调用的中间态同样不该被念出来（只有最终 text 才是给用户的话）。
  if (node.type === "tool-call" || node.type === "tool-result") return "";

  for (const key of ["text", "content", "parts", "message"]) {
    if (key in node) {
      const t = extractText(node[key]);
      if (t) return t;
    }
  }
  return "";
}

/**
 * 单台音箱的运行时上下文（设计 §4.1）。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 为什么必须「每设备一个上下文」—— 这是多音箱改造的**架构核心**（风险 R3）
 * ════════════════════════════════════════════════════════════════════════
 * 下列状态若在设备间共享，会出现**静默且不可恢复**的故障：
 *
 *   · `lastTime`（水位线）—— A 音箱说话了就抬高水位线，于是 B 音箱的
 *     新消息被 `r.time > lastTime` 过滤掉 → **B 永久失聪**。
 *     用户看到的是「卧室那台怎么喊都不理」，重启才好，然后又复发。
 *   · `seen`（去重集合）—— `${time}|${query}` 在两台同时说同一句话时
 *     互相吞掉，表现为「偶尔有一台不理我」。
 *   · `aiMode` —— 对客厅说「进入AI模式」，卧室那台也进了；反之亦然。
 *   · `history` —— 两台设备的对话混在一条时间线里，UI 上分不清谁说的。
 *
 * 因此这些字段一律放在**设备自己的上下文对象**里，绝不放回 runtime。
 * ════════════════════════════════════════════════════════════════════════
 */
export class SpeakerContext {
  /**
   * @param {object} spec 归一化后的音箱对象（来自 normalizeSettings）。
   */
  constructor(spec = {}) {
    /** 设备标识（miotDID）。 */
    this.did = String(spec.did ?? "").trim();
    /** 展示名。 */
    this.name = String(spec.name ?? "").trim();
    /** 硬件型号（如 "OH2P"）。 */
    this.model = String(spec.model ?? "").trim();
    /** MiNA 侧标识。 */
    this.deviceId = String(spec.deviceId ?? "").trim();
    /** 用户是否启用该设备。 */
    this.enabled = spec.enabled !== false;
    /** 归一化后的原始规格（含覆盖项），供 resolveEffective 使用。 */
    this.spec = spec;

    /** XiaomiSpeaker 实例（连接成功后才有）。 */
    this.speaker = null;

    // ── ★ 四个必须 per-device 的状态（见类头注释）──
    /** 水位线：本设备已处理到的最后一条消息时间。 */
    this.lastTime = 0;
    /** 去重集合：`${time}|${query}`。 */
    this.seen = new Set();
    /** AI 模式状态机：idle | active | thinking | replying。 */
    this.aiMode = "idle";
    /** 对话历史环形缓冲。 */
    this.history = [];

    /** per-device 的「无对话自动退出」倒计时句柄。 */
    this.keepAliveTimer = null;
    /**
     * 是否正在处理一条语音（含 LLM 推理 + TTS 播报）。
     * 对齐 MiGPT 的 `responding`（speaker.ts:172）—— 超时到点时必须检查它，
     * 否则会在回答播到一半时退出 AI 模式。
     */
    this.responding = false;

    // ── 设备级故障隔离（设计 §4.5 的 L2）──
    /** 连接/运行阶段：running | degraded | error | disabled。 */
    this.phase = "disabled";
    /** 最近一次错误信息。 */
    this.lastError = null;
    /** 是否已连接。 */
    this.connected = false;
    /** 本设备处理过的消息计数。 */
    this.handledCount = 0;
    /** 本设备最近听到/回复（供 UI 逐设备展示）。 */
    this.lastHeard = null;
    this.lastReply = null;
    this.lastSpokenAt = null;
    /** 绑定到的会话信息（供 UI 展示）。 */
    this.sessionId = null;
    this.workspacePath = null;
    this.workspaceId = null;
  }

  /** 是否参与处理（已连接且未停用）。 */
  get active() {
    return this.enabled && this.connected && this.phase === "running";
  }

  /** 导出给 UI 的状态快照（深拷贝，避免外部改到内部状态）。 */
  toStatus(effective = null) {
    return {
      did: this.did,
      name: this.name,
      model: this.model,
      deviceId: this.deviceId,
      enabled: this.enabled,
      connected: this.connected,
      // online 与 connected 同义（设计 §6.4 的状态字段名），保留两个键
      // 是为了对齐设计文档，UI 用哪个都不会落空。
      online: this.connected,
      phase: this.phase,
      aiMode: this.aiMode,
      lastHeard: this.lastHeard ? { ...this.lastHeard } : null,
      lastReply: this.lastReply ? { ...this.lastReply } : null,
      lastSpokenAt: this.lastSpokenAt,
      handledCount: this.handledCount,
      lastError: this.lastError,
      sessionId: this.sessionId,
      workspacePath: this.workspacePath,
      workspaceId: this.workspaceId,
      historyCount: this.history.length,
      /** 实际生效的配置（含继承结果，UI 据此显示「继承全局：xxx」）。 */
      effective: effective
        ? {
            workspace: effective.workspace ?? "",
            agentPreset: effective.agentPreset ?? "",
            provider: effective.provider ?? "",
            model: effective.model ?? "",
          }
        : null,
    };
  }
}

export class XiaoaiRuntime {
  /**
   * ── 多音箱：设备上下文表（did → SpeakerContext）──
   *
   * 取代原 `#speaker`（单个实例）。原先挂在 runtime 上的
   * `#lastTime` / `#seen` / `#aiMode` / `#history` 已全部搬进
   * SpeakerContext —— 见该类头部关于 R3 的说明。
   */
  #speakers = new Map();
  /**
   * 共享的 MiNA 连接（账号级，N 台音箱复用一份）。
   * 拉对话只需这一份，因此轮询次数**不随设备数增长**（设计 §4.4）。
   */
  #na = null;
  /** 供 storeOverride 复制的凭据基线（只读，永不传入 vendor）。 */
  #baseStore = null;
  #loop = null;
  #stopped = true;
  #config = { ...DEFAULTS };
  #logLines = [];
  #lastTimeFile = null;
  #firstPoll = true;
  #onStatus = null;
  #settingsScope = null;
  /**
   * ⚠️ R11：连续错误计数 —— **必须全局**，不要改成 per-device。
   * 见 #runLoop 里的详细说明（多设备会把重连次数放大 N 倍 → 打死账号）。
   */
  #consecutiveErrors = 0;
  #generation = 0;
  #sleepResolve = null;
  #sleepTimer = null;
  #startChain = null;
  /** ⚠️ R11：重启节流窗口 —— **必须全局**，同上。 */
  #restartTimes = [];
  #restartFailures = 0;
  #logFile = null;
  #logBytes = 0;
  #askChain = null;
  #miStorePath = null;
  #agentCtx = null;
  #agentCwd = null;
  #diagEvents = 0;
  #stateDir = null;
  #sessionFile = null;
  /** 已成功挂载预设的 agentCtx（WeakSet，防重复挂载导致 dsh-scope 报错）。 */
  #mountedPresetScopes = null;

  // ── 音箱侧：AI 模式状态机 ──
  //
  // ⚠️ 多音箱改造后，`#aiMode` / `#keepAliveTimer` / `#history` 已全部
  //    搬进各个 SpeakerContext（见该类头部关于 R3 的说明）。
  //    曾短暂留着这几个字段做过渡，现已删除 —— 留着它们就等于留了一条
  //    「不小心又共享」的回头路，而这类共享 bug 是静默且极难排查的。
  //
  // `#conversationKey` / `#boundSessionId` / `#boundWorkspaceId` 同理：
  // 会话归属现在是 per-device 的（`SpeakerContext.sessionId` 等）。

  /** 保留多少轮历史（见 DEFAULTS.historyLimit）。 */
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
      // ── 多音箱状态（设计 §6.4）──
      /** 每台设备的状态数组（权威来源）。 */
      speakers: [],
      /**
       * ⚠️ 向后兼容投影 = speakers[0]。
       *
       * 老 UI（`src/client/index.js:4204`）与外部脚本读的是
       * `status.speaker.connected` —— 保留这个投影让它们不炸，
       * 显著降低改动面。阶段 1-2 期间双写，成本极低、兼容收益大。
       */
      speaker: { connected: false, name: null, model: null, did: null },
      dsh: { reachable: false },
      // ⚠️ 下面这些顶层字段是「代表设备/全局」视图，同样为兼容而保留。
      //    多设备细节一律看 status.speakers[]。
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

  /** 一次性把所有设备状态同步进 status（含投影），并广播。 */
  #syncSpeakerStatus() {
    const list = [...this.#speakers.values()];
    const statuses = list.map((ctx) => ctx.toStatus(this.effectiveConfig(ctx.spec)));
    // 汇总投影：老字段取「第一台」，与改造前的单设备语义一致。
    const first = statuses[0] ?? null;
    this.status.speakers = statuses;
    this.status.speaker = first
      ? {
          connected: first.connected,
          name: first.name || null,
          model: first.model || null,
          did: first.did || null,
        }
      : { connected: false, name: null, model: null, did: null };
    // 顶层投影也只反映代表设备，避免 UI 显示「最后说话的那台」造成混淆。
    this.status.history = first ? [] : [];
    this.#emit();
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
  next.haDirectEnabled = next.haDirectEnabled !== false;
  next.haMcpUrl = String(next.haMcpUrl ?? "").trim();
    next.replyTimeoutMs = Math.max(5000, Number(next.replyTimeoutMs) || DEFAULTS.replyTimeoutMs);
    next.maxReplyChars = Math.max(20, Number(next.maxReplyChars) || DEFAULTS.maxReplyChars);
    if (!Array.isArray(next.triggerKeywords)) next.triggerKeywords = [];
    if (!Array.isArray(next.ignorePatterns)) next.ignorePatterns = DEFAULTS.ignorePatterns;

    // ── 多音箱：读时归一化（设计 §3.3）──
    //
    // 不做磁盘迁移：老配置（只有 did）在这里被合成出 speakers[]，
    // 幂等且可回滚。归一化结果**只放内存**，不写回 settings ——
    // 写回会把「读」变成「写」，一旦中途失败就留下半迁移状态。
    const normalized = normalizeSettings(next);
    next.speakers = normalized.speakers;
    // did 是投影：老代码路径（外部脚本/老 UI/降级分支）只读 did 时行为不变。
    next.did = projectDid(normalized.speakers) || String(next.did ?? "").trim();
    next.settingsVersion = SETTINGS_VERSION;

    this.#config = next;
    return next;
  }

  get config() {
    return this.#config;
  }

  /**
   * 当前生效的设备列表（已归一化、含停用项）。
   *
   * @returns {Array<object>}
   */
  get speakers() {
    return Array.isArray(this.#config.speakers) ? this.#config.speakers : [];
  }

  /**
   * 解析某台音箱的生效配置（覆盖 → 全局）。
   * @param {object} speaker 已归一化的音箱对象。
   */
  effectiveConfig(speaker) {
    return resolveEffective(this.#config, speaker);
  }

  // ─────────────── 断点持久化（防冷启动重放，REPORT §8） ───────────────
  //
  // ── 多音箱：水位线改为 per-device（设计 §4.1，风险 R3）──
  //
  // 老格式：{ "lastTime": 1789910291697 }
  // 新格式：{ "lastTime": <代表设备值>, "byDid": { "<did>": <ts> } }
  //
  // 为什么保留顶层的 `lastTime`：它是**老版本的读取目标**。若哪天用户
  // 回退到旧版插件，旧版读顶层字段仍能拿到合理的值，而不是从 0 开始
  // 回放全部历史（那会把陈年旧话全念出来）。双向兼容，成本一个字段。

  /** 读取某设备的已保存水位线。 */
  #loadLastTime(did = null) {
    if (!this.#lastTimeFile) return 0;
    try {
      const raw = JSON.parse(readFileSync(this.#lastTimeFile, "utf8"));
      const key = String(did ?? "").trim();
      if (key && raw?.byDid && typeof raw.byDid === "object") {
        const v = Number(raw.byDid[key]);
        if (Number.isFinite(v) && v > 0) return v;
      }
      // 老格式回落：老配置只有单个 lastTime，归给第一台设备
      return Number(raw?.lastTime) || 0;
    } catch {
      return 0;
    }
  }

  /** 保存全部设备的水位线（合并写入，不丢别的设备的值）。 */
  #saveLastTime() {
    if (!this.#lastTimeFile) return;
    try {
      mkdirSync(dirname(this.#lastTimeFile), { recursive: true });
      const byDid = {};
      let maxTime = 0;
      for (const ctx of this.#speakers.values()) {
        if (!ctx.did) continue;
        byDid[ctx.did] = ctx.lastTime;
        if (ctx.lastTime > maxTime) maxTime = ctx.lastTime;
      }
      // 既没有设备也没有历史值时保留旧值，避免把断点抹成 0
      if (maxTime === 0) {
        try {
          const prev = JSON.parse(readFileSync(this.#lastTimeFile, "utf8"));
          maxTime = Number(prev?.lastTime) || 0;
        } catch {
          /* 首次写入，无旧值 */
        }
      }
      writeFileSync(this.#lastTimeFile, JSON.stringify({ lastTime: maxTime, byDid }));
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
   * 优先级：该设备生效的 workspace > settings.workspace >
   *         环境变量 DSH_XIAOAI_CWD > 默认 IM 工作区。
   *
   * ⚠️ 多音箱：每台可用自己的 workspace（阶段 2 覆盖）。
   *    传 spec 时按其生效配置解析；不传则用全局（老路径兼容）。
   *
   * @param {object} [spec] 已归一化的音箱对象。
   */
  #resolveWorkspacePath(spec = null) {
    const eff = spec ? resolveEffective(this.#config, spec) : this.#config;
    const configured = String(eff.workspace ?? "").trim();
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
  /**
   * 兼容入口：不带设备上下文时，用「代表设备」（第一台启用的）。
   *
   * 老 RPC `xiaoai.test` 不带 did 就调 askDsh —— 改造前它天然用唯一那台。
   * 多设备下必须挑一台，语义取「第一台启用的」，与 `status.speaker` 投影一致。
   */
  async #ensureAgentForFirst() {
    const ctx = this.#firstActiveContext() ?? this.#firstContext();
    if (!ctx) return null;
    return this.#ensureAgent(ctx);
  }

  /** 第一台上下文（不论是否启用）。 */
  #firstContext() {
    return [...this.#speakers.values()][0] ?? null;
  }

  async #ensureAgent(ctx) {
    if (!ctx) return null;
    if (ctx.agent) return ctx.agent;
    if (!this.#agentCtx) return null;

    // ── 多音箱：会话按设备隔离（设计 §5.1）──
    // sessionKeyFor(did) 天然按 did 分 key，因此每台音箱各自一条会话、
    // 各自上下文，互不串话。落盘结构 sessions{} 本就是 map，无需改。
    const key = sessionKeyFor(ctx.did);
    ctx.conversationKey = key;

    // ── ① 解析工作区目录，并确保它 **存在** ──
    //
    // workspaceRegistry.create(path) 对不存在的目录直接抛原始 ENOENT
    // （`dsh-workspace/lib/index.js:38-50` 的 realpathNormalize 注释：
    //  "A path that does not exist rejects with the original ENOENT"），
    // 所以必须先 mkdir。dsh-im 只在 ungrouped 分支 mkdir
    // （`harness-client.mjs:1089`），这里统一做，更省心。
    //
    // ⚠️ 工作区取【该设备生效配置】：每台可覆盖自己的 workspace（阶段 2）。
    const cwd = this.#resolveWorkspacePath(ctx.spec);
    try {
      mkdirSync(cwd, { recursive: true });
    } catch (err) {
      this.log(`创建工作区目录失败 ${cwd}: ${err?.message ?? err}`);
    }

    // ── ② 复用上次会话（探活通过才复用）──
    const stored = this.#storedSessionId(key);
    if (stored) {
      if (this.#sessionAlive(stored)) {
        const reused = await this.#adoptAgent(ctx, stored);
        if (reused) {
          this.log(`[${ctx.name || ctx.did}] 复用已绑定会话: ${stored}`);
          return reused;
        }
      }
      this.log(`上次会话 ${stored} 已失效（进程重启/已归档），将新建`);
    }

    // ── ③ 建工作区 → 建会话 → 选模型（三件套）──
    const { agent, sessionId, workspaceId, via } = await this.#createBoundSession(ctx, cwd, key);
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
  async #createBoundSession(spk, cwd, key) {
    const host = this.#agentCtx;
    // ⚠️ 每台音箱可用自己的 preset（阶段 2 覆盖）。取【生效配置】而不是全局。
    const preset = String(this.effectiveConfig(spk.spec).agentPreset ?? "").trim();

    // ── A. 直调 sessionController.create （首选） ──
    // 实测：本插件 ctx 通过 hostService 借 agents.ctx 能拿到该服务；
    // 它的 create() 就是 session.create 的实现本体，省掉 wire 编解码。
    const controller = host.sessionController;
    if (controller && typeof controller.create === "function") {
      try {
        const result = await this.#viaSessionController(spk, controller, cwd, preset, key);
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
    const gateway = host.typertGateway;
    if (gateway && typeof gateway.invoke === "function") {
      try {
        const result = await this.#viaGateway(spk, gateway, cwd, preset, key);
        if (result) return { ...result, via: "typertGateway.invoke" };
      } catch (err) {
        this.log(`[会话] typertGateway 路线失败，回退 agents.create: ${err?.message ?? err}`);
      }
    }

    // ── C. agents.create + 手动 attach（官方 webhook 路线，兜底） ──
    return await this.#viaAgentsCreate(spk, cwd, preset, key);
  }

  /** 路线 A：sessionController.create（+ selectModel）。 */
  async #viaSessionController(spk, controller, cwd, preset, key) {
    const workspaceId = await this.#getOrCreateWorkspace(cwd);
    if (!workspaceId) throw new Error("无法取得 workspaceId");

    const request = { workspaceId };
    if (preset) request.agentPreset = preset;

    const created = await controller.create(request);
    const sessionId = created?.sessionId;
    if (!sessionId) throw new Error("session.create 未返回 sessionId");

    await this.#applyModelSelection(spk, controller, sessionId);
    await this.#afterBind(spk, sessionId, workspaceId, key, cwd);
    return { agent: await this.#attachAgent(spk, sessionId, cwd, preset), sessionId, workspaceId };
  }

  /** 路线 B：typertGateway.invoke('session','create')。 */
  async #viaGateway(spk, gateway, cwd, preset, key) {
    const workspaceId = await this.#getOrCreateWorkspace(cwd);
    if (!workspaceId) throw new Error("无法取得 workspaceId");

    const request = { workspaceId };
    if (preset) request.agentPreset = preset;

    // ⚠️ args 必须【恰好】匹配方法形参名（gateway 的 assertExactArguments 会校验），
    // create(request) 只有一个形参，所以是 { request }。
    const created = await gateway.invoke({ namespace: "session", method: "create", args: { request } });
    const sessionId = created?.sessionId;
    if (!sessionId) throw new Error("session.create 未返回 sessionId");

    await this.#applyModelSelection(spk, null, sessionId, gateway);
    await this.#afterBind(spk, sessionId, workspaceId, key, cwd);
    return { agent: await this.#attachAgent(spk, sessionId, cwd, preset), sessionId, workspaceId };
  }

  /** 路线 C：agents.create + 手动 workspace.attachSession（官方 webhook 做法）。 */
  async #viaAgentsCreate(spk, cwd, preset, key) {
    const host = this.#agentCtx;
    const workspace = await this.#getOrCreateWorkspaceEntity(cwd);

    const sessionId = `session-xiaoai-${randomUUID()}`;
    // ① agentOptions 必须带 provider/model —— 不带时 agent 构造不完整，
    //    收到消息后十余毫秒就 turn/end，没有任何 assistant/message（空回复）。
    const agentOptions = this.#resolveModelSelection(spk);
    if (!agentOptions) throw new Error("无法确定 provider/model（agentDefaultModel 不可用）");

    const createOptions = {
      sessionId,
      meta: { cwd, ...(preset ? { agentPreset: preset } : {}) },
      agentOptions,
    };

    // ② setup 里挂载预设 + 安装模型选择（官方 composeAgent 的等价物）。
    const presets = host.agentPresets;
    createOptions.setup = async (agentCtx, agent) => {
      // ── 诊断：setup 收到了什么 ──
      try {
        this.log(
          `[诊断] setup 进入: agentCtx=${agentCtx ? typeof agentCtx : "null"}` +
            ` on=${typeof agentCtx?.on}` +
            ` keys=${agentCtx ? Object.getOwnPropertyNames(agentCtx).slice(0, 12).join(",") : "-"}`,
        );
      } catch (e) {
        this.log(`[诊断] setup 探测失败: ${e?.message ?? e}`);
      }
      try {
        const install = host.installSelection;
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

    const created = await host.agents.create(createOptions);

    // ③ 手动 attach —— 这一步就是 agents.create 缺失的那个副作用。
    if (workspace && typeof workspace.attachSession === "function") {
      try {
        await workspace.attachSession(sessionId);
      } catch (err) {
        this.log(`attachSession 失败（会话可用但未绑定工作区）: ${err?.message ?? err}`);
      }
    }

    await this.#afterBind(spk, sessionId, workspace?.id ?? null, key, cwd);
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

  /**
   * 解析要用的 provider/model：settings 显式配置优先，否则读宿主默认。
   *
   * ⚠️ 多音箱：取【该设备生效配置】的 provider。
   *    注意 LLM 的 `model` 在本阶段只支持全局 —— 音箱对象上的 `model`
   *    键已被**硬件型号**占用（同名不同义），详见 settings-normalize.js。
   */
  #resolveModelSelection(spk = null) {
    const eff = spk ? this.effectiveConfig(spk.spec) : this.#config;
    const p = String(eff.provider ?? "").trim();
    const m = String(eff.model ?? "").trim();
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
  async #applyModelSelection(spk, controller, sessionId, gateway) {
    const selection = this.#resolveModelSelection(spk);
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

  /** 绑定成功后：记状态 + 落盘。会话归属记在【设备上下文】上。 */
  async #afterBind(spk, sessionId, workspaceId, key, cwd) {
    this.#storeSessionId(key, sessionId);
    spk.sessionId = sessionId;
    spk.workspaceId = workspaceId ?? null;
    spk.workspacePath = cwd;
    // 顶层投影保持「代表设备」语义，老 UI 读 status.sessionId 仍可用
    this.#patch({ sessionId, workspaceId: workspaceId ?? null, workspacePath: cwd });
    this.#syncSpeakerStatus();
    this.log(
      `[${spk.name || spk.did}] 语音会话就绪: ${sessionId}` +
        `（工作区 ${cwd}${workspaceId ? ` / ${workspaceId}` : " / 未绑定"}）`,
    );
  }

  /** 从 Host 的活 agent 表里取回刚建好的 agent 句柄（记在设备上下文上）。 */
  /**
   * 挂载 Agent 预设（幂等）。
   *
   * ⚠️ 为什么单独抽出来：预设的挂载原来只写在【路线 C（#viaAgentsCreate）的
   *    setup 回调】里，但实际走的是【路线 B（#viaGateway）】（见 #ensureAgent
   *    的路线优先级）—— setup 永不执行 → 预设从未挂载。
   *    实测证据：配了 agentPreset='voice'，但会话的 system/message 仍是
   *    默认的 "You are an AI agent powered by DeepSeek Harness."，
   *    说明 persona 没被预设覆盖。
   *    这与「语音约束没注入」是同一类问题（注入点选错路线）。
   */
  async #mountPreset(agentCtx, preset) {
    const presets = this.#agentCtx?.agentPresets;
    if (!presets || typeof presets.mount !== "function") return false;
    // 幂等：同一条 scope 不能挂两次 —— 第二次会抛
    // "dsh-scope: scope key is already bound to a parent"。
    // 用 WeakSet 记住挂过的 ctx（复用路径与 attach 路径会重复调用）。
    if (!this.#mountedPresetScopes) this.#mountedPresetScopes = new WeakSet();
    const key = agentCtx && typeof agentCtx === "object" ? agentCtx : null;
    if (key && this.#mountedPresetScopes.has(key)) return true;
    try {
      const resolved = await presets.resolve(preset || undefined);
      if (!resolved?.id) return false;
      await presets.mount(agentCtx, resolved.id);
      if (key) this.#mountedPresetScopes.add(key);
      this.log(`已挂载 Agent 预设: ${resolved.id}`);
      return true;
    } catch (err) {
      const msg = String(err?.message ?? err);
      // 已被挂载过 = 等价于成功（复用场景下重复调用）
      if (/already bound to a parent/i.test(msg)) {
        if (key) this.#mountedPresetScopes.add(key);
        return true;
      }
      this.log(`挂载 Agent 预设失败（忽略）: ${msg}`);
      return false;
    }
  }

  async #attachAgent(spk, sessionId, cwd, preset) {
    const agents = this.#agentCtx?.agents;
    let agent = agents?.get?.(sessionId);
    if (agent) {
      spk.agent = agent;
      await this.#mountPreset(agent.ctx ?? agent, preset);
      this.#installVoiceGuidance(agent.ctx ?? agent);
      return agent;
    }
    // 极少数情况下 session.create 只落了会话没起 agent（延迟激活），
    // 这里用 ensureSession 幂等唤醒（adopt=true 表示认领已有会话）。
    if (typeof agents?.ensureSession === "function") {
      const adopted = await agents.ensureSession(sessionId, cwd, true, preset || undefined);
      agent = adopted?.agent ?? adopted;
      if (agent) {
        spk.agent = agent;
        await this.#mountPreset(agent.ctx ?? agent, preset);
        this.#installVoiceGuidance(agent.ctx ?? agent);
        return agent;
      }
    }
    throw new Error(`会话 ${sessionId} 已建但拿不到 agent 句柄`);
  }

  /** 复用路线：把已存在的 sessionId 重新认领为 Live agent。 */
  async #adoptAgent(spk, sessionId) {
    try {
      const agents = this.#agentCtx?.agents;
      if (typeof agents?.ensureSession !== "function") return null;
      const cwd = this.#resolveWorkspacePath(spk.spec);
      const preset = String(this.effectiveConfig(spk.spec).agentPreset ?? "").trim();
      const adopted = await agents.ensureSession(sessionId, cwd, true, preset || undefined);
      const agent = adopted?.agent ?? adopted;
      if (!agent) return null;
      spk.agent = agent;
      await this.#mountPreset(agent.ctx ?? agent, preset);
      this.#installVoiceGuidance(agent.ctx ?? agent);   // 复用路径同样注入
      await this.#afterBind(spk, sessionId, this.#storedWorkspaceId(sessionId), sessionKeyFor(spk.did), cwd);
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
  async askDsh(text, spk = null) {
    // ── P1-5(b)：串行化 ──
    //
    // xiaoai.test（RPC）与 #tick（轮询）会共用同一个 agent。若并发调用
    // #askDshAgent，两个调用各自挂一份 session/event 监听，A 收到的回复
    // 会被 B 的收集器一起收走（串话），甚至互相把对方提前 resolve。
    // 这里用 promise 链把它们排成队，任一时刻只有一个在等回复。
    //
    // ⚠️ 多音箱：这个队列仍是**全局**的。每台音箱各有自己的 agent/会话，
    //    理论上可并发，但 DSH 的 agent-loop 在同一进程里并发跑多个 turn
    //    会给模型侧带来成倍的峰值负载 —— 保持全局串行是最保守、也最
    //    符合「语音本来就是一次一句」实际场景的选择。
    //    代价是 B 台要等 A 台说完，对家庭场景可接受（且比串话安全得多）。
    const previous = this.#askChain;
    let release;
    this.#askChain = new Promise((r) => { release = r; });
    try {
      if (previous) await previous.catch(() => {});
      return this.#agentCtx
        ? await this.#askDshAgent(text, spk)
        : await this.#askDshHttp(text, spk);
    } finally {
      release();
    }
  }

  /** 进程内：注入消息 → 收集 assistant/message → 等 turn/end。 */
  async #askDshAgent(text, spk = null) {
    const agent = spk ? await this.#ensureAgent(spk) : await this.#ensureAgentForFirst();
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
          void this.#sayPhrase(spk, progressPhrases, "进度");
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
  async #askDshHttp(text, spk = null) {
    const { dshApiUrl, dshApiToken, replyTimeoutMs } = this.#config;
    const body = { message: text };
    const sessionId = spk?.sessionId ?? this.status.sessionId;
    if (sessionId) body.session = sessionId;

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

  /**
   * 列出可供 UI 下拉选择的宿主选项（工作区 / Agent 预设 / 模型）。
   *
   * 为什么需要：设置面板里 workspace / agentPreset / provider+model 三个字段
   * 让用户手填是不现实的 —— 路径要写对、预设 id 要写对、模型名要写对，
   * 任何一处写错都表现为"会话建不起来"，且错误信息对用户毫无指向性。
   * 这里从宿主服务把可选项列出来，UI 直接渲染成下拉。
   *
   * 容错：任一来源不可用只跳过该项（返回空数组），不抛错 ——
   * 下拉为空时 UI 退化为手填，仍可用。
   *
   * @returns {Promise<{workspaces: Array, presets: Array, models: Array, defaultModel: object|null}>}
   */
  async listHostOptions() {
    const out = { workspaces: [], presets: [], models: [], defaultModel: null };

    // ── 工作区（workspaceRegistry.list()）──
    try {
      // 只能用 #agentCtx：#host 是未声明的私有字段，this.#host 会直接抛
      // TypeError（?. 保护不了私有字段自身的读取），被 catch 吞掉后永远返回空数组。
      const reg = this.#agentCtx?.workspaceRegistry;
      if (reg && typeof reg.list === "function") {
        const raw = await reg.list();
        const arr = Array.isArray(raw) ? raw : (raw?.items ?? []);
        out.workspaces = arr.map((w) => ({
          id: String(w.id ?? w.workspaceId ?? ""),
          path: String(w.path ?? w.cwd ?? w.root ?? ""),
          name: String(w.name ?? w.title ?? ""),
        })).filter((w) => w.id || w.path);
      }
    } catch (err) {
      this.log(`列工作区失败（忽略）: ${err?.message ?? err}`);
    }

    // ── Agent 预设（ctx.agentPresets.list()）──
    try {
      const presets = this.#agentCtx?.agentPresets;
      if (presets && typeof presets.list === "function") {
        const raw = await presets.list();
        const arr = Array.isArray(raw) ? raw : (raw?.items ?? []);
        out.presets = arr.map((p) => ({
          id: String(p.id ?? ""),
          name: String(p.name ?? p.title ?? p.id ?? ""),
          description: String(p.description ?? ""),
        })).filter((p) => p.id);
      }
    } catch (err) {
      this.log(`列预设失败（忽略）: ${err?.message ?? err}`);
    }

    // ── 模型（agentDefaultModel 的当前选择；完整清单由 DSH 的模型服务提供）──
    try {
      const dm = this.#agentCtx?.agentDefaultModel;
      const sel = dm?.currentSelection?.();
      if (sel?.provider && sel?.model) {
        out.defaultModel = { provider: String(sel.provider), model: String(sel.model) };
        out.models.push({ provider: String(sel.provider), model: String(sel.model), isDefault: true });
      }
      // 若服务能列出全部模型，一并取来
      if (typeof dm?.list === "function") {
        const raw = await dm.list();
        const arr = Array.isArray(raw) ? raw : (raw?.items ?? []);
        for (const m of arr) {
          const provider = String(m.provider ?? m.providerId ?? "");
          const model = String(m.model ?? m.modelId ?? m.id ?? "");
          if (!provider || !model) continue;
          if (out.models.some((x) => x.provider === provider && x.model === model)) continue;
          out.models.push({ provider, model, isDefault: false });
        }
      }
    } catch (err) {
      this.log(`列模型失败（忽略）: ${err?.message ?? err}`);
    }

    return out;
  }

  /**
   * 播报一条提示语（失败只记日志，不影响主流程）。
   *
   * ⚠️ 多音箱：必须显式传目标设备的上下文 —— 「对哪台说」是要紧信息。
   *    收音机里说「AI模式已开启」却从另一台嘴里念出来，是最难排查的一类 bug。
   */
  async #sayPhrase(spk, phrases, label) {
    const text = this.#pickPhrase(phrases);
    if (!text) return;
    try {
      await spk?.speaker?.say(text);
      if (spk) {
        spk.lastSpokenAt = Date.now();
        this.log(`🔊 [${spk.name || spk.did}] [${label}] ${text}`);
      } else {
        this.log(`🔊 [${label}] ${text}`);
      }
    } catch (err) {
      this.log(`提示语播报失败（${spk?.name || spk?.did || "?"}/${label}）: ${err?.message ?? err}`);
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
  #pushHistory(spk, query, reply, at) {
    const limit = Math.max(1, Number(this.#config.historyLimit) || 20);
    this.#historyLimit = limit;
    spk.history.push({
      query: String(query ?? ""),
      reply: reply === null || reply === undefined ? null : String(reply),
      at: Number(at) || Date.now(),
    });
    // 环形：超限时丢弃最旧的
    if (spk.history.length > limit) {
      spk.history = spk.history.slice(-limit);
    }
    // 同步进 status 供 UI 读取（深拷贝，避免外部改到内部数组）。
    // 顶层 history 显示「代表设备」的，逐设备历史在 status.speakers[]。
    const first = [...this.#speakers.values()][0];
    this.#patch({ history: (first?.history ?? []).map((x) => ({ ...x })) });
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
      "7. 不要输出你的思考过程（reasoning），只给最终要说的话。",
    ].join("\n");

    // ── 路径 A（首选）：systemPrompt.section() ──
    //
    // 【2026-09-21 修复】原实现用 agentCtx.on("agent/request")，但那是错的：
    // DSH 的 setup 回调拿到的是 `prepared.agent.ctx`（见 dsh-agent-loop/
    // lib/index.js:1858），而 agent.ctx 上【没有 .on 方法】—— 守卫
    // `typeof agentCtx.on !== "function"` 直接静默 return，
    // 于是语音约束【从未生效过】。本机用 deepseek 恰好遵守指令而没暴露，
    // 换到 HA 的 glm-5.3-flash 立刻出现 `**加粗**` 被念出来的问题。
    //
    // 正确做法（对齐官方 dsh-persona/lib/index.js:32-44）：
    // 往 ctx.systemPrompt 注册一个 prompt section，
    // 用 ctx.effect() 包裹以获得自动清理。
    try {
      const sp = agentCtx?.systemPrompt;
      if (sp && typeof sp.section === "function") {
        const order =
          typeof sp.getSectionOrder === "function"
            ? (sp.getSectionOrder("DEPLOYMENT_PERSONA_SUFFIX") ?? 1)
            : 1;
        agentCtx.effect?.(
          () =>
            sp.section({
              name: "xiaoai:voice-guidance",
              order,
              text: guidance,
            }),
          "xiaoai.voiceGuidance()",
        );
        this.log("已注入语音播报约束（systemPrompt.section）");
        return;
      }
    } catch (err) {
      this.log(`systemPrompt.section 注入失败，回退 agent/request: ${err?.message ?? err}`);
    }

    // ── 路径 B（回退）：agent/request 中间件 ──
    // 保留这条路径以便在 systemPrompt 服务不可用时仍能约束（不同 DSH 版本差异）。
    if (!agentCtx || typeof agentCtx.on !== "function") {
      this.log("语音约束注入失败：systemPrompt 与 agent/request 都不可用（回复可能含 Markdown）");
      return;
    }
    try {
      agentCtx.on("agent/request", async (payload, next) => {
        const resolved = await next();
        if (typeof resolved?.system === "string") {
          return { ...resolved, system: `${resolved.system}\n\n${guidance}` };
        }
        if (Array.isArray(resolved?.system)) {
          return { ...resolved, system: [...resolved.system, { type: "text", text: guidance }] };
        }
        return { ...resolved, system: guidance };
      });
      this.log("已注入语音播报约束（agent/request 中间件，回退路径）");
    } catch (err) {
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

  /**
   * 把【该设备】的模式重置为 idle 并清掉它的计时器。
   *
   * ⚠️ 多音箱：计时器与模式都必须在设备上下文里（R3）——
   *    共享会让「对客厅说进入AI模式」把卧室也一起推进 active。
   */
  #resetAiMode(spk, reason) {
    if (spk.keepAliveTimer) {
      clearTimeout(spk.keepAliveTimer);
      spk.keepAliveTimer = null;
    }
    if (spk.aiMode !== "idle") {
      spk.aiMode = "idle";
      this.#syncSpeakerStatus();
      this.log(`[${spk.name || spk.did}] AI 模式退出（${reason}）`);
    }
  }

  /** 每次成功处理一条语音后调用，重置该设备的「无对话自动退出」倒计时。 */
  #touchKeepAlive(spk) {
    if (spk.keepAliveTimer) clearTimeout(spk.keepAliveTimer);
    const seconds = Math.max(5, Number(this.#config.exitKeepAliveAfter) || 30);
    spk.keepAliveTimer = setTimeout(() => {
      // ── 【2026-09-21 修复】加入 MiGPT 式的「退出守卫」──
      //
      // 对齐 MiGPT 的 exitKeepAliveIfNeeded（src/services/speaker/speaker.ts:163-177）：
      //   if (this.keepAlive && !this.responding && noNewMsg() && status === "running")
      //     await this.exitKeepAlive();
      //
      // 三重守卫的价值：超时到点时若【还在回答】或【刚收到新消息】，就续期而不是退出。
      // 否则会出现「回答还没播完，AI 模式已经退了」——用户实测三次复现。
      if (spk.responding) {
        // 正在处理/播报：续期，等这一轮结束再说
        this.#touchKeepAlive(spk);
        return;
      }
      if (spk.lastHeard && Date.now() - spk.lastHeard.at < 3000) {
        // 3 秒内刚听到新消息（可能正在解析）：也续期
        this.#touchKeepAlive(spk);
        return;
      }
      const wasActive = spk.aiMode !== "idle";
      this.#resetAiMode(spk, "超时无对话");
      if (wasActive) void this.#sayPhrase(spk, this.#config.onExitAI, "退出");
    }, seconds * 1000);
    spk.keepAliveTimer.unref?.();
  }

  /**
   * 判定一条语音该怎么处理。
   *
   * @param {string} text 识别到的文字
   * @returns {{action: "ignore"|"enter"|"exit"|"ask", text: string}}
   */
  #resolveIntent(spk, text) {
    const raw = String(text ?? "").trim();
    const cfg = this.#config;

    // 黑名单永远优先（如 "小爱同学" 这类唤醒词本身的回声）
    for (const pat of cfg.ignorePatterns) {
      try {
        if (new RegExp(pat).test(raw)) return { action: "ignore", text: raw };
      } catch {
        /* 非法正则忽略 */
      }
    }
    if (!raw) return { action: "ignore", text: raw };

    // 未启用模式机 → 旧的逐条匹配行为
    if (!cfg.aiModeEnabled) {
      return this.shouldHandle(raw) ? { action: "ask", text: raw } : { action: "ignore", text: raw };
    }

    if (spk.aiMode === "idle") {
      // ⚠️ 唤醒词取【该设备生效配置】：不同房间可用不同口令（阶段 2 覆盖）。
      const wakeWords = this.effectiveConfig(spk.spec).wakeUpKeywords;
      if (this.#matchesAny(raw, wakeWords)) return { action: "enter", text: raw };
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
      const hasAnyKeyword = cfg.callAIKeywords.length > 0
        || cfg.triggerKeywords.length > 0;
      if (!hasAnyKeyword) {
        // 与旧版一致：无关键词时全部转发（老用户升级后行为不变）
        return { action: "ask", text: raw };
      }
      const direct = this.#matchesAny(raw, cfg.callAIKeywords)
        || this.#matchesAny(raw, cfg.triggerKeywords);
      if (direct) return { action: "ask", text: raw };

      // 有唤醒词但没命中：若用户在 idle 且**只**配了 wakeUpKeywords，
      // 则这句话既不进模式也不直接问 → 忽略（这正是「等唤醒词」的语义）。
      return { action: "ignore", text: raw };
    }

    // active / thinking / replying：模式内所有话都处理，除非命中退出词
    if (this.#matchesAny(raw, cfg.exitKeywords)) return { action: "exit", text: raw };
    return { action: "ask", text: raw };
  }

  /**
   * 按 intent 推进状态机，返回是否要把这条交给 DSH。
   * 副作用（播报提示语、改模式、重置计时器）都在这里。
   */
  async #advanceAiMode(spk, text) {
    const { action } = this.#resolveIntent(spk, text);

    if (action === "ignore") return false;

    if (action === "enter") {
      spk.aiMode = "active";
      this.#syncSpeakerStatus();
      this.log(`[${spk.name || spk.did}] AI 模式已开启`);
      await this.#sayPhrase(spk, this.#config.onEnterAI, "进入");
      this.#touchKeepAlive(spk);
      return false; // 进入语本身不需要再问 DSH
    }

    if (action === "exit") {
      this.#resetAiMode(spk, "用户退出");
      await this.#sayPhrase(spk, this.#config.onExitAI, "退出");
      return false;
    }

    // action === "ask"
    //
    // 先试「本地快速路径」：音量、时间这类高频指令不必惊动 LLM。
    // 实测走 DSH 需要 5-20 秒（轮询 + 推理），而这类指令本机 0.1 秒就能做 ——
    // 用户说「声音小一点」等十几秒是很糟的体验。
    // 家居意图直通（在本地快速路径之前）—— 实测 agent 走不通 ha-mcp 的
    // 元工具链，故把"查状态/开关设备"这两类写死在代码里。
    if (await this.#tryHomeAssistantDirect(spk, text)) {
      this.#touchKeepAlive(spk);
      return false;
    }
    if (await this.#tryLocalCommand(spk, text)) {
      this.#touchKeepAlive(spk);
      return false; // 本地已处理，不再交给 DSH
    }

    spk.aiMode = "thinking";
    this.#syncSpeakerStatus();

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
    await this.#sayPhrase(spk, this.#config.onAIAsking, "思考");

    this.#touchKeepAlive(spk);
    return true;
  }

/**
 * 家居意图直通：识别"查设备状态/开关设备"这类指令，直接调 ha-mcp，
 * 不经过 agent 的多步推理。
 *
 * ── 为什么需要（实测根因）──
 * ha-mcp 的工具是【元工具模式】（11 个 pinned 工具）：
 *   ① ha_search           {"query": "<设备名>"}          → 找 entity_id
 *   ② ha_search_tools     {"query": "state"}             → 找工具名（query 必填！）
 *   ③ ha_call_read_tool   {"name": "...", "arguments": {...}}  → 执行
 *
 * 实测：agent 在第 ① 步就传空参数 `{}`（缺 query），随后跑去用
 * `mcp_connector_tool_search`（DSH 的连接器管理工具，与家居无关），
 * 最终回一句"没接上家里灯光那套系统"。三次复现，persona 引导也无效。
 *
 * ── 做法 ──
 * 把这条链【写死在代码里】：正则识别意图 → 直接按顺序调 MCP →
 * 拿到结果后让 agent 只做"润色成一句话"这一件事。
 * 与现有「本地快速路径」（音量/时间）同一思路：
 * 高频且确定的操作不该赌模型的工具调用正确性。
 *
 * ── 边界（重要）──
 * · 只处理【两个明确模式】：查状态 / 开与关
 * · 识别不出就返回 false，交回 agent（不猜）
 * · MCP 不可用也返回 false（降级，不阻塞）
 */
async #tryHomeAssistantDirect(spk, text) {
  if (!this.#config.haDirectEnabled) return false;
  const t = String(text ?? "").trim();
  if (!t) return false;

  // ── 模式 1：查状态 ──
  // "储藏室灯现在什么状态" / "台灯开着吗" / "客厅灯是开还是关"
  const askState = /(什么状态|什么情况|开着还是关着|开着吗|关着吗|是开还是关|亮着吗)/.test(t)
    || /^(?:帮我)?(?:看|查|看看|查查)/.test(t) && /(灯|空调|风扇|窗帘|插座|开关|热水器|扫地机)/.test(t);
  // ── 模式 2：开关 ──
  const turnOn = /(打开|开启|开一下|把.{1,10}开)/.test(t) && /(灯|空调|风扇|窗帘|插座|开关|热水器|扫地机)/.test(t);
  const turnOff = /(关掉|关闭|关上|把.{1,10}关)/.test(t) && /(灯|空调|风扇|窗帘|插座|开关|热水器|扫地机)/.test(t);
  if (!askState && !turnOn && !turnOff) return false;

  // 从话里抠出设备名（去掉动作词与语气词）
  let name = t
    .replace(/^(?:请|帮我|麻烦|你)?(?:看|查|看看|查查|把|给)/g, "")
    .replace(/(现在|目前|一下|的状态|状态|什么状态|什么情况|开着还是关着|开着吗|关着吗|是开还是关|亮着吗|打开|开启|开一下|关掉|关闭|关上|开|关)/g, "")
    .replace(/[？?。，,！!]/g, "")
    .trim();
  if (!name || name.length > 20) return false;

  let mcp;
  try {
    mcp = await this.#callHaMcp("ha_search", { query: name, limit: 3 });
  } catch (err) {
    this.log(`家居直通：ha_search 失败（降级交回 agent）: ${err?.message ?? err}`);
    return false;
  }
  // ── 选实体：不能只取第一个 ──
  //
  // 实测陷阱：搜"储藏室灯"会返回 5 个 score 都是 100 的实体
  // （friendly_name 都含该词）：
  //   device_tracker.bouffalolab_...     ← 设备追踪（不是灯！）
  //   light.chu_cang_shi_deng            ← ⭐ 真正的灯
  //   select.sonoff_...                  ← 开关
  //   sensor.huawei_..._流量 / _IP       ← 网络指标
  // 取第一个会拿到 device_tracker，回一句莫名其妙的"home"。
  //
  // 按【可控 domain 优先级】选，只认明确能开/能关/能读状态的：
  const DOMAIN_RANK = {
    light: 0, switch: 1, fan: 2, climate: 3, cover: 4, media_player: 5,
    humidifier: 6, vacuum: 7, water_heater: 8, input_boolean: 9, select: 10,
  };
  const candidates = (mcp?.entities ?? []).filter((e) => {
    const d = String(e?.entity_id ?? "").split(".")[0];
    return d in DOMAIN_RANK;
  });
  const hit = candidates.sort((a, b) => {
    const da = DOMAIN_RANK[a.entity_id.split(".")[0]] ?? 99;
    const db = DOMAIN_RANK[b.entity_id.split(".")[0]] ?? 99;
    if (da !== db) return da - db;
    // 同 domain 时，名字更短的更可能是本体（"储藏室灯" vs "储藏室灯 开关"）
    return String(a.friendly_name ?? "").length - String(b.friendly_name ?? "").length;
  })[0];
  if (!hit?.entity_id) return false; // 找不到可控设备 → 交回 agent
  this.log(`家居直通：识别到 ${hit.entity_id}（${hit.friendly_name ?? ""}）`);

  if (askState) {
    try {
      const st = await this.#callHaMcp("ha_call_read_tool", {
        name: "ha_get_state",
        arguments: { entity_id: hit.entity_id },
      });
      const state = st?.data?.state ?? st?.state;
      if (state === undefined) return false;
      const zh = { on: "开着", off: "关着", unavailable: "离线", unknown: "状态未知" }[String(state)] ?? String(state);
      await this.#sayPhrase(spk, [`${hit.friendly_name || name}${zh}。`], "家居");
      return true;
    } catch (err) {
      this.log(`家居直通：查状态失败: ${err?.message ?? err}`);
      return false;
    }
  }

  // 开关
  try {
    const svc = turnOn ? "turn_on" : "turn_off";
    // ⚠️ 参数名是 entity_id（不是 target: {entity_id}）—— 实测报错：
    //   "`target`: unknown parameter. Valid parameters: domain, service,
    //    entity_id, data, return_response, wait, verbose, ..."
    await this.#callHaMcp("ha_call_write_tool", {
      name: "ha_call_service",
      arguments: { domain: hit.entity_id.split(".")[0], service: svc, entity_id: hit.entity_id },
    });
    await this.#sayPhrase(spk, [`${turnOn ? "已经打开" : "已经关掉"}${hit.friendly_name || name}。`], "家居");
    return true;
  } catch (err) {
    this.log(`家居直通：${turnOn ? "开" : "关"}设备失败: ${err?.message ?? err}`);
    return false;
  }
}

/** 调 ha-mcp 的 MCP 端点（JSON-RPC over HTTP）。 */
async #callHaMcp(toolName, args) {
  const url = this.#config.haMcpUrl;
  if (!url) throw new Error("未配置 haMcpUrl");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const raw = await res.text();
  const m = raw.match(/^data: (\{.*\})$/m);
  const body = m ? JSON.parse(m[1]) : JSON.parse(raw);
  if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
  const content = body?.result?.content ?? [];
  const text = content.map((c) => c?.text ?? "").join("");
  try { return JSON.parse(text); } catch { return { raw: text }; }
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
  async #tryLocalCommand(spk, text) {
    if (!this.#config.localCommandsEnabled) return false;
    // ⚠️ 所有音量/暂停/TTS 都作用于【发起这条语音的那台音箱】，
    //    绝不能落到「当前连接的那台」—— 那正是多设备串台的来源。
    const dev = spk.speaker;
    const t = String(text ?? "").trim();
    if (!t) return false;

    // ── 音量：绝对（调到50 / 音量50）──
    const absVol = t.match(/^(?:请|帮我)?(?:把)?(?:音量|声音|音量调|声音调)(?:调到|调成|设为|设成|调整到)?\s*(\d{1,3})\s*%?$/);
    if (absVol) {
      const want = Number(absVol[1]);
      if (want >= 0 && want <= 100) {
        const r = await dev?.setVolume(want);
        const cur = r?.volume ?? want;
        this.log(`🔊 [${spk.name || spk.did}] [本地] 音量设为 ${cur}`);
        await dev?.say(`音量已经调到${cur}`);
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
      const r = await dev?.adjustVolume(delta);
      const cur = r?.volume ?? '?';
      this.log(`🔊 [${spk.name || spk.did}] [本地] 音量 ${delta > 0 ? '+' : ''}${delta} → ${cur}`);
      await dev?.say(`音量${delta > 0 ? '已经调大' : '已经调小'}，现在是${cur}`);
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
      this.log(`🔊 [${spk.name || spk.did}] [本地] ${line}`);
      await dev?.say(line);
      return true;
    }

    // ── 停止播放（"别说了"用暂停，避免把 TTS 也停掉导致后续无法播报）──
    if (/^(?:请|帮我)?(?:先)?(?:别说了|安静|停一下|停止播放|暂停播放|停)($|吧|一下)/.test(t)) {
      const r = await dev?.pause();
      this.log(`🔊 [${spk.name || spk.did}] [本地] 暂停播放 ok=${r?.ok}`);
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
    // ── 多音箱：校验「至少一台启用的音箱」而不是单个 did（设计 §7.2）──
    const enabled = this.speakers.filter((sp) => sp.enabled);
    if (enabled.length === 0) {
      missing.push(
        this.speakers.length > 0 ? "至少一台启用的音箱（当前全部已停用）" : "音箱设备 ID（did）",
      );
    }
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

    // ── 为每台启用的音箱建立独立上下文与连接（设计 §4.4）──
    //
    // 三层保证连接正确性：
    //   防线 D（vendor storeOverride）—— 每台用自己的 store 副本，从根上消除
    //     「N 个实例并发写同一份 .mi.json、互相覆盖 account.device」的竞态。
    //   防线 B（连接后校验 did）—— 万一仍绑错，在连接时就抛错而不是静默串台。
    //   防线 A（串行连接）—— 即便有 D，串行仍能进一步降低触发概率；
    //     代价只是启动慢几百毫秒，换来的是确定性。
    //
    // 失败隔离：任一台连不上**只影响它自己**，其余照常监督与播报（设计 §4.5 的 L2）。
    this.#speakers.clear();
    this.#na = null;
    const created = [];
    for (const sp of enabled) {
      const spk = new SpeakerContext(sp);
      spk.lastTime = this.#loadLastTime(sp.did);
      spk.phase = "degraded";
      this.#speakers.set(sp.did, spk);
      created.push(spk);
    }
    // 停用的设备也要出现在状态里（UI 要显示「已停用」），但不参与连接。
    for (const sp of this.speakers) {
      if (sp.enabled) continue;
      const spk = new SpeakerContext(sp);
      spk.phase = "disabled";
      this.#speakers.set(sp.did, spk);
    }
    this.#syncSpeakerStatus();

    // 凭据基线：只读模板，每台连接时 structuredClone 一份。
    // ⚠️ 绝不把这个对象本身传给 vendor —— 见下面的注释。
    this.#baseStore = this.#readBaseStore();

    for (const spk of created) {
      await this.#connectSpeaker(spk).catch((err) => {
        // 理论上 #connectSpeaker 自己已吞掉异常；这里是最后一道保险。
        spk.connected = false;
        spk.phase = "error";
        spk.lastError = String(err?.message ?? err);
        this.log(`[${spk.name || spk.did}] 连接异常: ${spk.lastError}`);
      });
    }

    const okCount = created.filter((sp) => sp.connected).length;
    if (okCount === 0) {
      const msg = `没有一台音箱连接成功（共 ${created.length} 台）`;
      this.log(msg);
      // ⚠️ 保留每台的 lastError 供 UI 逐台展示，顶层给一句汇总。
      this.#patch({ phase: "error", lastError: msg });
      this.#syncSpeakerStatus();
      return;
    }

    this.#firstPoll = true;
    this.#stopped = false;
    this.#patch({ phase: "running", lastError: null, startedAt: Date.now() });
    this.log(`开始监听语音…（${okCount}/${created.length} 台已连接）`);
    this.#loop = this.#runLoop(this.#generation);
  }

  /**
   * 读取凭据基线（只读模板）。
   *
   * 返回**新解析出来的对象**，绝不缓存后共享引用 —— 每台设备连接时
   * 会 `structuredClone` 它。返回 null 表示读不到（让 vendor 走原路径）。
   */
  #readBaseStore() {
    if (!this.#miStorePath) return null;
    try {
      const raw = JSON.parse(readFileSync(this.#miStorePath, "utf8"));
      return raw && typeof raw === "object" ? raw : null;
    } catch (err) {
      this.log(`读取凭据基线失败（将走 vendor 原路径）: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * 连接单台音箱（失败只标记该设备，绝不抛出）。
   *
   * @param {SpeakerContext} spk 设备上下文。
   * @returns {Promise<boolean>} 是否连接成功。
   */
  async #connectSpeaker(spk) {
    try {
      // ── 防线 D 的调用方纪律：每台一份**独立副本** ──
      //
      // ⚠️ 这里必须 structuredClone。若图省事把 this.#baseStore 这个
      //    同一个对象引用传给所有设备，vendor 里的 `store[service] = account`
      //    仍会在内存里互相覆盖 —— 竞态只是从文件搬到了内存，破坏力完全相同。
      //    （设计 §4.3 用红框专门标注过这个坑。）
      const storeOverride = this.#baseStore ? structuredClone(this.#baseStore) : null;

      spk.speaker = new XiaomiSpeaker({
        userId: this.#config.userId,
        password: this.#config.password,
        did: spk.did,
        // 凭据缓存放在持久化的 state 目录，绝不依赖 cwd。
        miStorePath: this.#miStorePath,
        logger: (m) => this.#config.verboseLog && this.log(`[${spk.name || spk.did}] ${m}`),
        // MiNA 共享：对话接口是账号级的，N 台只需一份（设计 §4.2）。
        sharedNa: this.#na,
        storeOverride,
      });
      const device = await spk.speaker.connect();
      // 第一台连上后，把它的 MiNA 提为共享连接，后续设备复用。
      if (!this.#na) this.#na = spk.speaker.na;

      spk.connected = true;
      spk.phase = "running";
      spk.lastError = null;
      // 回填元数据：连接时拿到的设备信息是老配置（只有 did）唯一的补全机会。
      spk.name = String(device?.name ?? spk.name ?? "");
      spk.model = String(device?.hardware ?? spk.model ?? "").toUpperCase();
      spk.deviceId = String(device?.deviceID ?? spk.deviceId ?? "");
      this.log(`[${spk.name || spk.did}] 已连接 (${spk.model})`);

      // ── 可选：启动时设定该设备音量（阶段 2 的 volume 覆盖）──
      const eff = this.effectiveConfig(spk.spec);
      if (typeof eff.volume === "number") {
        try {
          const r = await spk.speaker.setVolume(eff.volume);
          this.log(`[${spk.name || spk.did}] 启动音量设为 ${r?.volume ?? eff.volume}`);
        } catch (err) {
          this.log(`[${spk.name || spk.did}] 设置启动音量失败（忽略）: ${err?.message ?? err}`);
        }
      }
      this.#syncSpeakerStatus();
      return true;
    } catch (err) {
      // ── 失败隔离（L2）：一台连不上，其他台照常 ──
      spk.connected = false;
      spk.phase = "error";
      spk.lastError = String(err?.message ?? err);
      this.log(`[${spk.name || spk.did}] 连接失败（该设备已隔离，不影响其他）: ${spk.lastError}`);
      this.#syncSpeakerStatus();
      return false;
    }
  }

  /** 第一台**已连接**的设备上下文（代表设备，供兼容路径使用）。 */
  #firstActiveContext() {
    for (const spk of this.#speakers.values()) {
      if (spk.active) return spk;
    }
    return null;
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
    // ── 【2026-09-21 优化】优雅停止：先在处理的对话做完，再退 ──
    //
    // 实测问题：插件重启撞上用户对话时，正在处理的请求被直接掐断 ——
    // 用户听到「让我想想」之后就再没下文（回答永远不来）。
    //   13:08:24 用户说话 → 13:08:26 开始处理 → 13:08:33 插件重启 → 回答丢失
    //
    // 做法：给正在处理的设备一个宽限期（最多 GRACE_MS），等它把这一轮
    // 走完（含 TTS 播报）再真正停下。超时则强制退出，避免"卡死式"关不掉。
    // stop() 是重启路径的一部分，不能无限等 —— 否则 DSH 重启会挂住。
    const responding = [...this.#speakers.values()].filter((sp) => sp.responding);
    if (responding.length > 0) {
      const GRACE_MS = 20000;
      const names = responding.map((sp) => sp.name || sp.did).join("、");
      this.log(`停止中：等待 ${names} 处理完当前对话（最多 ${GRACE_MS / 1000} 秒）…`);
      const deadline = Date.now() + GRACE_MS;
      while (Date.now() < deadline) {
        if (![...this.#speakers.values()].some((sp) => sp.responding)) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const still = [...this.#speakers.values()].filter((sp) => sp.responding);
      if (still.length > 0) {
        this.log(`宽限期已到，仍有 ${still.length} 台在处理（强制停止）`);
      } else {
        this.log("当前对话已处理完，可以安全停止");
      }
    }

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
    // ── 多音箱：清掉每台设备自己的 AI 模式倒计时 ──
    // 漏了这一步，停用后计时器仍会在几秒后触发 —— 对着已停用的音箱播
    // 「已退出AI模式」，且改动上下文状态（stop 后本该完全静止）。
    for (const spk of this.#speakers.values()) {
      if (spk.keepAliveTimer) {
        clearTimeout(spk.keepAliveTimer);
        spk.keepAliveTimer = null;
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
        // 一轮顺利跑完 = 账号级链路正常 → 把此前因单条消息失败而临时
        // 降级的设备恢复为 running（设备级隔离的恢复路径，设计 §4.5 的 L2）。
        // 注意：**连接不上**的设备（connected=false）不在此恢复 ——
        // 那需要重连，而不是「下一轮就好了」。
        for (const spk of this.#speakers.values()) {
          if (spk.connected && spk.phase === "degraded") {
            spk.phase = "running";
            spk.lastError = null;
          }
        }
      } catch (err) {
        const msg = String(err?.message ?? err);
        this.#consecutiveErrors += 1;
        this.log(`轮询出错(${this.#consecutiveErrors}): ${msg}`);
        this.#patch({ lastError: msg, consecutiveErrors: this.#consecutiveErrors });

        // 连续失败多半是 token 过期 —— 尝试一次凭据刷新并重连。
        //
        // 【2026-09-21 修复】原条件是 `consecutiveErrors === 3`（精确等于），
        // 一旦那一次刷新失败（例如本机没有 HA 可同步），后面就**永远不会
        // 再尝试** —— 实测出现「轮询出错(4633)」这种 4000+ 次的 401 空转，
        // 期间用户完全用不了，日志也被刷爆。
        //
        // 改成**周期性重试**：第 3 次先试一次（覆盖偶发抖动），之后每 50 次
        // 再试一次（给「密码重新登录」留出兜底机会）。不是每次都试，
        // 是为了避免把小米账号打到风控。
        const shouldTryRefresh =
          this.#consecutiveErrors === 3 ||
          (this.#consecutiveErrors > 3 && this.#consecutiveErrors % 50 === 0);
        if (shouldTryRefresh && this.#miStorePath) {
          this.log(`连续失败 ${this.#consecutiveErrors} 次，尝试刷新凭据并重连…`);
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

        // 401 持续无法自愈时，明确告诉用户该怎么办（而不是默默空转）。
        //
        // 【2026-09-21 新增】实测出现过「轮询出错(4633)」这种四千多次 401 空转：
        // 本机没有 HA 可同步凭据，而 vendor 缓存的 serviceToken 已过期，
        // 插件既不会退回密码登录，也不提示用户，就这样一直转到天亮。
        //
        // 这里在连续失败达阈值时：
        //   1) 把状态标成 error（UI 会变红，用户一眼能看到）
        //   2) 通过音箱播报一次明确指引
        //   3) 之后自动暂停轮询（不再空转刷日志），等用户重新保存凭据
        //
        // 刻意【不做自动重登】：历史上「刷新成功→重启→又失败→又刷新」的
        // 循环曾把整机打死（见上方注释）。让用户显式操作一次，比机器
        // 自作聪明地反复重启安全得多。
        // ⚠️⚠️ R11：这些计数**必须是全局的，绝不能改成 per-device** ⚠️⚠️
        //
        // `#consecutiveErrors` / `#restartTimes` / `#stopped` 都挂在 runtime
        // 而非 SpeakerContext 上，这是**刻意的**。若按「每台设备各自熔断」去改，
        // 3 台设备 × 每分钟 3 次 = 每分钟 9 次重连 —— 总重连次数乘以设备数，
        // 正是历史上「凭据刷新 → 重启 → 又失败 → 又刷新」打死整机（台式DSH 死机）
        // 的那条路径。多设备会把它放大 N 倍。
        //
        // 凭据本身也是**账号级共享**的：一台的鉴权失败就是全体的鉴权失败，
        // 因此熔断本来就该是全局的 —— 单独放过某一台毫无意义，只会多打几次
        // 小米的风控。
        const AUTH_ERROR_LIMIT = 30;
        const looksLikeAuth = /\b401\b|\b403\b|unauthor|未授权|认证失败/i.test(msg);
        if (looksLikeAuth && this.#consecutiveErrors >= AUTH_ERROR_LIMIT) {
          const hint =
            "小米账号登录已过期，且在自动重试后仍无法恢复。请在面板里重新保存一次账号密码。";
          this.log(`连续 ${this.#consecutiveErrors} 次鉴权失败，暂停轮询等待人工处理`);
          this.#patch({ phase: "error", lastError: hint });
          try {
            await this.#safeSay(this.#firstActiveContext(), "小米账号登录过期了，请在设置面板重新保存一次账号密码");
          } catch {
            /* 播报失败不影响停止 */
          }
          this.#stopped = true;
          return;
        }

        if (this.#consecutiveErrors === 5) {
          await this.#safeSay(this.#firstActiveContext(), "灵犀和音箱的连接出了问题，请检查设置");
        }
      }
      await this.#sleep(this.#config.pollIntervalMs);
    }
  }

  /**
   * 一轮轮询：**1 次拉取，N 路分发**（设计 §4.4）。
   *
   * ════════════════════════════════════════════════════════════════════════
   * 为什么是 1 次拉取 —— 这是实测驱动的结论，不是猜测
   * ════════════════════════════════════════════════════════════════════════
   * `getConversations` 的方法签名里**没有任何设备选择参数**，只有 limit /
   * timestamp；`deviceId` cookie 仅做**必填校验而不参与过滤**（真实 / 伪造 /
   * 空 deviceId 三者返回逐字节相同，已实测）。也就是说这个接口本身是
   * **账号级**的 —— 一次请求就拿到账号下所有音箱的对话。
   *
   * 于是「N 台音箱 = N 倍请求」的假设不成立：轮询开销**不随设备数增长**。
   *
   * 反方向则是不对称的：播报（ubus/TTS）用 `account.device.deviceId` 定目标，
   * 是**设备级**的，所以每台必须各有一个 MiIOT 连接。
   * 一句话：**拉取共享，播报分离**。
   * ════════════════════════════════════════════════════════════════════════
   */
  async #tick() {
    // 只要有一台连着，就能拉全账号的对话（共享 MiNA）。
    const na = this.#na ?? this.#firstActiveContext()?.speaker?.na;
    if (!na) return;

    const records = await this.#fetchRecords(na, 5);

    // 冷启动保护：首次拉取只对齐水位线，绝不回放历史（否则会把陈年旧话念出来）。
    // ⚠️ 每台**各自**对齐：A 的历史水位不该决定 B 从哪里开始听（R3）。
    if (this.#firstPoll) {
      this.#firstPoll = false;
      for (const spk of this.#speakers.values()) {
        if (!spk.active) continue;
        const mine = records.filter((r) => this.#routeTo(spk, r));
        const newest = mine.reduce((m, r) => Math.max(m, Number(r.time) || 0), spk.lastTime);
        if (newest > spk.lastTime) spk.lastTime = newest;
      }
      this.#saveLastTime();
      const summary = [...this.#speakers.values()]
        .filter((sp) => sp.active)
        .map((sp) => `${sp.name || sp.did}=${sp.lastTime ? new Date(sp.lastTime).toISOString() : "0"}`)
        .join(", ");
      this.log(`水位线已对齐（不回放历史）: ${summary || "（无已连接设备）"}`);
      return;
    }

    // ── 分发到各设备：每台用自己的水位线 / 去重集 / AI 模式（R3）──
    //
    // 失败隔离：单台处理抛错只标记该设备，循环继续跑下一台（设计 §4.5 的 L2）。
    for (const spk of this.#speakers.values()) {
      if (!spk.active) continue;
      try {
        await this.#processFor(spk, records);
      } catch (err) {
        spk.phase = "degraded";
        spk.lastError = String(err?.message ?? err);
        this.log(`[${spk.name || spk.did}] 处理出错（该设备降级，其他继续）: ${spk.lastError}`);
        this.#syncSpeakerStatus();
      }
    }
  }

  /**
   * 拉取账号下的对话记录（共享 MiNA）。
   *
   * 复刻 `XiaomiSpeaker.fetchConversations` 的硬化逻辑（空返回探针、
   * 答案提取），但那台实例属于某个具体设备 —— 用共享 na 时不能借它的
   * `#emptyStreak`，故这里独立实现同一套语义。
   */
  async #fetchRecords(na, limit) {
    const res = await na.getConversations({ limit: Math.max(1, Math.floor(limit) || 5) });
    const raw = Array.isArray(res?.records) ? res.records : [];
    return raw.map((r) => {
      const picked = extractAnswerText(r.answers);
      return {
        query: String(r.query ?? "").trim(),
        answer: picked.text,
        answerType: picked.type,
        time: r.time,
        raw: r,
      };
    });
  }

  /**
   * ★ 唯一依赖 R1（`records[]` 是否含设备标识）的函数。
   *
   * ════════════════════════════════════════════════════════════════════════
   * 当前实现 = B2 降级（代表设备独占），因为 R1 **尚未实测出结果**：
   * 本账号对话历史为空（records 恒为 0），且已证实「TTS 播报不产生对话记录」
   * （延长到 40 秒、四轮轮询仍是 0），所以无法凭空造数据来验证 record 结构。
   *
   * 这意味着当前多音箱的真实语义是：
   *   ✅ 设备列表 / 逐设备状态 / 指定设备播报（xiaoai.speak({did})）—— 全部可用
   *   ⚠️ 「听到并回复」同一时刻只由**一台代表设备**承担
   * 因此 UI 必须明示这个限制，不能让用户以为两台都能对话（设计 §4.4 B2）。
   *
   * ── R1 出结果后怎么改（只动这一个函数，别处不用碰）──
   *   若 record 含设备标识（deviceId / did / hardware / deviceSNProfile）：
   *     ```js
   *     #routeTo(spk, rec) {
   *       const recDevice = rec.raw?.deviceId ?? rec.raw?.did ?? rec.raw?.deviceSNProfile;
   *       if (!recDevice) return this.#representative === spk;   // 无标识 → 兜底
   *       return [spk.did, spk.deviceId].filter(Boolean).includes(String(recDevice));
   *     }
   *     ```
   *   若确实不含：保持现状（B2），并在 UI 保留限制说明。
   * ════════════════════════════════════════════════════════════════════════
   *
   * @param {SpeakerContext} spk 候选设备。
   * @param {object} rec 一条对话记录。
   * @returns {boolean} 这条记录是否由该设备处理。
   */
  #routeTo(spk, rec) {
    // R1 未验证 → B2 降级：由「代表设备」独占处理，避免两台同时回答同一句话。
    return this.#representativeContext() === spk;
  }

  /**
   * 代表设备 = 第一台**已连接且启用**的设备。
   *
   * 这也是 B2 降级下「谁负责听」的答案。刻意用「第一台」而不是
   * 「最后活跃的那台」：稳定、可预期 —— 用户看到的限制说明与实际行为一致，
   * 不会出现「刚才还是客厅在听，怎么变成卧室了」的困惑。
   *
   * ⚠️ 若 R1 的探测发现 device_list 的 `current` 字段确实表示「服务端认定的
   *    当前活跃设备」，这里可以改为优先选它（设计 §4.4 的附带发现）。
   */
  #representativeContext() {
    return this.#firstActiveContext();
  }

  /** 处理属于某台设备的记录。 */
  async #processFor(spk, records) {
    // 该设备的水位线只推进它自己负责的那部分记录。
    const mine = records.filter((r) => this.#routeTo(spk, r));
    const fresh = mine.filter((r) => r.time && r.time > spk.lastTime).reverse();

    for (const rec of fresh) {
      if (rec.time > spk.lastTime) {
        spk.lastTime = rec.time;
        this.#saveLastTime();
      }
      const key = `${rec.time}|${rec.query}`;
      if (spk.seen.has(key)) continue;
      spk.seen.add(key);
      if (spk.seen.size > 1000) spk.seen = new Set([...spk.seen].slice(-300));

      // 音箱侧状态机：判断这条语音怎么处理（ignore/enter/exit/ask）。
      // aiModeEnabled=false 时退化为旧的 shouldHandle 行为，老配置无感。
      if (!(await this.#advanceAiMode(spk, rec.query))) continue;

      spk.lastHeard = { text: rec.query, at: rec.time };
      // 顶层投影保持「代表设备」语义，老 UI 读 status.lastHeard 仍可用。
      if (this.#representativeContext() === spk) {
        this.#patch({ lastHeard: { text: rec.query, at: rec.time } });
      }
      this.#syncSpeakerStatus();
      this.log(`🎤 [${spk.name || spk.did}] ${rec.query}`);
      // ── 【2026-09-21】处理期间置 responding=true ──
      // #touchKeepAlive 的超时回调会检查它：正在处理中不退出 AI 模式，
      // 而是续期（对齐 MiGPT speaker.ts:172 的 !this.responding 守卫）。
      spk.responding = true;
      try {
        const reply = await this.#handleOne(spk, rec.query);
        spk.handledCount += 1;
        this.#pushHistory(spk, rec.query, reply, rec.time);
        void reply;
      } catch (err) {
        this.log(`❌ [${spk.name || spk.did}] 处理失败: ${err?.message ?? err}`);
        spk.lastError = String(err?.message ?? err);
        spk.phase = "degraded";
        this.#syncSpeakerStatus();
        this.#pushHistory(spk, rec.query, null, rec.time);
        // 按错误类型播报更具体的提示 —— 「抱歉，出错了」对用户毫无信息量，
        // 用户无法据此判断该重试、该重新登录、还是该换个说法。
        await this.#sayPhrase(spk, this.#classifyErrorPhrases(err), "错误");
        if (spk.aiMode !== "idle") this.#touchKeepAlive(spk);
      } finally {
        spk.responding = false;
        if (spk.aiMode !== "idle") this.#touchKeepAlive(spk);
      }
    }
  }

  /** 一条语音的完整处理：DSH → 清洗 → 截断 → 播报（全部针对该设备）。 */
  async #handleOne(spk, text) {
    const raw = await this.askDsh(text, spk);
    // 清洗在截断之前：Markdown 符号可能占掉大量字符预算，
    // 先清掉才能把有限的字数留给真正要播的内容。
    let reply = cleanForSpeech(raw) || "我收到了，但没想出怎么回答";
    if (reply.length > this.#config.maxReplyChars) {
      reply = reply.slice(0, this.#config.maxReplyChars) + "……先说这么多";
    }
    this.log(`🔊 [${spk.name || spk.did}] ${reply.slice(0, 120)}`);
    await this.#safeSay(spk, reply);
    // ── 【2026-09-21 修复】回答播完后再重置一次倒计时 ──
    //
    // 症状（用户实测三次复现）：AI 模式下回答还没播完就退出。
    //   12:53:24 提问 → 12:53:54 退出（正好 30 秒）
    //   · 回答耗时 10-13 秒（LLM 推理）+ 播放 10-20 秒（TTS）
    //   · 倒计时却从【提问时刻】算起，于是用户听完回答只剩几秒
    //
    // 根因：倒计时只在「提问时」touch 了一次（见 #advanceAiMode 里
    //   `#sayPhrase(onAIAsking)` 之后那次），而提问到播完回答之间
    //   可能花掉 30 秒中的大部分。
    //
    // 修复：回答播完（await 返回）后再 touch 一次 —— 用户听完回答，
    //   从这一刻起才有完整的 exitKeepAliveAfter 秒可以接着说。
    if (spk.aiMode !== "idle") this.#touchKeepAlive(spk);
    spk.lastReply = { text: reply, at: Date.now() };
    spk.lastSpokenAt = Date.now();
    if (this.#representativeContext() === spk) {
      this.#patch({ lastReply: { ...spk.lastReply }, lastSpokenAt: spk.lastSpokenAt });
    }
    this.#syncSpeakerStatus();
    return reply;
  }

  async #safeSay(spk, text) {
    try {
      await spk?.speaker?.say(text);
    } catch (err) {
      this.log(`[${spk?.name || spk?.did || "?"}] TTS 失败: ${err?.message ?? err}`);
    }
  }

  /** 自检：走完整链路但不播报（契约 §4 xiaoai.test）。 */
  async test(text, did = null) {
    const spk = did ? this.#speakers.get(String(did)) : (this.#firstActiveContext() ?? this.#firstContext());
    const reply = await this.askDsh(text, spk);
    return { ok: true, reply };
  }

  /**
   * 直接让音箱念一段（契约 §4 xiaoai.speak）。
   *
   * ⚠️ 兼容语义：不传 did 时播报到**代表设备**（= 改造前唯一那台），
   *    老调用方行为不变。多设备下可传 did 精确指定某台。
   *
   * @param {string} text 要念的文字。
   * @param {string} [did] 目标设备；省略则用代表设备。
   */
  async speak(text, did = null) {
    let spk = null;
    if (did) {
      spk = this.#speakers.get(String(did)) ?? null;
      if (!spk) throw new Error(`未知的音箱设备: ${did}（可用：${[...this.#speakers.keys()].join(", ") || "无"}）`);
      if (!spk.connected) throw new Error(`设备 ${spk.name || spk.did} 未连接`);
    } else {
      spk = this.#firstActiveContext() ?? this.#firstContext();
      if (!spk) throw new Error("未连接音箱");
    }
    if (!spk.speaker) throw new Error("未连接音箱");
    await spk.speaker.say(text);
    spk.lastSpokenAt = Date.now();
    if (this.#representativeContext() === spk) this.#patch({ lastSpokenAt: Date.now() });
    this.#syncSpeakerStatus();
    return { ok: true, did: spk.did, name: spk.name };
  }

  /**
   * 列出所有音箱的当前状态（供 RPC / UI）。
   * @returns {Array<object>}
   */
  listSpeakers() {
    return [...this.#speakers.values()].map((spk) => spk.toStatus(this.effectiveConfig(spk.spec)));
  }
}
