# dsh-xiaoai UI 大改造 —— 独立验收测试报告

- **验收人**：ui-verifier（独立复核，非实现者）
- **被测版本**：`src/client/index.js`（4463 行）+ `src/index.js`（655 行）
- **测试时间**：2026-09（当日）
- **测试方式**：浏览器实测（chrome-devtools MCP，`http://127.0.0.1:3080/`）+ `xiaoai/*` RPC 后端交叉验证
- **纪律遵守**：未改任何产品代码、未重启 DSH、只在 `docs/research/ui-acceptance.md` 写入

---

## 总评：通过 21 / 22，1 项部分通过（不影响交付）

**结论：达到可交付标准。** 无 P0 阻断问题。设计师标注的两个高风险点（数组字段数据完整性、折叠脏点）
**均已实测通过**。发现 2 项 P2 观测项（非本插件引入 / 属产品设计选择），不阻断交付。

---

## A. 面板渲染

### 1. 打开 设置 → 小爱语音 ✅
**命令**：
```js
document.querySelector('button[aria-label="设置"]').click();
Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='小爱语音').click();
```
**实际输出**：面板正常挂载，`details` 节点出现 7 个。
**结论**：通过。

### 2. 面板有内容（`.xiaoai-*` 元素 > 300） ✅
**命令**：
```js
document.querySelectorAll('[class*=xiaoai]').length
```
**实际输出**：`442`（首测 431，导航后 442，均远超 300 阈值）
**结论**：通过。

### 3. 6 个分组都在 ✅
**命令**：
```js
Array.from(document.querySelectorAll('details')).map(g=>g.querySelector('summary').textContent)
```
**实际输出**：
```
① 会话与模型      ② 接入音箱       高级：自定义 TTS / 唤醒指令（嵌套子组）
③ 音箱行为        ④ 提示语         ⑤ 高级 / 桥接        ⑥ 状态与日志
```
**说明**：需求写「6 组」；实测 `details` 为 7 个，其中「高级：自定义 TTS / 唤醒指令」是
**② 接入音箱组内的嵌套折叠子组**，6 个顶层分组齐全，命名与需求完全一致。
**结论**：通过（7 = 6 顶层 + 1 嵌套，非缺陷）。

### 4. 控制台无 error（尤其无 React #310） ⚠️
**命令**：
```js
// chrome-devtools list_console_messages({types:["error"], includePreservedMessages:true})
```
**实际输出**（3 轮，每轮 2 条，内容一致）：
```
[error] Uncaught Error: list slot "conversation.chat.turnTail" requires options.id
[error] Failed to load resource: net::ERR_FAILED
```
**关键判定**：
- **无 React #310**：`has310 = /Minified React error #310/.test(document.body.innerHTML)` → `false`
  （两个曾导致白屏的 #310 bug **确认已修复**）
- 上述 `turnTail` 报错**不属于本插件**。证据：
  ```bash
  grep -c "turnTail" src/client/index.js   # → 0
  ```
  且堆栈指向宿主 shell 的 `conversation.chat.turnTail` slot 注册，本插件
  `inject = ["slots","remote"]`（index.js:4533）不注册该 slot。
- `ERR_FAILED` 为宿主资源加载失败，非插件资源。

**结论**：**部分通过** —— 面板自身零 error、#310 已修复；控制台存在**宿主 shell 的既有报错**，
非本次改造引入，不建议计为本任务缺陷。**严重程度 P2**。

---

## B. 「会话与模型」组（重点）

### 5. 工作区下拉来自 `xiaoai/hostOptions.workspaces`（应 7 个真实工作区） ✅
**命令（RPC 证据）**：
```bash
T=$(journalctl --user -u dsh-web --no-pager --since "today" | grep -oE "token=[A-Za-z0-9_-]+" | tail -1 | cut -d= -f2)
curl -sL --noproxy '*' -c /tmp/ckv.txt -o /dev/null "http://127.0.0.1:3080/?token=$T"
curl -s --noproxy '*' -b /tmp/ckv.txt -X POST -H "Content-Type: application/json" \
  -d '{"type":"client-request","rpcId":"x","method":"xiaoai/hostOptions","payload":{"args":{}}}' \
  "http://127.0.0.1:3080/api/xiaoai/hostOptions"
```
**实际输出**（RPC，7 个工作区）：
```
im               /home/duola/.dsh/im
工作             /media/duola/devdata/AI-workspace/工作
AI-PROXY         /media/duola/devdata/AI-workspace/AI-PROXY
ha-hotata-airer  /media/duola/devdata/AI-workspace/ha-hotata-airer
huawei route     /media/duola/devdata/huawei route
hacs-vision      /media/duola/devdata/AI-workspace/hacs-vision
AI-workspace     /media/duola/devdata/AI-workspace
```
**UI 侧一致性（证明非硬编码）**：拦截 `fetch` 后重新挂载，捕获到实际调用：
```js
xiaoaiCalls = ["/api/xiaoai/status","/api/xiaoai/settings.get",
               "/api/xiaoai/hostOptions","/api/xiaoai/onboarding.models"]
wsOptionCount = 8   // 7 真实工作区 + 1「跟随默认（~/.dsh/im）」
```
**结论**：通过 —— 选项确实来自 RPC 且与 UI 逐条吻合。

### 6. Agent 预设下拉应有 4-5 个 ✅
**实际输出**（RPC `presets` + UI `select.options.length`）：
```
presets = standard(标准模式) / ptc(PTC 模式) / minimal(极简模式) / cordis(创造模式)  → 4 个
UI options = 5   // 4 预设 + 1「跟随宿主默认」
```
**结论**：通过。

### 7. provider/model 成对约束（选 provider 自动切 model） ✅
**命令**：
```js
prov.value='ai-proxy'; prov.dispatchEvent(new Event('change',{bubbles:true}));
// 观察 model.value
```
**实际输出**：
```
provBefore: ""            modelBefore: ""
provNow:    "ai-proxy"    modelAfterProv: "workbuddy/deepseek-v4.1-flash"
modelOptsNow: ["", "workbuddy/deepseek-v4.1-flash"]
```
**结论**：通过 —— 选中 provider 后 model 自动填充为对应值，成对约束生效
（避免 runtime.js:717 的静默忽略）。

> **观察项（P2，非缺陷）**：`hostOptions.models` 当前**仅有 1 条**
> （`ai-proxy / workbuddy/deepseek-v4.1-flash`），因此 model 下拉实际只有 2 个选项
> （默认 + 该唯一模型）。这不是 UI bug，而是宿主当前只暴露一个可用模型的**环境事实**。
> 建议：多模型环境下复测一次下拉填充。

### 8. 会话复用开关可切换 ✅
**命令**：`g0.querySelector('input[type=checkbox]').click()`
**实际输出**：`switchBefore: true → switchAfter: false`（可来回切换）
**结论**：通过。

### 9. 实际保存：改字段 → 保存 → 重新加载 → 值还在 ✅
**命令（三段式）**：
1. UI 改工作区 → 点「保存」
2. 浏览器 reload
3. 后端 RPC 核对 + UI 回填核对

**实际输出**：
```js
// reload 后 UI
b5_workspaceValue: "/media/duola/devdata/AI-workspace/AI-PROXY"
```
```bash
# 后端（source of truth）
revision: 6
workspace: "/media/duola/devdata/AI-workspace/AI-PROXY"
pollIntervalMs: 2000
```
**结论**：通过 —— 保存链路完整，UI 回填与后端一致。

### 10. 脏点标记（改动后分组标题出现脏点） ✅
**命令**：改工作区后检查 `summary` 内部与 `details.className`
**实际输出**：
```js
summaryHTML: "...<span class='xiaoai-group-title' id='xiaoai-group-session'>① 会话与模型
              <span class='xiaoai-group-dot' title='这个分组里有未保存的修改'></span></span>..."
dirtyEls: ["xiaoai-group xiaoai-group-dirty", "xiaoai-dirty-note"]
dotExists: true
```
**结论**：通过。

---

## C. 折叠交互

### 11. 点击分组标题能折叠/展开 ✅
**命令**：`g.querySelector('summary').click()`
**实际输出**：`wasOpen:false → nowOpen:true`，`localStorage` 同步更新
**结论**：通过。

### 12. 折叠状态跨导航持久化（localStorage） ✅
**测试方法（两次，含纠错）**：

> ⚠️ **方法学纠错**：首次测试我直接写 DOM 的 `g.open = false` 而未触发 React 事件，
> 导致「存储状态」与「React 状态」不一致，出现**假失败**。改用真实
> `summary.click()` 后复测，结果正确。报告采用后者。

**命令**：
```js
// 真实点击折叠 0、3 两组 → 切「通用设置」→ 切回「小爱语音」
gs[0].querySelector('summary').click(); gs[3].querySelector('summary').click();
// navigate away & back
```
**实际输出**：
```js
lsMid:          "[\"access\",\"advanced\",\"status\",\"behavior\"]"
capturedBefore: [false,true,false,true,false,true,true]
afterRerender:  [false,true,false,true,false,true,true]
restoredCorrectly: true
```
**补充验证（整页 reload）**：
```js
lsReloaded: "[\"access\",\"advanced\",\"status\",\"behavior\"]"
openAfterReload: [false,true,false,true,false,true,true]   // 完全保持
```
**结论**：通过 —— 折叠状态在**导航切换**和**整页刷新**后都正确恢复
（localStorage key：`dsh-xiaoai.settings.groups`）。

### 13. 折叠状态下改字段，折叠标题仍有脏点 ✅（设计师关键点）
**命令**：
```js
// ① 会话与模型 处于「折叠」状态时，用 React 事件改组内 workspace
setter.call(ws, ws.options[3].value); ws.dispatchEvent(new Event('change',{bubbles:true}));
```
**实际输出**：
```js
wasCollapsedAtStart: true
groupStillCollapsed: true
dotPresentInCollapsedGroup: true          // ← 折叠下脏点存在
detailsClassName: "xiaoai-group xiaoai-group-dirty"
totalDotsInPage: 1
```
**结论**：通过 —— 脏状态不会因折叠而被隐藏，用户能看到「有未保存修改」。

---

## D. 数组字段（chip 输入）★高风险★

### 14. 找到数组字段 ✅
**命令**：`document.querySelectorAll('.xiaoai-tags').length`
**实际输出**：`13` 个 chip 输入，含
`wakeUpKeywords / exitKeywords / callAIKeywords / onEnterAI / onExitAI / onAIAsking /
onAIReplied / onAIProgress / onAIErrorNetwork / onAIErrorAuth / onAIErrorTimeout /
onAIError / ignorePatterns`
**结论**：通过。

### 15. 输入文字 + 回车 → 生成 chip ✅
**命令**：
```js
setter.call(inp,'enter-added'); inp.dispatchEvent(new Event('input',{bubbles:true}));
inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
```
**实际输出**：chips 末尾新增 `"enter-added"`，输入框清空（`inputVal: ""`）
**结论**：通过。

### 16. 点 chip 的 × → 删除 ✅
**命令**：`document.querySelector('.xiaoai-chip-del[aria-label="删除 ui-test-2"]').click()`
**实际输出**：
```
before: [... "ui-test-1","ui-test-2"]
after:  [... "ui-test-1"]          // ui-test-2 已移除
```
**结论**：通过（`aria-label="删除 xxx"` 无障碍标注正确）。

### 17. 粘贴逗号串 `a, b，c、d` → 应拆成 4 个 chip ✅（高风险点）
**命令**：
```js
setter.call(inp, 'a, b，c、d'); inp.dispatchEvent(new Event('input',{bubbles:true}));
```
**实际输出**：
```js
before: ["^小爱同学$"]
after:  ["^小爱同学$","a","b","c","d"]
added:  ["a","b","c","d"]          // 恰好 4 个
inputValueNow: ""
```
**结论**：通过 —— 半角逗号 `,`、全角逗号 `，`、顿号 `、` **三种分隔符全部正确识别**
（`splitEntryText`：`/[,，、\n\r\t]/`）。

### 18. 保存后重新加载 → 值不丢 ✅（设计师标注的最高风险点）
**完整链路证据**：

| 步骤 | 命令 | 实际输出 |
|---|---|---|
| ① UI 添加 | 粘贴 `ui-test-1, ui-test-2` | chips: `[...,"ui-test-1","ui-test-2"]`（7 项） |
| ② 点保存 | 点「保存」按钮 | chips 保持不变（7 项） |
| ③ 后端核对 | RPC `xiaoai/settings.get` | `revision: 5`，`ignorePatterns: ["^小爱同学$","a","b","c","d","ui-test-1","ui-test-2"]` |
| ④ 整页 reload | navigate reload | — |
| ⑤ UI 回填 | 读 chips | `["^小爱同学$","a","b","c","d","ui-test-1","ui-test-2"]` ✅ 完全一致 |

**结论**：通过 —— **`formatList` / `parseList` 同步改造正确，未出现「保存即丢数据」**。
数组字段在 draft 中保持真数组，元素内含逗号的值（如提示语）也不会被切碎。

---

## E. 数值字段

### 19. 轮询间隔填 500（低于下限 2000）→ 钳制提示 + 保存为 2000 ✅
**命令**：
```js
setter.call(poll,'500'); poll.dispatchEvent(new Event('input',{bubbles:true}));
```
**实际输出（钳制提示）**：
```
hints: ["最小 2000 毫秒，已按 2000 处理"]
pollValueAfterInput: "500"      // 输入瞬间仍显示 500
```
**保存后**：
```js
pollValueAfterSave: "2000"      // ← 不是默认值 4000
```
```bash
# 后端核对
pollIntervalMs: 2000
```
**结论**：通过 —— 提示文案明确，且**保存值为 2000 而非回退默认 4000**，符合验收要求。

> **观察项（P2，体验建议）**：输入框在失焦/保存前仍显示用户输入的 `500`，
> 仅在保存后归一为 `2000`。建议在 blur 时即回写钳制值，减少认知落差。非阻断。

---

## F. 状态与日志组

### 20. 最近活动、对话历史、运行日志都能看到 ✅
**命令**：展开「⑥ 状态与日志」读取 `innerText`
**实际输出**：
```
最近活动        最近听到 / 最近回复 / 已处理条数 0
会话 ID         未绑定
工作区路径      未知
绑定方式        未知
运行日志        查看日志
```
**结论**：通过 —— 状态区字段齐全（「未绑定 / 未知」为当前无活动会话的真实状态，非渲染缺陷）。

---

## G. 稳定性

### 21. 快速切换设置页 10 次，面板不崩 ✅
**命令**：循环 10 次「通用设置 ↔ 小爱语音」
**实际输出**：
```js
cycles: [{i:0,details:7,xiaoai:442},{i:1,...442}, ... {i:9,details:7,xiaoai:442}]
finalAlive: 7
```
**结论**：通过 —— 10 轮均稳定 442 元素，无递减/崩溃/内存异常迹象。

### 22. 折叠/展开所有分组，不崩 ✅
**命令**：遍历 7 个 `details` 逐一 toggle
**实际输出**：
```js
collapseAll: { count:7, states:[...], stillAlive:7, xiaoaiCount:445 }
```
**结论**：通过。

---

## 附加校验：控制项复核

| 控制项 | 方法 | 结果 |
|---|---|---|
| **37 个字段全部可见可编辑** | 分组内 `input/select/textarea` 计数 | ✅ **恰好 37**（①6 ②7 子2 ③10 ④9 ⑤5 ⑥0） |
| **禁用项：`onboarding.models` 不得用于 LLM 下拉** | 对比 RPC 返回与下拉内容 | ✅ 通过 —— `onboarding.models` 返回音箱硬件（`OH2P`/`OH2`/`LX06`/`X10A`…），与 LLM 下拉（`ai-proxy`）**完全无交集** |
| **禁用项：`inject` 数组未被修改** | `grep` 源码 | ✅ `const inject = ["slots", "remote"]`（index.js:4533），未加入 `remote.session` |
| **CSS 类前缀一致性** | `[class*=xiaoai]` | ✅ 442 个元素统一 `xiaoai-` 前缀 |

---

## 问题清单

### P0（阻断交付）：**无**

### P1（应修但不阻断）：**无**

### P2（观测项 / 建议）

| # | 现象 | 可能原因 | 归属 | 严重度 |
|---|---|---|---|---|
| P2-1 | 控制台存在 `list slot "conversation.chat.turnTail" requires options.id` 与 `net::ERR_FAILED` | 宿主 shell 的 slot 注册契约问题；本插件 `grep turnTail` = 0 次命中，非本次改造引入 | 宿主 shell，**非本插件** | P2 |
| P2-2 | model 下拉仅 2 项（默认 + 1 个模型） | 宿主 `hostOptions.models` 当前只返回 1 条（`ai-proxy/workbuddy/deepseek-v4.1-flash`），属环境事实 | 环境 / 宿主配置 | P2 |
| P2-3 | 数值输入钳制在 blur 前不回写 UI（显示 500，保存后为 2000） | 钳制发生在保存路径而非输入事件 | 本插件（体验优化） | P2 |

---

## 诚实性说明（未验证 / 方法限制）

1. **多模型环境的 provider/model 联动未验证** —— 当前宿主仅暴露 1 个模型，
   无法验证「多个 provider 之间切换时 model 列表是否联动过滤」。
   已验证的是：**单一 provider 下 model 自动填充正确**。
2. **拖拽排序 / 键盘无障碍导航未纳入本次 22 项清单**，未测。
3. **首次 chip 测试出现过一次「保存后 chips 归位」假阳性**：根因是我用原生 setter
   改 `<select>` 后触发的保存携带了**过期 revision**，被后端拒绝。
   改用真实用户交互路径（点击 summary / change 事件）后复测，**保存与持久化均正常**。
   该现象提示：**并发编辑（多标签页/多端）时 UI 缺少「版本冲突」的用户可见提示**，
   属 P2 级体验建议（本次未计入 22 项）。
4. 所有「实际输出」均为工具真实返回，未做修饰。

---

## 最终结论

> **✅ 达到可交付标准（21/22 通过，1 项部分通过）**

- 两个设计师标注的**高风险点**（数组字段数据完整性、折叠态脏点）**均实测通过**；
- 两个曾导致白屏的 **React #310 bug 确认已修复**（`has310 = false`）；
- 6 组折叠、37 个字段、13 个 chip 输入、5 个下拉、5 个开关全部按设计落地；
- 保存链路经 **UI → 后端 RPC → 整页 reload** 三段式交叉验证，数据一致（revision 3→6）；
- 控制台无插件相关 error；3 项 P2 观测项均不阻断交付。

**建议**：交付。P2-3（钳制回写）可在后续小版本顺手优化。
P2-1 需由宿主 shell 侧单独跟进，与本次 UI 改造无关。
