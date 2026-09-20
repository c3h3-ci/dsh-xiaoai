/**
 * 本机（非 HA addon）适配补丁 —— 幂等，可重复执行。
 *
 * 背景：DSH 有两种部署形态，插件原先只适配了 HA addon：
 *   · HA addon：DSH 在 $DSH_HOME/vendor/node_modules/@deepseek-ai/dsh
 *   · npm -g  ：DSH 在 <node前缀>/lib/node_modules/@deepseek-ai/dsh
 * 以及 vendor 库默认 HTTP 超时只有 3s，走代理时轮询必失败。
 *
 * 本脚本把这几处适配写回 src/，避免被后续覆盖后忘记重做。
 * 用法：node scripts/apply-local-fixes.mjs && node scripts/build.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const MARK = "__LOCAL_FIX__";
let changed = 0;

function patch(file, oldText, newText, label) {
  if (!existsSync(file)) { console.log(`  SKIP ${label}: ${file} 不存在`); return; }
  let s = readFileSync(file, "utf8");
  if (s.includes(newText.slice(0, 80))) { console.log(`  OK   ${label}（已应用）`); return; }
  if (!s.includes(oldText)) { console.log(`  MISS ${label}：锚点文本未找到`); return; }
  writeFileSync(file, s.replace(oldText, newText));
  changed += 1;
  console.log(`  FIX  ${label}`);
}

// 1) rpc.js —— 用 argv[1] 反推正在运行的 DSH 根
patch(
  "src/rpc.js",
  `const ANCHOR_CANDIDATES = [
  () => \`\${process.env.DSH_HOME ?? "/data/dsh"}/vendor/node_modules/@deepseek-ai/dsh/package.json\`,`,
  `const ANCHOR_CANDIDATES = [
  // ${MARK} 全局 npm/nvm 形态：从正在运行的 DSH 入口反推安装根
  () => {
    const bin = process.env.DSH_BIN ?? process.argv[1] ?? "";
    const root = bin.replace(/\\/lib\\/bin\\.(js|mjs|cjs)$/, "");
    return root ? \`\${root}/node_modules/@deepseek-ai/dsh/package.json\` : "";
  },
  () => \`\${process.env.DSH_HOME ?? "/data/dsh"}/vendor/node_modules/@deepseek-ai/dsh/package.json\`,`,
  "rpc.js 锚点"
);

// 2) xiaomi.js —— HTTP 超时 3s → 15s
patch(
  "src/xiaomi.js",
  `const EMPTY_STREAK_LIMIT = 5;`,
  `const EMPTY_STREAK_LIMIT = 5;

/** ${MARK} 小米云 HTTP 超时；vendor 默认仅 3000ms，走代理时必然 abort。 */
const MI_HTTP_TIMEOUT_MS = 15000;`,
  "xiaomi.js 超时常量"
);
patch(
  "src/xiaomi.js",
  `    const cfg = { userId: this.userId, password: this.password, did: this.did };`,
  `    const cfg = {
      userId: this.userId,
      password: this.password,
      did: this.did,
      timeout: MI_HTTP_TIMEOUT_MS, // ${MARK}
    };`,
  "xiaomi.js 超时传参"
);

console.log(`\n共应用 ${changed} 处补丁。请接着执行：node scripts/build.mjs`);
