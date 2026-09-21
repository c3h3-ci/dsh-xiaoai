/**
 * 首次使用（onboarding）支撑层 —— 让"添加小米音箱"从 3 个字段变成 3 步。
 *
 * 设计参考（都是本机/线上真实实现，不是凭空设计）：
 *
 *  1. **xiaogpt**（yihong0618/xiaogpt）
 *     `xiaogpt/xiaogpt.py:108 _init_data_hardware()` 的核心洞察：
 *     用户**永远不该手填 DID**。先 `mina_service.device_list()` 拿到账号下
 *     所有音箱（那里有 `miotDID` 和 `hardware`），再按用户给的"型号"
 *     反查设备。我们更进一步：直接把设备列表摊给用户点选。
 *     `xiaogpt/config.py:18 HARDWARE_COMMAND_DICT` 提供了 17 个型号的
 *     指令集对照表 —— 本文件把它和 MiGPT 的兼容表合并成一张完整的表。
 *
 *  2. **MiGPT**（idootop/mi-gpt）
 *     `docs/compatibility.md` 是更权威的兼容表（含 ttsCommand/wakeUpCommand
 *     /streamResponse 三列），且区分"完美运行 / 正常运行 / 不支持"三档 ——
 *     这个分档直接变成 UI 的提示文案（见 commandForModel 的 support 字段）。
 *     另外它的 `.mi.json` 凭据文件结构（{mina:{...}, miiot:{...}}）就是本插件
 *     vendor 的 mi-service-lite 使用的格式，所以"从 MiGPT 导入"是零转换的。
 *
 *  3. **HA xiaomi_miot 集成**
 *     它的 config_flow 是"先登录 → 拿到设备列表 → 让用户从下拉里选设备"，
 *     并把认证缓存在 `{store}/xiaomi_miot/auth-{uid}-cn-micoapi.json` /
 *     `auth-{uid}-cn.json`。本文件的 `discoverImportableCredentials()` 直接
 *     扫这两个位置 + MiGPT 的 `.mi.json`，让用户"选一个"而不是"重新登录"
 *     —— 因为小米有异地登录风控，能不登录就不登录。
 *
 *  4. **小米风控**（vendor/mi-service-lite.js:783-795）
 *     `serviceLoginAuth2` 响应里出现 `notificationUrl` / `captchaUrl` 时，
 *     说明触发了异地登录安全验证 —— 必须把链接交给用户去浏览器授权，
 *     且授权后约 1 小时才生效。本模块把它结构化返回（needsAuth/authUrl），
 *     而不是像 vendor 那样只 `console.log` 完事。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";

import "./bootstrap.js";
import { readMiStore, writeMiStore } from "./xiaomi.js";
import { findHaStorage, writeStoreAtomic } from "./token-refresh.js";

// ═══════════════════════ 1. 型号 → 指令集（兼容表） ═══════════════════════

/**
 * 小爱音箱型号 → MIoT 指令 + 支持等级。
 *
 * 两个来源合并：
 *  - MiGPT `docs/compatibility.md`（ttsCommand / wakeUpCommand / streamResponse）
 *  - xiaogpt `config.py:18 HARDWARE_COMMAND_DICT`（补充 xiaogpt 有、MiGPT 无的型号）
 *
 * ⚠️ 两家的 wakeUpCommand 不完全一致（例如 LX06：MiGPT 用 [5,3]，xiaogpt 用 [5,5]）。
 * 这里以 **MiGPT 为准**，因为它与本插件的 vendor 同源（都走 mi-service-lite
 * 的 `MiIOT.doAction(siid, aiid, text)`），参数形态一致（[scope, action] 二元组）；
 * xiaogpt 用的是它自己 MiIOService 的 `siid-aiid` 字符串形式，不能直接照搬。
 *
 * support 字段直接对应 UI 文案：
 *  - "perfect"  完美运行（支持连续对话）
 *  - "ok"       正常运行（不支持连续对话，我们本来也不用）
 *  - "unknown"  未收录 —— 用默认指令，UI 提示"型号未收录，可能有兼容问题"
 *  - "unsupported" 已知不支持 —— UI 明确劝阻
 */
export const SPEAKER_MODELS = Object.freeze({
  // ── 完美运行（MiGPT docs/compatibility.md「✅ 完美运行」）──
  OH2P: { name: "Xiaomi 智能音箱 Pro", tts: [7, 3], wakeUp: [7, 1], support: "perfect" },
  OH2: { name: "Xiaomi 智能音箱", tts: [5, 3], wakeUp: [5, 1], playing: [3, 1, 1], support: "perfect" },
  LX06: { name: "小爱音箱 Pro", tts: [5, 1], wakeUp: [5, 3], support: "perfect" },
  S12: { name: "小米 AI 音箱", tts: [5, 1], wakeUp: [5, 3], support: "perfect" },
  L15A: { name: "小米 AI 音箱（第二代）", tts: [7, 3], wakeUp: [7, 1], playing: [3, 1, 1], support: "perfect" },
  LX5A: { name: "小爱音箱 万能遥控版", tts: [5, 1], wakeUp: [5, 3], support: "perfect" },
  LX05: { name: "小爱音箱 Play（2019 款）", tts: [5, 1], wakeUp: [5, 3], playing: [3, 1, 1], support: "perfect" },
  X10A: { name: "小爱智能家庭屏 10", tts: [7, 3], wakeUp: [7, 1], support: "perfect" },
  L17A: { name: "Xiaomi Sound Pro", tts: [7, 3], wakeUp: [7, 1], support: "perfect" },

  // ── 正常运行（不支持连续对话；本插件不用连续对话，故等价可用）──
  L06A: { name: "小爱音箱", tts: [5, 1], wakeUp: [5, 2], support: "ok" },
  LX01: { name: "小爱音箱 mini", tts: [5, 1], wakeUp: [5, 2], support: "ok" },
  L05B: { name: "小爱音箱 Play", tts: [5, 3], wakeUp: [5, 1], support: "ok" },
  L05C: { name: "小米小爱音箱 Play 增强版", tts: [5, 3], wakeUp: [5, 1], support: "ok" },
  L09A: { name: "小爱音箱 Art", tts: [3, 1], wakeUp: [3, 2], support: "ok" },
  LX04: { name: "小爱触屏音箱", tts: [5, 1], wakeUp: [5, 2], support: "ok" },
  ASX4B: { name: "Xiaomi 智能家庭屏 Mini", tts: [5, 3], wakeUp: [5, 1], support: "ok" },
  X6A: { name: "Xiaomi 智能家庭屏 6", tts: [7, 3], wakeUp: [7, 1], support: "ok" },
  X08E: { name: "Redmi 小爱触屏音箱 Pro 8", tts: [7, 3], wakeUp: [7, 1], support: "ok" },
  X8F: { name: "Xiaomi 智能家庭屏 Pro 8", tts: [7, 3], wakeUp: [7, 1], support: "ok" },

  // ── xiaogpt 补充（MiGPT 未收录，但 xiaogpt 的 HARDWARE_COMMAND_DICT 有）──
  S12A: { name: "小米 AI 音箱（S12A）", tts: [5, 1], wakeUp: [5, 5], support: "ok" },
  L07A: { name: "Redmi 小爱音箱 Play", tts: [5, 1], wakeUp: [5, 5], support: "ok" },

  // ── 已知不支持（MiGPT docs/compatibility.md「❌ 不支持」）──
  SM4: { name: "小米小爱音箱 HD", tts: null, wakeUp: null, support: "unsupported" },
});

/** 未收录型号的兜底指令（MiGPT 对 LX06 类设备的默认值）。 */
export const DEFAULT_COMMANDS = Object.freeze({ tts: [5, 1], wakeUp: [5, 3] });

/**
 * 把设备上报的 hardware 串归一成型号 key。
 *
 * 真实世界的脏数据：
 *  - MiNA `/admin/v2/device_list` 回 "OH2P"（大写，无前缀）
 *  - MiIOT `device_list` 回 model = "xiaomi.wifispeaker.oh2p"（带命名空间，小写）
 *  - 用户还可能填别名/中文名
 * 两种形态都要能命中，否则"自动匹配型号"就是空话。
 *
 * @param {string} raw 原始型号串（hardware / model / 用户输入）
 * @returns {string} 大写的型号 key；无法归一返回空串
 */
export function normalizeModel(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  // 直接命中
  const upper = text.toUpperCase();
  if (SPEAKER_MODELS[upper]) return upper;
  // "xiaomi.wifispeaker.oh2p" → 取最后一段
  const tail = upper.split(".").pop();
  if (tail && SPEAKER_MODELS[tail]) return tail;
  // "urn:miot-spec-v2:device:speaker:0000A015:xiaomi-oh2p:1" → 取 xiaomi- 后缀
  const m = upper.match(/XIAOMI-([A-Z0-9]+)/);
  if (m && SPEAKER_MODELS[m[1]]) return m[1];
  // 中文名反查
  for (const [key, spec] of Object.entries(SPEAKER_MODELS)) {
    if (spec.name && text === spec.name) return key;
  }
  return tail || upper;
}

/**
 * 型号 → 指令集。
 *
 * @param {string} model 型号（任意形态）
 * @returns {{model: string, name: string, tts: number[], wakeUp: number[], support: string, known: boolean}}
 */
export function commandForModel(model) {
  const key = normalizeModel(model);
  const spec = SPEAKER_MODELS[key];
  if (!spec) {
    return {
      model: key,
      name: "",
      tts: [...DEFAULT_COMMANDS.tts],
      wakeUp: [...DEFAULT_COMMANDS.wakeUp],
      support: "unknown",
      known: false,
    };
  }
  return {
    model: key,
    name: spec.name,
    tts: spec.tts ? [...spec.tts] : null,
    wakeUp: spec.wakeUp ? [...spec.wakeUp] : null,
    support: spec.support,
    known: true,
  };
}

// ═══════════════════════ 2. 从本机已有配置导入凭据 ═══════════════════════

/** 本机候选：MiGPT / xiaogpt 的凭据与配置。 */
function migptCandidates() {
  const home = os.homedir();
  const roots = [
    "/media/duola/devdata/AI-workspace/mi-gpt",
    process.env.XIAOAI_MIGPT_DIR,
    path.join(home, "mi-gpt"),
    path.join(home, ".mi-gpt"),
    process.cwd(),
  ].filter(Boolean);
  const out = [];
  for (const root of roots) {
    for (const file of [".mi.json", "mi.json"]) {
      out.push({ kind: "migpt-store", file: path.join(root, file), root });
    }
    for (const file of [".migpt.js", ".migpt.mjs", ".migpt.cjs", ".env"]) {
      out.push({ kind: "migpt-config", file: path.join(root, file), root });
    }
  }
  return out;
}

/**
 * 从一个 `.mi.json` 读取凭据。
 *
 * 结构（vendor 的 mi-service-lite 写入）：`{mina:{...}, miiot:{...}}`。
 * 只认同时具备 serviceToken + ssecurity 的条目 —— 半截凭据导进来只会在
 * 连接时炸，不如当场判定"不可用"。
 */
function readStoreCredentials(file) {
  const store = readMiStore(file);
  if (!store || typeof store !== "object") return null;
  const pick = (node, sid) => {
    if (!node || typeof node !== "object") return null;
    if (!node.serviceToken || !node.pass?.ssecurity) return null;
    return {
      userId: node.userId === undefined ? null : String(node.userId),
      sid,
      deviceId: node.deviceId ?? null,
      serviceToken: node.serviceToken,
      ssecurity: node.pass.ssecurity,
      password: typeof node.password === "string" ? node.password : "",
      did: node.did === undefined ? null : String(node.did),
      deviceName: node.device?.name ?? node.device?.alias ?? null,
      model: node.device?.hardware ?? node.device?.model ?? null,
      deviceID: node.device?.deviceID ?? null,
    };
  };
  const mina = pick(store.mina, "micoapi");
  const miiot = pick(store.miiot, "xiaomiio");
  if (!mina && !miiot) return null;
  return { mina, miiot };
}

/**
 * 从 MiGPT 的 `.migpt.js` / `.env` 里抠出 userId/password/did。
 *
 * 不 import 用户文件（那是任意代码执行，且 MiGPT 配置里有 askAI 函数引用，
 * import 会拖进它整条依赖链）。用正则扫文本即可 —— 我们要的只是三个标量。
 *
 * 字段名沿用 MiGPT 的 `speaker.{userId,password,did}` 与 xiaogpt 的
 * `MI_USER` / `MI_PASS` / `MI_DID` 环境变量命名。
 */
function readConfigCredentials(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const grab = (patterns) => {
    for (const re of patterns) {
      const m = text.match(re);
      if (m && m[1]) return m[1].trim();
    }
    return null;
  };
  // 允许单/双引号、允许 xiaogpt 的 YAML 风格与 .env 风格
  const q = (key) =>
    new RegExp(`(?:^|[\\s{,])${key}\\s*[:=]\\s*["'\`]?([^"'\`\\n,}]+)`, "m");
  const userId = grab([q("userId"), q("MI_USER"), q("account"), q("username")]);
  const password = grab([q("password"), q("MI_PASS")]);
  const did = grab([q("did"), q("MI_DID"), q("deviceId")]);
  if (!userId && !password) return null;
  return { userId, password, did };
}

/**
 * 扫描本机可导入的凭据。
 *
 * 三路来源，优先级从高到低（越靠前越"省事且不触发风控"）：
 *  1. 本插件自己的 store（说明已经配好了）
 *  2. MiGPT 的 `.mi.json`（结构完全一致，可直接复用 token）
 *  3. HA xiaomi_miot 的 auth 缓存（同样可直接复用 token）
 *  4. MiGPT / xiaogpt 的配置文件（只有账号密码 → 需要真登录一次）
 *
 * ⚠️ 密码可用性必须诚实标注：从 MiGPT 的 `.mi.json` 导入的条目**可能没有
 * 密码**（MiGPT 自己也是拿 token 跑的）。而 vendor 的 `getMiService()` 强制
 * 要求 `userId + password` 同时存在（见 probeSpeakers 的说明），
 * 所以没有密码的条目**不能**直接用来列设备 —— 但**可以**直接写入配置：
 * runtime 的 `XiaomiSpeaker.connect()` 会走 `getMiNA({userId,password,did})`
 * 复用已缓存的 token。为了不让 UI 在该场景下误导用户点"选择音箱"，
 * 这里用 `canSelectSpeaker` + `hasPassword` 两个字段把能力讲清楚。
 *
 * @param {string} ownStorePath 本插件当前的凭据文件路径
 * @returns {Array<object>} 可直接展示给用户的候选列表
 */
export function discoverImportableCredentials(ownStorePath) {
  const found = [];
  /** 已出现过的小米账号：同一账号只保留"最能干活"的那一条，避免用户选花眼。 */
  const seenUsers = new Map();

  const push = (entry) => {
    const key = String(entry.userId ?? "");
    if (key) {
      const prev = seenUsers.get(key);
      // hasToken > needsLogin；有密码 > 无密码
      const score = (e) => Number(e.hasToken) * 2 + Number(e.hasPassword);
      if (prev && score(prev) >= score(entry)) {
        // 保留前者，但把路径信息并进 detail，方便用户知道还有别处也配过
        prev.alsoFoundAt = [...(prev.alsoFoundAt ?? []), entry.detail];
        return;
      }
      if (prev) {
        entry.alsoFoundAt = [...(prev.alsoFoundAt ?? []), prev.detail];
        found.splice(found.indexOf(prev), 1);
      }
      seenUsers.set(key, entry);
    }
    found.push(entry);
  };

  // ── 1. 本插件自己的凭据 ──
  const own = ownStorePath ? readStoreCredentials(ownStorePath) : null;
  if (own) {
    const node = own.mina ?? own.miiot;
    push({
      id: "own-store",
      source: "本插件",
      detail: ownStorePath,
      userId: node?.userId ?? "",
      did: node?.did ?? "",
      deviceName: node?.deviceName ?? "",
      model: node?.model ?? "",
      hasToken: true,
      hasPassword: Boolean(node?.password),
      needsLogin: false,
      // 有密码时可以直接重新列设备（例如用户想换一台音箱）；
      // 没密码也能用，只是"选择音箱"这一步要走磁盘上缓存的 device。
      canSelectSpeaker: Boolean(node?.password),
      // 带上原始节点，让 RPC 层能在"仅导入"场景下原样写回配置
      store: own,
      account: { userId: node?.userId ?? "", password: node?.password ?? "" },
      cachedDid: node?.did ?? "",
    });
  }

  // ── 2. MiGPT 的 .mi.json ──
  const seenStores = new Set();
  for (const cand of migptCandidates()) {
    if (cand.kind !== "migpt-store") continue;
    if (ownStorePath && path.resolve(cand.file) === path.resolve(ownStorePath)) continue;
    if (seenStores.has(cand.file)) continue;
    seenStores.add(cand.file);
    const creds = readStoreCredentials(cand.file);
    if (!creds) continue;
    const node = creds.mina ?? creds.miiot;
    push({
      id: `migpt:${cand.file}`,
      source: "MiGPT",
      detail: cand.file,
      userId: node?.userId ?? "",
      did: node?.did ?? "",
      deviceName: node?.deviceName ?? "",
      model: node?.model ?? "",
      hasToken: true,
      hasPassword: Boolean(node?.password),
      needsLogin: false,
      canSelectSpeaker: Boolean(node?.password),
      store: creds,
    });
  }

  // ── 3. HA xiaomi_miot 的认证缓存 ──
  const haStore = findHaStorage();
  if (haStore) {
    const dir = `${haStore}/xiaomi_miot`;
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      files = [];
    }
    // auth-<uid>-cn-micoapi.json / auth-<uid>-cn.json 成对出现，按 uid 归并
    const uids = new Set();
    for (const f of files) {
      const m = f.match(/^auth-(\d+)-cn(?:-micoapi)?\.json$/);
      if (m) uids.add(m[1]);
    }
    for (const uid of uids) {
      const read = (file) => {
        try {
          return JSON.parse(fs.readFileSync(`${dir}/${file}`, "utf8"))?.data ?? null;
        } catch {
          return null;
        }
      };
      const micoapi = read(`auth-${uid}-cn-micoapi.json`);
      const xiaomiio = read(`auth-${uid}-cn.json`);
      const ok = (n) => n?.service_token && n?.ssecurity;
      if (!ok(micoapi) && !ok(xiaomiio)) continue;
      push({
        id: `ha:${uid}`,
        source: "Home Assistant (xiaomi_miot)",
        detail: `${dir}/auth-${uid}-cn*.json`,
        userId: String(micoapi?.user_id ?? xiaomiio?.user_id ?? uid),
        did: "",
        deviceName: "",
        model: "",
        // HA 的缓存里没有密码 —— 但它的 token 是 HA 自己在持续保鲜的，
        // 因此"导入后直接可用"，只是不能用它去列设备（列设备需要密码）。
        hasToken: true,
        hasPassword: false,
        needsLogin: false,
        canSelectSpeaker: false,
        ha: { micoapi, xiaomiio },
      });
    }
  }

  // ── 4. MiGPT / xiaogpt 配置文件（只有账密，需登录）──
  const seenConfigs = new Set();
  for (const cand of migptCandidates()) {
    if (cand.kind !== "migpt-config") continue;
    if (seenConfigs.has(cand.file)) continue;
    seenConfigs.add(cand.file);
    const cfg = readConfigCredentials(cand.file);
    if (!cfg) continue;
    push({
      id: `config:${cand.file}`,
      source: path.basename(cand.file) === ".env" ? "环境变量文件" : "MiGPT 配置",
      detail: cand.file,
      userId: cfg.userId ?? "",
      did: cfg.did ?? "",
      deviceName: "",
      model: "",
      hasToken: false,
      hasPassword: Boolean(cfg.password),
      needsLogin: true,
      // 只有账密：登录后才能列设备 → 这一条可以走"选择音箱"流程
      canSelectSpeaker: Boolean(cfg.userId && cfg.password),
      account: { userId: cfg.userId, password: cfg.password },
    });
  }

  return found;
}

/**
 * 把一组"可直接使用"的凭据写进本插件的 store。
 *
 * ⚠️ 必须用 writeStoreAtomic（0600 + 原子替换）：里面是 serviceToken +
 * ssecurity，等价于登录态。裸 writeFileSync 默认 0644。
 *
 * @param {string} storePath 目标凭据文件
 * @param {object} creds discoverImportableCredentials 返回项里的 store/ha
 * @param {{did?: string}} [extra] 附加字段（选中的设备）
 * @returns {{ok: boolean, userId: string, did: string}}
 */
export function applyCredentials(storePath, creds, extra = {}) {
  const current = readMiStore(storePath) ?? {};
  const next = { ...current };

  if (creds.mina) {
    next.mina = {
      ...(current.mina ?? {}),
      deviceId: creds.mina.deviceId ?? current.mina?.deviceId,
      userId: creds.mina.userId,
      sid: "micoapi",
      serviceToken: creds.mina.serviceToken,
      pass: { ...(current.mina?.pass ?? {}), ssecurity: creds.mina.ssecurity },
      password: creds.mina.password || current.mina?.password || "",
      did: extra.did ?? creds.mina.did ?? current.mina?.did,
      device: undefined, // 清掉缓存的设备，强制重解析（换设备后必须）
    };
  }
  if (creds.miiot) {
    next.miiot = {
      ...(current.miiot ?? {}),
      deviceId: creds.miiot.deviceId ?? current.miiot?.deviceId,
      userId: creds.miiot.userId,
      sid: "xiaomiio",
      serviceToken: creds.miiot.serviceToken,
      pass: { ...(current.miiot?.pass ?? {}), ssecurity: creds.miiot.ssecurity },
      password: creds.miiot.password || current.miiot?.password || "",
      did: extra.did ?? creds.miiot.did ?? current.miiot?.did,
      device: undefined,
    };
  }

  writeStoreAtomic(storePath, next);
  return {
    ok: true,
    userId: String(next.mina?.userId ?? next.miiot?.userId ?? ""),
    did: String(next.mina?.did ?? next.miiot?.did ?? ""),
  };
}

// ═══════════════════════ 3. 设备列表（登录后） ═══════════════════════

/** 音箱型号的 hardware 前缀特征：小爱系列设备都是 "OH"/"LX"/"L0"/"L1"/"X"/"S1"/"AS"。 */
const SPEAKER_HINT = /^(OH|LX|L0|L1|L7|X0|X6|X8|X10|S12|ASX|SM4|L17|L15|L09)/;

/**
 * 判断 MiNA 设备列表里的一条是不是音箱。
 *
 * 为什么需要：`/admin/v2/device_list` 返回**账号下所有**小爱设备，
 * 不只是音箱（还有电视、盒子、手表…）。直接全列给用户，
 * "选择音箱"这一步就失去意义了。
 *
 * 判定依据（任一命中即算）：
 *  1. `capabilities` 里有音箱专属字段（`dialog_h5` / `night_mode` 等）
 *  2. `hardware` 命中已知音箱型号表
 *  3. `hardware` 命中前缀特征
 *
 * ⚠️ 宁可多列不可漏列：判错的代价是用户要从 3 个里挑，漏判的代价是
 * 用户根本看不到自己的音箱（更糟）。因此前缀特征故意放宽。
 */
export function isSpeakerDevice(device) {
  if (!device || typeof device !== "object") return false;
  const caps = device.capabilities;
  if (caps && typeof caps === "object") {
    // 这几个字段是 micoapi 设备列表里音箱独有的
    if (caps.dialog_h5 !== undefined || caps.night_mode !== undefined || caps.multiroom_music !== undefined) {
      return true;
    }
  }
  const hw = String(device.hardware ?? "").toUpperCase();
  if (!hw) return false;
  if (SPEAKER_MODELS[normalizeModel(hw)]) return true;
  return SPEAKER_HINT.test(hw);
}

/**
 * 把 MiNA 的设备列表压成 UI 需要的形状。
 *
 * @param {Array<object>} devices `/admin/v2/device_list` 的原始数组
 * @returns {Array<object>} 已排序（在线优先）的音箱列表
 */
export function toSpeakerList(devices) {
  const list = Array.isArray(devices) ? devices : [];
  return list
    .filter(isSpeakerDevice)
    .map((d) => {
      const commands = commandForModel(d.hardware ?? d.model);
      return {
        // did 取 miotDID：MiGPT / xiaogpt / 本插件 runtime 都按这个匹配
        did: String(d.miotDID ?? d.deviceID ?? ""),
        deviceID: String(d.deviceID ?? ""),
        name: String(d.name ?? d.alias ?? "未命名音箱"),
        alias: String(d.alias ?? ""),
        model: String(d.hardware ?? ""),
        modelName: commands.name,
        support: commands.support,
        commands,
        online: String(d.presence ?? "") === "online",
        serialNumber: d.serialNumber ?? null,
        romVersion: d.romVersion ?? null,
      };
    })
    .sort((a, b) => Number(b.online) - Number(a.online));
}

// ═══════════════════════ 4. 登录（含风控处理） ═══════════════════════

/**
 * 小米登录 + 风控识别。
 *
 * 为什么不用 vendor 的 `getMiNA()/getMiIOT()` 一把梭：
 * 它们把风控场景吞成 `undefined`（`getAccount()` 里只 console.log 就 return void 0），
 * 调用方拿到的是"登录失败"这个没有任何诊断价值的结论 —— 而用户真正需要知道的
 * 是"去这个链接授权，等 1 小时"。所以这里**自己走两步登录握手**，
 * 复用 vendor 已经导出不了但语义明确的接口（`/serviceLogin` + `/serviceLoginAuth2`）。
 *
 * ⚠️ 为什么不用 vendor 内部的 `getAccount`：它没有 export。
 * 因此这里用 Node 内置 fetch 重放同一个握手 —— 参数与 vendor :748/:767 逐字对应，
 * 保证服务端行为一致（同样的 sid / _sign / hash 算法）。
 *
 * @param {{account: string, password: string, timeoutMs?: number}} args
 * @returns {Promise<object>} `{ok:true, userId}` 或 `{ok:false, needsAuth:true, authUrl}` 或 `{ok:false, error}`
 */
export async function loginWithAccount({ account, password, timeoutMs = 15000 }) {
  const user = String(account ?? "").trim();
  const pass = String(password ?? "");
  if (!user) return { ok: false, code: "xiaoai/bad-request", error: "账号不能为空" };
  if (!pass) return { ok: false, code: "xiaoai/bad-request", error: "密码不能为空" };

  const LOGIN_API = "https://account.xiaomi.com/pass";
  const jsonp = (text) => {
    // 小米所有登录接口都返回 `&&&START&&&{...}`
    const idx = text.indexOf("&&&START&&&");
    const body = idx >= 0 ? text.slice(idx + "&&&START&&&".length) : text;
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  };
  const md5 = (s) => createHash("md5").update(s).digest("hex");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, timeoutMs));
  try {
    // ── 第一步：拿 _sign（vendor :748）──
    const sid = "micoapi";
    const first = await fetch(`${LOGIN_API}/serviceLogin?sid=${sid}&_json=true&_locale=zh_CN`, {
      headers: { "User-Agent": UA },
      signal: controller.signal,
    });
    const pass1 = jsonp(await first.text());
    if (!pass1) return { ok: false, code: "xiaoai/upstream", error: "小米登录接口返回了无法解析的内容" };

    // ── 第二步：提交账号密码（vendor :767）──
    const body = new URLSearchParams({
      _json: "true",
      qs: String(pass1.qs ?? ""),
      sid,
      _sign: String(pass1._sign ?? ""),
      callback: String(pass1.callback ?? ""),
      // ⚠️ user 字段服务端自己识别手机号 / 邮箱 / 小米 ID —— 这是"零输入"的关键
      user,
      hash: md5(pass).toUpperCase(),
    });
    const second = await fetch(`${LOGIN_API}/serviceLoginAuth2`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: body.toString(),
      signal: controller.signal,
    });
    const pass2 = jsonp(await second.text());
    if (!pass2) return { ok: false, code: "xiaoai/upstream", error: "小米登录接口返回了无法解析的内容" };

    // ── 风控（vendor :783-795 的同款判定，但结构化返回）──
    if (!pass2.location || !pass2.nonce || !pass2.passToken) {
      const authUrl = pass2.notificationUrl || pass2.captchaUrl || null;
      if (authUrl) {
        return {
          ok: false,
          needsAuth: true,
          authUrl,
          waitMinutes: 60,
          code: pass2.code ?? null,
          message:
            "小米检测到异地登录，需要在浏览器里完成安全验证。" +
            "授权成功后约需等待 1 小时账号信息才会更新，之后再点一次「登录」。",
        };
      }
      const reason =
        pass2.code === 70016
          ? "账号或密码错误（也可能是账号被限制登录）"
          : String(pass2.description ?? pass2.desc ?? "小米拒绝了这次登录");
      return { ok: false, code: "xiaoai/auth-failed", error: reason, upstreamCode: pass2.code ?? null };
    }

    // ── 第三步：换 serviceToken（vendor :_getServiceToken）──
    const nonce = pass2.nonce;
    const ssecurity = pass2.ssecurity ?? "";
    const clientSign = createHash("sha1").update(`nonce=${nonce}&${ssecurity}`).digest("base64");
    const loc = String(pass2.location);
    const url = `${loc}${loc.includes("?") ? "&" : "?"}_userIdNeedEncrypt=true&clientSign=${encodeURIComponent(clientSign)}`;
    const third = await fetch(url, { headers: { "User-Agent": UA }, signal: controller.signal });
    const setCookie = third.headers.getSetCookie?.() ?? [];
    let serviceToken = null;
    for (const cookie of setCookie) {
      if (cookie.includes("serviceToken")) {
        serviceToken = cookie.split(";")[0].replace("serviceToken=", "");
        break;
      }
    }
    if (!serviceToken) {
      return { ok: false, code: "xiaoai/upstream", error: "登录成功但没能取到 serviceToken" };
    }

    // 从 location 的 query 里抠 userId（小米把它放在 location 上）
    let userId = "";
    try {
      userId = new URL(loc).searchParams.get("userId") ?? "";
    } catch {
      /* location 不是合法 URL 时留空，下面靠 cookie 兜底 */
    }

    return {
      ok: true,
      userId: userId || String(pass2.userId ?? ""),
      ssecurity,
      serviceToken,
      pass: { ssecurity, passToken: pass2.passToken, nonce },
      credentials: {
        mina: { userId: userId || String(pass2.userId ?? ""), sid: "micoapi", serviceToken, ssecurity, password: pass, deviceId: `android_${randomUUID()}` },
        miiot: { userId: userId || String(pass2.userId ?? ""), sid: "xiaomiio", serviceToken, ssecurity, password: pass, deviceId: `android_${randomUUID()}` },
      },
    };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return {
      ok: false,
      code: aborted ? "xiaoai/timeout" : "xiaoai/network",
      error: aborted ? "连接小米服务器超时" : `连接小米服务器失败: ${err?.message ?? err}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 与 vendor 同一款 UA（小米对 UA 敏感，换掉可能直接走风控）。 */
const UA = "MICO/AndroidApp/@SHIP.TO.2A2FE0D7@/2.4.40";

// ═══════════════════════ 5. 用凭据列出设备 ═══════════════════════

/**
 * 用一份凭据列出账号下的音箱。
 *
 * ⚠️ 这里**不能**直接调 vendor 的 `getMiNA()` 去打探一份候选凭据，原因有两个，
 * 都会造成真实事故：
 *
 *  1. vendor 在【模块求值时】就锁定写盘路径：
 *       `var kConfigFile = process.env.XIAOAI_MI_STORE || ".mi.json"`
 *     而本插件的 bootstrap 已经把它设成了真实凭据文件。getMiNA() 结尾会
 *     无条件 `writeJSON(kConfigFile, store)` —— 拿候选凭据去试，
 *     **会把候选的 token 覆盖写进用户正式配置**。
 *  2. 候选凭据（如从 MiGPT 导入的）可能属于另一个小米账号，
 *     覆盖后表现为"配置莫名其妙变成了别人的账号"。
 *
 * 因此：凡是"用别人的凭据探路"的场景，一律走 `probeSpeakers()` ——
 * 它把 vendor 的模块**重新加载一份**（带 query 后缀绕过 ESM 缓存）
 * 并指向临时 store，与正式配置完全隔离。
 *
 * @param {object} args `{ userId, password, did?, timeoutMs? }`
 * @returns {Promise<{ok: boolean, speakers?: Array<object>, error?: string}>}
 */
export async function listSpeakers({ userId, password, did, timeoutMs = 15000 } = {}) {
  return probeSpeakers({ account: { userId, password }, did, timeoutMs });
}

/**
 * 判断 vendor 打印出来的东西里是否包含小米风控的授权链接。
 *
 * 为什么需要"事后侦测"而不是直接返回：
 *   vendor 的 `getAccount()` 在风控场景下只 `console.log` 链接然后返回
 *   `undefined` —— 调用方（我们的 `getMiNA()`）拿到的是"登录失败"这个
 *   毫无诊断价值的结论。我们**不能改 vendor**（它是逐字照搬的上游代码，
 *   改了以后无法用 diff 对照上游），所以在探路期间临时拦截 console，
 *   把 `notificationUrl` / `captchaUrl` 抠出来结构化返回给 UI。
 *
 * 这是"能用"与"用户知道该干什么"的区别：没有它，用户只会看到
 * "账号或密码不正确"，然后开始怀疑自己记错了密码。
 *
 * @param {() => Promise<T>} fn 被侦测的异步操作
 * @returns {Promise<{value: T, authUrl: string|null, sawRiskControl: boolean}>}
 * @template T
 */
async function captureAuthChallenge(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  let authUrl = null;
  let sawRiskControl = false;

  /** 从一行输出里抠出授权 URL。 */
  const sniff = (args) => {
    for (const a of args) {
      const text = typeof a === "string" ? a : "";
      if (!text) continue;
      if (text.includes("异地登录安全验证")) sawRiskControl = true;
      // 链接可能混在 JSON / 前缀文本里，用宽松匹配
      const m = text.match(/https:\/\/account\.xiaomi\.com\/[^\s"'\\]+/);
      if (m && !authUrl) authUrl = m[0].replace(/[",]+$/, "");
    }
  };

  console.log = (...args) => {
    sniff(args);
    originalLog(...args);
  };
  console.error = (...args) => {
    sniff(args);
    originalError(...args);
  };
  try {
    const value = await fn();
    return { value, authUrl, sawRiskControl };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/**
 * 在**隔离的临时 store** 里用任意凭据登录并列设备。
 *
 * 隔离手法（ESM 缓存绕过）：
 *   1. 建成临时目录 + 临时 store 文件（0600），内容 = 传入的凭据
 *   2. 设 `process.env.XIAOAI_MI_STORE` 指向它
 *   3. `import(vendorUrl + "?probe=" + n)` —— query 让 Node 视为不同模块，
 *      从而**重新求值**那份 vendor，它读到的就是新的 env 值
 *   4. 用完把 env 还原、临时目录删掉
 *
 * 代价是每次探路多加载一份 vendor（约 28KB JS，毫秒级），换来的是
 * "绝不污染用户正式配置"这个硬保证 —— 值得。
 *
 * @param {{account: {userId?: string, password?: string}, store?: object, did?: string, timeoutMs?: number}} args
 *        `store` 给出完整凭据节点（含 serviceToken）时走"免登录"快路径。
 * @returns {Promise<{ok: boolean, speakers?: Array<object>, error?: string, needsAuth?: boolean, authUrl?: string}>}
 */
export async function probeSpeakers({ account = {}, store = null, did, timeoutMs = 15000 } = {}) {
  const userId = String(account.userId ?? store?.userId ?? "").trim();
  const password = String(account.password ?? store?.password ?? "");

  // 没有任何可用凭据 → 明确报错，不要静默返回空列表（UI 会误以为"你没音箱"）
  const hasToken = Boolean(store?.serviceToken && store?.ssecurity);
  if (!hasToken && (!userId || !password)) {
    return {
      ok: false,
      code: "xiaoai/bad-request",
      error: "需要账号+密码，或一份含 serviceToken 的凭据。当前两者都没有。",
    };
  }
  // ⚠️ vendor 的 `getMiService()` 在拿到 store 之后、复用 token 之前，
  // 会先做一次 `if (!account.userId || !account.password) return` ——
  // 也就是说**即便有新鲜 token，也仍然需要 userId 和 password 存在**
  // （实测：不传就打印「没有找到账号或密码」并返回 undefined）。
  // 这很反直觉，但它是硬约束，因此这里把 store 里的字段显式补进 config。
  const seededUserId = userId || String(store?.userId ?? "");
  const seededPassword = password || String(store?.password ?? "");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoai-probe-"));
  const tmpStore = path.join(tmpDir, "probe-store.json");
  const prevEnv = process.env.XIAOAI_MI_STORE;
  try {
    // 临时 store 结构必须与 vendor 期望的一致：{mina:{...}, miiot:{...}}
    const seeded = store
      ? { mina: { ...store, sid: "micoapi" }, miiot: { ...store, sid: "xiaomiio" } }
      : {};
    fs.writeFileSync(tmpStore, JSON.stringify(seeded), { mode: 0o600 });
    process.env.XIAOAI_MI_STORE = tmpStore;

    // 绕过 ESM 模块缓存：query 后缀使这次 import 成为独立模块实例
    const vendorUrl = new URL("../vendor/mi-service-lite.js", import.meta.url).href;
    const { getMiNA } = await import(`${vendorUrl}?xiaoai-probe=${Date.now()}-${Math.random()}`);

    const cfg = { timeout: timeoutMs, userId: seededUserId, password: seededPassword };
    if (did) cfg.did = String(did);

    // ── 关键：拦截 vendor 的 console，把风控链接救出来 ──
    // 见 captureAuthChallenge 的说明：vendor 在风控时只打印不抛错，
    // 不拦截的话这个链接就永远到不了用户眼前。
    const { value: na, authUrl, sawRiskControl } = await captureAuthChallenge(() => getMiNA(cfg));

    if (!na) {
      if (authUrl || sawRiskControl) {
        return {
          ok: false,
          needsAuth: true,
          authUrl,
          waitMinutes: 60,
          code: "xiaoai/needs-auth",
          error:
            "小米检测到异地登录，需要在浏览器里完成安全验证。" +
            "授权成功后约需等待 1 小时账号信息才会更新。",
        };
      }
      return {
        ok: false,
        code: "xiaoai/auth-failed",
        error: "登录失败：账号或密码不正确（也可能是账号被限制登录）。",
      };
    }

    const devices = await na.getDevices();
    const raw = Array.isArray(devices) ? devices : (devices?.data ?? []);
    if (raw.length === 0) {
      return {
        ok: false,
        code: "xiaoai/no-devices",
        error: "登录成功，但这个账号下的设备列表是空的（或 serviceToken 已失效）。",
      };
    }
    return { ok: true, speakers: toSpeakerList(raw), deviceCount: raw.length };
  } catch (err) {
    return { ok: false, code: "xiaoai/internal", error: `探测设备列表失败: ${err?.message ?? err}` };
  } finally {
    // 还原 env：vendor 的正式实例已经用旧值求值过了，但任何**之后**的
    // 懒加载都必须看到原值，否则会把正式写入导向临时目录（下次探测时已被删）。
    if (prevEnv === undefined) delete process.env.XIAOAI_MI_STORE;
    else process.env.XIAOAI_MI_STORE = prevEnv;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
}

// ───────────────────────── 从远程 HA 导入 ─────────────────────────

/**
 * 从远程 Home Assistant 导入小米凭据（micoapi + xiaomiio 两份）。
 *
 * 背景：小米云的两个服务各需独立 token（见 docs/CREDENTIALS.md），
 * 而 HA 的 xiaomi_miot 集成两份都有 —— 这是实测最省事、最可靠的来源。
 *
 * 安全与健壮性：
 *   · 只读 HA 的凭据文件，绝不修改
 *   · 密码通过 SSHPASS 环境变量传递，不出现在 argv（避免 ps 泄漏）
 *   · 任一步失败就抛错，**不动本地 store**（避免把好的凭据弄坏）
 *   · 成功时【合并】写入，保留本地已有字段（如 password）
 *
 * @param {{host: string, user: string, password: string, uid?: string,
 *          did?: string, hardware?: string, storePath: string}} opts
 * @returns {Promise<{ok: boolean, summary: {uid: string, mina: boolean, miiot: boolean, dir: string}}>}
 */
export async function importCredentialsFromHa(opts) {
  const { host, user, password, uid, did, hardware, storePath } = opts;
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");

  /** 远程执行；密码走环境变量。 */
  const ssh = (cmd) =>
    execFileSync(
      "sshpass",
      ["-e", "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
       `${user}@${host}`, cmd],
      { env: { ...process.env, SSHPASS: password }, encoding: "utf8", timeout: 60_000 },
    ).trim();

  // 1. 探测 HA 的凭据目录（三种常见布局）
  const HA_DIRS = [
    "/homeassistant/.storage/xiaomi_miot",
    "/config/.storage/xiaomi_miot",
    "/usr/share/hassio/homeassistant/.storage/xiaomi_miot",
  ];
  let dir = null;
  for (const d of HA_DIRS) {
    try {
      ssh(`test -d ${d} && echo ok`);
      dir = d;
      break;
    } catch {
      /* 试下一个 */
    }
  }
  if (!dir) {
    throw new Error(
      `未能在 HA 上找到 xiaomi_miot 凭据目录（试过: ${HA_DIRS.join("、")}）。` +
        "请确认 HA 装了该集成并已登录小米账号。",
    );
  }

  // 2. 发现账号
  const listing = ssh(`ls ${dir} 2>/dev/null | grep -E '^auth-[0-9]+-cn(-micoapi)?\\.json$'`);
  const uids = [...new Set(
    listing.split("\n").map((f) => f.match(/^auth-(\d+)-cn/)?.[1]).filter(Boolean),
  )];
  if (uids.length === 0) throw new Error("未在 HA 上找到 auth-*.json，可能该账号未登录");
  const useUid = uid ?? uids[0];

  // 3. 读两份凭据
  const readJson = (file) => {
    try {
      const d = JSON.parse(ssh(`cat ${dir}/${file} 2>/dev/null`));
      return d.data ?? d;
    } catch {
      return null;
    }
  };
  const micoapi = readJson(`auth-${useUid}-cn-micoapi.json`);
  const xiaomiio = readJson(`auth-${useUid}-cn.json`);

  if (!micoapi?.service_token && !xiaomiio?.service_token) {
    throw new Error("HA 上的两份凭据都没有 service_token（可能是过期的空壳）");
  }

  // 4. 组装（字段名严格按 vendor 的读取方式 —— device.deviceId 在 device 对象里）
  const toSegment = (src, sid) => {
    if (!src?.service_token) return undefined;
    return {
      userId: String(src.user_id ?? useUid),
      sid,
      serviceToken: src.service_token,
      deviceId: src.device_id ?? "",
      did: did ?? "",
      device: { deviceId: src.device_id ?? "", hardware: hardware ?? "", did: did ?? "" },
      pass: { ssecurity: src.ssecurity ?? "", passToken: "" },
    };
  };
  const incoming = {};
  const mina = toSegment(micoapi, "micoapi");
  const miiot = toSegment(xiaomiio, "xiaomiio");
  if (mina) incoming.mina = mina;
  if (miiot) incoming.miiot = miiot;

  // 5. 合并写入（保留本地 password 等字段）
  const target = resolve(storePath);
  let merged = incoming;
  if (existsSync(target)) {
    try {
      const cur = JSON.parse(readFileSync(target, "utf8"));
      merged = {
        ...cur,
        ...Object.fromEntries(
          Object.entries(incoming).map(([k, v]) => [k, { ...(cur[k] ?? {}), ...v }]),
        ),
      };
    } catch {
      /* 现有文件坏了 —— 直接用导入的 */
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(merged, null, 2));

  return {
    ok: true,
    summary: {
      uid: String(useUid),
      mina: Boolean(mina),
      miiot: Boolean(miiot),
      dir,
      candidates: uids,
    },
  };
}
