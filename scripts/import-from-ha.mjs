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
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    // boolean flag：下一个是另一个 --flag，或没有下一个（末尾）
    // ⚠️ 原实现用 `argv[i+1]?.startsWith("--") ? true : argv[++i]`，
    //    在【末尾 boolean flag】时会走 else 分支把 undefined 赋进去 ——
    //    导致 `--auto-detect-uuid` 放在命令最后时【静默失效】。
    if (next === undefined || next.startsWith("--")) {
      out[a.slice(2)] = true;
    } else {
      out[a.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const host = args.host;
const user = args.user ?? "root";
const password = args.password;
const stateDir = resolve((args["state-dir"] ?? `${homedir()}/.dsh/xiaoai-state`).replace(/^~/, homedir()));

if (!host || !password) {
  console.error(
    "用法: node scripts/import-from-ha.mjs --host <ip> --user <u> --password <p> [--state-dir <dir>] [--did <did>] [--hardware <型号>] [--device-uuid <设备UUID>]\n" +
      "\n" +
      "⚠️ --device-uuid 强烈建议提供（或用 --auto-detect-uuid 自动探测）。\n" +
      "   小米的对话接口要求 cookie 里的 deviceId 是【设备 UUID】（cbf60488-c95d-...），\n" +
      "   而 HA auth 文件里的 device_id 是【账号级 ID】（DEVICE_ID_PLACEHOLDER）。\n" +
      "   传错会【静默失败】：接口返回 Success 但 records 永远为空。",
  );
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
//
// ⚠️⚠️ 关键：deviceId 必须用【设备 UUID】，不能用 HA auth 文件里的 device_id ⚠️⚠️
//
// HA 的 auth-<uid>-cn*.json 里的 `device_id` 是【MiNA 账号级 ID】
// （形如 DEVICE_ID_PLACEHOLDER），而小米的
//   userprofile.mina.mi.com/device_profile/v2/conversation
// 接口要求 cookie 里的 deviceId 是【设备 UUID】（形如 cbf60488-c95d-...）。
//
// 传错时接口照样返回 `code: 0, message: "Success"`，但 `records` 永远为空 ——
// 一个【静默失败】：插件看起来一切正常（连接成功、无错误），
// 却永远捕获不到任何语音。本项目在这个坑上花了整整一天。
//
// 设备 UUID 从 device_list 接口取（onboarding.discoverSpeakers 内部就用它）：
//   GET https://api2.mina.mi.com/admin/v2/device_list
//   → data[].deviceID
//
// 因此这里给 --device-uuid 参数，并用模块级的 DEVICE_UUID 变量；
// 未提供时【保留旧值】而不是写账号级 ID。
const HA_DEVICE_ID_IS_ACCOUNT_LEVEL = src => {
  // 账号级 ID 的特征：无连字符的 16 位大写十六进制
  return /^[0-9A-F]{16}$/.test(String(src ?? ""));
};

// ⚠️ 只有 mina（micoapi）需要设备 UUID —— 它拉对话记录。
//    miiot（xiaomiio）的 deviceId 是 MiIOT 侧标识（形如 SVXF0M6WA8Z9QCBP），
//    用于 doAction/TTS 定目标，【不能】被对话用的 UUID 覆盖。
//    这里对 sid === "micoapi" 才写 args.deviceUuid；xiaomiio 段保留空值，
//    由插件在连接时按 did 反查（见 runtime 的设备解析逻辑）。
const toSegment = (src, sid) => src && src.service_token ? {
  userId: String(src.user_id ?? uid),
  sid,
  serviceToken: src.service_token,
  // ⚠️ 只有 micoapi 用设备 UUID；xiaomiio 的 deviceId 由插件反查。
  deviceId: sid === "micoapi" ? (args.deviceUuid ?? "") : "",
  // hardware / did 必须非空 —— vendor 的 getConversations 用 hardware 作查询
  // 参数，空值会被小米判 400（每 4 秒空转一次）。HA 的 auth 文件没有这两项，
  // 必须由 --did / --hardware 传入。
  hardware: args.hardware ?? "",
  did: args.did ?? "",
  device: {
    // 设备 UUID（对话接口要的）
    deviceId: args.deviceUuid ?? "",
    deviceID: args.deviceUuid ?? "",
    // 账号级 ID 单独存，仅供排查参考
    accountDeviceId: src.device_id ?? "",
    hardware: args.hardware ?? "",
    did: args.did ?? "",
  },
  pass: { ssecurity: src.ssecurity ?? "", passToken: "" },
} : undefined;

// ── 解析设备 UUID（对话接口必需）──
//
// 优先级：
//   1. --device-uuid 显式传入
//   2. --auto-detect-uuid：从 device_list 接口自动取（推荐）
//   3. 已有 mi-store.json 里的 device.deviceId（若看起来是 UUID）
let deviceUuid = args.deviceUuid ? String(args.deviceUuid).trim() : "";

if (!deviceUuid && args["auto-detect-uuid"]) {
  try {
    const token = (micoapi?.service_token ?? xiaomiio?.service_token ?? "");
    const uidS = String(micoapi?.user_id ?? uid);
    const st = String(micoapi?.device_id ?? "");
    console.log("  自动探测设备 UUID（device_list）…");
    const out = execFileSync("curl", [
      "-s", "--noproxy", "*", "-m", "20",
      "https://api2.mina.mi.com/admin/v2/device_list?master=0&requestId=" + Date.now(),
      "-H", `Cookie: userId=${uidS}; serviceToken=${token}; deviceId=${st}`,
    ], { encoding: "utf8", timeout: 30000 });
    const j = JSON.parse(out);
    const list = Array.isArray(j?.data) ? j.data : [];
    // 优先匹配 --did 指定的那台
    const want = args.did ? list.find((x) => String(x.miotDID) === String(args.did)) : null;
    const pick = want ?? list[0];
    if (pick?.deviceID) {
      deviceUuid = String(pick.deviceID);
      console.log(`  ✅ 设备 UUID: ${deviceUuid}（${pick.name ?? ""}）`);
    }
  } catch (e) {
    console.warn(`  ⚠️ 自动探测失败: ${String(e?.message ?? e).slice(0, 80)}`);
  }
}

if (!deviceUuid) {
  // 保留已有文件里的值（避免把修好的 UUID 覆盖成空）
  try {
    const prev = JSON.parse(readFileSync(resolve(stateDir, "mi-store.json"), "utf8"));
    const pv = prev?.mina?.device?.deviceId ?? "";
    if (pv && !/^[0-9A-F]{16}$/.test(pv)) {
      deviceUuid = pv;
      console.log(`  ℹ️ 沿用已有 mi-store.json 的设备 UUID: ${deviceUuid}`);
    }
  } catch { /* 首次导入，无旧文件 */ }
}

if (!deviceUuid) {
  console.warn(
    "  ⚠️⚠️ 未提供设备 UUID（--device-uuid 或 --auto-detect-uuid）！\n" +
      "     对话记录接口会静默返回空 —— 插件能连上但永远听不到语音。\n" +
      "     建议加 --auto-detect-uuid 重新导入。",
  );
}
args.deviceUuid = deviceUuid;

// ⚠️ store 必须在 UUID 解析【之后】构造 —— toSegment 读的是 args.deviceUuid。
// （曾经把它放在前面，导致自动探测到的 UUID 写不进去。）
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
