# DSH 插件开发指南 —— 以「浏览器页面标注 → 输入框」为例

> 目标形态：在 DSH 右侧边栏 **Browser** 标签里打开你自己的页面，点选页面上不对的元素、写一句「哪里不对、想改成什么」，
> 一键把这些批注变成一段 Markdown 灌进下方输入框（composer），然后照常发给 Agent。
>
> 本文只讲机制、API、slot 选型和关键代码片段，不含完整实现（按你的要求）。
> 所有结论都来自本机运行中的 DSH Desktop `0.1.7-rc.1`（`/Applications/DeepSeek Harness.app` 内的 `app.asar`），
> 不是推测。涉及的包源可在 `~/.dsh/profiles/node_modules/@deepseek-ai/` 下直接读到（该目录是软链，指向 nvm 全局 `@deepseek-ai/dsh` 安装）。

---

## 0. 一句话架构

```
┌─ DSH 主窗口 (127.0.0.1:19387，Electron BrowserWindow，webviewTag: true)
│
│  ┌─ 你的 Client 插件 (client.js，纯浏览器 JS，无 Node)
│  │    ① 在 composer 工具栏注册一个「标注」按钮  → slot: conversation.input.left
│  │    ② 找到右侧 Browser 里那个 <webview> 元素
│  │    ③ webview.executeJavaScript(OVERLAY_SRC)   ← 唯一能进到页面里的通道
│  │    ④ webview.executeJavaScript('__DSH_ANNOTATE__.read()')  ← 唯一能取回数据的通道
│  │    ⑤ 拼 Markdown，写进输入框 (conversation.input.for(actx).setDraft)
│  └─
│
│  ┌─ 右侧边栏 Browser tab (官方包 dsh-client-ui-sidebar-browser)
│  │    Desktop = Electron <webview>          ← 标注目标在这里
│  │    Web     = <iframe sandbox>            ← 另一套方案，见 §12.7
│  │    <webview> 的 guest 强制：sandbox / contextIsolation / nodeIntegration:false
│  │                              / disableDialogs:true / devTools 打包版关闭
│  └─
└─
```

**Host half（index.js）在这个方案里是空的**，只需要存在，让这个包能占一行 Loader entry。
真正干活的全在 client.js。

---

## 1. 插件模型：profile / bundle / patch

DSH 用 [Cordis](https://github.com/deepseek-ai/deepseek-harness) 做依赖注入 + 插件加载，配置是一层层 YAML patch 叠加出来的。

```
$DSH_HOME/profiles/<profile>/
├── package.json          # dsh.profile.bundles = 有序的 bundle 列表
├── cordis.yml            # profile 根，永远是空数组，不要改
├── cordis.patch.yml      # 你自己的 patch 层，在这里插入/覆盖/禁用插件行
└── node_modules/         # pnpm 装进来的第三方 bundle
```

当前会话跑的是 `desktop` profile：

```bash
$ echo $DSH_PROFILE $DSH_PROFILE_DIR
desktop /Users/zm00138ml/.dsh/profiles/desktop
```

`~/.dsh/profiles/desktop/package.json` 里 `dsh.profile.bundles` = `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`，所以桌面版和 Web 版共用同一套 Web 前端 —— **给 Web 写的客户端插件在桌面版一样跑**。

**叠加顺序**（后者覆盖前者）：

```
每个 bundle 的 patch（按 bundles 顺序）
  → profile/cordis.patch.yml
  → $DSH_HOME/cordis.patch.yml
  → --patch 命令行 overlay
```

patch 语法（Loader YAML 方言）：

```yaml
# 追加一行插件
- insert:
    - id: annotate                 # 行 id，全局唯一，patch 用它定位
      name: '@local/dsh-annotate'  # 包名（或 patch 文件旁的相对路径）
      config: {}                   # 该插件 Config schema 校验过的配置

# 覆盖已有行的配置（注意：config 是整体替换，不是深合并）
- id: ui-conversation
  config: { ... }                  # 必须把需要的字段全部重写

# 开关已有行
- id: ui-sidebar-browser
  disabled: false                  # 或 !!js 表达式
```

---

## 2. 一个插件包长什么样

你这种「纯 UI + 一点点注入」的插件，四个文件就够了（官方模板 `templates/decoration/` 就是这个形状）：

```
dsh-annotate/
├── package.json
├── cordis.patch.yml
├── index.js        # Host half
└── client.js       # Client half（浏览器）
```

### 2.1 `package.json`

```json
{
  "name": "@local/dsh-annotate",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-sidebar-right"
      ]
    }
  }
}
```

| 字段 | 作用 |
|---|---|
| `dsh.bundle.patch` | 声明这是个 bundle；路径指向 patch 文件，可以是数组（按序应用为一层） |
| `dsh.client.platform` | `web`。Host half 只负责占位，浏览器 half 才是 UI |
| `dsh.client.immediately` | 启动时就加载这个 bundle。去掉则懒加载（第一次被用到才拉） |
| `dsh.client.inject` | **只用于排序激活顺序**：保证 conversation / sidebar-right 先激活。不是模块依赖，也不会把它们的 API 塞给你 |
| `dsh.client.external` | 需要额外非基线模块时才写。自定义插件一般不需要 |
| `icon`（顶层）+ `locale/en.json`、`locale/zh.json` 里的 `meta.title` / `meta.description` | 插件管理页的卡片显示，**不激活插件就能读到**。`icon` 是相对 manifest 目录的路径，支持 SVG/PNG/JPEG/WebP 且 ≤256 KiB；绝对路径、URL、目录外路径、指向目录外的软链都会被拒。缺字段时回落成 `package.json` 的 `name` / `description` 和默认图 |
| `dsh.manifestVersion` | 可选，当前格式是 `1` |

### 2.2 `cordis.patch.yml`

```yaml
- insert:
    - id: annotate
      name: '@local/dsh-annotate'
```

### 2.3 `index.js`（Host half，空实现）

```js
/** Host 半边：这个方案里不做任何事，只为了让包占一行 Loader entry。 */
export function apply() {}
```

### 2.4 `client.js`（Client half）

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-annotate',          // 必须 == 包名
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // ... 组件与注入源码
    return {
      inject: ['slots', 'conversation', 'sidebarRight', 'sessions'],
      apply(ctx) {
        // 在这里注册一切，用 ctx.effect / ctx.on 并返回清理函数
      },
    };
  },
});
```

---

## 3. Client 插件的加载契约

这是最容易踩坑的一环，把机制讲清楚：

- Host 半边扫描所有**已启用**的 Loader entry，把声明了 `dsh.client` 的包合成为一张 **boot graph**，作为 `window.__DSH_BOOT__` 注进页面。
- 每个插件的 `client.js` 从 `/plugins` 路由按需拉取（combo URL，`?rev=<mtime+ctime+size>`）。
- **执行 bundle 只做一件事：注册 factory**。所有副作用（含 CSS 注入）都写在 `factory(require)` 闭包里，等到真正物化时才跑。
- 模块解析顺序：平台种子表 → 已物化的记录 → boot graph 行 → 已注册的 factory，**查不到就 throw**。
- 平台种子表（`PLATFORM_MODULES`，冻结）只保证：**React、Cordis、若干静态 UI 库**。

由此推出三条硬规则：

1. `require('react')` 可以，`require('react-dom')` 一般也可以；**绝不能 `require('@deepseek-ai/dsh-client-ui-primitives')` 或任何其他 DSH Client 包**。这些包会变，而你写的插件没有类型检查；一旦某个组件 throw，整个 slot entry 会白屏，控制台只留一句 `slot entry crashed in '<slot>'`。
   想要按钮/开关/弹层，就把宿主组件的 markup + CSS 抄进你自己的插件，类名前缀换成自己的，配色只留 `--dsw-alias-*` token。
2. `factory` 里**不要有副作用**。注册样式、监听器、定时器都放 `apply(ctx)`，用 `ctx.effect(() => { ...; return dispose })`。
3. 循环 require 会 throw（factory 形式的 CJS 交不出部分导出）。

---

## 4. Slot 系统：唯一合法的 UI 扩展点

`@deepseek-ai/dsh-client-ui-slots` 是 UI 组合的核心。要点：

- **声明即认领**：父组件声明一个 slot，就它是唯一有权渲染该 key 的条目。
- 往**未声明**的 slot 注册 → 加载时 throw。
- 四种 kind：`single`（一个占位者）、`list`（有序条目，**你要用这个**）、`keyed`（按键分派）、`chain`（条目自行提名）。

### 4.1 注册写法

```js
ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
  name: 'conversation.input.left',
  id: 'annotate',          // 在这一格里的唯一 id
  order: 10,               // list 排序，数字越小越靠左/靠前
  // locale: 'annotate',   // 只有你自带了 locale 命名空间才写；v1 建议省略、文案直接硬编码
  inject: (sessionId) => ({ /* 你想塞给组件的 props */ }),
}, MyButton));
```

`ctx.slots.inject(ownerKey, cb)` 的语义：**回调里的注册会随所属声明一起被销毁，声明回来时重新安装**。所以注册逻辑必须写在回调里，不能在 `apply` 里直接 `ctx.slots.register`。

### 4.2 `inject(sessionId)` —— 把能力喂给组件

这是官方包自己也在用的模式。看 `conversation.input.dock` 里 `queue` 那一条（来自 `dsh-client-ui-conversation`）：

```js
inject: (sessionId) => {
  const actx = ctx.sessions.scope(sessionId);
  if (actx === undefined) throw new Error(`dock: session "${sessionId}" resolved no scope`);
  const conversation = actx.get('conversation');
  if (conversation === undefined) throw new Error('dock: conversation service unavailable');
  return {
    updateQueue: (itemId, action) => conversation.updateQueue(itemId, action),
    notify: (level, text) => conversation.input.for(actx).notify(level, text),
  };
}
```

注意 `ctx.sessions.scope(sessionId)` → `actx.get('conversation')`：**会话级服务要这样取**，不能用根 ctx。

### 4.3 和本需求相关的 slot 清单

| slot | kind | scope | 用途 / 建议 |
|---|---|---|---|
| `conversation.input.left` | list | session | 输入框工具栏**左侧**按钮区（`conversation.input.model` 左边）。**放「标注」按钮的最佳位置** |
| `conversation.input.right` | list | session | 输入框工具栏右侧按钮区 |
| `conversation.input.dock` | list | session | 输入框**上方整块区域**，官方 `todo`(order 0) / `queue`(order 20) 用这里。适合放**批注列表 / 预览** |
| `conversation.composer.dock` | list | session | composer 下方 dock（官方装饰模板默认选它） |
| `conversation.input.overlay` | list | session | 覆盖在 composer 卡片上的浮层锚点 |
| `shell.overlay` | list | root | **整个应用窗口的浮层**。做「全屏标注模式」的遮罩/工具条用这个 |
| `conversation.composer.bar` | single | session-maybe | 已被占用，不能注册 |
| `conversation.input.model` / `.plan` / `.permission` / `.activity` / `.attachments` | single | session | 都是 single，已被占用 |

> 完整 slot 表可以自己扫一遍：`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-*/lib/client.js`
> 里搜 `slots.register({ name: "..."`（我扫到 77 个）**和** `children: { "..." }`（只以 children 形式声明的，比如
> `conversation.input.left/right`，不在那 77 个里）。
>
> 更省事的办法：切到 **Creator mode**（见 §13），直接让 Agent 用 `cordis_inspect_query` 查 `Slots.listSubTree` —— 那是运行时的权威答案，包含每个 slot 的 kind、scope、props。

### 4.4 组件能拿到什么 props

每个 slot 组件都会收到**五份框架 props**：

1. **运行时 share** —— 父级 render 调用点的 `owner`、会话标准工具包（`useSession`、`useInput`、`useProjection`、`renderSlot`、`t`、`sessionId` …）、全局席位；
2. **child-render share** —— 静态缩窄到已声明 children 的 `renderSlot`；
3. **Factory-render share** —— `renderFactorySlot`；
4. **store share** —— 你声明的 handle 的 selector hook + 去掉 draft 的 actions；
5. **业务 share** —— 从你的 `inject` 推导出来的。

以 `conversation.input.left` 为例，你能确定拿到 `sessionId`、`useInput`，加上你 `inject` 返回的东西。
想精确知道某个 slot 给什么 props，就是 §4.3 末尾说的那两种查法。

---

## 5. 核心 API A：把文字写进输入框

这是「发给输入框」那一步。链路是：

```
ctx.sessions.scope(sessionId)        → 会话级 ctx (actx)
actx.get('conversation')             → conversation 服务
conversation.input.for(actx)         → SessionInputShell（per-session 输入门面）
shell.setDraft(text)                 → 整体替换草稿（光标落到末尾，进 undo 历史但不是独立一步）
shell.actions.insertText(text, span) → 在光标处插入（需要先 actions.captureInsertion()）
shell.actions.submit()               → 直接提交
shell.notify(level, text)            → 在输入框附近弹一条提示
```

`SessionInputShell` 的公开面（源码注释原文：*"The per-session input facade: scoped-event application verbs + setDraft/submit + the published InputState store, over a shell-owned Lexical editor"*）：

```ts
shell.state        // 已发布的 InputState store（draft / attachmentIds / phase ...）
shell.snapshot     // 当前快照：{ draft, draftRev, attachmentIds, phase, ... }
shell.actions = {
  captureInsertion(): { ...span, draftRev },
  insertText(text, span): boolean,   // span.draftRev !== 当前 rev 时返回 false
  setDraft(text): void,
  addAttachments(ids), removeAttachment(id), pruneAttachments(ids),
  submit(): void,
}
```

### 5.1 推荐写法（追加一段 Markdown 到现有草稿）

```js
inject: (sessionId) => {
  const actx = ctx.sessions.scope(sessionId);
  const conversation = actx.get('conversation');
  const shell = conversation.input.for(actx);

  return {
    /** 追加一段文本到输入框（保留用户已输入的内容）。 */
    appendToComposer(block) {
      const current = shell.snapshot.draft;
      shell.setDraft(current === '' ? block : `${current}\n\n${block}`);
      return true;
    },
    /** 在光标处插入（不覆盖已有内容）。 */
    insertAtCaret(block) {
      const span = shell.actions.captureInsertion();
      const ok = shell.actions.insertText(block, span);
      if (!ok) shell.setDraft(`${shell.snapshot.draft}\n\n${block}`); // rev 变了就退回追加
      return ok;
    },
    notify: (level, text) => shell.notify(level, text),
  };
}
```

### 5.2 两个备选面（按需选）

- **Conversation store**：草稿会持久化到 `localStorage` 的 `dsh.conversation.<sessionId>`，`actions.setDraft(d, text)` 是同一份草稿的另一入口。**不要自己 `defineStore` 一个同 key 的 handle** —— 同一个共享句柄挂到两个 scope 下会在加载时 throw。
- **`ctx.conversation.send(text)`**：直接以 `queue` 模式发一条用户消息，不走输入框。**你明确要「发给输入框」，所以用 §5.1，不要用这个。**

> 想让输入框里出现的是 **UI 组件**（chip / 附件卡片）而不是一段文字，从而不污染手写内容？见 **§15**。

---

## 6. 核心 API B：找到侧边栏 Browser 里那个页面

### 6.1 载体

官方包 `@deepseek-ai/dsh-client-ui-sidebar-browser`（Desktop 默认启用；Web profile 默认关闭）：

| 平台 | 载体 | 元素标记 |
|---|---|---|
| Desktop | Electron `<webview>` | `data-sidebar-browser-frame="webview"` |
| Web | `<iframe sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox">` | `data-sidebar-browser-frame="iframe"` |

元素的创建代码（`ElectronWebviewPresentation.createElement`）：

```js
const element = document.createElement('webview');
element.className = Browser_module_css_default.webview;
element.dataset.sidebarBrowserFrame = 'webview';
element.setAttribute('name', reservation.lease);      // lease id
element.setAttribute('partition', reservation.partition);
element.setAttribute('allowpopups', '');
element.setAttribute('src', 'about:blank#' + reservation.lease);
```

### 6.2 定位「当前可见、属于当前会话」的那个 webview

右侧栏是个 docking 系统，**保留的 tab 会 keepMounted**——DOM 里可能同时存在多个 `<webview>`，非活动的藏在 `[hidden]` / `[aria-hidden="true"]` 下面。官方自己定位 pane 的 DOM 契约（`sidebar-right` 的 `visibleSidebarPane` / `sidebarTargetFromElement`）：

```
[data-sidebar-right-session="<sessionId>"]        会话的侧栏根
  [data-dockkit-pane] / [data-dockkit-float]      一个 pane（浮动窗是 -float）
  [data-dockkit-pane-active] / [data-dockkit-float-active]   当前活动 pane
  [data-dockkit-tab] / [data-sidebar-right-tab]   一个 tab
  [data-sidebar-right-occurrence]                 tab 的 occurrence 标记
```

据此写定位函数：

```js
/** 找到当前会话、当前活动 pane 里那个可见的 Browser webview。 */
function activeBrowserWebview(sessionId, sidebarRight) {
  // 属性选择器的值用 JSON.stringify 引起来，比 CSS.escape 更稳妥（后者是给标识符用的）
  const owner = document.querySelector(`[data-sidebar-right-session=${JSON.stringify(sessionId)}]`);
  if (owner === null) return undefined;

  const panes = [...document.querySelectorAll('[data-dockkit-pane], [data-dockkit-float]')]
    .filter((pane) => pane.closest('[data-sidebar-right-session]') === owner
      && pane.closest('[hidden], [aria-hidden="true"]') === null
      && (pane.hasAttribute('data-dockkit-float') || owner.hasAttribute('data-sidebar-right-open')));

  const pane = panes.find((p) => p.hasAttribute('data-dockkit-pane-active')
      || p.hasAttribute('data-dockkit-float-active')) ?? panes[0];
  if (pane === undefined) return undefined;

  const frame = pane.querySelector('webview[data-sidebar-browser-frame="webview"]');
  if (frame === null) return undefined;

  // 再用官方控制器复核一次：拿到的 target 必须属于这个会话
  const target = sidebarRight.focusedTarget(frame);
  if (target === undefined || target.sessionId !== sessionId) return undefined;
  return frame;
}
```

`ctx.sidebarRight` 是官方导航控制器，与本需求相关的公开方法：

| 方法 | 说明 |
|---|---|
| `openTab(kind, options?)` | 打开一个 tab；Browser 的 kind 是 `'browser'`，参数走 `options.params.url` |
| `openResource(address, options?)` | 打开 `dsh-resource://…` 资源（文件、diff…） |
| `active()` | 读当前活动 tab |
| `focus(tabId)` / `split(paneId?)` / `float(tabId, rect?)` / `dock(paneId)` | 布局操作 |
| `isExpanded()` / `toggleExpanded()` | 列的展开态 |
| `focusedTarget(element?)` | **从 DOM 元素反解出 `{ sessionId, paneId, host, tabId, occurrence, navigationRevision }`**；元素不可见/在外部则返回 `undefined` |
| `commandTarget(element?)` | 同上，但允许外部打开落到当前会话的活动 dock pane |
| `isTargetCurrent(target)` | 校验 target 是否还有效（会话变了 / tab 被移动重开 / 中间发生过导航） |
| `mounted` | 当前在屏的会话（observable） |

所以「打开页面」就一行：

```js
ctx.sidebarRight.openTab('browser', { params: { url: 'http://localhost:5173/' } });
```

> 校验用 `isTargetCurrent` 比 `focusedTarget` 更严格，**异步流程里请在真正操作前再查一次**。

---

## 7. 核心 API C：把标注 UI 注入页面

### 7.1 通道

Desktop 的 guest 被主进程强制成：

```js
// /lib/main.js，主窗口 will-attach-webview 处理器
nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
contextIsolation: true, sandbox: true, webSecurity: true,
allowRunningInsecureContent: false, webviewTag: false,
plugins: false, navigateOnDragDrop: false,
disableDialogs: true,            // ← alert/confirm/prompt 全部失效
devTools: !app.isPackaged,       // ← 打包版里 guest 开不了 DevTools
params.httpreferrer = '';
```

**没有 preload 暴露给插件，`window.parent.postMessage` 在 webview 里也到不了 DSH 页面**（webview guest 没有嵌套浏览上下文，`window.parent === window`）。

唯一可用的双向通道是 **`<webview>` 元素自己 = `WebviewTag` API**：

```js
await frame.executeJavaScript(code, /* userGesture */ true)   // 注入并执行，返回 Promise<结果>
frame.getURL()                                                // 当前地址
frame.isLoading()
await frame.capturePage(rect)                                 // NativeImage 截图 —— ⚠️ 见下
frame.addEventListener('dom-ready' | 'did-navigate' | 'did-fail-load' | 'page-title-updated', fn)
```

### 想给页面加 DevTools？打包版被宿主堵死了（用 vConsole）

DSH 在 `will-attach-webview` 里**强制覆盖** guest 的 webPreferences，其中一行是
`devTools: !app.isPackaged` —— 装好的 `.app` 里 `isPackaged === true`，所以：

- `<webview>.openDevTools()` / `inspectElement()` 确实在 `webview-tag` 的方法白名单里，
  **开发版（未打包）一调就开**；打包版调用会被主进程静默忽略（`isDevToolsOpened()` 永远 false）；
- `devTools` 是创建时定死的，**没有**「事后打开」的 API；
- 想真开就只能在 DSH 那一行动手（或者让官方做成设置项）。

绕开它的办法是**把调试面板注进页面**（它只是页面 JS，与 `devTools` 开关无关）：

```js
// 源码从插件自己的路由取（离线可用，不依赖 CDN）
const source = await (await fetch('/api/dsh-annotate/vconsole.js')).text();
await frame.executeJavaScript(source + '\n;true');            // UMD：挂上 window.VConsole
await frame.executeJavaScript('new VConsole({ theme: "dark" })');
```

几条实测经验：

- 注入**分两段**发：UMD 尾巴上可能是行注释，把 `new VConsole()` 拼在后面会被注释吃掉；
- 页面一导航注入就没了，要在 `dom-ready` 补一次（用 **ref** 读开关状态，
  否则这个监听器会被绑到状态上、每次切换都重建整个 webview）；
  载体的起点 `about:blank#<lease>` 也过一次 `dom-ready`，那一次可以跳过（省一次 286KB，
  也免得空白页上闪个悬浮球）—— 默认开的话这一步很值得做；
- vConsole 抓不到**它创建之前**的日志（Network 面板倒是能抓到之后的所有 XHR/fetch）；
- 想调 H5，就和「H5 宽度」开关一起用：窄屏 + vConsole = 手机端那套调试体验。

`vendor/vconsole.min.js`（286KB，MIT）直接内置进插件，不走 CDN —— 这类工具常常在离线 /
内网环境跑，运行时多一个网络依赖就是多一个失败点。

> ⚠️ **`capturePage()` 能用，但拿到 `NativeImage` 之后只能用 `toDataURL()`，千万别用 `toPNG()` / `toJPEG()` / `toBitmap()`。**
>
> 实测（Electron 44.0.0 / dsh-desktop 0.1.7-rc.2）：`capturePage(rect)` 正常 resolve，
> 但紧接着 `image.toPNG()` 会**把 Desktop 渲染进程直接打死**（`EXC_BREAKPOINT` / SIGTRAP，
> 崩溃栈停在 `v8::ValueSerializer::WriteRawBytes`，DSH 记 `Desktop renderer exited: crashed`）。
>
> 原因在 Electron 源码 `shell/common/api/electron_api_native_image.cc`：
> ```cpp
> ToPNG()     → electron::Buffer::Copy(isolate, png_span)   // 造一个 Node Buffer
> ToDataURL() → webui::GetBitmapDataUrl(bitmap)             // 只返回 std::string
> ```
> 主窗口渲染进程是**沙箱化**的（没有 Node 环境），构造 Node `Buffer` 那一步就炸了 ——
> `WriteRawBytes` 正是把 PNG 字节往新 Buffer 里拷。所以：
> ```js
> const image = await frame.capturePage({ x, y, width, height });
> const dataUrl = image.toDataURL();                 // "data:image/png;base64,…"
> const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
> ```
> 另外两条经验：**加阶段标记时用 `console.error`** —— DSH 只把 error 级的渲染进程日志收进
> `~/Library/Logs/DeepSeek Harness/crash-*.log`，渲染进程一崩，这是唯一能看出死在半步的证据；
> 以及**把危险调用放在最后一步**（先落文字 / 先插 chip，再截图），崩了也只丢图。

主窗口 `webviewTag: true`（`createWindow(preload, show, primary)` 里主窗口传 `primary = true`），所以**任何在 DSH 渲染进程里跑的脚本——包括你的插件——都能拿到这个元素并调用 `executeJavaScript`**。

`executeJavaScript` 返回值必须能跨进程序列化：**只返回纯 JSON，不要返回 DOM 节点、函数、Map**。

### 7.2 注入 + 读回

```js
const SRC = `(${overlayMain.toString()})()`;   // 见 §8

/** 确保页面里有标注器；已装则直接返回。 */
async function ensureOverlay(frame) {
  return frame.executeJavaScript(
    `(function () {
       if (window.__DSH_ANNOTATE__ && window.__DSH_ANNOTATE__.version === 1) return true;
       ${SRC}
       return true;
     })()`, true);
}

/** 取回当前批注（纯 JSON 数组）。 */
async function readAnnotations(frame) {
  return frame.executeJavaScript(
    `(window.__DSH_ANNOTATE__ ? window.__DSH_ANNOTATE__.read() : [])`, true);
}

/** 进入/退出点选模式。 */
const setPicking = (frame, on) =>
  frame.executeJavaScript(`window.__DSH_ANNOTATE__.setPicking(${on})`, true);

/** 收工，把页面恢复原样。 */
const uninstall = (frame) =>
  frame.executeJavaScript(
    'window.__DSH_ANNOTATE__ && window.__DSH_ANNOTATE__.uninstall(), true', true);
```

`overlayMain.toString()` 这个技巧值得用：注入脚本在源码里是**普通函数**，可读、可 lint、可 grep，
运行时才序列化成字符串。代价是它**不能闭包任何外部变量**——必须自包含。

### 7.3 导航会清掉注入

`executeJavaScript` 的产物活不过页面导航。所以：

```js
// 在组件/effect 里
const onLoaded = () => { if (pickingRef.current) ensureOverlay(frame).then(() => setPicking(frame, true)); };
frame.addEventListener('dom-ready', onLoaded);
frame.addEventListener('did-navigate', onLoaded);
return () => {
  frame.removeEventListener('dom-ready', onLoaded);
  frame.removeEventListener('did-navigate', onLoaded);
};
```

注意 SPA 内部路由（history.pushState）**不触发** `did-navigate`；这种情况注入还在，不用管。

---

## 8. 注入脚本（overlay）设计

关键约束：**`disableDialogs: true`（不能用 alert/confirm）、guest DevTools 打包版关闭（不能靠 console 调试）、与页面共享 main world（要防命名冲突）**。

推荐把状态挂在 `window.__DSH_ANNOTATE__` 上，只暴露一个 JSON-ish 的 API 对象。骨架：

```js
function overlayMain() {
  const NS = '__DSH_ANNOTATE__';
  const prev = window[NS];
  if (prev && prev.version === 1) return;      // 幂等
  if (prev && typeof prev.uninstall === 'function') prev.uninstall();

  const HOST_ATTR = 'data-dsh-annotate-host';   // 我们自己的 DOM 都打这个标记
  const state = { version: 1, picking: false, items: [], seq: 0 };
  const cleanups = [];

  // ---- 样式：用最高 z-index + !important，避免被页面样式吃掉
  const style = document.createElement('style');
  style.setAttribute(HOST_ATTR, '');
  style.textContent = `
    [${HOST_ATTR}]{position:fixed;z-index:2147483647;box-sizing:border-box;
      font:12px/16px -apple-system,system-ui,sans-serif}
    [${HOST_ATTR}="outline"]{pointer-events:none;outline:2px solid #4d6bfe;
      background:rgba(77,107,254,.12);transition:all .05s}
    [${HOST_ATTR}="picked"]{pointer-events:none;outline:2px solid #ffb020;
      background:rgba(255,176,32,.15)}
    [${HOST_ATTR}="panel"]{background:#fff;color:#111;border-radius:8px;
      box-shadow:0 8px 32px rgba(0,0,0,.28);padding:8px;width:260px}
    [${HOST_ATTR}="panel"] textarea{width:100%;height:56px;resize:vertical;
      border:1px solid #ddd;border-radius:6px;padding:4px;font:inherit;box-sizing:border-box}
    [${HOST_ATTR}="bar"]{right:16px;bottom:16px;background:#111;color:#fff;
      border-radius:999px;padding:6px 12px;display:flex;gap:8px;align-items:center;cursor:default}
    [${HOST_ATTR}="badge"]{background:#4d6bfe;border-radius:999px;
      min-width:18px;height:18px;line-height:18px;text-align:center;font-weight:600}
  `;
  document.head.appendChild(style);
  cleanups.push(() => style.remove());

  // ---- 稳定的选择器：优先 testid / id，其次 nth-of-type 链
  function cssPath(el) {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
      return '#' + CSS.escape(el.id);
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      for (const attr of ['data-testid', 'data-test-id', 'data-cy', 'data-qa', 'name']) {
        const v = node.getAttribute && node.getAttribute(attr);
        // 属性值用 JSON.stringify 生成带引号的字面量；CSS.escape 是给标识符（如 #id）用的
        if (v) { parts.unshift(`${node.tagName.toLowerCase()}[${attr}=${JSON.stringify(v)}]`);
                 return parts.join(' > '); }
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  // ---- 悬浮高亮
  const outline = document.createElement('div');
  outline.setAttribute(HOST_ATTR, 'outline');
  // ... 追加到 body；pointermove 时 elementFromPoint → getBoundingClientRect → 定位

  // ---- 点选 → 弹批注框
  // 关键：capture 阶段拦截，preventDefault + stopPropagation，
  //       否则你的点击会被页面自己的按钮吃掉（比如点到「提交订单」就真下单了）
  function onClickCapture(event) {
    if (!state.picking) return;
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!el || el.closest(`[${HOST_ATTR}]`)) return;   // 点自己的 UI 不算
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    openPanel(el);
  }

  function openPanel(el) {
    const rect = el.getBoundingClientRect();
    const item = {
      id: ++state.seq,
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || '').trim().slice(0, 200),
      html: el.outerHTML.slice(0, 400),
      url: location.href,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y),
              w: Math.round(rect.width), h: Math.round(rect.height) },
      note: '',
    };
    // ... 渲染 textarea + 保存/取消，保存时 state.items.push({...item, note}) 并刷新角标
  }

  // ---- 对外 API
  window[NS] = {
    version: 1,
    setPicking(on) { state.picking = !!on; /* 切光标、显隐工具条 */ return state.picking; },
    read() { return JSON.parse(JSON.stringify(state.items)); },   // 只回纯 JSON
    remove(id) { state.items = state.items.filter((i) => i.id !== id); },
    clear() { state.items = []; },
    uninstall() {
      for (const fn of cleanups.splice(0)) { try { fn(); } catch (_) {} }
      delete window[NS];
    },
  };
  // ... appendChild(outline) 等，并把 removeEventListener 塞进 cleanups
}
```

**这个脚本里的每一条都必须能自己收尾**（`uninstall` 恢复原样），否则用户关掉插件后页面还会留着蓝色虚线框。

调试建议：因为 guest DevTools 在打包版是关的，把中间状态**画在页面里**（比如工具条上显示 `items.length` 和最近一次错误），
或者让 `read()` 顺带返回一个 `debug` 字段，用 `executeJavaScript` 把错误捞回来打印在 DSH 主窗口的 console 里。

---

## 9. 生成给模型的 Markdown

这一段是产品价值的核心：**selector 要能让 Agent 在代码里定位到元素**。

````js
function toPrompt(annotations, pageUrl) {
  if (annotations.length === 0) return '';
  const rows = annotations.map((a, i) => [
    `### ${i + 1}. \`${a.selector}\``,
    `- 页面：${a.url || pageUrl}`,
    a.text ? `- 元素文本：${a.text}` : null,
    `- 当前 HTML：\`${a.html.replace(/`/g, '\\`')}\``,
    `- 位置：x=${a.rect.x} y=${a.rect.y} w=${a.rect.w} h=${a.rect.h}`,
    `- 问题 / 期望：${a.note || '（未填写）'}`,
    '',
  ].filter(Boolean).join('\n')).join('\n');

  return [
    `请修复我在浏览器里标注的 ${annotations.length} 处问题（页面：${pageUrl}）：`,
    '',
    rows,
    '说明：以上 selector 是在运行时页面里生成的，请先在代码里找到对应位置再改；',
    '如果 selector 与源码结构对不上，以「元素文本 + HTML」为准。',
  ].join('\n');
}
````

然后：

```js
const frame = activeBrowserWebview(sessionId, ctx.sidebarRight);
const items = await readAnnotations(frame);
appendToComposer(toPrompt(items, frame.getURL()));
await uninstall(frame);
shell.notify('info', `已插入 ${items.length} 条标注`);
```

### 可选增强

- **截图**：`const img = await frame.capturePage(rect)` → `img.toDataURL()`（**不要 `toPNG()`**，见 §7.1 的警告）→ 之后有两条路：(a) `fetch(dataUrl).then(r => r.blob())` → `new File([blob], …)` → `conversation.createDrafts(sessionId, [file])` → `shell.addAttachments(draftIds)`，图会**跟在消息里**；(b) 通过插件自己的路由把 base64 交给宿主半边，由模型侧工具用 `attachments.saveImage()` + `{ type: 'image', attachment }` 返回 —— 气泡干净，图只在工具结果里。本仓库的 `annotate-starter` **两条都用**：截图优先走 (a)（气泡里能看见、模型直接看到），
只有当附件那条路不可用时才退化成 (b)，并在工具文字里注明「截图已作为用户消息里的图片附件」。
- **批注列表 UI**：把 `conversation.input.dock` 用作批注列表（每条可删、可编辑、可跳转），按钮只负责「开始点选 / 汇总写入」。

---

## 10. 安装、热更新与验证

### 10.1 安装（Desktop profile）

桌面版的 `desktop` profile 是 Electron 持有的，**CLI `dsh plugin --profile desktop` 会拒绝**。用界面：

```
左侧边栏 → Plugins → Add plugin
  → 填包的**绝对路径**，例如 /Users/zm00138ml/work/AI/dsh-plugins/annotate-starter
  → Install（Host 会先 inspect 这个 spec：读 package.json、确认它有 bundle patch）
  → Enable now
```

安装会在这个 profile 目录里跑 pnpm `add`，并把 `@local/dsh-annotate` 加进 `dsh.profile.bundles`。
纯 JS、无依赖、无 build script 的包，不会有 pending build scripts 那一步。

> **不要在 workspace 之外手改 profile 文件**。`plugin_manager` / Plugins 页会维护 `cordis.patch.yml` 与
> `package.json` 的一致性（比如开关只改最后一条匹配 override 的 `disabled`，安装默认把 bundle 追加到列表末尾）。

### 10.2 热更新（这是能大幅提升开发体验的点）

`dsh-client-hmr` 的 Host 半边**会对每个 client bundle 做统计轮询**（`pollIntervalMs` 默认 500ms，比较 `mtimeMs/ctimeMs/size`），
一有变化就 `clientModules.rebuilt(id)`，并通过 `/plugins/events` 这个 SSE 通道推给浏览器；
浏览器半边的行为是：**重新执行这个插件的 bundle，并以全新 state 重新挂载（依赖它的插件跟着重载）**。

所以只要包是用绝对路径 `link` 进 profile 的：

```
改 client.js  →  约 0.5s 后页面里插件自动重载，无需刷新、无需重启
```

（改动 patch YAML 也一样，因为 `dsh.profile.bundles` 配的是 `patchReload: live`。）

例外：**替换一个「已安装的包」（换包名/版本重新安装）需要重启**才能拿到全新的 JS module generation。
热重载失败会出现在 Plugins 列表里，可以手动 retry，不用等下一次重建。

### 10.3 验收清单

- [ ] Plugins 页能看到卡片，标题/描述正确，没有 `failed` / `overridden` / `restart-required`
- [ ] 输入框工具栏出现「标注」按钮，明暗主题下都是对的（**只用 `--dsw-alias-*` token**）
- [ ] 右侧 Browser 打开一个页面，点按钮后页面进入点选模式，悬浮有高亮
- [ ] 点一个元素 → 弹批注框 → 写一句话 → 保存 → 角标 +1
- [ ] 点「写入输入框」→ composer 里出现拼好的 Markdown，且**用户原本输入的内容没被覆盖**
- [ ] 控制台没有 `slot entry crashed in 'conversation.input.left'`
- [ ] 在页面上导航一次（换 URL）后再标注，依然能注入、能读回
- [ ] 关掉插件后页面恢复原样（没有残留的虚线框/浮层）
- [ ] 多会话切换、右侧栏开两个 pane 时，定位到的仍是当前会话当前 pane 的 webview

---

## 11. 坑与硬限制清单

| # | 事实 | 影响 |
|---|---|---|
| 1 | 主进程 `will-attach-webview` 校验 `params.src === 'about:blank#' + 已发放 lease`，lease 只通过内部 IPC 发放 | **插件不可能自己 `createElement('webview')`**。必须复用 sidebar-browser 已建的那个 |
| 2 | webview guest 没有暴露给插件的 preload；无嵌套浏览上下文，`window.parent.postMessage` 到不了 DSH | **页面不能主动推送**。唯一双向通道是 `executeJavaScript` 的返回值 → 采用「拉」模型（点按钮时读） |
| 3 | guest `disableDialogs: true` | 注入脚本里**不能**用 `alert / confirm / prompt` |
| 4 | guest `devTools: !app.isPackaged`，当前是打包版 → `false` | 页面内**开不了 DevTools** 调试，只能靠页面内可见输出 + `executeJavaScript` 回传 |
| 5 | 注入脚本跑在页面 **main world**，与页面自己的 JS 同命名空间 | 用 `__DSH_ANNOTATE__` 这类带前缀的名字；所有自建 DOM 打 `data-dsh-annotate-host` 标记；**幂等**（重复注入要安全） |
| 6 | 导航会清掉注入 | 监听 `dom-ready` / `did-navigate` 重注入；SPA 内部路由不触发这两个事件，无需处理 |
| 7 | Web profile 用 `<iframe sandbox>`，跨域，且**没有** `executeJavaScript` | 本方案是 **Desktop 专属**。要覆盖 Web 版得改成「页面侧主动引入一段脚本 + `postMessage`」，见 §12 |
| 8 | Client 插件无 Node，只能 `require` 平台种子表（React 等） | **不要 `require` 任何 `@deepseek-ai/dsh-client-*` 包**，自己写控件、抄宿主样式 |
| 9 | slot 声明即授权 | 往未声明的 slot 注册、或往 `single` 已占用的 slot 注册，**加载时 throw** |
| 10 | `dsh.client.inject` 只排序激活，不提供 API | 要真拿服务，靠 `actx.get('conversation')` / `ctx.sidebarRight` / `ctx.sessions` |
| 11 | 草稿持久化在 `dsh.conversation.<sessionId>`，是**共享 store handle** | 不要自己 `defineStore` 同 key 的 handle；同一个共享句柄挂两个 scope 会 throw |
| 12 | 会话日志是唯一真相 | 标注内容最终以**文本**进会话才有意义；插件内存状态不参与 fork/resume/replay |
| 13 | 样式里 literal 颜色只在「美术素材」场合允许 | 一切容器/控件只用 `--dsw-alias-*`（当前共 109 个 token），否则暗色主题下会很难看 |
| 14 | 不要 `document.body.appendChild` 第二套应用，不要读别的插件的 DOM | 会被认为是破坏宿主的行为 |

---

## 12. 延伸：如果以后要支持系统浏览器 / Web 版

架构会变成两半：

1. **页面侧**：你需要往目标页面里加一段脚本。两种办法——
   - 目标是你自己的应用：直接在 `index.html` 里引一个 `annotate.js`（最省事，且能拿到完整的源码映射信息）；
   - 目标是任意站点：写**浏览器扩展**（content script），或让 Host 半边起一个**反向代理路由**（`dsh-http-proxy` + `dsh-host-webserver`）在 HTML 响应里注 `<script>`。
     Web 版的 iframe 沙箱给了 `allow-scripts allow-same-origin`，跨域页面**可以** `window.parent.postMessage(payload, '*')`，DSH 页面里的插件 `window.addEventListener('message', …)` 能收到。
2. **DSH 侧**：插件监听 message → 走 §5 写进输入框。要跨会话/跨窗口就用 Host 半边的 `dsh-storage` / `dsh-webhook` 做中转。

工作量大概是本方案的 1.5～2 倍，主要花在「怎么把脚本塞进别人的页面」上。

---

## 13. 自己查 API 的官方知识源（比读本文更权威）

DSH 自带三个技能包，就在安装目录里（`app.asar` 内，只有 Host 进程的文件读能打开）：

| 技能 | 内容 |
|---|---|
| `cordis-plugin-development` | 主流程 + `references/{host-plugin,ui-plugin,practices,verification}.md` + 可直接抄的 `templates/decoration/`（就是 §2 那四个文件） |
| `cordis-composition-reference` | Loader patch 方言、`isolate`、`!!js`、以及 `references/packages.md`（**全部可安装插件包清单**，按 group 分组） |
| `editing-cordis-compositions` | 改 agent preset 组合 |

**最快的用法**：把当前会话/新会话切到 **Creator mode**（agent preset 的一种，它会挂载这三个技能，并启用 `plugin_manager` 工具）。
之后直接对 Agent 说需求，它就能：

- `cordis_inspect_query` 查 `Slots.listSubTree` → **拿到运行时真实的 slot 树和每个 slot 的 props**（比我 §4.3 那张表更准）
- 查 `Theme` → 当前主题 token 全量清单
- 查 `Service` / `Event` → 确认 `conversation.input.for` 之类的方法签名
- `plugin_manager` `install_bundle` → 直接帮你装到 profile 里

另外两个通用查法：

```bash
# 读某个包的权威文档（每个包都带 README.md / README.zh.md）
less ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-sidebar-browser/README.md

# 读构建产物里的 JSDoc（包只发 lib/，不发 src/，但注释保留得很完整）
grep -n "executeJavaScript\|focusedTarget" \
  ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js
```

> 注意：`~/.dsh/profiles/node_modules/` 里有一批**断掉的软链**（指向 nvm 全局 `@deepseek-ai/dsh@0.1.5-rc.1` 里已不存在的包）。
> 当前桌面版实际跑的是 `app.asar` 里的 `0.1.7-rc.1`。要读**运行中的**那份，用：

```bash
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  -e 'console.log(require("fs").readFileSync(
    "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json","utf8"))'
```

---

## 14. 官方开发流程（照做能避开大部分返工）

`cordis-plugin-development` 技能规定的工作顺序，值得遵守：

1. **先定结果和落点**。「一个视觉物件」在没有别的落点时，默认就是装进当前 Harness Web UI 的插件。
2. **只为这一版找必需的 API**。先 `cordis_inspect_list`，再有针对性地 `cordis_inspect_query`；
   UI 就查 `Slots.listSubTree` 和选中 slot 的注册选项与 props。
3. **先写最小一版并装上去**。
   *"在第一次安装之前，不要创建预览 HTML、mock 外壳、设计变体、截图脚本或光栅化工具。用装好的插件本身做第一次预览。"*
4. **读完安装结果再验证**：`application: applied` 之后，要么真的用一次那个能力，要么检查 live Client 注册；
   有浏览器控制时用连着的页面做视觉验证。同时检查设计一致性：只用主题 token、没 import DSH Client 包、控制台没有 slot entry crash、明暗主题都正常。
5. **在同一个插件里修掉观察到的缺陷**。跑通就收，不要继续做投机性的视觉变体或可选项。

---

## 15. 进阶：让输入框里出现的是 UI 组件，而不是一段文字

> 结论：**能**。用的是 composer 自己的 inline chip（`@文件` / `@会话` 用的同一套机制），
> 而且 chip 在输入框里显示什么、发送时展开成什么，**是两件可以分开控制的事**。
> 但 chip 有一个必须知道的退化行为（§15.5），它会直接决定你怎么设计。

### 15.1 机制：chip 的模型形态由你的 source 决定

`ui-conversation` 的编辑器里有一个原子 inline 装饰节点 `ReferenceChipNode`，字段是：

```js
{
  source,         // "Owning source name (serializer routing key)"
  ref,            // Owner-scoped reference id（隐藏值）
  label,          // "Inline display label (insert-time cache)" —— chip 上显示的文字
  appearance,     // 可选，域字形
  clipboardText,  // "Clipboard / persistence projection, e.g. `/name` (never the model form)"
}
```

发送时序（`SessionInputShell.sinkSerialized`，源码注释原文是
*"Prompt serialization before the sink: expand each chip occurrence to its owner's model form via the session controller's codec routing"*）：

```
用户按发送
  → 取草稿 projection.occurrences（每个 chip 一条 { offset, length, source, ref, … }）
  → 对每条：await inputTriggers.serializeReference(o.source, o.ref, signal)
        → roster.all().find(s => s.name === o.source).codec.serialize(ref, signal)
  → 把草稿里 [offset, offset+length) 替换成 codec 返回的文本
  → 拼出来的整串才是真正发出去的 prompt
```

- 草稿里没有 chip 时**整段异步展开被跳过**（零开销）。
- 任何一步抛错 → **这次发送被拒绝、编辑器快照被恢复**，不会发出半截内容。

所以：**label 管「输入框里显示什么」，`codec.serialize` 管「模型收到什么」。** 这就是你要的能力。

### 15.2 注册一个 codec-only source（最省事的形状）

`serializeReference` 是按 **`name`** 在 `roster.all()` 里找 source 的，**与 `trigger` 无关**；
而候选菜单只查 `roster.sources('<触发符>')`。所以**不给 `trigger` 的 source 对 `@` / `/` 菜单完全不可见**，
却被 chip 序列化正常路由到。（我把 `all()` 的四处遍历都核对过：`warm?` / `lexicon` / `matchEnter` 全部有 undefined 守卫，无 trigger 的 source 不会引发异常。）

```js
apply(ctx) {
  const inputTriggers = ctx.get('inputTriggers');
  const payloads = new Map();            // ref id -> 完整 Markdown

  ctx.effect(() => inputTriggers.registerSource({
    // 故意不给 trigger：不进 @ / 菜单，只承担 chip 的序列化
    name: 'annotate',
    codec: {
      // 复制草稿时、以及草稿被持久化 / 跨会话迁移时，chip 变成这个 —— 务必短
      clipboardText: () => '@标注',
      // 发送时 chip 展开成这个
      async serialize(ref) {
        const markdown = payloads.get(ref);
        if (markdown === undefined) throw new Error(`annotate: unknown reference "${ref}"`);
        return markdown;
      },
    },
  }), 'annotate: input source');
}
```

- `registerSource` 按 `(trigger, name)` 去重，重名会 throw；返回 disposer，交给 `ctx.effect` 收尾。
- 想让用户还能打 `@` 手动挑一批标注，就补上 `trigger: '@'` 加 `candidates` / `onPick`；
  候选行的形状照抄 `dsh-client-ui-reference` 的 `fileCandidate` / `sessionCandidate`。

### 15.3 把 chip 插进草稿（不走 `@` 菜单）

用官方自己也在用的那条路：`shell.addFiles(references, ids)`
—— 注释原文 *"Add validated file references and attachment ids while admission is editable"*，
内部是 `draftEditor.insertFileReferences()`，*"Insert an ordered file-reference batch after the live selection without deleting it"*。
**`ids` 传空数组就是纯粹的 chip 插入**：在光标处插入、不删除任何手写内容。

```js
// 在 inject(sessionId) 里拿到 shell
const actx = ctx.sessions.scope(sessionId);
const shell = actx.get('conversation').input.for(actx);

const refId = crypto.randomUUID();
payloads.set(refId, markdown);

const ok = shell.addFiles([{
  source: 'annotate',          // 必须等于注册的 source name
  ref: refId,                  // 隐藏值，原样交给 codec.serialize
  label: `标注 ${count} 处`,    // chip 上显示的文字
  appearance: 'session',       // 见 §15.4
  clipboardText: '@标注',       // 见 §15.5，务必短
}], []);

if (!ok) {
  payloads.delete(refId);
  shell.notify('error', '输入框当前不可编辑，请稍后再试');
}
```

`addFiles` 在 `phase === 'adjudicating' | 'submitting'` 时返回 `false`，把它当降级信号处理，不要静默忽略。

### 15.4 chip 长什么样：只能选原生那一两种

chip 的渲染器 `ReferenceChip` 是 `ui-conversation` 私有的，**插件换不掉**。你能控制的只有：

| 字段 | 可控性 |
|---|---|
| `label` | 完全自由；chip 最大宽度 240px，超出走省略号（`title` 里是全文） |
| `appearance` | 只有 `'session'`（对话气泡）、`'file'`（文件）、`'folder'`（文件夹）；**其它值渲染成空白**（`ReferenceIconArtwork` 的 switch 没有 default）；省略则渲染一个 `@` 标记 |
| 颜色 | 固定 `--dsw-alias-state-business-primary` + hover 底色，改不了 |
| 点击 | 只有 `appearance === 'file'` 会加指针样式并触发你 source 的 `openReference(session, reference)`；其它值不响应点击 |

所以：

- 要「评论 / 气泡」语义 → `appearance: 'session'`（但不可点）
- 要可点击（点开标注详情）→ `appearance: 'file'`，并实现 `openReference`
- 要完全自定义外观（缩略图、徽标、逐条删除）→ **chip 做不到，见 §15.7**

DOM 锚点：chip 元素带 `data-composer-chip="<source>"`，可以用它做端到端断言。

### 15.5 ⚠️ 最大的坑：chip 活不过刷新和切会话

草稿的持久化层**只存一个字符串**：

```js
defineStore({
  init: () => ({ draft: '', view: null, viewRequest: null }),
  persist: 'dsh.conversation',                        // localStorage: dsh.conversation.<sessionId>
  actions: { setDraft: (d, text) => { d.draft = text; } },
})
```

- 写入侧 `bindDraftMirror(actions.setDraft)` 拿的是投影的 **clipboard 形式**（chip 贡献它的 `clipboardText`）。
- 读回侧挂载时 `if (inputState.draft === '' && storedDraft !== '') inputActions.setDraft(storedDraft)`
  —— 而 `setDraft(text)` 只会建**纯文本段落，不重建 chip**。
- 切 workspace / session 时同一条路：`const draft = from.snapshot.draft; … next.setDraft(draft);` 也是走字符串。

**所以 chip 是内存态。刷新页面、或让草稿跨会话迁移，chip 就退化成 `clipboardText` 那段文字。**

于是 `clipboardText` 就是你「污染」的上限：

| `clipboardText` | 刷新 / 切会话之后 | 代价 |
|---|---|---|
| 完整 Markdown payload | **整段 Markdown 灌进输入框** | 正是你想避免的污染 |
| 短 token（如 `@标注`） | 剩一个 `@标注` | 文字区基本干净，但 payload 丢了（此时它只是个短 token） |

**结论：`clipboardText` 一律用短 token**，然后按下表挑一种方式把 payload 送达模型。

（另一个失败模式也顺带安全：如果发送时 source 已经不在 roster 里——比如插件被卸载——
`serializeReference` 会抛 `no serializer for reference source "annotate"`，这次发送被拒绝并恢复草稿。
用户删掉 chip 就能继续，不会被卡住。）

### 15.6 四种方案对比

| 方案 | 输入框里是什么 | payload 怎么到模型 | 刷新 / 切会话后 | 代码量 |
|---|---|---|---|---|
| **A. chip + 附件**（推荐） | 一个 `标注 3 处` chip **+ 一张附件卡片** | 附件文件内容 | chip 退化成短 token，附件一起消失（**不污染**） | 中 |
| **B. 只要附件** | 一张原生附件卡片（自带删除按钮、上传状态） | 附件文件内容 | 一起消失（**不污染**） | **最小** |
| **C. 纯 chip** | 一个 `标注 3 处` chip | `codec.serialize` 展开 | 退化成短 token，payload 丢 | 小 |
| **D. chip/按钮 + Host 侧 context** | 一个 chip 或一个按钮 | `agent.inject()` 注入成模型上下文 | chip 退化，但标注还在 Host 那边 | 最大（要写 Host half） |

**方案 A** 是「UI 组件感」和「不污染」兼顾的那一个：chip 提供语义标签，附件承载真正的 payload（附件天生就能删除、天生进消息、天生不会变成文字）。

```js
async function attachAnnotations(ctx, sessionId, markdown) {
  const actx = ctx.sessions.scope(sessionId);
  const conversation = actx.get('conversation');
  const shell = conversation.input.for(actx);

  const file = new File([markdown], 'page-annotations.md', { type: 'text/markdown' });
  const [draft] = conversation.createDrafts(sessionId, [file]);   // 非图片文件会先走上传
  if (!shell.addAttachments([draft.id])) {
    conversation.releaseDraftAttachment(draft.id);                // 失败必须自己回收
    return false;
  }
  return true;
}
```

**注意附件是异步上传的**：非图片附件要等到 `upload.status === 'ready'`，否则 `sendSession` 会抛
`"one or more files have not finished uploading"`；`serializeDraftAttachments` 同理。
composer 自己会渲染 pending 状态（内部变量 `uploadsPending`），所以用户看到的是「转圈 → 就绪」，
但**别在 `createDrafts` 之后立刻 `submit()`**。状态读 `conversation.fileUploads.getSnapshot()[id]?.status`，
失败用 `conversation.retryFileUpload(sessionId, id)` 重试。

**方案 D** 的 Host 侧 API（`dsh-agent` README 原文）：

> `inject()` adds model-facing context without waking the driver, so it lands in the next admitted step.

即：client 半边把标注同步到 Host，Host 在合适的时机 `agent.inject(...)`。这样 payload 完全不经过消息文本，
输入框永远只有一个干净的 UI 元素；而且 Chat 默认**不渲染**普通 Context injection 行（只在 Trajectory 里可见），
界面也不会被刷屏。代价是要写真正的 Host half，以及一条 client↔host 通道（`dsh-api-remotes` / `dsh-storage`）。

### 15.7 如果你要的是「完全自定义的卡片」

chip 换不了渲染器，但 **`conversation.input.dock` 是 list slot，里面的 React 完全由你写**。
所以要缩略图、徽标、逐条删除、点击定位回页面元素，就：

- 按钮 / chip 只负责「把标注收进来」和「打开面板」；
- 真正的内容在 `conversation.input.dock`（输入框上方那块，官方 `todo` / `queue` 就在这）渲染成你自己的卡片；
- 卡片上再用 `conversation.input.for(actx)` 的 `setDraft` / `addAttachments` 提交。

样式只用 `--dsw-alias-*` token，明暗主题下才不崩。

---

## 16. 写好的插件放哪、能不能放 GitHub

### 16.1 开发时：它就是一个普通目录

不需要特殊的项目结构、不需要脚手架，**也不必放在会话 workspace 里** —— 放哪都行，
安装时填绝对路径即可。按 §2 建四个文件，就是一个合法的 bundle：

```
/Users/zm00138ml/work/AI/dsh-plugins/annotate-starter/
├── package.json       # dsh.bundle.patch + dsh.client
├── cordis.patch.yml
├── index.js
└── client.js
```

官方 `cordis-plugin-development` 技能的原话就是这样：
*"Use ordinary workspace files to author a bundle, then install it in the current profile."*

### 16.2 安装时：spec 被**原样**交给 pnpm

`installBundle` 接受四种 spec（源码里的分类就叫 `registry` / `path` / `git` / `tarball`）：

| spec 形态 | 例子 | 装完是什么 |
|---|---|---|
| registry 包名（+版本） | `@scope/dsh-annotate@1.0.0` | 从 npm（或镜像）下载 |
| **绝对本地路径** | `/Users/…/AI/dsh-plugins/annotate-starter` | pnpm 记为 `link:` → **软链**，目录还在原地 |
| **git 地址** | `https://github.com/you/dsh-annotate` | pnpm 拉进 store → **快照**（不可变） |
| tarball | `./dsh-annotate-1.0.0.tgz` 或 URL | 解包快照 |

安装动作本身就是 `pnpm add <spec>`（`runPnpm(["add", spec, ...registryArguments])`），**spec 原封不动传下去**。这带来一个对你很关键的差别：

- **绝对路径 → 软链 → 改 `client.js` 立刻生效**（配合 §10.2 的 500ms 轮询热重载，不用重启）。
- **GitHub → pnpm 的快照 → 改代码要重新安装**，重启才拿到新代码。

所以开发期用绝对路径，发布 / 共享用 GitHub 或 npm。

### 16.3 能直接放 GitHub 吗：能

GitHub 是官方支持的安装源之一。GitHub 地址会**先做一次 `git ls-remote`** 探活
（默认 5s 超时，`githubConnectionTimeoutMs`），再交给 pnpm；探活只挡网络 / 超时，
认证等其它问题留给 pnpm（包括它的 HTTPS→SSH 回退）。

```
左侧 Plugins → Add plugin → https://github.com/you/dsh-annotate
左侧 Plugins → Add plugin → github:you/dsh-annotate#v0.1.0
```

命令行（非 desktop profile）：

```sh
dsh plugin --profile web add github:you/dsh-annotate#v0.1.0
```

**对你的形态特别有利的一点**：你是**手写纯 JS、无构建步骤**的插件，`exports["./client"]` 直接指向仓库根目录的 `client.js`，Host 就原样伺服这个文件。所以：

- 不需要 CI、不需要 tsdown、不需要提交 `lib/` 构建产物；
- 仓库里那几个源文件就是可安装的成品。

（官方那些包是 tsdown 编译出 `lib/client.js` 再发布的；你这条路省掉了整条构建链。这是手写插件最大的优势。）

### 16.4 放 GitHub 的注意事项

| 项 | 说明 |
|---|---|
| **包必须在仓库根目录** | pnpm 的 git 依赖装的是**仓库根**。一个仓库一个插件最省事；monorepo 里的子包要额外技巧，别踩 |
| **版本要钉住** | `#v0.1.0` 或 `#<commit>`。不钉的话每次安装的行为取决于默认分支当时的状态 |
| **`dsh.bundle.patch` 必须相对且包内** | patch 里相对的 `name` 也锚定在 patch 文件旁边 |
| **`icon` 必须包内、≤256 KiB** | 支持 SVG/PNG/JPEG/WebP；绝对路径、URL、目录外路径、指向目录外的软链都会被拒 |
| **私有仓库要有 git 凭据** | pnpm 在 profile 目录里跑，用你本机 git 的配置和代理 |
| **别提交依赖** | 插件零依赖最好；有依赖就让 pnpm 装，别 vendor |

### 16.5 ⚠️ 安全：装 bundle = 让它的 Host 代码在你机器上跑

官方文档明确写了：

> `plugin_manager` 的每个工具动作都需要 `danger-full-access` 或对该次调用的批准。
> **安装的 Host 代码在进程内执行，位于 workspace 沙箱之外。**

也就是说：**装别人 GitHub 上的插件，等于让那个人的代码以你的用户权限在你机器上运行**，
而且它能碰的远不止你的项目目录。你自己写的无所谓；把插件分享给别人时，
也请在 README 里说清 Host 半边做了什么 —— 你这种纯 UI 插件的 `index.js` `apply()` 是空的，
这是个很好的卖点，值得写明。

---

## 17. 「浏览器右上角一个按钮，点击进标注模式，Esc 退出」能行吗

拆成三个问题，答案不一样。

### 17.1 结论

| 你的想法 | 能行吗 | 说明 |
|---|---|---|
| 在**页面右上角**加一个按钮 | ✅ 能，而且是推荐做法 | 反正你要注入脚本，让脚本自己画一个 `position: fixed` 的悬浮按钮 |
| 在 **DSH 侧边栏 Browser 自带的工具栏**右上角加按钮 | ❌ 不行 | 官方没留这个扩展点（见 17.2），只能用浮层自己定位模拟 |
| **Esc 退出标注模式** | ✅ 能 | 核实过不会被 DSH 的快捷键服务截走（见 17.4） |

### 17.2 为什么不能加到 Browser 自带的工具栏

三条独立证据：

1. **那个工具栏没有子 slot。** `BrowserBody` 里的工具栏是一个硬编码的 `<form class="…toolbar">`，
   里面写死了后退 / 前进 / 刷新 / 地址栏 / 外部打开；而它的注册（`ui-sidebar-browser.body`）
   **完全没有 `children` 字段**：

   ```js
   scope.slots.register({ name: 'sidebar.right.pane.tab', key: BROWSER_ID, locale, store, inject: … }, BrowserBody)
   ```

   没有 `children` = 没有子扩展点。

2. **tab 与 tab 标题这两个 slot 都是 `keyed`。** `rightbar.session` 的声明是：

   ```js
   children: {
     'sidebar.right.pane.tab':       { kind: 'keyed', scope: 'session', … },
     'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session', … },
     'sidebar.right.tab.menu.item':  { kind: 'list',  scope: 'session' },
   }
   ```

   `keyed` 是按 key 分派的，browser 占了 `browser` 这个 key；而「声明即认领」——一个 key 只能有一个条目。你插不进去。

3. **官方文档明说了没有。** `ui-sidebar-right` README 原文：

   > Two more seats extend what is already there: `sidebar.right.tab.guide` (chain) … `sidebar.right.tab.menu.item` (list) …
   > **No seat exists for pane-level actions or for collapsed-state controls yet, because nothing needs one.**

顺带：DSH 应用外壳本身也**没有右上角的 slot**。只有 `shell.leading`（`single`，macOS 上被红绿灯位占用）
和 `shell.overlay`（`list`，自由）。没有 `shell.trailing` 之类的东西。

### 17.3 那怎么做「右上角按钮」

**路线 A（推荐）：按钮做进页面里。**

你本来就要 `executeJavaScript` 注入标注脚本，那脚本顺手画一个就行：

```js
const bar = document.createElement('div');
bar.setAttribute('data-dsh-annotate-host', 'bar');
Object.assign(bar.style, {
  position: 'fixed', top: '12px', right: '12px', zIndex: 2147483647,
  display: 'flex', alignItems: 'center', gap: '6px',
  padding: '5px 10px', borderRadius: '999px',
  background: 'rgba(17,17,17,.9)', color: '#fff',
  font: '12px/18px -apple-system, system-ui, sans-serif',
  cursor: 'pointer', userSelect: 'none',
  boxShadow: '0 2px 12px rgba(0,0,0,.3)',
});
bar.textContent = '标注';
bar.addEventListener('click', () => setPicking(!state.picking));
document.body.appendChild(bar);
```

- 视觉上就是页面右上角一个胶囊按钮，`position: fixed` 跟随滚动；
- 它活在 guest 的 main world 里，不跟 DSH 抢 DOM；
- 退出时随 `uninstall()` 一起移除。

**路线 B：`shell.overlay` 里自己画，绝对定位到 Browser pane 的右上角。**

```js
// 在 shell.overlay 注册的组件里
const pane = document.querySelector('[data-sidebar-right-session="…"] [data-dockkit-pane-active]');
const rect = pane?.getBoundingClientRect();
// 用 position: fixed + rect.right/rect.top 定位你自己的按钮
// pane 尺寸变化用 ResizeObserver 跟随
```

缺点很明显：位置是**算出来**的，pane 拖拽分隔条、全屏、右侧栏折叠都要跟着更新。能在页面里画就别走这条。

**两条路可以并存**：A 负责页面内的标注交互，B（或 §4.3 的 composer 按钮）负责 DSH 侧的入口。

### 17.4 Esc 能不能用：能 ✅（附验证过程）

这个我特意去查了会不会被 DSH 的快捷键服务拦截 —— 拦了的话页面根本收不到按键。

**webview 的按键拦截逻辑**（Electron 主进程 `before-input-event`）：

```js
const main = guestName === void 0 && frame === contents.mainFrame;
if (!priority && (main || !match)) return;   // ← 提前返回，不动这个事件
event.preventDefault();                       // ← 只有走到这才吞掉按键
```

其中 `match = keys.has(bindingKey({ code, modifiers }))`，而 `keys` 是这样构建的：

```js
keys = new Set(rows.flatMap((row) =>
  row.binding !== null && row.issue === null && row.conflicts.length === 0
    ? [bindingKey(row.binding)] : []));
```

关键是 `rows` 的来源：

```js
function effectiveShortcuts(definitions, document, runtime, platform) {
  const fixed = definitions.flatMap((row) => row.fixed?.map(…) ?? []);    // ← fixed 单独摘出
  const rows  = definitions.filter((row) => row.fixed === void 0).map(…) // ← rows 不含 fixed
  …
}
```

`fixed` 只参与**冲突检测**，不进 `rows`。而 **Escape 恰好是 fixed 命令**
（`dsh-client-shortcuts` 的 `fixed.dismiss`、`dsh-client-ui-conversation` 的 `response.stop`），所以：

```
Escape → keys 里没有 → match = false
       → !priority && (main=false || !match=true) → true
       → 提前 return，不 preventDefault
       → 按键正常到达页面 ✅
```

另外 `bindingIssue()` 把裸 `Escape` 归类为 `"reserved"`：

```js
if (["Escape","Tab","Space","Backspace","Delete","ArrowUp",…].includes(code) …) return "reserved";
```

所以**用户也无法把 Escape 绑到别的命令上**，不会有键位冲突的意外。

**两个前提**：

1. **焦点必须在页面里。** 如果你最后点的是 DSH 输入框，Esc 会走 DSH 那条路（停止生成 / 关菜单），
   页面收不到。你的流程是「点页面右上角按钮进入标注模式」—— 焦点天然在页面里，没问题。
2. **别无条件吞掉 Esc。** 只在标注模式激活时拦截，否则会破坏页面自己的 Esc（关闭弹窗等）。

### 17.5 Esc 的实现要点

```js
function onKeyDown(event) {
  if (event.key !== 'Escape' || !state.picking) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();   // 页面自己的 Esc 处理排在后面
  setPicking(false);
}
// capture 阶段先拿到，并只在这个模式下拦截
window.addEventListener('keydown', onKeyDown, { capture: true });
cleanups.push(() => window.removeEventListener('keydown', onKeyDown, { capture: true }));
```

退出时要彻底清理，否则页面上会残留：

- 移除所有 `[data-dsh-annotate-host]` 节点（高亮框、批注框、工具条）；
- 移除注入的 `<style>`；
- 恢复被改过的样式（比如 `document.documentElement.style.cursor`、`userSelect`）；
- 移除所有 `document` / `window` 监听器；
- `state.items` 清不清由你决定（保留的话，用户重新进入还能看到上次的标注）。

### 17.6 一个必须注意的设计约束：页面里的按钮**没法通知插件**

回到 §7.1 那条硬限制：webview guest 没有暴露给插件的 preload，`window.parent.postMessage` 也到不了 DSH。
**唯一通道是 `executeJavaScript` 的返回值。**

所以「用户在页面里点按钮进入标注模式」这件事，**插件不会自动知道**。三个选择：

| 做法 | 机制 | 评价 |
|---|---|---|
| **插件只注入，交互全靠页面** | `dom-ready` 时注入一次；标注模式完全由页面内按钮 + Esc 驱动 | 体验最好，但插件得主动去读才知道有标注 |
| **轮询** | 标注模式激活时，`setInterval` 每 1s 调一次 `frame.executeJavaScript('__DSH_ANNOTATE__.pull()')` | 能让页面按钮驱动全流程。代价是持续 IPC。**务必在 webview 不可见 / 未打开时停掉**，别在隐藏 tab 上一直轮询 |
| **DSH 侧留一个入口** | composer 按钮 / `sidebar.right.tab.menu.item` 菜单项来「开始标注」 | 最稳、零轮询；代价是用户要点两次 |

**建议**：`dom-ready` 时自动注入 overlay（页面右上角就出现按钮），标注模式全在页面内完成；
**只在「标注模式已激活」期间开启轮询**，用户在页面里点「写入输入框」后，
脚本把结果挂到 `window.__DSH_ANNOTATE__.outbox`，插件下一次轮询取走并**立即关掉轮询**。
这样既不需要 DSH 侧按钮，也没有常驻开销。

一个几乎零成本的补充：顺手实现 `sidebar.right.tab.menu.item`，在 Browser tab 的右键菜单里加一项
「开始标注」—— 这是官方**真实存在**的 list slot，能给不想用页面内按钮的时候留个官方入口。

---

## 18. 「干脆自己在插件里实现一个浏览器」—— 这条路是通的，而且可能是最优解

### 18.1 结论

**桌面版可以。** 插件能自己申请 guest lease、自己创建 `<webview>`、自己画工具栏。
关键原因是：**官方浏览器用的那个 desktop bridge 就挂在 `globalThis.dshDesktop` 上，DSH 主帧里任何脚本都能拿到。**

这同时解决了你上一个问题 —— 「工具栏右上角一个按钮」：**工具栏变成你自己的，按钮想放哪放哪。**

### 18.2 证据：bridge 的暴露条件与 API

`preload-app.cjs` 结尾：

```js
electron.contextBridge.exposeInMainWorld("dshDesktop",
  location.protocol === `dsh-app:` && location.hostname === "app" && process.isMainFrame
    ? createProductApi()          // ← 完整 API
    : { protocolVersion: 1 });    // ← 其它文档只拿到一个降级桩
```

- DSH 渲染进程**就是** `dsh-app://app/` 的主帧 → 拿到的正是完整的 `createProductApi()`。
- 非主帧、其它文档只拿到 `{ protocolVersion: 1 }`。

`browser` 桥一共只有三个方法：

```js
globalThis.dshDesktop.browser = {
  acquire(workspace)              // -> Promise<{ lease, partition }>
  release(lease)                  // -> Promise<void>
  onOpenRequested(lease, listener) // -> unsubscribe（处理 target=_blank）
}
```

官方包自己就是这么用的，**照着它的版本检查写**：

```js
const carrier = globalThis.dshDesktop;
const desktop = carrier?.protocolVersion === 1 ? carrier.browser : undefined;
```

`protocolVersion` 一变就当「没有浏览器」优雅降级，而不是崩。

### 18.3 为什么这不算钻空子

主进程的 `will-attach-webview` 校验的是「**你必须是已发放的 lease**」，而不是「你必须是官方包」：

```js
owner.on("will-attach-webview", (event, preferences, params) => {
  const id = params.src.startsWith("about:blank#") ? params.src.slice(12) : "";
  const lease = this.leases.get(id);
  if (lease === void 0 || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
    event.preventDefault();        // ← 拒绝
    return;
  }
  // …强制 guest 的 webPreferences…
});
```

`acquire()` 就是那个**发放入口**。所以自己建 webview 是官方机制的一部分。

### 18.4 自己建 webview 的最小代码

```js
const bridge = globalThis.dshDesktop?.protocolVersion === 1
  ? globalThis.dshDesktop.browser
  : undefined;
if (bridge === undefined) throw new Error('annotate: desktop browser bridge unavailable');

// workspace 是「存储身份」字符串，你自己定（见 18.5）
const { lease, partition } = await bridge.acquire(`cwd:${cwd}`);

const el = document.createElement('webview');
el.setAttribute('name', lease);                    // ← 必需，校验会比对
el.setAttribute('partition', partition);           // ← 必需，校验会比对
el.setAttribute('allowpopups', '');
el.setAttribute('src', 'about:blank#' + lease);    // ← 必需，校验就是比这个前缀
el.className = 'annotate-browser-webview';
host.appendChild(el);

// 首帧之后再导航
el.addEventListener('dom-ready', () => el.loadURL(url));

// 卸载时（组件卸载 / 会话切换 / 插件卸载都要走）
el.remove();
await bridge.release(lease);
```

**`workspace` 传什么**：主进程只要求「非空字符串、≤4096」，它是 partition 的键（决定 cookie / storage 分组）。官方用的是：

```js
workspace === undefined ? `session:${sessionId}` : `cwd:${workspace.path}`
```

**建议传 `cwd:${workspace.path}`** —— 这样你的 webview 和官方浏览器**共用同一个 partition**，用户已登录的 cookie 直接可用。想隔离就用自己的前缀（`annotate:${sessionId}`）。

### 18.5 路线 1（推荐）：注册自己的 tab 类型，放进右侧边栏

`ctx.sidebarRightTabs.register()` 是公开 API：

```js
ctx.sidebarRightTabs.register({
  id: '@local/dsh-annotate',     // 全局唯一；同时也是 body / title 的 slot key
  kind: 'annotate-browser',      // 页类型：不写 patterns，按 kind 打开
  multiple: true,                // 像浏览器一样可开多个独立实例
  priority: 'extension',         // 不写就是这个（最高档）
  title: () => '标注浏览器',       // tab chip 文案，开 tab 时捕获
  guide: [{ id: 'new', order: 40, title: () => '标注浏览器', description: () => '边看边标注' }],
  keepMounted: true,             // 切 tab / 切会话 / 折叠时保留 DOM
});

// body —— key 必须等于 definition.id
ctx.slots.register({ name: 'sidebar.right.pane.tab', key: '@local/dsh-annotate' }, Body);
// 标题（可选；不注册就用 title() 的文案）
ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: '@local/dsh-annotate' }, Title);
```

打开自己的 tab：

```js
ctx.sidebarRight.openTab('annotate-browser', { params: { url: 'http://localhost:5173/' } });
```

**Body 的骨架**（官方 `BrowserBody` 就是这形状）：组件通过框架注入的 `useTabInfo()` 拿到
`{ sidebar, panel, tab }`，自己 `useId()` 出一个 viewport，用 `useLayoutEffect` 把 webview 挂进去。

```js
function Body() {
  const { tab } = useTabInfo();
  const viewportId = React.useId();
  React.useLayoutEffect(() => {
    let cancelled = false;
    let lease;
    (async () => {
      const acquired = await bridge.acquire(workspaceIdentity);
      if (cancelled) { await bridge.release(acquired.lease); return; }
      lease = acquired.lease;
      const el = makeWebview(acquired);              // 见 18.4
      document.getElementById(viewportId).append(el);
      el.addEventListener('dom-ready', () => el.loadURL(tab.navigation.params.url));
    })();
    return () => {
      cancelled = true;
      document.getElementById(viewportId)?.replaceChildren();
      if (lease !== undefined) bridge.release(lease);
    };
  }, [viewportId]);
  return React.createElement('div', { id: viewportId, style: { flex: 'auto', minHeight: 0 } });
}
```

**这样一来工具栏完全是你自己的** —— 「右上角一个按钮」不再需要任何 slot hack，
也不需要在页面里画悬浮按钮，也不需要轮询（状态是纯 React 的）。

另外你白拿 dockkit 的全套能力：停靠、分栏、拖成浮动窗、全屏、`keepMounted`、tab chip、右键菜单。

### 18.6 另外两条路（和为什么不推荐）

**路线 2：顶替官方浏览器的 kind。** 文档原话：

> A `kind` carries at most one `builtin` and one `extension` registration (**the extension is in force**;
> the builtin resumes when it leaves); any other collision on a `kind` throws.

也就是说注册 `kind: 'browser'` 的 extension 就会**接管**官方那个 tab。代价是你得维护一个完整浏览器
（后退/前进/刷新/地址栏/历史/恢复/未知地址状态机…）。除非你真的要替换掉它，否则别这么干。

**路线 3：`shell.overlay` 里挂自己的 webview。** 可行，但你会失去 dockkit 的停靠/分栏/浮动/全屏/keepMounted，全得自己实现。

### 18.7 代价与硬限制（一条都没少）

| # | 事实 |
|---|---|
| 1 | **Web 版走不通。** `dshDesktop` 不存在 → 只能退回 `<iframe>`。要么只支持桌面版，要么像官方那样写两套载体（`IframeImpl` / `ElectronWebviewImpl`） |
| 2 | **guest 的强制配置你改不了**：sandbox、contextIsolation、`nodeIntegration:false`、`disableDialogs:true`（**没有 alert/confirm/prompt**）、`devTools: !app.isPackaged`（打包版开不了 guest DevTools）、`webviewTag:false`（不能嵌套 webview）。§7.1 那些限制原样保留 |
| 3 | **导航策略仍是主进程说了算**：`will-frame-navigate` / `will-redirect` 会走 `allowedNavigation(url)`，越界直接 `preventDefault` |
| 4 | **lease 是资源，必须 `release`**。组件卸载、会话切换、插件卸载都要释放，否则 guest 泄漏（主进程只在 `release` 或 webContents 销毁时才 close） |
| 5 | **`target=_blank` 要自己处理**：`bridge.onOpenRequested(lease, (url) => …)` |
| 6 | **浏览器外壳要自己写**：地址栏、后退/前进/刷新、加载态、失败页。（Electron webview 自带 `canGoBack`/`canGoForward`/`goBack`/`goForward`/`reload`，这部分省事；Web iframe 得全自己管） |
| 7 | **`dshDesktop` 不在任何官方 README 里。** 它是 desktop shell 的实现细节 —— 虽然带 `protocolVersion` 版本化，说明**预期会被这样消费**，但它不是文档化的稳定公开 API。用它就接受了「升版可能变」的风险，所以：先检查版本、优雅降级、别把它包装成「官方支持的浏览器 API」对外宣传 |

### 18.8 所以到底选哪个

| 你的目标 | 建议 |
|---|---|
| 只要在现有 Browser 页面上叠加标注交互 | §6–§8（复用官方 webview + `executeJavaScript`）。最省事 |
| **必须在「浏览器工具栏右上角」有个按钮** | **路线 1**（自己注册 tab 类型）。这是唯一能真正拥有那个工具栏的办法 |
| 完全不想依赖官方浏览器包 | 路线 1 + 自己的 webview |
| 要同时支持 Web 版 DSH | 路线 1，但载体写两套（Electron webview / iframe） |

**推荐路线 1**，理由：

- 你原问题的核心诉求（工具栏右上角一个按钮）**只有这条路能做到**；
- 不必碰 composer 的 chip、不必抢 slot、不必算 pane 坐标、不必轮询；
- 标注按钮和页面在**同一个你自己的组件**里，状态传递是纯 React；
- 页面就在你自己的 webview 里，`executeJavaScript` 依然可用；
- dockkit 的分栏/浮动/全屏/keepMounted 免费白拿。

唯一代价是写一个很小的浏览器外壳：一个地址输入 + 一个标注按钮 + 一个 webview。
这比在官方浏览器外面套一层 hack **更简单，也更可控**。

---

## 附：最小可跑骨架（把 §2 的四个文件填成能装的东西）

`client.js` 的第一版只做三件事就够，先确认链路通：

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-annotate',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** composer 工具栏上的按钮：仅测试「能否往输入框写字」。 */
    function AnnotateButton({ appendToComposer, t }) {
      return h('button', {
        type: 'button',
        title: '标注（连通性测试）',
        onClick: () => appendToComposer('（连通性测试：这行字来自插件）'),
        style: {
          all: 'unset',
          cursor: 'pointer',
          padding: '0 6px',
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: 12,
        },
      }, '标注');
    }

    return {
      inject: ['slots', 'sessions'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'annotate',
          order: 10,
          inject: (sessionId) => {
            const actx = ctx.sessions.scope(sessionId);
            if (actx === undefined) throw new Error(`annotate: session "${sessionId}" resolved no scope`);
            const conversation = actx.get('conversation');
            if (conversation === undefined) throw new Error('annotate: conversation service unavailable');
            const shell = conversation.input.for(actx);
            return {
              appendToComposer(block) {
                const current = shell.snapshot.draft;
                shell.setDraft(current === '' ? block : `${current}\n\n${block}`);
              },
            };
          },
        }, AnnotateButton));
      },
    };
  },
});
```

> 「能不能拿到输入框」这一步跑通之后，再按 §6 / §7 / §8 加 webview 定位与注入。
> 这样任何一步出问题，你都知道是新加的那一步，而不是一开始就把三件事搅在一起。
