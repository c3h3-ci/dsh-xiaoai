/**
 * 引导模块 —— 唯一的职责是【在任何人 import xiaomi.js 之前】设好凭据路径。
 *
 * 为什么需要它：
 *   ESM 规范要求所有 `import` 声明在模块内的任何其他语句之前求值。
 *   因此这样写是【无效】的：
 *
 *     import { readFileSync } from "node:fs";
 *     process.env.XIAOAI_MI_STORE ??= "...";     // ← 永远晚于下面的 import
 *     import { XiaomiSpeaker } from "./xiaomi.js";
 *
 *   而 vendored 的 mi-service-lite 在模块求值时就锁定路径：
 *     var kConfigFile = process.env.XIAOAI_MI_STORE || ".mi.json";
 *
 *   唯一可靠的做法是：让一个【只做这件事】的模块被最先 import。
 *   由于 ESM 按依赖图的深度优先顺序求值，只要 xiaomi.js 之前
 *   出现 `import "./bootstrap.js"`，这个副作用就会先执行。
 */

const DSH_HOME = process.env.DSH_HOME ?? "/data/dsh";

/**
 * 解析凭据文件路径。
 *
 * ⚠️ 必须与 index.js 的 resolveStateDir() 用同一套规则 —— 否则会出现
 * 「bootstrap 定了一个路径、runtime 又传另一个」的错配，而 storePathHonored
 * 检查会因此硬失败。台式DSH 那次死机的根因链条里就有这一环：
 *   路径错配 → connect 抛错 → 但 token 已刷新 → 触发无限重启循环。
 */
export function resolveMiStorePath() {
  const dir = process.env.DSH_XIAOAI_STATE_DIR ?? `${DSH_HOME}/xiaoai-state`;
  return process.env.XIAOAI_MI_STORE ?? `${dir}/mi-store.json`;
}

process.env.XIAOAI_MI_STORE ??= resolveMiStorePath();

export const MI_STORE_PATH = process.env.XIAOAI_MI_STORE;
