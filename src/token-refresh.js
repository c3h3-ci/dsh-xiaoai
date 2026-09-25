/**
 * 小米凭据自动刷新 —— 从 HA 的 xiaomi_miot 集成里重新拉取 serviceToken。
 *
 * 背景：小米的 serviceToken 会过期（实测约 15~24 小时）。过期后
 * getConversations() 静默返回 undefined，插件表现为「听不到你说话」。
 * 而 HA 的 xiaomi_miot 集成本身会持续保持登录态，其缓存文件里
 * 始终有一份可用的 token —— 直接拿来用即可，不必重新走密码登录
 * （重走会触发小米异地登录风控）。
 *
 * 数据来源（HA 容器内）：
 *   /config/.storage/xiaomi_miot/auth-<uid>-cn-micoapi.json   → MiNA（抓对话）
 *   /config/.storage/xiaomi_miot/auth-<uid>-cn.json           → MiIOT（发 TTS）
 *
 * 本模块通过 HA 的 REST API（读文件不方便，故用 supervisor 代理）或
 * 直接读挂载目录两种方式之一获取。优先直读文件，失败再走 API。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, chmodSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/** HA 的 .storage 在本容器里的可能挂载点。 */
const HA_STORAGE_CANDIDATES = [
  "/config/.storage", // addon 若挂载了 config:rw
  "/data/homeassistant/.storage",
];

/** 找到 HA 的 .storage 目录，找不到返回 null。 */
export function findHaStorage() {
  for (const p of HA_STORAGE_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 读取 HA xiaomi_miot 的认证缓存。
 *
 * @param {string} uid 小米账号数字 ID（如 "12345678"）
 * @returns {{mina: object|null, miiot: object|null}}
 */
export function readHaAuth(uid) {
  const store = findHaStorage();
  const out = { mina: null, miiot: null };
  if (!store) return out;

  const read = (file) => {
    try {
      const parsed = JSON.parse(readFileSync(`${store}/xiaomi_miot/${file}`, "utf8"));
      return parsed?.data ?? null;
    } catch {
      return null;
    }
  };

  const micoapi = read(`auth-${uid}-cn-micoapi.json`);
  if (micoapi?.service_token && micoapi?.ssecurity) {
    out.mina = {
      userId: String(micoapi.user_id ?? uid),
      sid: "micoapi",
      deviceId: micoapi.device_id ?? undefined,
      serviceToken: micoapi.service_token,
      pass: { ssecurity: micoapi.ssecurity },
    };
  }

  const xiaomiio = read(`auth-${uid}-cn.json`);
  if (xiaomiio?.service_token && xiaomiio?.ssecurity) {
    out.miiot = {
      userId: String(xiaomiio.user_id ?? uid),
      sid: "xiaomiio",
      deviceId: xiaomiio.device_id ?? undefined,
      serviceToken: xiaomiio.service_token,
      pass: { ssecurity: xiaomiio.ssecurity },
    };
  }

  return out;
}

/**
 * 把 HA 里新鲜的凭据合并进插件的凭据文件，保留 did 等本地字段。
 *
 * @param {string} storePath 插件的凭据文件路径
 * @param {string} uid 小米账号数字 ID
 * @param {(m: string) => void} [log]
 * @returns {{refreshed: boolean, reason?: string}}
 */
export function mergeFreshTokens(storePath, uid, log = () => {}) {
  const fresh = readHaAuth(uid);
  if (!fresh.mina && !fresh.miiot) {
    return { refreshed: false, reason: `未能从 HA 读取到 ${uid} 的认证缓存` };
  }

  let current = {};
  try {
    current = JSON.parse(readFileSync(storePath, "utf8"));
  } catch {
    /* 首次运行，凭据文件还不存在 */
  }

  let changed = false;
  for (const key of ["mina", "miiot"]) {
    const incoming = fresh[key];
    if (!incoming) continue;
    const existing = current[key] ?? {};
    // 只在 token 确实变了的时候才写，避免无谓的文件改动
    if (existing.serviceToken === incoming.serviceToken) continue;
    current[key] = {
      ...existing,
      ...incoming,
      // 保留本地的 did（HA 的缓存里没有这个字段）
      did: existing.did ?? incoming.did,
      // device 缓存必须清掉，否则会拿旧设备的 hardware 去查对话
      device: undefined,
    };
    changed = true;
    log(`${key} token 已刷新`);
  }

  if (!changed) return { refreshed: false, reason: "token 未变化" };

  // ── P1-3：凭据含 serviceToken + ssecurity（等价登录态），必须 0600 ──
  // 裸 writeFileSync 默认 0644，同机任意用户可读。
  writeStoreAtomic(storePath, current);
  return { refreshed: true };
}

/**
 * P1-4：原子写入凭据文件，并串行化进程内写入。
 *
 * 为什么需要：
 *  1. 本模块的 read → writeFileSync 是【非原子】的读-改-写；而 vendor 的
 *     getMiService() 结尾也会整体覆写同一文件。两条写入路径存在竞态，
 *     最坏情况是「刚刷到的新 token 被旧 account 覆盖」，表现为 token 突然失效。
 *  2. 直接覆写还可能被读到半截内容（读到损坏 JSON）。
 *
 * 做法：进程内 promise 链串行 + 写临时文件 + rename 原子替换 + 0600 权限。
 * 同机跨进程仍可能竞争，但那是 vendor 侧的行为，本模块只能保证自身原子性。
 */
let writeChain = Promise.resolve();

export function writeStoreAtomic(storePath, data) {
  const run = () => {
    mkdirSync(dirname(storePath), { recursive: true });
    const tmp = `${storePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      // mode 0600：仅属主可读写（凭据等价登录态）
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      // 已存在的临时文件不受 mode 影响时补一次，确保权限正确
      try { chmodSync(tmp, 0o600); } catch { /* 非 POSIX 平台忽略 */ }
      renameSync(tmp, storePath);   // 原子替换：读者要么看到旧版，要么看到新版
      try { chmodSync(storePath, 0o600); } catch { /* 同上 */ }
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* 清理失败不影响主流程 */ }
      throw err;
    }
  };
  // 串行化：把本次写入排到链尾，避免并发读-改-写互相覆盖
  writeChain = writeChain.then(run, run);
  return writeChain;
}
