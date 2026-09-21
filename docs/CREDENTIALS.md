# 小米凭据机制（重要）

> 本文记录一个**极易踩坑**的事实：小米云 API 有**两个服务**，各自需要**独立的登录凭据**。

## 一、两个服务的区别

| 服务 | sid | 用途 | 对应插件能力 |
|---|---|---|---|
| **MiNA** | `micoapi` | 拉取对话记录（语音识别结果）| 听用户说话 |
| **MiIOT** | `xiaomiio` | 下发 MIoT 指令 | **TTS 播报、唤醒、音量控制** |

**关键**：两者的 `serviceToken` **不通用** —— 各自由不同的 sid 登录签发。

## 二、症状：只有一份凭据会怎样

如果只配置了 `micoapi` 的凭据：

```
✅ MiNA 登录成功      → 能拉到对话
❌ MiIOT 登录失败     → 无法播报
❌ connect() 抛错     → 整个插件不可用
   "小米登录失败（检查 .mi.json 凭据）"
```

更糟的是：**轮询会持续 401 空转**（实测出现过 4633 次），日志被刷爆，用户完全不知道发生了什么。

## 三、正确做法：store 里放两份

插件读取的凭据文件（`${DSH_HOME}/xiaoai-state/mi-store.json`）：

```json
{
  "mina": {
    "userId": "USER_ID_PLACEHOLDER",
    "sid": "micoapi",
    "serviceToken": "I6mD4vzF/...",
    "deviceId": "DEVICE_ID_PLACEHOLDER",
    "did": "DID_PLACEHOLDER",
    "device": { "deviceId": "DEVICE_ID_PLACEHOLDER", "hardware": "OH2P", "did": "DID_PLACEHOLDER" },
    "pass": { "ssecurity": "SSECURITY_PLACEHOLDER" }
  },
  "miiot": {
    "userId": "USER_ID_PLACEHOLDER",
    "sid": "xiaomiio",
    "serviceToken": "NWqQFgVMrO1...",
    "deviceId": "DEVICE_ID_PLACEHOLDER",
    "did": "DID_PLACEHOLDER",
    "device": { "deviceId": "DEVICE_ID_PLACEHOLDER", "hardware": "OH2P", "did": "DID_PLACEHOLDER" },
    "pass": { "ssecurity": "SSECURITY_PLACEHOLDER" }
  }
}
```

**每个字段都不能少**：
- `sid` —— 决定用哪个登录态
- `serviceToken` —— 实际的鉴权令牌
- `pass.ssecurity` —— vendor 判断"能否复用缓存"的依据（缺了会走密码登录）
- `device.deviceId` —— **注意在 `device` 对象里**（vendor 从 `account.device.deviceId` 取，不是顶层）
- `device.hardware` —— 型号（决定指令集）

## 四、最省事的获取方式：从 HA 导入

如果你的 Home Assistant 装了 `xiaomi_miot` 集成（并且已登录），
凭据就在下面这两个文件里，**直接复制即可**：

```
/config/.storage/xiaomi_miot/auth-<uid>-cn-micoapi.json     → mina 段
/config/.storage/xiaomi_miot/auth-<uid>-cn.json             → miiot 段（sid=xiaomiio）
```

字段映射：
```
service_token  → serviceToken
ssecurity      → pass.ssecurity
device_id      → device.deviceId
user_id        → userId（⚠️ 必须是数字 ID，不是手机号）
sid            → sid
```

**实测**：HA 的凭据直接可用，无需重新登录。

## 五、为什么不用密码登录

新浪（小米）对异地/新设备登录有风控：
```
1. 提交账号密码 → 返回 notificationUrl（要求手机验证）
2. 打开验证页 → 发送短信验证码
3. 提交验证码 → 通过
4. 用 location 换 serviceToken     ← ⚠️ 这一步在纯 API 下很难走通
   （需要跨域 cookie，浏览器跳转带不上）
```

**结论**：**能导入就导入**，密码登录作为最后手段，且要有风控处理。

## 六、相关代码位置

```
src/xiaomi.js          → XiaomiSpeaker.connect()（#na / #iot）
src/token-refresh.js   → mergeFreshTokens()（从 HA 同步）
src/bootstrap.js       → resolveMiStorePath()（凭据路径）
lib/vendor/mi-service-lite.js → getMiNA / getMiIOT（sid 在此分叉）
```
