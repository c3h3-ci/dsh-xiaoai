# legacy/ —— 已被插件取代的早期实现

| 文件 | 说明 |
|---|---|
| `daemon.js` | 最早的独立守护进程版（插件之前的设计） |
| `bridge.js` | 早期尝试的 in-process 会话桥（已并入 `src/runtime.js`） |

保留仅作参考。**生产路径是 DSH 插件**（`src/index.js` + `src/rpc.js` + `src/runtime.js`）。
