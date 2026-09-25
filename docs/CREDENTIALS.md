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
    "serviceToken": "<REDACTED>...",
    "deviceId": "DEVICE_ID_PLACEHOLDER",
    "did": "DID_PLACEHOLDER",
    "device": { "deviceId": "DEVICE_ID_PLACEHOLDER", "hardware": "OH2P", "did": "DID_PLACEHOLDER" },
    "pass": { "ssecurity": "SSECURITY_PLACEHOLDER" }
  },
  "miiot": {
    "userId": "USER_ID_PLACEHOLDER",
    "sid": "xiaomiio",
    "serviceToken": "<REDACTED>...",
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


---

## 七、凭据来源全表（实测结论）

HA 上实际存在**三种**小米凭据，用途与有效期各不相同：

| 来源文件 | 类型 | 能否驱动音箱 | 有效期 | 备注 |
|---|---|---|---|---|
| `xiaomi_miot/auth-<uid>-cn-micoapi.json` | micoapi | ✅ **主路径** | 静态，会过期 | 需解析 `data` 键 |
| `xiaomi_miot/auth-<uid>-cn.json` | xiaomiio | ❌ 401（两次独立实测） | 静态 | 仅供 MiIOT |
| `xiaomi_home/miot_config/<uid>_cn.dict` | mac/HmacSHA1 | ❌ 401（有对照组） | 3 天 + 可 refresh | 见下 |

### 关于第三种（xiaomi_home 的 mac token）

**不要被"能自动续期"误导** —— 它的 refresh 机制**真实可用**，但**不能用于音箱**：

- 它的 `scope` 是 `"1 3 6000"`，属于小米**官方 IoT OpenAPI** 权限集
- 音箱的对话接口走 **MiNA 私有域**（`api2.mina.mi.com`），不在此 scope 内
- 实测：**同样 URL / headers / 参数**下，mac token 得 401，micoapi 真 token 得 200
  （有对照组，排除了"参数写错"的可能）

**准确说法是"确认它不能用于音箱"，而不是"这个 token 没用"** ——
它走的是小米官方 IoT OpenAPI（`scope "1 3 6000"`），我们只测了它打不通 MiNA，
没有测它能否操作其他官方 OpenAPI 设备。若将来有走官方 OpenAPI 的需求，
它的（尤其是 refresh 能力）可能仍有价值。

**⚠️ 该文件还有两个坑**：
1. **不是纯 JSON** —— 尾部有 32 字节二进制签名，直接 `json.load` 会失败
2. **刷新是破坏性的** —— refresh 会轮换并**立即作废旧 refresh_token**。
   若手动刷新而不回写，HA 会拿到死 token。**不要手动 refresh**。

### 关于 micoapi 的续期

**micoapi 的 serviceToken 没有公开的 refresh 机制。** 这意味着：

- token 过期后**无法自动续期**，只能重新从 HA 拉一次
- 这正是"从 HA 导入"作为主路径的原因

**实践建议**：若音箱突然不可用且日志报 401，先跑一次
`node scripts/import-from-ha.mjs`（或 UI 里的「从 HA 导入」）刷新凭据。
