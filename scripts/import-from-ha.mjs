/**
 * 从远程 Home Assistant 导入小米凭据（含 micoapi + xiaomiio 两份）。
 *
 * 为什么需要这个脚本：
 *   小米云有两个服务（MiNA/micoapi 拉对话、MiIOT/xiaomiio 控制音箱），
 *   各需独立的 serviceToken。缺任一份，插件都无法工作
 *   （详见 docs/CREDENTIALS.md）。而 HA 的 xiaomi_miot 集成两份都有，
 *   是获取凭据最省事的来源。
 *
 * 用法：
 *   node scripts/import-from-ha.mjs \
 *     --host 192.168.3.3 --user root --password '***' \
 *     --state-dir ~/.dsh/xiaoai-state
 *
 * 依赖系统 sshpass（Debian/UOS: apt install sshpass）。
 * 只读 HA 的凭据文件，不做任何修改；失败时不动本地文件。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1]?.startsWith("--") ? true : argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const host = args.host;
const user = args.user ?? "root";
const password = args.password;
const stateDir = resolve((args["state-dir"] ?? `${homedir()}/.dsh/xiaoai-state`).replace(/^~/, homedir()));

if (!host || !password) {
  console.error("用法: node scripts/import-from-ha.mjs --host <ip> --user <u> --password <p> [--state-dir <dir>]");
  process.exit(1);
}

/** 在远程执行命令（通过 sshpass，密码走环境变量，不出现在 argv）。 */
function ssh(cmd) {
  return execFileSync("sshpass", [
    "-e", "ssh",
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=10",
    `${user}@${host}`,
    cmd,
  ], { env: { ...process.env, SSHPASS: password }, encoding: "utf8", timeout: 60_000 }).trim();
}

/** HA 的凭据文件候选目录（addon / core / supervised 布局）。 */
const HA_DIRS = [
  "/homeassistant/.storage/xiaomi_miot",
  "/config/.storage/xiaomi_miot",
  "/usr/share/hassio/homeassistant/.storage/xiaomi_miot",
];

console.log(`  连接 ${user}@${host} …`);
let dir = null;
for (const d of HA_DIRS) {
  try {
    ssh(`test -d ${d} && echo ok`);
    dir = d;
    break;
  } catch { /* 试下一个 */ }
}
if (!dir) {
  console.error("  ❌ 未找到 xiaomi_miot 凭据目录（试过: " + HA_DIRS.join(", ") + "）");
  process.exit(1);
}
console.log(`  ✅ 凭据目录: ${dir}`);

// 找 uid
const listing = ssh(`ls ${dir} 2>/dev/null | grep -E '^auth-[0-9]+-cn(-micoapi)?\\.json$'`);
const uids = [...new Set(listing.split("\n").map((f) => f.match(/^auth-(\d+)-cn/)?.[1]).filter(Boolean))];
if (uids.length === 0) {
  console.error("  ❌ 未找到 auth-*.json，可能 HA 未登录小米账号");
  process.exit(1);
}
console.log(`  发现账号: ${uids.join(", ")}`);

const uid = args.uid ?? uids[0];
const readJson = (file) => {
  try {
    const raw = ssh(`cat ${dir}/${file} 2>/dev/null`);
    const d = JSON.parse(raw);
    return d.data ?? d;
  } catch { return null; }
};

const micoapi = readJson(`auth-${uid}-cn-micoapi.json`);
const xiaomiio = readJson(`auth-${uid}-cn.json`);
if (!micoapi?.service_token && !xiaomiio?.service_token) {
  console.error("  ❌ 两份凭据都没有 service_token");
  process.exit(1);
}
console.log(`  micoapi : ${micoapi?.service_token ? "✅ 有 token" : "❌ 无"}`);
console.log(`  xiaomiio: ${xiaomiio?.service_token ? "✅ 有 token" : "❌ 无"}`);

// 组装 store（字段名按 vendor 的读取方式）
const toSegment = (src, sid) => src && src.service_token ? {
  userId: String(src.user_id ?? uid),
  sid,
  serviceToken: src.service_token,
  deviceId: src.device_id ?? "",
  // hardware / did 必须非空 —— vendor 的 getConversations 用 hardware 作查询
  // 参数，空值会被小米判 400（每 4 秒空转一次）。HA 的 auth 文件没有这两项，
  // 必须由 --did / --hardware 传入。
  hardware: args.hardware ?? "",
  did: args.did ?? "",
  device: { deviceId: src.device_id ?? "", hardware: args.hardware ?? "", did: args.did ?? "" },
  pass: { ssecurity: src.ssecurity ?? "", passToken: "" },
} : undefined;

const store = {};
const mina = toSegment(micoapi, "micoapi");
const miiot = toSegment(xiaomiio, "xiaomiio");
if (mina) store.mina = mina;
if (miiot) store.miiot = miiot;

const target = resolve(stateDir, "mi-store.json");
mkdirSync(dirname(target), { recursive: true });
// 合并进已有 store（保留 password 等本地字段）
let merged = store;
if (existsSync(target)) {
  try {
    const cur = JSON.parse(readFileSync(target, "utf8"));
    merged = {
      ...cur,
      ...Object.fromEntries(Object.entries(store).map(([k, v]) => [k, { ...(cur[k] ?? {}), ...v }])),
    };
  } catch { /* 坏了就用新的 */ }
}
writeFileSync(target, JSON.stringify(merged, null, 2));
console.log(`  ✅ 已写入 ${target}`);
console.log();
console.log("  注意：device.hardware / did 若为空，插件会在连接时用配置里的 did 补全。");
