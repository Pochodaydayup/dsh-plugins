# vendor/

## vconsole.min.js

- 上游：[Tencent/vConsole](https://github.com/Tencent/vConsole) v3.15.1
- 来源：`https://registry.npmjs.org/vconsole/-/vconsole-3.15.1.tgz` 里的 `package/dist/vconsole.min.js`
- 许可：MIT（见 `vconsole.LICENSE`，源码头部也保留了原始版权声明）
- 为什么是**打包内置**而不是 CDN：这是个本机工具，可能完全离线 / 内网，
  运行时去拉 CDN 会平白多一个失败点。

它由 Host 半边以 `GET /api/dsh-annotate/vconsole.js` 原样送出，client 半边取到后
用 `executeJavaScript` 注入**页面里**（不是我们的 React 层）—— 所以能抓到页面自己的
console / XHR / fetch / storage，也就绕开了 DSH 给 guest 强制的 `devTools: false`。

升级方式：重新下 tarball，覆盖 `vconsole.min.js`，改这里的版本号。
