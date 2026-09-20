/**
 * 构建：把 src/ 与 vendor/ 同步到 lib/。
 *
 * 本插件刻意不引入 tsup/esbuild/TypeScript —— 全部源码都是可直接运行的
 * ESM，Node 与浏览器都能直接吃。这一步只做「复制」，但**必须机械可靠**。
 *
 * ⚠️ 历史教训（issue #1，P0）：
 * 这里原本是一份**手工维护的 COPIES 清单**，结果漏掉了 token-refresh.js。
 * 而每次构建又先 `rmSync("lib")` 清空目录 —— 于是该文件永久缺失，
 * lib/runtime.js 的 import 解析失败 → cordis loader 无限重试 →
 * CPU 191% + 日志零输出 → Supervisor 120s 超时杀进程 → 循环重启。
 *
 * 现在改成：**递归扫描 + 复制后断链自检**。任何相对 import 找不到目标
 * 文件都会让构建**失败退出**，从机制上杜绝同类问题。
 */
import { cpSync, rmSync, mkdirSync, existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";

/** 需要整体同步的目录：[源, 目标]。 */
const ROOTS = [
  ["src", "lib"],
  ["vendor", "lib/vendor"],
];

/** 只同步这些扩展名。 */
const EXTS = /\.(js|mjs|cjs|json)$/;

/** 递归收集目录下的待同步文件（相对 base 的路径）。 */
function collect(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full, base, out);
    } else if (EXTS.test(entry)) {
      out.push(relative(base, full));
    }
  }
  return out;
}

// ── 1. 清空并重建 lib/ ──
rmSync("lib", { recursive: true, force: true });
for (const [, dest] of ROOTS) mkdirSync(dest, { recursive: true });

// ── 2. 递归复制 ──
let copied = 0;
for (const [src, dest] of ROOTS) {
  for (const rel of collect(src)) {
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(src, rel), to);
    copied += 1;
  }
}
console.log(`  已复制 ${copied} 个文件`);

// ── 3. 断链自检：lib/ 中每个相对 import 都必须有实体文件 ──
let broken = 0;
for (const rel of collect("lib")) {
  if (!rel.endsWith(".js")) continue;
  const text = readFileSync(join("lib", rel), "utf8");
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
    const spec = m[1];
    const target = join(dirname(join("lib", rel)), spec);
    const exists = existsSync(target) || existsSync(`${target}.js`) || existsSync(join(target, "index.js"));
    if (!exists) {
      console.error(`  ❌ 断链: lib/${rel} → ${spec}`);
      broken += 1;
    }
  }
}
if (broken > 0) {
  console.error(`\n❌ 构建失败：发现 ${broken} 处断链（这就是 issue #1 的故障模式）`);
  process.exit(1);
}
console.log("  ✅ 断链自检通过");

// ── 4. 客户端入口存在性（package.json 声明了 ./client，缺了会启动即抛）──
const clientEntry = "lib/client/index.js";
if (!existsSync(clientEntry)) {
  console.error(`❌ 构建失败：package.json 声明了 ./client 但 ${clientEntry} 不存在`);
  process.exit(1);
}
console.log("  ✅ 客户端入口存在");
console.log("✅ lib/ 已同步");
