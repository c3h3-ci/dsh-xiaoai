# dsh-xiaoai 设置面板重新规划（UI 重构设计）

> 目标：解决用户原话指出的两个问题 ——
> ①「对话，工作区，模型等等设置选择怎么都没有？」
> ②「界面布局也不够合理。」
>
> 本文只做设计，不含实现改动。所有结论都基于对本仓库与 DSH 官方包的实地阅读，引用处标注了文件与行号。

---

## 0. 现状核实（先纠正两个事实）

在动手设计前，我先核对了 `buildSettingsSchema`，有两处与任务书给的线索**不一致**，先说清楚，否则会照着一个错的清单写代码。

### 0.1 schema 实际字段数：38 个，UI 暴露 8 个 —— 这一点任务书是对的

`src/index.js:251-340` 的 `buildSettingsSchema` 实际定义（按出现顺序）：

| # | 字段 | 行号 |
|---|------|------|
| 1 | `enabled` | 254 |
| 2 | `userId` | 256 |
| 3 | `password` | 258 |
| 4 | `did` | 260 |
| 5 | `deviceModel` | 266 |
| 6 | `ttsCommand` | 268 |
| 7 | `wakeUpCommand` | 270 |
| 8 | `onboarded` | 272 |
| 9 | `pollIntervalMs` | 274 |
| 10 | `replyTimeoutMs` | 276 |
| 11 | `maxReplyChars` | 278 |
| 12 | `triggerKeywords` | 280 |
| 13 | `ignorePatterns` | 282 |
| 14 | `aiModeEnabled` | 285 |
| 15 | `callAIKeywords` | 287 |
| 16 | `wakeUpKeywords` | 289 |
| 17 | `exitKeywords` | 291 |
| 18 | `exitKeepAliveAfter` | 293 |
| 19 | `localCommandsEnabled` | 295 |
| 20 | `onEnterAI` | 297 |
| 21 | `onExitAI` | 299 |
| 22 | `onAIAsking` | 301 |
| 23 | `onAIReplied` | 303 |
| 24 | `onAIProgress` | 305 |
| 25 | `progressAfterSeconds` | 307 |
| 26 | `historyLimit` | 309 |
| 27 | `onAIError` | 311 |
| 28 | `onAIErrorNetwork` | 313 |
| 29 | `onAIErrorAuth` | 315 |
| 30 | `onAIErrorTimeout` | 317 |
| 31 | `dshApiUrl` | 319 |
| 32 | `dshApiToken` | 321 |
| 33 | `verboseLog` | 323 |
| 34 | `workspace` | 330 |
| 35 | `agentPreset` | 332 |
| 36 | `provider` | 334 |
| 37 | `model` | 336 |
| 38 | `sessionReuse` | 338 |

UI 侧 `normalizeSettings`（`src/client/index.js:786-808`）只搬运了 8 个：
`enabled` / `userId` / `password` / `did` / `pollIntervalMs` / `maxReplyChars` / `triggerKeywords` / `ignorePatterns`。

→ **缺失 30 个**，任务书给的清单完全正确。

### 0.2 ⚠️ 但 `xiaoai/onboarding.models` 不是 LLM 模型列表

任务书说「`xiaoai/onboarding.models` 已能返回模型列表 → 直接给下拉用」。**这是错的，不能这么用。**

读 `src/rpc.js:893-911`：

```js
/**
 * `xiaoai.onboarding.models()` —— 型号兼容表。
 * ...
 */
async onboardingModels() {
  const models = Object.entries(SPEAKER_MODELS).map(([code, spec]) => ({
    code, name: spec.name, tts: spec.tts, wakeUp: spec.wakeUp, support: spec.support,
  }));
  return { models };
}
```

它返回的是**音箱硬件型号表**（`OH2P` 这类，带 TTS/唤醒指令字节），用途是「手动配置时的型号下拉」，
给 `deviceModel` / `ttsCommand` / `wakeUpCommand` 用的 —— 与 LLM 的 `provider`/`model` 完全无关。

如果照这个思路接线，用户会在「模型」下拉里看到 `Xiaomi 智能音箱 Pro`，然后被写进 `settings.model`。

**正确的 LLM 模型列表来源见 §5.1。**

---

## 1. 关键发现：DSH 官方设置面板的组织方式，我们只用了十分之一

这一节决定了整个设计的方向。

### 1.1 官方设置面板是「导航 + 分区」结构，不是一列平铺

读 `@deepseek-ai/dsh-client-ui-settings`（`README.zh.md`）：

> 设置界面会注册进本包声明的 slot 类型。外壳（`sidebar.settings` 占位方、**导航**、界面框架）位于 `ui-settings-general`；
> 功能页面注册 `settings.section` 贡献；「插件」分区承载 `settings.plugins.tab` 页面。

> 外壳渲染模态面板、**由 `settings.section` 条目构建的导航**，以及每次只挂载一个的引导步骤。

读 slot 契约（`dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:67-78`）：

```ts
'settings.section': {
  kind: 'list';
  scope: 'root';
  owner: SettingsSectionOwnerProps;   // 只给一个 close()，其余全是自己的事
};
```

配套的 `SettingsSectionOwnerProps` 注释（同文件 124-140 行）说得很明确：

> Owner share of a settings section entry. **The shell owns modal visibility and navigation**;
> a section's data arrives through **its own inject faces and stores**.

**结论**：`settings.section` 是**一整页**，外壳已经提供了左侧导航。所以我们的分区**天然是一页**，
不需要自己造 tab —— 但**页内**仍然需要分组，因为我们只是「小爱语音」这一页里的内容。

### 1.2 我们的注册只填了 4 个字段

`src/client/index.js:2635-2651`：

```js
ctx.slots.inject("settings.section", () =>
  ctx.slots.register(
    {
      name: "settings.section",
      id: "dsh-xiaoai",
      order: 30,
      label: () => "小爱语音",
      inject: () => ({ hooks: { Xiaoai: statusSource }, rpc })
    },
    XiaoaiSectionBound
  )
);
```

契约允许注册 `label`（导航显示名）与 `order`（导航位置），我们用了；但页内**没有分组**，
`renderSettingsForm`（1708-1759）只输出 `SectionTitle` + 一堆 `Field`，一路平铺到底。

### 1.3 dsh-im 的组织方式：一个关注点一个模块 + 页内 tab

dsh-im 的做法值得直接借鉴。`c3h3-dsh-im/plugin-src/client/` 把设置拆成**每关注点一个文件**：

| 文件 | 行数 | 关注点 |
|------|------|--------|
| `global-settings.js` | 421 | 通用设置（附件保留时长），**页内 tablist** |
| `delivery-settings.js` | 881 | 投递目标 |
| `access-policy-settings.js` | — | 访问策略 |
| `agent-preset.js` | — | Agent 预设 |
| `model-setting.js` | — | 模型选择 |
| `credential-binding.js` | — | 凭据绑定 |
| `workspace-editor.js` | 69 | 工作区编辑 |
| `workspace-directory-picker.js` | — | 工作区目录**可视化选择器** |
| `context-enhancement.js` | — | 上下文增强 |
| `bot-alias.js` | — | 别名 |

它在 `settings.section` 里注册**一个** tab（`order: 21`），页内再用 `role="tablist"` 分tab
（`global-settings.js:284-297`），每个 tab 是一个 `role="tabpanel"`。

两个可直接抄的具体手法：

**(a) 帮助文案用 `?` 按钮 + tooltip，不占常驻空间**（`global-settings.js:312-333`）：

```js
h('div', { className: 'dim-globalHead' },
  h('div', { className: 'dim-globalHeadTitle' },
    h('h3', { id: 'dim-globalTtlTitle' }, '附件保留时长 (小时)'),
    h('div', { className: 'dim-globalTtlHelp' },
      h('button', {
        type: 'button',
        className: 'dim-channelHelpButton dim-globalTtlHelpButton',
        'aria-label': '查看附件保留时长说明',
        'aria-describedby': ttlHintsId,
      }, h('span', { 'aria-hidden': 'true' }, '?')),
      h('div', { id: ttlHintsId, className: 'dim-globalTtlTooltip', role: 'tooltip' },
        h('ul', { className: 'dim-globalTtlHints' },
          h('li', null, h('code', null, '-1'), h('span', null, '永久保留，不会自动清理')),
          h('li', null, h('code', null, '0'),  h('span', null, '每 Turn 结束后立即清理')),
          h('li', null, h('code', null, `1~${INBOUND_TTL_MAX_HOURS}`), h('span', null, '小时后自动清理'))))))),
```

**(b) 保存按钮的可用性由「是否真的有改动」决定**（`global-settings.js:276-279`）:

```js
const canSave = phase !== 'loading'
  && !isSaving
  && proposedTtl !== null
  && proposedTtl !== savedTtl;   // ← 脏检查
```

**(c) 工作区是「可视化目录选择器」，不是手填路径** —— `workspace-directory-picker.js` 用 `createPortal`
渲染一个带面包屑（`displayCrumbs`，含 home 裁剪）、显示隐藏文件开关、错误分类
（`directory-picker/unavailable` → `unreadable`）的模态选择器。

**关于 `workspaces` / `agentPresets` / `models` 那几个配置项**：dsh-im 的 `workspaces.json`
是它**自己的**存储格式，不是 DSH 的通用契约。真正权威的数据源是 DSH 的 Host RPC，见 §5.1。

---

## 2. 信息架构

### 2.1 分组方案：6 组，两级层次

字段 38 个，全平铺必然压迫。方案是**「顶部常驻状态条 + 6 个可折叠分组」**，
其中 **2 组默认展开、4 组默认折叠**。

```
┌─ 常驻：状态总览（不可折叠）─────────────────────────────┐
│  ● 运行中 · Xiaomi 智能音箱 Pro OH2P · [AI模式: 待命]   │
│  DSH 连通：可达   ·  会话：已绑定  ·  工作区：~/AI-workspace │
└──────────────────────────────────────────────────┘

① 会话与模型        ★默认展开   priority 1  ← 用户最关心的
② 接入音箱（账号/设备）  默认展开     priority 2
③ 音箱行为          ☆默认折叠     priority 3
④ 提示语            ☆默认折叠     priority 4
⑤ 高级 / 桥接        ☆默认折叠     priority 5
⑥ 状态与日志（最近活动 + 运行日志）  ☆默认折叠  priority 6
```

**默认展开哪两个**：①「会话与模型」是用户明确抱怨缺失的，必须第一眼可见；
②「接入音箱」含运行状态与凭据，是「能不能用」的前提。
其余四组都是「配好一次就不动」的调优项，默认折叠。

**为什么不是页内 tab**：本页已经是导航里的一个 section，
再套一层 tab 会让「点导航 → 再点 tab」变成两级操作；而可折叠分组是零成本展开
（`<details>` 原生语义，键盘/无障碍免费）。6 组的量级用折叠比用 tab 更轻。

### 2.2 ⚠️ 折叠状态必须持久化 —— 否则每次进设置都重置

这是个**容易漏的坑**。`XiaoaiSection` 是每次导航切进来重新挂载的（`useState` 不跨挂载存活），
所以折叠状态若只用 `React.useState`，用户每次都要重新展开。

**方案**：存 `localStorage`，key `dsh-xiaoai.settings.groups`，值为已展开分组的 id 数组。
用 `try/catch` 包住（无痕模式会抛），读取失败回退默认。

```js
const GROUP_STORAGE_KEY = "dsh-xiaoai.settings.groups";
const DEFAULT_OPEN = ["session", "access"];   // 默认展开的两组

function readOpenGroups() {
  try {
    const raw = localStorage.getItem(GROUP_STORAGE_KEY);
    if (raw === null) return new Set(DEFAULT_OPEN);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set(DEFAULT_OPEN);
  } catch { return new Set(DEFAULT_OPEN); }
}
```

> 注意：不要试图把折叠状态写进 settings schema。那是**设备本地偏好**，
> 写进 settings 会占用 revision、触发 `applyConfig`、还会在用户之间同步 —— 都不对。

---

## 3. 线框图

```
╔══════════════════════════════════════════════════════════════════════════╗
║  小爱语音                                                                 ║
║  ┌────────────────────────────────────────────────────────────────────┐  ║
║  │ ● 运行中   ·  Xiaomi 智能音箱 Pro OH2P   ·   [ AI 模式：待命 ]      │  ║
║  │ DSH 连通：可达   ·   会话：已绑定   ·   工作区：AI-workspace        │  ║
║  │                                          [重新接入 / 更换音箱]      │  ║
║  └────────────────────────────────────────────────────────────────────┘  ║
║                                                                          ║
║  ┌─ ① 会话与模型 ──────────────────────────────────────────── ▼ ─────┐  ║
║  │  工作区        [ ~/AI-workspace            ▾ ]  [浏览…]            │  ║
║  │                语音会话落在哪个目录；决定会话在会话列表里归到哪。    │  ║
║  │  Agent 预设    [ 跟随宿主默认              ▾ ]                     │  ║
║  │  Provider      [ 跟随宿主默认              ▾ ]                     │  ║
║  │  模型          [ 跟随宿主默认              ▾ ]                     │  ║
║  │                留空 = 用 DSH 当前默认模型。                         │  ║
║  │  ☑ 会话复用    重启后继续用上次绑定的会话（探活失败会自动新建）      │  ║
║  └────────────────────────────────────────────────────────────────────┘  ║
║                                                                          ║
║  ┌─ ② 接入音箱 ────────────────────────────────────────────── ▼ ─────┐  ║
║  │  ☑ 启用（关掉后不再轮询音箱）                                       │  ║
║  │  小米 ID       [                            ]  不是手机号          │  ║
║  │  密码          [ ••••••••                   ]                      │  ║
║  │  音箱 DID      [                            ]  设备 ID 或米家名称  │  ║
║  │  型号          [ 自动识别（OH2P）           ▾ ]  [高级: 自定义指令] │  ║
║  └────────────────────────────────────────────────────────────────────┘  ║
║                                                                          ║
║  ┌─ ③ 音箱行为 ────────────────────────────────────────────── ▶ ─────┐  ║
║  │  （折叠）轮询间隔 · 回复字数上限 · 回复超时 · AI 模式开关            │  ║
║  │          三类关键词 · 静默退出时长 · 本地快速路径 · 进度播报阈值     │  ║
║  └────────────────────────────────────────────────────────────────────┘  ║
║                                                                          ║
║  ┌─ ④ 提示语 ──────────────────────────────────────────────── ▶ ─────┐  ║
║  │  （折叠）进入/退出/AI 回复中/已回复/进度/三类错误 — 共 9 组标签输入  │  ║
║  └────────────────────────────────────────────────────────────────────┘  ║
║                                                                          ║
║  ┌─ ⑤ 高级 / 桥接 ─────────────────────────────────────────── ▶ ─────┐  ║
║  │  （折叠）HTTP 桥接端点 / 令牌 · 详细日志 · 历史条数 · 忽略规则       │  ║
║  └────────────────────────────────────────────────────────────────────┘  ║
║                                                                          ║
║  ┌─ ⑥ 状态与日志 ──────────────────────────────────────────── ▶ ─────┐  ║
║  │  （折叠）最近活动 · 对话历史 · 运行日志                             │  ║
║  └────────────────────────────────────────────────────────────────────┘  ║
║                                                                          ║
║  ┌────────────────────────────────────────────────────────────────────┐  ║
║  │  ● 有 3 项未保存的修改                                              │  ║
║  │  [ 保存 ]  [ 撤销修改 ]  [ 恢复默认 ]         [ 应用推荐配置 ]      │  ║
║  │  工具： [测试音箱] [自检] [重启插件]                                │  ║
║  └────────────────────────────────────────────────────────────────────┘  ║
╚══════════════════════════════════════════════════════════════════════════╝
```

**分组内的字段行布局**（三列）：

```
┌──────────────┬────────────────────────────────┬──────────────────────┐
│ 标签          │ 控件                            │ 说明文案 / 行内提示    │
│ 14em 定宽     │ flex:1                          │ 12px 灰字，可换行      │
└──────────────┴────────────────────────────────┴──────────────────────┘
```

**标签式数组字段**（关键词、提示语）—— 这是字段最多的形态（9 个数组字段），必须设计好：

```
┌─ 进入 AI 模式的关键词 ────────────────────────────────────┐
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                  │
│  │ 进入AI模式 ×│ │ 召唤助手 ×│ │ 打开助手 ×│  [ 输入后回车 ]  │
│  └──────────┘ └──────────┘ └──────────┘                  │
│  说了这些词就进入连续对话，之后不用再喊触发词。             │
└─────────────────────────────────────────────────────────┘
```

要点：
- **已添加项渲染成 chip**，每个带 `×` 删除按钮（`aria-label="删除 进入AI模式"`）
- **输入框独立在末尾**，回车（`onKeyDown` 判 `Enter`）追加，**同时支持全角逗号/半角逗号粘贴拆分**
- **空数组显示占位提示**，而不是空白 —— 例：`（空 = 不播报这一条）`
- chip 删除后**焦点回到输入框**，连续删不丢键盘流

---

## 4. 字段清单

> 控件类型图例：`T`=文本输入 `N`=数字输入 `P`=密码 `SW`=开关 `SEL`=下拉（数据源见 §5）
> `TAGS`=标签式数组输入 `WS`=工作区选择器（下拉+浏览）`TA`=多行文本
> 「默认」取自 `src/runtime.js:21-70` 的 `DEFAULTS` 与 `src/index.js:68-73` 的 `ONBOARDING_DEFAULTS`。

### 组① 会话与模型（默认展开）★

| 字段 | 中文标签 | 控件 | 说明文案 | 默认值 | 数据源 |
|------|---------|------|---------|--------|--------|
| `workspace` | 工作区 | `WS` | 语音会话落在哪个目录。决定会话在 DSH 会话列表里归到哪个工作区。留空 = 用 DSH 默认 IM 工作区（`~/.dsh/im`）。 | `""` → `~/.dsh/im` | §5.2 |
| `agentPreset` | Agent 预设 | `SEL` | 这套会话加载哪些工具与提示词。留空 = 跟随宿主默认预设。 | `""` | §5.1 |
| `provider` | 模型 Provider | `SEL` | 与「模型」成对生效。**两者都填才生效**，只填一个会被忽略。 | `""` | §5.1 |
| `model` | 模型 | `SEL` | 留空 = 用 DSH 当前默认模型。 | `""` | §5.1 |
| `sessionReuse` | 会话复用 | `SW` | 重启插件后继续用上次绑定的会话，保留上下文。探活失败时会自动新建。 | `true` | — |

> ⚠️ **`provider`/`model` 的成对约束必须在 UI 上表达**。见 `src/runtime.js:713-727`：
> ```js
> #resolveModelSelection() {
>   const p = String(this.#config.provider ?? "").trim();
>   const m = String(this.#config.model ?? "").trim();
>   if (p && m) return { provider: p, model: m };   // ← 两者都有才用
>   ... 否则回退宿主默认
> }
> ```
> 如果用户只选了 provider 没选 model，**配置被静默忽略**，用户会以为设了却没生效。
> 设计上：选 provider 后自动把 model 下拉重填为该 provider 的第一个模型；
> 清空其一时同时清空另一个，并在行内给出提示。

### 组② 接入音箱（默认展开）

| 字段 | 中文标签 | 控件 | 说明文案 | 默认值 |
|------|---------|------|---------|--------|
| `enabled` | 启用 | `SW` | 关掉后不再轮询音箱，语音入口整体停用。 | `true` |
| `userId` | 小米 ID | `T` | 小米账号 ID，**不是手机号**。 | `""` |
| `password` | 密码 | `P` | 留空 = 不修改已保存的密码。 | `""` |
| `did` | 音箱 DID | `T` | 设备 ID 或米家名称。 | `""` |
| `deviceModel` | 音箱型号 | `SEL` | 空 = 连接时从设备硬件信息自动识别。 | `""` |
| `ttsCommand` | TTS 指令（高级） | `T` | 仅型号未收录时手填，格式 `7,3`。 | `""` |
| `wakeUpCommand` | 唤醒指令（高级） | `T` | 仅型号未收录时手填，格式 `7,1`。 | `""` |
| `onboarded` | 已完成接入向导 | 隐藏 | **不暴露给用户**，仅内部状态。 | `false` |

> `ttsCommand` / `wakeUpCommand` 默认藏在「型号」行右侧的「高级」展开里 ——
> 99% 的用户用不到，但排障时能找到。

### 组③ 音箱行为（默认折叠）

| 字段 | 中文标签 | 控件 | 说明文案 | 默认值 |
|------|---------|------|---------|--------|
| `aiModeEnabled` | 启用 AI 模式 | `SW` | 打开后支持「进入/退出 AI 模式」的连续对话；关掉则只做逐条关键词匹配。 | `true` |
| `pollIntervalMs` | 轮询间隔 | `N` | 毫秒。越小响应越快，但小米接口有风控，**最小 2000**。 | `4000` |
| `maxReplyChars` | 回复字数上限 | `N` | 音箱念太长很难受，超出部分会被截断。 | `400` |
| `replyTimeoutMs` | 回复等待上限 | `N` | 毫秒。超过就放弃并播报超时提示。 | `240000` |
| `callAIKeywords` | 「直接问」关键词 | `TAGS` | 以这些词开头时**立刻**交给 DSH，但不改变模式。 | `[]` |
| `wakeUpKeywords` | 「进入 AI 模式」关键词 | `TAGS` | 说了之后所有话都交给 DSH，无需重复喊触发词。 | `[]` |
| `exitKeywords` | 「退出 AI 模式」关键词 | `TAGS` | 说了就回到待命，普通话不再处理。 | `[]` |
| `exitKeepAliveAfter` | 静默退出时长 | `N` | 秒。AI 模式下多久没说话自动退出，**最小 5**。 | `30` |
| `localCommandsEnabled` | 本地快速路径 | `SW` | 音量/时间/停止这类高频指令本机处理，毫秒级响应、不走大模型。 | `true` |
| `triggerKeywords` | 触发词（旧模式） | `TAGS` | 关掉 AI 模式后才用。留空 = 全部转发。 | `[]` |
| `progressAfterSeconds` | 进度播报阈值 | `N` | 秒。任务超过这个时间没完成，先播一句安抚语。**最小 10**。 | `35` |

> ⚠️ `triggerKeywords` 与 `aiModeEnabled` 是**互斥的两套机制**（`src/runtime.js:1206-1242` 的状态机分支）。
> 设计上：`triggerKeywords` 放在 `aiModeEnabled` 为 **false** 时才展开显示，
> 并注明「仅在关闭 AI 模式时生效」。

### 组④ 提示语（默认折叠）

9 个数组字段。全部语义相同：**空数组 = 不播报**，多条时随机取一条。

| 字段 | 中文标签 | 控件 | 说明文案 | 默认值 |
|------|---------|------|---------|--------|
| `onEnterAI` | 进入 AI 模式 | `TAGS` | 进入时播报。 | `["AI模式已开启"]` |
| `onExitAI` | 退出 AI 模式 | `TAGS` | 退出时播报。 | `["已退出AI模式"]` |
| `onAIAsking` | 思考中 | `TAGS` | 已交给 DSH、等回复时播报。 | `["让我想想"]` |
| `onAIReplied` | 回答完毕 | `TAGS` | 回复念完之后播报。**默认空 = 不播报**。 | `[]` |
| `onAIProgress` | 进度安抚 | `TAGS` | 长任务超过阈值时播报一次。 | `["还在处理，请稍等一下"]` |
| `onAIError` | 出错（兜底） | `TAGS` | 未命中具体分类时的兜底。 | `["抱歉，出错了"]` |
| `onAIErrorNetwork` | 出错 · 网络 | `TAGS` | 连接失败/断开时。 | `["网络好像不太好，等一下再试试"]` |
| `onAIErrorAuth` | 出错 · 鉴权 | `TAGS` | 401/403/token 过期时。 | `["小米账号可能需要重新登录，请在设置面板检查"]` |
| `onAIErrorTimeout` | 出错 · 超时 | `TAGS` | 请求超时时。 | `["这个问题有点复杂，我还没想完，请再问一次"]` |

> 组④ 字段多但结构极规整 —— 建议组内再分两个小节：
> **「对话流程提示」（前 5 个）** 与 **「出错提示」（后 4 个）**，各带一行小标题。

### 组⑤ 高级 / 桥接（默认折叠）

| 字段 | 中文标签 | 控件 | 说明文案 | 默认值 |
|------|---------|------|---------|--------|
| `ignorePatterns` | 忽略规则 | `TAGS` | 正则。匹配到的句子直接忽略，不转发。 | `["^小爱同学$"]` |
| `historyLimit` | 历史保留条数 | `N` | 面板里能回看多少轮对话。 | `20` |
| `verboseLog` | 详细日志 | `SW` | 打开后日志量明显变大，仅排障时用。 | `false` |
| `dshApiUrl` | HTTP 桥接地址 | `T` | **仅**在进程内 agent 不可用时才走这条通路。一般不用改。 | `http://127.0.0.1:3082/api/session` |
| `dshApiToken` | HTTP 桥接令牌 | `P` | 敏感。留空 = 不修改。 | `""` |

> 组⑤ 顶部加一条说明：
> 「下面的设置一般不需要改。改动前建议先记下原值。」

### 组⑥ 状态与日志（默认折叠）

纯展示，无表单字段：

| 内容 | 数据源 | 展示 |
|------|--------|------|
| 最近听到 / 最近回复 | `status.lastHeard` / `status.lastReply` | `InfoRow` |
| 已处理条数 | `status.handledCount` | `InfoRow` |
| 会话 / 工作区绑定 | `status.sessionId` / `status.workspacePath` / `status.boundVia` | `InfoRow`（**新增**，当前有数据但 UI 没显示） |
| 对话历史 | `status.history` | 现有 `renderRecent` 的 `<details>` |
| 运行日志 | `xiaoai.logs` | 现有 `renderLogs` |
| 连续错误次数 | `status.consecutiveErrors` | 仅 > 0 时显示 |

> `sessionId` / `workspacePath` / `boundVia` 在 `src/runtime.js:262-265` 已有，
> 是排查「会话到底绑上没有」的关键证据，当前 UI 完全没显示。

---

## 5. 下拉数据源方案（本节回答「能不能做下拉而不是手填」）

**能，但必须走对通路。** 逐项给方案。

### 5.1 模型 / Agent 预设：走 DSH 客户端框架的 `remote` 命名空间

官方 `dsh-client-ui-model-selection`（`lib/client.js:109`）就是这么拿的：

```js
const operation = this.ctx.remote.session.modelCatalog().then((response) => {
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  ...
});
```

返回结构（`dsh-api-session-controller/lib/types/types.d.ts:107-133`）：

```ts
interface ModelCatalogModel { id: string; name: string; description?: string; reasoning?: ModelReasoning }
interface ModelProviderGroup { id: string; name: string; models: readonly ModelCatalogModel[] }
interface ModelCatalogFailure { id: string; name: string; message: string }
interface ModelCatalog {
  readonly default: ModelSelection;
  readonly routableProviders: readonly string[];
  readonly groups: readonly ModelProviderGroup[];
  readonly failures: readonly ModelCatalogFailure[];
}
```

→ **`groups` 可直接渲染成 `<optgroup>`**（provider 名 + 该 provider 下的模型），
`failures` 用来显示「某些 provider 加载失败」的提示，`default` 是「跟随宿主默认」的实际值。

**Agent 预设**同理：`ctx.agentPresets.remoteExportList()` 返回
`{ presets: AgentPresetRow[], authorable, modeSelectionEnabled }`
（`dsh-agent-presets/lib/types/types.d.ts:24-31`）。

**⚠️ 实施风险（必须知晓）**：本插件的 `inject` 是 `["slots", "remote"]`
（`src/client/index.js:2676`），且 `remote` 已声明 —— 所以 `ctx.remote.session` 理论上可达。
但插件头部注释（2531-2545）明确记过教训：**不要静态 inject 动态挂载的命名空间**。
`session` / `agentPresets` 是**框架预置**命名空间（始终存在），与自注册的 `xiaoai` 不同，
静态注入是安全的（官方 `dsh-client-ui-agent-preset` 就直接写进 inject）。

**但仍有加载时序风险**：`remote.session` 若在某些宿主上晚挂载，静态 inject 会让整个插件
永久 pending（这正是注释里记载的坑）。**建议**：仍然走运行时轮询
（复用已有的 `waitForNamespace` 模式），取不到就**降级为普通输入框**并给出提示：

```
模型  [ 无法读取模型列表，请手动输入        ]  ⚠️ 未连接到 DSH 模型目录
```

**降级路径是必须的** —— 不能因为拿不到列表就让用户完全无法配置。

### 5.2 工作区：两条路，建议「选择器 + 手填」并存

- **主路径**：官方 `dsh-client-ui-workspace` / `dsh-api-workspace-controller` 提供
  `create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue>` 与列表能力。
  服务端侧本插件已在用 `ctx.workspaceRegistry.list()` / `.create(path)`
  （`src/runtime.js:699-706`）—— **`list()` 是现成的**。

  **推荐做法**：加一个服务端 RPC `xiaoai.workspaces.list`，在服务端调
  `ctx.workspaceRegistry.list()` 返回 `[{id, path, name}]`。
  这样绕开了客户端命名空间的时序问题，且与既有代码同源（`#getOrCreateWorkspaceEntity` 就在做同样的事）。

- **辅助路径**：输入框允许直接粘贴路径（很多用户知道自己的目录在哪）。
  校验：保存时服务端会 `realpathSync` + `create`（`src/runtime.js:693-706`），
  路径不存在会抛 ENOENT —— **UI 需要把这个错误翻译成人话**：
  「这个目录不存在或无法访问，请检查路径」。

> 不做完整目录浏览器（dsh-im 的 `workspace-directory-picker.js` 那种）。
> 那是 200+ 行的模态组件，本次改造收益/成本比不高。**列为后续可选增强。**

### 5.3 音箱型号：`xiaoai.onboarding.models`（这才是它的正确用途）

`SPEAKER_MODELS` 表（`src/rpc.js:902-911`）→ 渲染成下拉，`support` 字段用于显示兼容性说明。

---

## 6. 交互设计

### 6.1 底部操作栏：三类动作分开

现状把 5 个按钮平铺（`renderActions`，1591-1604），「保存」和「测试音箱」视觉权重相同 —— 不合理。

重构成**三组**：

```
┌────────────────────────────────────────────────────────────────┐
│ ● 有 3 项未保存的修改                    （脏状态提示，仅脏时出现）│
│                                                                │
│ [ 保存 ]  [ 撤销修改 ]  [ 恢复默认 ]      [ 应用推荐配置 ]      │
│  ↑主操作    ↑次           ↑危险            ↑批量填充（不落盘）  │
│ ────────────────────────────────────────────────────────────── │
│ 工具：[ 测试音箱 ]  [ 自检 ]  [ 重启插件 ]                      │
└────────────────────────────────────────────────────────────────┘
```

- **保存**：`primary`，**仅在脏时可用**（`disabled={!dirty || busy}`）
- **撤销修改**：把 draft 重置回最近一次加载/保存的值
- **恢复默认**：填回 `DEFAULTS`（需二次确认，`window.confirm`）
- **应用推荐配置**：**只改 draft 不落盘** —— 保持现有语义
  （`src/client/index.js:1960-1965` 注释已说明这是刻意的），应用后置脏、提示「已填入推荐值，请检查后保存」
- **测试/自检/重启**：归入「工具」，与配置修改分开；这三个是**立即执行**的，不参与 draft

### 6.2 忙碌态

**问题**：现状一个 `busy` 布尔管所有按钮（`state.busy`），点「测试音箱」会禁掉「保存」，反之亦然。语义不清。

**方案**：把 `busy` 拆成 `busyAction`（`null | "save" | "restart" | "speak" | "selftest"`）：

- 被点击的按钮显示 spinner + 文案变「保存中…」
- **其余按钮保持可用**（它们互不冲突）
- 全局 `aria-busy` 挂在操作栏上

### 6.3 错误展示

三级，不要一律用同一档：

| 级别 | 场景 | 展示 |
|------|------|------|
| 字段级 | 单个字段校验失败（如轮询间隔 < 2000） | 控件下方红字，`aria-invalid` + `aria-describedby` |
| 分组级 | 该组依赖的远端数据读失败（如模型列表） | 组标题右侧 ⚠️ 图标 + 组内顶部一行提示 |
| 页面级 | 保存/加载整体失败 | 顶部 `role="alert"` 横幅（沿用现有 `notice`） |

**校验前置**：轮询间隔 / 退出时长 / 进度阈值都有下限（2000 / 5 / 10），
现在 `buildPatch`（`814-828`）是**静默钳制**（`poll >= 2000 ? poll : 2000`）——
用户输入 500 会被悄悄改成 2000，没有任何反馈。改为**行内实时提示**：
「最小 2000 毫秒，已按 2000 处理」，让用户知道发生了什么。

### 6.4 脏数据提示

```js
const dirtyKeys = useMemo(() => computeDirtyKeys(draft, baseline), [draft, baseline]);
const dirty = dirtyKeys.length > 0;
```

- 底部提示条：**有 N 项未保存的修改**
- **折叠的分组标题上打圆点** —— 这是关键：用户在组①改了东西，
  组③折叠着但也有改动时，必须能看见。否则折叠会**隐藏脏状态**。
- 离开页面拦截：`beforeunload` 在 SPA 内不可靠；
  改用「切导航时若脏则 confirm」——如果 section 的卸载钩子允许。
  **若不支持，至少保证底部提示条始终可见**（在滚动容器外/`position: sticky`）。

### 6.5 敏感字段

`password` 与 `dshApiToken` 都是 `role("secret")`（`src/index.js:258, 321`），
`describe({redactSecrets:true})` 会打码。现有 `isRedacted()`（`src/client/index.js:834-838`）
已识别掩码，逻辑正确，**保留**。

UI 上补充：
- 右侧一个 👁 切换明文（仅前端，不改传输）
- placeholder 显示「已保存（留空则不修改）」—— 现有行为，保留

### 6.6 无障碍

- 分组用 `<details>`/`<summary>` → 键盘与读屏原生支持
- 折叠标题的脏点用 `aria-label` 补充语义：「会话与模型，有未保存的修改」
- 标签式输入：chip 删除按钮带 `aria-label="删除 xxx"`；输入框 `aria-describedby` 指向说明文案
- 状态点不能只靠颜色 —— 现有 `StatusDot` 已配文字，保留
- 所有校验错误用 `role="alert"` 或 `aria-live="polite"`

---

## 7. 与 dsh-im 的对比

| 维度 | dsh-im | dsh-xiaoai（现状） | 学习点 |
|------|--------|-------------------|--------|
| **模块拆分** | 每个关注点一个文件（`model-setting.js` / `agent-preset.js` / `workspace-editor.js` / `delivery-settings.js` …），单一 `index.js` 只有 601 行 | 全部塞在 `client/index.js` 2688 行里 | 拆文件。但**本次先不拆**（见 §8 风险），先把分组做出来 |
| **页内导航** | `role="tablist"` + `role="tabpanel"`，`aria-labelledby` 齐全 | 无，一路平铺 | 我们用 `<details>` 折叠（零成本），dsh-im 用 tab（适合并列的关注点） |
| **帮助文案** | `?` 按钮 + `role="tooltip"`，长说明进 tooltip | `Field` 只有一行 12px `hint` | 长说明（如「三类关键词语义不同」）改 tooltip，避免每行都拖一片灰字 |
| **脏检查** | `canSave = ... && proposedTtl !== savedTtl` | 无，保存按钮永远可点 | 直接采纳 |
| **数据源** | 服务端 `modern-harness-api.mjs` 经 `#invoke('session','modelCatalog')` 拿目录 | 无（字段根本没暴露） | 模型/预设从 DSH 目录读，不手填 |
| **工作区** | 可视化目录选择器 + 面包屑 + 错误分类 | 无 | 本次做下拉+手填；选择器列后续 |
| **i18n** | 有 `i18n.js`，`zh`/`en` 双语文案 | 不注册 locale，中文硬编码 | 保持硬编码（本插件定位单一语言，`src/client/index.js:2513` 已说明理由） |
| **错误分类** | `pickerErrorKind()` 把 RPC 错误码映射成 `unavailable`/`unreadable` | `describeError()` 直接显示原始消息 | 采纳：至少把「目录不存在」「RPC 网关不可达」翻译成人话 |
| **状态可见** | `aria-busy`、`role="alert"`、错误详情分类 | 部分有（`role="alert"` 已用） | 补 `aria-busy` |

**一句话**：dsh-im 的**信息架构**（一关注点一模块 + 页内导航 + 脏检查 + 目录选择器）值得学；
但它的**技术栈更重**（Context、portal、i18n、自定义 picker）。我们本次取「架构思路」，不取「实现体量」。

---

## 8. 实施建议

### 8.1 改动范围

**唯一需要改的文件**：`src/client/index.js`（2688 行）。**服务端除一个可选 RPC 外不用改。**

| 改动 | 位置（当前行号） | 内容 | 预计行数 |
|------|-----------------|------|---------|
| **A. 扩 `SETTING_DEFAULTS`** | 770-783 | 补齐 38 个字段的默认值（对齐 `src/runtime.js:21-70`） | +30 |
| **B. 扩 `normalizeSettings`** | 786-808 | 把 30 个缺失字段搬进来；数组字段保持数组（**不要**在这里 `formatList`） | +35 |
| **C. 扩 `buildPatch`** | 814-828 | 补 30 个字段；数组字段 `parseList`；数字字段保留钳制但**同时返回钳制信息供 UI 提示** | +40 |
| **D. 新增原子组件** | 842-936 区段 | `Checkbox`（开关）· `Select`（下拉，支持 optgroup）· `TagInput`（标签式数组）· `CollapsibleGroup`（`<details>` 分组）· `FieldRow`（三列布局） | +180 |
| **E. 重写 `renderSettingsForm`** | 1708-1759 | 拆成 6 个 `renderXxxGroup(state)` 函数 | 1759 起，替换为 ~450 |
| **F. 改 `renderActions`** | 1591-1604 | 三类动作分离 + 脏检查 + 每按钮独立 busy | +40 |
| **G. 新增 `useDirtyKeys`** | 组件内 | 与 baseline 比对 | +25 |
| **H. 新增模型/预设目录加载** | 组件内 | `remote.session.modelCatalog()` / `agentPresets.remoteExportList()`，带降级 | +70 |
| **I. 补 CSS** | `STYLESHEET`（约 350-628） | 分组、三列行、chip、tab 式控件、脏点 | +200 |
| **J. 折叠持久化** | 组件内 | `localStorage` 读写 | +25 |

**合计约 +1090 行 / 改 ~120 行**，最终文件约 **3700 行**。

**可选的服务端改动**（让工作区下拉成为可能）：
- `src/rpc.js`：新增 `workspacesList()`（约 20 行，调 `ctx.workspaceRegistry.list()`）
- `src/rpc.js:981-996`：`RPC_METHODS` 加一行
- `src/index.js:514`：日志里的端点清单加一项

### 8.2 建议分阶段落地（**不要一次改完**）

| 阶段 | 内容 | 可独立验证 |
|------|------|-----------|
| **P1** | A + B + C + D + E（先做**分组 + 补字段**，下拉先用手填输入框） | 38 个字段全部可见可存；`settings.get` → 改 → `settings.update` → 回读一致 |
| **P2** | F + G + J（交互：脏检查 / 独立 busy / 折叠持久化） | 脏点、按钮态、刷新后折叠保持 |
| **P3** | H + 5.1/5.2 下拉（含降级 + 服务端 workspace RPC） | 拿到列表时是下拉，拿不到时是输入框 + 提示 |
| **P4** | I 收尾（视觉打磨）+ 第 6 节剩余无障碍项 | — |

P1 完成就已解决用户的**两个原始抱怨**（字段缺失 + 无分组）；P3 的体验提升最大但风险也最高。

### 8.3 风险点（逐条，附规避）

1. **⚠️ `buildPatch` 必须发全量，不能只发改动字段**
   `settings.update` 的 `sanitizePatch` 走的是 merge 语义（`src/rpc.js:401-405`），
   发部分字段是安全的；但改成「只发脏字段」会引入新复杂度。
   **建议仍发全量 patch**（当前行为），配合 revision 乐观锁（`src/client/index.js:1899`）。
   *风险*：并发界面下 revision 冲突 → 已有 `notice` 提示，保留即可。

2. **⚠️ 数组字段的双重格式陷阱**
   现状 draft 里 `triggerKeywords` 存的是**逗号分隔字符串**（`formatList`，1859-1860），
   `buildPatch` 再 `parseList` 回来。改成 `TagInput` 后 **draft 里必须是真数组**，
   否则 `parseList` 会把数组当字符串处理。**P1 必须同步改掉这两处**，否则保存即丢数据。

3. **⚠️ 密码掩码回写**
   `isRedacted()` 逻辑正确，但**新增 30 个字段后**，`normalizeSettings` 若漏掉某个
   secret 字段的打码处理，会把掩码串写回。当前只涉及 `password` / `dshApiToken`，
   两者都要走同一套 `isRedacted` 处理。

4. **⚠️ 静态 inject `remote.session` 的时序风险**
   见 5.1。**必须走运行时轮询 + 降级**，不要写进 `exports.inject`。
   插件头部注释（2531-2545）记载过这个坑，别重蹈。

5. **⚠️ `normalizeSettings` 在 3 处被调用**（1854 / 1901 / 保存后回填）
   扩字段后要保证三处**行为一致**。建议抽出单一 `normalizeSettings`，
   不要在调用点各自拼装（现在 1903-1908 就有重复的 `{...values, password: ..., triggerKeywords: formatList(...)}` 逻辑）。
   **这是当前代码里已经存在的重复，扩展时会放大**。

6. **可折叠 + 脏点的组合容易漏**
   用户折叠的分组里如果有改动，必须在标题可见处提示（§6.4）。
   这是**最容易做错**的一点 —— 折叠会隐藏脏状态。

7. **`<details>` 与受控状态的取舍**
   用 `<details open>` 受控时，`open` 属性变化不触发 `toggle` 事件，
   而用户点击触发 `toggle`。**建议**：用 `onToggle` 同步 state 到 localStorage，
   但**不要**在每次 render 强行回写 `open`（会导致展开动画抖动）。
   仅在挂载时用 `defaultOpen` 语义。

8. **性能**：38 个字段全在一个组件里，每次 `onDraftChange` 触发整树重渲。
   规模不大（几百个节点），现代浏览器无感。**但**若 P3 加了模型目录加载，
   注意 `useMemo` 缓存目录、避免每次 render 重新请求。

9. **不要动 `onboarded` 的语义**
   它决定首屏显示向导还是完整面板。新设计里它是**隐藏字段**，
   `buildPatch` 里**不要**发它（当前 `buildPatch` 也没发，保持）。
   向导流程（`renderOnboarding`，1070-1536）**本次不动**。

10. **回到 `showWizard` 的交互**
    现在「重新接入 / 更换音箱」按钮把整个 section 换成向导（不渲染完整面板）。
    重构后建议保留这个行为，但向导**完成后**要回到新的分组布局，
    并自动把「接入音箱」组设为展开。

### 8.4 不建议做的事（明确划界）

- **不要拆文件**。dsh-im 的多文件结构更好，但 `client/index.js` 是单文件 bundle 入口
  （检查 `package.json` 的 client 字段与 build 方式），拆文件会引入构建/路径问题，
  与本次「补字段 + 分组」的目标不正交。**列为后续独立任务。**
- **不要做完整目录选择器**。成本高，先把下拉+手填做扎实。
- **不要引入 i18n**。保持中文硬编码（已在 `src/client/index.js:2513` 说明理由）。
- **不要改服务端 settings schema**。38 个字段已经够了，缺的只是 UI。

---

## 9. 验收清单（照着这个测）

- [ ] 6 个分组全部可见，「会话与模型」「接入音箱」默认展开，其余折叠
- [ ] 38 个字段中有 37 个可在 UI 编辑（`onboarded` 隐藏属预期）
- [ ] 「会话与模型」组能选工作区 / Agent 预设 / Provider / 模型，选完保存后 `settings.get` 能读回
- [ ] `provider` 与 `model` 的成对约束有提示；只选一个时给出明确说明
- [ ] 数组字段（9 个）用 chip 编辑：回车添加、点 × 删除、粘贴逗号串能拆分
- [ ] 空数组显示的占位文案是「空 = 不播报这一条」而非空白
- [ ] 折叠状态刷新页面后保持
- [ ] 改动后底部出现「有 N 项未保存的修改」；保存后消失
- [ ] **折叠的分组里有改动时，标题上能看见脏点**
- [ ] 保存中只有「保存」按钮转圈，其他按钮不被打断
- [ ] 轮询间隔填 500 时，行内提示「最小 2000」，且保存后回读为 2000
- [ ] 密码/token 留空保存不会清空已存值；掩码不会回写
- [ ] 模型列表拿不到时降级为输入框 + 提示，**不会白屏或卡住**
- [ ] 应用推荐配置后 draft 变化、面板置脏、**未落盘**
- [ ] 键盘可 Tab 到所有分组标题并回车展开；chip 删除按钮可聚焦
- [ ] 重新接入向导仍可用；完成后回到分组布局且「接入音箱」组展开

---

## 附录 A：字段 → 分组速查（38 个全覆盖）

| 字段 | 组 |
|------|-----|
| `workspace` `agentPreset` `provider` `model` `sessionReuse` | ① 会话与模型 |
| `enabled` `userId` `password` `did` `deviceModel` `ttsCommand` `wakeUpCommand` `onboarded`(隐藏) | ② 接入音箱 |
| `aiModeEnabled` `pollIntervalMs` `maxReplyChars` `replyTimeoutMs` `callAIKeywords` `wakeUpKeywords` `exitKeywords` `exitKeepAliveAfter` `localCommandsEnabled` `triggerKeywords` `progressAfterSeconds` | ③ 音箱行为 |
| `onEnterAI` `onExitAI` `onAIAsking` `onAIReplied` `onAIProgress` `onAIError` `onAIErrorNetwork` `onAIErrorAuth` `onAIErrorTimeout` | ④ 提示语 |
| `ignorePatterns` `historyLimit` `verboseLog` `dshApiUrl` `dshApiToken` | ⑤ 高级 / 桥接 |
| （纯展示：`sessionId` `workspacePath` `boundVia` `history` `handledCount` `consecutiveErrors` `lastHeard` `lastReply`） | ⑥ 状态与日志 |

合计：5 + 8 + 11 + 9 + 5 = **38** ✓

## 附录 B：本次调研读过的文件

| 文件 | 用途 |
|------|------|
| `dsh-xiaoai-local/src/index.js:251-340` | `buildSettingsSchema` —— 38 个字段的权威定义 |
| `dsh-xiaoai-local/src/runtime.js:21-70` | `DEFAULTS` —— 默认值来源 |
| `dsh-xiaoai-local/src/runtime.js:248-267` | `status` 形状（组⑥ 数据源） |
| `dsh-xiaoai-local/src/runtime.js:684-727` | 工作区解析 + provider/model 成对约束 |
| `dsh-xiaoai-local/src/rpc.js:397-424` | `settings.update` 的 patch/merge 语义 |
| `dsh-xiaoai-local/src/rpc.js:475-510` | `recommendedPreset` 推荐值内容 |
| `dsh-xiaoai-local/src/rpc.js:893-911` | `onboarding.models` —— **实为音箱型号表** |
| `dsh-xiaoai-local/src/client/index.js:786-828` | `normalizeSettings` / `buildPatch`（待扩展） |
| `dsh-xiaoai-local/src/client/index.js:1537-1759` | 现有渲染函数（待重构） |
| `dsh-xiaoai-local/src/client/index.js:2635-2651` | `settings.section` 注册 |
| `@deepseek-ai/dsh-client-ui-settings/README.zh.md` | 官方设置面板架构 |
| `@deepseek-ai/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:67-140` | `settings.section` 契约 |
| `@deepseek-ai/dsh-client-ui-model-selection/lib/client.js:109` | 官方如何取模型目录 |
| `@deepseek-ai/dsh-api-session-controller/lib/types/types.d.ts:107-133` | `ModelCatalog` 类型 |
| `@deepseek-ai/dsh-agent-presets/lib/types/index.d.ts` + `types.d.ts:24-31` | Agent 预设 API |
| `c3h3-dsh-im/plugin-src/client/global-settings.js:276-333` | 页内 tab + tooltip + 脏检查范式 |
| `c3h3-dsh-im/plugin-src/client/model-setting.js` | 模型编辑器实现参考 |
| `c3h3-dsh-im/plugin-src/client/workspace-directory-picker.js` | 目录选择器（后续可选） |
| `c3h3-dsh-im/plugin-src/host/modern-harness-api.mjs:408-420` | dsh-im 如何拿模型目录 |
