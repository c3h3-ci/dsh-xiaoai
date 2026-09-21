# 部署与调优记录（2026-09-21 实战）

> 本文记录把 dsh-xiaoai 从"看起来能用"变成"真正可用"的全过程，
> 包含 9 个真实 bug 的根因与修复，以及性能瓶颈的量化分析。

## 一、致命 bug：deviceId 用错（全链路不通）

### 症状
插件**从未捕获过语音**：日志里 `🎤` 恒为 0，小米云端 `records` 恒为 `[]`。
所有"测试通过"都是 `xiaoai/test` 直接注入文本 —— **真实语音链路从未验证**。

### 根因
轮询对话时 cookie 里的 `deviceId` 传错了值：

| | 值 | 来源 |
|---|---|---|
| ❌ 错误 | `DEVICE_ID_PLACEHOLDER` | MiNA **账号级** ID（从 HA 的 auth 文件导入） |
| ✅ 正确 | `cbf60488-c95d-40f8-bc6d-afbd0b673d2b` | **设备 UUID**（来自 `device_list`） |

小米的 `device_profile/v2/conversation` 接口要求**设备 UUID**；
传账号级 ID 时**接口照样返回 `code:0 Success`，但 `records` 永远为空** ——
一个**静默失败**，没有任何错误提示，因此极难发现。

### 怎么找到的
用户要求"好好对比 MiGPT"。对比它 9/19 成功时的 `.mi.json`：
```json
"device": { "deviceID": "cbf60488-c95d-40f8-bc6d-afbd0b673d2b", ... }
```
而我们的 `mi-store.json` 里 `device.deviceId` 是账号级 ID。
分别请求：账号级 → `records=0`；设备 UUID → **`records=10`**（立刻拿到真实对话）。

### 修复
```javascript
// mi-store.json
device.deviceId = "cbf60488-c95d-40f8-bc6d-afbd0b673d2b"   // 设备 UUID
device.id       = "DEVICE_ID_PLACEHOLDER"                        // 账号级 ID 另存备用
```

---

## 二、其余 8 个 bug

| # | 症状 | 根因 | 修复 |
|---|---|---|---|
| 2 | 每 2 秒 `extractAnswerText is not defined` | 多音箱改造只写了调用没写定义 | 按 MiGPT `speaker.ts:294-305` 实现 |
| 3 | 音箱念出模型英文思考过程 | `extractText` 不看 `content[].type`，把 `reasoning` 段也提取了 | 跳过 `reasoning`/`thinking`/`tool-*` |
| 4 | 语音约束从未生效 | `agentCtx.on` 不存在（setup 传的是 `agent.ctx`） | 改用 `ctx.systemPrompt.section()` |
| 5 | 约束仍不生效 | 注入点写在路线 C 的 `setup`，实际走路线 B（`#viaGateway`） | 移到 `#attachAgent`（所有路线公共出口） |
| 6 | Agent 预设从未挂载 | 同上（挂载点也选错路线） | 抽出 `#mountPreset`，3 条路径都调用 |
| 7 | `dsh-scope: already bound` | 重复挂载同一 ctx | WeakSet 防重入 + 把该错误视为成功 |
| 8 | **回答没播完就退出 AI 模式** | 倒计时从"提问"起算，而回答要 10-13 秒 + 播放 10-20 秒 | 播完后重置 + 加 MiGPT 式 `responding` 守卫 |
| 9 | 重启打断用户对话 | `stop()` 无条件立即停 | 加 20 秒宽限期，等当前对话做完 |

---

## 三、性能量化（实测 22 次采样）

### 响应时间构成

```
简单问答（复用会话）:  8-11 秒
工具调用（查设备）:    20-50 秒

拆解：
  ┌────────────────────────────────────────────┐
  │ DSH 准备（systemPrompt.assemble） ~12 秒    │ ← 63%
  │ 模型推理                           ~1.4 秒  │ ←  7%
  │ TTS 播报 + 网络                    ~2 秒    │
  │ 工具调用每多一轮                   +7 秒    │
  └────────────────────────────────────────────┘
```

### 关键测量

| 指标 | 值 | 说明 |
|---|---|---|
| 模型本身 | **1.4 秒** | 直测 ai-proxy API（cheapest/hy3/deepseek 都在 1.4-1.7s）|
| 新 turn 首次 step | **11-16 秒** | 22 次采样平均 20.6s（含异常值）|
| 同 turn 后续 step | **0.1 秒** | 工具调用后不需要重新组装 |
| 异常值 | 247.8 秒 | 插件重启打断所致 |

### 瓶颈定位（DSH 源码）

```javascript
// dsh-agent-loop/lib/index.js:883
async preStep(target, position) {
  const assembly = await this.loopCtx.systemPrompt.assemble(...);   // ⭐ 12 秒
  const sections = renderContextSections(assembly);
  ...
}
```

`assemble()` 要收集并渲染：persona + 技能列表 + Hindsight 记忆 +
其他 4 个插件的注入 + 工具指引 + 运行时上下文。

### 已做的缓解
- `includeRuntimeContext: false`（voice 预设里）—— 抑制运行时上下文快照
- 会话复用 —— 同 turn 内后续 step 只要 0.1 秒
- persona 加效率引导 —— 减少工具调用轮数

### 未做的（需权衡）
- 禁用注入插件（`dsh-weknora` / `skill-explorer` / `dsh-context`）—— 影响其他工作流
- 流式响应 —— DSH 架构限制（我们监听 `session/event` 拿到的是完整消息，非 token 流）

---

## 四、与成熟方案的对比

| 维度 | xiaogpt | MiGPT v4.2 | 本插件（修复后）|
|---|---|---|---|
| 轮询间隔 | 1000ms（动态）| 1000ms | 2000ms（下限）|
| 拉取条数 | limit=2 | limit=2 → 翻页 | limit=5 |
| 退出守卫 | — | ✅ 三重（`!responding && noNewMsg`）| ✅ 两重 |
| 认证 | cookie（绕过风控）| 账密 → token | 账密 → token |
| 流式响应 | — | ✅ | ❌ |
| deviceId | 从 cookie 取 | `account.device.deviceId` | ✅ 同上（已修对）|

**结论**：核心机制已对齐；差异主要在流式响应（架构限制）。

---

## 五、语音专用 Agent 预设

`docs/agent-preset-voice/`（部署时复制到 `~/.dsh/.agent-presets/voice/`）

```yaml
# agent.cordis.yml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: >-
      你是家里的语音助手，通过智能音箱与用户对话。回答要简短、口语化，
      能直接念出来。效率要求：先用最贴切的工具一次做对…
    includeRuntimeContext: false
- id: tool-web          # 查天气/新闻
- id: tool-ask-user     # 重操作前确认
- id: tool-bash         # shell
- id: tool-todo         # 多步任务
  config:
    allowParallelInProgress: true   # ⚠️ 必填，漏了会挂载失败
```

**注意**：HA 工具（`mcp__ha_mcp__*`）由**宿主级** `dsh-mcp-connector` 提供，
不受预设影响 —— 实测在 voice 预设下仍可控制设备（已验证）。

---

## 六、端到端验证（真实语音，北京时间）

```
20:41:10  🔊 [进入] AI模式已开启          ← 用户说"进入AI模式"
20:41:26  🔊 [思考] 让我想想
20:41:26  🎤 介绍一下自己                 ← 首次捕获语音
20:41:34  🔊 我是小U，你的智能助手…       ← 语音回答
20:41:54  🎤 查看一下邮箱状态
20:42:19  🔊 邮箱授权是正常的…            ← 真实查了邮箱
20:42:25  🔊 [退出] 已退出AI模式
```

**voice 预设生效后**：
```
system prompt: "…你是家里的语音助手，通过智能音箱与用户对话…"
回复: "你好！我是你家的语音助手，能帮你控制灯光、空调、窗帘这些设备…"
设备查询: "储藏室灯现在是关闭的，储藏室通道的灯也是关的。"（用了 ha_search）
```
