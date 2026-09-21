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
- **拆文件**：`client/index.js` 已 4469 行，dsh-im 的「一关注点一模块」结构更好，
  但拆分会动构建/路径，与本次目标不正交（设计文档 §8.4 明确不建议）。
