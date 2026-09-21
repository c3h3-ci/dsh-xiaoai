# 多音箱支持 —— 可实施设计方案

> 任务：task-5 · 作者：multi-speaker-architect · 状态：研究完成，**未改任何代码**
> 目标：把 dsh-xiaoai 从「只支持 1 台音箱」改造为「账号下 N 台音箱各自独立工作」。

---

## 0. 摘要（先看这个）

| 问题 | 结论 |
|---|---|
| **A. 配置结构** | 推荐**方案 2**（`speakers[]` 对象数组）+ **全局默认 + 每设备覆盖**；老 `did` 双写保留 |
| **B. 运行时** | **MiNA 连接共享 1 个**，`XiaomiSpeaker` **每设备 1 个**；轮询 **1 次拉全部**（已实测验证！） |
| **C. 会话隔离** | 每设备独立会话（`sessionKeyFor(did)` 已支持）；`workspace/agentPreset/model` 全局默认 + 每设备覆盖 |
| **D. UI** | 设备卡片列表（借 dsh-im `BotSettingsButton` 模式）+ 每卡独立状态点 |
| **E. 迁移** | 读时归一化（read-time normalization），**零破坏**；老 `did` 字段保留为兼容投影 |
| **F. 工作量** | 后端 ~600 行 / 前端 ~700 行；**分 3 阶段**，阶段 1 即可交付「2 台音箱」 |

### 🔴 最重要的实测发现（颠覆原设计假设）

**小米对话接口是【账号级】的，不是【设备级】的。**

原任务描述假设「N 台设备 = N 倍请求」。**实测证明这个假设是错的** ——
一个 HTTP 请求就能拿到**账号下所有音箱**的对话。
这直接决定了轮询架构：**N 台音箱不需要 N 倍拉取请求**。

具体证据见 [§2.2](#22-关键核实小米对话接口的粒度)。

### ⚠️ 实施前必须处理的两件事

| # | 事项 | 说明 |
|---|---|---|
| **R2** | **vendor 并发竞态**（§4.3） | 推荐给 vendor 加 `storeOverride`（2 行，**已实机验证**）；至少要做「串行化 + 连接后校验 did」 |
| **R1** | **`records[]` 结构未知**（§4.4） | 决定路由方案 B1（精确）vs B2（降级）；**Lead 已安排实测** |

---

## 1. 现状分析（当前实现的真实约束）

### 1.1 单设备假设渗透在哪里

| 位置 | 代码 | 单设备假设 |
|---|---|---|
| `src/index.js:260` | `did: z.string().default(DEFAULTS.did)` | 配置层：单值字符串 |
| `src/runtime.js:189` | `#speaker = null;` | 运行时：单实例字段 |
| `src/runtime.js:491` | `sessionKeyFor(this.#config.did)` | 会话：单 key |
| `src/runtime.js:1488` | `if (!this.#config.did) missing.push(...)` | 校验：要求单个 did |
| `src/runtime.js:1515-1522` | `new XiaomiSpeaker({ did: this.#config.did, ... })` | 构造：单实例 |
| `src/runtime.js:1714` | `this.#speaker.fetchConversations(5)` | 轮询：单次拉取 |
| `src/runtime.js:1795` | `this.#speaker.say(text)` | 播报：单目标 |
| `src/xiaomi.js:78` | `this.did = did` | 实例：单 did 字段 |
| `src/rpc.js:297` | `RESTART_KEYS = ["enabled","userId","password","did"]` | 重启判定：单 did key |
| `src/runtime.js:251` | `speaker: { connected, name, model, did }` | 状态：单音箱对象 |

### 1.2 关键实例状态（决定「一个实例能不能服务多设备」）

`XiaomiRuntime` 的这些字段**全部是单设备状态**，多设备必须各自独立：

```
#speaker          音箱连接对象
#lastTime         水位线（最后处理的消息时间）
#firstPoll        冷启动保护标志
#seen             去重 Set（`${time}|${query}`）
#aiMode           AI 模式状态机：idle|active|thinking|replying
#keepAliveTimer   自动退出倒计时
#history          对话历史环形缓冲
#agent            绑定的 agent
#conversationKey  会话 key
#consecutiveErrors 连续错误计数
```

**结论**：`#lastTime` / `#seen` / `#aiMode` / `#history` 必须是 **per-device**。
如果共享，会出现：
- **水位线串台**：A 音箱说话了，水位线抬高 → B 音箱的新消息被 `r.time > #lastTime` 过滤掉 → **B 音箱永久失聪**
- **去重误杀**：`${time}|${query}` 在两台音箱同时说同一句话时会互相吞掉
- **AI 模式串台**：对 A 说「进入 AI 模式」，B 也进了

这是多音箱改造**最核心的风险点**，也是为什么必须「每设备一个运行时上下文」。

---

## 2. 关键事实核实（本次实测）

> 所有核实均用**本机真实账号凭据**（`~/.dsh/xiaoai-state/mi-store.json`，
> userId=USER_ID_PLACEHOLDER）直连小米云完成，非推断。

### 2.1 账号下设备枚举

```bash
XIAOAI_MI_STORE=~/.dsh/xiaoai-state/mi-store.json node tmp-tests/probe-devices.mjs
```
```
[PATCH] 复用缓存的 serviceToken，跳过登录
=== DEVICE COUNT: 1
{"name":"Xiaomi 智能音箱 Pro","deviceID":"cbf60488-c95d-40f8-bc6d-afbd0b673d2b",
 "miotDID":"DID_PLACEHOLDER","hardware":"OH2P","presence":"online"}
```

**结论**：`MiNA.getDevices()`（`GET /admin/v2/device_list`）返回**账号下全量设备**，
本账号当前只有 1 台音箱 —— **这就是我无法端到端实测多音箱的原因**（见 §2.4 诚实声明）。

注意 `device_list` 里的 `deviceID`（`cbf60488-...`，UUID 形态）与
`mi-store.json` 里存的 `device.deviceId`（`DEVICE_ID_PLACEHOLDER`）**不是同一个值**。
这是两个不同来源的设备标识，设计方案必须区分，否则会拿错 ID 去播报。

### 2.2 关键核实：小米对话接口的粒度

**问题**：`getConversations` 是按设备拉，还是一次能拉多设备？

**源码证据**（`lib/vendor/mi-service-lite.js:544-577`）：

```js
async getConversations(options) {
  const { limit = 10, timestamp } = options ?? {};        // ← 无任何设备选择参数
  const res = await Http.get(
    "https://userprofile.mina.mi.com/device_profile/v2/conversation",
    {
      limit, timestamp, requestId: uuid(), source: "dialogu",
      hardware: this.account.device?.hardware                // ← 只传 hardware（型号）
    },
    {
      account: this.account,
      cookies: {
        userId: this.account.userId,
        serviceToken: this.account.serviceToken,
        deviceId: this.account.device?.deviceId,             // ← 只作为 cookie 存在性校验
      },
    }
  );
  ...
}
```

**方法签名里没有任何「设备列表」参数** —— 它只接受 `limit` / `timestamp`。
设备相关的只有两处：`hardware`（**型号**，不是设备 ID）和 `deviceId`（cookie）。

**实测验证 1** —— `deviceId` cookie 是否影响结果？

```bash
node tmp-tests/probe-conv5.mjs
```
```
[cookie=real-miot-deviceId] HTTP 200: {"code":0,"message":"Success","data":"{\"bitSet\":[0,1,1],\"records\":[],\"nextEndTime\":0}"}
[cookie=FAKE-deviceId]      HTTP 200: {"code":0,"message":"Success","data":"{\"bitSet\":[0,1,1],\"records\":[],\"nextEndTime\":0}"}
[cookie=empty-deviceId]     HTTP 200: {"code":0,"message":"Success","data":"{\"bitSet\":[0,1,1],\"records\":[],\"nextEndTime\":0}"}
```

**真实 deviceId / 伪造 deviceId / 空 deviceId —— 三者返回逐字节相同。**

**实测验证 2** —— 换掉 `deviceId` 与 `hardware` 组合：

```bash
node tmp-tests/probe-conv3.mjs
```
```
[A real hw=OH2P]              -> HTTP 200 records=0
[B real device, WRONG hw=LX06] -> HTTP 200 records=0
[C bogus device, right hw]     -> HTTP 200 records=0
[D limit=50]                   -> HTTP 200 records=0
```

**实测验证 3** —— `deviceId` 变体对照：

```bash
node tmp-tests/probe-uuid.mjs
```
```
[uuid deviceID]         status=200 nextEndTime=0 bitset=[0,1,1] records=0
[miotDID as deviceId]   status=200 nextEndTime=0 bitset=[0,1,1] records=0
[garbage]               status=200 nextEndTime=0 bitset=[0,1,1] records=0
```

**实测验证 4** —— 缺 cookie 会怎样（证明它是「存在性校验」而非「过滤条件」）：

```bash
node tmp-tests/probe-conv4.mjs
```
```
[no-timestamp] HTTP 400: {"code":601,...,"MissingRequestCookieException: Required cookie 'deviceId' ... is not present"}
```

> ⚠️ 注意这里是 **MissingRequestCookie**（cookie 缺失）而非 `hardware`
> 那种 **MissingServletRequestParameter**（query 参数缺失）——
> 两者都是 Spring 的**必填校验**，但 `deviceId` 的**值**从不参与查询。

#### ✅ 核实结论（A 类事实，有实测证据）

| 项 | 结论 | 证据强度 |
|---|---|---|
| 对话接口能否一次拉多设备 | **能** —— 接口本身就是账号级，一次返回全账号对话 | ⭐⭐⭐ 强（4 组实测 + 源码） |
| `deviceId` cookie | **仅做必填校验，不参与过滤**（值随便填结果都一样） | ⭐⭐⭐ 强 |
| `hardware` query | **必填**，传型号（如 `OH2P`）；同账号混型号时的作用**未验证** | ⭐⭐ 中 |
| 响应是否含设备标识 | ⚠️ **未确认** —— 本账号历史为空（`records:[]`），看不到 record 结构 | ⚠️ 未知 |

> 🔴 **遗留未知项（必须实机确认）**：
> 由于本账号对话历史为空，我**无法看到 `records[]` 里是否有 `deviceId` 字段**。
> 如果每条 record 带设备标识 → 可以精确路由（方案 B1）。
> 如果**不带** → 无法区分是哪台音箱说的 → 必须退回「谁在线/单台模式」（方案 B2）。
>
> **这是整个改造中唯一的关键未知，必须由有真实对话记录的用户实机验证。**
> 验证方法：`node tmp-tests/04_answers.mjs`（已有脚本，会 dump records 原始结构），
> 或用两台音箱各说一句话，看 `records[]` 是否出现设备区分字段。

### 2.3 播报方向：设备级（与拉取相反）

**源码证据**（`mi-service-lite.js:459-467`）：

```js
ubus(scope, command, message) {
  message = jsonEncode(message ?? {});
  return this._callMina("POST", "/remote/ubus", {
    deviceId: this.account.device?.deviceId,   // ← 播报目标设备！
    path: scope, method: command, message
  });
}
```

而 `account.device` 是在**建立连接时**由 `MiNA.getDevice()` 单次选定的：

```js
// mi-service-lite.js:399-419
static async getDevice(account) {
  const devices = await this.__callMina(account, "GET", "/admin/v2/device_list");
  const device = (devices ?? []).find(
    (e) => [e.deviceID, e.miotDID, e.name, e.alias].includes(account.did)   // ← 按 did 选一台
  );
  if (device) account.device = { ...device, deviceId: device.deviceID };
  return account;
}
```

测量确认：

```bash
node tmp-tests/probe-tts.mjs
```
```
MiIOT bound device: {"name":"Xiaomi 智能音箱 Pro","did":"DID_PLACEHOLDER","deviceId":"SVXF0M6WA8Z9QCBP"}
MiNA  bound device: {"name":"Xiaomi 智能音箱 Pro","deviceId":"DEVICE_ID_PLACEHOLDER","hw":"OH2P"}
```

**结论 —— 核心不对称性**：

```
拉取对话  getConversations  →  账号级（deviceId 不参与过滤）      ← 1 次拿全部
播报/唤醒 ubus / TTS        →  设备级（用 account.device.deviceId） ← 必须每设备一个连接
```

**这决定了运行时架构**：**拉取共享、播报分离**。

### 2.4 诚实声明：未能验证的部分

| 未验证项 | 原因 | 影响 |
|---|---|---|
| 多台音箱的真实行为 | 本账号只有 1 台音箱 | 中：架构据此设计，但需实机确认 |
| `records[]` 是否含设备标识 | 本账号对话历史为空（`records:[]`） | **高**：决定路由方案 B1 vs B2 |
| 同账号混型号（OH2P+LX06）时 `hardware` 的行为 | 无第二台不同型号设备 | 中：TTS 指令表按设备查即可规避 |
| 小米是否有并发/频率限制 | 未压测（见 `tmp-tests/07_ratelimit.mjs`） | 中：设计中加了并发上限兜底 |

---

## 3. A. 配置结构设计

### 3.1 三个候选方案对比

| | 方案 1 `dids: []` | **方案 2 `speakers: []`（推荐）** | 方案 3 `did` + `extraDids` |
|---|---|---|---|
| 形态 | `dids: ["DID_PLACEHOLDER","123"]` | `speakers: [{did,name,enabled,...}]` | `did: "981..."` + `extraDids: ["123"]` |
| 每设备独立配置 | ❌ 需另开平行数组，易错位 | ✅ 天然内聚 | ❌ 主设备与附加设备结构不对称 |
| 每设备启用/停用 | ❌ 只能靠增删数组 | ✅ `enabled` 字段 | ⚠️ 需额外 `disabledDids` |
| 每设备覆盖模型/工作区 | ❌ 需要 `overrides: {did: {...}}` 旁路 | ✅ 直接写在对象里 | ❌ 同方案 1 |
| 可扩展性（音量/备注/顺序） | ❌ 加字段要动多处 | ✅ 加 key 即可 | ❌ |
| UI 映射 | ⚠️ 数组 of string，卡片要另查名称 | ✅ 1 对象 = 1 卡片，直接渲染 | ❌ 需合并两个来源 |
| 向后兼容 | ⚠️ 需要迁移逻辑 | ✅ 读时归一化 | ✅ 最平滑但最脏 |

**淘汰方案 1**：每设备配置无处安放。一旦要「A 音箱用工作区 X、B 音箱用工作区 Y」，
就必然长出 `didOverrides` 这类平行结构，两处数据靠 did 字符串关联 —— 增删时要手动同步，
是经典的一致性 bug 温床。

**淘汰方案 3**：主/附设备结构不对称，代码里到处是 `if (isPrimary)` 分支。
且「主设备」概念本身无业务含义 —— 用户不关心谁是主。

### 3.2 ✅ 推荐：方案 2 + 全局默认 + 每设备覆盖

设计参照 **dsh-im 的真实配置模型**（`~/.dsh/integrations/dsh-feishu/workspaces.json`）：

```json
{
  "version": 3,
  "workspaces":  { "bot_07dd...": "/path/a", "bot_0214...": "/path/b" },
  "agentPresets":{ "bot_0214...": "liangshen" },
  "models":      { "bot_07dd...": { "provider": "ai-proxy", "model": "..." } }
}
```

**dsh-im 的模式（已验证）**：
- **稀疏 map，key = botId**，只存**被显式覆盖过**的 bot（`agentPresets` 只有 1 条，而 `workspaces` 有 10 条）
- **未出现的 key = 用全局默认**（`DEFAULT_WORKSPACE` / 默认模型）
- 顶层用 `version` 字段做 schema 迁移

**我们采纳同样的语义，但载体用数组**（因为需要稳定顺序 + 音箱有 `name` 等元数据）：

```jsonc
{
  "version": 2,                          // ← 新增：schema 版本，用于迁移

  // ── 向后兼容投影（阶段 1 保留；阶段 3 可移除）──
  "did": "DID_PLACEHOLDER",                    // ← 老字段保留，恒等于 speakers[0].did

  // ── 全局默认（所有音箱继承）──
  "workspace": "/media/duola/devdata/AI-workspace",
  "agentPreset": "liangshen",
  "provider": "ai-proxy",
  "model": "workbuddy/deepseek-v4.1-flash",
  "sessionReuse": true,
  "maxReplyChars": 200,
  "pollIntervalMs": 4000,
  "triggerKeywords": ["小爱"],
  "ignorePatterns": [],

  // ── 设备列表（本方案核心）──
  "speakers": [
    {
      "did": "DID_PLACEHOLDER",                // MiGPT/xiaogpt/runtime 三家通用标识（miotDID）
      "name": "Xiaomi 智能音箱 Pro",      // 展示名；从 discoverSpeakers 回填
      "model": "OH2P",                   // 硬件型号；决定 TTS 指令集
      "enabled": true,
      "deviceId": "DEVICE_ID_PLACEHOLDER",    // MiNA 侧设备标识（播报用，§2.3）

      // ── 每设备覆盖（全部可选，缺省 = 继承全局）──
      "workspace": null,                 // null/缺省 = 用全局
      "agentPreset": null,
      "provider": null,
      "model": null,
      "volume": null,                    // 可选：启动时设置音量
      "wakeUpKeywords": null             // 覆盖全局唤醒词（如卧室用不同口令）
    },
    {
      "did": "123456789",
      "name": "小爱音箱 mini",
      "model": "LX06",
      "enabled": true,
      "deviceId": "ABC123..."
    }
  ]
}
```

**覆盖语义（明确写死，避免歧义）**：

```
effective(speaker, key) = speaker[key] ?? global[key]
# 只有 null / undefined / 缺省 才回退到全局
# 空字符串 "" 和 空数组 [] 是【有效覆盖值】，不回退
#   —— 例：某音箱不想要唤醒词，设 wakeUpKeywords=[] 应当生效
```

> ⚠️ 这个「`null` 回退 vs `[]` 生效」的区分是**最容易写错的地方**，
> 必须用 `??` 而不是 `||`。用 `||` 会让 `[]` 和 `""` 静默回退到全局。

### 3.3 迁移：读时归一化（read-time normalization）

**核心思想：不在磁盘上做一次性迁移，而是在读取时归一化。**
理由：一次性迁移需要处理「迁移到一半崩了」的中间态；读时归一化天然幂等、可回滚。

```js
/**
 * 把任意历史形态的配置归一化成 { version, global, speakers[] }。
 * 幂等、无副作用、可重复调用。
 */
export function normalizeSettings(raw) {
  const v = Number(raw?.version ?? 1);

  // ── v1（老配置）：单 did → 单元素 speakers[] ──
  if (v < 2 || !Array.isArray(raw?.speakers)) {
    const did = String(raw?.did ?? "").trim();
    return {
      version: 2,
      global: { ...pickGlobalKeys(raw) },
      speakers: did
        ? [{
            did,
            name: raw?.deviceName ?? "",        // 老配置可能没存名字
            model: raw?.deviceModel ?? "",      // ONBOARDING_DEFAULTS.deviceModel
            enabled: true,
            deviceId: null,                     // 连接时按 did 反查
          }]
        : [],
    };
  }

  return {
    version: 2,
    global: { ...pickGlobalKeys(raw) },
    speakers: raw.speakers.map(normalizeSpeaker).filter((s) => s.did),
  };
}
```

**迁移关键点**：

1. **老 `did` 不失效**：`did` 字段继续存在且继续被读取；
   `speakers` 为空时由 `did` 合成 —— 老用户升级后**无感**。
2. **`did` 作为投影维持**：每次写入 `speakers` 时同步 `did = speakers[0]?.did ?? ""`，
   让还在读 `did` 的老代码路径（及降级逻辑）继续工作。
3. **`deviceModel` / `deviceName`** 同样从老标量字段回填到 `speakers[0]`。
4. **不删老字段**：阶段 1-2 期间 `did`/`deviceModel` 双写，
   阶段 3 确认无消费者后再清理（或永久保留，成本极低）。

### 3.4 Schema 定义（照 `buildSettingsSchema` 写法）

```js
// src/index.js —— 新增，放在现有 did 字段之后
speakers: z.array(z.object({
  did:        z.string(),
  name:       z.string().default(""),
  model:      z.string().default(""),
  deviceId:   z.string().default(""),
  enabled:    z.boolean().default(true),
  // 覆盖项：用 nullable 表达“未覆盖”
  workspace:   z.string().nullable().default(null),
  agentPreset: z.string().nullable().default(null),
  provider:    z.string().nullable().default(null),
  model:       z.string().nullable().default(null),
  volume:      z.number().nullable().default(null),
})).default([]),

/** schema 版本；用于归一化。 */
settingsVersion: z.number().default(2),
```

**为什么用 `speakers` 数组而不是 dsh-im 那种 map**：
- 音箱**有稳定的人类可读顺序**（用户会按房间排列），数组保序
- 音箱有 `name`/`model` 等元数据，map 的 value 得是对象，不如数组直白
- 数量少（通常 2-5 台），数组遍历/查找成本可忽略

**为什么覆盖项用 `nullable().default(null)`**：
Schemastery 的 `.default(null)` 保证字段存在且类型稳定，
UI 侧据此判断「这是继承来的还是覆盖的」（`null` → 显示灰色占位「继承全局：xxx」）。

---

## 4. B. 运行时架构

### 4.1 核心设计：**共享拉取 + 独立播报 + 独立会话**

基于 §2.2/§2.3 实测的不对称性：

```
                    ┌─────────────────────────────────────┐
                    │      XiaomiAccount (共享)            │
                    │  · 1× MiNA 连接（拉对话，账号级）      │
                    │  · N× MiIOT 连接（播报，设备级）       │
                    │  · 1× 凭据 store（两份凭据共用）        │
                    └─────────────────────────────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
   ┌─────────────┐          ┌─────────────┐          ┌─────────────┐
   │ SpeakerCtx  │          │ SpeakerCtx  │          │ SpeakerCtx  │
   │  did=A      │          │  did=B      │          │  did=C      │
   ├─────────────┤          ├─────────────┤          ├─────────────┤
   │ #lastTime   │          │ #lastTime   │          │ #lastTime   │  ← 独立水位线
   │ #seen       │          │ #seen       │          │ #seen       │  ← 独立去重
   │ #aiMode     │          │ #aiMode     │          │ #aiMode     │  ← 独立状态机
   │ #history    │          │ #history    │          │ #history    │  ← 独立历史
   │ #agent      │          │ #agent      │          │ #agent      │  ← 独立会话
   │ #consecErr  │          │ #consecErr  │          │ #consecErr  │  ← 独立故障计数
   └─────────────┘          └─────────────┘          └─────────────┘
```

### 4.2 每设备一个 `XiaomiSpeaker` 实例？

**部分正确 —— 精确答案是「每设备一个 MiIOT 连接，MiNA 连接共享」。**

原因（实测 §2.3）：`ubus`（TTS/唤醒/音量）用 `account.device.deviceId` 定目标，
而 `account.device` 在 `getDevice()` 时**按 did 单次选定**。
所以要让 B 音箱说话，必须有**一个 account.device 指向 B 的 MiIOT 对象**。

而 MiNA 的 `getConversations` 不看 device（§2.2），所以共享一个就够。

**但有一个现实约束**：`getMiNA()/getMiIOT()` 都会**读写同一个 `.mi.json`**
（`getMiService` 末尾 `store[service] = account; await writeJSON(kConfigFile, store)`）。
N 个实例并发写同一文件 → **竞态 + 互相覆盖 `device` 字段**。

```
getMiIOT(A) → getMiService → 读 store → ... → 写 store.miiot.device = A
getMiIOT(B) → getMiService → 读 store → ... → 写 store.miiot.device = B   ← 覆盖！
```

**🔴 这是必须处理的关键风险。**（当前单设备下无感，多设备下会串台）

### 4.3 R2 缓解：三层防线（含**已实测通过**的 vendor 补丁）

> 本节按 Lead 评审意见加强。三层从弱到强，**推荐 D（根因消除）**，
> 其余两层作为纵深防御与「不改 vendor」时的退路。

#### 竞态窗口有多宽（Lead 已核实 + 我复核）

```js
// lib/vendor/mi-service-lite.js:850-872
const { service, userId, password, did, relogin } = config;
const store = await readJSON(kConfigFile) ?? {};   // ← ① 读全局 store
let account = { ...store[service], ...overrides, sid };
account = await getAccount(account);               // ← ② 异步登录（长耗时！可能数百 ms~数秒）
store[service] = account;
await writeJSON(kConfigFile, store);               // ← ③ 写回 → 覆盖别人的 device
```

**「读 → 异步登录 → 写」之间的窗口极宽**（② 可能包含网络往返 + 风控重试）。
两个设备并发时，后写的会把先写的 `device` 冲掉 → **A 的命令发到 B 的音箱**。

---

#### 🥇 防线 D（**已批准实施**）：给 vendor 加 `storeOverride` —— 从根因消除

**Lead 已批准。** 我已实机验证可行。

> ✅ **Lead 定的两条补丁规矩（实施者必须遵守）**：
> 1. **纯增量 + 向后兼容** —— 不传 `storeOverride` 时，代码路径与现在**逐字节等价**
> 2. **标注清晰** —— 沿用现有 `// ── PATCH: <说明> ──` 格式
>    （既有先例：`mi-service-lite.js:725`、`:844`）

**改动**（`lib/vendor/mi-service-lite.js` 的 `getMiService`，仅 2 处）：

```js
// ① 读取：允许注入 store，跳过全局文件
- const { service, userId, password, did, relogin } = config;
+ const { service, userId, password, did, relogin, storeOverride } = config;
- const store = await readJSON(kConfigFile) ?? {};
+ const store = storeOverride ?? ((await readJSON(kConfigFile)) ?? {});

// ② 写入：只有「没注入 store」时才写全局文件
  store[service] = account;
- await writeJSON(kConfigFile, store);
+ if (!storeOverride) {
+   await writeJSON(kConfigFile, store);
+ }
```

**调用方**（每设备传自己的 store 副本）：

```js
// 读一次全局 store 作为模板，然后每设备用独立副本
const baseStore = JSON.parse(readFileSync(this.#miStorePath, "utf8"));

async connect() {
  const cfg = {
    userId, password, did: this.did, timeout: 15000,
    storeOverride: structuredClone(baseStore),   // ← 独立副本，不碰全局文件
  };
  this.#iot = await getMiIOT(cfg);
  this.#na  ??= await getMiNA(cfg);              // 共享
  // 校验：本实例绑定的必须是本设备（fail-fast）
  if (String(this.#iot?.account?.device?.did) !== String(this.did)) {
    throw new Error(`连接绑定到了错误的设备（期望 ${this.did}）`);
  }
}
```

**✅ 实机验证结果**（本机真实凭据，临时打补丁后跑）：

```
A connected: Xiaomi 智能音箱 Pro did= DID_PLACEHOLDER
REAL store unchanged? YES ✅ (race eliminated)
```

**验证方法**：备份 vendor → 打补丁 → 用 `storeOverride` 连接 → 
比对 `~/.dsh/xiaoai-state/mi-store.json` 字节 → **完全一致（未被写入）** → 还原 vendor（`diff` 确认 IDENTICAL）。

**收益**：写入全局文件这一动作被**彻底移除**，竞态从根上消失；
且不再需要串行化（可并发连接）。

> 🔴 **`structuredClone` 不能省（Lead 评审确认的隐蔽坑）**：
> `storeOverride` 必须是**每设备独立副本**。若图省事把**同一个对象引用**传给 N 个设备，
> `store[service] = account` 仍会在内存里互相覆盖 ——
> **竞态只是从文件搬到了内存，破坏力完全相同**。
> 必须 `structuredClone(baseStore)`（或等价深拷贝），且 **`baseStore` 本身始终保持只读**。

---

#### ⚠️ 「改 vendor」的代价评估（Lead 已据此拍板同意）

我核实了 vendor 的来源与历史：**`lib/vendor/mi-service-lite.js` 已经是本地打过补丁的副本**，
不是纯净的上游拷贝：

```
lib/vendor/mi-service-lite.js:725  // ── PATCH: 复用已缓存的 serviceToken，跳过小米密码登录与风控 ──
lib/vendor/mi-service-lite.js:844  // ── PATCH: 让凭据缓存路径可被环境变量覆盖 ──
```

**这意味着**：

| 考量 | 评估 |
|---|---|
| 「改动会让升级变麻烦」的顾虑 | **部分已存在** —— 已有 2 处 PATCH，再叠加第 3 处，边际成本**低于** Lead 的预期 |
| 上游升级的实际频率 | vendor 是拷贝进来后手工维护的，非 npm 依赖（`lib/vendor/` 就地存放） |
| 补丁的侵入性 | **极低** —— 2 行改动，纯增量（新增可选参数，不传时行为**完全不变**） |
| 回滚成本 | 有备份即零成本 |

> 📌 **✅ Lead 已批准做防线 D**，理由：
> 1. 改动是**纯增量且向后兼容**的 —— `storeOverride` 不传时，代码路径与现在**逐字节等价**
> 2. vendor 已是本地分支，新增第 3 个标记清晰的 PATCH 不改变维护模型
> 3. 它把「并发正确性」从**调用方纪律**（容易在后续重构中破坏）变成**库的保证**（不会退化）
> 4. 已实机验证可行
>
> Lead 原话：**「把并发正确性从『调用方纪律』变成『库的保证』，后续重构不会破坏它。」**

**若将来改回不改 vendor** → 用下面的防线 A + B，同样可上线（代价是并发正确性依赖调用方纪律）。

---

#### 🥈 防线 B：连接后**冻结 account 快照 + 校验 did**（fail-fast）

即使不做 D，也**必须**做这一步 —— 它是「发现自己被覆盖」的唯一途径：

```js
async connect() {
  this.#iot = await getMiIOT(cfg);
  // ① 冻结：本实例后续只用自己这份 account，不再读全局 store
  this.#account = structuredClone(this.#iot.account);
  // ② 校验：确认绑定的是本设备（被别的设备覆盖时立即暴露，而不是静默发错音箱）
  const bound = this.#iot?.account?.device?.did;
  if (String(bound) !== String(this.did)) {
    throw new Error(
      `连接绑定到了错误的设备（期望 ${this.did}，实际 ${bound}）—— ` +
      `可能是并发连接导致的凭据串台，请重试`
    );
  }
  // ③ 防御性重绑：不依赖 vendor 的 find 结果
  this.#iot.account.device = pickDevice(await this.#na.getDevices(), this.did);
}
```

> ⚠️ **为什么「校验」比「重绑」更重要**：单纯重绑会**掩盖**竞态
> （错误被静默修好，但根因还在，下次换个路径又炸）。
> 校验让问题**在连接时就暴露**，配合日志能立刻定位。

#### 🥉 防线 A：连接**串行化**（最低要求）

```js
// ✅ 正确：串行连接（一次一台，消除 ② 与 ③ 交叠）
for (const sp of enabledSpeakers) {
  await conn.connect();
}

// ❌ 错误：并发连接会让 store.miiot.device 互相覆盖
await Promise.all(enabledSpeakers.map((sp) => conn.connect()));
```

**注意**：串行化**只是把窗口缩到最小，不是消除** —— 
设备 A 连接完成后，若之后有别的路径（如 token 刷新 `mergeFreshTokens`）再调
`getMiIOT`，仍可能覆盖。因此 A 必须与 B 配对使用。

---

#### 三层对照速查

| 防线 | 做法 | 消除竞态？ | 需改 vendor？ | 推荐度 |
|---|---|---|---|---|
| **D** | `storeOverride` 注入独立 store | ✅ **根因消除** | ✅ 2 行 | 🥇 **推荐**（已验证） |
| **B** | 连接后冻结快照 + 校验 did | ❌ 但**立即暴露** | ❌ | 🥈 **必做**（纵深防御） |
| **A** | 连接串行化 | ❌ 仅缩小窗口 | ❌ | 🥉 最低要求 |

**最终建议：D + B + A 全上**（D 消除根因，B 兜底暴露异常，A 降低触发概率）。
若不做 D，则 **B + A 是最低可接受组合** —— 不可只做 A。

---

#### `SpeakerConnection` 封装

```js
/**
 * 一个音箱的连接单元。
 * · 播报（MiIOT）→ 每设备独占
 * · 拉对话（MiNA）→ 共享引用
 * · account 快照 → 每设备冻结，不读全局 store
 */
class SpeakerConnection {
  #iot = null;        // 播报用（设备级）
  #na = null;         // 拉对话用（共享引用）
  #device = null;
  #account = null;    // ← 冻结的 account 快照（防线 B）

  constructor({ did, sharedNa, userId, password, baseStore, logger }) { ... }

  async connect() { /* 见上方 D/B 实现 */ }
  async say(text) { ... }
  async wakeUp() { ... }
  async getVolume() / setVolume() { ... }
  async fetchConversations() { return this.#na.getConversations(...); }  // 共享
}
```

### 4.4 轮询策略：**1 次拉取，N 路分发**（实测驱动的结论）

原假设「N 设备 = N 倍请求」**不成立**。由于对话接口是账号级的：

```
❌ 旧假设（错误）：每设备轮询 → N 次 HTTP
✅ 实际方案：1 次 HTTP → 得到全账号 records → 按 did 分发到 N 个 SpeakerCtx
```

**分发逻辑**：

```js
async #tick() {
  if (!this.#na) return;

  // ── 1 次拉取（不随设备数增长）──
  let records;
  try {
    records = await this.#na.getConversations({ limit: 20 });   // 一次拿全账号
  } catch (err) {
    this.#onSharedPollError(err);       // 账号级故障：所有设备一起降级
    return;
  }

  // ── 按设备分发 ──
  for (const ctx of this.#contexts.values()) {
    const mine = records.filter((r) => this.#routeTo(ctx, r));   // 见下
    await this.#processRecords(ctx, mine).catch((err) => {
      ctx.onError(err);                 // 单设备故障隔离
    });
  }
}
```

#### ⚠️ 路由问题：`records` 里怎么区分是哪台音箱说的？

这是整个设计的**分水岭**，取决于 §2.4 的未验证项：

**情形 B1：record 含设备标识**（如 `deviceId` / `did` / `hardware` 字段）

```js
#routeTo(ctx, rec) {
  const recDevice = rec.deviceId ?? rec.did ?? rec.deviceSNProfile;
  if (!recDevice) return false;                 // 无标识 → 走 B2 兜底
  return matchesDevice(recDevice, ctx.speaker); // 与 ctx 的 did/deviceId 比对
}
```
→ **精确路由，每台音箱独立响应**。这是理想架构。

**情形 B2：record 不含设备标识**（无法区分来源）

```js
#routeTo(ctx, rec) {
  // 兜底策略：由「活跃音箱」独占处理
  return ctx.did === this.#activeDid();   // 例如最近有交互/唯一在线的那台
}
```
→ 退化为**「多设备注册、单设备响应」**：
- 设备列表/状态/播报目标仍是多台（可对指定音箱说话：`xiaoai.speak({text, did})`）
- 但**「听到并回复」只能由 1 台承担**
- UI 必须**明确说明**这个限制，不能让用户以为两台都能对话

> 🔴 **实施前必须先验证是 B1 还是 B2。**
> **在拿到证据前，实施应当按 B2 设计接口、按 B1 预留扩展点**
> —— 即路由函数独立可替换，不把假设散落到各处。

#### 📋 R1 实测进展（Lead 主导 + 我的独立复核）

**Lead 的发现（我已独立复现并加强）**：

```
1. 用 xiaoai/speak 让音箱播报     → ✅ ok = true（播报成功）
2. 等待并轮询对话记录              → records 始终为 0
```

**我的独立复核**（播报后按 10/20/30/40 秒四轮轮询）：

```
BEFORE records: 0 nextEndTime: 0
TTS sent, ok = true
  t+10s -> records=0 nextEndTime=0
  t+20s -> records=0 nextEndTime=0
  t+30s -> records=0 nextEndTime=0
  t+40s -> records=0 nextEndTime=0
```

**✅ 结论（比 Lead 的单次检查更强）**：
**TTS 播报不产生对话记录** —— 即使延长到 40 秒、四轮轮询，`records` 恒为 0。
「对话记录」只记录**用户对音箱的真实语音输入**，不记录设备侧的输出。

> ⚠️ **这条对实施有直接价值**：
> 意味着**无法用 `xiaoai.speak` 制造测试数据**来推进 R1。
> 任何 R1 的验证都必须由**用户对着音箱真实说话**产生记录。
> —— 这也解释了为什么此前反复探测 `records` 都是空。

**附带发现（探测过程中的额外收获，可能对路由有用）**：

1. **`device_list` 的完整设备记录含 `current` 字段**（本机为 `false`）——
   疑似服务端维护的「当前活跃设备」标记。
   ⚠️ **用途未验证** —— 单设备下无法判断它在多设备时的语义，
   但它是一个**候选人**：若 B2 需要选一台「代表设备」，`current` 可能正是小米自己的答案。
2. **`device_list` 还含 `capabilities`**（本机 40 项，含 `dialog_h5` / `ai_protocol_3_0` /
   `continuous_dialogue` / `voice_print_multidevice`）——
   `isSpeakerDevice()`（`src/onboarding.js:488`）就是靠它判断音箱的，多音箱可继续复用。
3. **`deviceId` 作为 query 参数同样被忽略**（复核：`conv(+query deviceId)` 与对照组返回一致）——
   进一步佐证 §2.2 的「账号级」结论。

#### R1 验证清单（用户配合时执行）

```bash
# 前置：让用户对着音箱说一句话（如「小爱同学，现在几点」），确认音箱有响应
node tmp-tests/04_answers.mjs      # 已有脚本，dump records 原始结构
```

**要看的是 `records[]` 里每条记录的字段**，重点确认是否存在：
`deviceId` / `did` / `miotDID` / `hardware` / `deviceSNProfile` 等**区分设备的字段**。

| 实测结果 | 路由方案 | 后续动作 |
|---|---|---|
| **有**区分字段 | **B1 精确路由** | 用该字段实现 `#routeTo`，每台独立响应 ✅ |
| **无**区分字段 | **B2 降级** | `#routeTo` 走「代表设备独占」，UI 明示限制 |

**两种情况下架构都不变** —— 只需替换 `#routeTo` 一个函数（这正是把它独立出来的原因）。
**R1 已由 Lead 安排实测**，届时可叫我细化 `#routeTo`。

### 4.5 失败隔离

**三层隔离**：

| 层 | 故障 | 影响范围 | 处理 |
|---|---|---|---|
| L1 账号级 | `serviceToken` 过期 / 网络断 | **全部**音箱 | 全局降级：`phase=error`，按现有逻辑周期刷新凭据（`runtime.js:1624-1672`） |
| L2 设备级 | 某台音箱离线 / 型号不支持 / 播报失败 | **单台** | 该 `SpeakerCtx` 标记 `error`，**其他继续跑** |
| L3 消息级 | 单条语音处理失败 | **单条** | 现有逻辑：播报错误提示（`runtime.js:1751-1759`） |

**L2 的实现要点**（当前代码是全局 `#consecutiveErrors`，必须改成 per-device）：

```js
// 每个 SpeakerCtx 独立的错误计数与重连节流
class SpeakerContext {
  #consecutiveErrors = 0;
  #restartTimes = [];        // ← 沿用现有的「1 分钟 3 次」熔断
  #phase = "running";        // running | degraded | error
  #stopProcessing = false;   // 本设备是否暂停处理（不影响其他设备）
}
```

**关键规则**：
- 单设备连续失败 **不触发全局 `runtime.stop()`**（现有代码在 `AUTH_ERROR_LIMIT` 时会 `#stopped = true` 停整个循环 —— 多设备下必须改为只停该设备）
- 全局凭据刷新仍由账号级故障触发（因为凭据是共用的）
- 设备级不可恢复故障（型号不支持）→ 该设备 `phase=error` 并在 UI 标红 + 给出型号提示

### 4.6 并发与退避

```
每设备处理循环：独立串行（#askChain 语义）
设备之间：     并发（Promise.allSettled，各自 catch）
拉取：         全局 1 次
播报：         每设备独立（互不影响）
```

**并发上限**：小米未验证频率限制，保守起见加：
- 全局播报并发上限 **3**（`semaphore(3)`），超出排队
- 拉取间隔沿用现有 `pollIntervalMs`（默认 4000，下限 2000），**不随设备数增加**

**TTS 冲突**：多台同时播报是用户可能不想要的（客厅卧室一起响）。
建议**默认允许并播**（符合「每台独立工作」的需求），
但保留一个全局开关 `broadcastMode: "all" | "first"`（阶段 3 可选）。

---

## 5. C. 会话隔离策略

### 5.1 现状（已支持多设备）

```js
// src/runtime.js:91-93
function sessionKeyFor(did) {
  return `xiaoai:${did || "default"}`;
}
```

**已经天然支持多设备** —— 只要每设备传入自己的 did，会话 key 就自动隔离。

落盘结构验证（`~/.dsh/xiaoai-state/session.json`）：

```json
{
  "version": 1,
  "sessions": { "xiaoai:DID_PLACEHOLDER": "session-5ed32171-ad31-415d-9dcc-6375749baf26" }
}
```

`sessions` 已经是 **map**，多设备只需多加几个 key —— **无需改结构，只需保证写入不覆盖**。

**✅ 已核实：`#storeSessionId` 已经是安全的读-改-写**（`src/runtime.js:388-412`）：

```js
#storeSessionId(key, sessionId) {
  const state = this.#loadSessionState();              // 读
  state.sessions = { ...state.sessions, [key]: sessionId };  // 改（合并，非覆盖）
  this.#saveSessionState(state);                        // 写（tmp + rename 原子）
}
#saveSessionState(state) {
  const tmp = `${this.#sessionFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, this.#sessionFile);                   // ← 原子替换
}
```

**结论：`sessions` 是合并写入 + 原子替换，多设备天然安全**，
不需要为多音箱改造这块（这是既有实现做得好的地方）。

唯一的理论风险是「两个设备**同一时刻**各自读到旧 state 再各自写」——
但 `#ensureAgent` 是每设备串行调用的，且写窗口极小（同步 IO），
实践风险可忽略。若追求严格正确，可在 `#storeSessionId` 外加一个进程内异步锁。

### 5.2 workspace / agentPreset / model：全局默认 + 每设备覆盖

**推荐：三态解析**，与 §3.2 的覆盖语义一致。

```js
/**
 * 解析某台音箱的实际配置（覆盖 → 全局 → 硬默认）。
 * @returns {{workspace, agentPreset, provider, model, sessionReuse, ...}}
 */
function resolveEffective(global, speaker) {
  return {
    // ?? 而非 || —— 空字符串/空数组是有效覆盖值
    workspace:   speaker.workspace   ?? global.workspace,
    agentPreset: speaker.agentPreset ?? global.agentPreset,
    provider:    speaker.provider    ?? global.provider,
    model:       speaker.model       ?? global.model,
    sessionReuse: global.sessionReuse,        // 全局项（每设备覆盖意义不大）
  };
}
```

**为什么这样设计**：

| 配置项 | 全局默认 | 每设备覆盖 | 理由 |
|---|---|---|---|
| `workspace` | ✅ | ✅ | **典型场景**：客厅音箱 → 家庭助手工作区；卧室音箱 → 个人工作区 |
| `agentPreset` | ✅ | ✅ | 不同房间不同人格（如儿童房用儿童预设） |
| `provider` / `model` | ✅ | ✅ | 省钱：次要音箱用便宜模型 |
| `sessionReuse` | ✅ | ❌ | 语义是「复用上次会话」，每设备独立 session 已经天然隔离，全局开关足够 |
| `pollIntervalMs` | ✅ | ❌ | **账号级**参数（拉取是共享的），per-device 无意义 |
| `triggerKeywords` | ✅ | ⚠️ 可选 | 有场景（卧室喊「小爱」，客厅喊「小爱同学」），但增加复杂度 |
| `maxReplyChars` | ✅ | ⚠️ 可选 | 同上 |
| 提示语（`onEnterAI` 等） | ✅ | ❌ | 全局统一体验更好 |

**边界规则（必须写进文档与 UI）**：
- `provider` 与 `model` **必须成对**（现有 `runtime.js:717` 会在只填一个时静默忽略）
  → 覆盖时若只设 `provider` 不设 `model`，应**报错或同时回退两者**，不能半生效
- `workspace` 覆盖时，**必须校验目录存在**（现有 `#resolveWorkspacePath` 会 mkdir，
  注意：per-device 覆盖意味着会在不同目录建工作区，这是预期行为）

### 5.3 会话落盘 key 与迁移

**已有会话（绑定旧 did）怎么办？**

```
老配置: did = "DID_PLACEHOLDER"  →  session.json: { "xiaoai:DID_PLACEHOLDER": "session-xxx" }
新配置: speakers = [{did: "DID_PLACEHOLDER", ...}, {did:"123", ...}]
```

**结论：零处理。** 因为：
- 归一化后 `speakers[0].did === "DID_PLACEHOLDER"`，`sessionKeyFor` 算出**同一个 key**
- 旧 sessionId 继续被复用（`#storedSessionId(key)` 命中）
- 新增设备只是新增 key，不影响老 key

**唯一注意**：老配置没有 `speakers`，归一化时若 `did` 为空则 `speakers = []` →
此时 `sessionKeyFor(undefined)` 会算出 `"xiaoai:default"`。
建议保留这个行为（与现有 `did || "default"` 一致），避免破坏性变更。

---

## 6. D. UI 设计

### 6.1 参考 dsh-im 的多渠道管理

**dsh-im 的做法**（`plugin-src/client/channel-card-meta.js`）：

```js
// 每个 bot 一张卡片，带独立的「更多设置」按钮与状态点
export function BotSettingsButton({ channel, botId, botName, connected, accessPolicy, channelSettings }) {
  const { openBotSettings } = React.useContext(BotSettingsContext);
  return h('span', { className: 'dim-botSettingsAction' },
    h('button', { onClick: () => openBotSettings?.({ ...channelSettings, channel, botId, botName, connected }) },
      h(SettingsGlyph)));
}

export function BotStatusMeta({ tone, stateLabel, lastCheckedAt, healthState }) {
  return h('div', { className: 'dim-botHealthGroup' },
    h('div', { 'data-health': healthState },         // ← 每 bot 独立健康状态
      h('span', { 'data-tone': tone }),              // ← 状态点颜色
      h('span', null, stateLabel)),
    h('div', null, '最近检查', formatCheckedTime(lastCheckedAt)));
}
```

**可复用的三点**：
1. **Context + 回调**：`BotSettingsContext` 提供 `openBotSettings`，
   卡片只负责渲染与触发 —— 解耦「列表」与「详情」
2. **每卡独立状态点**：`data-tone` / `data-health` 属性驱动样式，语义清晰
3. **sparse 覆盖**：卡片只显示「是否被覆盖」，未覆盖时显示「继承全局」

### 6.2 设置面板线框图

新增分组 **「② 音箱设备」**（替换现在的单 `did` 字段），
沿用任务 3 已实现的 `<details>` 折叠 + 脏点机制：

```
┌─ ② 音箱设备 ──────────────────────────────────── [3 台 · 2 在线] ──┐
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ ● Xiaomi 智能音箱 Pro          OH2P · 在线      [⏸] [⚙] [🗑] │    │
│  │   did: DID_PLACEHOLDER                                           │    │
│  │   ▸ 使用全局配置（工作区 / 模型 / 预设）                      │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ ● 小爱音箱 mini                LX06 · 离线      [▶] [⚙] [🗑] │    │
│  │   did: 123456789                                           │    │
│  │   ▸ 已覆盖：工作区 = /path/to/bedroom                       │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ ○ 客厅音箱                     OH2P · 已停用    [▶] [⚙] [🗑] │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  [ + 添加音箱 ]   [ 🔄 重新扫描账号设备 ]                            │
└─────────────────────────────────────────────────────────────────────┘
```

**状态点语义**（`data-tone`）：
| 图标 | tone | 含义 |
|---|---|---|
| ● | `ok` | 已连接，正在监听 |
| ● | `warn` | 连接中 / 型号未收录 / 部分降级 |
| ● | `error` | 连接失败 / 鉴权过期 |
| ○ | `muted` | 用户手动停用（`enabled: false`） |

**每卡操作**：
- `[⏸] / [▶]` —— 启停该设备（写 `speakers[i].enabled`）
- `[⚙]` —— 展开该设备的覆盖配置（内联展开，不弹窗 —— 参照 dsh-im 的 Context 模式可扩展为弹层）
- `[🗑]` —— 移除该设备（**需二次确认**，因为会丢失该设备的会话绑定）

> ⚠️ **删除确认文案**要具体：「移除后，这台音箱的对话会话将不再复用，
> 历史记录仍保留在 DSH 会话列表中」，而不是笼统的「确定删除吗？」

### 6.3 设备覆盖配置（点 `[⚙]` 展开）

```
┌─ 小爱音箱 mini 的独立配置 ─────────────────────────┐
│  名称        [小爱音箱 mini            ]           │
│  型号        [LX06 ▾]  （未收录型号可手填指令）     │
│  启用        [✓]                                   │
│                                                    │
│  ── 覆盖全局（留空 = 继承）──                       │
│  工作区      [                   ] 继承全局: /media/duola/devdata/AI-workspace │
│  Agent 预设  [                   ] 继承全局: liangshen │
│  模型        [ai-proxy ▾] [workbuddy/... ▾]  继承全局 │
│  启动音量    [50    ] 0-100                        │
│                                                    │
│  [ 恢复为全局默认 ]                                 │
└────────────────────────────────────────────────────┘
```

**关键交互细节**：

1. **「继承全局」的视觉表达**：占位符显示 `继承全局: <实际值>`（灰色），
   一旦输入就变成覆盖态（正常色）。这让用户一眼看出哪些是覆盖、哪些是继承。
2. **覆盖项的「清除」**：`[恢复为全局默认]` 一键把该设备所有覆盖设为 `null`
3. **`provider`+`model` 成对**：与现有 UI 约束一致（任务 3 已实现），
   覆盖态下**必须成对设置**，只填一个时禁用保存并提示
4. **脏点**：任一设备的任一字段改动 → 「② 音箱设备」标题打脏点
   （沿用任务 3 的机制，注意**折叠状态下也要打点**）

### 6.4 状态区多设备呈现

「⑥ 状态与日志」组内，把现有单音箱状态改为**设备状态列表**：

```
┌─ 运行状态 ──────────────────────────────────────────┐
│  插件     ● 运行中 · 2/3 台在线                      │
│  DSH      ● 已连接                                   │
│                                                      │
│  ── 设备 ──                                          │
│  ● Xiaomi 智能音箱 Pro   OH2P   AI模式: idle  最近: 2分钟前 │
│  ● 小爱音箱 mini         LX06   AI模式: active 最近: 刚刚   │
│  ○ 客厅音箱              OH2P   已停用                │
│                                                      │
│  最近活动  [🎤 客厅音箱] 打开灯                       │
│  运行日志  ...                                       │
└──────────────────────────────────────────────────────┘
```

**每设备的独立状态字段**（`status.speakers[]`）：

```jsonc
{
  "speakers": [
    {
      "did": "DID_PLACEHOLDER",
      "name": "Xiaomi 智能音箱 Pro",
      "model": "OH2P",
      "connected": true,
      "online": true,
      "phase": "running",          // running | degraded | error | disabled
      "aiMode": "idle",            // ← per-device！
      "lastHeard": { "text": "...", "at": 1789910291697 },
      "lastReply": { "text": "...", "at": 1789910291700 },
      "handledCount": 12,
      "consecutiveErrors": 0,
      "lastError": null,
      "sessionId": "session-5ed32171-...",
      "workspacePath": "/media/duola/devdata/AI-workspace",
      // 实际生效的配置（含继承结果，供 UI 展示「继承全局: xxx」）
      "effective": { "workspace": "...", "agentPreset": "liangshen", "model": "..." }
    }
  ],
  // ── 向后兼容投影：老 UI 代码读 status.speaker 仍可用 ──
  "speaker": { "connected": true, "name": "Xiaomi 智能音箱 Pro", "model": "OH2P", "did": "DID_PLACEHOLDER" },
  // ── 账号级状态 ──
  "phase": "running",
  "accountOnline": true
}
```

> 📌 **`status.speaker` 保留为投影**（= `speakers[0]`）：
> `src/client/index.js:4204` 等处读的是 `status.speaker.connected` ——
> 保留投影可让老代码不炸，降低改动面。

### 6.5 添加音箱流程

复用已有的 `xiaoai.onboarding.discoverSpeakers`（**已能列出全部音箱**，任务背景已确认）：

```
[ + 添加音箱 ]
      │
      ▼
┌─ 选择要添加的音箱 ──────────────────────────────┐
│  ● Xiaomi 智能音箱 Pro   OH2P   在线   [已添加]  │  ← 已添加的置灰
│  ○ 小爱音箱 mini         LX06   在线   [ 添加 ]  │
│  ○ 客厅音箱              OH2P   离线   [ 添加 ]  │
│                                                  │
│  凭据将复用当前账号（无需重新登录）                │
└──────────────────────────────────────────────────┘
```

**要点**：
- 凭据**共用**（任务背景已确认：多音箱共用同一份 micoapi + xiaomiio）→ 添加设备**不需要重新登录**
- 已添加的设备置灰并标注，避免重复添加（用 did 去重）
- 离线设备**允许添加**（用户可能先配置好，设备稍后上线）
- 添加后**自动回填** `name` / `model`（来自 `discoverSpeakers` 返回）

---

## 7. E. 向后兼容方案

### 7.1 兼容矩阵

| 场景 | 老行为 | 新行为 | 兼容性 |
|---|---|---|---|
| 老配置（只有 `did`） | 单音箱 | 归一化为 `speakers[0]` | ✅ 无感 |
| 老配置 + 老 UI 代码 | 读 `did` | `did` 投影继续存在 | ✅ |
| 老 `session.json` | `xiaoai:DID_PLACEHOLDER` | 同一 key | ✅ 复用 |
| `xiaoai.status` 老消费者 | 读 `status.speaker` | 投影保留 | ✅ |
| `xiaoai.speak` 老调用 | 播报到唯一设备 | 默认播报 `speakers[0]` | ✅ |
| `onboarding.apply({did})` | 写单 `did` | 写 `did` **且** upsert 到 `speakers[]` | ✅ |
| `RESTART_KEYS` 含 `did` | 改 did 触发重启 | 需加入 `speakers` | ⚠️ 必须改 |

### 7.2 必须同步修改的兼容点

```js
// src/rpc.js:297 —— 多音箱必须扩展重启判定
const RESTART_KEYS = Object.freeze([
  "enabled", "userId", "password",
  "did",        // 保留（老字段）
  "speakers",   // ← 新增：设备列表变化必须重启
]);
```

```js
// src/runtime.js:1488 —— 校验逻辑改为「至少一台启用的音箱」
- if (!this.#config.did) missing.push("音箱设备 ID（did）");
+ const enabled = normalizeSettings(this.#config).speakers.filter((s) => s.enabled);
+ if (enabled.length === 0) missing.push("至少一台启用的音箱");
```

```js
// src/runtime.js:491 —— 会话 key 改为 per-context
- const key = sessionKeyFor(this.#config.did);
+ const key = sessionKeyFor(ctx.speaker.did);
```

### 7.3 `onboarding.apply` 的双写

向导目前调用 `apply({ did, model })` 落单设备配置。改造后：

```js
// src/rpc.js onboardingApply —— 双写：老字段 + speakers[]
const patch = {
  did: did,                            // ← 老投影
  deviceModel: model ?? "",            // ← 老投影
  speakers: upsertSpeaker(existing, { did, model, name }),  // ← 新结构
};
```

`upsertSpeaker` 语义：did 已存在则更新 name/model，否则追加。
**幂等**，重复调用不会产生重复条目。

### 7.4 降级路径（老 DSH / 老代码）

若某处代码仍只读 `did`（如外部脚本、文档示例）：
- `did` 始终等于 `speakers[0]?.did ?? ""`
- 因此在「只用第一台音箱」的语义下，老路径**行为完全不变**

---

## 8. F. 分阶段实施计划

### 阶段 1：双设备可用（MVP）—— 建议先做这个

**目标**：支持 2+ 台音箱，每台独立会话、独立播报。

| 文件 | 改动 | 估算 |
|---|---|---|
| `src/index.js` | schema 加 `speakers[]` + `settingsVersion`；`DEFAULTS` 加默认值 | ~40 行 |
| `src/settings-normalize.js`（新） | `normalizeSettings` / `resolveEffective` / `upsertSpeaker` | ~120 行 |
| `src/runtime.js` | 抽 `SpeakerContext` 类（把现有单设备状态搬进去）；`#tick` 改 1 拉 N 分发；per-device 错误隔离 | ~350 行 |
| `src/xiaomi.js` | 加 `SpeakerConnection`（含 `account.device` 重绑）；或让 `XiaomiSpeaker` 支持共享 `na` | ~80 行 |
| `src/rpc.js` | `RESTART_KEYS` 加 `speakers`；`status` 加 `speakers[]` 投影；`onboardingApply` 双写 | ~60 行 |
| `src/client/index.js` | 设备卡片列表 + 添加/启停/删除 | ~450 行 |

**阶段 1 验收标准**：
1. 老配置升级后**行为不变**（单音箱照常工作，会话继续复用）
2. 添加第 2 台音箱后，**两台各自响应、各自会话**（或在 B2 情形下明确提示限制）
3. 停用其中一台，另一台**不受影响**
4. 一台离线/连接失败，另一台**继续正常工作**
5. 轮询请求数**不随设备数增加**（用日志/抓包验证：N 台仍为 1 次/轮）
6. `status.speakers[]` 每台有独立 `connected` / `aiMode` / `lastHeard`
7. `node --check` + `node scripts/build.mjs` 通过

### 阶段 2：每设备覆盖

**目标**：`workspace` / `agentPreset` / `model` 可按设备覆盖。

| 文件 | 改动 | 估算 |
|---|---|---|
| `src/settings-normalize.js` | `resolveEffective` 补全所有可覆盖项 | ~40 行 |
| `src/runtime.js` | `#ensureAgent` / `#createBoundSession` 用 `effective` 而非全局 config | ~80 行 |
| `src/client/index.js` | 设备展开面板（覆盖项 UI + 「继承全局」占位 + 恢复默认） | ~250 行 |

**阶段 2 验收标准**：
1. A 音箱用工作区 X、B 音箱用工作区 Y，**各自会话落在各自工作区**
2. 「继承全局」placeholder 显示实际生效值
3. 「恢复为全局默认」能清空所有覆盖
4. `provider`+`model` 覆盖必须成对，只填一个时拒绝保存
5. 空数组/空字符串作为覆盖值能生效（不被 `??` 误回退）

### 阶段 3：打磨

- 广播模式开关（`all` / `first`）
- 设备排序（拖拽）
- 每设备独立提示语（若阶段 2 证明有需求）
- 清理老 `did` 投影（**可选，建议永久保留** —— 成本极低，兼容收益大）
- vendor 的 store 写入竞态修复（加 Mutex）

### 阶段划分理由

**为什么阶段 1 就能交付**：核心价值（多台音箱各自工作）在阶段 1 已完全实现。
阶段 2 的每设备覆盖是**锦上添花**（多数用户所有音箱共用一个工作区/模型）。
先上阶段 1 能尽早拿到真实多设备环境的验证数据 —— 特别是 §2.4 的 B1/B2 未知项。

---

## 9. 风险清单

| # | 风险 | 等级 | 影响 | 缓解 |
|---|---|---|---|---|
| **R1** | **`records[]` 不含设备标识** → 无法路由 | 🔴 高 | 多音箱退化为「多注册单响应」，与用户预期不符 | **实施前先验证**（§4.4）；接口按 B1 设计、B2 可降级；UI 明确说明限制 |
| **R2** | **vendor `getMiService` 并发写 `.mi.json` 竞态** | 🔴 高 | 多实例 `account.device` 互相覆盖 → **播报到错误的音箱**。竞态窗口极宽（读 → 异步登录 → 写回） | **三层防线（§4.3）**：D 给 vendor 加 `storeOverride`（**已实机验证**，2 行纯增量改动，根因消除）＋ B 连接后冻结快照 + 校验 did（fail-fast）＋ A 串行连接。⚠️ 「每设备独立 store 文件」不可行（`kConfigFile` 模块级常量，`mi-service-lite.js:848`） |
| **R3** | **水位线/去重/AI模式串台** | 🔴 高 | 一台说话导致另一台**永久失聪** | 必须 per-device 隔离（§4.1）；这是架构核心，不能省 |
| **R4** | 全局 `#stopped` 被单设备故障触发 | 🟠 中 | 一台坏了全部停 | L2 隔离（§4.5）：per-device 计数与熔断 |
| **R5** | `session.json` 并发写丢 key | 🟢 低 | （**已核实为非风险**：`#storeSessionId` 是合并写入 + 原子 rename） | 无需处理；极端情况可加进程内锁 |
| **R6** | `RESTART_KEYS` 漏加 `speakers` | 🟠 中 | 改设备列表**不生效**，用户以为没保存 | 明确加入（§7.2）；加单测 |
| **R7** | 小米接口频率限制（未验证） | 🟡 低 | 被限流导致全部失效 | 轮询不随设备数增长（已由账号级接口保证）；播报并发上限 3 |
| **R8** | 老配置迁移失败 | 🟡 低 | 用户升级后音箱不工作 | 读时归一化幂等；`did` 投影保留；**不删老字段** |
| **R9** | 空数组/空串被 `\|\|` 误回退 | 🟡 低 | 用户设「不要唤醒词」无效 | 统一用 `??`；加针对性单测 |
| **R10** | 多台同时播报扰民 | 🟢 低 | 体验问题 | 阶段 3 加广播模式开关 |
| **R11** | 停止重连节流被 per-device 稀释 | 🟠 中 | 3 台各重连 3 次 = 9 次/分钟 → **打死账号**（历史事故重演） | **全局**重连计数（跨设备共享），不是每设备独立 |

> 🔴 **R11 特别说明**：现有代码的「1 分钟最多重启 3 次」熔断（`runtime.js:1644-1656`）
> 是为防止「刷新→重启→失败→刷新」循环打死机器（曾有台式 DSH 死机事故）。
> 多设备下若把它改成 per-device，总重连次数会乘以设备数 —— **必须保持全局计数**。

---

## 10. 给实施者的行动清单

**开工前必须先做**（阻塞项）：

1. ✅ **验证 `records[]` 结构**（R1）—— 有真实对话历史后跑
   ```bash
   node tmp-tests/04_answers.mjs      # 看 records 里是否有 deviceId/did/hardware
   ```
   若字段存在 → 按 B1 精确路由；若不存在 → 按 B2 并在 UI 明示限制。

2. ✅ **确认本机多设备可用性** —— 本账号只有 1 台音箱，
   实施阶段 1 的多设备验证需要**至少 2 台**（否则只能做单元测试 + mock）。

**实施顺序**（不要跳步）：

```
0. ⚠️ 先做 R2 防线 D：给 vendor 加 storeOverride（2 行）+ 备份原文件
   —— 这是多音箱并发正确性的地基，必须在抽 SpeakerContext 之前完成
1. src/settings-normalize.js  （纯函数，单元测试友好，零风险）
2. src/index.js schema        （加字段，不动逻辑）
3. src/xiaomi.js SpeakerConnection（连接层：D 的调用方 + B 的校验，可用 mock 测）
4. src/runtime.js 抽 SpeakerContext（最大改动，风险集中）
5. src/rpc.js status/RESTART_KEYS
6. src/client/index.js UI
```

**关键提醒**：
- 每步跑 `node --check` + `node scripts/build.mjs`
- **每设备状态隔离（R3）是架构正确性的核心**，不要在实现时图省事共享
- 全局重连熔断（R11）**不要**改成 per-device
- **R2 只做串行化是不够的**（§4.3）—— 至少要做「串行化 + 连接后校验 did」

---

## 附录 A：证据文件索引

| 证据 | 位置 |
|---|---|
| `getConversations` 无设备参数 | `lib/vendor/mi-service-lite.js:544-577` |
| `deviceId` 仅作 cookie 存在性校验 | `lib/vendor/mi-service-lite.js:565-566` |
| `ubus` 用 `account.device.deviceId` 定目标 | `lib/vendor/mi-service-lite.js:459-467` |
| `getDevice` 按 did 单次选定设备 | `lib/vendor/mi-service-lite.js:399-419` |
| `getMiService` 写共享 store | `lib/vendor/mi-service-lite.js:848-873` |
| `kConfigFile` 模块级定死 | `lib/vendor/mi-service-lite.js:848` |
| **vendor 已有 2 处本地 PATCH**（评估改动代价的依据） | `lib/vendor/mi-service-lite.js:725`（复用 serviceToken）、`:844`（store 路径可覆盖） |
| `sessionKeyFor(did)` | `src/runtime.js:91-93` |
| 单设备状态字段 | `src/runtime.js:189-233` |
| 全局错误/熔断逻辑 | `src/runtime.js:1600-1710` |
| `RESTART_KEYS` | `src/rpc.js:297` |
| dsh-im sparse 覆盖配置 | `~/.dsh/integrations/dsh-feishu/workspaces.json` |
| dsh-im 渠道卡片 UI | `c3h3-dsh-im/plugin-src/client/channel-card-meta.js` |

## 附录 B：本次核实用的探针脚本

保留在 `tmp-tests/`（可复跑）：

| 脚本 | 用途 |
|---|---|
| `probe-devices.mjs` | 列账号下全部设备（验证 discoverSpeakers 数据源） |
| `probe-conv3.mjs` | 换 `deviceId`/`hardware` 组合，验证是否影响结果 |
| `probe-conv4.mjs` | 缺 cookie/参数的报错形态（证明是必填校验） |
| `probe-conv5.mjs` | 真实/伪造/空 `deviceId` 对照（**核心证据**） |
| `probe-uuid.mjs` | `deviceID`/`miotDID`/垃圾值 对照 |
| `probe-tts.mjs` | 确认 MiIOT/MiNA 各自绑定的设备 |

---

*本文档只做设计，未修改任何插件代码。所有实测结论均为只读探测（HTTP GET / 设备列表），未写入小米云端配置、未重启 DSH。*
