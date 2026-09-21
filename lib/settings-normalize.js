/**
 * 多音箱配置的纯函数层。
 *
 * 设计依据：`docs/research/multi-speaker-design.md` §3（配置结构）、§5（会话隔离）、§7（兼容）。
 *
 * 为什么单独成文件：
 *   这些函数**没有任何 IO、没有任何 this、不依赖 runtime 状态** —— 纯输入输出。
 *   归一化逻辑一旦和运行时搅在一起，就再也无法单测，而它恰好是
 *   「老配置升级会不会炸」的唯一关卡。抽出来可以穷举边界。
 *
 * ── 三条不可动摇的语义（写错任何一条都会静默毁数据）──
 *
 * 1. **读时归一化，不落盘迁移**（§3.3）
 *    「一次性迁移」需要处理「迁移到一半崩了」的中间态；读时归一化天然幂等、可回滚。
 *    老配置（只有 did）永远能被合成出 speakers[]，因此**不做任何磁盘写入**。
 *
 * 2. **覆盖回退用 `??`，绝不用 `||`**（§3.2，风险 R9）
 *    `null` / `undefined` / 缺省 = 未覆盖 → 回退全局；
 *    `""` 和 `[]` 是**有效覆盖值**，必须生效。
 *    用 `||` 会让「这台音箱不要唤醒词」（`wakeUpKeywords: []`）静默回退到全局，
 *    用户设了等于没设，且完全无迹可循。
 *
 * 3. **did 是投影，不是历史包袱**（§3.3 / §7.4）
 *    每次读到配置都令 `did === speakers[0]?.did`。
 *    老代码路径（外部脚本、老 UI、降级分支）只读 did 时，行为与改造前完全一致。
 */

/** 当前配置 schema 版本。v1 = 单 did，v2 = speakers[]。 */
export const SETTINGS_VERSION = 2;

/** 音箱对象里恒存在的标量字段（归一化时用作「老标量 → speakers[0]」的回填源）。 */
const SPEAKER_DEFAULTS = Object.freeze({
  name: "",
  model: "",
  deviceId: "",
  enabled: true,
});

/**
 * 每设备可覆盖的键（`null` / 缺省 = 继承全局）。
 *
 * 与设计 §5.2 的表格一致 —— 只有这几项 per-device 有意义：
 *   · workspace / agentPreset —— 不同房间不同工作区与人格
 *   · provider —— 省钱：次要音箱用便宜模型（⚠️ 见 normalizeSpeaker 的说明，
 *     LLM 的 `model` 不在此列，因为该键已被硬件型号占用）
 *   · volume —— 启动时设定音量
 *   · wakeUpKeywords —— 卧室与客厅可用不同口令
 *
 * 刻意【不】包含的（设计里明确论证过）：
 *   · model          —— ⚠️ 与硬件型号**同名不同义**，见 normalizeSpeaker
 *   · pollIntervalMs —— 拉取是账号级共享的，per-device 无意义
 *   · sessionReuse   —— 每设备独立 session 已天然隔离，全局开关足够
 *   · 各类提示语     —— 全局统一体验更好
 */
export const OVERRIDABLE_KEYS = Object.freeze([
  "workspace",
  "agentPreset",
  "provider",
  "volume",
  "wakeUpKeywords",
]);

/**
 * 把任意历史形态的配置归一化成稳定的 `{ version, speakers[] }`。
 *
 * 幂等：`normalizeSettings(normalizeSettings(x).settings)` 结果不变。
 * 无副作用：绝不写磁盘、绝不改入参。
 *
 * @param {object|null|undefined} raw settings scope 读出来的原始对象。
 * @returns {{version: number, speakers: Array<object>}}
 */
export function normalizeSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};

  // ── 已是 v2 且 speakers 是数组：逐项归一化（过滤掉没有 did 的残项）──
  if (Array.isArray(src.speakers)) {
    const speakers = src.speakers
      .map(normalizeSpeaker)
      .filter((s) => s.did);
    // ⚠️ 特例：speakers 数组存在但全被过滤空（例如用户把 did 清空了）。
    //    此时若老 did 还有值，仍要回退到「用 did 合成一台」——否则会出现
    //    「配置里明明有 did，却一台音箱都不启动」的诡异状态。
    if (speakers.length === 0) {
      const legacy = legacySpeakerFrom(src);
      if (legacy) return { version: SETTINGS_VERSION, speakers: [legacy] };
    }
    return { version: SETTINGS_VERSION, speakers };
  }

  // ── v1（老配置）：单 did → 单元素 speakers[] ──
  const legacy = legacySpeakerFrom(src);
  return { version: SETTINGS_VERSION, speakers: legacy ? [legacy] : [] };
}

/**
 * 从老标量字段（did / deviceName / deviceModel）合成一台音箱。
 * 无 did 时返回 null（表示「账号还没配音箱」，与「配了但停用」不同）。
 */
function legacySpeakerFrom(src) {
  const did = String(src?.did ?? "").trim();
  if (!did) return null;
  return {
    did,
    // 老配置可能压根没存名字/型号 —— 连接时能从设备列表反查出来，留空即可。
    name: String(src?.deviceName ?? "").trim(),
    // 与 normalizeSpeaker 保持一致：型号统一大写，否则查表失败。
    model: String(src?.deviceModel ?? "")
      .trim()
      .toUpperCase(),
    // deviceId 是 MiNA 侧标识（播报用），老配置没有；连接时按 did 反查。
    deviceId: "",
    enabled: true,
    // 老配置没有覆盖概念 —— 全部 null 表示继承全局，行为与改造前一致。
    workspace: null,
    agentPreset: null,
    provider: null,
    volume: null,
    wakeUpKeywords: null,
  };
}

/**
 * 归一化单个音箱条目：补齐缺省字段、裁剪字符串、规范化覆盖项。
 *
 * @param {object} raw 单个音箱对象。
 * @returns {object} 稳定形状的音箱对象。
 */
export function normalizeSpeaker(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const out = {
    did: String(s.did ?? "").trim(),
    name: String(s.name ?? SPEAKER_DEFAULTS.name).trim(),
    // ⚠️ 统一大写：型号是 TTS 指令表的查表键（`commandForModel` 用大写比对），
    //    配置里写 "oh2p" 会让型号「未收录」而静默退化到默认指令。
    model: String(s.model ?? SPEAKER_DEFAULTS.model)
      .trim()
      .toUpperCase(),
    deviceId: String(s.deviceId ?? SPEAKER_DEFAULTS.deviceId).trim(),
    // ⚠️ 用 !== false 而不是 Boolean(...)：缺省（undefined）必须视为启用。
    //    老配置合成出来的条目没有 enabled 字段，用 Boolean 会变成全停用。
    enabled: s.enabled !== false,
  };
  for (const key of OVERRIDABLE_KEYS) {
    // ⚠️ `model` 是一个【双重身份】的键：它既是设备的硬件型号（上面那个
    //    `out.model`，参与 TTS 指令表查表），又是「模型 id」的覆盖项
    //    （agent 用哪个 LLM）。同名不同义。
    //
    //    设计文档 §3.2 的示例音箱对象里两者确实同名（都用 model），
    //    但那是**歧义**而非意图 —— 若在这里让覆盖逻辑覆盖掉型号，
    //    设备型号会变成 LLM 模型名（如 "workbuddy/deepseek-v4.1-flash"），
    //    TTS 指令表直接查不到，音箱从此不播报。
    //
    //    因此：**省略 `model` 覆盖项**。每设备的 LLM 模型差异通过
    //    `provider` + 全局 `model` 表达；本阶段不做 per-device 模型覆盖。
    //    这是与设计文档的一处有意偏差，已记入实现文档。
    if (key === "model") continue;
    out[key] = normalizeOverride(key, s[key]);
  }
  return out;
}

/** 规范化一个覆盖值：`null`/`undefined` → null；否则按类型收敛。 */
function normalizeOverride(key, value) {
  if (value === null || value === undefined) return null;
  if (key === "volume") {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
  }
  if (key === "wakeUpKeywords") {
    // ⚠️ 空数组是**有效覆盖值**（= 这台不要唤醒词），必须原样保留，
    //    绝不能因为「空」就当成未覆盖 —— 那正是 R9 要防的 bug。
    if (!Array.isArray(value)) return null;
    return value.map((v) => String(v ?? "").trim()).filter(Boolean);
  }
  const str = String(value).trim();
  // 覆盖项的空串：设计 §3.2 明确「"" 是有效覆盖值」。
  // 但对这三个字段而言空串等价于「没填」，保留空串会让 resolveEffective
  // 产出空工作区路径并让 #resolveWorkspacePath 回落到默认 —— 与继承全局
  // 的结果可能不同。为消除歧义，这里把空串收敛成 null（= 继承）。
  // ⚠️ 这是**有意为之的偏差**，已在实现文档里标注。
  return str === "" ? null : str;
}

/**
 * 解析某台音箱**实际生效**的配置（覆盖 → 全局 → 硬默认）。
 *
 * ⚠️ 全程用 `??`。用 `||` 会让 `volume: 0`（静音启动）和
 *    `wakeUpKeywords: []`（不要唤醒词）静默回退到全局 —— 见风险 R9。
 *
 * ⚠️ `provider` 可以 per-device 覆盖，但 LLM 的 `model` 在本阶段**只支持全局**：
 *    音箱对象上的 `model` 键已被**硬件型号**占用（如 "OH2P"），两者同名不同义。
 *    详见 normalizeSpeaker 里关于双重身份键的说明与实现文档的「与设计的偏差」。
 *
 * @param {object} global 全局配置（settings 原值）。
 * @param {object} speaker 已归一化的音箱对象。
 * @returns {object} 生效配置。
 */
export function resolveEffective(global, speaker) {
  const g = global && typeof global === "object" ? global : {};
  const s = speaker && typeof speaker === "object" ? speaker : {};

  // ⚠️ `s.model` 是【硬件型号】（如 "OH2P"），**不是** LLM 模型 id ——
  //    见 normalizeSpeaker 里关于双重身份键的说明。因此这里绝不能用
  //    `s.model` 去覆盖 `g.model`（那会让 LLM 模型名变成 "OH2P"，
  //    provider/model 对不上，agent 直接起不来）。
  //    LLM 模型覆盖在本阶段只支持全局，`provider` 仍可 per-device。
  const providerOverride = s.provider ?? null;

  return {
    // ── 可覆盖项 ──
    workspace: s.workspace ?? g.workspace ?? "",
    agentPreset: s.agentPreset ?? g.agentPreset ?? "",
    provider: providerOverride !== null ? providerOverride : (g.provider ?? ""),
    model: g.model ?? "",
    // volume：null = 未覆盖（启动时不改音量）；0 是有效值（静音启动）
    volume: s.volume !== null && s.volume !== undefined ? s.volume : (g.volume ?? null),
    wakeUpKeywords:
      s.wakeUpKeywords !== null && s.wakeUpKeywords !== undefined
        ? s.wakeUpKeywords
        : (g.wakeUpKeywords ?? []),

    // ── 全局项（per-device 无意义，设计 §5.2 已论证）──
    sessionReuse: g.sessionReuse ?? true,
    pollIntervalMs: g.pollIntervalMs,
    maxReplyChars: g.maxReplyChars,
    exitKeepAliveAfter: g.exitKeepAliveAfter,
    aiModeEnabled: g.aiModeEnabled,
    callAIKeywords: g.callAIKeywords ?? [],
    exitKeywords: g.exitKeywords ?? [],
    triggerKeywords: g.triggerKeywords ?? [],
    ignorePatterns: g.ignorePatterns ?? [],
    localCommandsEnabled: g.localCommandsEnabled,
    progressAfterSeconds: g.progressAfterSeconds,
    historyLimit: g.historyLimit,
    replyTimeoutMs: g.replyTimeoutMs,
  };
}

/**
 * 取出实际参与运行的音箱（归一化 + 只保留启用的）。
 *
 * @param {object} raw settings 原值。
 * @returns {Array<object>} 已归一化且 enabled 的音箱。
 */
export function enabledSpeakers(raw) {
  return normalizeSettings(raw).speakers.filter((s) => s.enabled);
}

/**
 * 在音箱列表里 upsert 一台设备（幂等）。
 *
 * 用于 `onboarding.apply` / 「添加音箱」：did 已存在则更新元数据，
 * 否则追加。**绝不产生重复条目**，重复调用结果一致。
 *
 * 已存在时**保留用户已有的覆盖配置** —— 向导只是补名字/型号，
 * 不应该把用户为这台设备精心设的独立工作区冲掉。
 *
 * @param {Array<object>} speakers 现有列表。
 * @param {object} entry `{ did, name?, model?, deviceId?, enabled? }`。
 * @returns {Array<object>} 新列表（不改入参）。
 */
export function upsertSpeaker(speakers, entry) {
  const list = Array.isArray(speakers) ? speakers.map(normalizeSpeaker) : [];
  const did = String(entry?.did ?? "").trim();
  if (!did) return list;

  const idx = list.findIndex((s) => s.did === did);
  const incoming = normalizeSpeaker({ ...entry, did });

  if (idx === -1) {
    // ⚠️ 追加前先看老 did 投影：老配置升级时 speakers 为空、而 did 有值，
    //    此时第一次「添加音箱」不该产生两台（一台合成的 + 一台新增的）。
    return [...list, incoming];
  }

  const prev = list[idx];
  const merged = {
    ...prev,
    // 只在对方提供了非空值时更新 —— 向导没传 name 不该把已有名字抹掉
    name: incoming.name || prev.name,
    model: incoming.model || prev.model,
    deviceId: incoming.deviceId || prev.deviceId,
    // enabled 显式传入才覆盖（undefined 保持原状）
    enabled: entry?.enabled === undefined ? prev.enabled : entry.enabled !== false,
  };

  // ── 覆盖项：显式传入才覆盖，未传入保留原值 ──
  //
  // ⚠️ 这里【不能】简单地 `{...prev, ...incoming}`：normalizeSpeaker 会把
  //    未提供的覆盖项统一填成 null（= 继承全局），直接展开就等于「没传 = 清空」，
  //    向导补个名字就会把用户配好的独立工作区冲掉。
  //    判据是**原始 entry 里有没有这个键**，而不是归一化后的值。
  for (const key of OVERRIDABLE_KEYS) {
    // `model` 是硬件型号（上面已单独处理），不是覆盖项。
    if (key === "model") continue;
    if (Object.hasOwn(entry ?? {}, key)) merged[key] = incoming[key];
  }
  list[idx] = merged;
  return list;
}

/**
 * 由音箱列表反推兼容投影 `did`（恒等于第一台）。
 *
 * 每个写 settings 的入口都必须同时写 did —— 老 UI
 * （`src/client/index.js:4204` 读 `status.speaker`）、外部脚本、
 * 降级分支都还在读它。阶段 1-2 期间双写，成本极低而兼容收益很大。
 *
 * @param {Array<object>} speakers 音箱列表。
 * @returns {string} 第一台的 did，空列表时为空串。
 */
export function projectDid(speakers) {
  const first = Array.isArray(speakers) ? speakers.find((s) => s?.did) : null;
  return first ? String(first.did).trim() : "";
}

/**
 * 由音箱列表反推兼容投影 `deviceModel`（第一台的型号）。
 * 与 projectDid 同理：向导与老代码仍在读这个标量字段。
 */
export function projectDeviceModel(speakers) {
  const first = Array.isArray(speakers) ? speakers.find((s) => s?.did) : null;
  return first ? String(first.model ?? "").trim() : "";
}

/** 汇总每台设备的状态，供 UI 显示「N 台 · M 在线」。 */
export function summarizeSpeakers(speakerStatuses) {
  const list = Array.isArray(speakerStatuses) ? speakerStatuses : [];
  const total = list.length;
  const enabled = list.filter((s) => s.enabled !== false).length;
  const online = list.filter((s) => s.connected === true).length;
  return { total, enabled, online, disabled: total - enabled };
}
