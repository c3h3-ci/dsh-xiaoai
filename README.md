# dsh-xiaoai

让小米音箱成为 **DSH 的语音入口** —— 不只是聊天，而是能真实操作你的家。

## 功能一览

### 🎤 语音对话
- **上下文记忆**：同一音箱的对话共享上下文（"刚才说的那个"）
- **AI 模式**：说「进入AI模式」后连续对话，无需重复喊触发词；静默 30 秒自动退出
- **三类唤醒词**：直接问 / 进入模式 / 退出模式，语义各不相同
- **文本清洗**：自动去掉 Markdown，避免音箱念出「星号星号」「反引号 switch 点 xxx」

### 🏠 智能家居控制（DSH 能力）
音箱背后是 DSH agent，可用工具包括：
- **Home Assistant**（150+ 工具）：查/开关灯、空调、插座，建自动化与场景
- **网络搜索**、**股票行情**、**发邮件**、**读写文档**
- **设备状态复核**：agent 会主动验证操作是否生效，失败时如实报告

### ⚡ 本地快速路径（毫秒级响应）
这些指令**不走 LLM**，本机直接执行：
- 「音量调到50」「大声点」「音量加10」
- 「几点」「现在几点了」「报时」
- 「停」「别说了」「停一下」

### 🎛 设置面板（6 组 37 个字段）
```
① 会话与模型  ← 工作区 / Agent 预设 / 模型 / 会话复用
② 接入音箱      启用 / 账号 / 密码 / DID / 型号 / 指令集
③ 音箱行为      AI模式 / 轮询 / 字数 / 超时 / 关键词 / 本地快速路径 / 进度
④ 提示语        9 组（对话流程 + 出错提示）
⑤ 高级          忽略规则 / 历史 / 日志 / HTTP 桥接
⑥ 状态与日志    最近活动 / 对话历史 / 运行日志 / 会话绑定
```

### 🚀 首次接入
- **从 HA 导入**（推荐）：一条命令拉取双服务凭据，零登录
- **账号登录**：手机号/邮箱/小米ID，含风控处理
- **设备自动发现**：列出账号下所有音箱，不用手填 DID
- **4 步向导**：选方式 → 凭据 → 选音箱 → 测试

## 快速开始

```bash
# 从 Home Assistant 导入凭据（推荐）
node scripts/import-from-ha.mjs \
  --host 192.168.3.3 --user root --password '***' \
  --state-dir ~/.dsh/xiaoai-state \
  --did <音箱DID> --hardware <型号如OH2P>
```

或在 DSH 设置面板 → 小爱语音 → 「重新接入」→ 「从 HA 导入」。

## 重要说明

### 小米凭据需要【两份】
见 [docs/CREDENTIALS.md](docs/CREDENTIALS.md)：
```
micoapi  → 拉对话（听）
xiaomiio → 控制音箱（说：TTS/唤醒/音量）
```
**缺任一份插件完全不可用**。这是最容易踩的坑。

### 手机登录的限制
小米对异地登录有风控，纯 API 下无法完成验证码流程
（vendor 库缺 cookie jar）。
**「从 HA 导入」是可靠主路径** —— 只要 HA 装了 `xiaomi_miot` 集成。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | 使用指南（三种唤醒方式、配置速查、常见问题）|
| [docs/CREDENTIALS.md](docs/CREDENTIALS.md) | 凭据机制（双服务、三种来源、续期说明）|
| [docs/DSH-PLUGIN-API.md](docs/DSH-PLUGIN-API.md) | 插件 API 契约 |
| [docs/research/login-protocol.md](docs/research/login-protocol.md) | 小米登录协议全解（含实测证据）|
| [docs/research/ui-redesign.md](docs/research/ui-redesign.md) | UI 设计方案 |
| [docs/research/ui-acceptance.md](docs/research/ui-acceptance.md) | 验收报告（21/22 通过）|

## 开发

```bash
node scripts/build.mjs              # src/ → lib/
node --check src/client/index.js    # 语法检查
node scripts/apply-local-fixes.mjs  # 本地环境适配补丁
```

**⚠️ 本地适配补丁**：`src/index.js` 与 `src/rpc.js` 的锚点解析已针对
npm 全局安装做适配（`DSH_BIN` / `process.argv[1]` / `<execPrefix>/lib/node_modules`）。
若改动这些文件，**务必重新运行补丁脚本**，否则插件会报
「无法载入 Schemastery」或「无法解析 @deepseek-ai/dsh-typert-protocol」。

## 已知限制

- 手机验证码登录走不通（小米风控）→ 用「从 HA 导入」
- 工作区选择是下拉（仅已注册工作区），无目录浏览器
- 模型下拉取决于宿主暴露的模型数
- 并发编辑（多标签）无版本冲突提示

## 许可

见 [LICENSE](LICENSE)。
