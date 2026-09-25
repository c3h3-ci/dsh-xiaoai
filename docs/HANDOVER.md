# 项目交接文档（2026-09-22）

> 给后续接手者：项目现状、已解决的坑、待办事项、关键信息。

## 一、这是什么

`dsh-xiaoai` —— 把**小米音箱**变成 **DSH 的语音入口**。

```
用户对音箱说话
   ↓ 小米云记录对话
插件轮询捕获（device_profile/v2/conversation）
   ↓ 交给 DSH agent
DSH 处理（可调用 HA 工具控制设备、搜索、发邮件…）
   ↓ 回复文本
插件调用小米 TTS 播报
```

## 二、当前状态：**可用**

```
✅ 全链路打通（真实语音验证过）
✅ 能听、能答、能控设备
✅ 语音人格（voice 预设）
✅ 多音箱支持（架构完成，单设备环境）
✅ AI 模式（进入/退出/超时）
⚠️ 响应 10-50 秒（DSH 准备时间占大头）
```

## 三、部署位置

| 项 | 本机（台式 DSH）| HA（192.168.3.3）|
|---|---|---|
| 插件 | `/media/duola/devdata/AI-workspace/dsh-xiaoai-local/` | `/data/dsh/workspace/dsh-xiaoai/`（容器内）|
| 状态 | ✅ 运行中（接管音箱）| ⏸️ 已禁用（`enabled: false`）|
| DSH 版本 | 0.1.6-alpha.2 | 0.1.5-rc.2 |
| 模型 | deepseek-v4.1-flash | glm-5.3-flash |

**⚠️ 两台不能同时启用**（会抢同一个小米账号的对话记录）。

## 四、必读文档（按重要性）

```
docs/DEPLOYMENT.md             ← 9 个 bug 的根因与修复（最重要）
docs/CREDENTIALS.md            ← 双服务凭据机制（最容易踩的坑）
docs/USER-GUIDE.md             ← 使用方法
docs/DSH-PLUGIN-API.md         ← DSH 插件 API 契约
docs/research/login-protocol.md       ← 小米登录协议全解
docs/research/multi-speaker-design.md ← 多音箱设计
docs/agent-preset-voice/       ← 语音专用 Agent 预设
```

## 五、九个关键坑（都踩过了）

### 1. 🔴 deviceId 必须是【设备 UUID】
```
❌ DEVICE_ID_PLACEHOLDER（账号级 ID）
✅ cbf60488-c95d-40f8-bc6d-afbd0b673d2b（设备 UUID）

传错时接口返回 code:0 Success 但 records 永远为空 —— 静默失败！
```

### 2. 🔴 DSH 的 setup 回调不会执行（路线 B）
```
#ensureAgent 优先走 #viaGateway（路线 B）
→ createOptions.setup（路线 C）永不执行
→ 任何"写在 setup 里的初始化"都失效

已踩：语音约束注入、Agent 预设挂载
修复：移到 #attachAgent（所有路线公共出口）
```

### 3. 🔴 语音约束用 `systemPrompt.section()`
```
❌ agentCtx.on("agent/request")  ← setup 传的是 agent.ctx，没有 .on
✅ ctx.systemPrompt.section({name, order, text})  ← 对齐官方 dsh-persona
```

### 4. 🔴 schemastery 没有 `.nullable()`
```
❌ z.string().nullable()  → "not a function" → 插件装配失败
✅ z.union([z.string(), z.const(null)])
```

### 5. 🔴 `extractText` 必须跳过 reasoning 段
```
助手 content 是带 type 的数组：
  [{type:"reasoning", text:"思考..."}, {type:"text", text:"答案"}]
不看 type 会把思考过程也念出来
```

### 6. 🔴 Agent 预设需要 `allowParallelInProgress`
```
@deepseek-ai/dsh-tool-todo 的该字段是必填
漏了 → 预设挂载失败但【静默忽略】
```

### 7. ⚠️ 小米需要【两份凭据】
```
micoapi  → 拉对话（听）
xiaomiio → TTS 播报（说）
缺任一份插件不可用（错误文案已区分）
```

### 8. ⚠️ 手机验证码登录走不通
```
小米风控（连 HA 也走不通）
→ 用「从 HA 导入」（已验证可靠）
```

### 9. ⚠️ HA 的 MCP 地址（易错）
```
❌ http://127.0.0.1:9584/private_xxx  （HA 容器内的 loopback，本机不可达）
✅ http://192.168.3.3:9583/cdd633723  （HA 主机地址 + secret path）
   或 http://192.168.3.3:8123/api/webhook/cdd633723
```

## 六、关键配置位置

```
插件设置:   ~/.dsh/settings.yaml 的 dsh-xiaoai 段
凭据:       ~/.dsh/xiaoai-state/mi-store.json（mina + miiot 两段）
会话状态:   ~/.dsh/xiaoai-state/xiaoai-sessions.json
水位线:     ~/.dsh/xiaoai-state/xiaoai-lasttime.json
日志:       ~/.dsh/xiaoai-state/xiaoai.log
语音预设:   ~/.dsh/.agent-presets/voice/agent.cordis.yml
MCP 配置:   ~/.dsh/storages/mcp_connector.json
profile:    ~/.dsh/profiles/web/package.json
```

## 七、性能现状（实测）

```
模型本身:        1.4 秒    （直测 ai-proxy）
DSH 准备:       11-16 秒   ⭐ 瓶颈（systemPrompt.assemble）
同 turn 后续:    0.1 秒    （复用）
──────────────────────────
简单问答:        8-11 秒
带工具调用:      20-50 秒

瓶颈源码: dsh-agent-loop/lib/index.js:883 的 preStep → systemPrompt.assemble()
```

## 八、待办

```
🅰 ha-mcp 元工具模式研究（task-8，进行中）
   · 11 个元工具 vs 75 个全量工具
   · 为什么 agent 调不通"查灯状态"

🅱 claw_assistant 研究（task-9，待派）
   · HA 上的成熟 AI Agent 框架
   · 借鉴其"反 prompt 膨胀"设计

🅲 12 秒准备时间优化（task-10，待派）
   · 禁用注入插件？缓存 assemble？

🅳 多音箱实测（需第二台音箱）

🅴 HA 版重新启用（如需 HA 接管）
```

## 九、开发约定

```bash
# 构建（src → lib）
node scripts/build.mjs

# 语法检查
node --check src/runtime.js

# 重启（必须 detached，避免打断）
systemd-run --user --on-active=3 --unit=dsh-xxx-$(date +%s) \
  systemctl --user restart dsh-web.service
# 然后等 90 秒

# 看日志（时间戳是 UTC，+8 = 北京时间）
tail -f ~/.dsh/xiaoai-state/xiaoai.log
```

**⚠️ 改完源码必须 build**（否则 lib 是旧的）。

## 十、RPC 接口

```
xiaoai/status              运行状态
xiaoai/settings.get        读设置
xiaoai/settings.update     改设置（带 revision 并发控制）
xiaoai/speakers            列出设备
xiaoai/test                自检（直接注入文本）
xiaoai/speak               让音箱说话
xiaoai/logs                读日志
xiaoai/hostOptions         宿主选项（工作区/预设/模型）
xiaoai/restart             重启轮询
xiaoai/onboarding.*        接入向导（4 个）
```

**HTTP 调用格式**：
```bash
curl -X POST "http://127.0.0.1:3080/api/xiaoai/status" \
  -H "Content-Type: application/json" \
  -d '{"type":"client-request","rpcId":"1","method":"xiaoai/status","payload":{"args":{}}}'
```
**⚠️ 需要先取 cookie**（token 每次重启都变）。

## 十一、家居直通（新增，2026-09-24）

### 问题
语音指令「储藏室灯什么状态」总是失败：agent 走 ha-mcp 的元工具链时
第①步就传空参数 `{}`，随后跑偏到 `mcp_connector_tool_search`，
最终回"没接上家里灯光那套系统"。耗时 58-80 秒，成功率 0%。

### 解法
`src/runtime.js` 新增 `#tryHomeAssistantDirect()`，把三步写死在代码里：
```
正则识别（查状态/开/关）→ 抠设备名 → ha_search
  → 按 domain 优先级选实体（light > switch > fan > climate ...）
  → ha_call_read_tool / ha_call_write_tool → 播报
```
配置：`haDirectEnabled: true` + `haMcpUrl: "http://192.168.3.3:9583/cdd633723"`

### ha-mcp 元工具的正确调用（踩过的坑）
```
① ha_search         {"query": "<设备名>", "limit": 5}      → entities[]
② ha_search_tools   {"query": "state"}                      ← query 必填！
③ ha_call_read_tool {"name": "ha_get_state",
                     "arguments": {"entity_id": "light.xxx"}}
                     ↑ 参数名是 name，不是 tool_name
   控制设备用 ha_call_write_tool + ha_call_service：
     {"name": "ha_call_service",
      "arguments": {"domain": "light", "service": "turn_on",
                    "entity_id": "light.xxx"}}
      ↑ entity_id 直接放顶层，不是 target:{entity_id}
```

### 实体选择的陷阱
搜"储藏室灯"会返回 5 个 score 都是 100 的实体（friendly_name 都含该词）：
device_tracker（设备追踪）/ light（真灯）/ select（开关）/ sensor×2（网络）
→ 必须按 domain 优先级选，只认能开/能关/能读状态的域。

### 效果
查状态 58 秒 → 约 2 秒，成功率 0% → 100%（实测两分支全通过）。

## 十二、跨机部署的凭据刷新（2026-09-25）

### 问题（反复出现 4 次，每次都要人工修）
小米 serviceToken 约 2 天过期。插件本有自动刷新，但**总是失败**：
```
[2026-09-24T16:56] 连续失败 3 次，尝试刷新凭据并重连…   ← 触发了
[2026-09-25T01:16] 凭据同步: 未能从 HA 读取到 USER_ID_PLACEHOLDER 的认证缓存  ← 读不到
[2026-09-25T01:16] [Xiaomi 智能音箱 Pro] 连接失败
```

### 根因
`token-refresh.js` 只支持**本地文件系统**读 HA 的 .storage：
```js
const HA_STORAGE_CANDIDATES = ["/config/.storage", "/data/homeassistant/.storage"];
```
这是为「插件跑在 HA addon 容器内」设计的。当前部署是
**台式 DSH + 远程 HA(192.168.3.3)** —— 本机没有这些路径。

### 修复
1. 新增 `remoteConfig(options)` + `readRemoteFile()`：用 sshpass 在 HA 主机上
   `docker exec <container> cat <file>` 读回内容；**本地优先，失败落远程**。
2. `mergeFreshTokens(storePath, uid, log, options)` 增加第 4 个参数。
3. `runtime.js` 两处调用传 `{ remote: this.#config.haRemote }`。
4. 新增配置项：
```yaml
dsh-xiaoai:
  haRemote:
    host: "192.168.3.3"
    user: "root"
    password: "***"
    container: "homeassistant"
```

### 验证
```
mergeFreshTokens(..., { remote: {...} })
→ {"refreshed": true}
→ 日志: "mina token 已刷新 | miiot token 已刷新"
```

### 意义
token 过期后**自动**恢复，不再需要人工跑 import 脚本（此前已人工修 4 次）。
同机场景（addon）行为不变（本地优先，零额外开销）。
