# P1+P2 实施记录：6 组折叠重构 + 补全 37 个设置字段

> 对应任务：`task-3`
> 设计依据：`docs/research/ui-redesign.md`（795 行）
> 改动文件：`src/client/index.js`（2688 → 4469 行）
> 状态：**已通过浏览器实测**（含一次崩溃修复后的回归验证）

---

## 0. 一句话结果

用户原话指出的两个问题都已解决：

| 原话 | 现状 |
|------|------|
| 「对话，工作区，模型等等设置选择怎么都没有？」 | **37 个字段全部可见可编辑**（38 个中 `onboarded` 按设计隐藏） |
| 「界面布局也不够合理。」 | **6 组可折叠分组**，默认展开 ①会话与模型 + ②接入音箱，折叠状态持久化 |

---

## 1. 改动清单（按设计文档 §8.1 的 A–J）

| 项 | 内容 | 位置 |
|----|------|------|
| **A** | `SETTING_DEFAULTS` 补齐 38 字段 | `src/client/index.js` 设置归一化区 |
| **B** | `normalizeSettings` 重写为「按字段清单批量归一化」 | 同上 |
| **C** | `buildPatch` 发全量 patch（37 字段） | 同上 |
| **D** | 新增原子：`CollapsibleGroup` / `FieldRow` / `Select` / `Switch` / `TagInput` / `HelpTip` / `SubHeading` | 通用 UI 原子区 |
| **E** | `renderSettingsForm` 重写为 6 个分组 | 面板各区块区 |
| **F** | `renderActions` 三类动作分离 + 脏计数 | 同上 |
| **G** | `computeDirtyKeys` + `useMemo` 脏检查 | 组件内 |
| **H** | `loadHostOptions` / `loadDeviceModels`（含降级） | 组件内 |
| **I** | CSS 新增约 380 行（分组 / 三列行 / chip / 开关 / tooltip / 操作栏） | `STYLESHEET` |
| **J** | 折叠状态 `localStorage` 持久化 | 组件内 + 工具函数 |

**新增的纯函数**（可单测）：
`splitEntryText` · `appendEntries` · `clampNumberField` · `computeDirtyKeys` ·
`readOpenGroups` · `writeOpenGroups`

---

## 2. 数据完整性：数组字段的「双重格式陷阱」

设计文档 §8.3-2 点名了这个坑，这里是**实际处理方式**与**实测证据**。

### 处理方式

- **draft 里数组字段保持真数组**。`TagInput` 直接读写 `draft[key]`（数组），
  不再有「数组 → 逗号串 → 数组」的往返。
- **`parseList` 增加数组直通**：
  ```js
  function parseList(text) {
    if (Array.isArray(text)) return text.map(i => String(i).trim()).filter(Boolean);
    if (isBlank(text)) return [];
    return String(text).split(/[,，]/).map(p => p.trim()).filter(Boolean);
  }
  ```
- **`formatList` 降级为「只读展示」**，draft 里不再调用它（函数头已写明警告）。

### 为什么这很重要

旧实现里 `triggerKeywords` 在 draft 中是 `"a, b"` 字符串。若只改 `TagInput`
而不改 `parseList`，「回车加一项」会变成字符串拼接；更隐蔽的是
**元素本身含逗号的值会被切碎**：

| 输入 | 旧实现 | 现在 |
|------|--------|------|
| `onAIError: ["第一阶段，请稍候"]` | `["第一阶段", "请稍候"]` ❌ | `["第一阶段，请稍候"]` ✅ |

### 实测证据（脚本往返 + 浏览器端到端）

脚本级（`normalizeSettings` → `buildPatch` 往返）：
```
数组字段往返: triggerKeywords / ignorePatterns / 空数组   ✅ 一致
含逗号的值:   "第一阶段，请稍候" 仍为单条                  ✅
粘贴拆分:     "a, b，c、d\ne" → 5 条                       ✅
全量 patch 字段数 = 37（不含隐藏的 onboarded）             ✅
```

浏览器端到端（真实保存 → 服务端回读）：
```
粘贴 "你好小爱, 打开助手，召唤助手"  →  3 个 chip（半角+全角都拆开）✅
点「保存」→ 服务端 settings.get 回读:
  onEnterAI: ["AI模式已开启","你好小爱","打开助手","召唤助手"]   ✅ 无丢失
```

---

## 3. 分组与折叠（设计文档 §2）

### 结构

| 组 | 字段数 | 默认 |
|----|--------|------|
| ① 会话与模型 | 5 | **展开** |
| ② 接入音箱 | 7（+`onboarded` 隐藏） | **展开** |
| ③ 音箱行为 | 11 | 折叠 |
| ④ 提示语 | 9 | 折叠 |
| ⑤ 高级 / 桥接 | 5 | 折叠 |
| ⑥ 状态与日志 | 0（纯展示） | 折叠 |

合计 **37 可见 + 1 隐藏 = 38** ✓

### 折叠状态持久化

`localStorage["dsh-xiaoai.settings.groups"]` 存**已展开**分组的 id 数组。
`readOpenGroups` / `writeOpenGroups` 都用 `try/catch` 包住（无痕模式会抛）。

**实测**：
```
清空 localStorage → 重载 → ① ② 展开，③④⑤⑥ 折叠   ✅ 默认正确
展开③ → 存储变为 ["session","access","behavior"]    ✅ 持久化生效
```

### `<details>` 而非 tab

依据 `settings.section` 契约（`slots.d.ts:67-78`：
"The shell owns modal visibility and navigation"）—— 本页已经是导航里的一个
section，再套 tab 会变成两级操作。`<details>/<summary>` 键盘与读屏零成本。

---

## 4. 折叠分组必须打脏点（设计文档 §6.4，最容易做错的一点）

**为什么关键**：折叠会隐藏脏状态。用户在折叠的组里改了东西，
如果标题上没有提示，他会以为「没改动」，保存后才发现。

**实现**：三重视觉冗余，确保收起时也看得见
1. 标题右侧**品牌色圆点**（`.xiaoai-group-dot`）
2. 卡片**左侧 3px 品牌色边条**（`.xiaoai-group-dirty`）
3. `summary` 上加 `aria-label="会话与模型，有未保存的修改"`（不只靠颜色）

**实测**：
```
折叠「④ 提示语」→ 在其中加一个 chip
→ .xiaoai-group-dot 出现 ✅
→ classList 含 xiaoai-group-dirty ✅
→ 底部 "● 有 1 项未保存的修改" ✅
→ 保存按钮 enabled ✅
保存后：脏点消失、提示消失、按钮 disabled ✅
```

---

## 5. 会话与模型组（用户最高优先级）

| 字段 | 控件 | 数据源 |
|------|------|--------|
| `workspace` | **下拉 + 手填并存** | `xiaoai.hostOptions.workspaces` |
| `agentPreset` | 下拉（降级手填） | `xiaoai.hostOptions.presets` |
| `provider` | 下拉（降级手填） | 从 `models` 去重 provider |
| `model` | **`<optgroup>` 分组下拉** | `xiaoai.hostOptions.models` |
| `sessionReuse` | 开关 | — |

**实测拿到的真实数据**：
```
workspaces: 7 个（im / 工作 / AI-PROXY / …）
presets:    4 个（standard / ptc / minimal / …）
models:     1 个（ai-proxy / workbuddy/deepseek-v4.1-flash）
```

### provider + model 成对约束

`src/runtime.js #resolveModelSelection` 只在**两者都非空**时才用配置，
只填一个会被**静默忽略**。UI 上三重表达：
1. **选 provider 自动补 model**：切到该 provider 的第一个模型，不留半对配置
2. **行内警告**：只填一个时红字「provider 与模型必须成对，否则配置不生效」
3. **清空联动**：provider 清空时同时清空 model

### 降级路径（设计文档 §5.1 明确要求）

`hostOptions` 抛错 → 退化为手填输入框 + 灰字提示「无法读取宿主的模型目录（…）」。
**不会白屏或卡住**。

> ⚠️ 已知边界：若 `hostOptions` **成功但 `models` 为空数组**
> （运行时未就绪），下拉会变输入框但**不显示警告行** —— 因为「空列表」与
> 「读取失败」是两种语义，无法区分。这是刻意取舍，非缺陷。

### 借鉴 dsh-im 的补充检查

读 `c3h3-dsh-im/plugin-src/client/model-setting.js:171` 后发现一个真实缺口：
**已保存的模型可能从目录里消失**（provider 下线 / 换机器），此时下拉会显示空选中项，
用户完全不知道发生了什么，表现为「模型莫名其妙不生效」。

已采纳：`savedModelMissing` 检查 —— 仅当**目录确实拿到了**（`models.length > 0`）
且已存模型不在其中时，提示「当前配置的模型 … 不在宿主的模型目录里，可能已下线」。

---

## 6. 其他交互（设计文档 §6）

| 项 | 实现 |
|----|------|
| 三列字段行 | `grid-template-columns: 14em minmax(0,1fr)`；窄屏（≤640px）退化为单列 |
| 长说明 | `HelpTip`：`?` 按钮 + `role="tooltip"`，用在「AI 模式关键词」三类语义区分处 |
| 操作栏三类分离 | 配置动作（保存/撤销/恢复默认/推荐）+ 工具动作（测试/自检/重启） |
| 保存按钮脏时才可用 | `disabled={!dirty \|\| busyAction !== null}` |
| 独立 busy | `busy` 布尔 → `busyAction`（`null\|save\|restart\|speak\|selftest\|recommend`），点「测试音箱」不再禁掉「保存」 |
| 行内钳制提示 | 轮询间隔填 500 → 黄字「最小 2000 毫秒，已按 2000 处理」（不再是静默钳制） |
| chip 交互 | 回车加 / × 删 / 退格删末项 / 失焦落库 / 空数组显示「空 = 不播报这一条」 |
| `dshApiToken` 掩码 | 与 `password` 同一套 `isRedacted` 处理，`tokenRedacted` 独立标记 |

---

## 7. ⚠️ 踩坑记录：React #310 崩溃（重要教训）

**这是本次唯一一次真正的事故，值得完整记录。**

### 现象
自测全绿（`node --check` ✅、`build` ✅、字段覆盖脚本 ✅），但浏览器里
**设置面板整片白屏**，React error #310：
```
Minified React error #310  (Rendered more/fewer hooks than during the previous render)
xiaoai-class 元素数 = 0
```

### 两个根因（都不是我原本怀疑的地方）

**根因 1（主因）：`TagInput` 被当普通函数调用**

```js
function TagInput(options) {
  const [text, setText] = React.useState("");   // ← Hook
  ...
}
// ❌ 我写的（6 处）：
control: TagInput({ value, onChange })
```

**React 铁律**：含 Hook 的函数**必须当组件渲染**（`h(Comp, props)`），
不能直接调用。直接调用时 Hook 挂到**调用者**的 fiber 上，
而调用链 `XiaoaiSection → renderSettingsForm → TagInput` 中
`renderSettingsForm` 不是组件，导致 Hook 归属错乱。

修复：`control: h(TagInput, { value, onChange })`

**根因 2（次因）：三个 Hook 在 early return 之后**

```js
if (wizardActive) { return ...; }     // early return
const dirtyKeys = React.useMemo(...); // ❌ 在它之后
```
`wizardActive` 首渲染为 `true`（draft 还是 null）、数据到位后翻转为 `false`
→ Hook 数变化 → #310。修复：三个 Hook 上移到 early return 之前。

### 教训

> **语法检查 ✅ + 构建 ✅ + 字段覆盖核验 ✅，面板依然可以白屏。**

三项静态自测**全部无法**发现 Hook 规则违反 —— 它是**运行期**约束。
**UI 改动提交前必须做浏览器实测**，这是硬纪律。

### 预防：加了静态审计脚本

新增自检：扫描所有含 `React.use*` 的函数，检查是否被以 `Comp(props)` 形式直接调用。
当前结果：
```
含 Hook 的函数：
  TagInput          React.useState
  XiaoaiSection     useState/useEffect/useMemo/useCallback
  useRuntimeStatus  useState/useEffect/useCallback
检查直接调用：
  useRuntimeStatus  ← 自定义 Hook，按约定直接调用，正确
  XiaoaiSection     ← 仅 XiaoaiSectionBound 转发（本身无 Hook），正确
✅ 无违规
```

---

## 8. 浏览器实测记录（本次已执行）

| 检查项 | 结果 |
|--------|------|
| 面板渲染 | ✅ `.xiaoai-section` 存在，`xiaoai-*` 元素 **424** 个 |
| 6 个分组 | ✅ 全部渲染 |
| 默认展开 | ✅ 清空存储后 ①② 展开、③④⑤⑥ 折叠 |
| 折叠持久化 | ✅ 展开③后 localStorage 更新为 `["session","access","behavior"]` |
| 下拉（`<select>`） | ✅ 5 个，带真实数据（7 工作区 / 4 预设） |
| 开关 | ✅ 5 个 |
| chip 输入框 | ✅ 13 个 |
| 粘贴拆分 | ✅ 半角+全角逗号都拆开 |
| 脏点（折叠组） | ✅ 圆点 + 边条 + 底部计数 |
| 保存往返 | ✅ 服务端回读一致，无数据丢失 |
| 撤销修改 | ✅ 脏状态清空、按钮 disabled |
| 行内钳制提示 | ✅ 「最小 2000 毫秒，已按 2000 处理」 |
| 控制台 React 错误 | ✅ **0 个**（仅有一条与本插件无关的 `conversation.chat.turnTail` 预存在错误） |

---

## 9. 字段 → 分组速查（38 全覆盖核验）

用脚本从 `buildSettingsSchema` 提取权威字段表，与实现比对：
```
schema 字段数: 38
SETTING_DEFAULTS 缺:                （无）
renderSettingsForm 未出现:          onboarded   ← 设计规定隐藏
意外缺失:                           （无）
buildPatch 字段数:                  37
```

| 组 | 字段 |
|----|------|
| ① 会话与模型 | `workspace` `agentPreset` `provider` `model` `sessionReuse` |
| ② 接入音箱 | `enabled` `userId` `password` `did` `deviceModel` `ttsCommand` `wakeUpCommand` |
| ③ 音箱行为 | `aiModeEnabled` `pollIntervalMs` `maxReplyChars` `replyTimeoutMs` `callAIKeywords` `wakeUpKeywords` `exitKeywords` `exitKeepAliveAfter` `localCommandsEnabled` `triggerKeywords` `progressAfterSeconds` |
| ④ 提示语 | `onEnterAI` `onExitAI` `onAIAsking` `onAIReplied` `onAIProgress` `onAIError` `onAIErrorNetwork` `onAIErrorAuth` `onAIErrorTimeout` |
| ⑤ 高级 / 桥接 | `ignorePatterns` `historyLimit` `verboseLog` `dshApiUrl` `dshApiToken` |
| ⑥ 状态与日志 | （纯展示，无表单字段） |
| **隐藏** | `onboarded` —— 仅内部状态，`buildPatch` 不发它 |

---

## 10. 顺带修复的既有 bug

### `buildPatch` 数值钳制语义错误

原实现：
```js
patch.pollIntervalMs = poll >= 2000 ? Math.floor(poll) : 2000;
```
看起来对，但配合**行内提示**就矛盾了 —— 我第一版按「低于下限回退默认值」写，
结果是：用户填 500 → 提示说「已按 2000 处理」→ 实际落盘 **4000**（默认值）。
**提示与落盘值不一致**，这正是设计文档 §6.3 想消除的「静默改数」，只是换了个形式。

改为：
```js
if (!Number.isFinite(value)) patch[key] = rule.def;   // 非数字 → 默认值
else if (value < rule.min)   patch[key] = rule.min;   // 低于下限 → 钳到下限
else                          patch[key] = Math.floor(value);
```
> 这个 bug 是脚本往返测试发现的，不是人工审阅发现的。

---

## 11. 与设计文档的偏差（自行决定的点）

设计文档没写清、由实施者定的地方，逐条说明：

1. **数组分隔符放宽**：设计文档只说「逗号」。实际拆分为
   `[,，、\n\r\t]` —— 用户从文档复制关键词时这几种混用是常态。
2. **chip 支持退格删除**：设计文档只说「× 删除」。增加「输入框为空时按退格删末项」，
   连续删不丢键盘焦点流。
3. **chip 失焦落库**：设计文档没提。加了 `onBlur` 提交，
   避免用户「填了没回车就点保存」导致输入丢失。
4. **⑥ 组放在分组列表最后而非独立区块**：设计文档线框图里 ⑥ 也是分组，采纳。
5. **`fieldWarnings` 只覆盖有下限的字段**：`maxReplyChars` 下限为 1，
   实际上不会触发提示，保留规则但不显示（无实际影响）。
6. **`formatList` 保留但降级**：设计文档暗示改掉两处，实测发现它仍被导出
   （`exports.formatList` 未导出，但函数被 `renderRecent` 等只读场景需要），
   故保留并加注释禁止在 draft 使用。

---

## 12. 后续（未做，列为独立任务）

- **P3**：模型目录下拉已做（`hostOptions`）；`workspaces` 目前是**下拉+手填并存**，
  完整目录浏览器（dsh-im 的 `workspace-directory-picker.js`，200+ 行 Portal 组件）
  **未做** —— 收益/成本比不高，设计文档 §5.2 也建议列为后续。
- **P4**：视觉打磨剩余项。
- **拆文件**：`client/index.js` 已 4715 行，dsh-im 的「一关注点一模块」结构更好，
  但拆分会动构建/路径，与本次目标不正交（设计文档 §8.4 明确不建议）。

---

# 附录：任务 A + B（错误边界 + 错误诊断）

> 在 P1+P2 验收通过后追加。文件：`src/client/index.js`（4469 → 4715 行）

## A. 错误边界（`PanelErrorBoundary`）

### 为什么要有

2026-09-21 的 React #310 事故：面板整片白屏，**用户以为插件没装/坏了**。
空白是最糟的失败形态 —— 它不给任何线索。有边界至少变成
「加载失败 + 具体原因 + 重试」。

### ⚠️ 它是兜底，不是修复

两条限制必须写清楚，避免被当成"解决问题"：

1. `failed` 置位后**不会自动恢复**。点「重试」只是重置标志，
   同一个 bug 会立刻再崩一次 —— 它让故障**可见**，不让故障**消失**。
2. 只能捕获**渲染阶段**的错误。事件处理器 / 异步回调 / 定时器抛出的错误
   **不经过**它（React 的设计如此）。

### 比 dsh-im 版多的两点

| | dsh-im | 本实现 |
|---|---|---|
| 显示错误原文 | ❌ 只有"面板加载失败" | ✅ `<pre>` 显示 `error.message` |
| 排查指引 | ❌ 无 | ✅ 提示去 DSH 日志搜「dsh-xiaoai: 设置面板渲染失败」 |
| 控制台堆栈 | 隐式 | ✅ `componentDidCatch` 显式 `console.error` |

### 挂载点（关键）

```js
function XiaoaiSectionBound(props) {
  currentRpc = props.rpc;
  return h(PanelErrorBoundary, null, h(XiaoaiSection, props));
}
```

⚠️ **必须用 `h(XiaoaiSection, props)` 而不是 `XiaoaiSection(props)`** ——
后者会把 `XiaoaiSection` 的 Hook 挂到包装函数的 fiber 上，正是 #310 的成因。

### 浏览器实测

```
fiber 链探针:  section → XiaoaiSection → PanelErrorBoundary   ✅ 边界在外层
兜底 UI 渲染:  role="alert" / 标题 / 错误原文 / 指引 / 重试按钮  ✅ 全部出现
错误原文显示:  "TEST: 模拟渲染崩溃（浏览器实测）"               ✅
点「重试」:    兜底消失、面板恢复 6 组 36 行                    ✅
正常路径:      边界未误触发（442 元素正常渲染）                  ✅
```

## B. 错误诊断（`diagnoseError` + 6 条规则）

### 动机：先量了才知道该不该抄 dsh-im

Lead 建议抄 dsh-im 的 `STAGE_LABELS`（40+ 阶段）。**先评估后否决**：

| | dsh-im | 我们 |
|---|---|---|
| 连接阶段数 | 40+（各平台登录、OAuth、长轮询、webhook 注册…） | **3 段**（小米登录 → 音箱连接 → DSH 会话） |

硬套 40 个 phase label 是**为了对齐而对齐**。真正的问题是
**已有分类的准确性**，不是标签数量。故改为「把已有三分类做扎实」。

### ⚠️ 先验证，再动手 —— 实测发现两个真缺陷

拿现有正则（`runtime.js:1217`）跑 4 个真实场景：

| 场景 | 日志原文 | 现有分类 | 用户实际听到 | 问题 |
|---|---|---|---|---|
| ① | `status code 401` | Auth | 「可能需要重新登录，请在设置面板检查」 | ✅ 正确 |
| ② | `小米登录失败（检查 .mi.json 凭据）` | **Auth** | 「可能需要重新登录…」 | ❌ **误导** |
| ③ | `code 70016 验证失败` | Auth | 「可能需要重新登录…」 | ⚠️ 勉强（实为风控，要的是授权链接） |
| ④ | `status code 400` | **兜底** | 「抱歉，出错了」 | ❌ **无从下手** |

**场景② 的危害最大**：`src/xiaomi.js:132` 的文案说「检查凭据」，
暗示用户填错了；**实际**是 store 里只有 `micoapi` 段、缺 `xiaomiio` 段
（MiNA 能拉对话、MiIOT 不能播报）。用户按提示去"重新登录"**修不好** ——
因为登录本来就是好的。

**修复方式**：客户端诊断表**把这条规则排在 401 之前**。
（顺序很关键：该文案含「登录」二字，会被 401 规则误捕。）

### 6 条规则

全部来自**实测日志原文**，不是设计出来的分类：

| id | 触发 | 给用户的指引 |
|---|---|---|
| `missing-iot-credential` | 「登录失败」+ 凭据/.mi.json | 说清缺的是 MiIOT 那份 → 点「从 HA 导入」 |
| `risk-control` | 70016 / 验证失败 / notificationUrl | 说明是风控不是密码错 → 走向导拿授权链接 |
| `hardware-missing` | 400 + 获取对话/hardware | 说明缺 device.hardware → 重新导入或补型号 |
| `token-expired` | 401 / 403 / unauthor | 重新保存密码，或从 HA 导入刷新 |
| `network` | ECONNREFUSED 等 | 检查网络/代理 |
| `timeout` | aborted / timeout | 会自动重试；可调大轮询间隔 |

**识别不出时返回 `null`，不硬套结论** —— 错误原文永远保留在最上方，
诊断只是补充。硬套一个可能错的结论比不说更糟。

### 浏览器实测

```
规则单测（9 例）:  4 个真实场景 + 网络 + 超时 + 不可识别 + 空串    ✅ ALL PASS
CSS 已送达:        .xiaoai-diagnosis 等 5 条规则在注入的 <style> 中  ✅
诊断卡渲染:        3px 琥珀左边框 / 标题 600 / flex / 可见 600×103  ✅
正常路径无副作用:   无 lastError 时诊断块不渲染                     ✅
```

### 未测（诚实标注）

- ⚠️ **诊断卡在「真实 lastError 触发」下的端到端渲染未测**。
  当前连接是健康的（phase=running），无法自然产生 401/400。
  我验证了：规则映射（脚本）、样式（CSS 已送达）、结构（隔离容器真实渲染）。
  **未验证**的是"服务端出错时这条卡片确实出现在面板上"这条链路。
  要补测需要人为制造一次小米鉴权失败（如临时改错密码），**风险较高，未做**。

- ⚠️ **`src/xiaomi.js:132` 的误导性文案本身未改** ——
  该文件不在本任务写作范围内（只允许改 `src/client/index.js`）。
  客户端已通过规则优先级规避了误分类，但**服务端日志里那句"检查凭据"
  仍然误导**。建议后续单独修：区分 `!na` 与 `!iot` 两种情况，分别给文案。

---

# 追加改造：三个来自 dsh-im 对比的改进（task-6）

**日期**：2026-09-21
**来源**：`c3h3-dsh-im/plugin-src/client/` 的三个实现对比筛选
**范围**：仅 `src/client/index.js`（未动 `inject`、未动多音箱）

这三项都源自**验收报告发现的真实问题**，不是凭空加功能：

| # | 项 | 来源 | 解决的已知问题 |
|---|---|---|---|
| 1 | 并发版本栅栏 | `workspace-snapshot-fence.js` | `ui-acceptance.md` 诚实性说明 #3 的 P2 |
| 2 | 回环地址恢复 | `loopback-recovery.js` | 浏览器对本机请求的额外校验（403 类） |
| 3 | 焦点管理 | `workspace-editor.js` | 弹层关闭后焦点丢失（无障碍） |

---

## 1. 并发版本栅栏 ⭐⭐⭐

### 问题

`xiaoai/settings.update` 一直**带 revision 乐观锁**（服务端 `src/rpc.js:340-346`
把 `SettingsConflictError` 翻译成 `xiaoai/settings-conflict`），
但客户端**从不把冲突告诉用户**：

```javascript
// 改造前 —— 用户只看到一句看不懂的英文原文
catch (error) {
  setNotice({ kind: "error", text: "保存失败：" + describeError(error) });
}
```

验收员的原话（`ui-acceptance.md:380-384`）：

> 我用原生 setter 改 `<select>` 后触发的保存携带了**过期 revision**，被后端拒绝。
> ……该现象提示：**并发编辑（多标签页/多端）时 UI 缺少「版本冲突」的用户可见提示**

用户体验就是「点了保存，但值又变回去了」，完全不知道发生了什么。

### 实现

**(a) 栅栏本身** —— `useSettingsFence()`，照搬 dsh-im 的记账模型：

```
beginStatus()         记下读的版本（有写在途时返回 null，表示这份读不可信）
canCommitStatus(v)    这份读响应还能落地吗（版本没变 且 没有写在途）
beginMutation()       发起写：version++（任何在途响应就此过期）
canCommitMutation(v)  这份写响应还是最新的吗
endMutation()         写结束
```

用 `useRef` 而不是 `useState` —— 栅栏只是并发记账，**不该触发重渲染**。
dsh-im 用 `useMemo(() => Object.freeze({...}), [])` 稳定引用，这里照做。

**(b) 接进读路径** —— `loadSettings` 里守卫：

```javascript
const fenceVersion = fence.beginStatus();
const result = await call("xiaoai.settings.get", {});
if (!fence.canCommitStatus(fenceVersion)) return;   // ← 陈旧响应直接丢弃
```

**解决的问题**：慢的 `settings.get` 响应回来时，若用户已经点了保存，
旧值会把刚保存的值又刷回界面 —— 这正是验收员观察到的「值又变回去」的机制之一。

**(c) 接进写路径** —— `onSave` 里分类处理：

```javascript
const fenceVersion = fence.beginMutation();
try { /* ... */ }
catch (error) {
  if (isSettingsConflict(error)) {
    setNotice({ kind: "conflict", action: "reload", text: "配置已被其他地方修改…" });
  } else {
    setNotice({ kind: "error", text: "保存失败：" + describeError(error) });
  }
} finally { fence.endMutation(); }
```

**(d) 错误码必须活到客户端** —— 这是**最容易漏的一环**。
原 `rpc()` 在网关返回 `ok:false` 时这样抛：

```javascript
throw new Error(err.message || err.code || "RPC 调用失败");   // ⚠️ code 被丢了！
```

丢掉 `code` 的后果：`isSettingsConflict()` 无从判断，
冲突就退化成「保存失败：<英文原文>」—— **功能等于没做**。
现在改为把它挂回 Error：

```javascript
const failure = new Error(err.message || err.code || "RPC 调用失败");
if (err.code) failure.code = err.code;
if (err.details !== undefined) failure.details = err.details;   // 冲突的 expected/actual 在这里
throw failure;
```

**踩坑记录**：`details` 不是 `data`。实测 `xiaoai/settings.update` 的
`RemoteError` 形状是 `{code, message, details:{expected, actual}}` ——
我最初按 `data` 写，取不到值（虽然不影响提示文案，但属于事实错误，已改）。

**(e) 提示要带动作** —— 冲突提示不只是文字，还内嵌一个「重新加载设置」按钮
（`onReloadSettings`），点了就重新拉最新 revision + 服务端真值。
只丢一句「请刷新后重试」等于把活推回给用户。

### 浏览器实测（**真实冲突，非模拟**）

```
1. 浏览器面板持有 revision=6
2. 用 curl 从"另一个客户端"写入 → 服务端推进到 revision=7
   （模拟"另一个标签页/手机先改了"）
3. 在面板改字段 maxReplyChars=455，点「保存」
   → 出现 .xiaoai-conflict：
     "配置已被其他地方修改（可能是另一个标签页或手机），你的这次保存没有生效。
      请先重新加载最新配置，再重试。" + 按钮「重新加载设置」
   （.xiaoai-error 不存在 → 说明**没有**退化成通用错误）
4. 点「重新加载设置」
   → "已重新加载最新配置，可以再次修改并保存。"
   → 输入框变成 477（**外部客户端写的值**）、脏点清空
5. 再改 488 → 保存 → "设置已保存。"
6. 后端核对：maxReplyChars === 488，revision === 8   ✅
```

**这是完整的闭环**：冲突 → 明确提示 → 一键恢复 → 再存成功。
第 4 步尤其关键 —— 拉回的是**外部写入的值**，证明 revision 与真值都刷新了。

---

## 2. 回环地址恢复 ⭐⭐

### 问题

浏览器对 `http://127.0.0.1` 有额外的「本机/私网请求」校验（PNA 策略）。
某些环境下同源 fetch 也会被拒，而 `dsh-client-connection` 会把它包成：

```
transport failure for /api/xiaoai/<method>: HTTP 403
```

（`dsh-client-connection/lib/client.js:1131` 的 throw 点 —— 我去读了源码确认格式）

用户看到的就是「网络错误」，但**真正的原因只是地址不对**。

### 实现

**(a) 精确判定** —— `createLoopbackRecovery(error, href)`，只认这一种签名：

```javascript
/^transport failure for \/[A-Za-z0-9._~-]+\/[A-Za-z0-9_$.\/~-]+: HTTP 403$/
```

**只处理 IPv4 回环**（`127.x.x.x`）：其他主机名换成 localhost 可能解析到别处，
不是修复而是引入新故障。命中后：

```javascript
url.hostname = "localhost";   // 127.0.0.1 → localhost
```

**(b) 接到 rpc()** —— 两条路径都覆盖：

```
路径 A：fetch 直接 reject（CORS / PNA 拦截 / 连接被拒）  → catch 分支判定
路径 B：服务端/网关回 403                                → res.ok===false 时判定
```

**踩坑记录（我自己引入又修掉的 bug）**：
最初路径 B 只是「发布恢复信号」，然后继续往下 `res.json()`。
但 **403 的响应体通常是空的** —— 硬解析会抛 `SyntaxError`，
被后面的兜底分支翻译成「网关返回了非 JSON 响应（HTTP ?）」，
**把真正的原因盖掉了**。实测时看到这句才发现。

现在路径 B 判定成功就**直接抛恢复错误**，不再尝试解析 body：

```javascript
if (!res.ok && res.status === 403) {
  const recovery = createLoopbackRecovery(simulated);
  if (recovery) { publish(recovery); throw presented; }   // ← 直接抛，不解析
}
if (!res.ok) throw new Error("网关返回 HTTP " + res.status + "（" + endpoint + "）");
```

**(c) rpc → UI 的信号通路** —— rpc() 在闭包里、UI 在组件里，用一个小订阅槽连接：

```javascript
let loopbackRecovery = null;
const loopbackListeners = new Set();
publishLoopbackRecovery(r)   // 去重：同一个 url 不重复推，避免轮询刷屏
subscribeLoopbackRecovery(l) // 立即回放一次（组件挂载晚于首次失败也能看到）
```

**为什么不用 React state**：`rpc()` 可能在组件挂载**之前**就被调用
（`createStatusSource` 首次 `getSnapshot`），那时还没有 setState 可调。

**(d) 界面**：横幅 + 「改用 localhost 重新打开」（primary） + 「忽略」。
跳转用 `location.replace` 而不是 `assign` —— 不把已知有问题的地址留在
浏览历史里，否则用户点「后退」又回到坏状态。

### 浏览器实测

**未能自然复现**（本机请求是成功的）。用 fetch 拦截模拟了两种形态：

```
形态 A（fetch reject，更贴近真实 PNA 行为）：
  拦截 /api/xiaoai/* → Promise.reject(new Error("transport failure for /api/…: HTTP 403"))
  → 横幅出现：
    "当前地址（http://127.0.0.1:3080）与浏览器的本机请求校验不兼容，导致请求被拒绝。"
  → 按钮 ["改用 localhost 重新打开", "忽略"]，目标 title="http://localhost:3080/"  ✅
  → 保存报错文案也清晰："保存失败：当前地址与浏览器的本机请求校验不兼容。
     请使用上方按钮改用 localhost 重新打开。（loopback-recovery-required）"   ✅
     （修掉 bug 之前这里是"非 JSON 响应" —— 印证了上面的踩坑记录）

形态 B（服务端回 403）：同样出横幅，目标 URL 正确           ✅
点「忽略」→ 横幅消失，面板仍健康（445 个元素）              ✅
```

⚠️ **诚实标注**：**真实浏览器 PNA/CORS 拦截未复现**（本机环境产生不了）。
验证的是「判定逻辑 + 两条错误路径 + 界面渲染 + 跳转 URL 计算」。

---

## 3. 焦点管理 ⭐

### 问题

弹层/大块内容关闭后，焦点掉到 `<body>`，键盘用户得从头 Tab 一遍
（WCAG 2.4.3 焦点顺序）。

### 实现

照搬 dsh-im 的 `queueMicrotask` 手法：

```javascript
function scheduleFocus(ref) {
  queueMicrotask(() => {
    const node = ref && ref.current;
    if (node && typeof node.focus === "function") node.focus();
  });
}
```

**为什么是 `queueMicrotask`**：调用点通常在 `setState` 之前，
此刻 DOM 还没提交，目标按钮可能已被卸载重建 —— 直接 `.focus()`
会落到旧节点上（表现为「焦点还是丢了」）。微任务在本次渲染提交后运行。

两个场景：

```
① 向导    「重新接入 / 更换音箱」(ref) → 向导 → 「关闭向导」/「进入设置」
          → closeWizard()：setShowWizard(false) + scheduleFocus(wizardTriggerRef)
② 日志    「查看日志」(ref) → 展开 → 「收起日志」→ scheduleFocus(logsTriggerRef)
```

顺带给 `Button()` 加了 `options.ref` 透传，并给日志切换按钮补了
`aria-expanded`（顺手的无障碍改进）。

**一个刻意的顺序调整**：`closeWizard` 一开始定义在 `showWizard` 声明**之前**。
虽然回调只在挂载后执行、实际不会踩 TDZ，但那依赖隐式时序 ——
已把它挪到 `showWizard` 之后，让顺序在源代码层面就是安全的。

### 浏览器实测

```
① 向导：点「重新接入 / 更换音箱」→ 向导出现（h3="接入小米音箱"）
        → 点「关闭向导」→ 向导消失
        → document.activeElement === 那个触发按钮
          {activeTag:"BUTTON", activeText:"重新接入 / 更换音箱", isTriggerButton:true}   ✅

② 日志：展开「⑥ 状态与日志」→ 点「查看日志」→ .xiaoai-logs 出现，aria-expanded="true"
        → 点「收起日志」→ .xiaoai-logs 消失，aria-expanded="false"
        → document.activeElement === 「查看日志」按钮  {focusIsToggle:true}              ✅
```

---

## 未测 / 已知限制（诚实标注）

| 项 | 状态 |
|---|---|
| 真实浏览器 PNA/CORS 拦截 | ⚠️ **未复现**（本机产生不了），用 fetch 拦截模拟 |
| 多标签页**真实**并发 | ⚠️ 用"curl 模拟第二个客户端"代替；真实双标签页未测 |
| Revert 按钮在冲突后的语义 | ⚠️ 未测（冲突后点「撤销修改」应回到 baseline，未验证） |
| 焦点在**首次接入**向导（notConfigured=true）的退出 | ⚠️ 未测 —— 该分支没有"关闭向导"按钮（无出口，属既有设计），焦点管理不适用 |

## 安全边界（本次改动遵守的约束）

- ✅ **只改了 `src/client/index.js`**（+ 本文件）
- ✅ **`inject` 数组未动**（仍是 `["slots","remote"]`）
- ✅ **未做多音箱改造**（那是 task-5/task-7）
- ✅ **未重启 DSH**（构建后浏览器硬刷新即生效，插件是软链）
- ✅ 无新增依赖、无新增 RPC 端点（纯客户端行为改进）

## 回归确认

```
node --check src/client/index.js     ✅ 语法通过
node scripts/build.mjs               ✅ 已同步 10 个文件 + 断链自检通过
浏览器硬刷新后                        ✅ 面板 442 个元素 / 6 组齐全 / 无 React #310
正常保存链路                          ✅ 改 488 → 保存成功 → 后端 revision=8 确认
控制台                                ✅ 仅 2 条宿主 shell 的已知 P2-1 报错（与本插件无关）
```

**Hook 规则**：本次新增 `useSettingsFence()` / `useState(recovery)` /
两个 `useRef` / 一个 `useEffect` / 两个 `useCallback`，
**全部在 `if (wizardActive) return` 之前**（该 early return 在文件 4477 行附近，
新 Hook 都在 3760-3810 之间）。已用静态扫描确认，并由浏览器实测确认无 #310
—— 但按前一位实施者的教训，**静态检查不足以证明**，真正的证据是上面的浏览器实测。
