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

/* ══════════════════════════════════════════════════════════════
   分组折叠（§2.1 / §3）
   ══════════════════════════════════════════════════════════════ */
.xiaoai-form {
	display: flex;
	flex-direction: column;
	gap: 12px;
}
.xiaoai-group {
	background: var(--dsw-alias-bg-layer-1, transparent);
	border: 1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, currentColor));
	border-radius: 12px;
	overflow: hidden;
	transition: border-color .15s var(--ds-ease-in-out, ease);
}
.xiaoai-group[open] {
	border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2, currentColor));
}
/* 有未保存修改的组：左边一条品牌色，收起时也看得见 */
.xiaoai-group-dirty {
	border-left: 3px solid var(--dsw-alias-brand-primary);
}
.xiaoai-group-summary {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 12px 14px;
	cursor: pointer;
	list-style: none;
	user-select: none;
	transition: background .15s var(--ds-ease-in-out, ease);
}
.xiaoai-group-summary::-webkit-details-marker { display: none; }
.xiaoai-group-summary:hover {
	background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2, transparent));
}
.xiaoai-group-summary:focus-visible {
	outline: 2px solid var(--dsw-alias-brand-primary);
	outline-offset: -2px;
}
/* 三角指示：收起 ▶ / 展开 ▼ —— 纯 CSS，跟着 [open] 自动翻转 */
.xiaoai-group-caret {
	flex: none;
	width: 0;
	height: 0;
	border-style: solid;
	border-width: 5px 0 5px 7px;
	border-color: transparent transparent transparent var(--dsw-alias-label-tertiary);
	transition: transform .15s var(--ds-ease-in-out, ease);
}
.xiaoai-group[open] .xiaoai-group-caret {
	transform: rotate(90deg);
}
.xiaoai-group-headtext {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}
.xiaoai-group-title {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-size: 14px;
	font-weight: 600;
	line-height: 20px;
	color: var(--dsw-alias-label-primary);
}
/* ⚠️ 脏点：折叠分组的标题上必须能看见 —— 否则折叠会隐藏脏状态（§6.4） */
.xiaoai-group-dot {
	width: 7px;
	height: 7px;
	flex: none;
	border-radius: 50%;
	background: var(--dsw-alias-brand-primary);
}
.xiaoai-group-desc {
	font-size: 12px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary);
}
.xiaoai-group-note {
	margin: 0;
	padding: 0 14px 8px 32px;
	font-size: 12px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary);
}
.xiaoai-group-body {
	display: flex;
	flex-direction: column;
	gap: 2px;
	padding: 4px 14px 14px;
	border-top: 1px solid var(--dsw-alias-border-l1, transparent);
}

/* ── 三列字段行（§3）─────────────────────────────────────── */
.xiaoai-row {
	display: grid;
	grid-template-columns: 14em minmax(0, 1fr);
	column-gap: 14px;
	row-gap: 4px;
	align-items: start;
	padding: 8px 0;
}
.xiaoai-row-label {
	padding-top: 6px;
	font-size: 13px;
	line-height: 18px;
	color: var(--dsw-alias-label-secondary, inherit);
	overflow-wrap: anywhere;
}
.xiaoai-row-req { color: var(--dsw-alias-state-error-primary, #f85149); margin-left: 3px; }
.xiaoai-row-control {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
	min-width: 0;
}
.xiaoai-row-hint {
	grid-column: 2;
	margin: 0;
	font-size: 12px;
	line-height: 17px;
	color: var(--dsw-alias-label-tertiary);
}
.xiaoai-row-error {
	grid-column: 2;
	margin: 0;
	font-size: 12px;
	line-height: 17px;
	color: #d29922;
}
.xiaoai-warn-inline { grid-column: 1 / -1; color: #d29922; }
.xiaoai-control-pair {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	width: 100%;
	min-width: 0;
}

/* ── 小节标题（提示语组内分两段）───────────────────────── */
.xiaoai-subheading {
	display: flex;
	align-items: baseline;
	gap: 8px;
	margin: 10px 0 0;
	padding-bottom: 4px;
	border-bottom: 1px dashed var(--dsw-alias-border-l1, transparent);
}
.xiaoai-subheading h4 {
	margin: 0;
	font-size: 13px;
	font-weight: 600;
	color: var(--dsw-alias-label-primary);
}

/* ── 下拉 / 开关 ─────────────────────────────────────────── */
.xiaoai-select {
	flex: 1 1 12em;
	min-width: 0;
	padding: 6px 10px;
	font-size: 13px;
	line-height: 18px;
	color: var(--dsw-alias-label-primary);
	background: var(--dsw-alias-bg-layer-2, transparent);
	border: 1px solid var(--dsw-alias-border-l2, currentColor);
	border-radius: 8px;
	cursor: pointer;
}
.xiaoai-select:focus-visible {
	border-color: var(--dsw-alias-brand-primary);
	outline: none;
	box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);
}
.xiaoai-switch {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	cursor: pointer;
	user-select: none;
}
.xiaoai-switch input[type="checkbox"] {
	position: absolute;
	opacity: 0;
	width: 0;
	height: 0;
}
.xiaoai-switch-track {
	position: relative;
	flex: none;
	width: 34px;
	height: 20px;
	border-radius: 999px;
	background: var(--dsw-alias-border-l2, #6b7280);
	transition: background .15s var(--ds-ease-in-out, ease);
}
.xiaoai-switch-thumb {
	position: absolute;
	top: 2px;
	left: 2px;
	width: 16px;
	height: 16px;
	border-radius: 50%;
	background: #fff;
	transition: transform .15s var(--ds-ease-in-out, ease);
}
.xiaoai-switch input:checked + .xiaoai-switch-track {
	background: var(--dsw-alias-brand-primary);
}
.xiaoai-switch input:checked + .xiaoai-switch-track .xiaoai-switch-thumb {
	transform: translateX(14px);
}
.xiaoai-switch input:focus-visible + .xiaoai-switch-track {
	box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent);
}
.xiaoai-switch input:disabled + .xiaoai-switch-track {
	opacity: .5;
	cursor: not-allowed;
}
.xiaoai-switch-text {
	font-size: 12px;
	color: var(--dsw-alias-label-tertiary);
}

/* ── 标签式数组输入（chip）───────────────────────────────── */
.xiaoai-tags {
	display: flex;
	flex-direction: column;
	gap: 6px;
	width: 100%;
	min-width: 0;
}
.xiaoai-tags-list {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}
.xiaoai-chip {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 3px 4px 3px 9px;
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-primary);
	background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2, transparent));
	border: 1px solid var(--dsw-alias-border-l2, transparent);
	border-radius: 999px;
	max-width: 100%;
}
.xiaoai-chip-text {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.xiaoai-chip-del {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 16px;
	height: 16px;
	padding: 0;
	font-size: 13px;
	line-height: 1;
	color: var(--dsw-alias-label-tertiary);
	background: transparent;
	border: none;
	border-radius: 50%;
	cursor: pointer;
}
.xiaoai-chip-del:hover {
	color: var(--dsw-alias-label-primary-inverted, #fff);
	background: var(--dsw-alias-state-error-primary, #f85149);
}
.xiaoai-chip-del:focus-visible {
	outline: 2px solid var(--dsw-alias-brand-primary);
	outline-offset: 1px;
}
/* 空数组的占位提示 —— 必须是文案而不是空白（§3） */
.xiaoai-chip-empty {
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-tertiary);
	font-style: italic;
}
.xiaoai-tags-input-row {
	display: flex;
	align-items: center;
	gap: 8px;
}
.xiaoai-tags-input { flex: 1 1 auto; min-width: 0; }
.xiaoai-tags-tip {
	flex: none;
	font-size: 11px;
	color: var(--dsw-alias-label-tertiary);
}

/* ── 问号帮助 tooltip（§6.6）────────────────────────────── */
.xiaoai-help { position: relative; display: inline-flex; }
.xiaoai-help-button {
	width: 16px;
	height: 16px;
	padding: 0;
	font-size: 11px;
	line-height: 1;
	color: var(--dsw-alias-label-tertiary);
	background: transparent;
	border: 1px solid var(--dsw-alias-border-l2, currentColor);
	border-radius: 50%;
	cursor: help;
}
.xiaoai-help-tip {
	position: absolute;
	bottom: calc(100% + 6px);
	left: 0;
	z-index: 30;
	width: max-content;
	max-width: 300px;
	padding: 8px 10px;
	font-size: 12px;
	line-height: 17px;
	color: var(--dsw-alias-label-primary);
	background: var(--dsw-alias-bg-layer-4, var(--dsw-alias-bg-layer-2, #222));
	border: 1px solid var(--dsw-alias-border-l3, currentColor);
	border-radius: 8px;
	box-shadow: 0 6px 20px rgba(0, 0, 0, .25);
	opacity: 0;
	visibility: hidden;
	transition: opacity .12s var(--ds-ease-in-out, ease);
}
.xiaoai-help-button:hover + .xiaoai-help-tip,
.xiaoai-help-button:focus-visible + .xiaoai-help-tip,
.xiaoai-help-tip:hover {
	opacity: 1;
	visibility: visible;
}

/* ── 操作栏（§6.1）─────────────────────────────────────── */
.xiaoai-actionbar {
	position: sticky;
	bottom: 0;
	z-index: 10;
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 12px 14px;
	background: var(--dsw-alias-bg-layer-1, transparent);
	border: 1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, currentColor));
	border-radius: 12px;
	backdrop-filter: blur(6px);
}
.xiaoai-dirty-note {
	margin: 0;
	font-size: 12px;
	line-height: 18px;
	color: #d29922;
}
.xiaoai-actions-gap { flex: 1 1 auto; }
.xiaoai-actions-tools {
	padding-top: 10px;
	border-top: 1px solid var(--dsw-alias-border-l1, transparent);
	align-items: center;
}
.xiaoai-actions-lead {
	font-size: 12px;
	color: var(--dsw-alias-label-tertiary);
}

@media (max-width: 640px) {
	.xiaoai-row { grid-template-columns: minmax(0, 1fr); }
	.xiaoai-row-hint, .xiaoai-row-error { grid-column: 1; }
	.xiaoai-row-label { padding-top: 0; }
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

		/**
		 * 把「逗号分隔文本」或「数组」统一解析成去空白的字符串数组。
		 *
		 * ⚠️ **必须与 formatList 同步修改**（设计师标注的坑）：
		 * draft 侧的数组字段现在是**真数组**（TagInput 直接读写），
		 * buildPatch 仍要过一遍这里做最终清洗。若这里只认字符串，
		 * `String(["a","b"])` → `"a,b"` → 切回 `["a","b"]` 看似正常，
		 * 但元素里**本身含逗号**的值（提示语里很常见）会被切碎。
		 * 因此数组一律原样返回，不经过字符串往返。
		 */
		function parseList(text) {
			if (Array.isArray(text)) return text.map((item) => String(item).trim()).filter((item) => item !== "");
			if (isBlank(text)) return [];
			return String(text)
				.split(/[,，]/)
				.map((part) => part.trim())
				.filter((part) => part !== "");
		}

		/**
		 * 数组渲染回逗号分隔文本。
		 *
		 * ⚠️ 现在只用于**只读展示**（如摘要行）。draft 里**不要**再调它 ——
		 * 数组字段在 draft 中保持真数组，一旦写成字符串，
		 * TagInput 的「回车加一项」就会往字符串上追加，保存即丢数据。
		 * （这条就是设计师在 §8.3-2 标注的「双重格式陷阱」。）
		 */
		function formatList(value) {
			return Array.isArray(value) ? value.join(", ") : "";
		}

		/**
		 * 把用户粘贴/输入的文本拆成待添加的多个条目。
		 *
		 * 支持半角逗号、全角逗号、顿号与换行 —— 用户从文档里复制关键词时
		 * 这几种分隔符混用是常态，只认半角会让整串变成一个巨大的条目。
		 */
		function splitEntryText(text) {
			return String(text === undefined || text === null ? "" : text)
				.split(/[,，、\n\r\t]/)
				.map((part) => part.trim())
				.filter((part) => part !== "");
		}

		/** 追加条目（去重，保持原有顺序）。 */
		function appendEntries(list, additions) {
			const out = Array.isArray(list) ? list.slice() : [];
			for (const item of additions) {
				const text = String(item).trim();
				if (text === "") continue;
				if (out.indexOf(text) === -1) out.push(text);
			}
			return out;
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

		/**
		 * 契约 §2 的默认值 —— 与 `src/runtime.js:21-70` 的 DEFAULTS 逐项对齐。
		 *
		 * ⚠️ 这里必须覆盖 `buildSettingsSchema`（src/index.js:251-340）的**全部 38 个字段**。
		 * 少一项的后果不是报错，而是：服务端某次没返回该字段 → UI 显示空 →
		 * 用户一保存就把空值写回去（数组字段尤其致命：整个列表被清空）。
		 */
		const SETTING_DEFAULTS = {
			// ── 接入 ──
			enabled: true,
			userId: "",
			password: "",
			did: "",
			deviceModel: "",
			ttsCommand: "",
			wakeUpCommand: "",
			// ── 行为 ──
			pollIntervalMs: 4000,
			replyTimeoutMs: 240000,
			maxReplyChars: 400,
			triggerKeywords: [],
			ignorePatterns: ["^小爱同学$"],
			// ── 音箱侧：AI 模式 ──
			aiModeEnabled: true,
			callAIKeywords: [],
			wakeUpKeywords: [],
			exitKeywords: [],
			exitKeepAliveAfter: 30,
			localCommandsEnabled: true,
			// ── 提示语（空数组 = 不播报）──
			onEnterAI: ["AI模式已开启"],
			onExitAI: ["已退出AI模式"],
			onAIAsking: ["让我想想"],
			onAIReplied: [],
			onAIProgress: ["还在处理，请稍等一下"],
			progressAfterSeconds: 35,
			historyLimit: 20,
			onAIError: ["抱歉，出错了"],
			onAIErrorNetwork: ["网络好像不太好，等一下再试试"],
			onAIErrorAuth: ["小米账号可能需要重新登录，请在设置面板检查"],
			onAIErrorTimeout: ["这个问题有点复杂，我还没想完，请再问一次"],
			// ── 桥接 / 日志 ──
			dshApiUrl: "http://127.0.0.1:3082/api/session",
			dshApiToken: "",
			verboseLog: false,
			// ── 会话绑定 ──
			workspace: "",
			agentPreset: "",
			provider: "",
			model: "",
			sessionReuse: true
		};

		/**
		 * 数值字段的钳制规则 —— 单点定义，UI 提示与 buildPatch 共用同一份，
		 * 避免「UI 说最小 2000、实际按 3000 钳」这种前后不一致。
		 */
		const NUMBER_RULES = {
			pollIntervalMs: { min: 2000, def: 4000, unit: "毫秒", label: "轮询间隔" },
			replyTimeoutMs: { min: 1000, def: 240000, unit: "毫秒", label: "回复等待上限" },
			maxReplyChars: { min: 1, def: 400, unit: "字", label: "回复字数上限" },
			exitKeepAliveAfter: { min: 5, def: 30, unit: "秒", label: "静默退出时长" },
			progressAfterSeconds: { min: 10, def: 35, unit: "秒", label: "进度播报阈值" },
			historyLimit: { min: 1, def: 20, unit: "轮", label: "历史保留条数" }
		};

		/**
		 * 数组字段清单（9 个 + 触发词/忽略规则 = 11 个）。
		 * 这些字段的 draft 表示**必须是真数组** —— TagInput 直接读写数组。
		 *
		 * ⚠️ 历史坑：早期实现把 draft 里的数组存成逗号分隔字符串
		 * （`formatList`），`buildPatch` 再 `parseList` 回来。改成 TagInput 后
		 * 若只改一处，`parseList(数组)` 会走 `String(数组)` 分支，
		 * 把 `["a","b"]` 变成 `["a,b"]` —— **保存即丢数据**。
		 * 现在只在 `parseList` 里做了「已是数组就原样返回」的兼容，
		 * 但 draft 侧仍必须是数组，两处已同步。
		 */
		const LIST_FIELDS = [
			"triggerKeywords",
			"ignorePatterns",
			"callAIKeywords",
			"wakeUpKeywords",
			"exitKeywords",
			"onEnterAI",
			"onExitAI",
			"onAIAsking",
			"onAIReplied",
			"onAIProgress",
			"onAIError",
			"onAIErrorNetwork",
			"onAIErrorAuth",
			"onAIErrorTimeout"
		];

		/** 布尔字段清单（draft 里保持真布尔）。 */
		const BOOL_FIELDS = [
			"enabled",
			"aiModeEnabled",
			"localCommandsEnabled",
			"verboseLog",
			"sessionReuse"
		];

		/** 字符串字段清单。 */
		const STRING_FIELDS = [
			"userId",
			"password",
			"did",
			"deviceModel",
			"ttsCommand",
			"wakeUpCommand",
			"dshApiUrl",
			"dshApiToken",
			"workspace",
			"agentPreset",
			"provider",
			"model"
		];

		/**
		 * 把 settings.get 的值对象补全成 UI 需要的完整形状。
		 *
		 * 三处调用点（初次加载 / 保存后回填 / 推荐配置）**必须**共用这一个函数 ——
		 * 早期实现里保存后回填是就地拼装的（`{...values, password: …, triggerKeywords: formatList(…)}`），
		 * 扩字段时三处行为会漂移，是已知的重复。
		 */
		function normalizeSettings(values) {
			const source = values && typeof values === "object" ? values : {};
			const out = {};

			for (const key of STRING_FIELDS) {
				const raw = source[key];
				out[key] = raw === undefined || raw === null ? SETTING_DEFAULTS[key] : String(raw);
			}

			for (const key of BOOL_FIELDS) {
				out[key] =
					source[key] === undefined || source[key] === null
						? SETTING_DEFAULTS[key]
						: Boolean(source[key]);
			}

			for (const key of Object.keys(NUMBER_RULES)) {
				const raw = source[key];
				out[key] = typeof raw === "number" && Number.isFinite(raw) ? raw : SETTING_DEFAULTS[key];
			}

			for (const key of LIST_FIELDS) {
				const raw = source[key];
				if (Array.isArray(raw)) {
					out[key] = raw.map((item) => String(item));
				} else if (typeof raw === "string" && raw.trim() !== "") {
					// 服务端理论上只会返回数组；这里兼容手工写入的字符串，
					// 否则一个「a, b」会被当成单元素数组。
					out[key] = parseList(raw);
				} else {
					out[key] = SETTING_DEFAULTS[key].slice();
				}
			}

			return out;
		}

		/**
		 * 由「草稿」构造 settings.update 的 patch（契约 §4）。
		 *
		 * ⚠️ 发**全量** patch，不是只发改动字段 —— `settings.update` 走的是
		 * merge 语义（src/rpc.js:401-405），发全量是安全的；只发脏字段会把
		 * 「字段缺失 = 用默认值」和「字段缺失 = 不修改」两种语义搅在一起。
		 *
		 * 数字字段做钳制；钳制的具体结果同时会由 `clampNumberField` 在**行内**
		 * 提前告诉用户，不再静默改数（见 §6.3）。
		 */
		function buildPatch(draft) {
			const patch = {};
			for (const key of STRING_FIELDS) {
				patch[key] = String(draft[key] === undefined || draft[key] === null ? "" : draft[key]);
			}
			for (const key of BOOL_FIELDS) {
				patch[key] = Boolean(draft[key]);
			}
			for (const key of Object.keys(NUMBER_RULES)) {
				const rule = NUMBER_RULES[key];
				const value = Number(draft[key]);
				// 非数字 → 默认值；低于下限 → **钳到下限**（不是默认值）。
				// 保留原实现的钳制语义：用户填 500 保存后回读是 2000，
				// 而不是被悄悄改成 4000 —— 行内提示说的也是「已按 2000 处理」，
				// 两处必须一致，否则提示与落盘值对不上。
				if (!Number.isFinite(value)) patch[key] = rule.def;
				else if (value < rule.min) patch[key] = rule.min;
				else patch[key] = Math.floor(value);
			}
			for (const key of LIST_FIELDS) {
				patch[key] = parseList(draft[key]);
			}
			return patch;
		}

		/**
		 * 单个数值字段是否会被钳制；返回 null 表示无需提示。
		 * UI 用它渲染行内黄字（「最小 2000 毫秒，已按 2000 处理」）。
		 */
		function clampNumberField(field, rawValue) {
			const rule = NUMBER_RULES[field];
			if (!rule) return null;
			const value = Number(rawValue);
			if (!Number.isFinite(value)) {
				return { text: "请输入数字，当前按默认值 " + rule.def + " " + rule.unit + " 处理", value: rule.def };
			}
			if (value < rule.min) {
				return { text: "最小 " + rule.min + " " + rule.unit + "，已按 " + rule.min + " 处理", value: rule.min };
			}
			return null;
		}

		/**
		 * 比较草稿与基线，返回有差异的字段名数组。
		 *
		 * 数组字段不能用 `!==` 比 —— `normalizeSettings` 每次都建新数组，
		 * 引用永远不等，会把「没改」误判成「改了」。所以逐项比较。
		 */
		function computeDirtyKeys(draft, baseline) {
			if (!draft || !baseline) return [];
			const keys = [];
			for (const key of Object.keys(SETTING_DEFAULTS)) {
				const a = draft[key];
				const b = baseline[key];
				if (Array.isArray(a) || Array.isArray(b)) {
					const left = Array.isArray(a) ? a : [];
					const right = Array.isArray(b) ? b : [];
					if (left.length !== right.length) {
						keys.push(key);
						continue;
					}
					let same = true;
					for (let i = 0; i < left.length; i += 1) {
						if (String(left[i]) !== String(right[i])) {
							same = false;
							break;
						}
					}
					if (!same) keys.push(key);
					continue;
				}
				if (typeof a === "boolean" || typeof b === "boolean") {
					if (Boolean(a) !== Boolean(b)) keys.push(key);
					continue;
				}
				if (typeof a === "number" || typeof b === "number") {
					if (Number(a) !== Number(b)) keys.push(key);
					continue;
				}
				if (String(a === undefined ? "" : a) !== String(b === undefined ? "" : b)) keys.push(key);
			}
			return keys;
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

		//#region 表单原子（分组 / 三列行 / 下拉 / 开关 / 标签输入）
		//
		// 这一组是为了「补字段 + 分组」新加的。设计约束见
		// docs/research/ui-redesign.md §3 与 §6。
		//
		// 为什么用 <details> 而不是页内 tab：
		//   settings.section 契约本身就是「一整页 + 外壳导航」
		//   （slots.d.ts:67-78 "The shell owns modal visibility and navigation"），
		//   再套一层 tab 会变成「点导航 → 再点 tab」的两级操作。
		//   <details>/<summary> 是原生语义，键盘与读屏零成本支持。

		/** 折叠状态的 localStorage key。 */
		const GROUP_STORAGE_KEY = "dsh-xiaoai.settings.groups";

		/** 默认展开的分组 —— ①会话与模型 是用户抱怨缺失的，必须第一眼可见。 */
		const DEFAULT_OPEN_GROUPS = ["session", "access"];

		/**
		 * 读取已展开分组集合。
		 *
		 * 必须持久化：XiaoaiSection 每次切导航都会重新挂载，React.useState
		 * 不跨挂载存活 —— 不存的话用户每次进设置都要重新展开。
		 *
		 * 无痕模式 / 禁用存储时 localStorage 会抛异常，因此 try/catch 兜底回默认。
		 */
		function readOpenGroups() {
			try {
				const raw = localStorage.getItem(GROUP_STORAGE_KEY);
				if (raw === null) return new Set(DEFAULT_OPEN_GROUPS);
				const parsed = JSON.parse(raw);
				return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set(DEFAULT_OPEN_GROUPS);
			} catch {
				return new Set(DEFAULT_OPEN_GROUPS);
			}
		}

		/** 写入已展开分组集合（失败静默：存储不可用不该影响设置面板可用性）。 */
		function writeOpenGroups(set) {
			try {
				localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify([...set]));
			} catch {
				/* 无痕模式等场景：折叠状态不持久化，但面板照常工作。 */
			}
		}

		/**
		 * 可折叠分组。
		 *
		 * @param options.group  { id, title, desc, defaultOpen, badge }
		 * @param options.dirty  组内是否有未保存修改 → 标题上打脏点
		 * @param options.onToggle 用户展开/收起时回调（同步到 localStorage）
		 *
		 * ⚠️ 脏点（§6.4）是**最容易做错**的一点：折叠会隐藏脏状态，
		 * 用户在折叠的组里改了东西却看不到，保存后才发现「怎么多了个改动」。
		 * 所以只要组内任一字段脏，标题右侧必须出现圆点 + 无障碍文案。
		 *
		 * ⚠️ 受控 <details open> 的取舍（§8.3-7）：`open` 属性变化**不触发**
		 * toggle 事件，而用户点击会。这里只在挂载那一刻用 defaultOpen 语义
		 * （open 属性），之后**不**在每次 render 强行回写 ——
		 * 回写会让展开动画抖动。
		 */
		function CollapsibleGroup(options) {
			const group = options.group;
			const dirty = Boolean(options.dirty);
			const titleId = "xiaoai-group-" + group.id;
			const summaryChildren = [
				h(
					"span",
					{ className: "xiaoai-group-title", id: titleId, key: "title" },
					group.title,
					dirty
						? h("span", {
								className: "xiaoai-group-dot",
								key: "dot",
								title: "这个分组里有未保存的修改",
								"aria-hidden": "true"
							})
						: null
				),
				group.desc ? h("span", { className: "xiaoai-group-desc", key: "desc" }, group.desc) : null
			];

			return h(
				"details",
				{
					className: "xiaoai-group" + (dirty ? " xiaoai-group-dirty" : ""),
					key: group.id,
					open: options.open === undefined ? Boolean(group.defaultOpen) : Boolean(options.open),
					// 只在用户实际交互时同步；初始 open 变化不进这里。
					onToggle: (event) => {
						if (typeof options.onToggle === "function") options.onToggle(group.id, event.target.open);
					}
				},
				h(
					"summary",
					{
						className: "xiaoai-group-summary",
						"aria-labelledby": titleId,
						// 脏点不能只靠颜色传达（§6.6）
						"aria-label":dirty ? group.title + "，有未保存的修改" : group.title
					},
					h("span", { className: "xiaoai-group-caret", "aria-hidden": "true" }),
					h("span", { className: "xiaoai-group-headtext" }, summaryChildren)
				),
				group.desc ? h("p", { className: "xiaoai-group-note" }, group.desc) : null,
				h("div", { className: "xiaoai-group-body" }, options.children)
			);
		}

		/**
		 * 三列字段行：标签（14em 定宽） / 控件（flex） / 说明（灰字）。
		 *
		 * 长说明走 `?` + tooltip（§6.6 的 dsh-im 范式），不占常驻空间。
		 */
		function FieldRow(options) {
			const labelId = options.id ? options.id + "-label" : undefined;
			const hintId = options.id ? options.id + "-hint" : undefined;
			const children = [
				h(
					"span",
					{ className: "xiaoai-row-label", key: "label", id: labelId },
					options.label,
					options.required ? h("span", { className: "xiaoai-row-req" }, "*") : null
				),
				h("div", { className: "xiaoai-row-control", key: "control" }, options.control)
			];

			if (options.error) {
				children.push(
					h(
						"p",
						{ className: "xiaoai-row-error", key: "error", role: "alert", id: hintId },
						options.error
					)
				);
			} else if (options.hint) {
				children.push(
					h("p", { className: "xiaoai-row-hint", key: "hint", id: hintId }, options.hint)
				);
			}

			return h(
				"div",
				{ className: "xiaoai-row" + (options.error ? " xiaoai-row-invalid" : "") },
				children
			);
		}

		/**
		 * 下拉框。options 支持两种形状：
		 *   · `[{ value, label, note }]`
		 *   · `[{ group: "providerName", items: [{ value, label }] }]` → 渲染成 <optgroup>
		 *
		 * 第一项恒为「跟随宿主默认」（value 为空串），因为空值就是本插件的
		 * 「不覆盖宿主」语义（见 runtime.js #resolveModelSelection）。
		 */
		function Select(options) {
			const items = [];
			for (const entry of options.options || []) {
				if (entry && Array.isArray(entry.items)) {
					items.push(
						h(
							"optgroup",
							{ label: entry.group, key: "g-" + entry.group },
							entry.items.map((item) =>
								h("option", { value: item.value, key: item.value }, item.label)
							)
						)
					);
				} else if (entry) {
					items.push(
						h("option", { value: entry.value, key: entry.value },
							entry.note ? entry.label + "　—　" + entry.note : entry.label)
					);
				}
			}
			return h(
				"select",
				{
					className: "xiaoai-select",
					value: options.value === undefined || options.value === null ? "" : String(options.value),
					disabled: Boolean(options.disabled),
					onChange: (event) => options.onChange(event.target.value)
				},
				items
			);
		}

		/** 开关（checkbox 语义，但外观是 iOS 式滑轨）。 */
		function Switch(options) {
			return h(
				"label",
				{ className: "xiaoai-switch" },
				h("input", {
					type: "checkbox",
					checked: Boolean(options.checked),
					disabled: Boolean(options.disabled),
					onChange: (event) => options.onChange(event.target.checked)
				}),
				h("span", { className: "xiaoai-switch-track", "aria-hidden": "true" },
					h("span", { className: "xiaoai-switch-thumb" })),
				options.text ? h("span", { className: "xiaoai-switch-text" }, options.text) : null
			);
		}

		/**
		 * 标签式数组输入（chip 输入）。
		 *
		 * 交互（§3）：
		 *   · 已添加项渲染成 chip，每个带 × 删除（aria-label="删除 xxx"）
		 *   · 输入框独立在末尾，回车追加
		 *   · 粘贴逗号串自动拆分（半角/全角/顿号/换行）
		 *   · 空数组显示占位文案，不是空白
		 *
		 * ⚠️ 值必须是**真数组**。写成逗号分隔字符串会让「回车加一项」
		 * 变成字符串拼接，保存时被 parseList 切碎 → 丢数据。
		 */
		function TagInput(options) {
			const raw = Array.isArray(options.value) ? options.value : parseList(options.value);
			const [text, setText] = React.useState("");
			const inputId = options.id ? options.id + "-input" : undefined;

			const commit = (inputText) => {
				const additions = splitEntryText(inputText);
				if (additions.length === 0) return;
				options.onChange(appendEntries(raw, additions));
				setText("");
			};

			const chips =
				raw.length === 0
					? [
							h(
								"span",
								{ className: "xiaoai-chip-empty", key: "empty" },
								options.emptyText || "空 = 不播报这一条"
							)
						]
					: raw.map((item, index) =>
							h(
								"span",
								{ className: "xiaoai-chip", key: "chip-" + index + "-" + item },
								h("span", { className: "xiaoai-chip-text" }, item),
								h(
									"button",
									{
										type: "button",
										className: "xiaoai-chip-del",
										"aria-label": "删除 " + item,
										onClick: () => options.onChange(raw.filter((_, i) => i !== index))
									},
									"×"
								)
							)
						);

			return h(
				"div",
				{ className: "xiaoai-tags" },
				h("div", { className: "xiaoai-tags-list" }, chips),
				h(
					"div",
					{ className: "xiaoai-tags-input-row" },
					h("input", {
						id: inputId,
						className: "xiaoai-input xiaoai-tags-input",
						type: "text",
						value: text,
						placeholder: options.placeholder || "输入后回车添加",
						"aria-describedby": options.describedBy,
						onChange: (event) => {
							const next = event.target.value;
							// 粘贴含分隔符的整串时直接拆分入库，省一次回车
							if (/[,，、\n\r\t]/.test(next)) commit(next);
							else setText(next);
						},
						onKeyDown: (event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								commit(text);
							} else if (event.key === "Backspace" && text === "" && raw.length > 0) {
								// 空输入框按退格删最后一项 —— 连续删不丢键盘流
								options.onChange(raw.slice(0, -1));
							}
						},
						// 失焦时落库，避免「填了没回车就点保存」导致丢输入
						onBlur: () => {
							if (text.trim() !== "") commit(text);
						}
					}),
					h("span", { className: "xiaoai-tags-tip" }, "回车添加")
				),
				options.hint ? h("p", { className: "xiaoai-row-hint" }, options.hint) : null
			);
		}

		/** 长说明的 `?` 按钮 + tooltip（§6.6）。 */
		function HelpTip(options) {
			const tipId = options.id + "-tip";
			return h(
				"span",
				{ className: "xiaoai-help" },
				h(
					"button",
					{
						type: "button",
						className: "xiaoai-help-button",
						"aria-label": "查看" + options.label + "说明",
						"aria-describedby": tipId
					},
					h("span", { "aria-hidden": "true" }, "?")
				),
				h(
					"span",
					{ className: "xiaoai-help-tip", id: tipId, role: "tooltip" },
					options.text
				)
			);
		}

		/** 组内小节标题（用于「提示语」组的两段划分）。 */
		function SubHeading(text, hint) {
			return h(
				"div",
				{ className: "xiaoai-subheading" },
				h("h4", null, text),
				hint ? h("span", { className: "xiaoai-muted" }, hint) : null
			);
		}

		//#endregion

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
					h("span", { className: "xiaoai-muted" }, isBlank(speaker.model) ? "型号未知" : speaker.model),
					h("span", { className: "xiaoai-status-sep" }, "·"),
					AiModeBadge(safe.aiMode)
				),
				h(
					"div",
					{ className: "xiaoai-status-line", key: "dsh" },
					h("span", { className: "xiaoai-info-label" }, "DSH 连通："),
					h(
						"span",
						{ className: dsh.reachable ? "xiaoai-ok" : "xiaoai-bad" },
						dsh.reachable ? "可达" : "不可达"
					),
					h("span", { className: "xiaoai-status-sep" }, "·"),
					h("span", { className: "xiaoai-info-label" }, "会话："),
					h(
						"span",
						{ className: isBlank(safe.sessionId) ? "xiaoai-muted" : "xiaoai-ok" },
						isBlank(safe.sessionId) ? "未绑定" : "已绑定"
					),
					h("span", { className: "xiaoai-status-sep" }, "·"),
					h("span", { className: "xiaoai-info-label" }, "工作区："),
					h(
						"span",
						{ className: isBlank(safe.workspacePath) ? "xiaoai-muted" : "" },
						isBlank(safe.workspacePath) ? "未知" : String(safe.workspacePath)
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

		/**
		 * 5. 操作区：三类动作分开（§6.1）。
		 *
		 * 现状把 5 个按钮平铺，「保存」和「测试音箱」视觉权重相同 —— 不合理。
		 * 分成：
		 *   · 配置动作：保存（脏时才可用）/ 撤销修改 / 恢复默认 / 应用推荐配置
		 *   · 工具动作：测试音箱 / 自检 / 重启插件 —— **立即执行**，不参与 draft
		 *
		 * busyAction 是单值：只有被点的那个按钮转圈，其余保持可用（它们互不冲突）。
		 */
		function renderActions(state) {
			const busy = state.busyAction;
			const dirty = state.dirtyCount > 0;
			const spinner = h("span", { className: "xiaoai-spinner", "aria-hidden": "true" });
			const label = (id, idle, doing) =>
				busy === id ? h("span", { className: "xiaoai-btn-busy" }, spinner, doing) : idle;

			return h(
				"div",
				{ className: "xiaoai-actionbar", "aria-busy": busy !== null },
				dirty
					? h(
							"p",
							{ className: "xiaoai-dirty-note", role: "status", key: "dirty" },
							"● 有 " + state.dirtyCount + " 项未保存的修改"
						)
					: null,
				h(
					"div",
					{ className: "xiaoai-actions", key: "config" },
					Button(label("save", "保存", "保存中…"), state.onSave, {
						primary: true,
						disabled: !dirty || busy !== null
					}),
					Button("撤销修改", state.onRevert, { disabled: !dirty || busy !== null }),
					Button("恢复默认", state.onRestoreDefaults, { disabled: busy !== null }),
					h("span", { className: "xiaoai-actions-gap", key: "gap" }),
					Button(
						label("recommend", "应用推荐配置", "读取中…"),
						state.onApplyRecommended,
						{ disabled: busy !== null, title: "只填入草稿，不立即保存" }
					)
				),
				h(
					"div",
					{ className: "xiaoai-actions xiaoai-actions-tools", key: "tools" },
					h("span", { className: "xiaoai-actions-lead" }, "工具："),
					Button(label("speak", "测试音箱", "播放中…"), state.onSpeak, { disabled: busy !== null }),
					Button(label("selftest", "自检", "自检中…"), state.onSelfTest, { disabled: busy !== null }),
					Button(label("restart", "重启插件", "重启中…"), state.onRestart, { disabled: busy !== null })
				)
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

		/**
		 * 设置表单：6 个可折叠分组（设计见 docs/research/ui-redesign.md §2、§4）。
		 *
		 * 分组与默认状态：
		 *   ① 会话与模型   ★默认展开   ← workspace/agentPreset/provider/model/sessionReuse
		 *   ② 接入音箱      ★默认展开   ← enabled/userId/password/did/deviceModel/tts/wakeUp
		 *   ③ 音箱行为      默认折叠     ← AI 模式 / 轮询 / 字数 / 超时 / 三类关键词 / …
		 *   ④ 提示语        默认折叠     ← 9 组提示语（分「对话流程」+「出错提示」）
		 *   ⑤ 高级 / 桥接   默认折叠     ← 忽略规则 / 历史条数 / 详细日志 / 桥接端点
		 *   ⑥ 状态与日志    默认折叠     ← 最近活动 / 会话绑定 / 对话历史 / 运行日志
		 *
		 * 38 个 schema 字段的落位（`onboarded` 是内部状态，按设计隐藏）：
		 *   ① 5 个 · ② 7 个(+1 隐藏) · ③ 11 个 · ④ 9 个 · ⑤ 5 个 = 37 可见 + 1 隐藏 ✓
		 */
		const SETTINGS_GROUPS = [
			{
				id: "session",
				title: "① 会话与模型",
				desc: "语音会话落在哪个工作区、用哪套 Agent 预设与模型。",
				defaultOpen: true
			},
			{
				id: "access",
				title: "② 接入音箱",
				desc: "小米账号、音箱设备与型号。",
				defaultOpen: true
			},
			{
				id: "behavior",
				title: "③ 音箱行为",
				desc: "轮询节奏、回复长度、AI 模式与三类唤醒关键词。",
				defaultOpen: false
			},
			{ id: "phrases", title: "④ 提示语", desc: "音箱在不同阶段念的句子。", defaultOpen: false },
			{
				id: "advanced",
				title: "⑤ 高级 / 桥接",
				desc: "下面的设置一般不需要改。改动前建议先记下原值。",
				defaultOpen: false
			},
			{ id: "status", title: "⑥ 状态与日志", desc: "最近活动、会话绑定与运行日志。", defaultOpen: false }
		];

		/** 组 id → 该组包含的字段（用于计算「本组是否脏」）。 */
		const GROUP_FIELDS = {
			session: ["workspace", "agentPreset", "provider", "model", "sessionReuse"],
			access: ["enabled", "userId", "password", "did", "deviceModel", "ttsCommand", "wakeUpCommand"],
			behavior: [
				"aiModeEnabled",
				"pollIntervalMs",
				"maxReplyChars",
				"replyTimeoutMs",
				"callAIKeywords",
				"wakeUpKeywords",
				"exitKeywords",
				"exitKeepAliveAfter",
				"localCommandsEnabled",
				"triggerKeywords",
				"progressAfterSeconds"
			],
			phrases: [
				"onEnterAI",
				"onExitAI",
				"onAIAsking",
				"onAIReplied",
				"onAIProgress",
				"onAIError",
				"onAIErrorNetwork",
				"onAIErrorAuth",
				"onAIErrorTimeout"
			],
			advanced: ["ignorePatterns", "historyLimit", "verboseLog", "dshApiUrl", "dshApiToken"],
			status: []
		};

		function renderSettingsForm(state) {
			const draft = state.draft;
			if (!draft) return h("p", { className: "xiaoai-muted" }, "设置加载中…");

			const set = (field) => (value) => state.onDraftChange(field, value);
			const dirty = new Set(state.dirtyKeys || []);
			const groupDirty = (groupId) => (GROUP_FIELDS[groupId] || []).some((f) => dirty.has(f));

			// ── ① 会话与模型 ────────────────────────────────────────
			//
			// 这一组是用户原话抱怨缺失的三个设置所在（工作区 / 模型选择 / 会话）。
			// provider 与 model 必须成对：runtime.js #resolveModelSelection
			// 只在**两者都非空**时才用配置，只填一个会被静默忽略 ——
			// 用户会以为「设了却没生效」。因此这里用一个组合控件表达约束。
			const host = state.hostOptions || {};
			const workspaceOptions = (host.workspaces || []).map((w) => ({
				value: w.path || w.id,
				label: (w.name ? w.name + " — " : "") + (w.path || w.id)
			}));
			const presetOptions = (host.presets || []).map((p) => ({
				value: p.id,
				label: p.name && p.name !== p.id ? p.name + "（" + p.id + "）" : p.id
			}));
			const modelOptions = host.models || [];

			// 模型下拉按 provider 分组渲染成 <optgroup>
			const modelGroups = [];
			for (const item of modelOptions) {
				let bucket = modelGroups.find((g) => g.group === item.provider);
				if (!bucket) {
					bucket = { group: item.provider, items: [] };
					modelGroups.push(bucket);
				}
				bucket.items.push({
					value: item.model,
					label: item.model + (item.isDefault ? "（当前默认）" : "")
				});
			}

			const providerNames = [];
			for (const item of modelOptions) {
				if (providerNames.indexOf(item.provider) === -1) providerNames.push(item.provider);
			}

			const modelCatalogWarning =
				state.hostOptionsError
					? "无法读取宿主的模型目录（" + state.hostOptionsError + "），请手动填写 provider 与模型名。"
					: null;

			/**
			 * provider/model 成对约束的实时提示。
			 * 两者都空 = 跟随宿主默认（正常）；只填一个 = 会被静默忽略（必须警告）。
			 */
			const pairFilled = !isBlank(draft.provider) && !isBlank(draft.model);
			const pairHalf = (!isBlank(draft.provider) && isBlank(draft.model)) || (isBlank(draft.provider) && !isBlank(draft.model));
			const pairHint = pairHalf
				? "⚠️ provider 与模型必须**同时填写**才生效，只填一个会被忽略。"
				: pairFilled
					? "已指定 " + draft.provider + " / " + draft.model + "。"
					: "留空 = 使用 DSH 当前默认模型。";

			const sessionBody = [
				FieldRow({
					key: "workspace",
					id: "workspace",
					label: "工作区",
					hint:
						"语音会话会绑定到这个目录，决定它在 DSH 会话列表里归到哪个工作区。" +
						"留空 = 用默认的 ~/.dsh/im。",
					control: h(
						"div",
						{ className: "xiaoai-control-pair" },
						workspaceOptions.length > 0
							? Select({
									value: draft.workspace,
									options: [{ value: "", label: "跟随默认（~/.dsh/im）" }].concat(workspaceOptions),
									onChange: set("workspace")
								})
							: null,
						TextInput({
							value: draft.workspace,
							onChange: set("workspace"),
							placeholder: "留空 = ~/.dsh/im，或粘贴绝对路径"
						})
					)
				}),
				FieldRow({
					key: "agentPreset",
					id: "agentPreset",
					label: "Agent 预设",
					hint: "决定这套会话加载哪些工具与提示词。留空 = 跟随宿主默认预设。",
					control:
						presetOptions.length > 0
							? Select({
									value: draft.agentPreset,
									options: [{ value: "", label: "跟随宿主默认" }].concat(presetOptions),
									onChange: set("agentPreset")
								})
							: TextInput({
									value: draft.agentPreset,
									onChange: set("agentPreset"),
									placeholder: "预设 id，留空 = 宿主默认"
								})
				}),
				FieldRow({
					key: "provider",
					id: "provider",
					label: "模型 Provider",
					hint: pairHint,
					error: pairHalf ? "provider 与模型必须成对，否则配置不生效" : null,
					control:
						providerNames.length > 0
							? Select({
									value: draft.provider,
									options: [{ value: "", label: "跟随宿主默认" }].concat(
										providerNames.map((name) => ({ value: name, label: name }))
									),
									onChange: (value) => {
										// 成对约束：选 provider 时，若模型不属于该 provider，
										// 自动切到该 provider 的第一个模型，避免留下半对配置。
										set("provider")(value);
										if (value === "") {
											set("model")("");
											return;
										}
										const current = modelOptions.find(
											(m) => m.provider === value && m.model === draft.model
										);
										if (!current) {
											const first = modelOptions.find((m) => m.provider === value);
											set("model")(first ? first.model : "");
										}
									}
								})
							: TextInput({
									value: draft.provider,
									onChange: set("provider"),
									placeholder: "如 anthropic，留空 = 宿主默认"
								})
				}),
				FieldRow({
					key: "model",
					id: "model",
					label: "模型",
					hint: "留空 = 用 DSH 当前默认模型。",
					control:
						modelGroups.length > 0
							? Select({
									value: draft.model,
									options: [{ value: "", label: "跟随宿主默认" }].concat(modelGroups),
									onChange: set("model")
								})
							: TextInput({
									value: draft.model,
									onChange: set("model"),
									placeholder: "模型 id，留空 = 宿主默认"
								}),
					...(modelCatalogWarning ? {} : {})
				}),
				modelCatalogWarning
					? h("p", { className: "xiaoai-row-hint xiaoai-warn-inline", key: "catalog-warn" }, modelCatalogWarning)
					: null,
				FieldRow({
					key: "sessionReuse",
					id: "sessionReuse",
					label: "会话复用",
					hint: "开启后重启插件仍继续用上次绑定的会话，保留上下文（能记住前文）；探活失败会自动新建。关闭则每次重新开始。",
					control: Switch({
						checked: Boolean(draft.sessionReuse),
						onChange: set("sessionReuse"),
						text: draft.sessionReuse ? "开启" : "关闭"
					})
				})
			];

			// ── ② 接入音箱 ──────────────────────────────────────────
			const modelCandidates = state.deviceModels || [];
			const sessionBodyExtra = [];

			const accessBody = [
				FieldRow({
					key: "enabled",
					id: "enabled",
					label: "启用",
					hint: "关掉后不再轮询音箱，语音入口整体停用。",
					control: Switch({
						checked: Boolean(draft.enabled),
						onChange: set("enabled"),
						text: draft.enabled ? "已启用" : "已停用"
					})
				}),
				FieldRow({
					key: "userId",
					id: "userId",
					label: "小米 ID",
					hint: "小米账号 ID，不是手机号。",
					control: TextInput({
						value: draft.userId,
						onChange: set("userId"),
						placeholder: "小米账号 ID（不是手机号）"
					})
				}),
				FieldRow({
					key: "password",
					id: "password",
					label: "密码",
					hint: "留空 = 不修改已保存的密码。",
					control: TextInput({
						value: draft.password,
						onChange: set("password"),
						type: state.passwordVisible ? "text" : "password",
						autoComplete: "new-password",
						placeholder: state.passwordRedacted ? "已保存（留空则不修改）" : "小米账号密码"
					})
				}),
				FieldRow({
					key: "did",
					id: "did",
					label: "音箱 DID",
					hint: "设备 ID 或米家名称。",
					control: TextInput({
						value: draft.did,
						onChange: set("did"),
						placeholder: "设备 ID 或米家名称"
					})
				}),
				FieldRow({
					key: "deviceModel",
					id: "deviceModel",
					label: "音箱型号",
					hint: "空 = 连接时从设备硬件信息自动识别（推荐）。",
					control:
						modelCandidates.length > 0
							? Select({
									value: draft.deviceModel,
									options: [{ value: "", label: "自动识别" }].concat(
										modelCandidates.map((m) => ({
											value: m.code,
											label: m.name ? m.code + "　" + m.name : m.code,
											note: m.support ? supportText(m.support) : ""
										}))
									),
									onChange: set("deviceModel")
								})
							: TextInput({
									value: draft.deviceModel,
									onChange: set("deviceModel"),
									placeholder: "如 OH2P，留空 = 自动识别"
								})
				}),
				// 高级指令：99% 的用户用不到，折叠起来但排障时能找到
				h(
					"details",
					{ className: "xiaoai-subdetails", key: "advanced-cmd" },
					h("summary", null, "高级：自定义 TTS / 唤醒指令"),
					FieldRow({
						key: "ttsCommand",
						id: "ttsCommand",
						label: "TTS 指令",
						hint: "仅型号未被兼容表收录时手填，格式如 7,3。",
						control: TextInput({
							value: draft.ttsCommand,
							onChange: set("ttsCommand"),
							placeholder: "如 7,3（留空 = 用兼容表默认值）"
						})
					}),
					FieldRow({
						key: "wakeUpCommand",
						id: "wakeUpCommand",
						label: "唤醒指令",
						hint: "仅型号未被兼容表收录时手填，格式如 7,1。",
						control: TextInput({
							value: draft.wakeUpCommand,
							onChange: set("wakeUpCommand"),
							placeholder: "如 7,1（留空 = 用兼容表默认值）"
						})
					})
				)
			];

			// ── ③ 音箱行为 ──────────────────────────────────────────
			const aiModeOn = Boolean(draft.aiModeEnabled);
			const behaviorBody = [
				FieldRow({
					key: "aiModeEnabled",
					id: "aiModeEnabled",
					label: "启用 AI 模式",
					hint: "开启后支持「进入 / 退出 AI 模式」的连续对话；关闭则只做逐条关键词匹配。",
					control: Switch({
						checked: aiModeOn,
						onChange: set("aiModeEnabled"),
						text: aiModeOn ? "开启" : "关闭"
					})
				}),
				FieldRow({
					key: "pollIntervalMs",
					id: "pollIntervalMs",
					label: "轮询间隔",
					error: state.fieldWarnings ? state.fieldWarnings.pollIntervalMs : null,
					hint: "毫秒。越小响应越快，但小米接口有风控，最小 2000。",
					control: TextInput({
						value: draft.pollIntervalMs,
						onChange: set("pollIntervalMs"),
						type: "number"
					})
				}),
				FieldRow({
					key: "maxReplyChars",
					id: "maxReplyChars",
					label: "回复字数上限",
					hint: "音箱念太长很难受，超出部分会被截断。",
					control: TextInput({
						value: draft.maxReplyChars,
						onChange: set("maxReplyChars"),
						type: "number"
					})
				}),
				FieldRow({
					key: "replyTimeoutMs",
					id: "replyTimeoutMs",
					label: "回复等待上限",
					error: state.fieldWarnings ? state.fieldWarnings.replyTimeoutMs : null,
					hint: "毫秒。超过就放弃并播报超时提示。",
					control: TextInput({
						value: draft.replyTimeoutMs,
						onChange: set("replyTimeoutMs"),
						type: "number"
					})
				}),
				FieldRow({
					key: "exitKeepAliveAfter",
					id: "exitKeepAliveAfter",
					label: "静默退出时长",
					error: state.fieldWarnings ? state.fieldWarnings.exitKeepAliveAfter : null,
					hint: "秒。AI 模式下多久没说话自动退出，最小 5。",
					control: TextInput({
						value: draft.exitKeepAliveAfter,
						onChange: set("exitKeepAliveAfter"),
						type: "number"
					})
				}),
				FieldRow({
					key: "progressAfterSeconds",
					id: "progressAfterSeconds",
					label: "进度播报阈值",
					error: state.fieldWarnings ? state.fieldWarnings.progressAfterSeconds : null,
					hint: "秒。任务超过这个时间没完成，先播一句安抚语，最小 10。",
					control: TextInput({
						value: draft.progressAfterSeconds,
						onChange: set("progressAfterSeconds"),
						type: "number"
					})
				}),
				FieldRow({
					key: "localCommandsEnabled",
					id: "localCommandsEnabled",
					label: "本地快速路径",
					hint: "音量 / 时间 / 停止这类高频指令本机处理，毫秒级响应、不走大模型。",
					control: Switch({
						checked: Boolean(draft.localCommandsEnabled),
						onChange: set("localCommandsEnabled"),
						text: draft.localCommandsEnabled ? "开启" : "关闭"
					})
				}),
				SubHeading("AI 模式关键词", "三类语义不同，别混用"),
				FieldRow({
					key: "wakeUpKeywords",
					id: "wakeUpKeywords",
					label: "进入 AI 模式",
					control: TagInput({
						id: "wakeUpKeywords",
						value: draft.wakeUpKeywords,
						onChange: set("wakeUpKeywords"),
						emptyText: "空 = 只能用触发词逐条唤醒",
						placeholder: "如：进入AI模式"
					}),
					hint: "说了这些词就进入连续对话，之后不用再喊触发词。"
				}),
				FieldRow({
					key: "exitKeywords",
					id: "exitKeywords",
					label: "退出 AI 模式",
					control: TagInput({
						id: "exitKeywords",
						value: draft.exitKeywords,
						onChange: set("exitKeywords"),
						emptyText: "空 = 只能靠静默超时退出",
						placeholder: "如：退出AI模式"
					}),
					hint: "说了就回到待命，普通话不再处理。"
				}),
				FieldRow({
					key: "callAIKeywords",
					id: "callAIKeywords",
					label: "直接问",
					control: TagInput({
						id: "callAIKeywords",
						value: draft.callAIKeywords,
						onChange: set("callAIKeywords"),
						emptyText: "空 = 不使用直接问",
						placeholder: "如：问问"
					}),
					hint: "以这些词开头时立刻交给 DSH，但不改变模式。"
				}),
				// ⚠️ triggerKeywords 与 aiModeEnabled 是互斥的两套机制
				// （runtime.js:1206-1242 的状态机分支）—— 只在关闭 AI 模式时展开。
				aiModeOn
					? h(
							"p",
							{ className: "xiaoai-row-hint", key: "trigger-off-note" },
							"「触发词」仅在**关闭 AI 模式**时生效，当前已隐藏。"
						)
					: FieldRow({
							key: "triggerKeywords",
							id: "triggerKeywords",
							label: "触发词",
							control: TagInput({
								id: "triggerKeywords",
								value: draft.triggerKeywords,
								onChange: set("triggerKeywords"),
								emptyText: "空 = 全部转发",
								placeholder: "如：小爱同学"
							}),
							hint: "仅在你关闭 AI 模式后使用。留空 = 所有话都转发给 DSH。"
						})
			];

			// ── ④ 提示语 ────────────────────────────────────────────
			//
			// 9 个字段语义一致：空数组 = 不播报，多条时随机取一条。
			// 分「对话流程」与「出错提示」两小节（§4 的组④）。
			const phraseRow = (field, label, hint, placeholder) =>
				FieldRow({
					key: field,
					id: field,
					label: label,
					hint: hint,
					control: TagInput({
						id: field,
						value: draft[field],
						onChange: set(field),
						emptyText: "空 = 不播报这一条",
						placeholder: placeholder || "输入后回车添加，可加多条"
					})
				});

			const phrasesBody = [
				SubHeading("对话流程提示", "多条时随机取一条播报"),
				phraseRow("onEnterAI", "进入 AI 模式", "进入时播报。"),
				phraseRow("onExitAI", "退出 AI 模式", "退出时播报。"),
				phraseRow("onAIAsking", "思考中", "已交给 DSH、等回复时播报。"),
				phraseRow("onAIReplied", "回答完毕", "回复念完之后播报。默认空 = 不播报。"),
				phraseRow("onAIProgress", "进度安抚", "长任务超过阈值时播报一次。"),
				SubHeading("出错提示", "按错误类型分类播报，比笼统的「出错了」有用得多"),
				phraseRow("onAIErrorNetwork", "出错 · 网络", "连接失败 / 断开时。"),
				phraseRow("onAIErrorAuth", "出错 · 鉴权", "401 / 403 / token 过期时。"),
				phraseRow("onAIErrorTimeout", "出错 · 超时", "请求超时时。"),
				phraseRow("onAIError", "出错 · 兜底", "未命中上面任何分类时的兜底。")
			];

			// ── ⑤ 高级 / 桥接 ───────────────────────────────────────
			const advancedBody = [
				FieldRow({
					key: "ignorePatterns",
					id: "ignorePatterns",
					label: "忽略规则",
					control: TagInput({
						id: "ignorePatterns",
						value: draft.ignorePatterns,
						onChange: set("ignorePatterns"),
						emptyText: "空 = 不过滤任何句子",
						placeholder: "如：^小爱同学$"
					}),
					hint: "正则。匹配到的句子直接忽略，不转发给 DSH。"
				}),
				FieldRow({
					key: "historyLimit",
					id: "historyLimit",
					label: "历史保留条数",
					error: state.fieldWarnings ? state.fieldWarnings.historyLimit : null,
					hint: "面板里能回看多少轮对话。",
					control: TextInput({
						value: draft.historyLimit,
						onChange: set("historyLimit"),
						type: "number"
					})
				}),
				FieldRow({
					key: "verboseLog",
					id: "verboseLog",
					label: "详细日志",
					hint: "打开后日志量明显变大，仅排障时用。",
					control: Switch({
						checked: Boolean(draft.verboseLog),
						onChange: set("verboseLog"),
						text: draft.verboseLog ? "开启" : "关闭"
					})
				}),
				FieldRow({
					key: "dshApiUrl",
					id: "dshApiUrl",
					label: "HTTP 桥接地址",
					hint: "仅在进程内 agent 不可用时才走这条通路。一般不用改。",
					control: TextInput({
						value: draft.dshApiUrl,
						onChange: set("dshApiUrl"),
						placeholder: "http://127.0.0.1:3082/api/session"
					})
				}),
				FieldRow({
					key: "dshApiToken",
					id: "dshApiToken",
					label: "HTTP 桥接令牌",
					hint: "敏感。留空 = 不修改。",
					control: TextInput({
						value: draft.dshApiToken,
						onChange: set("dshApiToken"),
						type: "password",
						autoComplete: "new-password",
						placeholder: state.tokenRedacted ? "已保存（留空则不修改）" : "桥接鉴权令牌"
					})
				})
			];

			// ── ⑥ 状态与日志 ────────────────────────────────────────
			const statusBody = [state.renderStatusGroup()];

			const bodies = {
				session: sessionBody,
				access: accessBody,
				behavior: behaviorBody,
				phrases: phrasesBody,
				advanced: advancedBody,
				status: statusBody
			};

			return h(
				"div",
				{ className: "xiaoai-form" },
				SETTINGS_GROUPS.map((group) =>
					CollapsibleGroup({
						group,
						open: state.openGroups.has(group.id),
						dirty: groupDirty(group.id),
						onToggle: state.onToggleGroup,
						children: bodies[group.id]
					})
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
			/**
			 * 基线：最近一次「加载成功 / 保存成功」的草稿快照。
			 * 脏检查与「撤销修改」都以它为参照，因此它**只在**这两个时机更新。
			 */
			const [baseline, setBaseline] = React.useState(null);
			const [revision, setRevision] = React.useState(undefined);
			const [passwordRedacted, setPasswordRedacted] = React.useState(false);
			const [tokenRedacted, setTokenRedacted] = React.useState(false);
			/** 密码明文切换（纯前端，不改传输）。 */
			const [passwordVisible, setPasswordVisible] = React.useState(false);
			/**
			 * 当前正在执行的动作；null 表示空闲。
			 * 拆成单值而不是一个 busy 布尔 —— 否则点「测试音箱」会把
			 * 「保存」一起禁掉，语义不清（§6.2）。
			 */
			const [busyAction, setBusyAction] = React.useState(null);
			const [notice, setNotice] = React.useState(null);
			const [logsOpen, setLogsOpen] = React.useState(false);
			const [logs, setLogs] = React.useState([]);
			const [logsLoading, setLogsLoading] = React.useState(false);
			const [logsError, setLogsError] = React.useState(null);
			const [selfTestReply, setSelfTestReply] = React.useState(null);

			// ── 折叠分组：初值从 localStorage 读，跨挂载存活 ──
			const [openGroups, setOpenGroups] = React.useState(readOpenGroups);
			const onToggleGroup = React.useCallback((groupId, isOpen) => {
				setOpenGroups((previous) => {
					const next = new Set(previous);
					if (isOpen) next.add(groupId);
					else next.delete(groupId);
					writeOpenGroups(next);
					return next;
				});
			}, []);

			// ── 宿主可选项目录（工作区 / 预设 / 模型 / 音箱型号）──
			const [hostOptions, setHostOptions] = React.useState(null);
			const [hostOptionsError, setHostOptionsError] = React.useState(null);
			const [deviceModels, setDeviceModels] = React.useState([]);

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

			/**
			 * 把服务端返回的 values 变成「草稿」。
			 *
			 * ⚠️ 三个调用点（初次加载 / 保存后回填 / 推荐配置）必须共用这一个函数。
			 * 早期实现里保存后回填是就地拼装的，扩字段时三处会漂移 ——
			 * 这是设计文档 §8.3-5 点名的既有重复。
			 *
			 * 掩码字段（password / dshApiToken）回读时是 `******`，
			 * 直接回写会把真实密码覆盖成星号，所以这里统一清空 + 置标记。
			 */
			const draftFromValues = React.useCallback((rawValues) => {
				const values = normalizeSettings(rawValues);
				const passwordIsRedacted = isRedacted(values.password);
				const tokenIsRedacted = isRedacted(values.dshApiToken);
				setPasswordRedacted(passwordIsRedacted);
				setTokenRedacted(tokenIsRedacted);
				const next = { ...values };
				if (passwordIsRedacted) next.password = "";
				if (tokenIsRedacted) next.dshApiToken = "";
				return next;
			}, []);

			/** 拉取设置（契约 §4 xiaoai.settings.get）。 */
			const loadSettings = React.useCallback(async () => {
				try {
					const result = await call("xiaoai.settings.get", {});
					const next = draftFromValues(result && result.values);
					setDraft(next);
					setBaseline(next);
					setRevision(result ? result.revision : undefined);
				} catch (error) {
					setNotice({ kind: "error", text: "设置读取失败：" + describeError(error) });
				}
			}, [call, draftFromValues]);

			/**
			 * 拉取宿主可选项目录（工作区 / Agent 预设 / 模型）。
			 *
			 * 这是模型选择与工作区下拉的数据源。**失败不阻断** ——
			 * 拿不到就退化为手填输入框 + 一行提示（§5.1 明确要求的降级路径）。
			 * 不能因为远端读不到就让用户完全无法配置。
			 */
			const loadHostOptions = React.useCallback(async () => {
				try {
					const result = await call("xiaoai.hostOptions", {});
					setHostOptions({
						workspaces: (result && result.workspaces) || [],
						presets: (result && result.presets) || [],
						models: (result && result.models) || []
					});
					setHostOptionsError(null);
				} catch (error) {
					setHostOptions({ workspaces: [], presets: [], models: [] });
					setHostOptionsError(describeError(error));
				}
			}, [call]);

			/**
			 * 拉取音箱型号兼容表。
			 * ⚠️ 这才是 `xiaoai.onboarding.models` 的正确用途 —— 它返回的是
			 * **音箱硬件型号**（OH2P 这类，带 TTS / 唤醒指令字节），
			 * 与 LLM 的 provider/model 毫无关系。绝不能拿它填模型下拉。
			 */
			const loadDeviceModels = React.useCallback(async () => {
				try {
					const result = await call("xiaoai.onboarding.models", {});
					setDeviceModels((result && result.models) || []);
				} catch {
					setDeviceModels([]);
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

			// 挂载时读一次设置 + 宿主可选项目录。
			React.useEffect(() => {
				loadSettings();
				loadHostOptions();
				loadDeviceModels();
			}, [loadSettings, loadHostOptions, loadDeviceModels]);

			// 展开日志时按需拉取。
			React.useEffect(() => {
				if (logsOpen) loadLogs();
			}, [logsOpen, loadLogs]);

			/** 保存设置（契约 §4 xiaoai.settings.update，带 revision 乐观锁）。 */
			const onSave = React.useCallback(async () => {
				if (!draft) return;
				setBusyAction("save");
				setNotice(null);
				try {
					const patch = buildPatch(draft);
					const result = await call("xiaoai.settings.update", { patch, revision });
					setRevision(result ? result.revision : undefined);
					const next = draftFromValues(result && result.values);
					setDraft(next);
					setBaseline(next);
					setNotice({ kind: "ok", text: "设置已保存。" });
				} catch (error) {
					setNotice({ kind: "error", text: "保存失败：" + describeError(error) });
				} finally {
					setBusyAction(null);
				}
			}, [call, draft, revision, draftFromValues]);

			/** 撤销修改：把草稿重置回最近一次加载 / 保存的值。 */
			const onRevert = React.useCallback(() => {
				if (!baseline) return;
				setDraft({ ...baseline });
				setNotice({ kind: "ok", text: "已撤销未保存的修改。" });
			}, [baseline]);

			/**
			 * 恢复默认：把草稿填回本地的 SETTING_DEFAULTS。
			 * 二次确认，因为这会丢掉用户全部自定义配置（仅草稿，未落盘）。
			 */
			const onRestoreDefaults = React.useCallback(() => {
				const ok =
					typeof window === "undefined" ||
					window.confirm("确定把所有设置恢复成默认值吗？（不会立即保存，仍需点「保存」）");
				if (!ok) return;
				const next = {};
				for (const key of Object.keys(SETTING_DEFAULTS)) {
					const value = SETTING_DEFAULTS[key];
					next[key] = Array.isArray(value) ? value.slice() : value;
				}
				// 掩码字段保持留空语义，避免把占位值写回
				next.password = "";
				next.dshApiToken = "";
				setDraft(next);
				setNotice({ kind: "ok", text: "已填入默认值（未保存）。点「保存」生效。" });
			}, []);

			/** 重启轮询循环（契约 §4 xiaoai.restart）。 */
			const onRestart = React.useCallback(async () => {
				setBusyAction("restart");
				setNotice(null);
				try {
					await call("xiaoai.restart", {});
					setNotice({ kind: "ok", text: "已请求重启。" });
				} catch (error) {
					setNotice({ kind: "error", text: "重启失败：" + describeError(error) });
				} finally {
					setBusyAction(null);
				}
			}, [call]);

			/** 测 TTS（契约 §4 xiaoai.speak）。 */
			const onSpeak = React.useCallback(async () => {
				setBusyAction("speak");
				setNotice(null);
				try {
					await call("xiaoai.speak", { text: SPEAK_TEST_PHRASE });
					setNotice({ kind: "ok", text: "已让音箱念出测试语句。" });
				} catch (error) {
					setNotice({ kind: "error", text: "测试音箱失败：" + describeError(error) });
				} finally {
					setBusyAction(null);
				}
			}, [call]);

			/** 走完整链路自检（契约 §4 xiaoai.test）。 */
			const onSelfTest = React.useCallback(async () => {
				setBusyAction("selftest");
				setNotice(null);
				setSelfTestReply(null);
				try {
					const result = await call("xiaoai.test", { text: SELF_TEST_PROMPT });
					setSelfTestReply(result && result.reply ? String(result.reply) : "（空回复）");
				} catch (error) {
					setNotice({ kind: "error", text: "自检失败：" + describeError(error) });
				} finally {
					setBusyAction(null);
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
				setBusyAction("recommend");
				setNotice(null);
				try {
					const result = await call("xiaoai.settings.recommended", {});
					const patch = (result && result.patch) || null;
					if (!patch || typeof patch !== "object") {
						setNotice({ kind: "error", text: "未取到推荐配置" });
						return;
					}
					// 推荐值也要过一遍归一化：它可能带数组字段，直接展开会把
					// 真数组换成别的形状，正是 TagInput 最怕的输入。
					const normalized = normalizeSettings(patch);
					setDraft((previous) => {
						if (previous === null) return previous;
						const next = { ...previous };
						for (const key of Object.keys(normalized)) {
							if (patch[key] !== undefined) next[key] = normalized[key];
						}
						return next;
					});
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
					setBusyAction(null);
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

			// ── 脏检查（§6.4）──
			//
			// 数组字段不能用 !== 比（normalizeSettings 每次都建新数组），
			// 所以 computeDirtyKeys 内部逐项比较。
			const dirtyKeys = React.useMemo(
				() => computeDirtyKeys(draft, baseline),
				[draft, baseline]
			);

			// ── 数值字段的钳制提示（§6.3）──
			//
			// 以前 buildPatch 是「静默钳制」：用户填 500 会被悄悄改成 2000，
			// 没有任何反馈。现在行内实时说明，让用户知道发生了什么。
			const fieldWarnings = React.useMemo(() => {
				if (!draft) return {};
				const out = {};
				for (const field of Object.keys(NUMBER_RULES)) {
					const warning = clampNumberField(field, draft[field]);
					if (warning) out[field] = warning.text;
				}
				return out;
			}, [draft]);

			/** ⑥ 状态与日志组的内容（纯展示 + 现有日志组件）。 */
			const renderStatusGroup = React.useCallback(
				() =>
					h(
						"div",
						{ className: "xiaoai-status-group" },
						renderRecent(status),
						h(
							"div",
							{ className: "xiaoai-bind-info" },
							InfoRow("会话 ID", isBlank(status && status.sessionId) ? "未绑定" : String(status.sessionId)),
							InfoRow(
								"工作区路径",
								isBlank(status && status.workspacePath) ? "未知" : String(status.workspacePath)
							),
							InfoRow(
								"绑定方式",
								isBlank(status && status.boundVia) ? "未知" : String(status.boundVia)
							)
						),
						renderLogs({
							logsOpen,
							logs,
							logsLoading,
							logsError,
							onToggleLogs: () => setLogsOpen((open) => !open)
						})
					),
				[status, logsOpen, logs, logsLoading, logsError]
			);

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
				renderSettingsForm({
					draft,
					passwordRedacted,
					tokenRedacted,
					passwordVisible,
					onDraftChange,
					openGroups,
					onToggleGroup,
					dirtyKeys,
					fieldWarnings,
					hostOptions,
					hostOptionsError,
					deviceModels,
					renderStatusGroup
				}),
				renderActions({
					busyAction,
					dirtyCount: dirtyKeys.length,
					onSave,
					onRevert,
					onRestoreDefaults,
					onRestart,
					onSpeak,
					onSelfTest,
					onApplyRecommended
				}),
				selfTestReply !== null
					? h(
							"p",
							{ className: "xiaoai-selftest", key: "selftest" },
							"自检回复：" + selfTestReply
						)
					: null
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
					// hostOptions() 无参 —— 漏了它网关会报 unexpected "args"
					"hostOptions",
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
