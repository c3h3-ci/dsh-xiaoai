# DSH 0.1.6-alpha.2 → 0.1.7-rc.2 升级实录与教训

> 2026-09-25/26。**升级成功，但踩了 4 个坑**。本文记录每一个的根因，
> 供下次升级（以及为 DSH 提交 issue）参考。

## 一、升级结果

```
✅ 成功：DSH 0.1.7-rc.2 运行中
✅ 会话格式迁移已发生（v3 → v4）
⚠️ 遗留：settings.yaml 位置变化导致插件配置需重填
⚠️ 遗留：v4 新建对话报 "requires a producer-owned source kind"
```

## 二、踩过的 4 个坑

### 坑 1：`@deepseek-ai/dsh-experimental-agent-team-web-profile` 在 0.1.7 被删除

**症状**：DSH 启动失败，日志：
```
dsh: skipping profile bundle "@deepseek-ai/dsh-experimental-agent-team-web-profile":
Error: cannot resolve profile bundle ... from the dsh installation or /home/duola/.dsh/profiles/web
```

**原因**：该包在 0.1.7 的 81 个依赖里不存在（`dsh-experimental-agent-team-profile` 单数版也还在，
但 web-profile 变体没了）。

**修复**：从 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里移除它。

### 坑 2：`@alpacachen/dsh-automation` 引用了被重命名的包

**症状**（预估，已提前禁用）：会因 `import '@deepseek-ai/dsh-agent-presets'` 失败而崩。

**原因**：0.1.7 把包**重命名**了：
```
0.1.6: @deepseek-ai/dsh-agent-presets  （复数，800+ 行完整实现）
0.1.7: @deepseek-ai/dsh-agent-preset   （单数，29 行，只剩默认导出）
```
而且 `standingMountFor` 等工具函数**被移除了**（0.1.6 里是 `lib/index.js:771`）。

**影响面**：`dsh-automation/lib/agent-configuration.js:2` 用了它：
```js
import { standingMountFor } from '@deepseek-ai/dsh-agent-presets';
const scope = standingMountFor(agent.ctx)?.key;   // :123
```

**修复方向**（未做，等作者适配）：
- 包名改为单数
- `scope` 改为可选（`skills.get(name, { cwd })` 不传 scope 也能工作）

### 坑 3：`settings.yaml` 存储位置变了（**最容易忽略**）

**症状**：插件报「缺少配置：小米账号 ID（userId）、音箱设备 ID（did）」，
UI 显示首次接入向导，但配置明明还在。

**原因**：0.1.7 把设置存储**从全局移到 profile 级**：
```
0.1.6: ~/.dsh/settings.yaml
0.1.7: ~/.dsh/profiles/web/settings.yaml      ← 变了
```
`dsh-settings/lib/index.js:348`：
```js
const path = join(profile.home, "settings.yaml");
```

**而且它有一次性迁移**（`:346` `importLegacyDocument`）：
```js
async importLegacyDocument() {
  const path = join(profile.home, "settings.yaml");
  if (!existsSync(path)) return;
  const imported = `${path}.imported`;
  await rename(path, imported);        // 重命名（防重复导入）
  const sections = parse(await readFile(imported, "utf8"));
  for (const [section, values] of Object.entries(sections)) {
    await this.update(ns, values);      // 逐段导入
  }
}
```
**实测问题**：我们的 `dsh-xiaoai` 段被迁移成了**空段**（`dsh-xiaoai:` 下面没内容），
所以插件读到的是空配置。

**修复**：从备份恢复 `settings.yaml` 到**新路径**：
```bash
tar xzf dshhome-<ts>.tgz -C /tmp/restore .dsh/settings.yaml
cp /tmp/restore/.dsh/settings.yaml ~/.dsh/profiles/web/settings.yaml
```

### 坑 4：v4 会话格式拒绝没有 source 的 assistant 消息

**症状**：新建对话报错：
```
本轮运行失败 format v4 message requires a producer-owned source kind
```

**根因**（精确定位到行）：
`dsh-session-format-v3-to-v4/lib/index.js:126`
```js
function source(message) {
  const value = message["source"];
  if (!isSessionFormatJsonObject(value)
      || typeof value["kind"] !== "string"
      || value["kind"].length === 0
      || value["kind"] === "plugin")          // ← 也拒绝旧的 plugin 包装
    throw new SessionFormatError("format v4 message requires a producer-owned source kind");
}
```

**实测 v4 文件里**：
```
[user/message]      source={"kind":"user", ...}            ✅ 有
[user/message]      source={"kind":"runtime-context",...}  ✅ 有
[user/message]      source={"kind":"skill-catalog",...}    ✅ 有
[user/message]      source={"kind":"plugin:hindsight",...} ✅ 有（迁移转换成功）
[assistant/message] source=❌ 缺失                          ← 问题在这
```

**结论**：迁移器把 `kind:"plugin"` 正确转成了 `plugin:xxx`，
但**没有给 assistant/message 补 source 字段** —— 这是 DSH 0.1.7 的 bug。

**迁移器的设计意图**（`:113`）：
```js
function rewriteV3MessageSource(source, seq, role) {
  if (kind === "plugin") return rewritePluginSource(source, seq, role);
  return source;                       // ← 其它情况原样返回（不补全缺失的）
}
```
即使 `source` 是 `undefined` 也直接返回 → 校验时抛错。

## 三、升级脚本的教训

### 教训 A：脚本会被重启杀掉
```
现象：脚本日志停在"等待 90 秒"，进程消失
原因：systemctl --user restart dsh-web 连带杀掉同 cgroup 的脚本
修复：用 systemd-run --user --unit=<独立名> 启动重启动作
```
（脚本已修：`scripts/upgrade-dsh.sh` 的重启步骤改为独立 unit）

### 教训 B：备份耗时远超预期
```
DSH 目录 500M → 压缩 111M，耗时 4 分钟
~/.dsh    2.0G → 压缩 690M，耗时 2.5 分钟
合计约 7 分钟（脚本注释写的"10-30 秒"严重低估）
```

### 教训 C：验证项要包含"设置能否读到"
```
本次 10 项验证里【没有】检查插件配置是否读到
→ 升级"成功"了，但插件是 phase=error
建议加：xiaoai/settings.get 返回的 values 非空
```

## 四、给 DSH 的 issue 草稿

**标题**：`v3→v4 session migration leaves assistant messages without source, breaking v4 validation`

**正文**：
```
DSH 0.1.7-rc.2. After upgrading from 0.1.6-alpha.2, creating a new turn fails:

  format v4 message requires a producer-owned source kind

Located at dsh-session-format-v3-to-v4/lib/index.js:126 (`source()`), called
from assertV4MessageSources().

Root cause: the migrator's rewriteV3MessageSource() only rewrites sources whose
kind === "plugin" and returns every other value unchanged — including
`undefined`. In v3, assistant messages could legitimately omit `source`; v4
requires it on every durable message slot. So any migrated session with an
assistant message lacking `source` fails validation on the next write.

Evidence (decoded v4 file):
  [user/message]      source={"kind":"user",...}            ok
  [user/message]      source={"kind":"plugin:hindsight",...} ok (migrated)
  [assistant/message] source=<missing>                       <- rejected

Suggested fix: in rewriteV3MessageSource (or a pass before validation), default
a missing assistant `source` to a producer-owned kind (e.g. {kind:"assistant"})
instead of leaving it undefined.

Also related for plugin authors: the rename
@deepseek-ai/dsh-agent-presets -> @deepseek-ai/dsh-agent-preset removed
`standingMountFor` (present at dsh-agent-presets@0.1.6-alpha.2 lib/index.js:771).
```

## 五、升级检查清单（下次用）

```
□ 备份：DSH 目录 + ~/.dsh（预留 10 分钟）
□ 检查 bundles 里有没有 0.1.7 已删除的包
    → npm pack @deepseek-ai/<pkg>@<新版本> 验证
□ 检查本地/第三方插件有没有 import 被重命名的包
    → grep -r "dsh-agent-presets" node_modules/<plugin>
□ 记录 settings.yaml 的旧内容（升级后会换位置）
□ 升级后用【独立 unit】重启（脚本别被连带杀掉）
□ 验证项要含"插件配置能读到"（不只是"进程活着"）
```
