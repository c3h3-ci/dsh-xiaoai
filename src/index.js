/**
 * dsh-xiaoai —— 把小米音箱（小爱）变成 DSH 的耳朵和嘴巴。
 *
 * 数据流：
 *   你说话 → 小米云 → 本插件轮询抓到文字 → 注入 DSH 会话
 *          → DSH（灵犀）处理（含控制 Home Assistant）
 *          → 回复文字 → 小米 TTS → 音箱念出来
 *
 * 本插件【不做任何 AI 处理】—— 大脑完全是 DSH。
 *
 * 本文件是插件【服务端半边】：设置命名空间注册（契约 §2）、
 * RPC 端点（契约 §4）、运行时单例的生命周期。
 * 运行时本身在 src/runtime.js，RPC 控制器在 src/rpc.js。
 */
import "./bootstrap.js";
import { appendFileSync } from "node:fs";
import { XiaoaiRuntime, DEFAULTS } from "./runtime.js";
import {
  RPC_NAMESPACE,
  RPC_SERVICE_KEY,
  createXiaoaiControllerClass,
  loadTypertProtocol,
  redactValues,
} from "./rpc.js";

export const name = "dsh-xiaoai";

/**
 * 依赖的 DSH 服务。
 *
 * - `settings`：契约 §2 的设置命名空间注册（`ctx.settings.register`）。
 * - `agents`：runtime 的进程内语音会话（`runtime.bindAgentFactory({ctx, cwd})`）。
 *   走 in-process agent 而不是 HTTP 桥接，绕开 `/api/session` 的全局单飞
 *   与 429（见 runtime.js 的 `#askDshAgent` 注释）。
 *
 * ⚠️ 这里【不含】任何 RPC 服务名：RPC 用 Typert Remote，靠
 * `TypertRemoteService` 在自己的构造函数里 `super(ctx, key)` 声明服务，
 * 由 Gateway 的 source-mode 扫描 `typertRemote` 绑定发现（见 rpc.js 头部注释）。
 */
export const inject = ["settings"];
//
// ⚠️ 为什么不把 `agents` 写进 inject（这是插件静态 pending 的元凶）：
//
// cordis 的 inject 是【硬依赖】—— 声明的服务若在插件加载时尚未注册，插件会
// 进入 pending 状态**静静等待**：不报错、不激活、零日志。`agents` 由
// @deepseek-ai/dsh-agent 提供，注册时机晚于本插件，于是插件永远等不到它，
// 表现为「DSH 编译 loader 树时明明含本插件，但日志里完全没有它的输出」。
//
// 对照：官方插件 dsh-duet 的 host inject 只声明它【确实需要且已就绪】的服务
// （webServer/connection/sessionController/...），并不把可延迟获取的能力写进去。
//
// 这里改为运行时按需获取：`ctx.get("agents", false)` 允许在服务尚未就绪时
// 返回 undefined（非严格模式），拿不到就回退 HTTP 桥接，插件本身照常激活。

/** 契约 §2 的命名空间。必须匹配 /^[a-z][a-z0-9-]*$/。 */
const SETTINGS_NS = "dsh-xiaoai";

/**
 * 首次接入向导新增字段的默认值。
 *
 * ⚠️ 为什么不加进 runtime.js 的 `DEFAULTS`：
 *   那个文件由另一位 agent 并行修改，本轮明确要求不碰它。
 *   `DEFAULTS` 的用途是「settings 没给值时 runtime 用什么」——
 *   这四个字段 runtime 完全不需要（型号指令由 xiaomi.js 自己在
 *   connect() 时从设备 hardware 解析），只有 UI 与 schema 需要，
 *   因此就地定义在这里是自洽的，不会造成两套默认值打架。
 */
const ONBOARDING_DEFAULTS = Object.freeze({
  deviceModel: "",
  ttsCommand: "",
  wakeUpCommand: "",
  onboarded: false,
});

/**
 * 进程级单例缓存。
 *
 * cordis 可能因为配置热更新对同一个插件调用多次 `apply()`；重复创建
 * runtime 会让两个轮询循环同时对着音箱说话（灾难）。因此把实例挂在
 * 模块作用域上，`apply()` 第二次进来直接复用（任务要求 §2 幂等）。
 */
let runtimeSingleton = null;
/** 设置监听器的 disposer 单例（热重载幂等，见 apply 内说明）。 */
let watchDisposerSingleton = null;
let controllerSingleton = null;

/**
 * 已注册的 settings scope。
 *
 * settings 服务对重复注册是**抛错**的（`settings namespace "..." is already
 * registered`），所以第二次 `apply()` 不能再去 register，必须复用首次的
 * scope。这也是幂等要求的一部分。
 */
let settingsScopeSingleton = null;

/** 单例状态目录：契约要求持久化水位线，重启后不回放历史。 */
function resolveStateDir() {
  // DSH_XIAOAI_STATE_DIR 供测试/隔离环境覆盖（默认 <DSH_HOME>/xiaoai-state）。
  return process.env.DSH_XIAOAI_STATE_DIR ?? `${process.env.DSH_HOME ?? "/data/dsh"}/xiaoai-state`;
}

/**
 * 解析宿主服务：先问本插件 ctx，再借 agent 服务的 ctx。
 *
 * 为什么需要第二跳：本插件的 ctx 只挂载了它自己 inject 的服务，
 * 而 agentPresets / agentDefaultModel / sessionController 等由更晚注册的
 * 插件提供，在插件 ctx 上用 `get(name, false)` 会得到 undefined
 * （实测：`preset 服务不可用: presets=undefined`，导致 agent 缺预设装配，
 *  对话时报 `Cannot read properties of undefined (reading 'kind')`）。
 *
 * agent 服务本身能取到（它就是 dsh-agent 提供的），而它的 ctx 处在完整的
 * 服务图里，因此从它那里再 get 一次即可看到其余宿主服务。
 * 官方 dsh-api-session-controller 直接用 this.ctx.get("agentPresets")
 * （lib/index.js:357）能拿到，正是因为它运行在完整 ctx 上。
 */
function hostService(ctx, name) {
  // 第一跳：本插件 ctx
  try {
    const direct = ctx.get?.(name, false);
    if (direct) return direct;
  } catch {
    /* 继续尝试第二跳 */
  }
  // 第二跳：借 agent 服务的 ctx
  try {
    const agents = ctx.get?.("agents", false);
    const hostCtx = agents?.ctx ?? agents?.[Symbol.for("cordis.ctx")];
    const viaHost = hostCtx?.get?.(name, false);
    if (viaHost) return viaHost;
  } catch {
    /* 忽略 */
  }
  return null;
}

/**
 * 取得（或创建）运行时单例。
 *
 * @param {object} ctx 插件上下文，用于取 logger 与 agents 服务。
 * @returns {XiaoaiRuntime}
 */
function getRuntime(ctx) {
  if (runtimeSingleton) return runtimeSingleton;

  const logger =
    typeof ctx?.logger === "function"
      ? (msg) => {
          // DSH 的 logger 有 name/debug/info/warn/error；优先 info。
          const l = ctx.logger("dsh-xiaoai");
          (l?.info ?? l?.debug ?? console.log)(msg);
        }
      : (msg) => console.log(`[dsh-xiaoai] ${msg}`);

  const stateDir = resolveStateDir();
  runtimeSingleton = new XiaoaiRuntime({ logger, stateDir });

  // 进程内语音会话：cwd 用独立目录，避免语音会话污染用户工作区。
  //
  // 不直接传 ctx —— 而是传一个【延迟解析】的代理：真正用到 agents 时才去取。
  // 这样即使 dsh-agent 在本插件之后才注册，也不会导致插件 pending。
  try {
    runtimeSingleton.bindAgentFactory({
      ctx: {
        // runtime 需要的是 ctx.agents 与 ctx.on("session/event", ...)。
        get agents() {
          // 非严格模式：服务还没注册时返回 undefined，而不是抛错。
          const a = ctx.get?.("agents", false);
          if (!a) {
            throw new Error("agents 服务尚未就绪（dsh-agent 可能仍在加载）");
          }
          return a;
        },
        /**
         * 默认模型选择（provider/model）—— agents.create 必须带 agentOptions。
         * 取法：先问本插件 ctx，取不到就借宿主 agent 服务的 ctx。
         */
        get agentDefaultModel() {
          return hostService(ctx, "agentDefaultModel");
        },
        /** Agent 预设服务：官方 composeAgent 用它挂载默认预设（必需）。 */
        get agentPresets() {
          return hostService(ctx, "agentPresets");
        },
        /**
         * 工作区注册表 —— 纯 in-process Cordis 服务（`super(ctx,"workspaceRegistry")`，
         * @deepseek-ai/dsh-workspace/lib/index.js:313-333）。
         * 提供 list() / get(id) / create(path)，这正是 session.create 需要的
         * `workspaceId` 的唯一来源。见 runtime 的 #ensureAgent 注释。
         */
        get workspaceRegistry() {
          return hostService(ctx, "workspaceRegistry");
        },
        /**
         * Session 远程命令控制器（`super(ctx,"sessionController",{namespace:"session"})`，
         * @deepseek-ai/dsh-api-session-controller/lib/index.js:2695）。
         * 它的 `create(request)` / `selectModel(request)` 就是 Host 侧
         * `session.create` / `session.selectModel` 的实现本体 ——
         * 走它等价于走 RPC，但没有 wire 序列化开销。
         */
        get sessionController() {
          return hostService(ctx, "sessionController");
        },
        /**
         * Typert 网关 —— 远程方法的统一调用入口（`invoke({namespace,method,args})`，
         * @deepseek-ai/dsh-api-gateway/lib/index.js:529-545）。
         * ⚠️ 实测结论见 runtime.js 的 `#callSessionCreate`：网关的
         * `resolveDescriptor` 依赖 `ctx.typert.local` 严格定义表，插件侧 ctx
         * 拿到的实例可能未挂该表 —— 因此运行时优先用 sessionController，
         * 网关只作为备选。
         */
        get typertGateway() {
          return hostService(ctx, "typertGateway");
        },
        /** 记录 agent 的模型选择（可选，官方 installSelection 的委托目标）。 */
        get installSelection() {
          const sc = hostService(ctx, "sessionController");
          // ⚠️ installSelection 在 SessionCommandController 上是【内部方法】，
          // 由 composeAgent 的 setup 调用；对外暴露的是
          // SessionController.installSelection(agent)（lib/index.js:465 走的
          // selectionFor）。这里做 null 保护，拿不到就不装。
          return typeof sc?.installSelection === "function" ? sc.installSelection.bind(sc) : null;
        },
        on: (...args) => ctx.on(...args),
      },
      // ⚠️ cwd 不再在这里硬编码：真正的解析在 runtime.#resolveWorkspacePath()，
      // 它读 settings 的 `workspace` 字段，空则回落 DSH 默认 IM 工作区
      // （~/.dsh/im，与 dsh-im 的 defaultImWorkspace 对齐）。
      cwd: process.env.DSH_XIAOAI_CWD ?? null,
      stateDir,
    });
  } catch (err) {
    runtimeSingleton.log(`绑定 agents 服务失败，将回退 HTTP 桥接: ${err?.message ?? err}`);
  }

  return runtimeSingleton;
}

/**
 * 构造 Schemastery 设置 schema（契约 §2 逐字段对应）。
 *
 * 用宿主里的 `@deepseek-ai/schemastery`：settings 服务本身用 Schemastery
 * 校验（`register(ns, schema)`），用 zod 会直接抛类型错。
 *
 * 每个字段都 `.default(...)`，保证 `resolve()` 总能给出完整对象。
 * `password` / `dshApiToken` 标 `role("secret")` ——
 * `describe({redactSecrets:true})` 会据此打码。
 *
 * @param {object} z Schemastery 模块（默认导出）。
 * @returns {object} z.object schema。
 */
function buildSettingsSchema(z) {
  return z.object({
    /** 总开关；false 时轮询循环挂起。 */
    enabled: z.boolean().default(DEFAULTS.enabled),
    /** 小米 ID（不是手机号）。 */
    userId: z.string().default(DEFAULTS.userId),
    /** 小米账号密码（敏感）。 */
    password: z.string().role("secret").default(DEFAULTS.password),
    /** 音箱设备 ID 或米家名称。 */
    did: z.string().default(DEFAULTS.did),

    // ── 首次接入向导（onboarding）写入的字段 ──
    //
    // ⚠️ 只【新增】字段，不动 workspace/agentPreset/model 等既有字段。
    /** 音箱型号（如 "OH2P"）；空 = 由连接时从设备 hardware 自动识别。 */
    deviceModel: z.string().default(ONBOARDING_DEFAULTS.deviceModel),
    /** 型号未收录时手动指定的 TTS 指令（格式 "7,3"）；空 = 用兼容表默认值。 */
    ttsCommand: z.string().default(ONBOARDING_DEFAULTS.ttsCommand),
    /** 型号未收录时手动指定的唤醒指令（格式 "7,1"）。 */
    wakeUpCommand: z.string().default(ONBOARDING_DEFAULTS.wakeUpCommand),
    /** 是否已完成首次接入向导（用于决定 UI 首屏显示向导还是完整面板）。 */
    onboarded: z.boolean().default(ONBOARDING_DEFAULTS.onboarded),
    /** 轮询间隔，最小 2000（runtime.applyConfig 会再次夹紧）。 */
    pollIntervalMs: z.number().default(DEFAULTS.pollIntervalMs),
    /** 等待 DSH 回复的超时。 */
    replyTimeoutMs: z.number().default(DEFAULTS.replyTimeoutMs),
    /** 回复截断长度（音箱念太长很难受）。 */
    maxReplyChars: z.number().default(DEFAULTS.maxReplyChars),
    /** 空 = 全部转发；非空 = 前缀匹配。 */
    triggerKeywords: z.array(z.string()).default([...DEFAULTS.triggerKeywords]),
    /** 正则，匹配则忽略。 */
    ignorePatterns: z.array(z.string()).default([...DEFAULTS.ignorePatterns]),
    // ── 音箱侧：唤醒与 AI 模式 ──
    /** 启用 AI 模式状态机；false 时退化为旧的逐条关键词匹配。 */
    aiModeEnabled: z.boolean().default(DEFAULTS.aiModeEnabled),
    /** 「直接问」：以这些词开头时立刻交给 DSH，但不改变模式。 */
    callAIKeywords: z.array(z.string()).default([...DEFAULTS.callAIKeywords]),
    /** 「进入 AI 模式」：之后所有话都交给 DSH，无需重复喊触发词。 */
    wakeUpKeywords: z.array(z.string()).default([...DEFAULTS.wakeUpKeywords]),
    /** 「退出 AI 模式」：回到 idle，普通话不再处理。 */
    exitKeywords: z.array(z.string()).default([...DEFAULTS.exitKeywords]),
    /** AI 模式下无对话多久自动退出（秒，最小 5）。 */
    exitKeepAliveAfter: z.number().default(DEFAULTS.exitKeepAliveAfter),
    /** 进入 AI 模式的提示语（空数组 = 不播报）。 */
    onEnterAI: z.array(z.string()).default([...DEFAULTS.onEnterAI]),
    /** 退出 AI 模式的提示语。 */
    onExitAI: z.array(z.string()).default([...DEFAULTS.onExitAI]),
    /** 思考中的提示语（随机取一条）。 */
    onAIAsking: z.array(z.string()).default([...DEFAULTS.onAIAsking]),
    /** 回答完毕的提示语。 */
    onAIReplied: z.array(z.string()).default([...DEFAULTS.onAIReplied]),
    /** 出错时的提示语。 */
    onAIError: z.array(z.string()).default([...DEFAULTS.onAIError]),
    /** DSH 桥接端点（仅在无法用进程内 agent 时使用）。 */
    dshApiUrl: z.string().default(DEFAULTS.dshApiUrl),
    /** 桥接鉴权（敏感）。 */
    dshApiToken: z.string().role("secret").default(DEFAULTS.dshApiToken),
    /** 详细日志。 */
    verboseLog: z.boolean().default(DEFAULTS.verboseLog),

    // ── 会话绑定（契约 §2 扩展） ──
    //
    // 这四项决定语音会话「长什么样」：在哪个工作区、用哪套 Agent 预设、
    // 用哪个模型。缺任何一项都会让 UI 显示「工作目录未知」或让 LLM 调用失败。
    /** 工作目录绝对路径；空 = 用 DSH 默认 IM 工作区（~/.dsh/im）。 */
    workspace: z.string().default(DEFAULTS.workspace),
    /** Agent 预设 id（如 "standard"）；空 = 用宿主默认预设。 */
    agentPreset: z.string().default(DEFAULTS.agentPreset),
    /** 模型 provider；与 model 成对生效，空 = 用宿主默认模型。 */
    provider: z.string().default(DEFAULTS.provider),
    /** 模型 id；与 provider 成对生效。 */
    model: z.string().default(DEFAULTS.model),
    /** 重启后是否复用上次绑定的会话（探活失败仍会新建）。 */
    sessionReuse: z.boolean().default(DEFAULTS.sessionReuse),
  });
}

/**
 * 插件入口。
 *
 * @param {object} ctx Cordis 上下文（提供 settings / agents / effect / logger）。
 * @param {object} [config] 组合配置（本插件全部设置走 settings 命名空间，
 *   此参数保留给 loader 传入，当前未使用）。
 * @returns {Promise<() => Promise<void>>} disposer。
 */

/**
 * 哨兵日志 —— 直写文件，绕过所有 stdout / 日志管线。
 *
 * 为什么需要它：
 *   排查「插件在 loader 树里但 apply 不执行、DSH 日志零输出」时，无法区分
 *   三种情况：(a) apply 根本没被调用；(b) 被调用了但卡在中间；(c) 跑完了
 *   但输出没进日志。stdout 本身可能就是失效的那一环 —— 所以必须直接写文件，
 *   并且每步都写，用「文件是否存在 / 最后写到哪一步」来定位。
 *
 * 排查结束后应该删掉，或者用 XIAOAI_SENTINEL=0 关掉。
 * 位置：$DSH_HOME/xiaoai-sentinel.log
 */
const SENTINEL_FILE = `${process.env.DSH_HOME ?? "/data/dsh"}/xiaoai-sentinel.log`;

function sentinel(step, extra = "") {
  if (process.env.XIAOAI_SENTINEL === "0") return;
  try {
    const line = `${new Date().toISOString()} pid=${process.pid} ${step}${extra ? " " + extra : ""}\n`;
    appendFileSync(SENTINEL_FILE, line);
  } catch {
    /* 哨兵本身失败不能影响插件 */
  }
}

export function apply(ctx, config = {}) {
  // ⚠️ 这一行必须最先执行：它是「apply 到底有没有被调用」的唯一可靠证据。
  sentinel("apply:enter", `inject=${JSON.stringify(inject)}`);
  void config;
  const runtime = getRuntime(ctx);
  runtime.log("dsh-xiaoai 服务端正在加载…");
  sentinel("apply:runtime-ready");

  const disposers = [];

  /**
   * 异步装配在后台跑，但 `apply` 本身【必须同步返回】。
   *
   * Cordis 按同步契约调用 apply(ctx) 并忽略返回值。若写成 async function，
   * 内部一旦抛错就变成「未处理的 Promise 拒绝」—— 插件表面加载成功、
   * 实际完全没生效，日志里也看不到痕迹（极难排查）。
   * 故改为显式 IIFE + 全量 catch，把失败写进 runtime 状态供 UI 展示。
   */
  const boot = (async () => {
    sentinel("boot:start");

  // ── 1. 设置命名空间（契约 §2） ──
  //
  // 幂等：settings 服务对重复注册会抛错，因此第二次 apply() 复用已有 scope。
  // 幂等关键：在【发起注册前】就把 promise 存进单例，而不是等它 resolve。
  // 否则第二次 apply() 会在第一次尚未 resolve 时再次 register → 抛
  // "settings namespace ... is already registered"（test_host.mjs 已复现）。
  if (!settingsScopeSingleton) {
    settingsScopeSingleton = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      try {
        // ctx.inject(services, callback) 是 DSH 标准的“服务就绪后回调”形态。
        // ⚠️ 它返回的是【fiber】（可 await、有 .then），**不是** Promise：
        // 直接调 `ret.catch(...)` 会抛 "ret.catch is not a function"
        // （真机加载时实测到的坑，假 ctx 掩盖了它）。
        // 因此这里用 Promise.resolve() 包一层再挂 catch。
        const ret = ctx.inject(["settings"], async (sctx) => {
          try {
            const z = await loadSchemastery();
            const scope = sctx.settings.register(SETTINGS_NS, buildSettingsSchema(z));
            if (!settled) {
              settled = true;
              resolve({ scope, settings: sctx.settings });
            }
          } catch (err) {
            fail(err);
          }
        });
        // 注入失败（服务不可用等）要能冒到调用方，而不是静默悬挂。
        if (ret && typeof ret.then === "function") {
          Promise.resolve(ret).catch(fail);
        }
      } catch (err) {
        fail(err);
      }
      // 兜底：注入迟迟不回调时不让 apply 永久挂起。
      setTimeout(() => {
        fail(new Error(`settings 服务在 10s 内未就绪，无法注册命名空间 ${SETTINGS_NS}`));
      }, 10_000).unref?.();
    });
  }
  const settingsScope = await settingsScopeSingleton;

  // 绑定 scope → runtime，并立刻应用一次配置。
  sentinel("boot:settings-registered");
  sentinel("boot:before-bindSettings");
  runtime.bindSettings(settingsScope.scope);
  sentinel("boot:bound", `raw=${JSON.stringify(settingsScope.scope.get?.() ?? null)}`);
  runtime.applyConfig();
  sentinel("boot:config-applied", `userId=${runtime.config?.userId ?? "?"} did=${runtime.config?.did ?? "?"}`);
  runtime.log(`设置命名空间已注册: ${SETTINGS_NS}`);

  // ── 2. 设置读写门面（供 RPC 使用，且绝不外泄敏感值） ──

  /**
   * 读当前设置视图（密码打码）+ revision。
   *
   * 值必须取自【未打码】的 scope.get()：`describe({redactSecrets:true}).value`
   * 会把 secret 字段整个删掉，客户端就无法区分“未设置”与“已设置但被打码”，
   * UI 会把已配好的账号显示成没配。revision 仍从 describe 取（scope 上没有）。
   */
  const getSettingsView = () => {
    const descriptor = settingsScope.settings
      .describe({ redactSecrets: true })
      .find((candidate) => candidate.ns === SETTINGS_NS);
    const raw = settingsScope.scope.get?.() ?? {};
    return {
      values: redactValues(raw),
      revision: descriptor?.revision ?? 0,
    };
  };

  /**
   * 写设置并返回新视图。
   *
   * 用服务层的 `update(ns, patch, expectedRevision)` 而不是 scope.update()：
   * 契约 §4 要求 `xiaoai.settings.update` 支持 revision 冲突检测，
   * 而 scope 上的 `update(patch)` 签名不带 revision（见 DSH-PLUGIN-API.md §2）。
   *
   * @param {object} patch 已净化的补丁。
   * @param {number} revision 客户端读到的 revision。
   */
  const updateSettings = async (patch, revision) => {
    await settingsScope.settings.update(SETTINGS_NS, patch, revision);
    runtime.applyConfig();
    return getSettingsView();
  };

  // ── 3. RPC 端点（契约 §4，Typert Remote） ──
  //
  // 幂等：第二次 apply() 不重复实例化控制器（同一 ctx 键重复 provide 会报错）。
  sentinel("boot:rpc-begin");
  try {
    if (controllerSingleton === null) {
      sentinel("boot:rpc-loading-protocol");
      const protocol = await loadTypertProtocol();
      sentinel("boot:rpc-protocol-loaded");
      const XiaoaiController = createXiaoaiControllerClass(protocol, runtime, {
        getSettingsView,
        updateSettings,
      });

      // TypertRemoteService 的构造函数内部就调用
      // `ctx.reflect.provide(serviceKey, self)` 完成自我注册
      // （cordis 的 Service 基类约定，见 @deepseek-ai/cordis/lib/index.js），
      // 因此这里【不需要】再手工 ctx.provide —— 重复注册反而会报错。
      // Gateway 随后通过 ctx.reflect.props 找到该 service。
      sentinel("boot:rpc-constructing");
      new XiaoaiController(ctx);
      sentinel("boot:rpc-constructed");
      controllerSingleton = XiaoaiController;
      sentinel("boot:rpc-singleton-set");
      runtime.log(
        `RPC 已注册: namespace=${RPC_NAMESPACE} (service=${RPC_SERVICE_KEY}) 端点 xiaoai/status, xiaoai/settings.get, xiaoai/settings.update, xiaoai/restart, xiaoai/test, xiaoai/speak, xiaoai/logs, xiaoai/onboarding.importScan, xiaoai/onboarding.login, xiaoai/onboarding.discoverSpeakers, xiaoai/onboarding.apply, xiaoai/onboarding.models`,
      );
    } else {
      runtime.log("RPC 已存在，跳过重复注册（幂等）");
    }
  } catch (err) {
    sentinel("boot:rpc-FAILED", String(err?.message ?? err));
    const msg = `RPC 注册失败: ${err?.message ?? err}`;
    runtime.log(msg);
    Object.assign(runtime.status, { phase: "error", lastError: msg });
  }

  // ── 4. 启动运行时（失败不能抛出 apply） ──
  //
  // 任务要求 §5：启动失败只记录到 status，插件必须仍然加载成功，
  // 这样 UI 才能把错误展示给用户。runtime.start() 内部已经把多数
  // 失败写进 status，但配置缺失/连接异常仍可能 throw，这里兜住。
  try {
    sentinel("boot:runtime-start-begin");
    await runtime.start();
    sentinel("boot:runtime-start-done", `phase=${runtime.status.phase} lastError=${runtime.status.lastError}`);
  } catch (err) {
    const msg = `启动失败: ${err?.message ?? err}`;
    runtime.log(msg);
    Object.assign(runtime.status, { phase: "error", lastError: msg });
  }

  // 设置变化时同步到 runtime（用户直接在设置面板手改也生效）。
  //
  // ⚠️ 必须做幂等保护：apply() 可能被热重载多次调用（三个单例都设计成可复用），
  // 而每次调用都会新注册一个 watch 回调 —— 重载 N 次后，一次设置写入会触发
  // N 次 applyConfig()。这里记住已注册的那个，重复调用直接复用。
  if (typeof settingsScope.scope.watch === "function" && watchDisposerSingleton === null) {
    const off = settingsScope.scope.watch(() => {
      runtime.applyConfig();
    });
    watchDisposerSingleton = typeof off === "function" ? off : () => {};
    disposers.push(watchDisposerSingleton);
  } else if (watchDisposerSingleton !== null) {
    runtime.log("设置监听已存在，跳过重复注册（幂等）");
  }

  })();

  // 后台装配失败绝不能让异常逃逸（见 boot 说明）——记录到状态即可。
  boot.then(() => sentinel("boot:done-all")).catch((err) => {
    sentinel("boot:FAILED", String(err?.message ?? err));
    const msg = `插件装配失败: ${err?.message ?? err}`;
    try {
      runtime.log(msg);
      Object.assign(runtime.status, { phase: "error", lastError: msg });
    } catch {
      /* 连日志都失败就只能放弃 */
    }
  });

  // ── 5. disposer ──
  return async () => {
    runtime.log("dsh-xiaoai 正在卸载…");
    for (const dispose of disposers.reverse()) {
      try {
        await dispose();
      } catch (err) {
        runtime.log(`卸载清理失败: ${err?.message ?? err}`);
      }
    }
    try {
      await runtime.stop();
    } catch (err) {
      runtime.log(`停止运行时失败: ${err?.message ?? err}`);
    }
    // 保留单例：热重载后复用同一实例，避免重复轮询。
  };
}

// ───────────────────── Schemastery（从宿主解析） ─────────────────────

/** 缓存，避免每次 apply 都重新解析。 */
let schemasteryPromise = null;

/**
 * 载入宿主里的 Schemastery。
 *
 * 为什么不直接 `import z from "@deepseek-ai/schemastery"`：
 * 本插件是 `link:` 进 profile 的，自身的 node_modules 里没有
 * `@deepseek-ai/*`（实测 ERR_MODULE_NOT_FOUND）。DSH 用 cordis loader
 * 的 `internal.import(name, bareModuleBaseUrl)` 把【裸包名】解析到安装目录，
 * 但那只对 loader 自己加载的插件入口生效；插件内部的二次 import
 * 仍需自己锚定。这里与其他宿主包共用同一套锚点策略。
 *
 * @returns {Promise<object>} Schemastery 默认导出。
 */
async function loadSchemastery() {
  schemasteryPromise ??= (async () => {
    const { createRequire } = await import("node:module");
    const { pathToFileURL } = await import("node:url");
    const home = process.env.DSH_HOME ?? "/data/dsh";
    // ⚠️ 锚点必须覆盖 DSH 的【所有】安装形态（事故修复）：
    //   1) addon 形态：DSH 在 $DSH_HOME/vendor（HA addon 的一键更新目录）
    //   2) 全局 npm 形态：DSH 在 nvm/系统 node 的 lib/node_modules
    //      —— 台式机就是这种，旧实现只找 $DSH_HOME，导致
    //         「无法载入 Schemastery」→ 插件装配失败。
    //   3) 当前进程的模块解析路径（最可靠：插件跑在 DSH 进程里，
    //      它的 node_modules 链一定能看到 DSH 自己的依赖）
    // 锚点按【可靠性】排序，第一个命中即返回：
    //   ① DSH_BIN / argv[1] 反推 —— 最可靠：直接指向正在运行的那个 DSH
    //   ② $DSH_HOME/vendor —— HA addon 的一键更新目录
    //   ③ $DSH_HOME/node_modules —— 少数部署形态
    //   ④ 插件自身 —— 仅在插件与 DSH 共享 node_modules 链时有效（通常无效）
    const dshBin = process.env.DSH_BIN ?? process.argv[1] ?? "";
    const dshRoot = dshBin.replace(/\/lib\/bin\.(js|mjs|cjs)$/, "");
    const anchors = [
      ...(dshRoot ? [`${dshRoot}/package.json`,
                     `${dshRoot}/node_modules/@deepseek-ai/dsh/package.json`] : []),
      `${home}/vendor/node_modules/@deepseek-ai/dsh/package.json`,
      `${home}/vendor/node_modules/@deepseek-ai/dsh-settings/package.json`,
      `${home}/node_modules/@deepseek-ai/dsh/package.json`,
      new URL("../package.json", import.meta.url).pathname,
    ].filter(Boolean);
    const failures = [];
    for (const anchor of anchors) {
      for (const spec of ["@deepseek-ai/schemastery", "schemastery"]) {
        try {
          const resolved = createRequire(anchor).resolve(spec);
          const mod = await import(pathToFileURL(resolved).href);
          const z = mod?.default ?? mod;
          if (typeof z?.object !== "function") {
            throw new TypeError(`${spec} 的导出不是 Schemastery（缺少 z.object）`);
          }
          return z;
        } catch (err) {
          failures.push(`${anchor} → ${spec}: ${err?.code ?? err?.message ?? err}`);
        }
      }
    }
    throw new Error(
      `无法载入 Schemastery（它由 DSH 自身携带）。已尝试的解析锚点:\n  ${anchors.join("\n  ")}\n` +
        `失败详情:\n  ${failures.join("\n  ")}`,
    );
  })();
  return schemasteryPromise;
}
