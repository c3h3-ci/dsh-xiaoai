/**
 * 零依赖适配层 —— 替代 axios 与 pako，让 mi-service-lite 不再需要 npm install。
 *
 * 为什么需要它（事故背景）：
 *   台式DSH 从 GitHub clone 源码后没跑 npm install，于是
 *   `vendor/mi-service-lite.js` 的 `import axios` 失败 →
 *   插件加载抛错 → DSH 整个 plugin tree 失败 → 进程退出 →
 *   systemd 每 5 秒重启一次，连崩 73 次，表现为「整机死机」。
 *
 *   只要插件依赖任何外部包，就存在「使用者忘了装依赖 → 宿主崩溃」这个风险。
 *   因此这里用 Node 内置能力（fetch / zlib / URL）把两个依赖彻底去掉。
 *
 * 兼容面（严格按 mi-service-lite 的实际用法实现，不追求 axios 全功能）：
 *   - axios.create({headers}) → 返回 http 实例
 *   - http.get(url, config) / http.post(url, data, config) / http(config)
 *   - http.interceptors.response.use(onFulfilled, onRejected)
 *   - 响应对象形状：{ status, statusText, headers, data, config, request }
 *     （对应 axios 的 res；调用方读 res.status / res.data / res.config）
 *   - 失败时抛出带 .config / .response / .isAxiosError 的 Error
 *     （TokenRefresher 依赖 err.config.url 与 err.response.status）
 *   - config.proxy === false（我们不用代理）
 *   - config.decompress === true（用 zlib 自动解 gzip/deflate/br）
 *   - config.rawResponse：拦截器里据此决定返回整个 res 还是 res.data
 *   - config.timeout / config.signal
 *   - pako.ungzip(buf, { to: "string" })
 */

import zlib from "node:zlib";

// ───────────────────────── HTTP（替代 axios） ─────────────────────────

/** 把 headers 对象规范化成普通小写键的 Map，便于大小写不敏感查询。 */
function normalizeHeaders(raw) {
  const out = new Map();
  if (!raw) return out;
  const entries =
    typeof raw.entries === "function" ? [...raw.entries()] : Object.entries(raw);
  for (const [k, v] of entries) out.set(String(k).toLowerCase(), String(v));
  return out;
}

/** 按响应头自动解压；解压失败时原样返回（有些接口压根没压）。 */
async function readBody(res, decompress) {
  const buf = Buffer.from(await res.arrayBuffer());
  if (!decompress) return buf;

  const enc = (res.headers.get("content-encoding") ?? "").toLowerCase();
  try {
    if (enc.includes("gzip")) return zlib.gunzipSync(buf);
    if (enc.includes("deflate")) return zlib.inflateSync(buf);
    if (enc.includes("br")) return zlib.brotliDecompressSync(buf);
    // 有些服务端不声明 encoding 但内容确实是 gzip（magic: 1f 8b）
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
  } catch {
    /* 解压失败就用原始字节 */
  }
  return buf;
}

/** 构造一个具备 axios 子集语义的 http 实例。 */
export function createHttp(baseConfig = {}) {
  // 响应拦截器（mi-service-lite 用它做「自动解包 res.data」与「401 重试」）
  const fulfilled = [];
  const rejected = [];

  const instance = async function request(config) {
    const cfg = {
      ...baseConfig,
      ...config,
      headers: { ...(baseConfig.headers ?? {}), ...(config?.headers ?? {}) },
    };
    if (!cfg.url) throw new Error("http: config.url 是必需的");

    const decompress = cfg.decompress !== false;
    const ctrl = new AbortController();
    const timer = cfg.timeout ? setTimeout(() => ctrl.abort(), cfg.timeout) : null;
    // 调用方传入的 signal 与本地的超时 signal 任一触发都中断
    if (cfg.signal) {
      if (cfg.signal.aborted) ctrl.abort();
      else cfg.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }

    let res;
    try {
      res = await fetch(cfg.url, {
        method: (cfg.method ?? "GET").toUpperCase(),
        headers: cfg.headers,
        body: cfg.data === undefined ? undefined : cfg.data,
        signal: ctrl.signal,
        redirect: "follow",
      });
    } catch (err) {
      // 网络层失败：抛错并挂上 config（TokenRefresher 会读 err.config.url）
      const e = new Error(err?.message ?? String(err));
      e.config = cfg;
      e.isAxiosError = true;
      e.code = err?.name === "AbortError" ? "ECONNABORTED" : (err?.code ?? "ERR_NETWORK");
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }

    const text = (await readBody(res, decompress)).toString("utf8");
    // mi-service-lite 的所有接口都是 JSON；解析不了就交原文
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* 保持字符串 */
    }

    const axiosRes = {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(normalizeHeaders(res.headers)),
      data,
      config: cfg,
      request: { url: cfg.url, method: cfg.method ?? "GET" },
    };

    // 非 2xx：抛错（保留 http 语义，TokenRefresher 靠 status===401 判断）
    if (res.status < 200 || res.status >= 300) {
      const e = new Error(`Request failed with status code ${res.status}`);
      e.config = cfg;
      e.response = axiosRes;
      e.isAxiosError = true;
      e.code = `ERR_BAD_STATUS_${res.status}`;
      throw e;
    }

    // 跑响应拦截器的 fulfilled 链（mi-service-lite 在这里做 res.data 解包）
    let out = axiosRes;
    for (const fn of fulfilled) out = await fn(out);
    return out;
  };

  instance.create = (extra) => createHttp({ ...baseConfig, ...extra });
  instance.get = (url, config) => instance({ ...(config ?? {}), url, method: "GET" });
  instance.post = (url, data, config) =>
    instance({ ...(config ?? {}), url, method: "POST", data });
  instance.interceptors = {
    response: {
      use: (onOk, onErr) => {
        if (typeof onOk === "function") fulfilled.push(onOk);
        if (typeof onErr === "function") rejected.push(onErr);
        return fulfilled.length - 1;
      },
    },
  };
  /** 供 TokenRefresher 的「重发原请求」使用。 */
  instance.retry = (cfg) => instance(cfg);
  return instance;
}

/** 默认导出：与 `import axios from "axios"` 等价（axios 本身也是可调用对象）。 */
const axiosLike = createHttp();
axiosLike.default = axiosLike;
export default axiosLike;
export const axios = axiosLike;

// ───────────────────────── 压缩（替代 pako） ─────────────────────────

/**
 * pako.ungzip 的最小替代。
 *
 * mi-service-lite 只用了 `pako.ungzip(buf, { to: "string" })` 一处 ——
 * Node 内置 zlib 完全够用，没必要为此带上整个 pako。
 */
export const pako = {
  ungzip(buf, options = {}) {
    const out = zlib.gunzipSync(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    return options.to === "string" ? out.toString("utf8") : out;
  },
  gzip(buf) {
    return zlib.gzipSync(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  },
};

export const ungzip = pako.ungzip;
export const gzip = pako.gzip;
