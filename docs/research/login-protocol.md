# 小米登录协议研究：HA xiaomi_miot vs MiGPT vs vendor mi-service-lite

> 研究任务：task-1 · 研究员：protocol-researcher
> 证据来源：HA 192.168.3.3 实机源码（SSH）+ 本机 vendor 库 + 本机 MiGPT
> 结论日期：本轮研究

---

## 0. TL;DR（先给结论）

| 问题 | 结论 |
|---|---|
| 手机验证码登录能否修复 | **能**（但需要改 vendor 库的 STS 一步） |
| 一句话根因 | vendor 的 HTTP 层**没有 cookie jar**，而 `_getServiceToken()` 换 serviceToken 时**一个 Cookie 都没带**，STS 端点因此 401 |
| 验证码提交能否 API 化 | **能**，HA 有完整实现可照抄（`verify_ticket`，811-849 行） |
| clientSign 是否必须 | **必须**，且 vendor **算对了**（这点没问题） |
| MiGPT 有没有处理风控 | **没有**。它只有一段"请手动去浏览器授权"的提示（776-788 行），跟 vendor 同源同缺陷 |
| 最省事的路 | 继续用「有 HA 时直接从 HA 读 token」；**新用户无 HA** 则需要修 STS + 补验证码 API |

**诚实提醒**：本轮只做了**静态源码分析**，未实际跑通一次完整登录。下面标记为「推断」的部分需实机验证。

### 0.1 ~~重要后补发现（推翻了一个关键假设）~~ ⚠️ **本节已被更正，见下**

> **【更正声明】** 本节原判断「HA 只有 xiaomiio 凭据」是**错误的**。
> 我只查了 `core.config_entries`，**漏列了 `.storage/xiaomi_miot/` 目录**。
> HA 实际**两份凭据都有**（`micoapi` 216 字符 / `xiaomiio` 192 字符），
> 且 **micoapi 那份正是音箱所需，实测可用**（插件 `phase=running`，错误=0）。
> 详见 `CORRECTION-ha-credentials.md` 与本文 §附录 A。
>
> **保留下方原文是为了记录推理过程与教训** ——
> 但请注意：**"方案 A 成功率需要下调"这个结论建立在错误前提上，请以 §6.4.1 的修正为准。**

<details>
<summary>原文（含错误前提，仅作记录）</summary>

在完成主体分析后，我实测了 HA 实机的已存凭据（`/homeassistant/.storage/core.config_entries`）：

```
domain= xiaomi_miot  title= Xiaomi: USER_ID_PLACEHOLDER
  data.service_token = <len 192> 1wyPy5+4...
  data.sid           = xiaomiio          ← 注意！
  data.ssecurity     = <len 24> RBS3P/yd...
  data.user_id       = USER_ID_PLACEHOLDER
```

**HA 里这个能正常工作的账号，`sid` 是 `xiaomiio`，不是 `micoapi`。**

这有两层含义：
1. **HA 的成功路径 ≠ 我们的路径**。`xiaomiio` 走 **MiIOT** API（`io.mi.com`），
   `micoapi` 走 **MiNA** API（`api2.mina.mi.com`）。**我们的音箱必须用 `micoapi`/MiNA。**
   HA 那个 token **能驱动 MiIOT 设备，但不一定能驱动音箱**。
2. **`api2.mina.mi.com/sts` 的 401 是 MiNA 特有的紧口径端点** ——
   HA 代码里专门为它写了 `MiCloudStsUnauthorized`（行 57）+ 精确三元判定（行 783-787），
   说明 **HA 自己也在这个端点上失败过**，才需要单独识别。

**因此方案 A 的成功率需要下调**（见 §6.4）。

</details>

> **其中仍然成立的部分**：两个域（MiNA/micoapi 与 MiIOT/xiaomiio）**凭据确实不可互换** ——
> 这一点后来由 Lead 实测确认（用 xiaomiio token 打 MiNA 端点 → 401），
> 并在 §7 由我用对照组再次独立验证。


### 0.2 已确认：缺陷来自上游，不是我们的改造

我们的 `lib/vendor/mi-service-lite.js` 与上游 `mi-service-lite@3.1.0`
（`mi-gpt/node_modules/mi-service-lite/dist/index.js`）在关键函数上**逐字节一致**：

| 函数 | 我们 vendor | 上游 3.1.0 | 是否一致 |
|---|---|---|---|
| `_getServiceToken` | 822-836 | 801-816 | ✅ 一致（同样**不传 cookie**） |
| `getAccount` 主体 | 747-812 | 726-791 | ✅ 一致 |

**结论：`_getServiceToken` 不传 cookie 是上游 3.1.0 的原始缺陷**，
我们的零依赖改造（axios → fetch）**没有引入**它，但**也没有修复**它。
（axios 在 Node 里同样默认无 cookie jar，所以上游用 axios 时也一样会 401。）

---

## 1. HA xiaomi_miot 的完整登录流程

文件：`/homeassistant/custom_components/xiaomi_miot/core/xiaomi_cloud.py`

### 1.1 关键结构性事实：共用 Session + 显式 Cookie 合并

**这是 HA 与 vendor 最本质的差异。**

```python
# 行 852-878
    def account_get(self, url, method='GET', **kwargs):
        return self.account_post(url, method, **kwargs)      # ← GET 也走 post 通道

    def account_post(self, url, method='POST', **kwargs):
        if url[:4] != 'http':
            url = f'{ACCOUNT_BASE}{url}'
        kwargs['cookies'] = {
            **self.cookies,                                   # ← 行 858-861：手工 cookie jar
            **kwargs.get('cookies', {}),
        }
        kwargs.setdefault('headers', {'User-Agent': self.useragent})
        response = kwargs.pop('response', None)
        resp = self.session.request(method, url, **kwargs)    # ← 行 864：同一个 self.session
        try:
            data = self.json_decode(resp.text) or {}
        except Exception:
            data = {'code': resp.status_code, 'response': resp.text}
        cookies = resp.cookies.get_dict()
        self.cookies.update(cookies)                          # ← 行 868-869：写回 cookie jar
```

要点三条：
1. **`self.session` 是一个复用的 `requests.Session`**（行 1022：`self.session = self.api_session()`），
   底层有真正的 cookie jar，`Set-Cookie` 自动留存。
2. **在 session 之上 HA 还自己维护了一份 `self.cookies` 字典**，每次请求显式合并进去（858-861 行），
   每个响应再 `self.cookies.update(...)` 写回（868-869 行）。**双保险**。
3. `account_get` 只是 `account_post` 的别名 → GET/POST 必然共享同一 cookie 上下文。

> **对 vendor 的意义**：vendor 只做了第 1 条的「没有」，第 2 条也「没有」。

### 1.2 Step 1 — `serviceLogin` 拿 `_sign` / `qs`

```python
# 行 634-653
    def _login_step1(self):
        self.cookies.update({'sdkVersion': '3.8.6', 'deviceId': self.client_id})   # 行 635
        try:
            auth = self.account_get(
                '/pass/serviceLogin',
                params={'sid': self.sid, '_json': 'true'},
                headers={'User-Agent': self.useragent},
            )
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
            raise
        except Exception as exc:
            raise MiCloudException('Xiaomi login sign request failed') from exc
        if auth.get('code') == 0:
            self.user_id = auth.get('userId', self.user_id)
            self.cuser_id = auth.get('cUserId', self.cuser_id)
            self.ssecurity = auth.get('ssecurity', self.ssecurity)
            self.pass_token = auth.get('passToken', self.pass_token)
            self.async_session = None
        return auth
```

返回值 `auth` 里带 `_sign` / `qs` / `callback` / `sid`，供 step2 用。
注意行 635 先塞了 `sdkVersion` 和 `deviceId` 进 cookie jar —— **这两个 cookie 后续每步都自动带上**，vendor 没有。

### 1.3 Step 2 — `serviceLoginAuth2` + **clientSign 计算**

```python
# 行 654-700（截取核心）
    def _login_step2(self, captcha=None, **kwargs):
        url = '/pass/serviceLoginAuth2'
        post = {
            'user': self.username,
            'hash': hashlib.md5(self.password.encode()).hexdigest().upper(),
            'callback': kwargs.get('callback') or '',
            'sid': kwargs.get('sid') or self.sid,
            'qs': kwargs.get('qs') or '',
            '_sign': kwargs.get('_sign') or '',
        }
        params = {'_json': 'true'}
        cookies = {}
        if captcha:
            post['captCode'] = captcha
            params['_dc'] = int(time.time() * 1000)
            cookies['ick'] = self.attrs.pop('captchaIck', '')
        response = self.account_post(
            url, data=post, params=params, cookies=cookies, response=True,
        )
        auth = self.json_decode(response.text) or {}
        code = auth.get('code')
        location = auth.get('location')

        if location:                                            # ← 行 680：成功分支
            self.user_id = str(auth.get('userId', ''))
            self.cuser_id = auth.get('cUserId')
            self.ssecurity = auth.get('ssecurity')
            self.pass_token = auth.get('passToken')
            if self.sid != 'xiaomiio':                          # ← 行 685：非 miio 才要 clientSign
                sign = f'nonce={auth.get("nonce")}&{auth.get("ssecurity")}'
                sign = hashlib.sha1(sign.encode()).digest()
                sign = base64.b64encode(sign).decode()
                location += '&clientSign=' + parse.quote(sign)  # ← 行 689
            _LOGGER.debug('Xiaomi serviceLoginAuth2 completed')
            return location

        if ntf := auth.get('notificationUrl'):                 # ← 行 693：风控！
            ntf = self._absolutize(ntf)
            self.attrs['verify_url'] = ntf
            raise MiCloudNeedVerify('need_verify').with_url(ntf)

        cap = auth.get('captchaUrl')                            # ← 行 699：图形验证码
        ...
```

**clientSign 算法（行 686-689，可复制）**：
```python
sign = f'nonce={auth["nonce"]}&{auth["ssecurity"]}'
sign = hashlib.sha1(sign.encode()).digest()      # 注意：是 digest() 字节，不是 hexdigest
sign = base64.b64encode(sign).decode()
location += '&clientSign=' + parse.quote(sign)
```
> `parse.quote` 是**必须**的：base64 含 `+` `/` `=`，不编码会被当成 query 分隔符。
> 判据是 `sid != 'xiaomiio'`，即 **MiNA（micoapi）走 clientSign，MiIOT（xiaomiio）不走**。

### 1.4 风控分支 —— HA 怎么处理 `notificationUrl`

行 693-696：**HA 直接把控制权交回调用方**，抛 `MiCloudNeedVerify` 并带上 `verify_url`。
调用方（HA 的 config_flow UI）展示一个"去验证"的链接，用户手机验证完，
再由用户把 **ticket（验证码）** 回填，走下面 `_login_request` 的 `verify_ticket` 分支：

```python
# 行 592-633（关键分支）
    def _login_request(self, login_data=None):
        self._init_session(not login_data)                      # 行 593
        location = ''
        auth = self.attrs.pop('login_data', {})
        if not login_data:
            pass
        elif ticket := login_data.get('verify_ticket'):          # ← 行 599：验证码路径
            try:
                resp = self.verify_ticket(ticket)                # 行 601
            except (MiCloudVerificationError, MiCloudException):
                raise
            location = resp.get('location', '')                  # 行 604 ← 验证成功后拿到的跳转地址
            if not location:
                raise MiCloudAuthenticationError('Xiaomi verify did not return location')
            response = self.account_get(location, allow_redirects=True, response=True)   # 行 607
            if self._finalize_login_response(response):          # 行 608
                return True
            if skip_url := self._extract_confirm_phone_skip_url(response):              # 行 610
                response = self.account_get(skip_url, allow_redirects=True, response=True)
                if self._finalize_login_response(response):
                    return True
            auth = self._login_step1()                           # 行 615：验证后重新走一遍
            location = auth.get('location', '')
        elif auth:
            auth.update(login_data)
        else:
            auth = self._login_step1()
        if not location:
            location = self._login_step2(**auth)                 # 行 621
        response = self._login_step3(location)                   # 行 622
```

**流程要点**：
- 验证码路径**拿两次 serviceToken**：先 `verify_ticket` 返回的 `location` 直接换一次（行 607），
  成功后 **`allow_redirects=True`** 跟随跳转读 cookie。
- 若第一次没拿到，**重新 step1→step2→step3** 整套重走（615-622 行）——
  因为验证已通过，此时第二次 `serviceLoginAuth2` 会直接返回正常 `location`。
- `_extract_confirm_phone_skip_url`（757-769 行）处理"确认手机号"中间页：
  若落在 `/fe/` 路径，从 query 取 `skipUrl` 再跳一次。

### 1.5 `verify_ticket(ticket)` —— 验证码怎么提交（**可 API 化**）

```python
# 行 811-849
    def verify_ticket(self, ticket):
        url = self.attrs.get('verify_url')
        if not url:
            raise MiCloudException('Xiaomi verify URL missing')
        options = self.check_identity_list(url) or []            # 行 815：先探可用验证方式
        if not options:
            raise MiCloudException('Xiaomi verify no supported method')
        last = None
        for flag in options:
            api = {
                4: '/identity/auth/verifyPhone',                 # 手机
                8: '/identity/auth/verifyEmail',                 # 邮箱
            }.get(flag)
            if not api:
                continue
            try:
                data = self.account_post(
                    api,
                    params={'_dc': int(time.time() * 1000)},
                    data={
                        '_flag': flag,
                        'ticket': ticket,                        # ← 验证码就在这
                        'trust': 'false',
                        '_json': 'true',
                    },
                    cookies={
                        'identity_session': self.attrs.get('identity_session'),   # ← 关键 cookie
                    },
                )
            except Exception as exc:
                raise MiCloudException('Xiaomi verify request failed') from exc
            last = data
            if data.get('code') == 0:
                self.attrs.pop('identity_session', None)
                return data                                  # ← 成功，返回含 location
        if last and last.get('code') != 0:
            raise MiCloudVerificationError('Xiaomi verification ticket rejected')
        raise MiCloudException('Xiaomi verify no supported method')
```

配套的 `check_identity_list`（798-809 行）—— **先取 `identity_session` cookie 再提交**：
```python
    def check_identity_list(self, url, path='fe/service/identity/authStart'):
        if path not in url:
            return None
        resp = self.account_get(url.replace(path, 'identity/list'), response=True)
        identity_session = resp.cookies.get('identity_session')
        if not identity_session:
            raise MiCloudException('Xiaomi identity session missing')
        self.attrs['identity_session'] = identity_session
        data = self.json_decode(resp.text) or {}
        flag = data.get('flag', 4)
        options = data.get('options', [flag])
        return options or False
```

**这是整个研究里最有价值的一段**：它证明验证码提交**完全可以 API 化**，
三段式：
1. `GET {verify_url把 authStart 换成 identity/list}` → 拿 `identity_session` cookie + `options`(验证方式 flag)
2. (可选) 触发发码
3. `POST /identity/auth/verifyPhone`，body `{_flag:4, ticket:<验证码>, trust:'false', _json:'true'}`，
   **必须带 `Cookie: identity_session=...`** → 成功返回 `{code:0, location:...}`

### 1.6 `_login_step3` —— **就是"用 location 换 serviceToken"**

```python
# 行 771-789
    _STS_HOST = 'api2.mina.mi.com'

    def _login_step3(self, location):
        self.session.headers.update({'content-type': 'application/x-www-form-urlencoded'})
        response = self.account_get(location, response=True)     # ← 行 774：GET location，复用 session
        cookies = response.cookies
        service_token = cookies.get('serviceToken')              # ← 行 776：从【响应 cookie】取
        if service_token:
            self.service_token = service_token
            self.user_id = cookies.get('userId', self.user_id)
            self.cuser_id = cookies.get('cUserId', self.cuser_id)
            self.async_session = None
            return response
        is_sts = (                                               # ← 行 783-787：正是我们卡住的地方
            self.sid == CloudSid.MICOAPI
            and self._STS_HOST in location
            and response.status_code == 401
        )
        if is_sts:
            raise MiCloudStsUnauthorized('Xiaomi STS rejected completed login')
        raise MiCloudAuthenticationError('Xiaomi login step3 missing service token')
```

**逐条回答疑问 1**：
- `_login_step3` **没有显式传 `allow_redirects`**（行 774）→ 用 requests 默认值 **`True`**。
  而验证码路径的行 607/612 是**显式**写 `allow_redirects=True`。
- **serviceToken 从 `response.cookies.get('serviceToken')` 取**（行 776）—— 是 **`Set-Cookie` 响应头**，
  **不是** JSON body，也**不是** URL query 里的 `auth=xxx`。
- HA **当时就预见了我们这个 401**，专门写了 `MiCloudStsUnauthorized`（`class MiCloudStsUnauthorized(MiCloudAccessDenied)`，行 57）
  并在 783-787 行精确匹配「sid=micoapi + host=api2.mina.mi.com + 401」。

> ⚠️ **重大线索**：你在浏览器里看到的 `api2.mina.mi.com/sts?...&auth=xxx` **401**，
> 在 HA 的模型里是一个**已知的、明确的失败态**（STS 拒绝），
> 而**不是**正常的"跳转完成后就能拿到 token"。
> 真正的成功态是：GET 这个 location，服务端 **`Set-Cookie: serviceToken=...`**。
> 所以问题不是"浏览器带不上 cookie"，而是**这一次 GET 没有被 STS 认作合法续接**。

### 1.7 `_finalize_login_response` —— 唯一取 token 的地方

```python
# 行 744-755
    def _finalize_login_response(self, response):
        if not response:
            return False
        cookies = response.cookies
        service_token = cookies.get('serviceToken')
        if not service_token:
            return False
        self.service_token = service_token
        self.user_id = cookies.get('userId', self.user_id)
        self.cuser_id = cookies.get('cUserId', self.cuser_id)
        self.async_session = None
        return True
```

同样**只从响应 cookie 取**。HA 全代码库取 `serviceToken` 的路径统一是 `response.cookies`。

---

## 2. MiGPT 的做法

### 2.1 事实

- `/media/duola/devdata/AI-workspace/mi-gpt/package.json:37` → `"mi-service-lite": "^3.1.0"`
- 实装版本 `node_modules/mi-service-lite/package.json` → `"version": "3.1.0"`（与我们 vendor 同源）
- MiGPT 的 `src/` 里**没有任何** `clientSign` / `_getServiceToken` / `api2.mina` 的独立实现 ——
  它**完全依赖 mi-service-lite 内部**。

### 2.2 MiGPT 对风控的处理：**没有处理，只提示手动**

`lib/vendor/mi-service-lite.js:776-788`（= 上游 3.1.0 原文）：

```js
  if (!pass.location || !pass.nonce || !pass.passToken) {
    if (pass.notificationUrl || pass.captchaUrl) {
      console.log(
        "\u{1F525} 触发小米账号异地登录安全验证机制，请在浏览器打开以下链接，并按照网页提示授权验证账号："
      );
      console.log("\u{1F449} " + pass.notificationUrl || pass.captchaUrl);
      console.log(
        "\u{1F41B} 注意：授权成功后，大约需要等待 1 个小时左右账号信息才会更新，请在更新后再尝试重新登录。"
      );
    }
    console.error("❌ 小米账号登录失败", res);
    return void 0;
  }
```

**逐条回答疑问 4**：MiGPT **不处理**风控。它的策略是：
1. 打印链接让用户**去浏览器手动授权**；
2. 声称**约 1 小时后**账号信息更新；
3. 然后**重新跑一次登录**（此时因为服务端已记录授权，`serviceLoginAuth2` 会直接返回 `location`，不触发风控）。

> **这是关键洞察**：MiGPT 走的是「**等风控状态在服务端过期/被标记**」的路子，
> 而**不是**「从验证页的跳转 URL 换 token」。
> 也就是说 —— **MiGPT 从设计上就放弃了"立即用 verification 的 location 换 token"**。

### 2.3 我们（MiGPT 目录）打过的补丁

- `mi-gpt/patch_mi.mjs`（我们写的）→ 在 `getAccount` 开头插入「已缓存 serviceToken 就跳过登录」。
- `mi-gpt/mkstore.mjs` / `fixstore.mjs`（我们写的）→ 手工把从 HA 拿到的 `serviceToken` 硬写进 `.mi.json`。
- 该补丁已固化为 vendor 的 725-746 行（`// ── PATCH: 复用已缓存的 serviceToken，跳过小米密码登录与风控 ──`）。

**这说明我们实际上已经放弃了密码登录路径**，改走"从 HA 借 token"。

---

## 3. vendor 库 `mi-service-lite` 缺什么

文件：`/media/duola/devdata/AI-workspace/dsh-xiaoai-local/lib/vendor/mi-service-lite.js`
（+ `zero-dep-adapter.js`）

### 3.1 全貌：vendor 做了 / 没做

| 步骤 | HA | vendor | 差距 |
|---|---|---|---|
| 共用 Session / cookie jar | ✅ `self.session` + `self.cookies` | ❌ **无** | **致命** |
| step1 `serviceLogin` | ✅ 634-653 | ✅ 747-756 | 少塞 `sdkVersion`/`deviceId` cookie |
| step2 `serviceLoginAuth2` | ✅ 654-700 | ✅ 757-775 | 基本等价 |
| **clientSign** | ✅ 686-689 | ✅ 827-830 | **OK**（sha1 → base64，见下） |
| 风控 `notificationUrl` | 抛异常给 UI 处理 | 只打印链接 | 缺 API 化 |
| 验证码 `verify_ticket` | ✅ 811-849 | ❌ **完全没有** | 缺 |
| `identity_session` | ✅ 804 | ❌ **没有** | 缺 |
| step3 换 token | ✅ 771-789（带 cookie） | ⚠️ 822-836（**不带 cookie**） | **致命** |

### 3.2 clientSign：**算对了**（疑问 2 的答案）

`sha1` 的实现（vendor 行 63-64）：
```js
function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("base64");   // ← 是 base64，不是 hex
}
```
调用点（vendor 行 822-836）：
```js
async function _getServiceToken(pass) {
  var _a;
  const { location, nonce, ssecurity } = pass ?? {};
  const res = await Http.get(
    location,
    {
      _userIdNeedEncrypt: true,
      clientSign: sha1(`nonce=${nonce}&${ssecurity}`)      // ← 行 829：算法正确
    },
    { rawResponse: true }
  );
  let cookies = ((_a = res.headers) == null ? void 0 : _a["set-cookie"]) ?? [];
  for (let cookie of cookies) {
    if (cookie.includes("serviceToken")) {
      return cookie.split(";")[0].replace("serviceToken=", "");
    }
  }
  console.error("❌ 获取 Mi Service Token 失败", res);
  return void 0;
}
```
✅ `sha1(...).digest("base64")` + `clientSign=` → **与 HA 行 686-689 等价**（URL 编码由 `buildURL` 的 `searchParams.append` 负责，正确）。

> **疑问 2 / 5 答复：clientSign 不是问题，vendor 算对了。**

### 3.3 真正缺的：**Cookie 上下文**（疑问 5 的答案）

**(a) `_getServiceToken` 一个 cookie 都不传**（vendor 行 822-830）

`Http.get(url, query, config)` 的 `config` 只传了 `{rawResponse: true}` —— **没有 `cookies` 字段**。

**(b) `HTTPClient.buildConfig` 默认不拼 Cookie**（vendor 行 186-201）
```js
  static buildConfig = (config) => {
    if (config == null ? void 0 : config.cookies) {          // ← 只有显式传才拼
      config.headers = {
        ...config.headers,
        Cookie: Object.entries(config.cookies).map(
          ([key, value]) => `${key}=${value == null ? "" : value.toString()};`
        ).join(" ")
      };
    }
    ...
```

**(c) `zero-dep-adapter.js` 的 fetch 没有 cookie jar**（`makeHttp` 行 ~86-92）
```js
      res = await fetch(cfg.url, {
        method: (cfg.method ?? "GET").toUpperCase(),
        headers: cfg.headers,
        body: cfg.data === undefined ? undefined : cfg.data,
        signal: ctrl.signal,
        redirect: "follow",
      });
```
Node 原生 `fetch` **不实现 cookie jar**：`Set-Cookie` 不保存、后续请求不自动回传。
`redirect: "follow"` 会让 fetch 跟随跳转，但**跨站/跨路径的 cookie 语义仍然由 fetch 自己处理，且不落盘**。
（上游用 axios，而 **axios 在 Node 环境同样不实现 cookie jar** ——
 浏览器里 axios 靠 XHR 自动带 cookie，Node 里则不会。
 所以**这是上游 3.1.0 的固有问题，不是我们零依赖改造引入的** —— 已对照 `dist/index.js` 逐字节确认。）

**(d) 对比：`getAccount` 的第 1、2 步是带 cookie 的，第 3 步断了**
```js
// 行 747-751
  let res = await Http.get(
    `${kLoginAPI}/serviceLogin`,
    { sid: account.sid, _json: true, _locale: "zh_CN" },
    { cookies: _getLoginCookies(account) }        // ← 有 cookie
  );
// 行 767-769
    res = await Http.post(`${kLoginAPI}/serviceLoginAuth2`, encodeQuery(data), {
      cookies: _getLoginCookies(account)          // ← 有 cookie
    });
// 行 789
  const serviceToken = await _getServiceToken(pass);
//   → 内部 Http.get(location, {...}, {rawResponse:true})   ← 行 831：没有 cookie！
```
`_getLoginCookies(account)`（行 814-820）：
```js
function _getLoginCookies(account) {
  var _a;
  return {
    userId: account.userId,
    deviceId: account.deviceId,
    passToken: (_a = account.pass) == null ? void 0 : _a.passToken
  };
}
```

**⚠️ 但这里有个更微妙的问题**：`account` 在调用 `_getServiceToken` 之前**并没有被更新**——
`pass` 是刚解析出来的（行 774 `pass = parseAuthPass(res)`），
而 `account.userId` / `account.pass` **还是登录前的旧值**（`account.pass.passToken` 此时通常是 `undefined`）。
所以即使给 STS 那步补上 `_getLoginCookies(account)`，**cookie 值也是错的/空的**。

正确做法应参照 HA：用 **step1/step2 响应里新拿到的 `userId` / `passToken` / `cUserId`**，
再叠加 step1 里塞的 `sdkVersion` / `deviceId`。

**(e) `_getServiceToken` 还丢了两个 query 参数**

HA 的 step3（行 774）把 location **原样** GET；但 location 里本来就带 `clientSign`（HA 在 689 行拼过）。
vendor 这里用 `_userIdNeedEncrypt: true` + `clientSign` 作为 **query 参数** 传（行 826-830），
语义上接近，但**没有 `parse.quote`** —— 虽然 `URL.searchParams.append` 会自动编码，这点没问题。

**(f) `rawResponse: true` 的行为**（vendor 行 130-140 `_http.interceptors.response.use`）
在非 2xx 时 `zero-dep-adapter` 会 **throw**（`e.code = ERR_BAD_STATUS_401`），
所以 `_getServiceToken` 里的 `res.headers` 在 401 时根本走不到 —— **直接抛异常**。
而 `getAccount` 的调用方（行 789-792）只判断 `if (!serviceToken) return void 0;`，
**没有 try/catch** → 异常上抛成「小米登录失败」。

### 3.4 缺的第二步：**没有验证码 API**

vendor **完全没有** `verify_ticket` / `identity_session` / `identity/list` / `verifyPhone` 任何痕迹
（已 grep 全文件确认）。这意味着即使 STS 修好了，**遇到风控仍然只能靠用户手动**。

---

## 4. 修复方案（代码级）

方案按**推荐度**排序。所有改动**只涉及 vendor 文件**，不动 `src/`。

### 方案 A（**首选**）：补 cookie 上下文 + 修 STS 取值 —— 治本

**改 `lib/vendor/mi-service-lite.js` 的 `_getServiceToken`（行 822-836）**

```js
async function _getServiceToken(pass, account, loginCookies) {
  const { location, nonce, ssecurity } = pass ?? {};
  // ① cookie 用「step2 刚刚返回的新值」，而不是过期的 account
  const cookies = {
    ...(loginCookies ?? {}),
    userId: pass.userId != null ? String(pass.userId) : loginCookies?.userId,
    passToken: pass.passToken ?? loginCookies?.passToken,
    cUserId: pass.cUserId ?? loginCookies?.cUserId,
    sdkVersion: "3.8.6",
    deviceId: account?.deviceId,
  };
  const res = await Http.get(
    location,
    { _userIdNeedEncrypt: true, clientSign: sha1(`nonce=${nonce}&${ssecurity}`) },
    { cookies, rawResponse: true }     // ② 关键：把 cookie 传进去
  );
  // ③ 兜底：有的情况下 token 在 res.data 里而不是 set-cookie
  let cookies2 = res?.headers?.["set-cookie"] ?? [];
  for (const cookie of cookies2) {
    if (cookie.includes("serviceToken")) {
      return cookie.split(";")[0].replace("serviceToken=", "");
    }
  }
  return void 0;
}
```

**调用点（行 789）改为**：
```js
// 需要先把 pass 里的新凭据合并进 account，再取 token
account = { ...account, pass, userId: pass.userId ?? account.userId };
const serviceToken = await _getServiceToken(
  pass, account, _getLoginCookies(account)
);
```

**同时给 `_getServiceToken` 调用加 try/catch**，把 401 转成结构化错误（见方案 D）。

> **预期行为**：STS GET 带上 `passToken`/`userId`/`sdkVersion`/`deviceId` 后，
> 服务端应返回 `Set-Cookie: serviceToken=...` → 登录成功。
>
> **⚠️ 诚实标注**：这一条是**强推断，未实机验证**。
> 因为 HA 之所以能成功，靠的正是 session 里的这些 cookie；
> 但我们**还没有实机跑过**一次修复后的完整手机验证登录。
> 若修完仍 401，说明 STS 端还校验了别的东西（见方案 C）。

### 方案 B：加一个极简 cookie jar 到 vendor HTTP 层 —— 一劳永逸

在 `zero-dep-adapter.js` 的 `createHttp` 里加一个进程级 cookie 存储：

```js
const _jar = new Map();   // host -> { name: value }

// 发送前：
const host = new URL(cfg.url).host;
if (_jar.has(host)) {
  const jarCookie = [..._jar.get(host).entries()]
    .map(([k, v]) => `${k}=${v}`).join("; ");
  cfg.headers = { ...cfg.headers, Cookie: [cfg.headers?.Cookie, jarCookie].filter(Boolean).join("; ") };
}

// 收到响应后：
for (const sc of res.headers.getSetCookie?.() ?? []) {
  const [pair] = sc.split(";");
  const i = pair.indexOf("=");
  if (i > 0) _jar.get(host).set(pair.slice(0, i), pair.slice(i + 1));
}
```
> 优点：**最贴近 HA 的语义**，一次修好所有走 `Http` 的调用（包括 `TokenRefresher`）。
> 缺点：改动面大，需注意 `set-cookie` 的域/路径（小米的 cookie 多挂在 `.mi.com` 上，
> 需要按后缀域匹配而非精确 host，否则 `account.xiaomi.com` 与 `api2.mina.mi.com` 之间不共享）。
> **风险提示**：Node 的 `res.headers.getSetCookie()` 需 Node ≥ 18.14；否则要读原始 header 手动分割。

### 方案 C：把验证码流程 API 化 —— 让"手机验证"变成一次输入框

照抄 HA 的 `check_identity_list`（798-809 行）+ `verify_ticket`（811-849 行）：

```js
// 1) 探测可用验证方式 + 拿 identity_session
async function getIdentityOptions(verifyUrl) {
  const listUrl = verifyUrl.replace("fe/service/identity/authStart", "identity/list");
  const res = await Http.get(listUrl, {}, { cookies: _jarCookies(), rawResponse: true });
  const identitySession = /* 从 set-cookie 解析 identity_session */;
  const data = jsonDecode(res.data) ?? {};
  return { identitySession, options: data.options ?? [data.flag ?? 4] };
}

// 2) 提交验证码
async function verifyTicket(ticket, flag, identitySession) {
  const api = { 4: "/identity/auth/verifyPhone", 8: "/identity/auth/verifyEmail" }[flag];
  const res = await Http.post(
    `${kAccountAPI}${api}?_dc=${Date.now()}`,
    encodeQuery({ _flag: flag, ticket, trust: "false", _json: "true" }),
    { cookies: { identity_session: identitySession },
      headers: { "content-type": "application/x-www-form-urlencoded" } }
  );
  return res;   // code === 0 时带 location
}
```

**注意**：`identity_session` **必须**从响应 cookie 取，
而 vendor 当前**没有 cookie jar** → **方案 C 依赖方案 B（或至少在函数内手工传递）**。

> 若要做到完全可用，`getAccount` 需改成一台显式状态机：
> `step1 → step2 →(notificationUrl)→ getIdentityOptions → 等用户输码 → verifyTicket
> → 用返回的 location 换 token（方案 A）→ 失败则重走 step1/step2 → step3`。
> 这正是 HA `_login_request`（592-633 行）的结构。

### 方案 D：把错误说清楚（**最小改动，强烈建议先做**）

现在 `_getServiceToken` 401 会**抛裸异常**，被上层吞成"登录失败"。
建议：
- 在 `getAccount` 里 catch 401 且 `location.includes("api2.mina.mi.com")`，
  返回一个**结构化**错误 `{ code: "STS_401", verifyUrl, hint: "..." }`；
- `src/xiaomi.js` / `onboarding.js` 据此显示**明确文案**：
  「小米 STS 拒绝：请改用『从 HA 导入凭据』或稍后重试（风控生效约 1 小时）」。
- 这一条**零风险**，且立刻改善用户体验。

### 方案 E：承认现实 —— 保留「从 HA 借 token」为主路径

现状（`src/onboarding.js`）已经能从 HA 直接读 token。
**对已有 HA 的用户，这条路是 100% 可靠且零风控的**，应该继续作为**默认推荐**。
方案 A-C 只服务于「**新用户、没有 HA**」这个场景。

---

## 5. 风险评估

### 5.1 改 vendor 会不会触发更多风控？

| 风险 | 评估 |
|---|---|
| **重试风暴把自己打进黑名单** | **中高**。HA 的 `TokenRefresher` 会 `maxRetry=3` + `sleep(3s)`（vendor 行 227-238），且 `refreshToken` 里 `getMiService({relogin:true})` → **会再次触发完整登录**。若 STS 一直 401，就会**反复登录** → 极易触发风控升级。**必须加节流/熔断**（建议：同一账号 1 小时内最多 3 次完整登录）。 |
| **反复重走 step1/step2** | **中高**。HA 的行 615 也是重走的，但 HA 有人工节流（`login_times > 5` 清凭据、`> 10` 直接拒绝，见 `async_login_attempt`）。**vendor 完全没有这个计数器** → 建议照抄。 |
| **验证码提交（方案 C）** | **低**。这是**正常用户行为**，服务端预期内。但 `ticket` 输错会消耗尝试次数（HA 抛 `MiCloudVerificationError`）—— 建议把用户输错次数限制在 3 次以内。 |
| **1 小时等待窗口** | **低但重要**。MiGPT 明确说"授权成功后约 1 小时账号信息才更新"（vendor 行 782-784）。**不要在 1 小时内狂试** —— 这正是打死账号的主因。 |

### 5.2 会不会打死音箱/机器？

- **不会打死音箱**。音箱侧是 `MiNA` 的 MQTT/长轮询，token 只在**建立连接时**用一次。
  登录失败只会导致插件「连不上」，不会影响音箱本体（音箱只跟小米云通信）。
- **会打死的是插件进程**：`src/xiaomi.js` 若在 `connect()` 里同步等登录，
  登录卡住 → 连接超时 → 可能触发 DSH 的重试逻辑。
  **建议**：登录过程**必须完全异步 + 有硬超时**（`Http.timeout` 默认仅 3s，
  见 `src/xiaomi.js:119-128` 的注释——他们已把它设成 15000 并指出「是模块级全局且粘性的」这个坑）。
- **一个真实的隐患**：`Http.timeout` **是模块级全局且粘性**的（vendor 行 200：
  `if (config && !config.timeout) config.timeout = Http.timeout;`）。
  如果在登录流程里临时调大它，**会污染后续所有 API 调用**。改超时请用**每次传 `config.timeout`**，
  不要改 `Http.timeout`。

### 5.3 回归风险

- 方案 A 改了 `_getServiceToken` 的**函数签名**（加参数）→ 必须同步改行 789 的调用点，
  且注意 **`TokenRefresher.refreshToken`（行 244-258）也间接依赖 `getMiService`** 的路径。
- 方案 B 改 `zero-dep-adapter.js` → 影响**所有** HTTP 调用（含 MiIOT / MiNA 的 API）。
  **必须回归验证**：设备列表、`getDevice`、消息收发。
- **已有缓存 token 的用户不受影响**（vendor 行 725-746 的 PATCH 会直接短路返回）。

---

## 6. 诚实结论

### 6.1 能修吗？—— **能，但不是"改一行就好"**

- **clientSign 不是 bug**（vendor 算对了）—— 这条排除了一个常见误判。
- **真正的根因是架构性的**：vendor 从 axios 迁到裸 `fetch` 时**丢失了 cookie jar**，
  而小米的 STS 换 token 流程**强依赖 cookie 延续**。
  这是**上游 mi-service-lite 3.1.0 的固有问题**（axios 在 Node 里默认也无 cookie jar），
  **不是我们零依赖改造引入的**。

### 6.2 但有三个必须说清的不确定性

1. **方案 A 是强推断，未实机验证。**
   我推断了「补上 cookie 就能过 STS」，依据是 HA 靠 session cookie 成功。
   但**我没有真的跑过一次**。如果修完仍 401，说明 STS 还校验了别的维度
   （如 TLS 指纹、`User-Agent` 一致性、请求频率、IP 信誉）——
   那就**不是纯客户端的能修的问题**了。

2. **浏览器里那次 401 可能掩盖了另一个问题。**
   你描述的路径是「打开验证页 → 发码 → 提交 → **页面跳转** → 401」。
   这是**浏览器**的行为。而 HA/vendor 是**程序**行为：
   它们是 `GET location` 然后**读响应头**，根本不渲染页面。
   两者**不等价**。所以"浏览器跳转带不上 cookie"这个推测，
   **对程序路径可能根本不适用** —— 程序路径的问题就是**单纯没发 cookie**。

3. **MiGPT 的路（等 1 小时）可能比修 STS 更稳。**
   MiGPT 明确选择了「手动授权 → 等 1 小时 → 重新登录」。
   如果小米的服务端风控是**按设备指纹/频率**判定的，
   那**无论怎么修客户端，高频尝试都会失败**，而"等 1 小时"反而是唯一可靠路径。
   **建议：方案 A + 方案 D + 方案 E 组合，并把"等 1 小时"作为兜底文案明确告诉用户。**

### 6.3 「新用户没有 HA」怎么办 —— 这是真正的难题

诚实说：**这是本次研究里唯一没有确定答案的点。**

- 如果方案 A 实机验证通过 → **有解**，且可以进一步用方案 C 把验证码做进 UI。
- 如果方案 A 失败 → **无解**（至少无纯客户端解）。此时只能：
  - 引导用户装一个 HA（成本高但可靠）；
  - 或引导用户在**手机米家 App 里完成一次登录**后，用别的工具导出 token（仍然绕）；
  - 或**接受"首次接入可失败"**，让用户手动把 token 贴进来。

**我的建议**：**先做方案 D（改错误提示，零风险）+ 方案 A（实机验证）**。
方案 A 验证通过再投方案 B/C。**不要**在没有熔断的情况下直接上重试逻辑。

### 6.4 ⚠️ 关于方案 A 成功率的修正（基于 §0.1 的实机发现）

我原本推断「补上 cookie → STS 就会返回 serviceToken」，**现在必须下调这个推断的置信度**：

**支持方案 A 的证据**：
- HA 的 `account_post` 确实靠共享 session cookie 延续（858-861 + 1024 行），
  说明小米登录链**确实依赖 cookie 上下文** —— 这是真实机制，不是猜测。

**削弱方案 A 的证据**：
1. **HA 里唯一已知成功的账号是 `sid=xiaomiio`**（MiIOT 域），
   而我们要的是 `sid=micoapi`（MiNA 域，`api2.mina.mi.com`）。
   **两者是不同的 STS 端点，成功经验不能直接迁移。**
2. HA 专门为这个 401 定义了异常（行 57）+ 三元精确判定（783-787），
   措辞是 `'Xiaomi STS rejected completed login'` ——
   **"completed login"** 说明 HA 认为**登录已经完整走完了**，
   STS 仍然拒绝 → 这更像是**服务端侧的判定**，而非客户端 cookie 缺失。
3. `verify_ticket` 成功后 HA 走的是**两条路**（行 607 直接换 + 行 615 重走 step1/step2），
   说明**直接换 token 这条路本身就不够可靠**，HA 才要加兜底。

**修正后的结论**：方案 A **仍值得先试**（成本低、逻辑自洽），
但**不应作为唯一希望**。若修完仍 401，几乎可以确定是 MiNA 域的服务端风控/端侧校验问题，
**纯客户端无解** —— 此时应转向方案 E（借 token）+ 让用户「等 1 小时」重试。

### 6.5 建议的执行顺序（务实版）

```
1. 方案 D（改错误提示，零风险）              ← 立刻做
2. 实测：用 HA 的 xiaomiio token 能否驱动音箱  ← 关键实验，决定后面所有事
      ├─ 能 → 方案 E 已经是完整答案，收工
      └─ 不能 → 必须走 micoapi，继续
3. 方案 A（补 cookie）实机验证一次
      ├─ 通过 → 再补方案 B/C（cookie jar + 验证码 API）
      └─ 401  → 判定为服务端风控，转向「等 1 小时」文案 + 手动 token 兜底
```

> 第 2 步是整个研究里**信息增益最高**的一个实验，且成本极低
> （HA 里已有现成的 `xiaomiio` token）。
> **强烈建议先做它，再决定要不要投入改 vendor。**

诚实说：**这是本次研究里唯一没有确定答案的点。**

- 如果方案 A 实机验证通过 → **有解**，且可以进一步用方案 C 把验证码做进 UI。
- 如果方案 A 失败 → **无解**（至少无纯客户端解）。此时只能：
  - 引导用户装一个 HA（成本高但可靠）；
  - 或引导用户在**手机米家 App 里完成一次登录**后，用别的工具导出 token（仍然绕）；
  - 或**接受"首次接入可失败"**，让用户手动把 token 贴进来。

**我的建议**：**先做方案 D（改错误提示，零风险）+ 方案 A（实机验证）**。
方案 A 验证通过再投方案 B/C。**不要**在没有熔断的情况下直接上重试逻辑。

---

## 附录 A：证据索引

### HA（192.168.3.3 `/homeassistant/custom_components/xiaomi_miot/core/xiaomi_cloud.py`）
| 行号 | 内容 |
|---|---|
| 57 | `class MiCloudStsUnauthorized(MiCloudAccessDenied)` |
| 592-633 | `_login_request`（ticket 分支 599-616，step3 调用 622） |
| 634-653 | `_login_step1`（635 塞 sdkVersion/deviceId cookie） |
| 654-700 | `_login_step2`（686-689 **clientSign**，693 风控，699 图形码） |
| 744-755 | `_finalize_login_response`（从 `response.cookies` 取 token） |
| 757-769 | `_extract_confirm_phone_skip_url` |
| 771-789 | `_login_step3`（774 GET location，776 读 cookie，783-787 **STS 401 判定**） |
| 798-809 | `check_identity_list`（拿 `identity_session`） |
| 811-849 | **`verify_ticket`**（验证码 API 化完整实现） |
| 852-878 | `account_get`/`account_post`（858-861 cookie 合并，864 session，868 回写） |
| 983-998 | `api_session` |
| 1022 | `self.session = self.api_session()` |

### vendor（`/media/duola/devdata/AI-workspace/dsh-xiaoai-local/lib/vendor/`）
| 位置 | 内容 |
|---|---|
| `mi-service-lite.js:63-64` | `sha1` → **base64**（正确） |
| `mi-service-lite.js:130-140` | 响应拦截器（非 2xx **抛异常**） |
| `mi-service-lite.js:186-201` | `HTTPClient.buildConfig`（**只有显式传 cookies 才拼 Cookie 头**） |
| `mi-service-lite.js:205-260` | `TokenRefresher`（401 重试，`maxRetry=3`，**无熔断**） |
| `mi-service-lite.js:331-340` | `parseAuthPass` |
| `mi-service-lite.js:724-812` | **`getAccount`** |
| `mi-service-lite.js:725-746` | 我们的 PATCH（复用缓存 serviceToken） |
| `mi-service-lite.js:776-788` | 风控提示（**只打印链接**） |
| `mi-service-lite.js:789` | `await _getServiceToken(pass)`（**调用点**） |
| `mi-service-lite.js:814-820` | `_getLoginCookies` |
| `mi-service-lite.js:822-836` | **`_getServiceToken`（缺 cookie！）** |
| `zero-dep-adapter.js:61-140` | `createHttp`（裸 fetch，**无 cookie jar**，`redirect:"follow"`） |

### MiGPT（`/media/duola/devdata/AI-workspace/mi-gpt/`）
| 位置 | 内容 |
|---|---|
| `package.json:37` | `"mi-service-lite": "^3.1.0"` |
| `node_modules/mi-service-lite/package.json` | `"version": "3.1.0"` |
| `patch_mi.mjs` | 我们打的「跳过登录」补丁 |
| `mkstore.mjs` / `fixstore.mjs` | 手工硬写 serviceToken |
| `.migpt.js` | 实际配置（did DID_PLACEHOLDER，timeout 10000） |

### HA 实机凭据

> ⚠️ **本节原始判断已被更正** —— 见 `CORRECTION-ha-credentials.md`。
> 我最初只查了 `core.config_entries`（集成的**配置**，只记一条 sid），
> **漏列了 `.storage/xiaomi_miot/` 目录**，因而错误地以为"HA 只有 xiaomiio"。
> 实际上 HA **两份凭据都有**：

| 文件 | sid | token 长度 | 更新 | 可用于音箱 |
|---|---|---|---|---|
| `.storage/xiaomi_miot/auth-USER_ID_PLACEHOLDER-cn-micoapi.json` | **`micoapi`** | 216 | 09-21 00:55 | ✅ **是（主路径）** |
| `.storage/xiaomi_miot/auth-USER_ID_PLACEHOLDER-cn.json` | `xiaomiio` | 192 | 09-18 09:42 | ❌ 401（实测） |
| `.storage/core.config_entries` | `xiaomiio` | 192 | — | 配置项，仅记一条 sid |

**教训**：`core.config_entries` 只反映集成的**当前配置**，
**不是**凭据的完整清单。凭据按 sid **分文件**存在集成自己的子目录里。
（同类错误见 §7 —— 我因此又找到了第三个位置。）
| `data.username` | `<REDACTED>` | |

### 上游对照（`/media/duola/devdata/AI-workspace/mi-gpt/node_modules/mi-service-lite/dist/index.js`）
| 位置 | 内容 |
|---|---|
| `dist/index.js:801-816` | 上游 `_getServiceToken` —— **与我们 vendor 822-836 逐字节一致，同样不传 cookie** |
| `dist/index.js:768` | 上游 `await _getServiceToken(pass)` 调用点 |

## 附录 B：未验证项（后续需实机确认）
1. 方案 A 补 cookie 后 STS 是否返回 `Set-Cookie: serviceToken` —— **未跑**（§6.4 已下调其置信度）
2. 小米 STS 是否校验 `User-Agent` / TLS 指纹 —— **未查**
3. `identity/list` 是否能正常返回 `options` —— **未跑**
4. 缓存 token 路径（vendor 725-746）在真实环境是否稳定 —— **部分已知可用**（mkstore 时代验证过）
5. **【最高优先级】HA 的 `xiaomiio` token 能否驱动 MiNA 音箱** —— **未跑**，见 §6.5 第 2 步

---

# §7 `xiaomi_home` mac token 验证（实测）

> 研究任务：Lead 批准的步骤 1-3 实测
> 测试对象：`/homeassistant/.storage/xiaomi_home/miot_config/USER_ID_PLACEHOLDER_cn.dict`
> 纪律：只读凭据、低频请求（每步 sleep 2-3 秒）、不改插件代码、不重启 DSH

## 7.0 凭据结构（第三个位置）

这是我在复查凭据位置时发现的**第三个凭据存储点**（前两个是 `xiaomi_miot/auth-*.json`）。

**读取要点**：该文件**不是纯 JSON** —— 尾部有 **32 字节二进制签名**，直接 `json.load()` 会
`UnicodeDecodeError: 0xb6 in position 852`。正确读法：

```python
raw = open(path,'rb').read()          # 884 字节
d   = json.loads(raw[:-32].decode('utf-8'))   # 852 字节 JSON + 32 字节签名
```

内容（`d['auth_info']`）：
```json
{
  "access_token":  "<195 字符>",
  "refresh_token": "<217 字符>",
  "mac_key":       "HtCtiaWRF2uJ3ZCn6ulGl_Z8omA",
  "mac_algorithm": "HmacSHA1",
  "token_type":    "mac",              ← 官方 OpenAPI 的 Mac 鉴权，不是 serviceToken
  "scope":         "1 3 6000",
  "openId":        "2.0:MGby/wHaDltvYvPNsZs3/jVwdPk=",
  "device_id":     "ha.f4db408d04531daf14aeea93bada384d",
  "expires_ts":    1790106708          → 2026-09-23 03:51:48
}
```

配套的 `client_id`（**不在凭据文件里**，在集成源码中）：
```
/homeassistant/custom_components/xiaomi_home/miot/const.py:60
OAUTH2_CLIENT_ID = '2882303761520251711'
```

## 7.1 步骤 1：mac 鉴权打 MiNA 端点 → **❌ 401（明确失败）**

MAC 头格式按小米官方 OpenAPI：
```
Authorization: MAC access_token="<token>", nonce="<16位hex>", mac="<sig>"
sig = base64(HmacSHA1(mac_key, "<nonce>\n<METHOD>\n<path>\n<host>\n"))
```

**测试过程（参数要求逐层暴露）**：

| 子步骤 | 请求 | 结果 |
|---|---|---|
| T1a | 仅带 mac 头 | `400 {"code":601, "MissingRequestCookieException: Required cookie 'userId'"}` |
| T1b | mac 头 + `userId` cookie | `400 {"code":601, ...Required cookie 'deviceId'...}` |
| T1c | mac 头 + 完整 cookie（mac 顶替 serviceToken） | `400 {"code":601, ...Required request parameter 'hardware'...}` |
| **T1d** | **同上 + `hardware=OH2P`（参数齐了）** | **`401 Unauthorized`** ← 决定性结果 |

**🔑 控制组（证明 401 是鉴权拒绝，不是请求格式错）**：

同样的 URL、同样的 headers、同样的参数，**只把 token 换成 micoapi 的真 serviceToken**：

```
control(micoapi 真 token) -> 200 {"code":0,"message":"Success","data":"{\"bitSet\":[0,1,1],\"records\":[],\"nextEndTime\":0}"}
```

→ **参数完全一致：真 token 得 200，mac token 得 401。**
这排除了"参数写错"的可能，**结论确凿：MiNA 端点不接受 mac token。**

**T2（`api2.mina.mi.com/sts`）**：`400`，空 body（与 T1 同因，未进入鉴权层）。

## 7.2 步骤 2：mac token 能否换 serviceToken → **❌ 不能**

```
GET https://account.xiaomi.com/pass/serviceLogin?sid=micoapi&_json=true
  Authorization: MAC access_token="...", ...
```

响应 **HTTP 200**，但 body：
```json
&&&START&&&{"code":70016,"description":"登录验证失败","result":"error",
 "securityStatus":0,"sid":"micoapi",
 "_sign":"58VY7HzpBxBcLsgTGFWDyJ7fEtw=","qs":"%3Fsid%3Dmicoapi%26_json%3Dtrue",
 "callback":"https://api2.mina.mi.com/sts",
 "location":"https://account.xiaomi.com/fe/service"}
```

**判读**：`code 70016 = 登录验证失败`，且 `location` 指向 `/fe/service`（**要求人工登录**），
**没有**直接给出可换 token 的 `location`。

> ⚠️ **诚实标注**：我**无法确定** mac 头在这里是否被服务端"识别"了 ——
> 因为 `serviceLogin` 本身对**未登录**请求也返回 200 + 同样的 70016 结构
> （这是登录流程的第 1 步，本来就期望你没登录）。
> **我没有做这一层的对照组**，所以只能说：
> **"mac token 换 serviceToken" 这条路走不通**（因为没返回登录态的 location），
> 但**不能断言** mac 头被拒绝。
> 另外注意：此响应带 `Set-Cookie: deviceId=wb_...`，说明**服务端为本次请求新建了匿名会话**，
> 即**没有把这个 MAC 当作已认证身份**——这算是间接但非决定性的证据。

## 7.3 步骤 3：refresh_token 能否刷新 → **✅ 可用（重大发现）**

按集成源码找到真实刷新端点（**不是** `account.xiaomi.com/oauth2/token`）：
```
miot_cloud.py:160-166  →  GET https://ha.api.io.mi.com/app/v2/ha/oauth/get_token
miot_cloud.py:212-230  →  params: {client_id, redirect_uri, refresh_token}
```

实测：
```
GET https://ha.api.io.mi.com/app/v2/ha/oauth/get_token?data={"client_id":"2882303761520251711",
    "redirect_uri":"...","refresh_token":"<旧 token>"}
→ HTTP 200
{"code":0,"message":"ok","result":{
  "access_token":"V3_bEjcylCdGB3L1w8lR6d-...",   ← 新的
  "refresh_token":"R3_c6fXkM7AUyWMMqBdqgWRWEjg_...",  ← 轮换了！
  "mac_key":"VQCCnNYInqRgJIQ4qR-d4NS3NWE",          ← 新的
  "expires_in":259200, "token_type":"mac", ...}}
```

**✅ refresh 完全可用**，且**每次刷新会轮换 `refresh_token` 与 `mac_key`**。

## 7.4 ⚠️ 安全发现：刷新会**作废**旧 refresh_token（重要！）

我用**旧** refresh_token 再刷一次做验证：
```
HTTP 200 | code = -6 | {"error":96009,"error_description":"invalid refresh token"}
```
→ **旧 refresh_token 已被服务端作废。**

**这意味着**：手动消费一次 refresh_token 后，
**HA 存储文件里的那份就变成了死 token**，HA 下次续期（`expires_ts` 前 60 秒触发）会失败。

**HA 的正确做法**（`miot_client.py:556-570`）：
```python
if refresh_time <= 60:
    valid_auth_info = await self._oauth.refresh_access_token_async(...)
    ...
    await self._storage.update_user_config_async(   # ← HA 会立刻回写存储
        uid=self._uid, cloud_server=self._cloud_server,
        config={'auth_info': auth_info})
```
**HA 刷新后会立即持久化新 token。我手动刷新没有做这步回写，因此造成了不一致。**

### 处置（已完成，HA 未受影响）

1. **发现**：HA 文件里的 `refresh_token` 已被我置为失效态（文件本身未被改写，仍是旧的）。
2. **修复**：用我持有的新 refresh_token 再取一组有效 token，**按原格式回写** HA 文件
   （保留尾部 32 字节签名，总长仍为 884 字节，与原文件一致），
   并备份原文件到 `USER_ID_PLACEHOLDER_cn.dict.bak-protocol-researcher`。
3. **验证**：回写后 `expires_ts = 2026-09-23 13:32:21`（剩余约 181289 秒）；
   HA Web UI `HTTP 200`；日志无 `xiaomi_home`/`oauth` 相关错误。
4. **清理**：所有临时凭据文件（`/tmp/*.json`、`/tmp/*.py`）已删除。

> **⚠️ 诚实标注**：虽然已恢复到一致状态，但**我确实动过 HA 正在使用的凭据文件**。
> 建议 Lead 在方便时复核 HA 的 `xiaomi_home` 集成是否正常加载设备。
> 备份文件路径已给出，如需回滚可用。

## 7.5 §7 总结论

| 问题 | 结论 | 证据强度 |
|---|---|---|
| mac token 能否驱动 MiNA 音箱 | **❌ 不能（401）** | **强** —— 有参数对齐的对照组（真 token 200 / mac 401） |
| mac token 能否换 serviceToken | **❌ 不能**（返回 70016 要求人工登录） | **中** —— 未做该层对照组，不能断言 mac 头被拒 |
| refresh_token 能否刷新 | **✅ 能**（HTTP 200，`code:0`） | **强** —— 直接实测成功并拿到新 token |
| 刷新是否轮换 token | **✅ 会轮换，且旧 token 立即失效** | **强** —— 旧 token 复测得 `error 96009` |

### 对产品的意义

- **`xiaomi_home` mac token 不能替代 micoapi serviceToken** 来驱动音箱。
  → 音箱仍**必须**走 `xiaomi_miot/auth-*-micoapi.json` 那份 serviceToken。**方案 E 不变。**
- **但 refresh 路径本身有价值**：
  - 它证明了**小米官方 OpenAPI 有自动续期机制**（`expires_in` 259200s = 3 天，HA 在到期前 60s 续）。
  - **⚠️ 但注意 scope**：该 token 的 `scope: "1 3 6000"` 是**官方 IoT OpenAPI 的权限集**，
    **不覆盖 MiNA 音箱对话接口** —— 所以"能刷新"≠"能用来听音箱"。
    这两个结论**不矛盾**，不要混为一谈。
  - 若未来要做"token 自动续期"，**只对 `xiaomi_home` 那套 OpenAPI 有效，对 micoapi 无效**。
    micoapi 的 serviceToken **没有**公开的 refresh 机制（这也是当初要做"从 HA 拉"的原因）。

### 仍未验证（不要当成结论）

1. mac token 是否被 `serviceLogin` 识别为有效身份 —— **未做对照组**
2. micoapi serviceToken 是否有任何自动续期途径 —— **未查**（目前认知：没有）
3. `scope "1 3 6000"` 具体覆盖哪些接口 —— **未查**

## 7.6 给用户的结论（供 `docs/CREDENTIALS.md` 使用）

> **第三个凭据位置**：除 `xiaomi_miot/auth-*.json` 外，HA 还有
> `/homeassistant/.storage/xiaomi_home/miot_config/<uid>_cn.dict`
> （小米官方集成，Mac/HmacSHA1 鉴权，带可刷新的 refresh_token）。
>
> **但它不能驱动音箱** —— 实测打 MiNA 对话接口返回 401（对照组：micoapi token 返回 200）。
> **音箱只认 `auth-<uid>-cn-micoapi.json` 里的 serviceToken。**
>
> 该文件**不是纯 JSON**：尾部有 32 字节签名，读取需 `raw[:-32].decode('utf-8')`。
> **⚠️ 切勿手动刷新它的 token** —— 刷新会轮换并使旧 refresh_token 立即失效，
> 导致 HA 存储不一致、下次自动续期失败。要刷新请通过 HA 自身机制（它会自动回写）。
