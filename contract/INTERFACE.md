# dsh-xiaoai 接口契约 (v0.1)

本文件由架构负责人维护，是所有并行工作块的**唯一接口真相**。
任何一方需要改动接口，必须先改这里，再改代码。

## 1. 职责边界

```
小米音箱 ──► XiaomiSpeaker (src/xiaomi.js)  ──► XIAOAI_RUNTIME  ──► DSH /api/session
   ▲              [已完成, 冻结]                 [本契约]                [已存在]
   └────────────── XiaomiSpeaker.say() ◄────────┘
```

- `src/xiaomi.js` — **冻结**。只提供 `connect/fetchConversations/say`。
- `XIAOAI_RUNTIME` — 插件服务端单例，负责轮询循环 + 状态机 + 设置读取。
- 客户端 UI — 只通过 **RPC** 与 `XIAOAI_RUNTIME` 通信，不直接碰小米 API。

## 2. 设置命名空间

```
ns = "dsh-xiaoai"
```

字段（全部可选，有默认值）：

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关；false 时轮询循环挂起 |
| `userId` | string | `""` | 小米 ID（不是手机号） |
| `password` | string | `""` | 小米账号密码 |
| `did` | string | `""` | 音箱设备 ID 或米家名称 |
| `pollIntervalMs` | number | `4000` | 轮询间隔，最小 2000 |
| `replyTimeoutMs` | number | `240000` | 等待 DSH 回复的超时 |
| `maxReplyChars` | number | `400` | 回复截断长度（音箱念太长很难受） |
| `triggerKeywords` | string[] | `[]` | 空 = 全部转发；非空 = 前缀匹配 |
| `ignorePatterns` | string[] | `["^小爱同学$"]` | 正则，匹配则忽略 |
| `dshApiUrl` | string | `"http://127.0.0.1:3082/api/session"` | DSH 桥接端点 |
| `dshApiToken` | string | from `DSH_API_TOKEN` env | 桥接鉴权 |
| `verboseLog` | boolean | `false` | 详细日志 |

**注意**：`password` 与 `dshApiToken` 是敏感值，`settings.describe({redactSecrets:true})` 会打码。

## 3. 运行时状态（只读，供 UI 展示）

```ts
type XIAOAI_STATUS = {
  phase: "stopped" | "starting" | "running" | "error";
  lastError: string | null;
  speaker: { connected: boolean; name: string | null; model: string | null; did: string | null };
  dsh: { reachable: boolean };
  lastHeard: { text: string; at: number } | null;   // 最近一条识别到的语音
  lastReply: { text: string; at: number } | null;   // 最近一次播报的回复
  lastSpokenAt: number | null;
  handledCount: number;                              // 本次运行累计处理条数
  sessionId: string | null;                          // 与 DSH 的会话 id
  startedAt: number | null;
};
```

## 4. RPC 方法（客户端 → 服务端）

**机制（已定，勿改）**：使用 DSH 官方 **Typert Remote** 装饰器
（`@deepseek-ai/dsh-typert-protocol`，`class X extends TypertRemoteService` + `@Remote`），
命名空间 **`xiaoai`**。客户端通过 `ctx.remote.xiaoai.<method>()` 调用，
返回 `{ok:true,value}` / `{ok:false,error:{code,message,details}}` 联合。

> ⚠️ 曾在本文件中暗示过 `@api_command` 风格 —— **该 API 在 DSH 中不存在**（全 vendor 树零命中）。
> 详见 `docs/DSH-PLUGIN-API.md` §6。

**线端点用斜杠**（`endpointOf = `${namespace}/${method}``）：
`xiaoai/status`、`xiaoai/settings.get`、`xiaoai/settings.update`、`xiaoai/restart`、
`xiaoai/test`、`xiaoai/speak`、`xiaoai/logs`。

下表的点号写法是**客户端调用形式**（`ctx.remote.xiaoai["settings.get"]()`），
两者是同一件事的不同视角 —— 别把它们当成两个不同的端点。

方法清单如下。

| 方法 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `xiaoai.status` | `{}` | `XIAOAI_STATUS` | 拉取状态；UI 每 2s 轮询 |
| `xiaoai.settings.get` | `{}` | `{ values, revision }` | 读设置（密码打码） |
| `xiaoai.settings.update` | `{ patch, revision }` | `{ values, revision }` | 写设置；revision 冲突返回错误 |
| `xiaoai.restart` | `{}` | `{ ok: true }` | 重启轮询循环（改账号后调用） |
| `xiaoai.test` | `{ text }` | `{ ok, reply }` | 把 text 走一遍完整链路（不播报），用于自检 |
| `xiaoai.speak` | `{ text }` | `{ ok: true }` | 直接让音箱念一段（测 TTS） |
| `xiaoai.logs` | `{ limit }` | `{ lines: string[] }` | 最近日志尾部 |

## 5. 组件 props（客户端 UI 收到什么）

`settings.section` 的 `inject` **函数返回值会被逐字展开为组件 props**。

```ts
inject: () => ({
  // hooks 键特殊：其每个条目会变成名为 use<Capitalized> 的 prop
  hooks: {
    Xiaoai: () => XIAOAI_STATUS,           // → 组件收到 props.useXiaoai
  },
  // 其余键原样透传
  rpc: (method: string, args?: object) => Promise<any>,
})
```

组件 props：
- `t(key)` — **仅当注册时声明了 `locale`** 才有（我们会设 `locale: "dsh-xiaoai"` 并注册字典）
- `close()` — 插槽拥有者传入，关闭设置弹窗
- `props.useXiaoai()` — 订阅运行时状态
- `props.rpc(method, args)` — 调 §4 的方法

❌ **禁止使用的 prop 名**（会被拥有者覆盖）：`close`、`t`、`renderSlot`、`actions`、`useX`。

渲染顺序：`{...kit, ...injected, ...slotInjected.props, ...contextual, ...ownerProps}`

## 6. 语音会话隔离（重要架构决策）

**不使用** `/api_server.js` 的 `/api/session`。原因：

| 问题 | 影响 |
|---|---|
| 全局单飞锁 `sessionRelayInFlight` | 主对话一忙，语音全 429 |
| 与主对话共用会话 | 语音和你的对话互相排队 |
| 每次请求跑满 120s 超时 | 无法接受 |
| 每次新建会话 | 无上下文记忆 |

**改为进程内自建会话**：

```js
runtime.bindAgentFactory({ ctx, cwd: workspaceDir });   // 插件 host 在 apply() 里调用
```

之后 `runtime.askDsh(text)` 走：
```
ctx.agents.create({ meta: { cwd } })      // 独立的语音会话
   → agent.followup({role:"user", content:text})
   → 监听 session/event 的 assistant/message + turn/end
   → 返回文本
```

- 语音会话**独立于主对话**，互不阻塞，各自有记忆。
- `askDsh` 保留 HTTP 回退（未绑定时），但**生产路径必须用 in-process**。

## 7. 文件所有权（避免冲突）

| 文件 | 负责人 |
|---|---|
| `src/xiaomi.js`, `daemon.js`, `vendor/*` | 已冻结，只读 |
| `contract/INTERFACE.md`, `docs/DSH-PLUGIN-API.md` | 架构（我） |
| `src/runtime.js`（XIAOAI_RUNTIME） | 服务端块 |
| `src/index.js`（插件入口） | 服务端块 |
| `src/client/index.js`（UI） | 客户端块 |
| `package.json`, `cordis.patch.yml`, `build/*` | 构建块 |

