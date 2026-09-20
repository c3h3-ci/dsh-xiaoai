# DSH 插件 API 参考（研究结论，已从源码验证）

> 来源：cf970cca 研究代理，逐文件对照 `/data/dsh/vendor/node_modules/@deepseek-ai/` 与
> `/data/dsh/profiles/web/node_modules/@xmanrui/dsh-im/`。
> **`@api_command` 不存在** —— 全 vendor 树零命中。任何提到它的设计都是错的。

## 1. 设置命名空间注册（host）

```js
import z from "@deepseek-ai/schemastery";   // ← Schemastery，不是 zod

export const inject = ["settings"];
const NS = "dsh-xiaoai";                     // 必须匹配 /^[a-z][a-z0-9-]*$/

const XiaoaiSettings = z.object({
  enabled: z.boolean().default(false),
  speakerHost: z.string().default(""),
});

export function apply(ctx) {
  ctx.inject(["settings"], (sctx) => {
    const scope = sctx.settings.register(NS, XiaoaiSettings);
  });
}
```

`register(ns, schema, options)` → scope。
`options = { base?, applies? ("live" 默认), validate? }`。
重复注册抛错；注册是 `ctx.effect`，fiber 销毁即注销。

## 2. 读写设置

scope 只有 4 个成员：

| 成员 | 说明 |
|---|---|
| `get()` | 同步返回 deep-frozen 的解析值 |
| `watch(cb)` | 返回 disposer；`cb(next, prev)` |
| `update(patch)` | Promise，把 plain object 合并到 **user 层** |
| `replace(section)` | Promise，整体替换 user 段（重置用） |

服务层另有：`get(ns)` / `update(ns,patch,rev)` / `replace(ns,sec,rev)` /
`mutate(ns,ops,rev)`（`ops=[{op:"set"|"unset", path:["a","b"], value?}]`）/ `describe(opts)`。

**跨线传输必须用 `describe({ redactSecrets: true })`。**

revision 是单调递增整数，仅在原始存储变化时递增。传入过期 revision 抛
`SettingsConflictError`（code `SETTINGS_CONFLICT`，带 `.expected`/`.actual`）。
传 `undefined` 则无条件写入。同命名空间的写入按 promise 链串行。

## 3. 客户端读设置

**首选**：`ctx.remote.settings`（Typert Remote，需 inject `"remote.settings"`）

```js
const r = await ctx.remote.settings.describe();   // r.ok → r.value
const r = await ctx.remote.settings.update(ns, patch, expectedRevision);
```

线端点：`settings/describe`、`settings/update`、`settings/mutate`、`settings/replace`。

**更省事**：`ctx.settingsScope.bind({ namespace: NS })`（来自 `dsh-client-ui-settings`），
返回带 `getSnapshot()`/`subscribe()`/`set(field,value)`/`unset(field)`/`mutate(ops)` 的
controller，**自动处理 revision 冲突恢复**。推荐用它。

**wire envelope**（来自 `/api_server.js` 的 `dshRpc`）：

```js
POST {DSH_WEB}/api/{method.replace(/\./g,'/')}
body: { type:"client-request", rpcId, method: wireMethod,
        payload: { args: { [argName]: payload } } }   // argName 默认 "request"
resp: { result: { ok:true, value } } | { result:{ ok:false, error:{code,message,details} } }
```

## 4. `settings.section` 插槽注册（client）

**只认这些键**：`key, id, order, label, priority, select, inject, children, store, locale, registrant`。
消费方只读 `id, order, label`。

`settings.section` 声明为 `{ kind: "list", scope: "root" }` → **`id` 必填**。
`label` 是 **string 或零参函数**（`(t)=> typeof t=="function" ? t() : t`），函数形式会随语言切换重解析。

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section",
  id: "dsh-xiaoai",              // list slot 必填
  order: 30,                     // general(0) → agent-presets(20) → dsh-im(21)
  label: () => t("nav"),
  locale: NS,                    // 给了才会有 t prop
  inject: injectFace,
}, XiaoaiSection));
```

⚠️ 设了 `locale: NS` 却**没注册**该命名空间 → 渲染时抛 `SlotAssemblyError`。
不用本地化就**不要设 locale**，label 直接返回字符串。

## 5. 组件收到的 props（渲染器源码为证）

```js
jsx(Comp, { ...kit, ...injected, ...slotInjected.props, ...contextual, ...ownerProps })
```

| 来源 | 内容 |
|---|---|
| `kit` | 若声明 `locale` → 有 `t`；若声明 store → 有 `useStore`/`actions`；若声明 `children` → `renderSlot` |
| `injected` | **你的 `inject` 函数返回值**，逐字展开为 props |
| `ownerProps` | 插槽拥有者传的：`{ close: onClose }`（**仅激活时**渲染）|

**特殊规则**：`injected` 里的 `hooks` 键**不会**作为 prop 透传，其每个条目会变成
名为 `use<Capitalized>` 的 prop。

⚠️ `ownerProps` **最后展开**，拥有者永远覆盖同名。**别取这些名字**：
`close`、`t`、`renderSlot`、`actions`、`useX`。

## 6. 插件侧 RPC（客户端可调）

DSH 有**两套**机制：

### (A) 官方：Typert Remote 装饰器 ⭐ 推荐

```js
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

class XiaoaiController extends TypertRemoteService {
  constructor(ctx) { super(ctx, "xiaoaiController", { namespace: "xiaoai" }); }
  @Remote async speak(text) { ... }              // → 端点 "xiaoai/speak"
  @Remote("name") async other() { ... }          // 显式导出名
  @Remote({ mode: "stream" }) async *watch() {}  // 流式
}
```

失败时 `throw new RemoteError(code, message, details)` → 客户端收到 `{ok:false,error}`。
客户端：`await ctx.remote.xiaoai.speak("...")`。

### (B) dsh-im 用的：裸 HTTP 路由

```js
ctx.connection.fetch.register({
  path: `/api/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
  async fetch(request) { /* 校验 type==="client-request" 等，返回 {type:"server-response", rpcId, result} */ }
});
```

客户端需 inject `@deepseek-ai/dsh-client-connection`，
调用 `ctx.connection.rpc.call('/api', endpoint, { method, payload }, signal)`。

**结论：dsh-xiaoai 用 (A)。** 有类型化结果、自动 `{ok,value}` 联合、无需手写 fetch 和 rpcId 记账。

## 7. 客户端 bundle 加载协议

```js
window.__ModuleLoader__.load({
  id: "dsh-xiaoai",
  factory: (require) => { var module = { exports: {} }; /* cjs */ return module.exports; }
});
```

重复注册同 id 会抛错。`require` 只认**平台种子**，其余一律抛
"require(...) missed the module table"。

**✅ 平台种子（9 个，任何插件都能 require）**：

```
react
react/jsx-runtime
react-dom
react-dom/client
@deepseek-ai/cordis
@deepseek-ai/dsh-client-store
@deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-ui-primitives     ← Switch / Button / Modal / Tooltip
@deepseek-ai/dsh-client-ui-dockkit
```

`package.json` 的 `dsh.client.inject` 里列出的包也会被预置。

## 8. 本地化

```js
ctx.locale.register(ns, { zh, en });   // 或 register(ns, "zh", {...})
const t = ctx.locale.bind(ns);          // t(key, params)
```

查找链最终回落到 `"en"`，再回落到 `common` 命名空间，最后**返回 key 本身**。
插值只支持 `{name}`。重复注册同一 `(ns, locale)` 抛错。返回 disposer。

**不必注册字典** —— `label` 可以直接返回字符串。只有想让标签跟随界面语言时才注册。

## 9. 最小完整插件清单

```
package.json
lib/index.js       (host)
lib/client.js      (client bundle)
cordis.patch.yml   (仅在需要 loader 配置时)
```

```json
{
  "type": "module",
  "main": "./lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "dsh": { "client": { "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-ui-settings",
               "@deepseek-ai/dsh-client-ui-slots","@deepseek-ai/dsh-client-locale"] } }
}
```

⚠️ 声明了 `dsh.client` 却**没有 `./client` 导出** → **启动时抛错**
（这正是 `dsh-boot-wake` 让 DSH 崩掉的原因）。

## ❌ 未验证 / 不要依赖

| 项 | 状态 |
|---|---|
| `@api_command` | **不存在**（全树零命中）|
| `ctx.remote.$host.isLoopback` | 存在但契约未读完 |
| `dsh.client.external` 对非种子模块的语义 | 未端到端验证 → 优先用 `inject` |
| 重复 `settings.section` id 是否在挂载时抛错 | 未实际执行验证 |
