/**
 * xiaoai RPC 控制器 —— 契约 §4 的 7 个方法。
 *
 * 机制：DSH 官方 **Typert Remote**（`@deepseek-ai/dsh-typert-protocol`）。
 * `XiaoaiController` 继承 `TypertRemoteService` 并把 namespace 设为 `xiaoai`，
 * 于是每个 `@Remote` 方法自动成为线端点 `xiaoai/<method>`，
 * 客户端用 `ctx.remote.xiaoai.<method>()` 调用，拿到
 * `{ok:true,value}` / `{ok:false,error:{code,message,details}}` 联合。
 *
 * ⚠️ 为什么不用装饰器语法（`@Remote`）：
 * 本插件被明令要求“无构建步骤、纯 JS ESM”。JS 装饰器语法 `@Remote`
 * 需要转译器（Node 尚未默认启用 decorators），而 Typert 的 `Remote()`
 * 本身是【双形态】API —— 直接调用 `Remote("exportName")` 会返回一个
 * 标准的 TC39 method decorator。这里用 `applyRemote()` 在类定义后
 * 手工施加它，产出与 `@Remote` **逐字节相同**的原型标记
 * （已实测：`remoteMethods()` 读回 `{method, exportName, invocation:{kind:"direct"}}`）。
 * Gateway 的 `resolveSrcDescriptor()` 正是读这个标记，因此两条路径等价。
 *
 * 不用 `@RemoteScope`：它标记 `invocation:{kind:"context"}`，要求
 * Gateway 里存在对应 Context provider（`ctx.typert.contexts.getHost`），
 * 本插件没有注册 provider，用了会在调用时报 `gateway/context-unavailable`。
 * 契约 §4 的 7 个方法都是无接收者的直接调用，用 `kind:"direct"` 正确。
 */
import { dirname } from "node:path";
import { readFileSync as readFileSyncImpl } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SPEAKER_MODELS,
  applyCredentials,
  commandForModel,
  discoverImportableCredentials,
  loginWithAccount,
  probeSpeakers,
} from "./onboarding.js";
import { resolveMiStorePath } from "./bootstrap.js";
import {
  normalizeSettings,
  upsertSpeaker,
  projectDid,
  projectDeviceModel,
  summarizeSpeakers,
} from "./settings-normalize.js";

/** 本模块所在目录（ESM 无 __dirname）。 */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 契约 §2 的命名空间，同时也是线端点前缀 `xiaoai/*`。
 * 必须满足 `isTypertRemoteSegment()`（`/^[A-Za-z0-9_$.-]+$/`）。
 */
export const RPC_NAMESPACE = "xiaoai";

/** RPC 里暴露的 Cordis 服务键（`ctx.xiaoaiController` 可取出该实例）。 */
export const RPC_SERVICE_KEY = "xiaoaiController";

// ─────────────────── 从 DSH 安装位置解析 @deepseek-ai/* ───────────────────
//
// 【关键】本插件通过 `link:` 挂在 /data/dsh/profiles/web/package.json，
// 但模块加载走的是 cordis loader 的 `internal.import(name, bareModuleBaseUrl)`，
// 它把【裸包名】解析到 **DSH 安装目录**（/data/dsh/vendor/node_modules），
// 而不是插件自身的 node_modules —— 插件目录下 neither `@deepseek-ai/*`
// 也不存在（实测 ERR_MODULE_NOT_FOUND）。
// 因此这里用 createRequire 锚定 vendor 里的 @deepseek-ai/dsh，
// 让 specifier **保持裸名**，从而与宿主共享同一份 typert-protocol 实例。
// 这一点很重要：Typert 靠原型上的字符串属性传标记，但 `RemoteError`
// 会被 Gateway 做结构化识别，共享实例能避免任何跨副本歧义。
//
// 解析顺序兜底：DSH_HOME → 默认 /data/dsh → 相对本文件向上找。
/**
 * 依次尝试的锚点包，先命中的为准。
 *
 * ⚠️ 顺序按【可靠性】排（事故修复）：
 *   DSH 有多种安装形态，旧实现只找 $DSH_HOME，于是全局 npm 形态下
 *   四个锚点全部 MODULE_NOT_FOUND，表现为「无法解析宿主包
 *   @deepseek-ai/dsh-typert-protocol」→ RPC 注册失败 → UI 读不到状态。
 *
 *   1) DSH_BIN / process.argv[1] 反推 —— 最可靠，直接指向正在运行的 DSH
 *      （台式机的 DSH 在 <nvm>/lib/node_modules，不在 $DSH_HOME 下）
 *   2) $DSH_HOME/vendor —— HA addon 的一键更新目录
 *   3) $DSH_HOME/node_modules —— 少数部署形态
 *   4) 插件自身向上找 —— 仅在共享 node_modules 链时有效
 */
const ANCHOR_CANDIDATES = [
  () => {
    const bin = process.env.DSH_BIN ?? process.argv[1] ?? "";
    const root = bin.replace(/\/lib\/bin\.(js|mjs|cjs)$/, "");
    return root ? `${root}/package.json` : null;
  },
  () => {
    const bin = process.env.DSH_BIN ?? process.argv[1] ?? "";
    const root = bin.replace(/\/lib\/bin\.(js|mjs|cjs)$/, "");
    return root ? `${root}/node_modules/@deepseek-ai/dsh/package.json` : null;
  },
  () => `${process.env.DSH_HOME ?? "/data/dsh"}/vendor/node_modules/@deepseek-ai/dsh/package.json`,
  () => `${process.env.DSH_HOME ?? "/data/dsh"}/node_modules/@deepseek-ai/dsh/package.json`,
  () => `${HERE}/../node_modules/@deepseek-ai/dsh/package.json`,
  () => `${HERE}/../../../vendor/node_modules/@deepseek-ai/dsh/package.json`,
].filter((f) => f() !== null);

/**
 * 从宿主安装位置动态 import 一个 `@deepseek-ai/*` 包。
 *
 * @param {string} specifier 裸包名，例如 `@deepseek-ai/dsh-typert-protocol`。
 * @returns {Promise<object>} 该包的模块命名空间对象。
 * @throws {Error} 所有锚点都解析不到时，抛出带排查提示的显式错误。
 */
async function importFromHost(specifier) {
  const failures = [];
  for (const anchorOf of ANCHOR_CANDIDATES) {
    const anchor = anchorOf();
    try {
      // 锚点必须是真实存在的 package.json，否则 createRequire 会抛。
      const { createRequire } = await import("node:module");
      const resolved = createRequire(anchor).resolve(specifier);
      return await import(pathToFileURL(resolved).href);
    } catch (err) {
      failures.push(`${anchor}: ${err?.code ?? err?.message ?? err}`);
    }
  }
  throw new Error(
    `无法解析宿主包 ${specifier}。已尝试:\n  ${failures.join("\n  ")}\n` +
      `请确认 DSH 安装目录可被解析（DSH_BIN=${process.env.DSH_BIN ?? "(未设置)"}, argv[1]=${process.argv[1] ?? "(无)"}, DSH_HOME=${process.env.DSH_HOME ?? "(未设置)"}）。`,
  );
}

/** 懒加载并缓存宿主模块，避免重复解析。 */
let hostModulesPromise = null;

/**
 * 载入 Typert 协议模块（`TypertRemoteService` / `Remote` / `RemoteError`）。
 *
 * @returns {Promise<{TypertRemoteService: Function, Remote: Function, RemoteError: Function}>}
 */
export function loadTypertProtocol() {
  hostModulesPromise ??= (async () => {
    const mod = await importFromHost("@deepseek-ai/dsh-typert-protocol");
    for (const key of ["TypertRemoteService", "Remote", "RemoteError"]) {
      if (typeof mod?.[key] !== "function") {
        throw new TypeError(`@deepseek-ai/dsh-typert-protocol 缺少导出 ${key}`);
      }
    }
    return mod;
  })();
  return hostModulesPromise;
}

// ─────────────────── 无构建步骤地施加 @Remote 标记 ───────────────────

/**
 * 把 Typert 的 `@Remote` 语义手工施加到一个已定义的类方法上。
 *
 * 等价于在源码里写 `@Remote` 或 `@Remote(exportName)`，但不需要转译器：
 * `Remote()` 的字符串形态返回标准 decorator，我们按 TC39 规范调用它
 * （`decorator(method, context)` + `context.addInitializer(fn)`），
 * 再把 initializer 以类原型为 `this` 执行一次。
 *
 * @param {Function} Remote   Typert 的 `Remote`（双形态 API）。
 * @param {Function} ctor     目标类。
 * @param {string}   method   类上的方法名。
 * @param {string}   [exportName] 线端点名；省略则用方法名。
 * @throws {TypeError} 方法不存在，或 Typert 拒绝了标记时。
 */
export function applyRemote(Remote, ctor, method, exportName) {
  const prototype = ctor.prototype;
  if (typeof prototype?.[method] !== "function") {
    throw new TypeError(`无法标记 Remote 方法 "${method}"：${ctor.name} 上没有该方法`);
  }
  const decorator = exportName === undefined ? Remote : Remote(exportName);
  if (typeof decorator !== "function") {
    throw new TypeError(`Remote(${JSON.stringify(exportName)}) 未返回 decorator，Typert API 可能已变更`);
  }

  const initializers = [];
  /** 复刻 TC39 method decorator context：只带 Typert 会读的字段。 */
  const context = {
    kind: "method",
    name: method,
    static: false,
    private: false,
    metadata: {},
    access: { has: (obj) => method in obj, get: (obj) => obj[method] },
    addInitializer(fn) {
      if (typeof fn !== "function") throw new TypeError("addInitializer 需要一个函数");
      initializers.push(fn);
    },
  };

  decorator(prototype[method], context);
  // ⚠️ initializer 的 `this` 在 TC39 规范里是【实例】，而 Typert 的
  // addMarkerInitializer 内部做的是 `Object.getPrototypeOf(this)` 来定位
  // 要打标记的原型。若像常见写法那样 `fn.call(prototype)`，取到的是
  // 【父类原型】(TypertRemoteService.prototype)，标记就会错落在父类上 ——
  // 现象是 remoteMethods(实例) 返回 0 个方法（已实测复现）。
  // 因此这里先造一个临时实例，用它的原型链定位：getPrototypeOf(实例) === prototype。
  const probe = Object.create(prototype);
  for (const fn of initializers) fn.call(probe);
}

// ───────────────────────── 取值与校验小工具 ─────────────────────────

/** 只接受普通对象；数组/null 视为未提供。 */
function asRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

/**
 * 参数校验：契约里所有方法都收【一个对象】。
 * 未传时按 `{}` 处理，传了非对象则显式报错 —— 静默忽略会让 UI 的
 * 调用错误被掩盖，排查起来很痛苦。
 *
 * @param {unknown} args 线上传来的参数。
 * @param {string} endpoint 端点名，仅用于错误信息。
 */
function asArgs(args, endpoint) {
  if (args === undefined || args === null) return {};
  const rec = asRecord(args);
  if (rec === undefined) throw new RemoteArgError(`${endpoint}: 参数必须是对象`);
  return rec;
}

/** 参数类错误（客户端传错），与运行时内部错误区分开的标记。 */
class RemoteArgError extends Error {
  constructor(message) {
    super(message);
    this.name = "RemoteArgError";
  }
}

/** 字符串字段：非字符串（除 undefined）一律拒绝。 */
function requireString(value, field) {
  if (typeof value !== "string") throw new RemoteArgError(`字段 ${JSON.stringify(field)} 必须是字符串`);
  return value;
}

/**
 * 敏感值打码。settings scope 的 `get()` 返回的是【未打码】的解析值
 * （打码只在 `describe({redactSecrets:true})` 生效），而 `xiaoai.settings.get`
 * 要发给客户端，因此必须在服务端自己打码。
 *
 * ⚠️ 为什么不能直接对 `describe({redactSecrets:true}).value` 再打码：
 * `redactSecrets` 会把 `role("secret")` 字段【整个删掉】（实测：
 * `{password:"hunter2",userId:"u1"}` → `{userId:"u1"}`，同时返回
 * `secrets:[{path:["password"],set:true}]`）。直接用它的 value，
 * 客户端就分不清“没设过”和“设了但被打码”——UI 会把已配置的账号
 * 显示成未配置。所以这里：以未打码的原始值为准，按 secrets 位置表
 * 判断“是否已设置”，再统一回掩码。
 *
 * @param {object} values 原始（未打码）设置值。
 * @returns {object} 打码后的副本；敏感字段要么是 ""（未设），要么是掩码。
 */
export function redactValues(values) {
  const MASK = "\u2022\u2022\u2022\u2022\u2022\u2022";
  const out = { ...values };
  for (const key of SECRET_KEYS) {
    const raw = out[key];
    out[key] = typeof raw === "string" && raw.length > 0 ? MASK : "";
  }
  return out;
}

/** 判断某个 patch 是否触碰了敏感字段且带上了真实值。 */
const SECRET_KEYS = Object.freeze(["password", "dshApiToken"]);

/**
 * 从 patch 里剔除“打码值回传”。
 *
 * 客户端拿到 `settings.get` 的打码值后，若原样把整个 values 当 patch 回传，
 * 会把掩码写进真实配置、毁掉凭据。这里把“等于掩码”的敏感字段视为未修改。
 *
 * @param {object} patch 客户端提交的补丁。
 * @returns {object} 安全的补丁。
 */
export function sanitizePatch(patch) {
  const MASK = "\u2022\u2022\u2022\u2022\u2022\u2022";
  const out = { ...patch };
  for (const key of SECRET_KEYS) {
    // 空串必须视为「未修改」，不能当成「主动清空」。
    //
    // 原因：客户端 loadSettings() 会把打码值（••••••）先转成空串再放进
    // 编辑框的初始值（见 src/client/index.js 的 password 初始化）。用户只改
    // 别的字段（如触发词）再点保存时，这个空串会被当成新值写回 —— 结果是
    // **静默抹掉已保存的小米密码**。而 password ∈ RESTART_KEYS，还会连带重启
    // runtime。当前因 vendor 复用 serviceToken 表面能跑，但 token 一过期就
    // 永久登不上（复现见 tmp-tests/verify_p0_1.mjs）。
    //
    // 需要真正清空凭据时，用下面的 CLEAR_SENTINEL 显式表达意图 ——
    // 保留「能清空」的能力，同时杜绝「误清空」。
    if (out[key] === MASK || out[key] === "") delete out[key];
    else if (out[key] === CLEAR_SENTINEL) out[key] = "";
  }
  return out;
}

/**
 * 显式的「清空此敏感字段」哨兵值。
 *
 * 客户端要清空密码/令牌时传这个字符串，而不是空串 —— 空串已被约定为
 * 「未修改」（见 sanitizePatch）。这样两种意图互不混淆。
 */
export const CLEAR_SENTINEL = "__XIAOAI_CLEAR__";

/**
 * 设置变更是否需要重启运行时（改账号/设备/开关都必须重启才生效）。
 *
 * ⚠️ 多音箱（设计 §7.2 / 风险 R6）：`speakers` **必须**在列表里。
 *    漏了它的后果是「用户增删/启停设备 → 保存 → 界面显示成功 → 但设备
 *    列表压根没重新加载」，用户以为改了实际没生效，且没有任何报错可循。
 *    `did` 保留：老字段、以及「只改代表设备」的写入路径仍在用它。
 */
const RESTART_KEYS = Object.freeze(["enabled", "userId", "password", "did", "speakers"]);

/**
 * 该 patch 是否要求重跑 `runtime.start()`。
 *
 * @param {object} patch 已净化的补丁。
 * @returns {boolean}
 */
export function needsRestart(patch) {
  return RESTART_KEYS.some((key) => Object.hasOwn(patch, key));
}

// ───────────────────────── 控制器 ─────────────────────────

/**
 * 创建 `XiaoaiController` 类。
 *
 * 之所以做成工厂而不是直接导出类：`TypertRemoteService` 基类必须从
 * 【宿主安装位置】动态载入（见 `importFromHost` 的说明），而 ESM 的
 * `extends` 在模块求值时就需要基类，无法在顶层 await 之后才决定。
 * 工厂把“载入宿主模块”推迟到 `apply()` 里。
 *
 * @param {{TypertRemoteService: Function, Remote: Function, RemoteError: Function}} protocol
 * @param {import("./runtime.js").XiaoaiRuntime} runtime
 * @param {object} deps 额外依赖：`getSettingsView()` / `updateSettings()`。
 * @returns {Function} 可直接 `new` 的控制器类。
 */
export function createXiaoaiControllerClass(protocol, runtime, deps) {
  const { TypertRemoteService, Remote, RemoteError } = protocol;
  const { getSettingsView, updateSettings } = deps;

  /**
   * 把内部异常翻译成契约 §4 的错误联合。
   *
   * @param {unknown} err 捕获到的异常。
   * @param {string} endpoint 端点名，用于日志。
   */
  const fail = (err, endpoint) => {
    if (err instanceof RemoteArgError) {
      runtime.log(`RPC ${endpoint} 参数错误: ${err.message}`);
      return new RemoteError("xiaoai/bad-request", err.message, {});
    }
    // SettingsConflictError：契约 §4 明确要求 revision 冲突返回错误。
    if (err?.code === "SETTINGS_CONFLICT") {
      runtime.log(`RPC ${endpoint} revision 冲突: ${err.message}`);
      return new RemoteError("xiaoai/settings-conflict", err.message, {
        expected: err.expected ?? null,
        actual: err.actual ?? null,
      });
    }
    runtime.log(`RPC ${endpoint} 失败: ${err?.message ?? err}`);
    return new RemoteError("xiaoai/internal", String(err?.message ?? err), {});
  };

  /**
   * xiaoai 运行时控制器。方法名即线端点名（`xiaoai/<method>`）。
   *
   * 注意：Typert 会把方法首参按【参数名】映射到线字段（source mode 下
   * `wire === name`），客户端按名字传参。因此这里的参数名就是线上契约，
   * 改名等于改协议 —— 不要重命名。
   */
  class XiaoaiController extends TypertRemoteService {
    /**
     * @param {object} ctx 绑定的 Cordis 上下文。
     */
    constructor(ctx) {
      super(ctx, RPC_SERVICE_KEY, { namespace: RPC_NAMESPACE });
    }

    /**
     * `xiaoai.status` → 契约 §3 的 XIAOAI_STATUS。
     *
     * 直接回 `runtime.status` 的快照副本：runtime 会原地 `Object.assign`
     * 修改 status，把引用发出去会让调用方看到后续变化，破坏快照语义。
     *
     * ── 多音箱（设计 §6.4）──
     *   status.speakers[] —— 新增：每台设备的独立状态（权威来源）
     *   status.speaker     —— 保留投影 = speakers[0]（老 UI 在读它）
     *
     * 两者由 runtime 的 `#syncSpeakerStatus()` 一并维护，这里只需原样透传。
     * 额外补一个 `speakerSummary` 便于 UI 直接显示「N 台 · M 在线」，
     * 省得每个前端各算一遍（算法只应有一份）。
     *
     * @returns {object} 状态快照。
     */
    async status() {
      const snapshot = structuredClone(runtime.status);
      // 兼容：万一 status.speakers 还没被填过（例如启动早期），也保证是数组。
      if (!Array.isArray(snapshot.speakers)) snapshot.speakers = [];
      snapshot.speakerSummary = summarizeSpeakers(snapshot.speakers);
      return snapshot;
    }

    /**
     * `xiaoai.settings.get` → `{ values, revision }`（密码打码）。
     *
     * @returns {Promise<{values: object, revision: number}>}
     */
    async settingsGet() {
      return getSettingsView();
    }

    /**
     * `xiaoai.settings.update({ patch, revision })` → `{ values, revision }`。
     *
     * revision 冲突由 settings 服务抛 `SettingsConflictError`（code
     * `SETTINGS_CONFLICT`），这里翻译成 `xiaoai/settings-conflict`。
     * 改到凭据/开关时会重启 runtime，避免要求用户重启 DSH（任务要求 §8）。
     *
     * @param {object} args `{ patch, revision }`。
     * @returns {Promise<{values: object, revision: number}>}
     */
    async settingsUpdate(args) {
      const endpoint = "xiaoai.settings.update";
      try {
        const { patch, revision } = asArgs(args, endpoint);
        const clean = sanitizePatch(asRecord(patch) ?? {});
        if (typeof revision !== "number") {
          throw new RemoteArgError("settings.update: revision 必须是数字");
        }
        const view = await updateSettings(clean, revision);

        // 生效：重新读配置，必要时重跑 start()，无需重启 DSH。
        runtime.applyConfig();
        if (needsRestart(clean)) {
          runtime.log("设置已改（账号/设备/开关），正在按新配置重启轮询…");
          try {
            await runtime.start();
          } catch (err) {
            // 启动失败不能回滚设置，但必须让 UI 看得到。
            const msg = `按新配置重启失败: ${err?.message ?? err}`;
            runtime.log(msg);
            Object.assign(runtime.status, { phase: "error", lastError: msg });
          }
        }
        return view;
      } catch (err) {
        throw fail(err, endpoint);
      }
    }

    /**
     * `xiaoai.restart` → `{ ok: true }`。启动失败也返回 ok:true 之外的信息？
     * 不 —— 契约规定返回 `{ ok: true }`；失败以 RemoteError 抛出，
     * 真实原因同时写进 `status.lastError` 供 UI 展示。
     *
     * @returns {Promise<{ok: true}>}
     */
    async restart() {
      const endpoint = "xiaoai.restart";
      try {
        runtime.log("收到重启请求");
        await runtime.start();
        return { ok: true };
      } catch (err) {
        throw fail(err, endpoint);
      }
    }

    /**
     * `xiaoai.test({ text, did? })` → `{ ok, reply }`；走完整链路但不播报。
     *
     * 多音箱：可传 `did` 指定用哪台设备的会话自检；省略则用代表设备
     * （与改造前的单设备行为一致）。
     *
     * @param {object} args `{ text, did? }`。
     * @returns {Promise<{ok: boolean, reply: string}>}
     */
    async test(args) {
      const endpoint = "xiaoai.test";
      try {
        const { text, did } = asArgs(args, endpoint);
        requireString(text, "text");
        if (text.trim() === "") throw new RemoteArgError("test: text 不能为空");
        return await runtime.test(text, did ? String(did) : null);
      } catch (err) {
        throw fail(err, endpoint);
      }
    }

    /**
     * `xiaoai.settings.recommended()` → `{ patch }` 推荐配置。
     *
     * 为什么值得做：用户配好账号后面对一堆空字段（唤醒词/直接问/退出词/
     * 忽略规则），不知道该填什么 —— 于是干脆留空，然后发现「音箱把所有话
     * 都转走了」或者「说了没反应」。给一套经过实践的推荐值，一键填好，
     * 比写十页文档有用。
     *
     * 只返回建议值，不直接写 —— 由客户端走 settings.update 应用，
     * 这样用户能看到将要改动什么（revision 校验也照常生效）。
     *
     * @returns {Promise<{patch: object, notes: string[]}>}
     */
    async recommendedPreset() {
      return {
        patch: {
          aiModeEnabled: true,
          wakeUpKeywords: ["进入AI模式", "召唤助手", "打开助手"],
          callAIKeywords: ["请", "帮我", "请问", "小爱助手"],
          exitKeywords: ["退出", "再见", "不用了", "关闭助手"],
          // 与小爱自身能力冲突的句子不要转走：点歌/调音量它自己做得更好，
          // 我们的本地快速路径也接管了音量。
          ignorePatterns: [
            "^小爱同学$",
            "^打开.*歌",
            "^放.*歌",
            "^来首.*",
            "^换一首",
          ],
          exitKeepAliveAfter: 30,
          onEnterAI: ["AI模式已开启"],
          onExitAI: ["已退出AI模式"],
          onAIAsking: ["让我想想"],
          onAIProgress: ["还在处理，请稍等一下"],
          onAIError: ["抱歉，出错了"],
          onAIErrorNetwork: ["网络好像不太好，等一下再试试"],
          onAIErrorAuth: ["小米账号可能需要重新登录，请在设置面板检查"],
          onAIErrorTimeout: ["这个问题有点复杂，我还没想完，请再问一次"],
          localCommandsEnabled: true,
          maxReplyChars: 400,
          pollIntervalMs: 4000,
        },
        notes: [
          "唤醒词用于进入连续对话模式；直接问关键词则说了就答、不打断模式。",
          "忽略规则挡住了点歌这类小爱自己更擅长的指令。",
          "Agent 预设与模型保持跟随 Host，未包含在推荐值里。",
        ],
      };
    }

    /**
     * `xiaoai.speak({ text, did? })` → `{ ok, did, name }`；直接让音箱念一段。
     *
     * 多音箱：可传 `did` 精确指定由哪台音箱播报（设计 §4.4 B2 的核心能力 ——
     * 即便路由退化为「代表设备独占」，指定设备播报仍然完全可用）。
     * 省略 `did` 时播报到代表设备，与改造前的单设备行为一致。
     *
     * @param {object} args `{ text, did? }`。
     * @returns {Promise<{ok: true, did: string, name: string}>}
     */
    async speak(args) {
      const endpoint = "xiaoai.speak";
      try {
        const { text, did } = asArgs(args, endpoint);
        requireString(text, "text");
        if (text.trim() === "") throw new RemoteArgError("speak: text 不能为空");
        return await runtime.speak(text, did ? String(did) : null);
      } catch (err) {
        throw fail(err, endpoint);
      }
    }

    /**
     * `xiaoai.speakers()` → `{ speakers, summary }`；列出账号下已配置的设备状态。
     *
     * 为什么单独开一个方法而不是让 UI 从 status 里挖：设置面板需要的是
     * **设备列表本身**（含停用项、生效配置），而 status 是运行态快照。
     * 两者语义不同，混在一起会让 UI 在「未启动」时拿不到设备列表 ——
     * 而那恰恰是用户最需要看到列表去编辑配置的时刻。
     *
     * @returns {Promise<{speakers: Array<object>, summary: object}>}
     */
    async listSpeakers() {
      try {
        const speakers = runtime.listSpeakers();
        return { speakers, summary: summarizeSpeakers(speakers) };
      } catch (err) {
        throw fail(err, "xiaoai.speakers");
      }
    }

    /**
     * `xiaoai.onboarding.importScan` —— 扫描本机已有的小米凭据。
     *
     * 为什么这是"零输入"路径的首选：
     *   小米有异地登录风控（实测通过本机复现：用密码登录账号后
     *   `serviceLoginAuth2` 回 `notificationUrl` 而非 `location`，
     *   需要用户去浏览器授权并等约 1 小时）。而本机往往已经有一份
     *   **仍然新鲜**的凭据（MiGPT 的 `.mi.json`、HA xiaomi_miot 的 auth 缓存），
     *   直接复用可以完全绕开风控。HA 生态的 xiaomi_miot 也是这个思路
     *   （把认证结果缓存成 auth-{uid}-cn-*.json 反复复用）。
     *
     * ⚠️ 返回给客户端前必须**剥掉 token/ssecurity**：它们是等价登录态的
     * 机密，客户端只需要知道"有哪些候选、能不能直接用"。
     *
     * @returns {Promise<{candidates: Array<object>}>}
     */
    async importScan() {
      const endpoint = "xiaoai.importScan";
      try {
        const all = discoverImportableCredentials(resolveMiStorePath());
        // 打码：只保留展示与决策所需的字段
        const candidates = all.map((c) => ({
          id: c.id,
          source: c.source,
          detail: c.detail,
          userId: c.userId,
          did: c.did,
          deviceName: c.deviceName,
          model: c.model,
          modelName: commandForModel(c.model).name,
          hasToken: Boolean(c.hasToken),
          hasPassword: Boolean(c.hasPassword),
          needsLogin: Boolean(c.needsLogin),
          canSelectSpeaker: Boolean(c.canSelectSpeaker),
          alsoFoundAt: c.alsoFoundAt ?? [],
        }));
        return { candidates };
      } catch (err) {
        throw fail(err, endpoint);
      }
    }

    /**
     * `xiaoai.onboarding.importFromHa({ host, user, password })`
     * —— 从远程 Home Assistant 导入小米凭据。
     *
     * 为什么需要：小米云有 micoapi（拉对话）与 xiaomiio（控制音箱）两个服务，
     * 各需独立凭据（见 docs/CREDENTIALS.md）。手动凑两份很麻烦且字段有坑。
     * HA 的 xiaomi_miot 集成两份都有，直接拉最省事 —— 这是实测验证过的路径。
     *
     * 只读 HA 的凭据文件，不做修改；失败时不动本地 store。
     *
     * @param {{host?: string, user?: string, password?: string, uid?: string,
     *          did?: string, hardware?: string}} args
     * @returns {Promise<{ok: boolean, summary?: object, error?: string}>}
     */
    async importFromHa(args) {
      const endpoint = "xiaoai.onboarding.importFromHa";
      try {
        const { host, user, password, uid, did, hardware } = asArgs(args, endpoint);
        requireString(host, "host");
        requireString(password, "password");
        const { importCredentialsFromHa } = await import("./onboarding.js");
        const result = await importCredentialsFromHa({
          host: String(host).trim(),
          user: String(user || "root").trim(),
          password: String(password),
          uid: uid ? String(uid).trim() : undefined,
          did: did ? String(did).trim() : undefined,
          hardware: hardware ? String(hardware).trim() : undefined,
          storePath: resolveMiStorePath(),
        });
        return result;
      } catch (err) {
        throw fail(err, endpoint);
      }
    }

    /**
     * `xiaoai.onboarding.login({ account, password })` —— 账号登录。
     *
     * `account` 接受**手机号 / 邮箱 / 小米 ID** 三种形态，服务端自己识别
     * （vendor/mi-service-lite.js:767 的 `user` 字段就是这么用的）。
     * 这条对首次接入很关键：用户不用去 account.xiaomi.com 翻自己的数字 ID。
     *
     * 风控场景**不当作错误抛出**，而是返回 `{ok:false, needsAuth:true, authUrl}`：
     * 这是用户在浏览器里授权就能解开的正常分支，用 RemoteError 表达会
     * 让 UI 只能显示一行红字，拿不到那个必须点击的链接。
     *
     * @param {object} args `{ account, password }`
     * @returns {Promise<object>} `{ok:true, userId, speakers}` 或 `{ok:false, needsAuth, authUrl}` 或 `{ok:false, error}`
     */
    async login(args) {
      const endpoint = "xiaoai.login";
      try {
        const { account, password } = asArgs(args, endpoint);
        requireString(account, "account");
        requireString(password, "password");
        runtime.log("收到账号登录请求，正在联系小米服务器…");

        const result = await loginWithAccount({ account, password });
        if (!result.ok) {
          runtime.log(`登录未成功: ${result.error ?? result.message ?? result.code}`);
          return {
            ok: false,
            code: result.code ?? "xiaoai/auth-failed",
            error: result.error ?? result.message ?? "登录失败",
            needsAuth: Boolean(result.needsAuth),
            authUrl: result.authUrl ?? null,
            waitMinutes: result.waitMinutes ?? null,
          };
        }

        // 登录成功 → 顺手把凭据写盘并列出设备，让 UI 直接进"选择音箱"。
        // 这里必须写盘（而不是只在内存里传）：后续 RPC 调用是**无状态**的，
        // 下一轮 discoverSpeakers 要靠这份凭据。写入用原子 + 0600。
        applyCredentials(resolveMiStorePath(), result.credentials);
        runtime.log(`登录成功: userId=${result.userId}，凭据已保存`);

        const probe = await probeSpeakers({
          account: { userId: result.userId, password },
        });
        return {
          ok: true,
          userId: String(result.userId ?? ""),
          speakers: probe.ok ? probe.speakers : [],
          speakersError: probe.ok ? null : probe.error,
          needsAuth: probe.ok ? false : Boolean(probe.needsAuth),
          authUrl: probe.authUrl ?? null,
        };
      } catch (err) {
        throw fail(err, endpoint);
      }
    }

    /**
     * `xiaoai.onboarding.discoverSpeakers({ candidateId? })` —— 列出账号下的音箱。
     *
     * 设计取舍（"能不能不登录就列"）：
     *   - **有 token 时**：直接用缓存 token 走 vendor 的免登录快路径
     *     （`getAccount()` 开头就 `if (account.serviceToken && pass.ssecurity) return`），
     *     不发密码、不触发风控。这是首选路径，也是本机当前的实际情况。
     *   - **只有账密时**：必须先真登录一次才能拿到设备列表（设备列表接口
     *     需要 serviceToken）—— 这也是 xiaogpt 的做法（`_init_data_hardware`
     *     先 `mina_service.device_list()`）。
     *   - **两种都不具备**：明确报错并告诉用户去用「账号登录」或「自动导入」，
     *     而不是返回空列表（空列表会被 UI 渲染成"你没有音箱"）。
     *
     * ⚠️ 全程走 `probeSpeakers()` 的隔离临时 store —— 绝不污染正式凭据文件。
     *
     * @param {object} args `{ candidateId?, account?, password? }`
     * @returns {Promise<{ok: boolean, speakers: Array<object>, source?: string, error?: string}>}
     */
    async discoverSpeakers(args) {
      const endpoint = "xiaoai.discoverSpeakers";
      try {
        const { candidateId, account, password } = asArgs(args, endpoint);
        const view = getSettingsView().values;

        // ── 1. 显式传了账密（用户刚在"账号登录"里填的）──
        if (typeof account === "string" && account.trim() && typeof password === "string" && password) {
          const probe = await probeSpeakers({ account: { userId: account, password } });
          return { ...probe, source: "account" };
        }

        // ── 2. 指定了某个导入候选 ──
        if (typeof candidateId === "string" && candidateId) {
          const all = discoverImportableCredentials(resolveMiStorePath());
          const cand = all.find((c) => c.id === candidateId);
          if (!cand) {
            throw new RemoteArgError(`未知的凭据候选: ${candidateId}（可能已被删除，请重新扫描）`);
          }
          // token 候选优先走免登录
          if (cand.store?.mina) {
            const probe = await probeSpeakers({ store: cand.store.mina });
            return { ...probe, source: cand.source };
          }
          if (cand.account?.userId && cand.account?.password) {
            const probe = await probeSpeakers({ account: cand.account });
            return { ...probe, source: cand.source };
          }
          return {
            ok: false,
            code: "xiaoai/cannot-discover",
            error: `${cand.source} 的凭据里只有 token 没有密码，无法重新枚举设备。` +
              `请直接使用该凭据（它已绑定设备），或改用「账号登录」。`,
            speakers: [],
          };
        }

        // ── 3. 没指定 → 用当前配置的账号 ──
        //
        // ⚠️ ssecurity 在 store.pass.ssecurity，**不在顶层**！
        // 写成 store?.ssecurity 会永远取到 undefined → hasToken=false
        // → 退化成账号密码登录 → 触发小米异地登录风控 → 返回 0 个设备
        // （实测踩过：明明凭据可用、probeSpeakers 直调能列出音箱，
        //   RPC 却报「检测到异地登录」。）
        // 对照 onboarding.js:194 的正确写法：node.pass?.ssecurity。
        const store = readCurrentStoreNode();
        const hasToken = Boolean(store?.serviceToken && store?.pass?.ssecurity);
        const userId = String(view.userId ?? "") || String(store?.userId ?? "");
        const pwd = String(store?.password ?? "") || String(view.password ?? "");
        if (!hasToken && (!userId || !pwd)) {
          return {
            ok: false,
            code: "xiaoai/not-configured",
            error: "还没有可用的小米凭据。请先用「自动导入」或「账号登录」完成第一步。",
            speakers: [],
          };
        }
        const probe = await probeSpeakers(
          hasToken ? { store } : { account: { userId, password: pwd } },
        );
        return { ...probe, source: hasToken ? "cached-token" : "account" };
      } catch (err) {
        throw fail(err, endpoint);
      }
    }

    /**
     * `xiaoai.onboarding.apply({ candidateId?, account?, password?, did, model? })` —— 落地配置。
     *
     * 一次调用完成"凭据 + 设备 + 型号指令"三件事，因为这三者在向导里
     * 是同一时刻确定的，拆成三次 RPC 会引入"只写了一半"的中间态。
     *
     * 型号处理（对应任务 C 项）：
     *   - 传入 `model`（如 `OH2P`）→ 用兼容表解析出 tts/wakeUp 指令
     *   - 未传 → 从选中的设备反查（需要刚跑过 discoverSpeakers，
     *     这里用 did 去现网设备列表里找）
     *   - 型号未收录 → **不阻断**，写默认指令并把 `modelKnown:false`
     *     回给 UI，让 UI 明确提示"可能有兼容问题"（而不是假装成功）
     *
     * @param {object} args `{ candidateId?, account?, password?, did, model? }`
     * @returns {Promise<{ok: true, userId: string, did: string, model: string, commands: object, modelKnown: boolean}>}
     */
    async onboardingApply(args) {
      const endpoint = "xiaoai.onboardingApply";
      try {
        const { candidateId, account, password, did, model } = asArgs(args, endpoint);

        // ── 决定用哪份凭据 ──
        const storePath = resolveMiStorePath();
        let creds = null;

        if (typeof candidateId === "string" && candidateId) {
          const all = discoverImportableCredentials(storePath);
          const cand = all.find((c) => c.id === candidateId);
          if (!cand) throw new RemoteArgError(`未知的凭据候选: ${candidateId}`);
          if (cand.ha) {
            // HA 缓存 → 转换成 vendor 的 store 形状
            const toNode = (n, sid) =>
              n
                ? {
                    userId: String(n.user_id ?? cand.userId),
                    sid,
                    deviceId: n.device_id ?? undefined,
                    serviceToken: n.service_token,
                    ssecurity: n.ssecurity,
                    password: "",
                    did: did ?? "",
                  }
                : null;
            creds = {
              mina: toNode(cand.ha.micoapi, "micoapi"),
              miiot: toNode(cand.ha.xiaomiio, "xiaomiio"),
            };
          } else if (cand.store) {
            creds = cand.store;
          } else if (cand.account?.userId && cand.account?.password) {
            // 只有账密 → 真登录一次换 token
            const res = await loginWithAccount(cand.account);
            if (!res.ok) {
              return {
                ok: false,
                code: res.code ?? "xiaoai/auth-failed",
                error: res.error ?? res.message,
                needsAuth: Boolean(res.needsAuth),
                authUrl: res.authUrl ?? null,
              };
            }
            creds = res.credentials;
          }
        } else if (typeof account === "string" && account.trim() && typeof password === "string" && password) {
          const res = await loginWithAccount({ account, password });
          if (!res.ok) {
            return {
              ok: false,
              code: res.code ?? "xiaoai/auth-failed",
              error: res.error ?? res.message,
              needsAuth: Boolean(res.needsAuth),
              authUrl: res.authUrl ?? null,
            };
          }
          creds = res.credentials;
        }

        // ── 决定 did 与型号 ──
        let finalDid = String(did ?? "").trim();
        let finalModel = String(model ?? "").trim();
        // 顺带把设备展示名捞出来 —— 多音箱 UI 要显示「客厅音箱」而不是 did。
        let matchedName = "";

        if (creds) {
          // 有凭据：可以现网查一次，补齐缺失的 did/model
          const probe = await probeSpeakers({
            store: creds.mina ?? undefined,
            account: creds.mina ? undefined : undefined,
          });
          if (probe.ok && probe.speakers.length > 0) {
            const match =
              probe.speakers.find((s) => s.did === finalDid) ??
              probe.speakers.find((s) => s.deviceID === finalDid) ??
              (finalDid ? null : probe.speakers[0]);
            if (!finalDid && match) finalDid = match.did;
            if (!finalModel && match) finalModel = match.model;
            if (match?.name) matchedName = String(match.name);
          }
        }

        if (!creds) {
          throw new RemoteArgError("没有可用的凭据：请提供 candidateId 或 account+password");
        }
        if (!finalDid) {
          throw new RemoteArgError("没有选定音箱（did 为空）");
        }

        const written = applyCredentials(storePath, creds, { did: finalDid });
        const commands = commandForModel(finalModel);
        runtime.log(
          `接入向导完成: userId=${written.userId} did=${finalDid} model=${finalModel || "(未知)"} ` +
            `tts=${JSON.stringify(commands.tts)} known=${commands.known}`,
        );

        // ── 写设置（设计 §7.3 的双写）──
        //
        // 同时写两个地方：
        //   `speakers[]` —— 新的权威设备列表（upsert，幂等）
        //   `did` / `deviceModel` —— 兼容投影（老 UI、外部脚本、降级分支在读）
        //
        // ⚠️ upsert 而不是直接赋值：用户可能已经在面板里配过这台设备
        //    （甚至给它设了独立工作区），向导重新跑一遍不应该把那些清掉。
        //    重复调用也不会产生重复条目。
        //
        // 密码不写：token 已经在 store 里了，写明文密码进设置文件
        // 只会多一份泄漏面，且 sanitizePatch 对空串的语义是"未修改"。
        const current = normalizeSettings(getSettingsView().values);
        const speakers = upsertSpeaker(current.speakers, {
          did: finalDid,
          model: finalModel,
        });
        // 从 discoverSpeakers 的结果里补名字（finalModel 已有，名字还没有）
        const named = speakers.map((sp) =>
          sp.did === finalDid && !sp.name && matchedName ? { ...sp, name: matchedName } : sp,
        );
        const patch = {
          userId: written.userId,
          speakers: named,
          // 兼容投影：恒等于第一台
          did: projectDid(named) || finalDid,
          deviceModel: projectDeviceModel(named) || finalModel,
        };
        const view = await updateSettings(patch, getSettingsView().revision);

        // 生效
        runtime.applyConfig();
        try {
          await runtime.start();
        } catch (err) {
          const msg = `按新配置启动失败: ${err?.message ?? err}`;
          runtime.log(msg);
          Object.assign(runtime.status, { phase: "error", lastError: msg });
        }

        return {
          ok: true,
          userId: written.userId,
          did: finalDid,
          model: commands.model || finalModel,
          modelName: commands.name,
          commands: { tts: commands.tts, wakeUp: commands.wakeUp },
          modelKnown: commands.known,
          support: commands.support,
          values: view.values,
          revision: view.revision,
        };
      } catch (err) {
        throw fail(err, endpoint);
      }
    }

    /**
     * `xiaoai.hostOptions()` → `{ workspaces, presets, models, defaultModel }`。
     *
     * 给设置面板的下拉用：workspace / agentPreset / provider+model 让用户手填
     * 是不现实的（路径、预设 id、模型名任一处写错，表现都是"会话建不起来"，
     * 且错误信息对用户毫无指向性）。这里把宿主的可选项列出来。
     *
     * 无参方法 —— 客户端必须把它放进 NO_ARG_METHODS，
     * 否则网关会回 `unexpected "args"`（payload.args 必须是 {}）。
     *
     * @returns {Promise<{workspaces: Array<object>, presets: Array<object>,
     *                    models: Array<object>, defaultModel: object|null}>}
     */
    async hostOptions() {
      const endpoint = "xiaoai.hostOptions";
      try {
        // runtime 是本模块的模块级变量（见 status 方法：runtime.status）。
        // 运行时未就绪时返回空集，让 UI 退化为手填输入框，而不是整页报错。
        if (!runtime || typeof runtime.listHostOptions !== "function") {
          return { workspaces: [], presets: [], models: [], defaultModel: null };
        }
        return await runtime.listHostOptions();
      } catch (err) {
        throw fail(err, endpoint);
      }
    }

    /**
     * `xiaoai.onboarding.models()` —— 型号兼容表。
     *
     * 给 UI 两个用途：手动配置时的型号下拉、以及"这个型号行不行"的说明。
     * 表本身是静态的，但放在 RPC 里可以保证**单一数据源** ——
     * 前端不再复制一份型号表，改了服务端就生效。
     *
     * @returns {Promise<{models: Array<object>}>}
     */
    async onboardingModels() {
      const models = Object.entries(SPEAKER_MODELS).map(([code, spec]) => ({
        code,
        name: spec.name,
        tts: spec.tts,
        wakeUp: spec.wakeUp,
        support: spec.support,
      }));
      return { models };
    }

    /**
     * `xiaoai.logs({ limit })` → `{ lines }`。
     *
     * @param {object} args `{ limit }`。
     * @returns {Promise<{lines: string[]}>}
     */
    async logs(args) {
      const endpoint = "xiaoai.logs";
      try {
        const { limit } = asArgs(args, endpoint);
        if (limit !== undefined && typeof limit !== "number") {
          throw new RemoteArgError("logs: limit 必须是数字");
        }
        const n = Number.isFinite(limit) ? Math.trunc(limit) : 100;
        return { lines: runtime.getLogs(n) };
      } catch (err) {
        throw fail(err, endpoint);
      }
    }
  }

  // 施加 Remote 标记。导出名 = 方法名，端点即 `xiaoai/<方法名>`。
  // 手工施加而非装饰器语法：见文件头说明（无构建步骤约束）。
  applyRemote(Remote, XiaoaiController, "status");
  applyRemote(Remote, XiaoaiController, "settingsGet", "settings.get");
  applyRemote(Remote, XiaoaiController, "settingsUpdate", "settings.update");
  applyRemote(Remote, XiaoaiController, "restart");
  applyRemote(Remote, XiaoaiController, "test");
  applyRemote(Remote, XiaoaiController, "speak");
  applyRemote(Remote, XiaoaiController, "listSpeakers", "speakers");
  applyRemote(Remote, XiaoaiController, "logs");
  applyRemote(Remote, XiaoaiController, "hostOptions", "hostOptions");
  // ── 首次接入向导（onboarding）──
  applyRemote(Remote, XiaoaiController, "importScan", "onboarding.importScan");
  applyRemote(Remote, XiaoaiController, "login", "onboarding.login");
  applyRemote(Remote, XiaoaiController, "discoverSpeakers", "onboarding.discoverSpeakers");
  applyRemote(Remote, XiaoaiController, "onboardingApply", "onboarding.apply");
  applyRemote(Remote, XiaoaiController, "onboardingModels", "onboarding.models");
  applyRemote(Remote, XiaoaiController, "recommendedPreset", "settings.recommended");
  applyRemote(Remote, XiaoaiController, "importFromHa", "onboarding.importFromHa");

  return XiaoaiController;
}

/**
 * 读取当前正式凭据文件里的 MiNA 节点（含 token）。
 *
 * 只在服务端内部使用（RPC 返回值里绝不能出现它）—— 见 importScan 的打码说明。
 *
 * @returns {object|null}
 */
function readCurrentStoreNode() {
  try {
    const store = JSON.parse(readFileSyncSafe(resolveMiStorePath()) ?? "null");
    return store?.mina ?? store?.miiot ?? null;
  } catch {
    return null;
  }
}

/** 读文件；失败返回 null（凭据文件不存在是正常状态）。 */
function readFileSyncSafe(file) {
  try {
    // 延迟 require 风格，避免顶层再引一次 fs（本文件其余部分不碰文件系统）
    return readFileSyncImpl(file, "utf8");
  } catch {
    return null;
  }
}

/** 契约 §4 的方法清单（导出名 → 实现方法名），供自检与测试断言。 */
export const RPC_METHODS = Object.freeze({
  "xiaoai.status": "status",
  "xiaoai.settings.get": "settingsGet",
  "xiaoai.settings.update": "settingsUpdate",
  "xiaoai.restart": "restart",
  "xiaoai.test": "test",
  "xiaoai.speak": "speak",
  "xiaoai.speakers": "listSpeakers",
  "xiaoai.logs": "logs",
  "xiaoai.hostOptions": "hostOptions",
  // ── 首次接入向导（见文件头 onboarding 说明）──
  "xiaoai.onboarding.importScan": "importScan",
  "xiaoai.onboarding.login": "login",
  "xiaoai.onboarding.discoverSpeakers": "discoverSpeakers",
  "xiaoai.onboarding.apply": "onboardingApply",
  "xiaoai.onboarding.models": "onboardingModels",
});
