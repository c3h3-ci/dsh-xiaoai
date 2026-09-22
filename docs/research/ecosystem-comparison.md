# 小爱音箱 × LLM 生态对比研究

> 2026-09-22/23 调研。对比所有已知方案，明确我们的技术路线定位。

## 一、方案全景

| 项目 | ⭐ | 状态 | 技术路线 | 延迟 |
|---|---|---|---|---|
| **本插件** | — | ✅ 可用 | 轮询小米云 → DSH agent → TTS | 10-50 秒 |
| **xiaogpt** | 6919 | 🔄 活跃 | 轮询 + LLM + 流式切句 | 2-5 秒 |
| **MiGPT** | 12503 | ⚠️ 停更(2024-08) | 轮询 + 问答过滤 | 2-5 秒 |
| **migpt-next** | 1441 | ❌ 停维护 | 轮询 + 自定义回复 | 2-5 秒 |
| **open-xiaoai** | 2605 | ❌ 停维护 | **刷机接管耳嘴** | **实时** |
| **xiaomusic** | 10039 | 🔄 | 只做音乐播放 | — |
| **bemfa** | 557 | 🔄 | HA → 巴法云 → 小爱控制 | — |

## 二、获取语音的三种方式

### 方式 A：轮询小米云对话记录（我们 / xiaogpt / MiGPT）
```
GET userprofile.mina.mi.com/device_profile/v2/conversation
  ?limit=N&hardware=OH2P&requestId=<uuid>&source=dialogu
```
⚠️ **关键**：cookie 里的 deviceId 必须是【设备 UUID】
（`cbf60488-c95d-40f8-bc6d-afbd0b673d2b`），不是账号级 ID
（`DEVICE_ID_PLACEHOLDER`）—— **传错会静默返回空**（本项目在此坑花了一天）。

- ✅ 不刷机、零风险
- ❌ 2 秒轮询延迟、无法打断、不能自定义唤醒词

### 方式 B：刷机接管麦克风/扬声器（open-xiaoai）
```
1. 刷补丁固件（支持 LX06 / OH2P）
2. SSH 进音箱
3. 跑 Rust Client（接管音频设备）
4. 语音 → 自己的 LLM → 播放（完全绕过小米云）
```
- ✅ 实时、可打断、自定义唤醒词、流式
- ❌ 刷机风险（变砖）、失去小米原生功能、**项目已停维护**

### 方式 C：HA Assist Pipeline（需要语音硬件）
- ❌ 小爱音箱不开放语音接口，用不了

## 三、HA 的小米集成能否做语音入口？

**❌ 不能**（已核实）：

```
xiaomi_home v0.4.7：只有设备控制实体
  (binary_sensor/button/climate/cover/fan/humidifier/light/
   media_player/notify/number/select/sensor/switch/text/vacuum/...)
  没有 conversation / voice / stt / tts

xiaomi_miot：同样只控制设备，但有【intent.py】注册两个意图：
  · XiaoaiPlayText       → 让小爱念文本（TTS）
  · XiaoaiExecuteCommand → 让小爱【执行】文本指令
  以及 intelligent_speaker 服务（text + execute=true）
  → 方向都是 HA → 小爱（控制），不是 小爱 → HA（接收语音）
```

**结论**：HA 的小米集成是【控制层】，不碰语音链路。
小爱的语音是小米云自己闭环的，只有方式 A/B 能拿到。

## 四、各方案的"反延迟"技巧对比

| 技巧 | 谁在用 | 我们能否用 |
|---|---|---|
| **流式切句**（收到一句就播） | xiaogpt | ❌ DSH 无 token 流事件 |
| **退出守卫**（正在回答不超时） | MiGPT | ✅ **已实现** |
| **mute_xiaoai**（让小爱闭嘴） | xiaogpt / MiGPT | ✅ 已有（pause）|
| **文本清洗** | 都有 | ✅ 我们更完善（13 步 vs 4 步）|
| **元工具模式**（减少工具定义） | ha-mcp | ✅ 已用（11 vs 75）|
| **工具目录阶梯式** | claw_assistant | ❌ DSH 框架行为 |
| **Planner 模式不塞历史** | claw_assistant | ❌ 同上 |

## 五、工具定义的实测构成（98,812 字节 ≈ 25k tokens）

```
mcp__chrome-devtools   34 个  (25KB)  浏览器自动化
mcp__uos               24 个  (18KB)  系统控制（语音有用）
mcp__fuyao-*           23 个  (17KB)  股票行情
automation              8 个  (6.9KB)
hindsight               8 个  (6.3KB)  记忆工具（语音不需要）
bash                    1 个  (3.3KB)
weknora                 4 个  (3.3KB)
team                    4 个  (2.7KB)
其他                   43 个
```

## 六、优化探索（含失败记录）

| 优化 | 收益 | 代价 | 结论 |
|---|---|---|---|
| 减少预设工具（4→2） | <1 秒 | 无 | ❌ 宿主工具才是大头 |
| chrome-devtools 限作用域 | 省 3 秒 | 失去浏览器能力 | ❌ **已撤销**（revision 4）|
| 元工具模式 | ✅ 已是最优 | 无 | ✅ 保持 |
| voice 预设 + includeRuntimeContext:false | ✅ 已用 | 无 | ✅ 保持 |
| 流式响应 | 大 | — | ❌ DSH 无 token 流事件 |
| 缓存 assemble | 大 | — | ❌ DSH 框架行为 |

## 七、我们的定位

**优势**
```
✅ 唯一有【完整 Agent 能力】的方案（DSH：编码/搜索/HA 控制/邮件/记忆）
✅ 多音箱架构（per-device 隔离，其他方案都是单设备）
✅ 完整的 UI 配置面板（37 个字段，6 个分组）
✅ 首次接入向导（从 HA 导入凭据，含设备 UUID 自动探测）
✅ 语音人格（Agent 预设）
```

**劣势**
```
❌ 响应 10-50 秒
   根因：145 个工具定义 = 25k tokens，每 turn 全量序列化
   这是 DSH 框架的固定开销，插件层无法优化
❌ 无法打断、无法自定义唤醒词（轮询方案的天花板）
```

## 八、结论

1. **技术路线正确**：轮询是不刷机情况下唯一可行路径
   （HA 的小米集成只做设备控制，不碰语音）

2. **瓶颈不可解**（现有架构下）：
   DSH 的工具定义序列化（25k tokens/turn）
   → 除非改 DSH 源码，或刷机

3. **建议**：
   - 接受 10-12 秒响应（有"让我想想"提示）
   - 如需"实时对话体验" → 只有刷机（open-xiaoai），但已停维护
   - 继续完善可靠性（凭据自动刷新、错误恢复）
