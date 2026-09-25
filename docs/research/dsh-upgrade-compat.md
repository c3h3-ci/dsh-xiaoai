# DSH 升级兼容性排查（0.1.6-alpha.2 → 0.1.7-rc.2）

> 2026-09-25。升级前的逐项 API 核实。

## 一、版本情况

```
当前:        0.1.6-alpha.2
候选升级:    0.1.7-alpha.1 / 0.1.7-alpha.2 / 0.1.7-rc.1 / 0.1.7-rc.2
npm latest:  0.1.5-rc.3   ← ⚠️ npm 的 latest 标签指向【旧版】，别被误导
```

**说明**：`@deepseek-ai/dsh` 的 npm `latest` 标签停在 0.1.5-rc.3，
但实际有 0.1.7-rc.2。升级要用**显式版本号**，不能 `npm i @deepseek-ai/dsh`。

**建议**：升到 **0.1.7-rc.2**（RC 比 alpha 稳定，且是当前最高版本）。

## 二、插件依赖的 DSH API（逐项核实）

插件的关键依赖点，全部对照 0.1.7-rc.2 的源码核实：

| # | 插件用的 API | 用途 | 0.1.7-rc.2 状态 |
|---|---|---|---|
| 1 | `ctx.systemPrompt.section({name, order, text})` | **语音播报约束注入** | ✅ 存在，签名一致（`lib/index.js:240`）|
| 2 | `ctx.systemPrompt.getSectionOrder(name)` | 取标准 order | ✅ 存在 |
| 3 | `suppressRuntimeContext()` | 抑制运行时上下文 | ✅ 存在（`:230`）|
| 4 | `createOptions.setup(agentCtx, agent)` | 预设挂载回调 | ✅ 一致：`setup?.(prepared.agent.ctx, prepared.agent)`（`agent-loop:1874`）|
| 5 | `agent.ctx` | 拿 agent 的上下文 | ✅ 同上（setup 的第一参数即它）|
| 6 | `host.agents.create(options)` | 建 agent（路线 C）| ✅ 存在（`agent/lib/index.js` 的 `async create(`）|
| 7 | `agents.get(sessionId)` | 取已有 agent | ✅ 存在（`get(`）|
| 8 | `agents.ensureSession(...)` | 唤醒/认领会话 | ⚠️ 未在 0.1.7 包中找到同名方法（**需实测**）|
| 9 | `host.agentPresets.mount/resolve` | 挂载 Agent 预设 | ⚠️ `dsh-agent-presets` 包未在本次下载成功（**需补验**）|
| 10 | `host.typertGateway.invoke(...)` | RPC 网关（路线 B）| ⚠️ 需在升级后实测 |
| 11 | `host.sessionController` | 会话控制 | ⚠️ 同上 |
| 12 | `systemPrompt.assemble()` 的调用路径 | 12 秒准备时间所在 | ✅ `preStep` 实现【逐行相同】（`agent-loop:902`）|

## 三、兼容性评估

### ✅ 高置信度兼容
```
1. systemPrompt.section / getSectionOrder / suppressRuntimeContext
   → 签名与行为逐行一致，语音约束注入不受影响
2. setup 回调契约（agentCtx, agent）
   → setupAndPublish 的调用点代码完全相同
3. preStep / assemble 路径
   → 逐行相同，性能特征不变（仍是每 turn 全量组装）
```

### ⚠️ 需要升级后实测的
```
1. agents.ensureSession —— 未在 0.1.7 的 dsh-agent 里搜到同名方法
   影响：会话复用路径（#attachAgent 的 adopted 分支）
   降级：该方法不存在时 #attachAgent 会走 throw（"会话已建但拿不到 agent 句柄"）
   缓解：插件已有 try/catch 与日志，会退到新建会话
2. host.agentPresets（预设挂载）
   → dsh-agent-presets 包本次未下载成功，需补验
3. host.typertGateway / sessionController（RPC 路线 B）
   → #ensureAgent 会先试路线 B；不可用则自动回退路线 C
   （插件已有这条降级链）
```

## 四、升级风险评估

| 风险 | 等级 | 依据 |
|---|---|---|
| 语音约束失效 | 🟢 低 | section API 逐行相同 |
| 预设挂载失效 | 🟡 中 | 包未验证（但插件有 catch，不会崩）|
| 会话复用失效 | 🟡 中 | ensureSession 未找到（有降级）|
| 插件加载失败 | 🟢 低 | manifest/inject 未变 |
| 12 秒问题恶化 | 🟢 低 | preStep 逐行相同 |
| 数据（凭据/水位线）| 🟢 低 | 都在 `~/.dsh/xiaoai-state/`，升 DSH 不动 |

**总体：风险可控**。最坏情况是会话复用退化为"每次新建"（慢一点，但仍可用）。

## 五、升级步骤建议

```bash
# 1. 备份（必须）
cp -r ~/.dsh ~/.dsh-backup-$(date +%s)
cp -r /media/duola/devdata/AI-workspace/dsh-xiaoai-local ~/dsh-xiaoai-backup-$(date +%s)

# 2. 记录当前状态（回滚基准）
systemctl --user is-active dsh-web.service   # 应为 active
curl -s localhost:3080/api/xiaoai/status ...  # phase=running

# 3. 升级（显式版本号！不能靠 latest）
export PATH="/home/duola/.config/nvm/versions/node/v22.22.0/bin:$PATH"
npm install -g @deepseek-ai/dsh@0.1.7-rc.2

# 4. 验证 DSH 本身能起
dsh --version

# 5. 重启并观察
systemd-run --user --on-active=3 --unit=dsh-upgrade-$(date +%s) \
  systemctl --user restart dsh-web.service
# 等 90 秒，看哨兵日志

# 6. 逐项验收（见下）
```

## 六、升级后验收清单

```
□ DSH 启动成功（phase=running）
□ 插件加载（RPC 已注册: namespace=xiaoai）
□ 音箱连接（已连接音箱: Xiaomi 智能音箱 Pro）
□ 语音约束注入（日志: 已注入语音播报约束（systemPrompt.section））
□ 预设挂载（日志: 已挂载 Agent 预设: voice）
□ 家居直通（xiaoai/testDirect 返回 matched=true）
□ 会话复用（第二次对话明显更快）
□ UI 面板正常（37 字段 / 6 组）
```

## 七、回滚方案

```bash
# 如果升级后插件不可用：
export PATH="/home/duola/.config/nvm/versions/node/v22.22.0/bin:$PATH"
npm install -g @deepseek-ai/dsh@0.1.6-alpha.2
systemd-run --user --on-active=3 --unit=dsh-rollback-$(date +%s) \
  systemctl --user restart dsh-web.service
# 数据目录 ~/.dsh 未被升级修改，无需恢复
```

## 八、尚未验证的（诚实标注）

```
1. dsh-agent-presets@0.1.7-rc.2 的 mount/resolve 签名
   → 本次 npm pack 失败，未取得源码对照
2. agents.ensureSession 是否改名
   → 在 0.1.7 的 dsh-agent/lib/index.js 里没搜到，但可能换到别的包
3. typertGateway / sessionController 的接口变化
   → 需升级后实测

这些都在升级后验收清单里逐项检查，有降级路径。
```
