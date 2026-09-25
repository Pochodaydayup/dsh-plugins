# dsh-plugins

[DSH（DeepSeek Harness）](https://github.com/deepseek-ai) 的本地插件集合。每个目录是一个独立插件包，
通过 App 的 **设置 → 插件 → 安装** 填**绝对路径**装进 profile（pnpm 记成 `link:`，所以改代码就地生效）。

| 插件 | 干什么 | 入口 |
|---|---|---|
| [`annotate-starter/`](./annotate-starter) | 右侧边栏的「标注浏览器」tab：自建 webview，点页面元素写批注；消息正文只留一行 chip，详情（选择器/坐标/截图）存宿主侧，模型用 `browser_annotations` 工具读回 | 右侧边栏 `+` → 标注浏览器 |
| [`git-ship/`](./git-ship) | 输入框上方的「提交并推送」：点一下**直接**发一条正文只有 `@提交并推送` 的消息，由 AI 分析本次对话的改动后执行 `git add/commit/push` | 输入框上方那一条 |

文档：[`QUICKSTART.md`](./QUICKSTART.md) 上手流程；[`dsh-plugin-annotation-guide.md`](./dsh-plugin-annotation-guide.md)
是插件机制的**实测记录**（chip/reference 机制、dock 插槽对齐、`nativeImage` 崩溃、
`link:` 安装不能 `import '@deepseek-ai/*'` 等等，都是踩过的坑）。

## 装之前先体检

```bash
node check-manifests.mjs          # 或 pnpm exec check-manifests.mjs
```

它检查每个插件的 manifest 契约。**最要紧的一条**：声明了 `dsh.client` 就必须能解析出
`exports["./client"]` —— 少了这个字段，`dsh-client-modules`（必需插件）激活失败，
App 会在启动阶段直接退出，而不是「插件不工作」：

```
client-modules: @local/dsh-git-ship declares dsh.client but exports no "./client" bundle
→ dsh: startup failed: 1 required plugin did not activate
```

还检查：`exports["."]` 存在、client bundle 的 `__ModuleLoader__.load({ id })` 等于包名、
`dsh.client.platform`、`client.inject` 用完整包名、bundle patch 文件存在且 name 一致、
Host 半边没有 `import '@deepseek-ai/*'`（`link:` 安装时那条路径下没有这些包）。

## 开发时记住两件事

1. **`client.js` 改完约 0.5 秒热重载**（改到能看见效果不用重启）；
2. **`index.js`（Host 半边）改完必须重启 App** —— 而且 `package.json` 的改动同样要重启。

> 首次安装仍然需要一次重启：Loader 要在启动时读到新的 entry 行与 client bundle。
