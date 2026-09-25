# DSH Desktop 插件：怎么引入、怎么调试

> 这份是**照着做**的清单。架构和 API 细节在主文档
> [dsh-plugin-annotation-guide.md](./dsh-plugin-annotation-guide.md)（尤其 §2 包结构、§18 自己做浏览器）。

---

## 先记住三件事

1. 桌面版跑的 profile 叫 **`desktop`**，而 **CLI 不能管它** ——
   `dsh plugin --profile desktop ...` 会被直接拒绝（desktop 这个名字被 Electron 保留了）。
2. 所以主路径是 **界面里左侧边栏的「插件」页**（英文界面叫 Plugins，
   位置是侧边栏顶部、「新会话」正下方，不是底部）。
3. 另一条路是 **把会话切到「创造模式」**，让 Agent 用 `plugin_manager` 工具帮你装。

---

## 起步骨架：已经建好了

```
annotate-starter/          （就在本文件旁边）
├── package.json        声明这是个 bundle（dsh.bundle.patch）+ 有浏览器半边（dsh.client）
├── cordis.patch.yml    往 profile 里插一行；id 和 name 要唯一/一致
├── index.js            Host 半边：目前是空的，只为了占一行 Loader entry
└── client.js           Client 半边：在输入框工具栏注册一个「标注」按钮
```

它做四件事，用来验证整条链路：
Host 半边被调用 → client.js 被浏览器加载 → 注册 slot → 点按钮往输入框写字。

`client.js` 里点一次按钮会追加一段假标注到草稿**末尾**（绝不覆盖你手写的内容）。

---

## 一、装进去（界面操作，推荐）

1. 打开 DSH Desktop。
2. 左侧边栏**最上面**、「新会话」按钮的正下方，点 **插件**（英文界面是 **Plugins**）。
   ⚠️ 它**不在**侧边栏底部 —— 底部只有 Cordis 面板区和「设置」。
3. 点 **添加插件**（Add plugin）。
4. 输入框里填**绝对路径**（不要加引号）：

   ```
   /Users/zm00138ml/work/AI/dsh-plugins/annotate-starter
   ```

5. 点 **安装**（Install）。Host 会先做一次 `inspect`（读 package.json、确认它声明了 bundle），
   通过后才开始跑 pnpm。
6. 装完点 **立即启用**（Enable now）。

**验证**：回到会话，打开**右侧边栏**，点顶部的 **`+`** → 选 **「标注浏览器」**（这是它唯一的入口；
插件**不往输入框工具栏加按钮**，那一行保持官方原样）。tab 的工具栏是：
后退 / 前进 / 刷新 / 地址栏 / **vConsole**（把调试面板注进页面，**默认就开**）/ **H5**（切到 375px 窄屏宽度）/ **标注**（都是图标按钮）。
打开一个页面，点「标注」，再点页面上的元素，浮层输入框里写批注 —— **回车发送**（Shift+回车换行），
左下角有个 **截图** 勾选框（**默认关**，见下）。发送后会话输入框里出现一个 `标注 · 保存` 的 chip；
**发送消息时** chip 展开成一行：

```
@标注1 · 按钮点不动，应该提交表单
```

两个标注就是两行、中间一个空行。**文字详情不在气泡里**：selector / 坐标 / 页面 URL 存在宿主侧，
模型用 `browser_annotations` 工具按批次读回来。

**勾了截图**时，截图作为**消息附件**跟着消息走 —— 气泡里直接能看到那张图，模型也一起看到；
所以工具不再重复返回同一张图（只在附件挂不上时才兜底用图片块返回）。

> ⚠️ **改 `index.js`（Host 半边）必须重启 App**：它不热重载。宿主没起来时，发送会自动降级成
> 「把元素定位写进那一行」并给你一条 warning —— 信息不丢，只是气泡不好看。
>
> ⚠️ **截图默认关**：`<webview>.capturePage()` 本身没问题，但拿到 `NativeImage` 后**只能用
> `toDataURL()`**，`toPNG()`/`toJPEG()`/`toBitmap()` 会当场把渲染进程打死（详见
> [主指南 §7.1](./dsh-plugin-annotation-guide.md)）。先把文字链路跑通，再勾截图。

> 注意这里有个循环依赖的味道：**必须先装一次（旧版也行）让 bundle 进 profile**，
> `client.js` 才会被扫描加载。之后改 `client.js` 就是 0.5 秒热重载，
> 但改 `package.json`（比如 `dsh.client.inject`）或 `index.js` **要重启 App** 才会重新读。

> 插件页（Plugins）接受四种 spec：包名（可带版本）、**绝对本地路径**、git 地址、tarball。
> 本地路径会被 pnpm 记成 `link:`（软链），所以**目录还在原地**，改代码立刻生效；
> git / npm 装的是快照，改代码要重装。

---

## 二、装进去（让 Agent 干）

1. 新建一个会话（或切当前会话的 agent preset）。
2. preset 选 **「创造模式」**（内部 id 是 `cordis`）。
   只有这个 preset 里 `tool-plugin-manager` 和那三个插件开发技能是开着的
   （`dsh-web-app` 的根 patch 里 `tool-plugin-manager` 默认 `disabled: true`，
   只在 `presets/cordis.patch.yml` 等预设里被打开）。
3. 对它说：

   ```
   把 /Users/zm00138ml/work/AI/dsh-plugins/annotate-starter
   装进当前 profile 并启用
   ```

4. 安装时它可能要求你批准（`install_bundle` 需要 `danger-full-access` 或当次批准）——
   因为**安装的 Host 代码会在本机进程里执行，位于 workspace 沙箱之外**。

创造模式里的 Agent 还能用 `cordis_inspect_query` 查运行时的真实 slot 树、主题 token、
服务方法签名 —— 比自己翻代码快得多。

---

## 三、怎么知道装上了 / 为什么没装上

| 现象 | 含义 |
|---|---|
| 卡片有标题、有 `Enable`/`Disable` 开关 | 装上了 |
| 卡片标 `failed` | fiber 加载失败，卡片上会给诊断信息；Host 侧的报错要从终端看（见下） |
| 卡片标 `overridden` | 有更高优先级的层（比如 `$DSH_HOME/cordis.patch.yml`）覆盖了它 |
| 卡片标 `restart-required` | 改动没热生效，重启 App |
| 卡片标 `not-bundle` | 包的 `package.json` 里没有 `dsh.bundle.patch` |
| 插件页整页显示 **unavailable** | 这个 Host 没有受管 profile（桌面版不应该出现） |

另外 **设置 → 内置插件 → 插件列表**（Settings → Built-in plugins → Plugin list）是只读清单，
能看每个 entry 的 `enabled` 和
`fiberPhase`（`pending` / `loading` / `active` / `failed` / `unloading`）。

---

## 四、调试：五个入口

| 你要看什么 | 用什么 | 怎么打开 |
|---|---|---|
| **Client 半边**：渲染、异常、`slot entry crashed in '...'` | **主窗口 DevTools** | macOS `⌥⌘I`，Windows `F12` |
| **Host 半边**：`index.js` 的 console、加载/配置报错 | **从终端启动 App**，看 stdout/stderr | 见下 |
| 插件激活状态 | 插件页卡片 / 设置 → 内置插件 → 插件列表 | 界面 |
| 崩溃报告 | `~/Library/Logs/DeepSeek Harness/` | Finder（只在崩溃时才有文件） |
| **注入到网页里的脚本** | ⚠️ 打包版里 guest DevTools 是**关**的 | 见「六」 |

**主窗口 DevTools 是开的**（主窗口的 `webPreferences.devTools: true` 是硬编码的）。
菜单里那两个 `toggleDevTools` 项是 `visible: false`，但**快捷键依然有效**，
所以 `⌥⌘I` / `F12` 能直接开。这是你调试 client.js 的主要工具。

**Host 的 console 必须从终端启动才看得到**：

```sh
"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
```

同一个终端会打印 Electron 主进程的 stdout/stderr，也就是 Host 插件的
`console.log` 和报错。从 Finder 双击启动时这些输出你哪里都看不到。

---

## 五、迭代循环：改什么 → 多久生效

| 你改了 | 生效方式 |
|---|---|
| **`client.js`** | **约 0.5 秒自动热重载**，不用重启、不用刷新、不用重新安装 |
| `index.js`（Host 半边） | **必须重启 App** |
| `cordis.patch.yml` / `package.json` | 热生效（profile 配置会重载） |
| 换成新版本的同名包 | 需要重启才能拿到新的 JS module generation |
| 装 / 启用 / 禁用插件 | 热生效 |

**为什么 Host 代码不热重载**：`dsh-base` 里 HMR 那一行的配置是

```yaml
# Profile configuration reloads by default; module roots are opt-in.
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  disabled: !!js "!ctx.get('profileContext')"
  config:
    root: []        # ← profile 配置会重载，但「源码模块」监听默认是空的
```

`root: []` 意味着不监听插件源码目录。想让 Host 的 `index.js` 也热重载，
在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里加：

```yaml
- id: hmr
  disabled: false
  config:
    root: ["/Users/zm00138ml/work/AI/dsh-plugins/annotate-starter"]
```

（改配置本身是热生效的，但 `hmr` 那行官方建议在下一次启动前配好。）

`client.js` 的热重载走的是**另一条路** `dsh-client-hmr`：Host 半边每 500ms 轮询每个
client bundle 的 `mtimeMs`/`ctimeMs`/`size`，一变就 `clientModules.rebuilt(id)`，
再通过 `/plugins/events` 这个 SSE 通道推给浏览器，浏览器重新执行插件并以全新 state 重挂载。
这条是默认开着的。

**所以：开发期把逻辑尽量放在 `client.js`，迭代会快得多。**

---

## 六、最难调试的那个：注入到网页里的脚本

两个限制叠在一起：

1. 打包版里 guest 的 webPreferences 被主进程强制成 `devTools: !app.isPackaged` = **false**
   → **你没法在侧边栏那个 webview 里开 DevTools**。
2. guest 没有暴露给插件的 preload，`window.parent.postMessage` 也到不了 DSH
   → **页面里的脚本没法把日志推回来**。

三个办法，按推荐顺序：

### 1. 先在普通浏览器里把 overlay 脚本调通，再搬进来（推荐）

把注入脚本写成一个**自包含函数**（不闭包任何外部变量），单独建个 HTML 直接跑：

```html
<script>
  // 把 overlayMain 的源码整段贴进来，或者用构建脚本注入
  (function overlayMain() { /* ... */ })();
</script>
```

用 Chrome DevTools 随便调。调好之后整段复制进 `client.js` ——
因为注入用的就是 `executeJavaScript('(' + overlayMain.toString() + ')()', true)`，
源码完全一样，行为一致。这完全绕开了「guest 没有 DevTools」的问题。

### 2. 把调试信息画在页面里

overlay 自己的那个浮层工具条上显示当前状态和最近一次错误。虽然土，但它一定看得见。

### 3. 用 `executeJavaScript` 的返回值回传

让 `read()` 顺带返回一个 `debug` 字段，插件侧 `console.log` 出来，
你在主窗口 DevTools 里看。适合读状态，不适合看连续日志。

**顺带一个坑**：guest 被强制 `disableDialogs: true`，所以
**注入脚本里不能用 `alert` / `confirm` / `prompt`** —— 它们不会弹，也不报错。

---

## 七、常见症状 → 原因

| 症状 | 最可能的原因 |
|---|---|
| 侧边栏里压根找不到「插件」入口 | 位置看错了：它在侧边栏**顶部**「新会话」正下方，不在底部（底部是 Cordis 面板和「设置」）；中文界面标签是「插件」不是 Plugins。若确实没有，开主窗口 DevTools 看 console，并在「设置 → 内置插件 → 插件列表」里查 `ui-plugin-manager` 的 `fiberPhase` |
| 插件页里装成功了，但输入框没有按钮 | 忘了 `Enable`；或 client 半边加载失败 —— 开主窗口 DevTools 看 console |
| DevTools 里出现 `slot entry crashed in 'conversation.input.left'` | 你的组件抛异常了（通常是取服务时 `undefined` 没判空） |
| `throw new Error('... resolved no scope')` | 在非会话上下文里调了 `ctx.sessions.scope(sessionId)` |
| 按钮出现但点了没反应 | 主窗口 DevTools 里看有没有报错（组件抛异常只会显示成 `slot entry crashed`）。注意 `setDraft` **没有** phase 守卫，但 `addFiles` 在 `submitting`/`adjudicating` 时会返回 `false`，要自己判返回值 |
| 改了 `client.js` 没反应 | 确认装的是**绝对路径**（软链）。如果装的是 git/npm 那是快照，改本地文件当然没用 |
| 改了 `index.js` 没反应 | 正常 —— Host 代码要重启 App（见「五」） |
| 卡片标 `failed` | 从终端启动 App 看 Host 报错 |
| 插件列表里找不到自己的插件 | 看 `package.json` 的 `name` 是不是和 `cordis.patch.yml` 里的 `name` 一致 |

---

## 八、这版 starter 已经做到哪一步了

[`annotate-starter/client.js`](./annotate-starter/client.js) 已经按主文档 **§18.5 路线 1** 写成了
「自己注册 tab 类型 + 自己的 `<webview>`」，所以下面这些是**现状**而不是待办：

| 部分 | 怎么做的 |
|---|---|
| 入口 | **只有右侧边栏的 `+` → 「标注浏览器」**（tab 类型的 `guide` 条目）。composer 工具栏不动 |
| 右侧 tab | `ctx.sidebarRightTabs.register({ id, kind, multiple: false, keepMounted: true, guide })` + `sidebar.right.pane.tab` / `.title` 两个 keyed slot |
| 载体 | `globalThis.dshDesktop.browser.acquire(workspaceKey)` → `<webview name partition src="about:blank#lease">`；卸载必须 `release` |
| 工具栏 | 后退 / 前进 / 刷新 / 地址栏 / **H5** / **标注**，全是官方风格的 28px 图标按钮（38px 的条、16px 的 SVG）—— **因为 webview 是我们自己的**（复用官方 Browser tab 做不到，见 §17.2） |
| H5 宽度 | 把 webview 容器收成 `375px` 并居中（`.annotate-viewport.is-h5`）：webview 尺寸 = guest 视口尺寸，所以页面会按窄屏重排、媒体查询正常命中。偏好存 localStorage；浮层定位会把「host 相对 viewport 的偏移」算进去，否则 H5 下浮层会整体偏左 |
| vConsole | 打包版**没法**给 guest 开真 DevTools（DSH 在 `will-attach-webview` 里强制 `devTools: !app.isPackaged`），所以改用 vConsole：Host 用 `GET /api/dsh-annotate/vconsole.js` 把内置的 `vendor/vconsole.min.js`（MIT，3.15.1）原样送出，client 用 `executeJavaScript` 注进**页面**——console / 网络 / 元素 / 存储 都能看。**默认开**（只有显式关过、localStorage 存了 `off` 才不注入；按钮随时可关），在 `dom-ready` 自动注入、页面一导航自动补注入，`about:blank` 载体起点会跳过 |
| 路由安全 | 三条 `/api/dsh-annotate/*` 路由都要求 `x-dsh-annotate: 1` 头：它们是插件自己的 prefix 路由，**不走** web 登录 cookie，否则用户浏览器里任何一个网页都能往批注库 POST（而不用预检的「简单请求」正好能绕过 CORS）—— 批注文字是模型当用户指令读的，那是一条 prompt injection 通道 |
| 标注模式 | 注入自包含 overlay（`overlayMain.toString()`）；悬停高亮 + 点选回读 selector/rect；Esc 双向可退 |
| 输入框 | **画在 React 层**（浮在 webview 上），不画在页面里 —— 页面里的按钮没法通知插件（§17.6） |
| 回读 | 只在「标注模式开启且还没选中」时轮询 250ms，选中/退出立刻停 |
| 发送 | 半方案 D：chip（`标注N · …`，`clipboardText: '@标注'`）由 `codec.serialize` **原地**展开成一行 `@标注N · 你写的批注`；详情不进正文，POST 给宿主侧存起来（`POST /api/dsh-annotate/batch`）。`sendSession(text, …)` 只有一份字符串——**正文里显示的就是模型收到的**，所以想让气泡干净就只有「详情根本不在正文里」这一条路 |
| 宿主存储 | `index.js`：内存仓储 + **落盘**（`~/.dsh/annotate-batches/batch-*.json`，重启后恢复，写盘失败就退化成纯内存）。≤40 批 × ≤60 条、截图 ≤24MB/批，只收回环请求；批次按 `sessionId` 索引，输入框一空（上一条发出去了）就开新批次 |
| 模型侧工具 | `browser_annotations`（可传 `batchId`，省略读当前会话最近一批）：返回一段结构化文字 + **图片内容块**（`webview.capturePage` 的 PNG 经 `attachments.saveImage()` 落成附件）。工具定义是**手写的原始 JSON Schema** —— 因为 `link:` 安装的插件 `import '@deepseek-ai/*'` 会 ERR_MODULE_NOT_FOUND（Node 把软链解析成真实路径），见下 |
| 截图 | 先让页面里的 overlay 把高亮框画出来，再 `capturePage(rect)`（上限 800x600）→ `image.toDataURL()`（**绝不用 `toPNG()`**）。图默认挂成**消息附件**（`conversation.createDrafts` → `shell.addAttachments`）：气泡里可见、模型直接看到；挂不上才退化成 POST 给宿主、由工具用图片块返回。**默认关**，勾了才截 |
| 模型怎么知道 | `ctx.systemPrompt.section({ name: 'plugin:dsh-annotate', order: 180, text: … })` 注入一段说明：看到 `@标注N` 就先调工具 |
| 气泡渲染 | 用户气泡**不是纯文字**：`h` 里的 `@标注N` 会被 `projectUserText` 投影成一个**可点的引用 chip**（文件图标，点了会 `openFile('标注N')`）。想变成纯文字就把 `NOTE_CHIP` 设 false。另外两条「藏定位」的路都堵死：HTML 注释会被**当文字渲染**（渲染器 `case "html": return node.value`），假 `dsh-session:` URI 会被 `parseSessionReferenceText` **直接 throw** |
| 热重载 | tab 的 `navigation.params` 事后改不了，所以最后地址另存 `localStorage`，改 `client.js` 重挂载后接着看原来那页；**改 `index.js` 要重启 App** |

**这个插件为什么一个 `@deepseek-ai/*` 都不 import**：它是 `link:` 安装的，Node 会把软链解析成真实路径
（实测 `import.meta.url` 就是 `/Users/.../annotate-starter/index.js`），而那条路径下没有 `@deepseek-ai/*`
→ `import '@deepseek-ai/dsh-tools'` 直接 `ERR_MODULE_NOT_FOUND`。所以宿主半边改成「手写工具定义 +
一切从 ctx 上取」（`webServer` / `tools` / `systemPrompt` / `attachments`）。
想用官方 SDK 类型/`defineTool` 的话，就别用 `link:`，改用 `dsh plugin add <npm 包>` 或 git 安装。

想继续加的东西：

- **批注列表**：把已发送的标注渲染进 `conversation.input.dock`（输入框上方那块），做逐条删除 / 点回定位；
- **把截图钉死**：抓一次 `crash-*.log` 里的 stage 行（`capture:start` / `capture:resolved` / `shot-post:start`）就能定位是 `capturePage` 本身还是随后的 POST；
- **`browser_annotations_resolve`**：像 `@nono-neko/dsh-browser` 那样加一个「标记已解决」的工具，工具默认读「最近一批未解决」；
- **多实例**：把 `multiple: false` 改成 `true` 就能开多个标注页（代价是每次都要从 `+` 里选一次）；
- **只叠加在官方 Browser 上**：如果你不想维护外壳，就按主文档 §6–§8 复用官方 webview，那个更省事但要接受「工具栏没有扩展点」。

