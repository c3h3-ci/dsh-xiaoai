# 多音箱 UI：设备卡片实施报告（task-7 前端部分）

**日期**：2026-09-21
**范围**：仅 `src/client/index.js`（未动任何后端文件）
**设计依据**：`docs/research/multi-speaker-design.md` §6
**改动规模**：`+1097 / -46` 行

---

## 0. 一句话结论

设备卡片 UI **已实现并在浏览器实测通过**。实施过程中 `multi-speaker-backend`
落地了 `settings.speakers[]`，因此**降级路径与列表模式都实测到了**：

- 后端**没有** `speakers[]` 时 → 把老的单 `did` 合成一台设备显示（降级，可用）
- 后端**有** `speakers[]` 时 → 自动切换成真正的设备列表（**前端零改动**）
- 多张卡片的布局、稀疏覆盖显示、同时只展开一张、恢复默认 —— **均已实测**

唯一仍未验证的是 `status.speakers[]`（后端尚未提供）与真实多台音箱。

---

## 1. 交付清单

| 项 | 状态 | 位置 |
|---|---|---|
| 新增「② 音箱设备」组 | ✅ | `SETTINGS_GROUPS` |
| 设备卡片（状态点/名称/型号/三按钮） | ✅ | `DeviceCard()` |
| ⚙ 内联覆盖配置 + 「继承全局: x」 | ✅ | `DeviceCard()` |
| 添加设备（复用 discoverSpeakers） | ✅ | `renderSpeakerGroup()` + `scanDevices` |
| 状态区多设备列表 | ✅ | `renderSpeakerStatusList()` |
| 降级路径（speakers 为空 → 单 did） | ✅ | `normalizeSpeakers()` |
| 后端字段就绪后自动切换 | ✅ | 同上 |

**分组从 6 个变成 7 个**（编号整体后移）：

```
① 会话与模型   ② 音箱设备 ★新增   ③ 接入音箱   ④ 音箱行为
⑤ 提示语       ⑥ 高级 / 桥接      ⑦ 状态与日志
```

---

## 2. 架构：数据流

```
settings.get
     │
     ▼
 normalizeSettings()            ← 关键：必须显式保留 speakers[]
     │                             （只认识 STRING/BOOL/NUMBER/LIST 四类字段，
     │                              没登记的键会被【静默丢弃】）
     ▼
   draft.speakers[]
     │
     ├──► normalizeSpeakers(draft) ──► speakerInfo { mode, speakers[] }
     │         │
     │         ├─ mode="list"   有 speakers[] → 直接用
     │         ├─ mode="legacy" 只有 did     → 合成 synthetic 设备
     │         └─ mode="empty"  都没有        → 空列表 + 添加入口
     │
     ▼
  DeviceCard 渲染
     │
     ▼
 用户编辑 → writeSpeakers(toStored(next))  →  回写 draft
     │
     ▼
 buildPatch()  → 带上 speakers[]  →  settings.update
```

---

## 3. 实施中发现的 4 个真实 Bug（都是浏览器实测抓到的）

这一节是本文档最有价值的部分 —— 前 3 个**语法检查、构建、字段核验全部无法发现**。

### Bug 1：`state.renderSpeakerGroup is not a function`

```
现象：整个设置面板白屏，只剩 7 个元素
      TypeError: state.renderSpeakerGroup is not a function
根因：renderSpeakerGroup 是【模块级函数】，不是 state 上的方法。
      我按 renderStatusGroup（它是 XiaoaiSection 内的 useCallback）
      的形式误写成了 state.renderSpeakerGroup()。
修复：devices: renderSpeakerGroup(state)  —— 显式调用并传入 state
```

### Bug 2：老配置下改设备 → 面板跳回「接入向导」

```
现象：在设备卡片里改一个字段，整个面板突然变成接入向导
根因链：老配置只有 did、没有 speakers[]
    → UI 合成 synthetic 设备显示
    → 用户编辑 → toStored() 里 .filter(d => !d.synthetic) 把它滤掉
    → 得到空数组 → writeSpeakers 把 did 投影清空
    → notConfigured = !draft.did 变 true
    → 面板切到向导分支
修复：next.length === 0 时【绝不碰 did / deviceModel】
```

### Bug 3：设备编辑「不脏」—— 保存按钮不亮、改动被回滚

```
现象：改了设备名，输入框立刻被 React 回滚成空；脏点不亮；保存按钮禁用
根因：normalizeSettings() 只遍历 STRING_FIELDS / BOOL_FIELDS /
      NUMBER_RULES / LIST_FIELDS，speakers 不在任何一类里 → 被丢弃
      → draft 里根本没有 speakers → 改动无处可存
修复：在 normalizeSettings 里单独归一化 speakers（对象数组，不能进 LIST_FIELDS，
      那里会 String(item) 变成 "[object Object]"）
      + buildPatch 同步带上 speakers（仅在有设备时，避免老配置被凭空写入空数组）
```

### Bug 4：对象数组的脏检查恒等（潜在静默失效）

```
现象：即使把 speakers 塞进 draft，改了也不打脏点
根因：computeDirtyKeys 对数组用 String(left[i]) !== String(right[i])，
      元素是对象时两边都是 "[object Object]" → 永远「相等」
修复：抽出 sameRecord() 做结构化浅比较
```

> **教训**：Bug 2/3/4 全都"看起来能过"——语法通过、构建通过、字段核验通过。
> 只有真的在浏览器里点一下才会暴露。这印证了任务书里的警告。

---

## 4. 浏览器实测结果

### 4.1 面板渲染 ✅

```
xiaoai 元素数: 466
分组: ① 会话与模型 / ② 音箱设备 / ③ 接入音箱 / ④ 音箱行为
      / ⑤ 提示语 / ⑥ 高级·桥接 / ⑦ 状态与日志        ← 7 组齐全
设备卡片: 1 张（降级路径合成）
摘要: "共 1 台 · 1 台在线"
React #310: 无（reactErrorsInBody = false）
控制台: 仅 2 条宿主 shell 的已知 P2-1 报错（与本插件无关）
```

### 4.2 设备卡片结构 ✅

```
卡片文本: "Xiaomi 智能音箱 Pro在线 ⏸ ⚙ 🗑 did: DID_PLACEHOLDER"
data-tone: "ok"          ← 状态点语义正确
三个按钮的 aria-label: 停用 / 配置 / 移除   ← 无障碍到位
覆盖摘要: "▸ 使用全局配置（工作区 / 模型 / 预设）"
```

### 4.3 ⚙ 内联配置展开 ✅

```
展开后字段: 名称 / 工作区 / Agent 预设 / 模型 provider / 模型 model
「继承全局」占位符（设计 §6.3 的核心交互）实测输出：
   工作区     → "继承全局: /media/duola/devdata/AI-workspace/AI-PROXY"
   其他三项   → "继承全局: （未设置）"
aria-expanded 正确切换 true/false
```

### 4.4 编辑 → 脏点 → 保存 → 持久化 ✅（完整闭环）

```
1. 在「名称」输入 "客厅音箱"
   → 输入框保持 "客厅音箱"（不再被回滚）
   → 「② 音箱设备」标题【出现脏点】✅
   → 底部 "● 有 1 项未保存的修改"
   → 「保存」按钮变为【可点击】✅
   → 卡片名称实时变为 "客厅音箱"
2. 点「保存」→ "设置已保存。"
3. 后端核对：
     did     = "DID_PLACEHOLDER"          ← 老投影保留 ✅
     speakers= [{"did":"DID_PLACEHOLDER","name":"客厅音箱","model":"",
                 "enabled":true,"workspace":null,"agentPreset":null,"provider":null}]
     revision= 8 → 9                 ← 乐观锁正常 ✅
4. 整页刷新 → 卡片显示 "客厅音箱"，synthetic 徽章【消失】
   （说明已是真实设备，不再是降级合成项）
```

### 4.5 启停设备 ⏸ / ▶ ✅

```
点 ⏸ → data-tone: "ok" → "muted"
     → 卡片加 .xiaoai-device-disabled（降透明度）
     → 按钮变 ▶
     → 摘要 "1 台在线" → "0 台在线"        ← 实时重算
     → 脏点亮
点 ▶ → 完全恢复原状，且【脏点消失】
     （说明 sameRecord 能正确识别"回到基线"）
```

### 4.6 添加设备（复用 discoverSpeakers）✅

```
点「+ 添加音箱」→ 无参调用 xiaoai/onboarding.discoverSpeakers
                → 用【已保存凭据】列设备（无需重新登录）
实测输出：
  选择器出现，条目 "Xiaomi 智能音箱 Pro　OH2P · 在线"
  该设备已添加 → 显示「已添加」（did 去重生效）✅
  底部说明 "凭据将复用当前账号（无需重新登录）。"
点「关闭」→ 选择器消失，面板正常
```

### 4.7 移除设备（二次确认）✅

```
confirm 文案实测（设计 §6.2 要求"具体"）：
  "确定移除「客厅音箱」吗？

   移除后，这台音箱的对话会话将不再复用；历史记录仍保留在 DSH 会话列表中。"

拒绝 → 设备保留 ✅
接受 → 该设备被移除；因只剩一台，normalizeSpeakers 回退合成
       → 卡片仍在（回到单设备模式），面板不空白 ✅
```

### 4.8 状态区设备列表 ✅

```
⑦ 状态与日志 → "设备" 小节
实测: "设备 客厅音箱 在线"，data-tone="ok"
```

### 4.9 降级路径 ✅（后端未就绪时的核心验收项）

```
当前后端 settings.speakers = undefined / status.speakers = undefined
→ UI 显示 1 张卡片 + 徽章「单设备模式（此版本后端尚未提供设备列表）」
→ 说明条：「当前为单设备配置。后端尚未提供设备列表时，
           界面回退为单设备模式，配置照常可用。」
→ 不报错、不空白、保存链路照常
```

### 4.10 后端就绪后的自动切换 + 多设备实测 ✅（**超出原计划，意外可测**）

实施过程中 `multi-speaker-backend` 落地了 `speakers[]` schema，服务端开始返回该字段。
于是**降级路径之外的「列表模式」也得以实测**（原以为测不了）：

```
【自动切换，前端零改动】
后端提供 speakers[] 后重新加载：
  badge: null          ← "单设备模式"徽章自动消失
  modeNote: null       ← 降级说明条自动消失
  model: "OH2P"        ← 型号来自后端真实数据
=> normalizeSpeakers 的 mode 从 "legacy" 自动变为 "list"

【多设备布局：手工向后端注入第二台设备后实测】
cards: 2
卡片①  tone="muted"  名称="Xiaomi 智能音箱 Pro"  型号="OH2P"
       did="did: DID_PLACEHOLDER"
       覆盖摘要="▸ 使用全局配置（工作区 / 模型 / 预设）"
卡片②  tone="muted"  名称="小爱音箱 mini"        型号="LX06"
       did="did: 999000111"
       覆盖摘要="▸ 已覆盖：工作区 = /path/to/bedroom；Agent 预设 = liangshen"
       ★ 稀疏覆盖显示正确（设计 §6.2 要求的效果）
摘要: "共 2 台 · 0 台在线"

【同时只展开一张卡（设计 §6.3）】
点卡片②的 ⚙ → secondCardExpanded: true, firstCardExpanded: false   ✅

【覆盖态字段回填 + 继承占位符（设计 §6.3 核心交互）】
名称       value="小爱音箱 mini"
工作区     value="/path/to/bedroom"   placeholder="继承全局: /media/.../AI-PROXY"
Agent 预设 value="liangshen"          placeholder="继承全局: （未设置）"
provider   value=""                   placeholder="继承全局: （未设置）"
model      value=""                   placeholder="继承全局: （未设置）"
「恢复为全局默认」按钮出现（有覆盖时才出现）                          ✅

【恢复为全局默认】
点按钮 → 覆盖字段清空、摘要变回"使用全局配置"、按钮消失、脏点亮   ✅
```

> **`tone: "muted"` / "状态待同步" 是刻意的正确行为**：后端**仍未**提供
> `status.speakers[]`，因此 UI 如实显示"状态待同步"，而不是谎报"在线"。
> 这正是 `speakerTone()` 设计的安全降级 —— 宁可说不知道，也不要给假信息。

---

## 5. ⚠️ 仍未测 / 未验证（诚实标注）

| 项 | 原因 |
|---|---|
| **真实多台音箱** | 本机账号只有 1 台（`discoverSpeakers` 实测 `deviceCount: 1`）。上面的双卡片是**向后端注入假 did** 构造的；真实两台设备并发轮询/路由未验证（那是后端 + R1 的事） |
| **`status.speakers[]` 的消费** | 后端**尚未**提供该字段。`speakerRuntime()` 的"按 did 查列表"分支**从未被执行**，只跑过单设备投影分支 |
| **多设备状态隔离** | 代码写了「多台时绝不共享账号级状态」，这条防线**未经多设备 + 真实 status 实测** |
| **离线 / degraded / error 色调** | 当前连接健康且无第二台真机，三个分支未自然触发 |
| **添加设备写入真实第二台** | 用假 did 验证了 UI 渲染；用真实 `discoverSpeakers` 添加（账号没有第二台）未验证 |
| **与后端的完整联调** | 后端仍在改动中（`src/runtime.js` 本轮 +740 行）；本报告只覆盖前端，且服务端可能还需重启才完全生效 |

> 一句话：**UI 逻辑对「长度 > 1 的数组」已实测**（靠注入构造），
> 但**真实多设备 + 真实 per-device 状态**仍未跑过。建议后端完全就绪后补一次端到端联调。

---

## 6. 遵循的约束

```
✅ 只改 src/client/index.js（+ 本文件）
✅ 未改 src/runtime.js / src/index.js / src/rpc.js / vendor
✅ 未动 inject 数组（仍为 ["slots","remote"]）
✅ 未重启 DSH（构建后浏览器硬刷新即生效）
✅ 含 Hook 的函数一律 h(Comp, props) 渲染，无直接调用
✅ 新增 Hook 全部位于 if (wizardActive) return 之前
   （已核验：新 Hook 在 4574–5160 行，early return 在 5440 行）
```

## 7. 回归确认

```
node --check src/client/index.js      ✅ 语法通过
node scripts/build.mjs                ✅ 11 文件同步 + 断链自检通过
浏览器硬刷新                           ✅ 面板 466 元素 / 7 组 / 无 #310
设备编辑闭环                           ✅ 改 → 脏点 → 保存 → 刷新 → 值还在
多设备渲染                             ✅ 2 张卡片 / 稀疏覆盖 / 同时只展开一张
后端配置                               ✅ 已从全部测试值恢复为真实单设备（rev=12）
```

> **测试数据已清理**：为验证多设备而注入的假设备（`did: 999000111`）已从后端移除，
> 当前配置为真实设备 `DID_PLACEHOLDER` / `Xiaomi 智能音箱 Pro` / `OH2P`。

## 8. 后端就绪后的衔接点

后端补上字段后，前端**无需修改**即可切换；但有 3 处值得复核：

1. **`status.speakers[]` 的字段名** —— 前端读 `did` / `connected` / `online` /
   `phase` / `aiMode` / `lastHeard.at` / `lastError`（设计 §6.4 的形状）。
   若后端命名不同，需调整 `speakerRuntime()` 与 `speakerTone()`。
2. **`settings.speakers[]` 的元素形状** —— 前端发 `{did, name, model, enabled,
   workspace, agentPreset, provider}`。`workspace`/`agentPreset`/`provider` 用
   `null` 表示"继承全局"（**不是空字符串**），后端需按设计 §3.2 的语义处理。
3. **`RESTART_KEYS` 需包含 `speakers`** —— 这是后端的事（设计 §7.2 已列），
   但若漏了，用户改设备后不会自动重启轮询，表现为"改了不生效"。
