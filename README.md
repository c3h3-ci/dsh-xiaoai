# dsh-xiaoai

把 **小米音箱（小爱）** 变成 DSH 的**耳朵和嘴巴**。

```
你说 → 小爱音箱 → 小米云 → 本插件 → DSH（灵犀）
                                      ↓
                                 控制 HA / 回答问题
                                      ↓
              小爱念出来 ← TTS ← 本插件
```

**本插件不做任何 AI 处理** —— 大脑完全是 DSH。它只负责搬运语音。

---

## 能力

| 方向 | 说明 |
|---|---|
| **听** | 轮询小米云，抓取你对音箱说的话 |
| **说** | 用音箱自带的 TTS 念出 DSH 的回复 |
| **控制** | DSH 侧可调用全部工具（含 Home Assistant） |

---

## 设置

DSH → 设置 → **小爱语音**（`dsh-xiaoai`）

| 字段 | 说明 |
|---|---|
| 启用 | 总开关 |
| 小米 ID | 「个人信息」里的数字 ID，**不是手机号** |
| 密码 | 小米账号密码 |
| 音箱 DID | 米家设备名，或设备 ID |
| 轮询间隔 | 毫秒，最小 2000 |
| 回复最大字数 | 音箱念太长很难受，默认 400 |
| 触发词 | 逗号分隔；**留空 = 全部转发** |
| 忽略规则 | 正则，逗号分隔 |

---

## 架构

```
src/
├── index.js      插件服务端入口（设置注册 + 生命周期）
├── rpc.js        Typert Remote 控制器（7 个端点）
├── runtime.js    运行时：轮询循环 + 状态机 + DSH 会话
├── xiaomi.js     小米 API 层（登录 / 抓对话 / TTS）
└── client/
    └── index.js  设置面板（React，无构建步骤）

vendor/
└── mi-service-lite.js   内置小米库（含绕过风控补丁）

contract/INTERFACE.md    接口契约（改接口必须先改它）
docs/DSH-PLUGIN-API.md   DSH 插件 API 权威参考
```

---

## 关键设计决策

### 1. 绕过小米异地登录风控

小米对「新设备 + 新 IP」登录会要求人工验证。本插件复用
HA `xiaomi_miot` 集成已有的 `serviceToken` + `ssecurity`，
写进 `.mi.json`（key 是 `mina` / `miiot`，**不是** `micoapi` / `xiaomiio`），
并给 `vendor/mi-service-lite.js` 打了补丁：有缓存 token 就跳过密码登录。

### 2. 语音会话与主对话隔离

**不用** `/api_server.js` 的 `/api/session` —— 那是全局单飞锁，
主对话一忙语音就全部 429，且每次请求要跑满 120s 超时。

改为 `ctx.agents.create()` 自建**独立语音会话**（见 `contract/INTERFACE.md` §6）。

### 3. 三重防「念错话」

| 防护 | 说明 |
|---|---|
| 水位线持久化 | `lastTime` 存盘，重启不重放历史 |
| 冷启动只对齐 | 首次轮询只记录水位，不回放 |
| 去重集合 | 同一条消息只处理一次 |

### 4. 静默失败防护

小米 API 有几个**不报错但也不工作**的坑，均已硬化：

| 坑 | 处理 |
|---|---|
| TTS >~3900 字节被拒（返回 `-704002000`） | 按 UTF-8 字节截断 + 检查返回值抛错 |
| token 过期时 `getConversations()` 返回空 | 连续 5 次空返回 → 抛错告警 |
| `answer[0]` 是 `Audio` 时丢文本 | 多路径提取器 + 跳过 `illegalContent` |

---

## 开发

```bash
node scripts/build.mjs        # src/ → lib/（无转译，纯拷贝）
node tmp-tests/test_host.mjs  # 服务端自检（87 项断言）
node tmp-tests/test_client.mjs # 客户端自检（10 项）
```

改完 `src/` 记得跑 `build.mjs`；`lib/` 才是 DSH 实际加载的目录。

---

## 已知限制

- **响应有延迟**：DSH 处理复杂任务需要时间，音箱会沉默等待。
- **音箱念长文本体验差**：故有 `maxReplyChars` 截断。
- **小米可能变更 API**：`vendor/` 里的库是快照，上游变了要重新同步。
- **无 CSS**：设置面板的 `.xiaoai-*` 类名未加样式，沿用 DSH 默认排版。
