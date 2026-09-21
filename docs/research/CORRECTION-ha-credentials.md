# 更正：HA 同时持有 micoapi 与 xiaomiio 两份凭据

> 本文更正 `login-protocol.md` 中的一处判断错误，避免后续工作被误导。

## 被更正的判断

`docs/research/login-protocol.md` §"两个必须单独说的发现" 第 2 条称：

> ⚠️ HA 实机凭据显示 `sid = xiaomiio`（MiIOT 域），不是 `micoapi`（MiNA 域）。
> ……**两者是不同 STS 端点，HA 的成功经验不能直接迁移**。

## 实际情况（实测）

HA 的 `.storage/xiaomi_miot/` 目录下**同时存在两份凭据**：

```
auth-USER_ID_PLACEHOLDER-cn-micoapi.json   sid=micoapi    token 216 字符   更新 2026-09-21 00:55  ⭐
auth-USER_ID_PLACEHOLDER-cn.json           sid=xiaomiio   token 192 字符   更新 2026-09-18 09:42
```

**判断错误的来源**：只看了 `core.config_entries` 里记录的那一条（`xiaomiio`），
没有列 `.storage/xiaomi_miot/` 目录。

## 这解释了此前的修复为何有效

我们当前可用的凭据正是从这两份文件来的：

```
mi-store.json
  mina :  serviceToken = I6mD4vzF/l5OJX0s7LwrQ...   ← 来自 micoapi 文件（216 字符）
  miiot:  serviceToken = NWqQFgVMrO1LEsybkPNH4m...  ← 来自 xiaomiio 文件（192 字符）
```

而音箱的"听"（`api2.mina.mi.com` 拉对话）**必须**用 micoapi 的 token ——
这一点已由插件实测验证：`phase=running`、`连续错误=0`、对话与播报均正常。

## 补充实测：两个 token 确实不通用

```
用 xiaomiio 的 token 请求 api2.mina.mi.com/device_profile/v2/conversation
→ HTTP 401 Unauthorized
```

**结论**：
- 两个域（MiNA/micoapi 与 MiIOT/xiaomiio）**凭据确实不可互换** —— 这部分研究员是对的
- 但"HA 只有 xiaomiio"是错的 —— **HA 两份都有**，因此「从 HA 导入」这条路对音箱**完全够用**

## 对后续工作方向的影响

| 原判断 | 更正后 |
|---|---|
| 方案 E（借 HA token）不完整，因为只有 xiaomiio | **方案 E 成立** —— HA 提供的 micoapi token 正是音箱所需 |
| 手机登录修复是唯一出路 | 不是。**「从 HA 导入」已是可用主路径**，手机登录可降级为"没有 HA 时的备选" |

## 证据

```bash
# 列出 HA 上的两份凭据
sshpass -e ssh root@192.168.3.3 "ls -la /homeassistant/.storage/xiaomi_miot/auth-USER_ID_PLACEHOLDER-*.json"

# 各自的实际 sid
sshpass -e ssh root@192.168.3.3 "cat /homeassistant/.storage/xiaomi_miot/auth-USER_ID_PLACEHOLDER-cn-micoapi.json"  # sid=micoapi
sshpass -e ssh root@192.168.3.3 "cat /homeassistant/.storage/xiaomi_miot/auth-USER_ID_PLACEHOLDER-cn.json"          # sid=xiaomiio

# 交叉验证 token 不通用（用 xiaomiio 打 MiNA 端点）
curl -H "Cookie: userId=USER_ID_PLACEHOLDER; serviceToken=<xiaomiio token>; deviceId=..." \
     "https://userprofile.mina.mi.com/device_profile/v2/conversation?limit=3&..."   # → 401
```
