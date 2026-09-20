/**
 * dsh-xiaoai 守护进程 —— 小米音箱 ↔ DSH 的全双工桥。
 *
 * 职责（只做传声筒，不做任何 AI 处理）：
 *   1. 轮询小米云，抓取你对音箱说的话
 *   2. POST 到 DSH 桥接 API (/api/session)，由 DSH（灵犀）处理
 *   3. 把回复用小米 TTS 念出来
 *
 * 依赖：DSH 桥接 API（本容器 127.0.0.1:3082，由 /api_server.js 提供）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XiaomiSpeaker } from "./src/xiaomi.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 配置：优先读 config.json，其次环境变量，最后默认值。 */
function loadConfig() {
  const defaults = {
    enabled: true,
    dshApi: process.env.DSH_API_URL || "http://127.0.0.1:3082/api/session",
    dshToken: process.env.DSH_API_TOKEN || "",
    userId: "",
    password: "",
    did: "",
    pollIntervalMs: 4000,
    replyTimeoutMs: 240_000,
    maxReplyChars: 400,
    /** 空数组 = 全部转发；否则只转发以这些词开头的话 */
    triggerKeywords: [],
    /** 跳过这些固定的唤醒/客套语 */
    ignorePatterns: ["^小爱同学$", "^在吗$", "^你好$"],
    /** 日志 */
    logFile: "/data/dsh/xiaoai.log",
  };
  const cfgPath = path.join(HERE, "config.json");
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    /* 无配置文件则用默认 */
  }
  return { ...defaults, ...fileCfg };
}

const cfg = loadConfig();
const logFile = cfg.logFile;
fs.mkdirSync(path.dirname(logFile), { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(`[xiaoai] ${msg}`);
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch {
    /* ignore */
  }
}

/** 调用 DSH 桥接 API，取回助手的文字回复。 */
async function askDsh(text, sessionId) {
  const body = { message: text };
  if (sessionId) body.session = sessionId;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.replyTimeoutMs);
  try {
    const res = await fetch(cfg.dshApi, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.dshToken ? { Authorization: `Bearer ${cfg.dshToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
    const data = JSON.parse(raw);
    return { text: String(data.text ?? "").trim(), sessionId: data.sessionId ?? sessionId };
  } finally {
    clearTimeout(timer);
  }
}

function shouldHandle(text) {
  if (!text) return false;
  for (const pat of cfg.ignorePatterns) {
    if (new RegExp(pat).test(text)) return false;
  }
  if (cfg.triggerKeywords.length === 0) return true;
  return cfg.triggerKeywords.some((k) => text.startsWith(k));
}

async function main() {
  log("启动中…");
  const speaker = new XiaomiSpeaker({
    userId: cfg.userId,
    password: cfg.password,
    did: cfg.did,
    logger: log,
  });
  await speaker.connect();

  let sessionId = null;
  let lastTime = 0;
  const seen = new Set();

  log("开始轮询语音…");
  for (;;) {
    try {
      const records = await speaker.fetchConversations(5);
      // records 新→旧；只处理比 lastTime 更新的
      const fresh = records.filter((r) => r.time && r.time > lastTime).reverse();

      for (const rec of fresh) {
        if (rec.time > lastTime) lastTime = rec.time;
        const key = `${rec.time}|${rec.query}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > 1000) seen.clear();

        if (!shouldHandle(rec.query)) continue;

        log(`🎤 ${rec.query}`);
        try {
          const r = await askDsh(rec.query, sessionId);
          sessionId = r.sessionId ?? sessionId;
          let reply = r.text || "我收到了，但没想出怎么回答";
          if (reply.length > cfg.maxReplyChars) {
            reply = reply.slice(0, cfg.maxReplyChars) + "……先说这么多";
          }
          log(`🔊 ${reply.slice(0, 120)}`);
          await speaker.say(reply);
        } catch (err) {
          log(`❌ 处理失败: ${err?.message ?? err}`);
          await speaker.say("灵犀处理出错了").catch(() => {});
        }
      }
    } catch (err) {
      log(`轮询出错: ${err?.message ?? err}`);
    }
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
}

main().catch((err) => {
  log(`💥 致命错误: ${err?.stack ?? err}`);
  process.exit(1);
});
