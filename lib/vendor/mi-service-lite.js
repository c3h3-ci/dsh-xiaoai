import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
// ── 零依赖改造（事故修复）──
// 原本这里是 `import axios from 'axios'` + `import * as pako from 'pako'`，
// 需要使用者先跑 npm install。台式DSH 正是因为漏装依赖导致
// 「Cannot find package 'axios'」→ 插件加载失败 → DSH 崩溃 → 重启风暴 73 次。
// 现改用内置适配层（Node fetch + zlib），插件从此零外部依赖，clone 即可运行。
import { createHttp, pako } from './zero-dep-adapter.js';

// src/utils/io.ts

// src/utils/json.ts
function jsonEncode(obj, options) {
  const { prettier } = options ?? {};
  try {
    return prettier ? JSON.stringify(obj, void 0, 4) : JSON.stringify(obj);
  } catch (error) {
    return void 0;
  }
}
function jsonDecode(json) {
  if (json == void 0) return void 0;
  try {
    return JSON.parse(json);
  } catch (error) {
    return void 0;
  }
}

// src/utils/io.ts
process.cwd();
process.env;
var readFile2 = (filePath, options) => {
  const dirname2 = path.dirname(filePath);
  if (!fs.existsSync(dirname2)) {
    return void 0;
  }
  return new Promise((resolve2) => {
    fs.readFile(filePath, options, (err, data) => {
      resolve2(err ? void 0 : data);
    });
  });
};
var writeFile2 = (filePath, data, options) => {
  const dirname2 = path.dirname(filePath);
  if (!fs.existsSync(dirname2)) {
    fs.mkdirSync(dirname2, { recursive: true });
  }
  return new Promise((resolve2) => {
    {
      fs.writeFile(filePath, data, options, (err) => {
        resolve2(err ? false : true);
      });
    }
  });
};
var readJSON = async (filePath) => jsonDecode(await readFile2(filePath, "utf8"));
var writeJSON = (filePath, content) => writeFile2(filePath, jsonEncode(content) ?? "", "utf8");
function md5(s) {
  return crypto.createHash("md5").update(s).digest("hex");
}
function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("base64");
}
function signNonce(ssecurity, nonce) {
  let m = crypto.createHash("sha256");
  m.update(ssecurity, "base64");
  m.update(nonce, "base64");
  return m.digest().toString("base64");
}
function uuid() {
  return crypto.randomUUID();
}
function randomNoice() {
  return Buffer.from(
    Array(12).fill(0).map(() => Math.floor(Math.random() * 256))
  ).toString("base64");
}

// src/utils/is.ts
function isNaN(e) {
  return Number.isNaN(e);
}
function isNullish(e) {
  return e === null || e === void 0;
}
function isNotNullish(e) {
  return !isNullish(e);
}
function isString(e) {
  return typeof e === "string";
}
function isArray(e) {
  return Array.isArray(e);
}
function isObject(e) {
  return typeof e === "object" && isNotNullish(e);
}
function isEmpty(e) {
  if ((e == null ? void 0 : e.size) ?? 0 > 0) return false;
  return isNaN(e) || isNullish(e) || isString(e) && (e.length < 1 || !/\S/.test(e)) || isArray(e) && e.length < 1 || isObject(e) && Object.keys(e).length < 1;
}
function isNotEmpty(e) {
  return !isEmpty(e);
}

// src/utils/debug.ts
var Debugger = {
  enableTrace: false
};

// src/utils/base.ts
var sleep = async (time) => new Promise((resolve2) => setTimeout(resolve2, time));
function clamp(n, min, max) {
  return Math.max(min, Math.min(n, max));
}

// src/utils/http.ts
var _baseConfig = {
  proxy: false,
  decompress: true,
  headers: {
    "Accept-Encoding": "gzip, deflate",
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 10; RMX2111 Build/QP1A.190711.020) APP/xiaomi.mico APPV/2004040 MK/Uk1YMjExMQ== PassportSDK/3.8.3 passport-ui/3.8.3"
  }
};
var _http = createHttp(_baseConfig);
_http.interceptors.response.use(
  (res) => {
    if (res.config.rawResponse) {
      return res;
    }
    return res.data;
  },
  async (err) => {
    var _a, _b, _c, _d, _e;
    const newResult = await tokenRefresher.refreshTokenAndRetry(err);
    if (newResult) {
      return newResult;
    }
    const error = ((_b = (_a = err.response) == null ? void 0 : _a.data) == null ? void 0 : _b.error) || ((_c = err.response) == null ? void 0 : _c.data);
    const request = {
      method: err.config.method,
      url: err.config.url,
      headers: jsonEncode(err.config.headers),
      data: jsonEncode({ body: err.config.data })
    };
    const response = !err.response ? void 0 : {
      url: err.config.url,
      status: err.response.status,
      headers: jsonEncode(err.response.headers),
      data: jsonEncode({ body: err.response.data })
    };
    return {
      isError: true,
      code: (error == null ? void 0 : error.code) || ((_d = err.response) == null ? void 0 : _d.status) || err.code || "\u672A\u77E5",
      message: (error == null ? void 0 : error.message) || ((_e = err.response) == null ? void 0 : _e.statusText) || err.message || "\u672A\u77E5",
      error: { request, response }
    };
  }
);
var HTTPClient = class _HTTPClient {
  // 默认 3 秒超时
  timeout = 3 * 1e3;
  async get(url, query, config) {
    if (config === void 0) {
      config = query;
      query = void 0;
    }
    return _http.get(
      _HTTPClient.buildURL(url, query),
      _HTTPClient.buildConfig(config)
    );
  }
  async post(url, data, config) {
    return _http.post(url, data, _HTTPClient.buildConfig(config));
  }
  static buildURL = (url, query) => {
    const _url = new URL(url);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (isNotEmpty(value)) {
        _url.searchParams.append(key, value.toString());
      }
    }
    return _url.href;
  };
  static buildConfig = (config) => {
    if (config == null ? void 0 : config.cookies) {
      config.headers = {
        ...config.headers,
        Cookie: Object.entries(config.cookies).map(
          ([key, value]) => `${key}=${value == null ? "" : value.toString()};`
        ).join(" ")
      };
    }
    if (config && !config.timeout) {
      config.timeout = Http.timeout;
    }
    return config;
  };
};
var Http = new HTTPClient();
var TokenRefresher = class {
  isRefreshing = false;
  /**
   * 自动刷新过期的凭证，并重新发送请求
   */
  async refreshTokenAndRetry(err, maxRetry = 3) {
    var _a, _b, _c, _d, _e;
    const isMina = (_b = (_a = err == null ? void 0 : err.config) == null ? void 0 : _a.url) == null ? void 0 : _b.includes("mina.mi.com");
    const isMIoT = (_d = (_c = err == null ? void 0 : err.config) == null ? void 0 : _c.url) == null ? void 0 : _d.includes("io.mi.com");
    if (!isMina && !isMIoT || ((_e = err.response) == null ? void 0 : _e.status) !== 401) {
      return;
    }
    if (this.isRefreshing) {
      return;
    }
    let result;
    this.isRefreshing = true;
    let newServiceAccount = void 0;
    for (let i = 0; i < maxRetry; i++) {
      if (Debugger.enableTrace) {
        console.log(`\u274C \u767B\u5F55\u51ED\u8BC1\u5DF2\u8FC7\u671F\uFF0C\u6B63\u5728\u5C1D\u8BD5\u5237\u65B0 Token ${i + 1}`);
      }
      newServiceAccount = await this.refreshToken(err);
      if (newServiceAccount) {
        result = await this.retry(err, newServiceAccount);
        break;
      }
      await sleep(3e3);
    }
    this.isRefreshing = false;
    if (!newServiceAccount) {
      console.error("\u274C \u5237\u65B0\u767B\u5F55\u51ED\u8BC1\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u8D26\u53F7\u5BC6\u7801\u662F\u5426\u4ECD\u7136\u6709\u6548\u3002");
    }
    return result;
  }
  /**
   * 刷新登录凭证并同步到本地
   */
  async refreshToken(err) {
    var _a, _b, _c;
    const isMina = (_b = (_a = err == null ? void 0 : err.config) == null ? void 0 : _a.url) == null ? void 0 : _b.includes("mina.mi.com");
    const account = (_c = await getMiService({ service: isMina ? "mina" : "miiot", relogin: true })) == null ? void 0 : _c.account;
    if (account && err.config.account) {
      for (const key in account) {
        err.config.account[key] = account[key];
      }
      err.config.setAccount(err.config.account);
    }
    return account;
  }
  /**
   * 重新请求
   */
  async retry(err, account) {
    const cookies = err.config.cookies ?? {};
    for (const key of ["serviceToken"]) {
      if (cookies[key] && account[key]) {
        cookies[key] = account[key];
      }
    }
    for (const key of ["deviceSNProfile"]) {
      if (cookies[key] && account.device[key]) {
        cookies[key] = account.device[key];
      }
    }
    return _http(HTTPClient.buildConfig(err.config));
  }
};
var tokenRefresher = new TokenRefresher();

// src/utils/rc4.ts
var RC4 = class {
  iii;
  jjj;
  bytes;
  constructor(buf) {
    this.bytes = new Uint8Array(256);
    const length = buf.length;
    for (let i = 0; i < 256; i++) {
      this.bytes[i] = i;
    }
    let i2 = 0;
    for (let i3 = 0; i3 < 256; i3++) {
      const i4 = i2 + buf[i3 % length];
      const b = this.bytes[i3];
      i2 = i4 + b & 255;
      this.bytes[i3] = this.bytes[i2];
      this.bytes[i2] = b;
    }
    this.iii = 0;
    this.jjj = 0;
  }
  update(buf) {
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      const i2 = this.iii + 1 & 255;
      this.iii = i2;
      const i3 = this.jjj;
      const arr = this.bytes;
      const b2 = arr[i2];
      const i4 = i3 + b2 & 255;
      this.jjj = i4;
      arr[i2] = arr[i4];
      arr[i4] = b2;
      buf[i] = b ^ arr[arr[i2] + b2 & 255];
    }
    return buf;
  }
};
function rc4Hash(method, uri, data, ssecurity) {
  var arrayList = [];
  if (method != null) {
    arrayList.push(method.toUpperCase());
  }
  if (uri != null) {
    arrayList.push(uri);
  }
  if (data != null) {
    for (var k in data) {
      arrayList.push(k + "=" + data[k]);
    }
  }
  arrayList.push(ssecurity);
  var sb = arrayList.join("&");
  return sha1(sb);
}
function parseAuthPass(res) {
  try {
    return jsonDecode(
      res.replace("&&&START&&&", "").replace(/:(\d{9,})/g, ':"$1"')
      // 把 userId 和 nonce 转成 string
    ) ?? {};
  } catch {
    return {};
  }
}
function encodeQuery(data) {
  return Object.entries(data).map(
    ([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value == null ? "" : value.toString())
  ).join("&");
}
function encodeMiIOT(method, uri, data, ssecurity) {
  let nonce = randomNoice();
  const snonce = signNonce(ssecurity, nonce);
  let key = Buffer.from(snonce, "base64");
  let rc4 = new RC4(key);
  rc4.update(Buffer.alloc(1024));
  let json = jsonEncode(data);
  let map = { data: json };
  map.rc4_hash__ = rc4Hash(method, uri, map, snonce);
  for (let k in map) {
    let v = map[k];
    map[k] = rc4.update(Buffer.from(v)).toString("base64");
  }
  map.signature = rc4Hash(method, uri, map, snonce);
  map._nonce = nonce;
  map.ssecurity = ssecurity;
  return map;
}
function decodeMiIOT(ssecurity, nonce, data, gzip) {
  let key = Buffer.from(signNonce(ssecurity, nonce), "base64");
  let rc4 = new RC4(key);
  rc4.update(Buffer.alloc(1024));
  let decrypted = rc4.update(Buffer.from(data, "base64"));
  let error = void 0;
  if (gzip) {
    try {
      decrypted = pako.ungzip(decrypted, { to: "string" });
    } catch (err) {
      error = err;
    }
  }
  const res = jsonDecode(decrypted.toString());
  if (!res) {
    console.error("\u274C decodeMiIOT failed", error);
  }
  return Promise.resolve(res);
}

// src/mi/common.ts
function updateMiAccount(account) {
  return (newAccount) => {
    for (const key in newAccount) {
      account[key] = newAccount[key];
    }
  };
}

// src/mi/mina.ts
var MiNA = class _MiNA {
  account;
  constructor(account) {
    this.account = account;
  }
  static async getDevice(account) {
    if (account.sid !== "micoapi") {
      return account;
    }
    const devices = await this.__callMina(
      account,
      "GET",
      "/admin/v2/device_list"
    );
    if (Debugger.enableTrace) {
      console.log(
        "\u{1F41B} MiNA \u8BBE\u5907\u5217\u8868: ",
        jsonEncode(devices, { prettier: true })
      );
    }
    const device = (devices ?? []).find(
      (e) => [e.deviceID, e.miotDID, e.name, e.alias].includes(account.did)
    );
    if (device) {
      account.device = { ...device, deviceId: device.deviceID };
    }
    return account;
  }
  static async __callMina(account, method, path2, data) {
    var _a, _b, _c, _d;
    data = {
      ...data,
      requestId: uuid(),
      timestamp: Math.floor(Date.now() / 1e3)
    };
    const url = "https://api2.mina.mi.com" + path2;
    const config = {
      account,
      setAccount: updateMiAccount(account),
      headers: { "User-Agent": "MICO/AndroidApp/@SHIP.TO.2A2FE0D7@/2.4.40" },
      cookies: {
        userId: account.userId,
        serviceToken: account.serviceToken,
        sn: (_a = account.device) == null ? void 0 : _a.serialNumber,
        hardware: (_b = account.device) == null ? void 0 : _b.hardware,
        deviceId: (_c = account.device) == null ? void 0 : _c.deviceId,
        deviceSNProfile: (_d = account.device) == null ? void 0 : _d.deviceSNProfile
      }
    };
    let res;
    if (method === "GET") {
      res = await Http.get(url, data, config);
    } else {
      res = await Http.post(url, encodeQuery(data), config);
    }
    if (res.code !== 0) {
      if (Debugger.enableTrace) {
        console.error("\u274C _callMina failed", res);
      }
      return void 0;
    }
    return res.data;
  }
  async _callMina(method, path2, data) {
    return _MiNA.__callMina(this.account, method, path2, data);
  }
  ubus(scope, command, message) {
    var _a;
    message = jsonEncode(message ?? {});
    return this._callMina("POST", "/remote/ubus", {
      deviceId: (_a = this.account.device) == null ? void 0 : _a.deviceId,
      path: scope,
      method: command,
      message
    });
  }
  getDevices() {
    return this._callMina("GET", "/admin/v2/device_list");
  }
  async getStatus() {
    const data = await this.ubus("mediaplayer", "player_get_play_status");
    const res = jsonDecode(data == null ? void 0 : data.info);
    if (!data || data.code !== 0 || !res) {
      return;
    }
    const map = { 0: "idle", 1: "playing", 2: "paused", 3: "stopped" };
    return {
      ...res,
      status: map[res.status] ?? "unknown",
      volume: res.volume
    };
  }
  async getVolume() {
    const data = await this.getStatus();
    return data == null ? void 0 : data.volume;
  }
  async setVolume(volume) {
    volume = Math.round(clamp(volume, 6, 100));
    const res = await this.ubus("mediaplayer", "player_set_volume", {
      volume
    });
    return (res == null ? void 0 : res.code) === 0;
  }
  async play(options) {
    let res;
    const { tts, url } = options ?? {};
    if (tts) {
      res = await this.ubus("mibrain", "text_to_speech", {
        text: tts,
        save: 0
      });
    } else if (url) {
      res = await this.ubus("mediaplayer", "player_play_url", {
        url,
        type: 1
      });
    } else {
      res = await this.ubus("mediaplayer", "player_play_operation", {
        action: "play"
      });
    }
    return (res == null ? void 0 : res.code) === 0;
  }
  async pause() {
    const res = await this.ubus("mediaplayer", "player_play_operation", {
      action: "pause"
    });
    return (res == null ? void 0 : res.code) === 0;
  }
  async playOrPause() {
    const res = await this.ubus("mediaplayer", "player_play_operation", {
      action: "toggle"
    });
    return (res == null ? void 0 : res.code) === 0;
  }
  async stop() {
    const res = await this.ubus("mediaplayer", "player_play_operation", {
      action: "stop"
    });
    return (res == null ? void 0 : res.code) === 0;
  }
  /**
   * 注意：
   * 只拉取用户主动请求，设备被动响应的消息，
   * 不包含设备主动回应用户的消息。
   *
   * - 从游标处由新到旧拉取
   * - 结果包含游标消息本身
   * - 消息列表从新到旧排序
   */
  async getConversations(options) {
    var _a, _b;
    const { limit = 10, timestamp } = options ?? {};
    const res = await Http.get(
      "https://userprofile.mina.mi.com/device_profile/v2/conversation",
      {
        limit,
        timestamp,
        requestId: uuid(),
        source: "dialogu",
        hardware: (_a = this.account.device) == null ? void 0 : _a.hardware
      },
      {
        account: this.account,
        setAccount: updateMiAccount(this.account),
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 10; 000; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.193 Mobile Safari/537.36 /XiaoMi/HybridView/ micoSoundboxApp/i appVersion/A_2.4.40",
          Referer: "https://userprofile.mina.mi.com/dialogue-note/index.html"
        },
        cookies: {
          userId: this.account.userId,
          serviceToken: this.account.serviceToken,
          deviceId: (_b = this.account.device) == null ? void 0 : _b.deviceId
        }
      }
    );
    if (res.code !== 0) {
      if (Debugger.enableTrace) {
        console.error("\u274C getConversations failed", res);
      }
      return void 0;
    }
    return jsonDecode(res.data);
  }
};

// src/mi/miot.ts
var MiIOT = class _MiIOT {
  account;
  constructor(account) {
    this.account = account;
  }
  static async getDevice(account) {
    if (account.sid !== "xiaomiio") {
      return account;
    }
    const devices = await this.__callMiIOT(
      account,
      "POST",
      "/home/device_list",
      {
        getVirtualModel: false,
        getHuamiDevices: 0
      }
    );
    if (Debugger.enableTrace) {
      console.log(
        "\u{1F41B} MiIOT \u8BBE\u5907\u5217\u8868: ",
        jsonEncode(devices, { prettier: true })
      );
    }
    const device = ((devices == null ? void 0 : devices.list) ?? []).find(
      (e) => [e.did, e.name].includes(account.did)
    );
    if (device) {
      account.device = device;
    }
    return account;
  }
  static async __callMiIOT(account, method, path2, _data) {
    var _a;
    const url = "https://api.io.mi.com/app" + path2;
    const config = {
      account,
      setAccount: updateMiAccount(account),
      rawResponse: true,
      validateStatus: () => true,
      headers: {
        "User-Agent": "MICO/AndroidApp/@SHIP.TO.2A2FE0D7@/2.4.40",
        "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
        "miot-accept-encoding": "GZIP",
        "miot-encrypt-algorithm": "ENCRYPT-RC4"
      },
      cookies: {
        countryCode: "CN",
        locale: "zh_CN",
        timezone: "GMT+08:00",
        timezone_id: "Asia/Shanghai",
        userId: account.userId,
        cUserId: (_a = account.pass) == null ? void 0 : _a.cUserId,
        PassportDeviceId: account.deviceId,
        serviceToken: account.serviceToken,
        yetAnotherServiceToken: account.serviceToken
      }
    };
    let res;
    const data = encodeMiIOT(method, path2, _data, account.pass.ssecurity);
    if (method === "GET") {
      res = await Http.get(url, data, config);
    } else {
      res = await Http.post(url, encodeQuery(data), config);
    }
    if (typeof res.data !== "string") {
      if (Debugger.enableTrace) {
        console.error("\u274C _callMiIOT failed", res);
      }
      return void 0;
    }
    res = await decodeMiIOT(
      account.pass.ssecurity,
      data._nonce,
      res.data,
      res.headers["miot-content-encoding"] === "GZIP"
    );
    return res == null ? void 0 : res.result;
  }
  async _callMiIOT(method, path2, data) {
    return _MiIOT.__callMiIOT(this.account, method, path2, data);
  }
  rpc(method, params, id = 1) {
    return this._callMiIOT("POST", "/home/rpc/" + this.account.device.did, {
      id,
      method,
      params
    });
  }
  /**
   * - datasource=1  优先从服务器缓存读取，没有读取到下发rpc；不能保证取到的一定是最新值
   * - datasource=2  直接下发rpc，每次都是设备返回的最新值
   * - datasource=3  直接读缓存；没有缓存的 code 是 -70xxxx；可能取不到值
   */
  _callMiotSpec(command, params, datasource = 2) {
    return this._callMiIOT("POST", "/miotspec/" + command, {
      params,
      datasource
    });
  }
  async getDevices(getVirtualModel = false, getHuamiDevices = 0) {
    const res = await this._callMiIOT("POST", "/home/device_list", {
      getVirtualModel,
      getHuamiDevices
    });
    return res == null ? void 0 : res.list;
  }
  async getProperty(scope, property) {
    var _a, _b;
    const res = await this._callMiotSpec("prop/get", [
      {
        did: this.account.device.did,
        siid: scope,
        piid: property
      }
    ]);
    return (_b = (_a = res ?? []) == null ? void 0 : _a[0]) == null ? void 0 : _b.value;
  }
  async setProperty(scope, property, value) {
    var _a, _b;
    const res = await this._callMiotSpec("prop/set", [
      {
        did: this.account.device.did,
        siid: scope,
        piid: property,
        value
      }
    ]);
    return ((_b = (_a = res ?? []) == null ? void 0 : _a[0]) == null ? void 0 : _b.code) === 0;
  }
  async doAction(scope, action, args = []) {
    const res = await this._callMiotSpec("action", {
      did: this.account.device.did,
      siid: scope,
      aiid: action,
      in: Array.isArray(args) ? args : [args]
    });
    return (res == null ? void 0 : res.code) === 0;
  }
};

// src/mi/account.ts
var kLoginAPI = "https://account.xiaomi.com/pass";
async function getAccount(account) {
  // ── PATCH: 复用已缓存的 serviceToken，跳过小米密码登录与风控 ──
  if (account.serviceToken && account.pass && account.pass.ssecurity) {
    console.log("[PATCH] 复用缓存的 serviceToken，跳过登录");
    // 补齐 sid / deviceId，否则下游 getDevice 会跳过、API 报 601
    if (!account.sid) account.sid = "micoapi";
    if (!account.deviceId) account.deviceId = "android_" + uuid();
    // 绑定音箱设备（MiNA 用 device.hardware；MiIOT 用 device.did）
    if (!account.device) {
      try {
        if (account.sid === "micoapi") {
          const filled = await MiNA.getDevice(account);
          if (filled?.device) account = filled;
        } else {
          const filled = await MiIOT.getDevice(account);
          if (filled?.device) account = filled;
        }
      } catch (err) {
        console.error("[PATCH] getDevice 失败:", err?.message ?? err);
      }
    }
    return account;
  }
  let res = await Http.get(
    `${kLoginAPI}/serviceLogin`,
    { sid: account.sid, _json: true, _locale: "zh_CN" },
    { cookies: _getLoginCookies(account) }
  );
  if (res.isError) {
    console.error("\u274C \u767B\u5F55\u5931\u8D25", res);
    return void 0;
  }
  let pass = parseAuthPass(res);
  if (pass.code !== 0) {
    let data = {
      _json: "true",
      qs: pass.qs,
      sid: account.sid,
      _sign: pass._sign,
      callback: pass.callback,
      user: account.userId,
      hash: md5(account.password).toUpperCase()
    };
    res = await Http.post(`${kLoginAPI}/serviceLoginAuth2`, encodeQuery(data), {
      cookies: _getLoginCookies(account)
    });
    if (res.isError) {
      console.error("\u274C OAuth2 \u767B\u5F55\u5931\u8D25", res);
      return void 0;
    }
    pass = parseAuthPass(res);
  }
  if (!pass.location || !pass.nonce || !pass.passToken) {
    if (pass.notificationUrl || pass.captchaUrl) {
      console.log(
        "\u{1F525} \u89E6\u53D1\u5C0F\u7C73\u8D26\u53F7\u5F02\u5730\u767B\u5F55\u5B89\u5168\u9A8C\u8BC1\u673A\u5236\uFF0C\u8BF7\u5728\u6D4F\u89C8\u5668\u6253\u5F00\u4EE5\u4E0B\u94FE\u63A5\uFF0C\u5E76\u6309\u7167\u7F51\u9875\u63D0\u793A\u6388\u6743\u9A8C\u8BC1\u8D26\u53F7\uFF1A"
      );
      console.log("\u{1F449} " + pass.notificationUrl || pass.captchaUrl);
      console.log(
        "\u{1F41B} \u6CE8\u610F\uFF1A\u6388\u6743\u6210\u529F\u540E\uFF0C\u5927\u7EA6\u9700\u8981\u7B49\u5F85 1 \u4E2A\u5C0F\u65F6\u5DE6\u53F3\u8D26\u53F7\u4FE1\u606F\u624D\u4F1A\u66F4\u65B0\uFF0C\u8BF7\u5728\u66F4\u65B0\u540E\u518D\u5C1D\u8BD5\u91CD\u65B0\u767B\u5F55\u3002"
      );
    }
    console.error("\u274C \u5C0F\u7C73\u8D26\u53F7\u767B\u5F55\u5931\u8D25", res);
    return void 0;
  }
  const serviceToken = await _getServiceToken(pass);
  if (!serviceToken) {
    return void 0;
  }
  account = { ...account, pass, serviceToken };
  if (Debugger.enableTrace) {
    console.log("\u{1F41B} \u5C0F\u7C73\u8D26\u53F7: ", jsonEncode(account, { prettier: true }));
  }
  account = await MiNA.getDevice(account);
  if (Debugger.enableTrace) {
    console.log("\u{1F41B} MiNA \u8D26\u53F7: ", jsonEncode(account, { prettier: true }));
  }
  account = await MiIOT.getDevice(account);
  if (Debugger.enableTrace) {
    console.log("\u{1F41B} MiIOT \u8D26\u53F7: ", jsonEncode(account, { prettier: true }));
  }
  if (account.did && !account.device) {
    console.error("\u274C \u627E\u4E0D\u5230\u8BBE\u5907\uFF1A" + account.did);
    console.log(
      "\u{1F41B} \u8BF7\u68C0\u67E5\u4F60\u7684 did \u4E0E\u7C73\u5BB6\u4E2D\u7684\u8BBE\u5907\u540D\u79F0\u662F\u5426\u4E00\u81F4\u3002\u6CE8\u610F\u9519\u522B\u5B57\u3001\u7A7A\u683C\u548C\u5927\u5C0F\u5199\uFF0C\u6BD4\u5982\uFF1A\u97F3\u54CD \u{1F449} \u97F3\u7BB1"
    );
    return void 0;
  }
  return account;
}
function _getLoginCookies(account) {
  var _a;
  return {
    userId: account.userId,
    deviceId: account.deviceId,
    passToken: (_a = account.pass) == null ? void 0 : _a.passToken
  };
}
async function _getServiceToken(pass) {
  var _a;
  const { location, nonce, ssecurity } = pass ?? {};
  const res = await Http.get(
    location,
    {
      _userIdNeedEncrypt: true,
      clientSign: sha1(`nonce=${nonce}&${ssecurity}`)
    },
    { rawResponse: true }
  );
  let cookies = ((_a = res.headers) == null ? void 0 : _a["set-cookie"]) ?? [];
  for (let cookie of cookies) {
    if (cookie.includes("serviceToken")) {
      return cookie.split(";")[0].replace("serviceToken=", "");
    }
  }
  console.error("\u274C \u83B7\u53D6 Mi Service Token \u5931\u8D25", res);
  return void 0;
}

// src/mi/index.ts
// ── PATCH: 让凭据缓存路径可被环境变量覆盖 ──
// 原实现是相对路径 ".mi.json"，靠 process.cwd() 解析。作为 DSH 插件运行时，
// cwd 是 DSH 的工作区（/data/dsh/workspace）而不是插件目录，导致读不到凭据、
// 报「小米登录失败」。这里允许 XIAOAI_MI_STORE 指定绝对路径。
var kConfigFile = process.env.XIAOAI_MI_STORE || ".mi.json";
async function getMiService(config) {
  var _a;
  // ── PATCH: 支持 storeOverride，消除多设备并发写竞态 ──
  //
  // 背景：多音箱时每台设备各建一个 MiIOT 连接，各自调本函数。
  // 而「读 store → 异步登录（含网络往返/风控重试，窗口极宽）→ 写回
  // 全局 kConfigFile」之间存在竞态：并发时后写的会把先写的
  // store[service].device 冲掉 —— 结果是 **A 的命令发到 B 的音箱**。
  //
  // 修法：允许调用方注入一份【自己独占的 store 副本】。注入时既不读也不写
  // 全局文件，竞态从根上消失，也不需要把连接串行化。
  //
  // ⚠️ 调用方必须传 structuredClone 出来的独立副本。若图省事把同一个对象
  //    引用传给 N 个设备，`store[service] = account` 仍会在内存里互相覆盖 ——
  //    竞态只是从文件搬到了内存，破坏力完全相同。
  //
  // ✅ 向后兼容：不传 storeOverride 时代码路径与打补丁前【逐字节等价】
  //    （读全局文件、写全局文件，行为完全不变）。
  const { service, userId, password, did, relogin, storeOverride } = config;
  const overrides = relogin ? {} : { did, userId, password };
  const randomDeviceId = "android_" + uuid();
  const store = storeOverride ?? ((await readJSON(kConfigFile)) ?? {});
  let account = {
    deviceId: randomDeviceId,
    ...store[service],
    ...overrides,
    sid: service === "miiot" ? "xiaomiio" : "micoapi"
  };
  if (!account.userId || !account.password) {
    console.error("\u274C \u6CA1\u6709\u627E\u5230\u8D26\u53F7\u6216\u5BC6\u7801\uFF0C\u8BF7\u68C0\u67E5\u662F\u5426\u5DF2\u914D\u7F6E\u76F8\u5173\u53C2\u6570\uFF1AuserId, password");
    return;
  }
  account = await getAccount(account);
  if (!(account == null ? void 0 : account.serviceToken) || !((_a = account.pass) == null ? void 0 : _a.ssecurity)) {
    return void 0;
  }
  store[service] = account;
  // ── PATCH: 支持 storeOverride（续）—— 注入 store 时不写全局文件 ──
  // 否则注入的副本仍会把 account 落盘，等于没消除竞态。
  if (!storeOverride) {
    await writeJSON(kConfigFile, store);
  }
  return service === "miiot" ? new MiIOT(account) : new MiNA(account);
}

// src/index.ts
async function getMiIOT(config) {
  Debugger.enableTrace = config.enableTrace;
  Http.timeout = config.timeout ?? Http.timeout;
  return getMiService({ service: "miiot", ...config });
}
async function getMiNA(config) {
  Debugger.enableTrace = config.enableTrace;
  Http.timeout = config.timeout ?? Http.timeout;
  return getMiService({ service: "mina", ...config });
}

export { MiIOT, MiNA, getMiIOT, getMiNA };
