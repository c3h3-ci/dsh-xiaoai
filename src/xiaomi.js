import "./bootstrap.js";
/**
 * 小米音箱连接层 —— 只做两件事：抓语音文字、播放 TTS。
 * 不含任何 AI 逻辑（那是 DSH 的事）。
 */
import fs from "node:fs";
import path from "node:path";
import { getMiNA, getMiIOT } from "../vendor/mi-service-lite.js";
import { commandForModel } from "./onboarding.js";


/** TTS 单次文本上限（字节）。小米 API 超过约 3900–4050 字节返回 -704002000。 */
const TTS_MAX_BYTES = 3800;
/**
 * 连续空返回达到该次数后，改为「主动探针」判定，而不是直接抛错。
 *
 * 背景（issue #4 P0-3）：单纯用「连续 N 次空返回」判定 token 失效是错的 ——
 * 用户 20 秒没说话就会触发，音箱会莫名其妙开口念「连接出了问题」。
 * 「没人说话」和「拉不到数据」必须区分开，靠次数或时长都做不到，
 * 只有**探测一个不依赖对话内容的接口**才能确定链路是否真的断了。
 */
const EMPTY_STREAK_LIMIT = 5;

/** 按 UTF-8 字节截断，且不切断多字节字符。 */
export function truncateToBytes(text, maxBytes) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // 回退到 UTF-8 字符边界（续字节为 10xxxxxx）
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * 从 answers 数组里提取最合适的可读文本。
 * 跳过 illegalContent；依次探测 tts/llm/audio/text/content/general/nlp/speech。
 * @returns {{text: string, type: string, index: number}}
 */
export function extractAnswerText(answers) {
  const list = Array.isArray(answers) ? answers : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (!a || a.illegalContent === true) continue;
    for (const key of ["tts", "llm", "audio", "general", "nlp", "speech", "content", "text"]) {
      const node = a[key];
      const t = typeof node === "string" ? node : node?.text;
      if (typeof t === "string" && t.trim()) {
        return { text: t.trim(), type: String(a.type ?? key), index: i };
      }
    }
  }
  return { text: "", type: "", index: -1 };
}

/**
 * OH2P（Xiaomi 智能音箱 Pro）的 MIoT 指令实测可用值，来自 MiGPT 官方兼容表。
 *
 * ⚠️ 完整型号表已移到 `src/onboarding.js` 的 `SPEAKER_MODELS`（19 个型号，
 * 合并 MiGPT `docs/compatibility.md` 与 xiaogpt `config.py:HARDWARE_COMMAND_DICT`），
 * 因为"首次接入向导"需要把型号表同时用于**展示**（型号名/支持等级）与
 * **配置**（指令集）。这里保留常量只为向后兼容引用点。
 */
const MODEL_COMMANDS = {
  OH2P: { tts: [7, 3], wakeUp: [7, 1] },
  LX06: { tts: [5, 1], wakeUp: [5, 3] },
};

export class XiaomiSpeaker {
  #na = null;
  #iot = null;
  #device = null;
  #emptyStreak = 0;
  lastSpoken = null;

  constructor({ userId, password, did, miStorePath, logger }) {
    this.userId = userId;
    this.password = password;
    this.did = did;
    this.miStorePath = miStorePath;
    this.log = logger ?? (() => {});
    // ⚠️ vendored 的 mi-service-lite 在【模块导入时】就把 kConfigFile 定死了
    // （`var kConfigFile = process.env.XIAOAI_MI_STORE || ".mi.json"`），
    // 之后再设环境变量无效。因此调用方必须在 import 之前设好，
    // 这里只做一次显式校验，避免"看起来设了其实没生效"的静默失败。
    this.storePathHonored =
      !miStorePath || process.env.XIAOAI_MI_STORE === miStorePath;
  }

  /** 建立 MiNA / MiIOT 连接。凭据来自 .mi.json（已绕过密码登录）。 */
  async connect() {
    // 注意：did 必须在这里传，否则库的 overrides 会用 undefined 覆盖 store 里的值
    // ── P1-3（后半）：路径未生效必须【硬失败】，不能降级 ──
    //
    // 原实现只打一条告警就继续，结果会静默退回到 cwd 下的 `.mi.json`：
    //   - 凭据散落到意想不到的位置（且是 0644 权限）
    //   - 与 vendor 的写入路径叠加后，可能读到/写到两份不同的 store
    // 这种「看起来配好了其实没生效」的静默降级比直接报错危险得多，
    // 因此这里改为抛错，让上层把明确的原因展示到 UI。
    // ── P1-3（后半）：路径未生效时的处理 ──
    //
    // 历史：这里一度改成直接抛错（避免静默降级到 cwd 下的 .mi.json）。
    // 但那个改动引发了更严重的事故（台式DSH 死机）：
    //   路径错配 → connect 抛错 → 而凭据刷新已成功 → 触发无限重启循环。
    //
    // 正确做法不是「静默降级」也不是「硬抛错」，而是【认识到库已经锁定了
    // 它自己的路径，我们就用那个路径】—— 库读到哪份 store，我们就以那份为准，
    // 这样绝不会错配，也不需要降级。只有在路径确实不存在时才告警。
    const libPath = process.env.XIAOAI_MI_STORE ?? ".mi.json";
    if (!this.storePathHonored) {
      this.log(
        `凭据路径与库锁定值不一致（库=${libPath}，期望=${this.miStorePath}）；` +
          `将以库的路径为准以免错配`,
      );
      this.miStorePath = libPath;
    }

    // ⚠️ 必须显式放宽超时（默认仅 3 秒）。
    //
    // mi-service-lite 的 Http.timeout 默认 3000ms，并且是【模块级全局且粘性】的
    // （`Http.timeout = config.timeout ?? Http.timeout`，一次调用会影响后续所有调用）。
    // 实测本机小米接口 86~650ms，但部署到别的网络路径（如台式机）时抖动很大，
    // 超过 3 秒就会被 abort，日志表现为「获取对话失败: This operation was aborted」
    // → 轮询持续失败。放宽到 15 秒并显式写入全局，避免受前次调用影响。
    const cfg = {
      userId: this.userId,
      password: this.password,
      did: this.did,
      timeout: 15000,
    };
    this.#na = await getMiNA(cfg);
    this.#iot = await getMiIOT(cfg);
    if (!this.#na || !this.#iot) throw new Error("小米登录失败（检查 .mi.json 凭据）");
    this.#device = await this.#resolveDevice();
    const model = String(this.#device?.hardware ?? "").toUpperCase();
    // 型号 → 指令集：走 onboarding 的完整兼容表（19 个型号），
    // 未收录型号回落到默认值并在日志里【明确说出来】—— 静默用默认指令
    // 会让"音箱不说话"变成一个无从下手的谜题。
    const resolved = commandForModel(model);
    const cmds = {
      tts: resolved.tts ?? MODEL_COMMANDS.OH2P.tts,
      wakeUp: resolved.wakeUp ?? MODEL_COMMANDS.OH2P.wakeUp,
    };
    this.commands = cmds;
    this.modelInfo = resolved;
    if (!resolved.known) {
      this.log(
        `⚠️ 型号 ${model} 未收录在兼容表中，已使用默认指令 tts=${JSON.stringify(cmds.tts)}。` +
          `若音箱不响应，请在 https://home.miot-spec.com 查到该型号的 TTS 指令后手动配置。`,
      );
    }
    if (resolved.support === "unsupported") {
      this.log(`⚠️ 型号 ${model}（${resolved.name}）已知不受支持，可能无法正常收发语音。`);
    }
    this.log(`已连接音箱: ${this.#device?.name} (${model}) tts=${JSON.stringify(cmds.tts)}`);
    return this.#device;
  }

  /**
   * 按 did / deviceID / 名称找到目标设备。
   *
   * 向导统一把 `miotDID` 写进设置（那是 MiGPT / xiaogpt / 本插件 runtime
   * 三家通用的标识），但老配置里可能是 deviceID 或米家里的中文名 ——
   * 这些形态都继续支持，否则升级后老用户的配置会突然失效。
   *
   * 另外：设备列表里**同一台音箱可能同时出现多条**（例如 App 端与音箱端
   * 各注册一次），因此用 `find` 命中第一条即可，不做去重 —— 去重反而会
   * 让"用户手填了 deviceID"这种精确匹配失效。
   */
  async #resolveDevice() {
    const devices = await this.#na.getDevices();
    const list = Array.isArray(devices) ? devices : devices?.data ?? [];
    const wanted = String(this.did ?? "").trim();
    if (!wanted) {
      throw new Error(
        list.length === 0
          ? "账号下没有可用设备"
          : `未配置音箱 DID。账号下有 ${list.length} 台设备，请在设置里选择一台`,
      );
    }
    const found =
      list.find((d) => String(d.deviceId) === wanted) ??
      list.find((d) => String(d.deviceID) === wanted) ??
      list.find((d) => String(d.miotDID) === wanted) ??
      list.find((d) => String(d.name) === wanted) ??
      list.find((d) => String(d.alias) === wanted);
    if (!found) {
      // 列出实际可选项，让用户不用去猜自己填错了什么
      const available = list
        .map((d) => `${d.name ?? d.alias ?? "?"}(${d.miotDID ?? d.deviceID ?? "?"})`)
        .slice(0, 8)
        .join(", ");
      throw new Error(`找不到设备: ${wanted}。账号下可选：${available || "（无）"}`);
    }
    return found;
  }

  /**
   * 主动探针：探测一个**不依赖对话内容**的接口，判断链路是否真的断了。
   *
   * 这是区分「没人说话」与「token 失效」的唯一可靠办法 ——
   * 对话接口返回空既可能是没消息，也可能是鉴权挂了，无法区分；
   * 而设备列表接口只要有权限就一定有返回。
   *
   * @returns {Promise<boolean>} true = 链路正常；false = 确实断了
   */
  async #probeLinkAlive() {
    if (!this.#na) return false;
    try {
      const devices = await this.#na.getDevices();
      const list = Array.isArray(devices) ? devices : (devices?.data ?? devices?.list ?? []);
      const alive = list.length > 0;
      if (!alive) this.log("探针: 设备列表为空，判定链路异常");
      return alive;
    } catch (err) {
      this.log(`探针失败: ${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * 拉取最近的对话记录（新→旧）。
   *
   * 硬化要点（REPORT.md §5/§8）：
   *  - 底层在鉴权失效时返回 undefined（而非抛错），旧实现一律退化成 []，
   *    与"没人说话"无法区分。这里连续空返回达阈值即抛错，让上层能告警。
   *  - 用多路径提取器取答案，跳过 illegalContent，避免 Audio/未知类型丢文本。
   *  - 守卫 limit<=0（limit:0 会静默返回 0 条）。
   */
  async fetchConversations(limit = 3) {
    if (!this.#na) throw new Error("未连接音箱（请先 connect()）");
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 3;

    try {
      const res = await this.#na.getConversations({ limit: safeLimit });
      const records = res?.records ?? [];

      if (records.length === 0) {
        // 「空」是正常状态（没人说话），绝不能据此报错。
        this.#emptyStreak += 1;
        if (this.#emptyStreak >= EMPTY_STREAK_LIMIT && (await this.#probeLinkAlive()) === false) {
          throw new Error(
            `连续 ${this.#emptyStreak} 次拉取对话为空，且探针确认链路已断——` +
              `多半是 serviceToken 过期`,
          );
        }
      } else {
        this.#emptyStreak = 0;
      }

      return records.map((r) => {
        const picked = extractAnswerText(r.answers);
        return {
          query: String(r.query ?? "").trim(),
          answer: picked.text,
          answerType: picked.type,
          time: r.time,
          raw: r,
        };
      });
    } catch (err) {
      this.log(`获取对话失败: ${err?.message ?? err}`);
      throw err;
    }
  }

  /** 唤醒音箱（发 TTS 前需要，否则可能被忽略）。失败不致命，但必须可观测。 */
  async wakeUp() {
    if (!this.#iot) throw new Error("未连接音箱（请先 connect()）");
    try {
      const ok = await this.#iot.doAction(...this.commands.wakeUp);
      if (ok === false) this.log("唤醒被拒绝（继续尝试播报）");
    } catch (err) {
      this.log(`唤醒失败: ${err?.message ?? err}`);
    }
  }

  /**
   * 用音箱的 TTS 念出一段文字。
   *
   * 硬化要点（来自 tmp-tests/REPORT.md §6）：
   *  - 小米 API 对超长文本返回 code -704002000，但 doAction 只返回 false，
   *    旧实现把它丢掉了 → 完全静默失败。这里检查返回值并抛错。
   *  - 长度限制是【字节】而非字符（CJK 约 3900–4050 字节），故按字节截断。
   */
  async say(text) {
    if (!this.#iot) throw new Error("未连接音箱（请先 connect()）");
    const clean = String(text ?? "").trim();
    if (!clean) return;

    const safe = truncateToBytes(clean, TTS_MAX_BYTES);
    await this.wakeUp();

    const ok = await this.#iot.doAction(...this.commands.tts, safe);
    if (ok === false) {
      throw new Error(`TTS 发送被拒（文本 ${Buffer.byteLength(safe, "utf8")} 字节）`);
    }
    this.lastSpoken = safe;
    return safe;
  }

  // ── 音箱本机控制（供「本地快速路径」用，不必走 LLM）──
  //
  // vendor 已提供 getVolume/setVolume（lib/vendor/mi-service-lite.js:486-496）。
  // 注意 setVolume 内部 clamp(6,100)：传 0 会被抬到 6，与"静音"语义不符，
  // 因此 0 单独映射到 1（最小可听下限）；真正静音应走 pause。

  /** 读当前音量（0-100）。未连接或读不到时返回 null。 */
  async getVolume() {
    if (!this.#iot) return null;
    try {
      const v = await this.#iot.getVolume();
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }

  /** 设置音量（0-100）。返回 {ok, volume}。 */
  async setVolume(volume) {
    if (!this.#iot) throw new Error("未连接音箱（请先 connect()）");
    const v = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
    const target = v === 0 ? 1 : v;
    const ok = await this.#iot.setVolume(target);
    return { ok: ok !== false, volume: target };
  }

  /** 相对调整音量（delta 正负），返回调整前后的值。 */
  async adjustVolume(delta) {
    const cur = (await this.getVolume()) ?? 50;
    const next = Math.max(1, Math.min(100, cur + Number(delta || 0)));
    const r = await this.setVolume(next);
    return { ...r, from: cur };
  }

  /** 暂停播放。 */
  async pause() {
    if (!this.#iot) throw new Error("未连接音箱（请先 connect()）");
    try {
      await this.#iot.pause();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }
}

/** 读取/写入 MiGPT 兼容的 .mi.json 凭据缓存。 */
export function readMiStore(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeMiStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
}
