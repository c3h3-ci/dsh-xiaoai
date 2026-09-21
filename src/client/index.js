/**
 * dsh-xiaoai — 客户端（浏览器侧）一半。
 *
 * 职责：在 DSH 设置面板里注册一个「小爱语音」分区，展示 XIAOAI_RUNTIME 的运行时状态，
 * 并让用户编辑设置 / 重启循环 / 测试音箱与 TTS。
 *
 * 严格遵循 contract/INTERFACE.md：
 *   §3 状态形状、§4 RPC 方法名与入参、§5 组件 props。
 *
 * 打包协议见 docs/DSH-PLUGIN-API.md §7：
 *   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
 * `require` 只认平台种子，其中 `react` 与 `react/jsx-runtime` 可用。
 *
 * 无 JSX / 无 TypeScript / 无构建步骤 —— 全部用 React.createElement。
 */

window.__ModuleLoader__.load({
	id: "dsh-xiaoai",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");

		/** 设置命名空间，必须与服务端一致（契约 §2）。 */
		const NS = "dsh-xiaoai";

		/** RPC 命名空间（契约 §4：客户端通过 ctx.remote.xiaoai.<method>() 调用）。 */
				// ═══════════════════════════════════════════════════════════════════
		// ⚠️⚠️⚠️ 重要：不要把 RPC 改成 ctx.remote.xiaoai ⚠️⚠️⚠️
		//
		// 这个改动【已经被回退过 3 次】，每次都会让 UI 报
		//   「remote.xiaoai 在 10s 内未挂载」→ 用户以为插件坏了。
		//
		// 事实：ctx.remote.xiaoai **永远不会挂载**。
		//   客户端的 remote 命名空间由 dsh-api-gateway 用 $mount() fork，
		//   而 contribution 清单是硬编码的 19 个官方包，第三方没有扩展点
		//   （dsh-api-remotes/lib/types/client/index.js:1-46；
		//    官方 dsh-typert-loader/README.md:114 承认客户端发现机制未实现）。
		//
		// 正解：走 HTTP 直连 POST /api/xiaoai/<method>。
		//   Gateway 对未注册 manifest 的服务有 SRC 回退
		//   （resolveSrcDescriptor, dsh-api-gateway/lib/index.js:758-782），
		//   该端点已实测可用。
		//
		// 若你正准备"优化"回 ctx.remote —— 请先读上面这两条源码引用。
		// ═══════════════════════════════════════════════════════════════════

const RPC_NS = "xiaoai";

		/** RPC 方法名的公共前缀，用于剥出 remote.xiaoai 上的裸方法名。 */
		const RPC_PREFIX = RPC_NS + ".";

		/** 状态轮询间隔（契约 §3：UI 每 2s 轮询）。 */
		const POLL_INTERVAL_MS = 2000;

		/** 日志查看器一次拉取的行数。 */
		const LOG_LIMIT = 100;

		/** 「测试音箱」发送的短语。 */
		const SPEAK_TEST_PHRASE = "小爱同学，这是来自 DSH 的语音测试。";

		/** 「自检」发送的提示词。 */
		const SELF_TEST_PROMPT = "请用一句话回答：语音链路自检是否正常？";

		const h = React.createElement;

		//#region 样式注入
		//
		// 【背景】组件里一直写着 className="xiaoai-*"，但从来没有注入过对应
		// 的 CSS —— 浏览器于是按默认样式渲染：裸 input、灰色系统按钮、
		// 零间距、无层次，这也是「太难看」的唯一根因。
		//
		// 【做法】照抄官方 dsh-client-ui-workspace 的注入惯例：
		//   1. 建 <style>，打上 data-plugin / data-plugin-css 标记；
		//   2. 用 `style[data-plugin-css="..."]` 做**幂等**查询，已存在就跳过；
		//   3. 追加到 document.head。
		// 模块级 `styleInjected` 只是省掉一次 DOM 查询的快路径，真正的
		// 幂等保证是那个选择器（热重载时模块会重新求值，标记仍能命中）。
		//
		// 【配色】一律走 DSH 设计 token（--dsw-alias-*），不硬编码颜色，
		// 这样明暗主题自动适配。注意：**不存在** --primary-color /
		// --card-background-color 这类变量（那是 Home Assistant 的命名），
		// 这里用的是从官方插件 CSS 里实测到的真实 token 名。
		//
		// 【定位】纯样式层：DOM 结构一个节点都没动，宿主样式一律靠
		// CSS 变量与继承适配，不依赖也不覆盖宿主实现。

		/** <style> 的标记 id，用于幂等查询（与官方插件同构）。 */
		const STYLE_TAG_ID = "dsh-xiaoai/client.css";

		/** 快路径标记；真正的幂等由 STYLE_TAG_ID 的 DOM 查询保证。 */
		let styleInjected = false;

		/**
		 * 面板样式表。
		 *
		 * 全部规则都锚在 `.xiaoai-section` 之下，避免污染宿主设置页的
		 * 其它分区，也不需要 !important 去对抗宿主默认样式。
		 */
		const STYLESHEET = `
.xiaoai-section {
	display: flex;
	flex-direction: column;
	gap: 20px;
	color: var(--dsw-alias-label-primary);
	font-family: var(--dsw-font-family, inherit);
	font-size: 14px;
	line-height: 20px;
	box-sizing: border-box;
}
.xiaoai-section *,
.xiaoai-section *::before,
.xiaoai-section *::after {
	box-sizing: border-box;
}

/* ── 标题层次 ───────────────────────────────────────────── */
.xiaoai-heading {
	margin: 0;
	font-size: 16px;
	line-height: 24px;
	font-weight: 600;
	color: var(--dsw-alias-label-primary);
}
.xiaoai-title {
	margin: 0;
	font-size: 14px;
	line-height: 20px;
	font-weight: 600;
	color: var(--dsw-alias-label-primary);
}
.xiaoai-muted {
	margin: 0;
	font-size: 12px;
	line-height: 17px;
	color: var(--dsw-alias-label-tertiary);
}
.xiaoai-field-hint {
	font-size: 12px;
	line-height: 17px;
	color: var(--dsw-alias-label-tertiary);
}

/* ── 卡片分区 ───────────────────────────────────────────── */
.xiaoai-header,
.xiaoai-wizard,
.xiaoai-form,
.xiaoai-recent,
.xiaoai-logs-block {
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 16px;
	border: 1px solid var(--dsw-alias-border-l2, transparent);
	border-radius: 12px;
	background: var(--dsw-alias-bg-layer-1, transparent);
}
.xiaoai-wizard {
	gap: 16px;
}
.xiaoai-form {
	gap: 16px;
}
.xiaoai-recent,
.xiaoai-logs-block {
	gap: 12px;
}

/* 头部：状态行贴紧一点，错误信息才不至于散开 */
.xiaoai-header {
	gap: 8px;
}

/* ── 状态指示灯 ─────────────────────────────────────────── */
.xiaoai-status {
	display: inline-flex;
	align-items: center;
	gap: 6px;
}
.xiaoai-dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	flex: none;
	/* 组件用内联 style 传状态色，这里只补一圈描边让它不糊在背景上 */
	box-shadow: 0 0 0 2px var(--dsw-alias-bg-layer-1, transparent);
}
.xiaoai-status-text {
	font-weight: 500;
	color: var(--dsw-alias-label-primary);
}
.xiaoai-status-line {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 8px;
}
.xiaoai-status-sep {
	color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary));
}
.xiaoai-speaker {
	font-weight: 500;
	color: var(--dsw-alias-label-primary);
}

/* ── 语义色：错误 / 警告 / 成功 ─────────────────────────── */
.xiaoai-error {
	margin: 0;
	padding: 8px 12px;
	font-size: 13px;
	line-height: 19px;
	color: var(--dsw-alias-state-error-primary);
	background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
	border-radius: 8px;
}
.xiaoai-warn {
	margin: 0;
	padding: 8px 12px;
	font-size: 13px;
	line-height: 19px;
	color: var(--dsw-alias-state-warn-primary);
	background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);
	border-radius: 8px;
}
.xiaoai-ok {
	margin: 0;
	padding: 8px 12px;
	font-size: 13px;
	line-height: 19px;
	color: var(--dsw-alias-state-success-primary);
	background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
	border-radius: 8px;
}
.xiaoai-bad {
	color: var(--dsw-alias-state-error-primary);
	font-weight: 500;
}
/* 头部里 DSH 连通性那种行内 ok/bad 不该带色块 */
.xiaoai-status-line .xiaoai-ok,
.xiaoai-status-line .xiaoai-bad {
	padding: 0;
	background: none;
	font-size: inherit;
	line-height: inherit;
}

/* ── 键值行 ─────────────────────────────────────────────── */
.xiaoai-info-row {
	display: flex;
	align-items: baseline;
	gap: 12px;
	min-width: 0;
}
.xiaoai-info-label {
	flex: none;
	min-width: 84px;
	font-size: 13px;
	color: var(--dsw-alias-label-secondary);
}
.xiaoai-info-value {
	flex: 1;
	min-width: 0;
	color: var(--dsw-alias-label-primary);
	overflow-wrap: anywhere;
}

/* ── 表单字段 ───────────────────────────────────────────── */
.xiaoai-field {
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.xiaoai-field-label {
	font-size: 13px;
	font-weight: 500;
	color: var(--dsw-alias-label-secondary);
}
.xiaoai-input {
	width: 100%;
	padding: 8px 12px;
	font-family: inherit;
	font-size: 14px;
	line-height: 20px;
	color: var(--dsw-alias-label-primary);
	background: var(--dsw-alias-bg-base, var(--dsw-specific-input-major, transparent));
	border: 1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, currentColor));
	border-radius: 8px;
	outline: none;
	transition: border-color .15s var(--ds-ease-in-out, ease), background .15s var(--ds-ease-in-out, ease);
}
.xiaoai-input::placeholder {
	color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary));
}
.xiaoai-input:hover:not(:disabled) {
	border-color: var(--dsw-alias-border-l4, var(--dsw-alias-border-l2, currentColor));
}
.xiaoai-input:focus {
	border-color: var(--dsw-alias-brand-primary);
	background: var(--dsw-alias-bg-base, var(--dsw-specific-input-major, transparent));
	box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);
}
.xiaoai-input:disabled {
	color: var(--dsw-alias-label-dimmed);
	background: var(--dsw-alias-bg-layer-2, transparent);
	cursor: not-allowed;
}

/* 总开关 */
.xiaoai-switch {
	display: flex;
	align-items: center;
	gap: 8px;
	cursor: pointer;
	color: var(--dsw-alias-label-primary);
}
.xiaoai-switch input[type="checkbox"] {
	width: 16px;
	height: 16px;
	margin: 0;
	accent-color: var(--dsw-alias-brand-primary);
	cursor: pointer;
}

/* ── 按钮 ───────────────────────────────────────────────── */
.xiaoai-actions {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	align-items: center;
}
.xiaoai-button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	padding: 7px 14px;
	font-family: inherit;
	font-size: 13px;
	line-height: 18px;
	font-weight: 500;
	color: var(--dsw-alias-label-primary);
	background: var(--dsw-alias-button-elevated-fill, var(--dsw-alias-bg-layer-2, transparent));
	border: 1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, currentColor));
	border-radius: 8px;
	cursor: pointer;
	white-space: nowrap;
	transition: background .15s var(--ds-ease-in-out, ease), border-color .15s var(--ds-ease-in-out, ease),
		color .15s var(--ds-ease-in-out, ease), opacity .15s var(--ds-ease-in-out, ease);
}
.xiaoai-button:hover:not(:disabled) {
	background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3, transparent));
	border-color: var(--dsw-alias-border-l4, var(--dsw-alias-border-l2, currentColor));
}
.xiaoai-button:active:not(:disabled) {
	background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover, transparent));
}
.xiaoai-button:focus-visible {
	border-color: var(--dsw-alias-brand-primary);
	box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);
	outline: none;
}
.xiaoai-button-primary {
	color: var(--dsw-alias-label-primary-inverted, #fff);
	background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
	border-color: transparent;
}
.xiaoai-button-primary:hover:not(:disabled) {
	background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
	border-color: transparent;
	filter: brightness(1.08);
}
.xiaoai-button-primary:active:not(:disabled) {
	filter: brightness(.94);
}
/* 禁用态：必须一眼看出不可点（对应「空表单禁用登录」） */
.xiaoai-button:disabled {
	opacity: .45;
	cursor: not-allowed;
	filter: grayscale(1);
}
.xiaoai-button:disabled:hover {
	background: var(--dsw-alias-button-elevated-fill, var(--dsw-alias-bg-layer-2, transparent));
	border-color: var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, currentColor));
}

/* ── 向导：步骤指示 ─────────────────────────────────────── */
.xiaoai-wizard-head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 12px;
	flex-wrap: wrap;
}
.xiaoai-steps {
	display: flex;
	align-items: center;
	gap: 8px;
}
.xiaoai-step {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 24px;
	height: 24px;
	flex: none;
	font-size: 12px;
	font-weight: 600;
	color: var(--dsw-alias-label-tertiary);
	background: var(--dsw-alias-bg-layer-2, transparent);
	border: 1px solid var(--dsw-alias-border-l2, transparent);
	border-radius: 50%;
	transition: background .15s var(--ds-ease-in-out, ease), color .15s var(--ds-ease-in-out, ease),
		border-color .15s var(--ds-ease-in-out, ease);
}
.xiaoai-step-done {
	color: var(--dsw-alias-label-primary-inverted, #fff);
	background: var(--dsw-alias-state-success-primary);
	border-color: transparent;
}
/* 当前步骤：高亮 + 外圈，一眼看出进度 */
.xiaoai-step-active {
	color: var(--dsw-alias-label-primary-inverted, #fff);
	background: var(--dsw-alias-brand-primary);
	border-color: transparent;
	box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);
}

/* ── 向导：选项列表 ─────────────────────────────────────── */
.xiaoai-choices {
	display: flex;
	flex-direction: column;
	gap: 8px;
}
.xiaoai-choice {
	display: flex;
	align-items: flex-start;
	gap: 10px;
	padding: 12px;
	cursor: pointer;
	background: var(--dsw-alias-bg-layer-1, transparent);
	border: 1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, currentColor));
	border-radius: 10px;
	transition: background .15s var(--ds-ease-in-out, ease), border-color .15s var(--ds-ease-in-out, ease);
}
.xiaoai-choice:hover {
	background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2, transparent));
	border-color: var(--dsw-alias-border-l4, var(--dsw-alias-border-l2, currentColor));
}
.xiaoai-choice-selected {
	background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent);
	border-color: var(--dsw-alias-brand-primary);
}
.xiaoai-choice input[type="radio"] {
	flex: none;
	width: 16px;
	height: 16px;
	margin: 2px 0 0;
	accent-color: var(--dsw-alias-brand-primary);
	cursor: pointer;
}
.xiaoai-choice-body {
	display: flex;
	flex-direction: column;
	gap: 3px;
	min-width: 0;
	flex: 1;
}
.xiaoai-choice-title {
	font-size: 14px;
	line-height: 20px;
	font-weight: 500;
	color: var(--dsw-alias-label-primary);
}
.xiaoai-choice-desc {
	font-size: 12px;
	line-height: 17px;
	color: var(--dsw-alias-label-secondary);
}
.xiaoai-choice-path {
	font-family: var(--dsw-font-mono, monospace);
	font-size: 12px;
	line-height: 17px;
	color: var(--dsw-alias-label-tertiary);
	overflow-wrap: anywhere;
}

/* ── 向导：授权提示与完成态 ─────────────────────────────── */
.xiaoai-authchallenge {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 12px;
	background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent);
	border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent);
	border-radius: 10px;
}
.xiaoai-authchallenge .xiaoai-warn {
	padding: 0;
	background: none;
	font-weight: 500;
}
.xiaoai-authlink {
	color: var(--dsw-alias-link, var(--dsw-alias-brand-primary));
	text-decoration: underline;
	overflow-wrap: anywhere;
}
.xiaoai-authlink:hover {
	text-decoration: none;
}
.xiaoai-wizard-done {
	display: flex;
	flex-direction: column;
	gap: 10px;
}

/* ── 自检回复 / 凭据说明 ───────────────────────────────── */
.xiaoai-selftest {
	margin: 0;
	padding: 10px 12px;
	font-size: 13px;
	line-height: 19px;
	color: var(--dsw-alias-label-primary);
	background: var(--dsw-alias-bg-layer-2, transparent);
	border-left: 3px solid var(--dsw-alias-brand-primary);
	border-radius: 6px;
	overflow-wrap: anywhere;
}
.xiaoai-cred {
	font-size: 12px;
	line-height: 17px;
	color: var(--dsw-alias-label-tertiary);
	overflow-wrap: anywhere;
}
.xiaoai-mode {
	font-size: 12px;
	color: var(--dsw-alias-label-tertiary);
}

/* ── 日志查看器 ─────────────────────────────────────────── */
.xiaoai-logs-bar {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
}
.xiaoai-logs {
	margin: 0;
	max-height: 260px;
	overflow: auto;
	padding: 12px;
	font-family: var(--dsw-font-mono, monospace);
	font-size: 12px;
	line-height: 17px;
	color: var(--dsw-alias-label-secondary);
	background: var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-layer-2, transparent));
	border-radius: 8px;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.xiaoai-logs::-webkit-scrollbar {
	width: 8px;
	height: 8px;
}
.xiaoai-logs::-webkit-scrollbar-thumb {
	background: var(--dsw-alias-scrollbar-bg-l2, transparent);
	border-radius: 4px;
}
.xiaoai-logs::-webkit-scrollbar-thumb:hover {
	background: var(--dsw-alias-scrollbar-hover-l2, var(--dsw-alias-scrollbar-bg-l2, transparent));
}

/* ── 无障碍：尊重系统的减少动效设置 ─────────────────────── */
@media (prefers-reduced-motion: reduce) {
	.xiaoai-section .xiaoai-button,
	.xiaoai-section .xiaoai-input,
	.xiaoai-section .xiaoai-choice,
	.xiaoai-section .xiaoai-step {
		transition: none;
	}
}

/* ── 加载指示（spinner）─────────────────────────────────────
   由 UI 修复员 E 在 JS 里挂 class，但样式契约在此。
   用 currentColor 让它在两种场景自动取色：
     · 主按钮内 → 白色（按钮前景色）
     · 提示行内 → 次要文字色
   没有 @keyframes 时 spinner 会静止成方块，所以这条必须有。 */
@keyframes xiaoai-spin {
	to { transform: rotate(360deg); }
}
.xiaoai-spinner {
	display: inline-block;
	width: 12px;
	height: 12px;
	border: 2px solid currentColor;
	border-top-color: transparent;
	border-radius: 50%;
	animation: xiaoai-spin 0.7s linear infinite;
	vertical-align: -2px;
	margin-right: 6px;
}
.xiaoai-btn-busy {
	display: inline-flex;
	align-items: center;
	gap: 6px;
}
/* 「还没填」的提示：琥珀色而非红色 —— 这不是错误，只是暂未满足条件 */
.xiaoai-hint-need {
	color: #b45309;
	font-size: 12px;
	line-height: 18px;
	margin: 4px 0 8px;
}
/* busy 期间的整行说明文字 */
.xiaoai-busy-note {
	display: flex;
	align-items: center;
	color: var(--dsw-alias-label-secondary, #6b7280);
	font-size: 12px;
	line-height: 18px;
	margin: 4px 0 8px;
}
@media (prefers-reduced-motion: reduce) {
	.xiaoai-spinner { animation-duration: 2s; }
}
`;

		/**
		 * 把样式注入 <head>。幂等：重复调用只会命中已有的标记。
		 * SSR / 测试等无 document 环境下静默跳过。
		 */
		function injectStyles() {
			if (styleInjected) return;
			if (typeof document === "undefined" || document.head === null) return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_TAG_ID) + "]") !== null) {
				styleInjected = true;
				return;
			}
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-xiaoai";
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = STYLESHEET;
			document.head.appendChild(tag);
			styleInjected = true;
		}

		// 模块求值时就注入，而不是等到面板首次渲染 ——
		// 官方客户端插件同样是模块级注入。此处没有顶层 await，
		// 同步调用不会拖慢模块加载。
		injectStyles();

		//#endregion

		/**
		 * 轮询兜底用的当前 rpc 引用。
		 * `inject` 返回的 rpc 是注册时构造的，内部已经闭包住 ctx.remote，
		 * 因此这里只需要一个指向它的模块级句柄。每个面板实例在渲染时刷新它。
		 */
		let currentRpc = null;

		/**
		 * 是否已经拿到服务端推来的状态。
		 * 只要 useXiaoai() 返回过一个非空状态，就认为推送链路可用，
		 * 此时不再启动本地轮询兜底。
		 */
		let hasPushedStatus = false;

		//#region 纯工具函数

		/** 空字符串/未定义一律视作「未填写」。 */
		function isBlank(value) {
			return value === undefined || value === null || String(value).trim() === "";
		}

		/** 把逗号分隔文本解析成去空白的数组；空文本得到空数组。 */
		function parseList(text) {
			if (isBlank(text)) return [];
			return String(text)
				.split(",")
				.map((part) => part.trim())
				.filter((part) => part !== "");
		}

		/** 数组渲染回逗号分隔文本。 */
		function formatList(value) {
			return Array.isArray(value) ? value.join(", ") : "";
		}

		/** 相对时间：刚刚 / N 秒前 / N 分钟前 / N 小时前。 */
		function relativeTime(at) {
			if (typeof at !== "number" || !Number.isFinite(at)) return "从未";
			const deltaMs = Date.now() - at;
			if (deltaMs < 0) return "刚刚";
			const seconds = Math.floor(deltaMs / 1000);
			if (seconds < 10) return "刚刚";
			if (seconds < 60) return seconds + " 秒前";
			const minutes = Math.floor(seconds / 60);
			if (minutes < 60) return minutes + " 分钟前";
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return hours + " 小时前";
			return Math.floor(hours / 24) + " 天前";
		}

		/** phase → 文案与指示灯颜色。 */
		function phaseMeta(phase) {
			switch (phase) {
				case "running":
					return { text: "运行中", color: "#2ea043" };
				case "starting":
					return { text: "启动中", color: "#d29922" };
				case "error":
					return { text: "出错", color: "#f85149" };
				case "stopped":
					return { text: "已停止", color: "#8b949e" };
				default:
					return { text: "未知", color: "#8b949e" };
			}
		}

		/**
		 * 音箱侧 AI 模式 → 徽章文案与颜色。
		 *
		 * 为什么要展示：用户看不到「当前在不在 AI 模式」时会误操作 ——
		 * 明明不在模式里却说「退出」（没反应），或者在模式里说普通话
		 * 被转发出去（费 token）。把它显示出来是最低成本的解释手段。
		 */
		function aiModeMeta(mode) {
			switch (mode) {
				case "active":
					return { text: "AI 模式已开启", color: "#2ea043" };
				case "thinking":
					return { text: "思考中…", color: "#d29922" };
				case "replying":
					return { text: "回复中…", color: "#d29922" };
				case "idle":
				default:
					return { text: "待机（等唤醒词）", color: "#8b949e" };
			}
		}

		/**
		 * 从 RPC 返回值里取出值。
		 * 服务端是 Typert Remote，返回 {ok:true,value} / {ok:false,error}；
		 * 但也兼容直接返回裸值的情况（早期实现）。
		 */
		function unwrap(result) {
			if (result && typeof result === "object" && "ok" in result) {
				if (result.ok === false) {
					const error = result.error;
					const message = error && error.message ? error.message : "未知错误";
					const code = error && error.code ? error.code : "RPC_ERROR";
					const failure = new Error(message);
					failure.code = code;
					throw failure;
				}
				return result.value;
			}
			return result;
		}

		/** 把任意抛出物转成可展示的中文错误串（含 RPC code）。 */
		function describeError(error) {
			if (!error) return "未知错误";
			const message = error.message ? String(error.message) : String(error);
			return error.code ? message + "（" + error.code + "）" : message;
		}

		//#endregion

		//#region 设置归一化

		/** 契约 §2 的默认值，用于服务端未返回字段时兜底。 */
		const SETTING_DEFAULTS = {
			enabled: true,
			userId: "",
			password: "",
			did: "",
			pollIntervalMs: 4000,
			maxReplyChars: 400,
			triggerKeywords: [],
			ignorePatterns: ["^小爱同学$"]
		};

		/** 把 settings.get 的值对象补全成 UI 需要的完整形状。 */
		function normalizeSettings(values) {
			const source = values && typeof values === "object" ? values : {};
			return {
				enabled: source.enabled === undefined ? SETTING_DEFAULTS.enabled : Boolean(source.enabled),
				userId: isBlank(source.userId) ? SETTING_DEFAULTS.userId : String(source.userId),
				password: isBlank(source.password) ? SETTING_DEFAULTS.password : String(source.password),
				did: isBlank(source.did) ? SETTING_DEFAULTS.did : String(source.did),
				pollIntervalMs:
					typeof source.pollIntervalMs === "number"
						? source.pollIntervalMs
						: SETTING_DEFAULTS.pollIntervalMs,
				maxReplyChars:
					typeof source.maxReplyChars === "number"
						? source.maxReplyChars
						: SETTING_DEFAULTS.maxReplyChars,
				triggerKeywords: Array.isArray(source.triggerKeywords)
					? source.triggerKeywords
					: SETTING_DEFAULTS.triggerKeywords,
				ignorePatterns: Array.isArray(source.ignorePatterns)
					? source.ignorePatterns
					: SETTING_DEFAULTS.ignorePatterns
			};
		}

		/**
		 * 由「草稿」构造 settings.update 的 patch（契约 §4）。
		 * 数字字段做范围钳制，列表字段做逗号切分。
		 */
		function buildPatch(draft) {
			const patch = {
				enabled: Boolean(draft.enabled),
				userId: String(draft.userId || "").trim(),
				password: String(draft.password || ""),
				did: String(draft.did || "").trim(),
				triggerKeywords: parseList(draft.triggerKeywords),
				ignorePatterns: parseList(draft.ignorePatterns)
			};
			const poll = Number(draft.pollIntervalMs);
			patch.pollIntervalMs = Number.isFinite(poll) && poll >= 2000 ? Math.floor(poll) : 2000;
			const maxChars = Number(draft.maxReplyChars);
			patch.maxReplyChars = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 400;
			return patch;
		}

		/**
		 * 服务端对 password 打码（契约 §2），因此回读到的可能是掩码串。
		 * 掩码值绝不能回写覆盖真实密码 —— 这里识别并清空。
		 */
		function isRedacted(value) {
			if (isBlank(value)) return false;
			const text = String(value);
			return /^[*•\u2022]+$/.test(text) || text === "__REDACTED__" || text.indexOf("***") !== -1;
		}

		//#endregion

		//#region 通用 UI 原子

		/** 小标题。 */
		function SectionTitle(text) {
			return h("h3", { className: "xiaoai-title", key: "title" }, text);
		}

		/** 一行「标签 + 控件」。 */
		function Field(label, control, hint) {
			return h(
				"label",
				{ className: "xiaoai-field", key: label },
				h("span", { className: "xiaoai-field-label" }, label),
				control,
				hint ? h("span", { className: "xiaoai-field-hint" }, hint) : null
			);
		}

		/**
		 * 文本/数字/密码输入框。
		 * 注意：props 里绝不能出现 close/t/renderSlot/actions/useX 这些名字，
		 * 因此内部参数一律用 onChange 之类的普通名字。
		 */
		function TextInput(options) {
			return h("input", {
				className: "xiaoai-input",
				type: options.type || "text",
				value: options.value,
				placeholder: options.placeholder || "",
				autoComplete: options.autoComplete || "off",
				onChange: (event) => options.onChange(event.target.value)
			});
		}

		/** 按钮。 */
		function Button(label, onClick, options) {
			const opts = options || {};
			return h(
				"button",
				{
					type: "button",
					className: "xiaoai-button" + (opts.primary ? " xiaoai-button-primary" : ""),
					onClick,
					disabled: Boolean(opts.disabled),
					title: opts.title || ""
				},
				label
			);
		}

		/** 状态指示灯 + 文案。 */
		function StatusDot(phase) {
			const meta = phaseMeta(phase);
			return h(
				"span",
				{ className: "xiaoai-status", key: "status" },
				h("span", {
					className: "xiaoai-dot",
					style: { backgroundColor: meta.color }
				}),
				h("span", { className: "xiaoai-status-text" }, meta.text)
			);
		}

		/**
		 * AI 模式徽章。
		 *
		 * 与 StatusDot 并列展示 —— 前者说「插件进程是否在跑」，
		 * 这个说「音箱现在会不会把你的话转给 DSH」，两者是不同维度，
		 * 用户最常搞混的正是后者。
		 */
		function AiModeBadge(mode) {
			const meta = aiModeMeta(mode);
			return h(
				"span",
				{ className: "xiaoai-status xiaoai-ai-mode", key: "ai-mode" },
				h("span", {
					className: "xiaoai-dot",
					style: { backgroundColor: meta.color }
				}),
				h("span", { className: "xiaoai-status-text" }, meta.text)
			);
		}

		/** 键值对行。 */
		function InfoRow(label, value) {
			return h(
				"div",
				{ className: "xiaoai-info-row", key: label },
				h("span", { className: "xiaoai-info-label" }, label),
				h("span", { className: "xiaoai-info-value" }, value)
			);
		}

		//#endregion

		//#region 首次接入向导（onboarding）
		//
		// 设计目标：**3 步内接通，最好零输入**。
		//
		// 参考实现（都是真实项目，不是凭空设计）：
		//  · xiaogpt —— 用户永远不该手填 DID：先 `mina_service.device_list()`
		//    拿账号下所有音箱，再让用户选（简化自它的 `_init_data_hardware()`）。
		//  · MiGPT —— 型号兼容表（ttsCommand/wakeUpCommand）与「导入已有配置」
		//    的思路；它的 `.mi.json` 与本插件 vendor 同构，可零转换复用。
		//  · HA xiaomi_miot —— 先登录 → 从设备下拉里选设备；凭据缓存复用。
		//  · 小米风控 —— 异地登录需要用户在浏览器授权并等约 1 小时，
		//    这一步必须有自己的 UI（不能只弹一行红字）。

		/** 向导步骤。 */
		const WIZARD_STEPS = {
			CHOOSE: "choose",
			IMPORT: "import",
			LOGIN: "login",
			MANUAL: "manual",
			SPEAKER: "speaker",
			DONE: "done"
		};

		/**
		 * 用户感知的步骤编号。
		 * 内部有 6 个 step，但 import / login / manual 是三种并列的
		 * "提供凭据"方式，对用户而言是同一步，因此对外只呈现 4 步：
		 *   choose → 1 / import|login|manual → 2 / speaker → 3 / done → 4
		 */
		const WIZARD_TOTAL_STEPS = 4;
		const WIZARD_STEP_NUMBER = {
			choose: 1,
			import: 2,
			login: 2,
			manual: 2,
			speaker: 3,
			done: 4
		};

		/** "第 N 步 / 共 4 步"；step 未知时退化为不带编号。 */
		function stepLabel(step) {
			const n = WIZARD_STEP_NUMBER[step];
			if (!n) return "";
			return "第 " + n + " 步 / 共 " + WIZARD_TOTAL_STEPS + " 步";
		}

		/** 支持等级 → 用户能看懂的一句话。 */
		function supportText(support) {
			switch (support) {
				case "perfect":
					return "兼容性良好";
				case "ok":
					return "可用（部分机型不支持连续对话，本插件不需要）";
				case "unsupported":
					return "已知不受支持，可能无法正常收发语音";
				default:
					return "型号未收录，将使用默认指令；若音箱无响应请手动配置";
			}
		}

		/** 支持等级 → 颜色。 */
		function supportColor(support) {
			switch (support) {
				case "perfect":
					return "#2ea043";
				case "ok":
					return "#d29922";
				case "unsupported":
					return "#f85149";
				default:
					return "#8b949e";
			}
		}

		/** 单选行（radio + 标题 + 说明）。 */
		function ChoiceRow(options) {
			const opts = options || {};
			return h(
				"label",
				{
					className: "xiaoai-choice" + (opts.selected ? " xiaoai-choice-selected" : ""),
					key: opts.key || opts.title
				},
				h("input", {
					type: "radio",
					name: opts.group || "xiaoai-choice",
					checked: Boolean(opts.selected),
					onChange: () => opts.onSelect()
				}),
				h(
					"span",
					{ className: "xiaoai-choice-body" },
					h("span", { className: "xiaoai-choice-title" }, opts.title),
					opts.desc ? h("span", { className: "xiaoai-choice-desc" }, opts.desc) : null,
					opts.extra || null
				)
			);
		}

		/** 向导的步骤指示条。 */
		function StepBar(current, order) {
			const idx = order.indexOf(current);
			return h(
				"div",
				{ className: "xiaoai-steps" },
				order.map((step, i) =>
					h(
						"span",
						{
							key: step,
							className:
								"xiaoai-step" +
								(i === idx ? " xiaoai-step-active" : "") +
								(i < idx ? " xiaoai-step-done" : "")
						},
						String(i + 1)
					)
				)
			);
		}

		/**
		 * 首次接入向导主体。
		 *
		 * 状态机（step）：
		 *   choose  → 选接入方式
		 *   import  → 列出扫描到的凭据，选一个
		 *   login   → 填账号密码；若触发风控则显示授权链接
		 *   manual  → 专家模式，手填 3 个字段
		 *   speaker → 选择音箱（自动填充 DID + 型号指令）
		 *   done    → 测试连通
		 */
		function renderOnboarding(state) {
			const children = [];

			// ── 标题与进度 ──
			children.push(
				h(
					"div",
					{ className: "xiaoai-wizard-head", key: "head" },
					h("h3", { className: "xiaoai-title" }, "接入小米音箱"),
					h(
						"span",
						{ className: "xiaoai-muted" },
						stepLabel(state.step)
					)
				)
			);

			// ── 错误 / 提示 ──
			if (state.error) {
				children.push(
					h("p", { className: "xiaoai-error", role: "alert", key: "err" }, state.error)
				);
			}

			// ── Step 1：选接入方式 ──
			if (state.step === "choose") {
				children.push(
					h(
						"p",
						{ className: "xiaoai-muted", key: "hint" },
						"先扫描本机是否已有可用的小米凭据 —— 若有，可完全跳过登录（小米对异地登录有风控）。"
					)
				);
				children.push(
					h(
						"div",
						{ className: "xiaoai-choices", key: "choices" },
						ChoiceRow({
							key: "auto",
							group: "xiaoai-mode",
							selected: state.mode === "auto",
							title: "自动导入（推荐）",
							desc: "从本机 MiGPT / Home Assistant 的已有配置里读取凭据，无需重新登录",
							onSelect: () => state.onChooseMode("auto")
						}),
						ChoiceRow({
							key: "account",
							group: "xiaoai-mode",
							selected: state.mode === "account",
							title: "账号登录",
							desc: "用手机号 / 邮箱 / 小米 ID + 密码登录（服务端自动识别账号类型）",
							onSelect: () => state.onChooseMode("account")
						}),
						ChoiceRow({
							key: "manual",
							group: "xiaoai-mode",
							selected: state.mode === "manual",
							title: "手动配置（专家）",
							desc: "自己填写小米 ID、密码与音箱 DID",
							onSelect: () => state.onChooseMode("manual")
						})
					)
				);
				children.push(
					h(
						"div",
						{ className: "xiaoai-actions", key: "act" },
						Button(state.scanning ? "扫描中…" : "下一步", state.onNextFromChoose, {
							primary: true,
							disabled: state.scanning || !state.mode
						})
					)
				);
			}

			// ── Step 2a：自动导入 ──
			if (state.step === "import") {
				if (state.candidates === null) {
					children.push(h("p", { className: "xiaoai-muted", key: "loading" }, "正在扫描本机配置…"));
				} else if (state.candidates.length === 0) {
					children.push(
						h(
							"p",
							{ className: "xiaoai-muted", key: "none" },
							"本机没有找到可导入的小米凭据。可以改用「账号登录」，或「手动配置」。"
						)
					);
				} else {
					children.push(
						h(
							"div",
							{ className: "xiaoai-choices", key: "list" },
							state.candidates.map((c) =>
								ChoiceRow({
									key: c.id,
									group: "xiaoai-cred",
									selected: state.candidateId === c.id,
									title: c.source + (c.deviceName ? " · " + c.deviceName : ""),
									desc:
										(c.userId ? "账号 " + c.userId : "账号未知") +
										(c.model ? " · 型号 " + c.model : "") +
										(c.hasToken ? " · 含可用凭据" : " · 需要登录") +
										(c.alsoFoundAt && c.alsoFoundAt.length
											? "（另在 " + c.alsoFoundAt.length + " 处发现）"
											: ""),
									extra: h("span", { className: "xiaoai-choice-path" }, c.detail),
									onSelect: () => state.onSelectCandidate(c.id)
								})
							)
						)
					);
				}
				children.push(
					h(
						"div",
						{ className: "xiaoai-actions", key: "act" },
						Button("上一步", state.onBack),
						Button(state.busy ? "处理中…" : "使用此凭据", state.onUseCandidate, {
							primary: true,
							disabled: state.busy || !state.candidateId
						})
					)
				);
				// ── 附加：从远程 HA 导入 ──
				//
				// 本机扫描（importScan）只能看到**本机**的凭据。若 HA 不在本机
				// （我们的实际部署就是这样：HA 在 192.168.3.3），扫描必然为空，
				// 用户会以为"没得导"。这里提供填地址远程拉取。
				//
				// 为什么值得做：小米云有两个服务要两份凭据（micoapi 拉对话 +
				// xiaomiio 控制音箱），手动凑很麻烦；HA 的 xiaomi_miot 两份都有。
				children.push(
					h("hr", { className: "xiaoai-sep", key: "ha-sep" }),
					h(
						"p",
						{ className: "xiaoai-muted", key: "ha-tip" },
						"HA 装在另一台机器上？填它的地址，我可以远程拉取凭据（同时拿到拉对话与控制音箱两份）。"
					),
					Field(
						"HA 地址",
						TextInput({
							value: state.haHost,
							onChange: state.onHaHostChange,
							placeholder: "192.168.3.3"
						}),
						"Home Assistant 主机的 IP 或域名"
					),
					Field(
						"SSH 用户",
						TextInput({
							value: state.haUser,
							onChange: state.onHaUserChange,
							placeholder: "root"
						})
					),
					Field(
						"SSH 密码",
						TextInput({
							value: state.haPassword,
							onChange: state.onHaPasswordChange,
							type: "password",
							placeholder: "登录 HA 主机的密码"
						}),
						"仅用于本次拉取凭据，不会被保存"
					),
					h(
						"div",
						{ className: "xiaoai-actions", key: "ha-act" },
						Button(state.busy ? "导入中…" : "从 HA 导入", state.onImportFromHa, {
							primary: true,
							disabled: state.busy
						})
					)
				);
			}

			// ── Step 2b：账号登录 ──
			if (state.step === "login") {
				// 风控分支优先展示 —— 这是用户唯一能采取动作的信息
				if (state.authUrl) {
					children.push(
						h(
							"div",
							{ className: "xiaoai-authchallenge", key: "risk" },
							h("p", { className: "xiaoai-warn" }, "⚠️ 小米检测到异地登录，需要你完成安全验证"),
							h(
								"p",
								{ className: "xiaoai-muted" },
								"请在浏览器里打开下面的链接完成授权。授权成功后，小米需要约 1 小时同步账号信息，之后回到这里再点一次「登录」。"
							),
							h(
								"a",
								{
									className: "xiaoai-authlink",
									href: state.authUrl,
									target: "_blank",
									rel: "noreferrer noopener"
								},
								"打开小米安全验证页面 ↗"
							)
						)
					);
				}
				children.push(
					Field(
						"小米账号",
						TextInput({
							value: state.account,
							onChange: state.onAccountChange,
							placeholder: "手机号 / 邮箱 / 小米 ID 都可以"
						}),
						"服务端会自动识别账号类型，不必去查数字 ID"
					)
				);
				children.push(
					Field(
						"密码",
						TextInput({
							value: state.loginPassword,
							onChange: state.onLoginPasswordChange,
							type: "password",
							autoComplete: "new-password",
							placeholder: "小米账号密码"
						})
					)
				);
				// 空表单时把"为什么按钮点不动"直接写出来，
				// 而不是让用户对着灰按钮猜。
				const loginMissing = !state.account || !state.loginPassword;
				if (loginMissing && !state.busy) {
					children.push(
						h(
							"p",
							{ className: "xiaoai-hint-need", key: "need", role: "status" },
							"请先填写账号和密码"
						)
					);
				}
				const loginBusy = state.busy;
				if (loginBusy) {
					children.push(
						h(
							"p",
							{ className: "xiaoai-busy-note", key: "busy", role: "status" },
							h("span", { className: "xiaoai-spinner", "aria-hidden": "true" }),
							"正在登录小米账号，请稍候…"
						)
					);
				}
				children.push(
					h(
						"div",
						{ className: "xiaoai-actions", key: "act" },
						Button("上一步", state.onBack),
						Button(
							loginBusy
								? h(
										"span",
										{ className: "xiaoai-btn-busy" },
										h("span", { className: "xiaoai-spinner", "aria-hidden": "true" }),
										"登录中…"
									)
								: "登录",
							state.onLogin,
							{
								primary: true,
								disabled: loginBusy || loginMissing
							}
						)
					)
				);
			}

			// ── Step 2c：手动配置 ──
			if (state.step === "manual") {
				children.push(
					Field(
						"小米 ID",
						TextInput({
							value: state.manualUserId,
							onChange: state.onManualUserIdChange,
							placeholder: "数字 ID（不是手机号）"
						}),
						"可在 account.xiaomi.com 的个人资料页查到"
					)
				);
				children.push(
					Field(
						"密码",
						TextInput({
							value: state.loginPassword,
							onChange: state.onLoginPasswordChange,
							type: "password",
							autoComplete: "new-password"
						})
					)
				);
				children.push(
					Field(
						"音箱 DID",
						TextInput({
							value: state.manualDid,
							onChange: state.onManualDidChange,
							placeholder: "如 DID_PLACEHOLDER"
						}),
						"不确定就留空 —— 下一步会让你从账号下的设备里选"
					)
				);
				const manualMissing = !state.manualUserId;
				if (manualMissing && !state.busy) {
					children.push(
						h(
							"p",
							{ className: "xiaoai-hint-need", key: "need", role: "status" },
							"请先填写小米 ID 和密码"
						)
					);
				}
				const manualBusy = state.busy;
				if (manualBusy) {
					children.push(
						h(
							"p",
							{ className: "xiaoai-busy-note", key: "busy", role: "status" },
							h("span", { className: "xiaoai-spinner", "aria-hidden": "true" }),
							"正在处理，请稍候…"
						)
					);
				}
				children.push(
					h(
						"div",
						{ className: "xiaoai-actions", key: "act" },
						Button("上一步", state.onBack),
						Button(
							manualBusy
								? h(
										"span",
										{ className: "xiaoai-btn-busy" },
										h("span", { className: "xiaoai-spinner", "aria-hidden": "true" }),
										"处理中…"
									)
								: "继续",
							state.onManualSubmit,
							{
								primary: true,
								disabled: manualBusy || manualMissing
							}
						)
					)
				);
			}

			// ── Step 3：选择音箱 ──
			if (state.step === "speaker") {
				if (state.speakers === null) {
					children.push(h("p", { className: "xiaoai-muted", key: "loading" }, "正在读取账号下的音箱…"));
				} else if (state.speakers.length === 0) {
					children.push(
						h("p", { className: "xiaoai-muted", key: "none" }, "这个账号下没有发现音箱设备。")
					);
				} else {
					children.push(
						h("p", { className: "xiaoai-muted", key: "hint" }, "选中后会自动填好 DID 与型号指令。")
					);
					children.push(
						h(
							"div",
							{ className: "xiaoai-choices", key: "list" },
							state.speakers.map((s) =>
								ChoiceRow({
									key: s.did,
									group: "xiaoai-speaker",
									selected: state.speakerDid === s.did,
									title: s.name + (s.online ? "" : "（离线）"),
									desc:
										"型号 " + (s.model || "未知") +
										(s.modelName ? " · " + s.modelName : "") +
										" · DID " + s.did,
									extra: h(
										"span",
										{
											className: "xiaoai-choice-path",
											style: { color: supportColor(s.support) }
										},
										supportText(s.support)
									),
									onSelect: () => state.onSelectSpeaker(s.did)
								})
							)
						)
					);
				}
				children.push(
					h(
						"div",
						{ className: "xiaoai-actions", key: "act" },
						Button("上一步", state.onBack),
						Button(state.busy ? "正在接通…" : "接通并测试", state.onApplySpeaker, {
							primary: true,
							disabled: state.busy || !state.speakerDid
						})
					)
				);
			}

			// ── Step 4：完成 ──
			if (state.step === "done") {
				children.push(
					h(
						"div",
						{ className: "xiaoai-wizard-done", key: "done" },
						h("p", { className: "xiaoai-ok" }, "✅ 接入完成"),
						state.doneSummary
							? h(
									"div",
									null,
									InfoRow("音箱", state.doneSummary.speakerName || "—"),
									InfoRow("型号", state.doneSummary.model || "—"),
									InfoRow("DID", state.doneSummary.did || "—"),
									InfoRow(
										"TTS 指令",
										state.doneSummary.tts ? "[" + state.doneSummary.tts.join(",") + "]" : "—"
									)
								)
							: null,
						state.doneSummary && !state.doneSummary.modelKnown
							? h(
									"p",
									{ className: "xiaoai-warn" },
									"⚠️ 该型号未收录在兼容表中，已使用默认指令。若音箱不响应，请到「手动配置」里手动填写 TTS 指令。"
								)
							: null,
						state.testResult
							? h(
									"p",
									{
										className: state.testResult.ok ? "xiaoai-ok" : "xiaoai-error"
									},
									state.testResult.ok
										? "音箱已念出测试语句：" + (state.testResult.text || "")
										: "测试失败：" + state.testResult.error
								)
							: null
					)
				);
				children.push(
					h(
						"div",
						{ className: "xiaoai-actions", key: "act" },
						Button(state.busy ? "测试中…" : "测试音箱", state.onTest, { disabled: state.busy }),
						Button("进入设置", state.onFinish, { primary: true })
					)
				);
			}

			return h("div", { className: "xiaoai-wizard" }, children);
		}

		//#endregion

		//#region 面板各区块

		/**
		 * 1. 状态头部：指示灯、音箱信息、DSH 可达性；出错时突出 lastError。
		 * @param status - 契约 §3 的 XIAOAI_STATUS（可为 null，表示尚未取到）。
		 */
		function renderStatusHeader(status) {
			const safe = status && typeof status === "object" ? status : {};
			const speaker = safe.speaker && typeof safe.speaker === "object" ? safe.speaker : {};
			const dsh = safe.dsh && typeof safe.dsh === "object" ? safe.dsh : {};

			const children = [
				h(
					"div",
					{ className: "xiaoai-status-line", key: "line" },
					StatusDot(safe.phase),
					h("span", { className: "xiaoai-status-sep" }, "·"),
					h(
						"span",
						{ className: "xiaoai-speaker" },
						isBlank(speaker.name) ? "未识别音箱" : speaker.name
					),
					h("span", { className: "xiaoai-muted" }, isBlank(speaker.model) ? "型号未知" : speaker.model)
				),
				h(
					"div",
					{ className: "xiaoai-status-line", key: "dsh" },
					h("span", { className: "xiaoai-info-label" }, "DSH 连通："),
					h(
						"span",
						{ className: dsh.reachable ? "xiaoai-ok" : "xiaoai-bad" },
						dsh.reachable ? "可达" : "不可达"
					)
				)
			];

			if (safe.phase === "error" && !isBlank(safe.lastError)) {
				children.push(
					h(
						"p",
						{ className: "xiaoai-error", role: "alert", key: "error" },
						"错误：" + String(safe.lastError)
					)
				);
			}

			if (typeof safe.consecutiveErrors === "number" && safe.consecutiveErrors > 0) {
				children.push(
					h(
						"p",
						{ className: "xiaoai-warn", key: "consecutive" },
						"连续错误次数：" + safe.consecutiveErrors
					)
				);
			}

			return h("div", { className: "xiaoai-header" }, children);
		}

		/** 5. 操作按钮。 */
		function renderActions(state) {
			const busy = state.busy;
			return h(
				"div",
				{ className: "xiaoai-actions" },
				Button("保存", state.onSave, { primary: true, disabled: busy }),
				Button("重启", state.onRestart, { disabled: busy }),
				Button("测试音箱", state.onSpeak, { disabled: busy }),
				Button("自检", state.onSelfTest, { disabled: busy }),
				// 一键填入实践过的推荐配置 —— 用户面对一堆空字段往往不知填什么，
				// 于是留空，然后发现「所有话都被转走了」或「说了没反应」。
				Button("应用推荐配置", state.onApplyRecommended, { disabled: busy })
			);
		}

		/** 6. 最近活动。 */
		function renderRecent(status) {
			const safe = status && typeof status === "object" ? status : {};
			const heard = safe.lastHeard;
			const reply = safe.lastReply;
			// 对话历史（最近若干轮）—— 音箱没有屏幕，用户事后只能靠面板回看。
			const history = Array.isArray(safe.history) ? safe.history.slice(-8).reverse() : [];
			const rows = [];
			for (let i = 0; i < history.length; i += 1) {
				const item = history[i] || {};
				rows.push(
					h(
						"div",
						{ className: "xiaoai-history-item", key: "h" + i },
						h(
							"div",
							{ className: "xiaoai-history-q" },
							h("span", { className: "xiaoai-history-tag" }, "问"),
							h("span", null, String(item.query || "")),
							h("span", { className: "xiaoai-history-time" }, relativeTime(item.at))
						),
						h(
							"div",
							{ className: "xiaoai-history-a" },
							h("span", { className: "xiaoai-history-tag" }, "答"),
							h(
								"span",
								null,
								item.reply === null || item.reply === undefined || item.reply === ""
									? "（未回复）"
									: String(item.reply)
							)
						)
					)
				);
			}
			return h(
				"div",
				{ className: "xiaoai-recent" },
				SectionTitle("最近活动"),
				InfoRow(
					"最近听到",
					heard && !isBlank(heard.text)
						? String(heard.text) + "（" + relativeTime(heard.at) + "）"
						: "暂无"
				),
				InfoRow(
					"最近回复",
					reply && !isBlank(reply.text)
						? String(reply.text) + "（" + relativeTime(reply.at) + "）"
						: "暂无"
				),
				InfoRow("已处理条数", String(typeof safe.handledCount === "number" ? safe.handledCount : 0)),
				history.length > 0
					? h(
							"details",
							{ className: "xiaoai-history", key: "history" },
							h("summary", null, "对话历史（最近 " + history.length + " 轮）"),
							...rows
						)
					: null
			);
		}

		/** 7. 可折叠日志查看器。 */
		function renderLogs(state) {
			const toggle = h(
				"button",
				{
					type: "button",
					className: "xiaoai-button",
					key: "toggle",
					onClick: state.onToggleLogs
				},
				state.logsOpen ? "收起日志" : "查看日志"
			);

			const children = [
				SectionTitle("运行日志"),
				h("div", { className: "xiaoai-logs-bar", key: "bar" }, toggle, state.logsLoading ? h("span", { className: "xiaoai-muted" }, "加载中…") : null)
			];

			if (state.logsError) {
				children.push(
					h("p", { className: "xiaoai-error", role: "alert", key: "logerror" }, "日志读取失败：" + state.logsError)
				);
			}

			if (state.logsOpen) {
				children.push(
					h(
						"pre",
						{ className: "xiaoai-logs", key: "pre" },
						state.logs.length === 0 ? "（暂无日志）" : state.logs.join("\n")
					)
				);
			}

			return h("div", { className: "xiaoai-logs-block" }, children);
		}

		/** 设置表单：总开关 + 凭据 + 行为。 */
		function renderSettingsForm(state) {
			const draft = state.draft;
			if (!draft) return h("p", { className: "xiaoai-muted" }, "设置加载中…");

			const set = (field) => (value) => state.onDraftChange(field, value);

			return h(
				"div",
				{ className: "xiaoai-form" },
				h(
					"label",
					{ className: "xiaoai-switch", key: "enabled" },
					h("input", {
						type: "checkbox",
						checked: Boolean(draft.enabled),
						onChange: (event) => state.onDraftChange("enabled", event.target.checked)
					}),
					h("span", null, "启用")
				),
				SectionTitle("小米账号"),
				Field("小米 ID", TextInput({ value: draft.userId, onChange: set("userId"), placeholder: "小米账号 ID（不是手机号）" })),
				Field(
					"密码",
					TextInput({
						value: draft.password,
						onChange: set("password"),
						type: "password",
						autoComplete: "new-password",
						placeholder: state.passwordRedacted ? "已保存（留空则不修改）" : "小米账号密码"
					})
				),
				Field("音箱 DID", TextInput({ value: draft.did, onChange: set("did"), placeholder: "设备 ID 或米家名称" })),
				SectionTitle("行为"),
				Field(
					"轮询间隔 (ms)",
					TextInput({ value: draft.pollIntervalMs, onChange: set("pollIntervalMs"), type: "number" }),
					"最小 2000"
				),
				Field(
					"回复最大字数",
					TextInput({ value: draft.maxReplyChars, onChange: set("maxReplyChars"), type: "number" })
				),
				Field(
					"触发词",
					TextInput({ value: draft.triggerKeywords, onChange: set("triggerKeywords"), placeholder: "逗号分隔；留空 = 全部转发" })
				),
				Field(
					"忽略规则",
					TextInput({ value: draft.ignorePatterns, onChange: set("ignorePatterns"), placeholder: "逗号分隔的正则" })
				)
			);
		}

		//#endregion

		//#region 组件

		/**
		 * 「小爱语音」设置分区。
		 *
		 * props 由渲染器展开（docs/DSH-PLUGIN-API.md §5）：
		 *   - props.useXiaoai()  ← inject 的 hooks.Xiaoai（契约 §5）
		 *   - props.rpc(method, args)   ← inject 的 rpc（契约 §4）
		 *   - props.t(key)       ← 仅在注册时声明了 locale 才有
		 *   - props.close()      ← 插槽拥有者传入
		 *
		 * 不注册 locale 命名空间，因此不使用 props.t，所有文案直接写中文。
		 */
		function XiaoaiSection(props) {
			const useXiaoai = props.useXiaoai;
			const rpc = props.rpc;

			/**
			 * 订阅运行时状态。契约 §5 说 useXiaoai 是一个 hook，
			 * 我们用与 useSyncExternalStore 相同的调用约定来使用它：
			 * 传一个 getSnapshot 选择器，拿到当前状态值。
			 *
			 * 兜底：若注入缺失或 hook 抛错，退化为本地 state + 轮询（见下方 effect）。
			 */
			const status = useRuntimeStatus(useXiaoai);

			const [draft, setDraft] = React.useState(null);
			const [revision, setRevision] = React.useState(undefined);
			const [passwordRedacted, setPasswordRedacted] = React.useState(false);
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState(null);
			const [logsOpen, setLogsOpen] = React.useState(false);
			const [logs, setLogs] = React.useState([]);
			const [logsLoading, setLogsLoading] = React.useState(false);
			const [logsError, setLogsError] = React.useState(null);
			const [selfTestReply, setSelfTestReply] = React.useState(null);

			// ── 首次接入向导状态 ──
			// showWizard 为 true 时整个分区只渲染向导（不渲染完整设置面板），
			// 避免首次使用的人一上来就看到十几个字段。
			const [showWizard, setShowWizard] = React.useState(false);
			const [step, setStep] = React.useState(WIZARD_STEPS.CHOOSE);
			const [mode, setMode] = React.useState("auto");
			const [wizardBusy, setWizardBusy] = React.useState(false);
			const [wizardError, setWizardError] = React.useState(null);
			const [candidates, setCandidates] = React.useState(null);
			const [candidateId, setCandidateId] = React.useState(null);
			const [account, setAccount] = React.useState("");
			const [loginPassword, setLoginPassword] = React.useState("");
			const [manualUserId, setManualUserId] = React.useState("");
			const [manualDid, setManualDid] = React.useState("");
			const [speakers, setSpeakers] = React.useState(null);
			const [speakerDid, setSpeakerDid] = React.useState(null);
			/** 已选音箱的型号（用于补齐导入凭据的 hardware 字段）。 */
			const [speakerModel, setSpeakerModel] = React.useState(null);
			const [authUrl, setAuthUrl] = React.useState(null);
			// 从远程 HA 导入凭据所需的连接信息
			const [haHost, setHaHost] = React.useState("");
			const [haUser, setHaUser] = React.useState("root");
			const [haPassword, setHaPassword] = React.useState("");
			const [doneSummary, setDoneSummary] = React.useState(null);
			const [testResult, setTestResult] = React.useState(null);

			/**
			 * 统一的 RPC 调用。
			 *
			 * ⚠️ 不要再套 unwrap()！本文件的 rpc() 是 HTTP 直连实现，它
			 * **已经解包过一层**（返回网关响应的 result.value，并在
			 * result.ok === false 时抛错）。早期 rpc() 返回的是网关原始
			 * 信封 {ok,value}，那时才需要 unwrap。
			 *
			 * 两者叠加的后果：服务端业务数据若自身带 ok 字段（例如
			 * onboarding.importFromHa 返回 {ok:true, summary:{…}}），
			 * unwrap 会把它误认成信封、去取 .value —— 取到 undefined，
			 * UI 于是显示「导入失败」，而后端明明返回了成功。
			 * （实测踩过：直接 fetch 该端点返回 ok:true，UI 却报失败。）
			 */
			const call = React.useCallback(
				async (method, args) => {
					if (typeof rpc !== "function") {
						throw new Error("rpc 不可用：inject 未提供 rpc 函数");
					}
					return rpc(method, args || {});
				},
				[rpc]
			);

			/** 拉取设置（契约 §4 xiaoai.settings.get）。 */
			const loadSettings = React.useCallback(async () => {
				try {
					const result = await call("xiaoai.settings.get", {});
					const values = normalizeSettings(result && result.values);
					setPasswordRedacted(isRedacted(values.password));
					setDraft({
						...values,
						password: isRedacted(values.password) ? "" : values.password,
						triggerKeywords: formatList(values.triggerKeywords),
						ignorePatterns: formatList(values.ignorePatterns)
					});
					setRevision(result ? result.revision : undefined);
				} catch (error) {
					setNotice({ kind: "error", text: "设置读取失败：" + describeError(error) });
				}
			}, [call]);

			/** 拉取日志（契约 §4 xiaoai.logs）。 */
			const loadLogs = React.useCallback(async () => {
				setLogsLoading(true);
				setLogsError(null);
				try {
					const result = await call("xiaoai.logs", { limit: LOG_LIMIT });
					setLogs(result && Array.isArray(result.lines) ? result.lines : []);
				} catch (error) {
					setLogsError(describeError(error));
				} finally {
					setLogsLoading(false);
				}
			}, [call]);

			// 挂载时读一次设置。
			React.useEffect(() => {
				loadSettings();
			}, [loadSettings]);

			// 展开日志时按需拉取。
			React.useEffect(() => {
				if (logsOpen) loadLogs();
			}, [logsOpen, loadLogs]);

			/** 保存设置（契约 §4 xiaoai.settings.update，带 revision 乐观锁）。 */
			const onSave = React.useCallback(async () => {
				if (!draft) return;
				setBusy(true);
				setNotice(null);
				try {
					const patch = buildPatch(draft);
					const result = await call("xiaoai.settings.update", { patch, revision });
					setRevision(result ? result.revision : undefined);
					const values = normalizeSettings(result && result.values);
					setPasswordRedacted(isRedacted(values.password));
					setDraft({
						...values,
						password: isRedacted(values.password) ? "" : values.password,
						triggerKeywords: formatList(values.triggerKeywords),
						ignorePatterns: formatList(values.ignorePatterns)
					});
					setNotice({ kind: "ok", text: "设置已保存。" });
				} catch (error) {
					setNotice({ kind: "error", text: "保存失败：" + describeError(error) });
				} finally {
					setBusy(false);
				}
			}, [call, draft, revision]);

			/** 重启轮询循环（契约 §4 xiaoai.restart）。 */
			const onRestart = React.useCallback(async () => {
				setBusy(true);
				setNotice(null);
				try {
					await call("xiaoai.restart", {});
					setNotice({ kind: "ok", text: "已请求重启。" });
				} catch (error) {
					setNotice({ kind: "error", text: "重启失败：" + describeError(error) });
				} finally {
					setBusy(false);
				}
			}, [call]);

			/** 测 TTS（契约 §4 xiaoai.speak）。 */
			const onSpeak = React.useCallback(async () => {
				setBusy(true);
				setNotice(null);
				try {
					await call("xiaoai.speak", { text: SPEAK_TEST_PHRASE });
					setNotice({ kind: "ok", text: "已让音箱念出测试语句。" });
				} catch (error) {
					setNotice({ kind: "error", text: "测试音箱失败：" + describeError(error) });
				} finally {
					setBusy(false);
				}
			}, [call]);

			/** 走完整链路自检（契约 §4 xiaoai.test）。 */
			const onSelfTest = React.useCallback(async () => {
				setBusy(true);
				setNotice(null);
				setSelfTestReply(null);
				try {
					const result = await call("xiaoai.test", { text: SELF_TEST_PROMPT });
					setSelfTestReply(result && result.reply ? String(result.reply) : "（空回复）");
				} catch (error) {
					setNotice({ kind: "error", text: "自检失败：" + describeError(error) });
				} finally {
					setBusy(false);
				}
			}, [call]);

			/**
			 * 一键应用推荐配置。
			 *
			 * 只把建议值合并进 draft（不直接落盘）—— 用户能先看到将要改什么，
			 * 再决定是否「保存」。这比静默改配置安全，也符合面板已有的
			 * 「编辑 draft → 保存」交互习惯。
			 */
			const onApplyRecommended = React.useCallback(async () => {
				setBusy(true);
				setNotice(null);
				try {
					const result = await call("xiaoai.settings.recommended", {});
					const patch = (result && result.patch) || null;
					if (!patch || typeof patch !== "object") {
						setNotice({ kind: "error", text: "未取到推荐配置" });
						return;
					}
					setDraft((previous) => (previous === null ? previous : { ...previous, ...patch }));
					const notes = Array.isArray(result.notes) ? result.notes : [];
					setNotice({
						kind: "ok",
						text:
							"已填入推荐配置（未保存）。点「保存」生效。" +
							(notes.length > 0 ? " " + notes.join(" ") : "")
					});
				} catch (error) {
					setNotice({ kind: "error", text: "取推荐配置失败：" + describeError(error) });
				} finally {
					setBusy(false);
				}
			}, [call]);

			const onDraftChange = React.useCallback((field, value) => {
				setDraft((previous) => (previous === null ? previous : { ...previous, [field]: value }));
			}, []);

			// ── 向导：各步骤处理器 ──

			/** 选接入方式后按"下一步"分流。 */
			const onNextFromChoose = React.useCallback(async () => {
				setWizardError(null);
				if (mode === "manual") {
					setStep(WIZARD_STEPS.MANUAL);
					return;
				}
				if (mode === "account") {
					setStep(WIZARD_STEPS.LOGIN);
					return;
				}
				// auto：扫描本机凭据
				setStep(WIZARD_STEPS.IMPORT);
				setCandidates(null);
				setWizardBusy(true);
				try {
					const result = await call("xiaoai.onboarding.importScan", {});
					const list = (result && result.candidates) || [];
					setCandidates(list);
					// 只有一个候选时直接预选，减少一次点击（零输入的极致）
					if (list.length === 1) setCandidateId(list[0].id);
				} catch (error) {
					setCandidates([]);
					setWizardError("扫描失败：" + describeError(error));
				} finally {
					setWizardBusy(false);
				}
			}, [call, mode]);

			/**
			 * 从【远程 Home Assistant】导入凭据。
			 *
			 * 为什么需要：小米云要两份凭据（micoapi 拉对话 + xiaomiio 控制音箱），
			 * 而 HA 的 xiaomi_miot 集成两份都有。HA 常与本机不在同一台机器，
			 * 本机扫描（importScan）扫不到，所以要支持填地址远程拉取。
			 */
			const onImportFromHa = React.useCallback(async () => {
				setWizardError(null);
				setNotice(null);
				if (!haHost.trim() || !haPassword.trim()) {
					setWizardError("请填写 HA 地址与 SSH 密码");
					return;
				}
				setWizardBusy(true);
				try {
					// did / hardware 必须传 —— 导入的凭据缺这两项会让 vendor 的
					// getConversations 用空 hardware 查询，被小米判 400（每 4 秒空转）。
					// 此时往往尚未选音箱，因此留空并在下一步由「接通并测试」补全；
					// 若用户已选过音箱则直接带上。
					const result = await call("xiaoai.onboarding.importFromHa", {
						host: haHost.trim(),
						user: haUser.trim() || "root",
						password: haPassword,
						did: speakerDid || undefined,
						hardware: speakerModel || undefined,
					});
					if (!result || !result.ok) {
						setWizardError((result && result.error) || "导入失败");
						return;
					}
					const sum = result.summary || {};
					setNotice({
						kind: "ok",
						text:
							`已从 HA 导入账号 ${sum.uid}：` +
							`拉对话凭据 ${sum.mina ? "✅" : "❌"}、` +
							`控制音箱凭据 ${sum.miiot ? "✅" : "❌"}。请继续选择音箱。`,
					});
					// 导入成功后直接进入"选音箱"步骤：列出设备
					setSpeakers(null);
					setStep(WIZARD_STEPS.SPEAKER);
					try {
						const disc = await call("xiaoai.onboarding.discoverSpeakers", {});
						const list = (disc && disc.speakers) || [];
						setSpeakers(list);
						if (list.length === 1) setSpeakerDid(list[0].did);
					} catch {
						setSpeakers([]);
					}
				} catch (error) {
					setWizardError("导入失败：" + describeError(error));
				} finally {
					setWizardBusy(false);
				}
			}, [call, haHost, haUser, haPassword, speakerDid]);

			/** 从导入候选继续 → 列设备。 */
			const onUseCandidate = React.useCallback(async () => {
				setWizardError(null);
				setWizardBusy(true);
				setSpeakers(null);
				setStep(WIZARD_STEPS.SPEAKER);
				try {
					const result = await call("xiaoai.onboarding.discoverSpeakers", {
						candidateId
					});
					if (result && result.needsAuth) {
						// 风控：回到登录步骤展示授权链接
						setAuthUrl(result.authUrl || null);
						setWizardError(result.error || "需要在浏览器完成安全验证");
						setStep(WIZARD_STEPS.LOGIN);
						return;
					}
					if (!result || !result.ok) {
						setSpeakers([]);
						setWizardError((result && result.error) || "读取设备列表失败");
						return;
					}
					const list = result.speakers || [];
					setSpeakers(list);
					if (list.length === 1) setSpeakerDid(list[0].did);
				} catch (error) {
					setSpeakers([]);
					setWizardError("读取设备列表失败：" + describeError(error));
				} finally {
					setWizardBusy(false);
				}
			}, [call, candidateId]);

			/** 账号登录。 */
			const onLogin = React.useCallback(async () => {
				setWizardError(null);
				setAuthUrl(null);
				setWizardBusy(true);
				try {
					const result = await call("xiaoai.onboarding.login", {
						account,
						password: loginPassword
					});
					if (result && result.needsAuth) {
						setAuthUrl(result.authUrl || null);
						setWizardError(
							result.error || "小米检测到异地登录，请先在浏览器完成安全验证"
						);
						return;
					}
					if (!result || !result.ok) {
						setWizardError((result && result.error) || "登录失败");
						return;
					}
					const list = result.speakers || [];
					setSpeakers(list);
					if (list.length === 1) setSpeakerDid(list[0].did);
					setStep(WIZARD_STEPS.SPEAKER);
					if (result.speakersError) setWizardError(result.speakersError);
				} catch (error) {
					setWizardError("登录失败：" + describeError(error));
				} finally {
					setWizardBusy(false);
				}
			}, [account, call, loginPassword]);

			/** 手动配置提交 → 用账密列设备。 */
			const onManualSubmit = React.useCallback(async () => {
				setWizardError(null);
				setWizardBusy(true);
				setSpeakers(null);
				setStep(WIZARD_STEPS.SPEAKER);
				try {
					const result = await call("xiaoai.onboarding.discoverSpeakers", {
						account: manualUserId,
						password: loginPassword
					});
					if (result && result.needsAuth) {
						setAuthUrl(result.authUrl || null);
						setWizardError(result.error || "需要在浏览器完成安全验证");
						setStep(WIZARD_STEPS.LOGIN);
						return;
					}
					if (!result || !result.ok) {
						setSpeakers([]);
						setWizardError((result && result.error) || "读取设备列表失败");
						return;
					}
					const list = result.speakers || [];
					setSpeakers(list);
					if (list.length === 1) setSpeakerDid(list[0].did);
				} catch (error) {
					setSpeakers([]);
					setWizardError("读取设备列表失败：" + describeError(error));
				} finally {
					setWizardBusy(false);
				}
			}, [call, loginPassword, manualUserId]);

			/** 落定配置（凭据 + 设备 + 型号指令）。 */
			const onApplySpeaker = React.useCallback(async () => {
				setWizardError(null);
				setWizardBusy(true);
				try {
					const selected = (speakers || []).find((s) => s.did === speakerDid);
					const args = { did: speakerDid, model: selected ? selected.model : undefined };
					if (candidateId && step !== "login" && step !== "manual") {
						args.candidateId = candidateId;
					} else if (manualUserId || account) {
						args.account = manualUserId || account;
						args.password = loginPassword;
					}
					const result = await call("xiaoai.onboarding.apply", args);
					if (result && result.needsAuth) {
						setAuthUrl(result.authUrl || null);
						setWizardError(result.error || "需要在浏览器完成安全验证");
						return;
					}
					if (!result || !result.ok) {
						setWizardError((result && result.error) || "接通失败");
						return;
					}
					setDoneSummary({
						speakerName: selected ? selected.name : "",
						model: result.modelName ? result.modelName + " (" + result.model + ")" : result.model,
						did: result.did,
						tts: result.commands ? result.commands.tts : null,
						modelKnown: result.modelKnown
					});
					setStep(WIZARD_STEPS.DONE);
					// 落定后刷新设置草稿，让"进入设置"能看到新值
					await loadSettings();
				} catch (error) {
					setWizardError("接通失败：" + describeError(error));
				} finally {
					setWizardBusy(false);
				}
			}, [
				account,
				call,
				candidateId,
				loadSettings,
				loginPassword,
				manualUserId,
				speakerDid,
				speakers,
				step
			]);

			/** 完成后测试音箱。 */
			const onTest = React.useCallback(async () => {
				setWizardBusy(true);
				setTestResult(null);
				try {
					await call("xiaoai.speak", { text: SPEAK_TEST_PHRASE });
					setTestResult({ ok: true, text: SPEAK_TEST_PHRASE });
				} catch (error) {
					setTestResult({ ok: false, error: describeError(error) });
				} finally {
					setWizardBusy(false);
				}
			}, [call]);

			/** 向导"上一步"。 */
			const onBack = React.useCallback(() => {
				setWizardError(null);
				setStep(WIZARD_STEPS.CHOOSE);
			}, []);

			/** 结束向导。 */
			const onFinish = React.useCallback(() => {
				setShowWizard(false);
				setNotice({ kind: "ok", text: "接入完成，可以开始使用了。" });
			}, []);

			// ── 是否需要展示向导 ──
			//
			// 判定依据（"还没配好"）：
			//   · 设置里没有 did（音箱没选定），或
			//   · 运行时没连上音箱（speaker.connected === false）
			// 二者任一成立就说明还没接通，此时【只渲染向导】——
			// 首次使用的人不该一上来面对十几个字段。
			//
			// 手动展开/收起由 showWizard 控制：已配好的用户点「重新接入」
			// 也能进向导（换音箱、换账号的场景）。
			const notConfigured = !draft || isBlank(draft.did) || !(status && status.speaker && status.speaker.connected);
			const wizardActive = showWizard || notConfigured;

			if (wizardActive) {
				return h(
					"section",
					{ className: "xiaoai-section" },
					h("h2", { className: "xiaoai-heading", key: "heading" }, "小爱语音"),
					renderOnboarding({
						step,
						mode,
						busy: wizardBusy,
						scanning: wizardBusy && step === WIZARD_STEPS.CHOOSE,
						error: wizardError,
						candidates,
						candidateId,
						account,
						loginPassword,
						manualUserId,
						manualDid,
						speakers,
						speakerDid,
						authUrl,
						haHost,
						haUser,
						haPassword,
						doneSummary,
						testResult,
						onChooseMode: setMode,
						onNextFromChoose,
						onSelectCandidate: setCandidateId,
						onUseCandidate,
						onAccountChange: setAccount,
						onLoginPasswordChange: setLoginPassword,
						onLogin,
						onImportFromHa,
						onHaHostChange: setHaHost,
						onHaUserChange: setHaUser,
						onHaPasswordChange: setHaPassword,
						onManualUserIdChange: setManualUserId,
						onManualDidChange: setManualDid,
						onManualSubmit,
						onSelectSpeaker: setSpeakerDid,
						onApplySpeaker,
						onTest,
						onBack,
						onFinish
					}),
					// 已配好的用户需要一个"退出向导"的出口，
					// 否则点进来就出不去（notConfigured 为 false 时才显示）
					!notConfigured
						? h(
								"div",
								{ className: "xiaoai-actions", key: "exit" },
								Button("关闭向导", () => setShowWizard(false))
							)
						: null
				);
			}

			const children = [
				h("h2", { className: "xiaoai-heading", key: "heading" }, "小爱语音"),
				renderStatusHeader(status),
				notice
					? h(
							"p",
							{
								className: notice.kind === "ok" ? "xiaoai-ok" : "xiaoai-error",
								role: notice.kind === "ok" ? undefined : "alert",
								key: "notice"
							},
							notice.text
						)
					: null,
				// 重新接入入口（换音箱/换账号）
				h(
					"div",
					{ className: "xiaoai-actions", key: "reonboard" },
					Button("重新接入 / 更换音箱", () => setShowWizard(true))
				),
				renderSettingsForm({ draft, passwordRedacted, onDraftChange }),
				renderActions({ busy, onSave, onRestart, onSpeak, onSelfTest, onApplyRecommended }),
				selfTestReply !== null
					? h(
							"p",
							{ className: "xiaoai-selftest", key: "selftest" },
							"自检回复：" + selfTestReply
						)
					: null,
				renderRecent(status),
				renderLogs({
					logsOpen,
					logs,
					logsLoading,
					logsError,
					onToggleLogs: () => setLogsOpen((open) => !open)
				})
			];

			return h("section", { className: "xiaoai-section" }, children);
		}

		/**
		 * 状态订阅。
		 *
		 * 契约 §5 规定 `props.useXiaoai()` 返回 XIAOAI_STATUS。第一方插件的用法是
		 * 传入选择器，例如 `useAgentPresetSection((snapshot) => snapshot)`，
		 * 因此这里也按「传选择器」的约定调用。
		 *
		 * 注入缺失时（旧宿主 / 单测）退化为「本地 state + 每 2s 调 xiaoai.status」，
		 * 并在卸载时清掉定时器。两条路径下 useState/useEffect 的调用顺序保持一致。
		 */
		function useRuntimeStatus(useXiaoai) {
			const injected = typeof useXiaoai === "function";
			const [localStatus, setLocalStatus] = React.useState(null);

			// ⚠️ 绝不能写成 `injected ? useXiaoai(...) : null` —— 那是**条件调用
			// hook**，会违反 React 的 Hooks 规则：injected 翻转时同一 fiber 的
			// hook 槽位号会变（实测 2 → 1），轻则 state 串位，重则抛
			// "Rendered fewer hooks than expected" 直接崩掉设置面板。
			// 正确做法：无条件调用，用一个语义等价的空实现兜底。
			const nullHook = React.useCallback(() => null, []);
			const injectedStatus = (injected ? useXiaoai : nullHook)((value) => value);
			if (injectedStatus !== null && injectedStatus !== undefined) hasPushedStatus = true;

			// 只有在「还没有任何推送状态」时才需要本地轮询兜底。
			const needsFallback = !injected || !hasPushedStatus;

			React.useEffect(() => {
				if (!needsFallback) return undefined;
				let cancelled = false;
				const tick = () => {
					const rpc = currentRpc;
					if (typeof rpc !== "function") return;
					Promise.resolve(rpc("xiaoai.status", {}))
						.then((result) => {
							if (cancelled) return;
							try {
								setLocalStatus(result)  // rpc() 已解包，勿再 unwrap;
							} catch (error) {
								/* 轮询失败静默：下一 tick 会重试。 */
							}
						})
						.catch(() => {
							/* 同上。 */
						});
				};
				tick();
				const timer = setInterval(tick, POLL_INTERVAL_MS);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, [needsFallback]);

			return injectedStatus !== null && injectedStatus !== undefined ? injectedStatus : localStatus;
		}

		/**
		 * 注册用的状态源。
		 *
		 * 第一方插件的写法是 `hooks: { agentPresetSection: section.store }`
		 * —— 直接给一个「可被订阅的对象」。渲染器会用 observableHook 包它，
		 * 最终以 `props.useXiaoai(selector?)` 的形式交给组件。
		 *
		 * 我们这里给出一个最小的可订阅对象（getSnapshot/subscribe），
		 * 它在第一次读快照时惰性拉一次 xiaoai.status，之后每 2s 轮询刷新。
		 * 所有订阅者共享同一份状态与同一个定时器（最后一个退订时清理）。
		 */
		function createStatusSource(rpc) {
			let snapshot = null;
			let started = false;
			let timer = null;
			const listeners = new Set();

			const emit = () => {
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch (error) {
						console.error("xiaoai: status listener failed:", error);
					}
				}
			};

			const refresh = () => {
				Promise.resolve(rpc("xiaoai.status", {}))
					.then((result) => {
						snapshot = result;  // rpc() 已解包，勿再 unwrap
						emit();
					})
					.catch((error) => {
						// 轮询失败不抛出，避免打断 UI；保留上一份快照。
						console.error("xiaoai: status poll failed:", describeError(error));
					});
			};

			const start = () => {
				if (started) return;
				started = true;
				refresh();
				timer = setInterval(refresh, POLL_INTERVAL_MS);
			};

			const stop = () => {
				if (!started) return;
				started = false;
				if (timer !== null) clearInterval(timer);
				timer = null;
			};

			return {
				getSnapshot() {
					// 首次读取时启动轮询，保证挂载即开始拉状态。
					start();
					return snapshot;
				},
				subscribe(listener) {
					listeners.add(listener);
					start();
					return () => {
						listeners.delete(listener);
						if (listeners.size === 0) stop();
					};
				}
			};
		}

		/** 包装组件：把 rpc 暴露给 useRuntimeStatus 的轮询兜底。 */
		function XiaoaiSectionBound(props) {
			currentRpc = props.rpc;
			return XiaoaiSection(props);
		}

		//#endregion

		//#region 注册

		/**
		 * 客户端插件入口。
		 *
		 * 注册一个 settings.section（list 插槽 → id 必填），
		 * order 30 排在 general(0) / agent-presets(20) / dsh-im(21) 之后。
		 *
		 * 不设 locale：省去注册字典，组件也就不会收到 t prop。
		 */
		function apply(ctx) {
			// 幂等补注入：热重载后模块重新求值、<head> 被换掉等情况下，
			// 模块级那次注入可能已经失效，这里兜一次。
			injectStyles();

			/**
			 * 调用 xiaoai.* RPC。
			 *
			 * ctx.remote 是按命名空间分层的 Proxy（第一方用法为
			 * `ctx.remote.credentials.describe(...)`），因此方法名必须
			 * 「去前缀后逐层取」：xiaoai.settings.update → remote.xiaoai["settings.update"]。
			 * 契约 §4 的方法名里带点，所以这里保留 settings.get / settings.update 的字面量。
			 */
			/**
			 * 等待 Typert 命名空间被挂载。
			 *
			 * ⚠️ 为什么不在 inject 里声明 `remote.xiaoai`（踩过两次的坑）：
			 *   cordis 的 inject 是【硬依赖】—— 声明了就必须等到服务出现，否则
			 *   插件进入 pending：表现为
			 *     "web boot: 1 entry did not activate"
			 *     "dsh-xiaoai: pending (waiting for service: remote.xiaoai)"
			 *   而 remote.xiaoai 是【服务端控制器注册后】才由网关挂载的动态服务。
			 *   客户端与服务端的加载顺序无法保证，声明它就有概率永久 pending
			 *   （台式DSH 的 issue #3 记录过这种现象）。
			 *
			 *   官方插件（dsh-client-ui-agent-preset）确实把它写进了 inject，
			 *   但那是因为它的服务端在同一 bundle 内且先挂载 —— 我们不能依赖这点。
			 *
			 * 这里改为【运行时轮询等待】：挂载了就用，一直没出现就给出明确错误。
			 * 这样两种加载顺序都能正常工作。
			 */
			const NAMESPACE_WAIT_MS = 10000;
			const NAMESPACE_POLL_MS = 100;

			function waitForNamespace(timeoutMs = NAMESPACE_WAIT_MS) {
				const deadline = Date.now() + timeoutMs;
				return new Promise((resolve) => {
					const attempt = () => {
						const remote = (ctx.remote || {})[RPC_NS];
						if (remote !== undefined && remote !== null) return resolve(remote);
						if (Date.now() >= deadline) return resolve(undefined);
						setTimeout(attempt, NAMESPACE_POLL_MS);
					};
					attempt();
				});
			}

			/**
			 * 调用 xiaoai.* RPC —— 走【HTTP 直连】，不走 ctx.remote。
			 *
			 * 【为什么不用 ctx.remote.xiaoai】
			 * 客户端的 remote 命名空间由 dsh-api-gateway 用 $mount() fork
			 * （client.js:1564/1794），而 contribution 清单是硬编码的 19 个官方包，
			 * 第三方没有扩展点（dsh-api-remotes/lib/types/client/index.js:1-46；
			 * 官方 dsh-typert-loader/README.md:114 亦承认客户端发现机制未实现）。
			 * 因此 `ctx.remote.xiaoai` 永远 undefined，老老实实等待只会白等 10 秒
			 * 然后报「未挂载」——用户看到的就是登录失败。
			 *
			 * 而 Gateway 对未注册 manifest 的服务有 SRC 回退
			 * （resolveSrcDescriptor, dsh-api-gateway/lib/index.js:758-782），
			 * 所以 POST /api/xiaoai/<method> 可以直接工作（已实测）。
			 *
			 * 请求体形状（实测得出，少一个字段都会被判 bad-request）：
			 *   { type:"client-request", rpcId, method:"xiaoai/<m>", payload:{args} }
			 * 无参方法 payload.args 必须是 {}；有参方法用 {args:{...}}（形参名即 args）。
			 */
			const rpc = async (method, args) => {
				// 兼容两种调用形式：'xiaoai.status' / 'xiaoai.settings.get'
				const bare = method.startsWith(RPC_PREFIX) ? method.slice(RPC_PREFIX.length) : method;
				const endpoint = RPC_NS + "/" + bare;

				// 哪些方法没有形参 —— 它们的 payload.args 必须是空对象，
				// 传 {args:{...}} 会被网关拒绝（unexpected "args"）。
				const NO_ARG_METHODS = new Set([
					"status", "settings.get", "restart",
					"onboarding.importScan", "onboarding.models", "settings.recommended",
				]);
				const wantsArgs = !NO_ARG_METHODS.has(bare);

				const rpcId = "xiaoai-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
				const res = await fetch("/api/" + endpoint, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					credentials: "same-origin",
					body: JSON.stringify({
						type: "client-request",
						rpcId,
						method: endpoint,
						// ⚠️ 参数形状按服务端签名分两类
						// （Gateway 的 SRC 回退把【形参名】当线字段，
						//   而本插件所有有参方法的形参都叫 args）：
						//   · 无参方法 status()/settingsGet()/restart() 等
						//     → payload.args 必须是 {}，多一个字段就报
						//       `args fields do not match the descriptor: unexpected "args"`
						//   · 有参方法 login(args)/importFromHa(args) 等
						//     → payload.args 形如 { args: <真正参数> }
						// 实测对照（都踩过）：
						//   无参 {args:{args:{}}}    → unexpected "args"
						//   有参 {args:{host:…}}     → unexpected "host"
						//   有参 {args:{args:{…}}}   → ok
						payload: { args: wantsArgs ? { args: args || {} } : {} }
					})
				});
				let body;
				try {
					body = await res.json();
				} catch {
					throw new Error("网关返回了非 JSON 响应（HTTP " + res.status + "）");
				}
				const result = body && body.result;
				if (!result) throw new Error("网关响应缺少 result 字段");
				if (result.ok === false) {
					const err = result.error || {};
					throw new Error(err.message || err.code || "RPC 调用失败");
				}
				return result.value;
			};

			const statusSource = createStatusSource(rpc);

			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "dsh-xiaoai",
						order: 30,
						label: () => "小爱语音",
						inject: () => ({
							hooks: {
								Xiaoai: statusSource
							},
							rpc
						})
					},
					XiaoaiSectionBound
				)
			);
		}

		//#endregion

		/**
		 * 客户端插件依赖声明（cordis fiber inject）。
		 *
		 * 【2026-09-20 修复】原实现只导出了 apply，却在其中访问 ctx.slots
		 * 与 ctx.remote，触发：cannot get property "slots" without inject。
		 * cordis 要求先声明后访问。
		 * - slots: ctx.slots.inject/register（设置页区块挂载）
		 * - remote: ctx.remote 命名空间根
		 * - remote.xiaoai: 本插件自己的 Typert 命名空间
		 *
		 * ⚠️ 不要把 `remote.<自己的命名空间>` 写进 inject（踩过两次）：
		 *   它是服务端控制器注册后由网关【动态挂载】的服务，客户端与服务端
		 *   加载顺序无法保证；写进静态 inject 一旦服务晚到，插件就永久 pending
		 *   （"pending (waiting for service: remote.xiaoai)"）。
		 *   改为运行时轮询等待（见上面的 waitForNamespace）。
		 *
		 * 注：官方 dsh-client-ui-agent-preset 确实写了 remote.agentPresets /
		 * remote.settings，但那是框架预置命名空间（始终存在），与本插件
		 * 自注册的 xiaoai 不同。
		 */
		const inject = ["slots", "remote"];

		exports.apply = apply;
		exports.inject = inject;
		exports.XiaoaiSection = XiaoaiSection;
		exports.buildPatch = buildPatch;
		exports.parseList = parseList;
		exports.relativeTime = relativeTime;
		exports.phaseMeta = phaseMeta;

		return module.exports;
	}
});
