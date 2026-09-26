/**
 * Client 半边（浏览器）：右侧边栏的「标注浏览器」tab。
 *
 * 做四件事：
 *   1. 注册一个自己的 tab 类型（自建 <webview>，所以工具栏是我们自己的）；
 *   2. 工具栏：后退 / 前进 / 刷新 / 地址栏 / vConsole / H5 宽度 / 标注（都是官方风格的图标按钮）；
 *   3. 标注模式：往页面里注入自包含的 overlay，点元素 → 高亮 → 回读 selector；
 *   4. 发送：把一条标注变成输入框里的一个 chip；正文只留一行 `@标注N · 批注`，
 *      详情（selector / 坐标 / 页面 URL / 截图）POST 给宿主半边存起来。
 *
 * 关键设计（主文档 §15 / §18.5 + 方案 D 的变体）：
 *   - 气泡脏不了：`sendSession(text, …)` 只有一份字符串、没有「显示用/模型用」两份，
 *     所以详情不进正文，改走 **宿主侧存储 + 模型侧工具**（index.js 的 browser_annotations）——
 *     模型按需读，截图作为图片内容块回给模型，气泡里始终只有一行。
 *   - 宿主收不下（路由没挂 / 连不上）时自动降级：把元素定位写进那一行，信息不丢。
 *   - 输入框画在【React 层】（浮在 webview 上），不画在页面里 —— 页面里的按钮没法通知插件（§17.6）。
 *   - 只有「标注模式激活且还没选中元素」的这段时间才轮询（250ms），选中/退出立刻停。
 *   - 截图：截图前先让页面里的 overlay 把高亮框画出来，再 `webview.capturePage(rect)`，
 *     PNG 随批注一起 POST 到宿主；由宿主提交给附件服务，工具调用时按图片返回。
 *
 * 改这个文件约 0.5 秒后界面自动热重载（dsh-client-hmr 轮询 bundle 的 mtime/ctime/size）。
 */
window.__ModuleLoader__.load({
  // 必须等于 package.json 的 name
  id: '@local/dsh-annotate',

  factory(require) {
    // 平台种子表只保证 React / cordis / 若干静态 UI 库。
    // 【绝对不要】require 任何 @deepseek-ai/dsh-client-* 包：它们会变，
    // 而且你的组件一 throw，整个 slot entry 就白屏（控制台只剩 slot entry crashed）。
    const React = require('react');

    /** tab 类型的全局唯一 id，同时也是两个 keyed slot 的 key。 */
    const TAB_ID = '@local/dsh-annotate';
    /** 页类型（kind）：不写 patterns，只按 kind 打开。 */
    const TAB_KIND = 'annotate-browser';
    /** chip 的 source name；发送时按它在 roster 里找到我们的 codec。 */
    const SOURCE = 'annotate';
    /** 注入脚本的版本号：不匹配就重装（改了 overlay 就要 +1，否则旧页面里的旧版本会被当成已装）。 */
    const OVERLAY_VERSION = 2;
    /** 标注模式下的回读间隔（只在激活期间跑）。 */
    const POLL_MS = 250;

    const message = (error) => (error instanceof Error ? error.message : String(error));
    /** 尽量用真 UUID，环境不支持时退化成随机串。 */
    const makeId = () =>
      globalThis.crypto !== undefined && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : 'a-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

    /** 桌面版主帧才拿得到完整的 dshDesktop；其它文档只有降级桩。 */
    const desktopBridge = () => {
      const carrier = globalThis.dshDesktop;
      return carrier !== undefined && carrier.protocolVersion === 1 ? carrier.browser : undefined;
    };

    // ────────────────────────────────────────────────────────────── overlay

    /**
     * 注入到 guest 页面里的标注器。
     *
     * ⚠️ 必须【自包含】：运行时会被 toString() 序列化后丢进页面执行，
     * 闭包不到这个文件里的任何外部变量。所以只用它自己的局部变量 + 浏览器全局。
     */
    function overlayMain() {
      const KEY = '__DSH_ANNOTATE__';
      const VERSION = 2;
      const Z = 2147483000;
      const prior = window[KEY];
      if (prior !== undefined && prior.version === VERSION) return true;
      // 版本不匹配：先把旧版本拆干净（否则它的监听器和浮层会留在页面里）
      if (prior !== undefined && typeof prior.uninstall === 'function') {
        try {
          prior.uninstall();
        } catch (error) {
          /* 拆旧版本失败也要继续装新的 */
        }
      }

      const highlight = document.createElement('div');
      highlight.style.cssText =
        'position:fixed;z-index:' + Z + ';display:none;box-sizing:border-box;margin:0;padding:0;' +
        'pointer-events:none;transition:none;border:2px solid #4C8DFF;border-radius:3px;' +
        'background:rgba(76,141,255,0.14);';
      const caption = document.createElement('div');
      caption.style.cssText =
        'position:fixed;z-index:' + (Z + 1) + ';display:none;max-width:340px;margin:0;padding:2px 6px;' +
        'pointer-events:none;border-radius:4px;background:rgba(31,41,55,0.94);color:#F9FAFB;' +
        'font:11px/16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      document.documentElement.appendChild(highlight);
      document.documentElement.appendChild(caption);

      const state = { version: VERSION, picking: false, pick: null, hover: null };

      const escapeIdent = (value) =>
        window.CSS !== undefined && typeof window.CSS.escape === 'function'
          ? window.CSS.escape(value)
          : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');

      /** 尽量短又能唯一定位的选择器：优先 #id，否则 tag + nth-of-type 往上走到 6 层。 */
      const cssPath = (element) => {
        const parts = [];
        let node = element;
        let depth = 0;
        while (node !== null && node !== undefined && node.nodeType === 1 && depth < 6) {
          const tag = node.tagName.toLowerCase();
          if (node.id !== '' && document.querySelectorAll('#' + escapeIdent(node.id)).length === 1) {
            parts.unshift('#' + escapeIdent(node.id));
            break;
          }
          let part = tag;
          const parent = node.parentElement;
          if (parent !== null) {
            const same = Array.prototype.filter.call(
              parent.children,
              (child) => child.tagName === node.tagName,
            );
            if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
          }
          parts.unshift(part);
          node = node.parentElement;
          depth += 1;
        }
        return parts.join(' > ');
      };

      const textOf = (element) => {
        const raw = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
        return raw.length > 80 ? raw.slice(0, 77) + '…' : raw;
      };
      const htmlOf = (element) => {
        const raw = String(element.outerHTML || '');
        return raw.length > 400 ? raw.slice(0, 400) + '…' : raw;
      };

      /** 回给插件的纯 JSON（executeJavaScript 的返回值必须能跨进程序列化）。 */
      const describe = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          selector: cssPath(element),
          tag: element.tagName.toLowerCase(),
          text: textOf(element),
          html: htmlOf(element),
          ariaLabel: element.getAttribute('aria-label') || '',
          url: location.href,
          title: document.title,
          rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        };
      };

      const show = (rect, label) => {
        highlight.style.left = rect.left + 'px';
        highlight.style.top = rect.top + 'px';
        highlight.style.width = rect.width + 'px';
        highlight.style.height = rect.height + 'px';
        highlight.style.display = 'block';
        caption.textContent = label;
        caption.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 350)) + 'px';
        caption.style.top =
          (rect.bottom + 26 > window.innerHeight ? Math.max(4, rect.top - 24) : rect.bottom + 6) + 'px';
        caption.style.display = 'block';
      };
      const hide = () => {
        highlight.style.display = 'none';
        caption.style.display = 'none';
      };

      const onMove = (event) => {
        if (!state.picking) return;
        const element = event.target;
        if (element === null || element === undefined || element.nodeType !== 1) return;
        state.hover = element;
        const text = textOf(element);
        show(element.getBoundingClientRect(), cssPath(element) + (text === '' ? '' : ' · ' + text));
      };
      // 点选时把页面自己的按下 / 点击行为全部拦掉，否则会顺手触发页面交互。
      const swallow = (event) => {
        if (!state.picking) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      };
      const onClick = (event) => {
        if (!state.picking) return;
        swallow(event);
        const element = event.target;
        if (element !== null && element !== undefined && element.nodeType === 1) {
          state.pick = describe(element);
        }
        setPicking(false);
      };
      const onKey = (event) => {
        if (event.key === 'Escape' && state.picking) setPicking(false);
      };
      const onScroll = () => {
        if (!state.picking || state.hover === null) return;
        if (!state.hover.isConnected) return;
        const text = textOf(state.hover);
        show(state.hover.getBoundingClientRect(), cssPath(state.hover) + (text === '' ? '' : ' · ' + text));
      };

      function setPicking(on) {
        state.picking = on === true;
        if (!state.picking) {
          hide();
          state.hover = null;
        }
      }

      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mousedown', swallow, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', onScroll, true);

      window[KEY] = {
        version: VERSION,
        setPicking,
        /**
         * 把某个元素的高亮框亮一下（截图前用：这样截出来的图上有蓝框）。
         * @param selector - 之前回读出去的那个选择器
         * @param ms - 亮多久
         * @returns 是否找到了元素
         */
        flash(selector, ms) {
          let element = null;
          try {
            element = document.querySelector(selector);
          } catch (error) {
            element = null;
          }
          if (element === null) return false;
          const text = textOf(element);
          show(element.getBoundingClientRect(), cssPath(element) + (text === '' ? '' : ' · ' + text));
          window.setTimeout(() => {
            if (!state.picking) hide();
          }, Math.max(60, Number(ms) || 600));
          return true;
        },
        /** 插件侧唯一要读的东西：当前是否在选、以及刚选中的元素（读完即清）。 */
        pull() {
          const out = { picking: state.picking, pick: state.pick };
          state.pick = null;
          return out;
        },
        uninstall() {
          document.removeEventListener('mousemove', onMove, true);
          document.removeEventListener('mousedown', swallow, true);
          document.removeEventListener('click', onClick, true);
          document.removeEventListener('keydown', onKey, true);
          window.removeEventListener('scroll', onScroll, true);
          highlight.remove();
          caption.remove();
          delete window[KEY];
        },
      };
      return true;
    }

    /** 注入用的源码：已装过就直接返回，省一次重复注入。 */
    const OVERLAY_SOURCE =
      '(function () { if (window.__DSH_ANNOTATE__ && window.__DSH_ANNOTATE__.version === ' +
      OVERLAY_VERSION +
      ') return true; (' +
      overlayMain.toString() +
      ')(); return true; })()';

    // ──────────────────────────────────────────────────────────────── CSS

    const CSS = `
.annotate-root { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0;
  flex: auto; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
/* 尺寸照着官方 Browser 的工具栏抄：38px 的条、28px 的圆点按钮、16px 的图标。
   （之前是 24px 按钮 + 13px 文字字形，所以显得小。） */
.annotate-toolbar { display: flex; align-items: center; gap: 4px; flex: none; box-sizing: border-box;
  height: 38px; padding: 5px 6px; border-bottom: .5px solid var(--dsw-alias-border-l3); }
.annotate-icon { flex: none; width: 28px; height: 28px; display: inline-flex; align-items: center;
  justify-content: center; padding: 0; border: 0; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-secondary); line-height: 0; cursor: pointer; }
.annotate-icon:hover:not(:disabled) { color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover); }
.annotate-icon:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.annotate-form { flex: 1 1 auto; min-width: 0; display: flex; }
.annotate-address { width: 100%; height: 28px; padding: 0 8px; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; outline: none; }
.annotate-address:focus { border-color: var(--dsw-alias-state-business-primary); }
/* 图标按钮的「开启」态：底色 + 主题色，免得只剩下一个小图标看不出状态 */
.annotate-icon.is-on { color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-interactive-bg-hover); }
.annotate-viewport { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; }
.annotate-host { position: absolute; inset: 0; }
/* H5（窄屏）模式：webview 居中收成手机宽度，页面会按 375px 重新排版（媒体查询会命中）。
   只改容器宽度就行 —— webview 的尺寸就是 guest 的视口尺寸。 */
.annotate-viewport.is-h5 { background: var(--dsw-alias-bg-layer-2); }
.annotate-viewport.is-h5 .annotate-host { left: 50%; right: auto; width: 375px; max-width: 100%;
  transform: translateX(-50%); border-left: .5px solid var(--dsw-alias-border-l3);
  border-right: .5px solid var(--dsw-alias-border-l3); box-shadow: var(--dsw-elevation-prominent); }
.annotate-h5-tag { position: absolute; top: 6px; left: 50%; transform: translateX(-50%); z-index: 2;
  padding: 2px 8px; border-radius: 999px; background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; pointer-events: none; }
.annotate-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
.annotate-hint { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
  padding: 4px 10px; border-radius: 999px; background: rgba(31,41,55,.92); color: #F9FAFB;
  font-size: 11px; pointer-events: none; white-space: nowrap; }
.annotate-error { position: absolute; left: 8px; right: 8px; bottom: 8px; padding: 6px 10px;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-3);
  border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary);
  font-size: 11px; }
/* 只有真实存在的 token 才用：--dsw-alias-bg-layer-1 是「抬升的面」，明暗两套都有值。
   之前写的 --dsw-alias-bg-elevated 在这个 build 里不存在 → 退化成深色 fallback，
   而文字色用的是真实的 label-primary（浅色主题下接近黑）→ 黑字压深底，看不清。 */
.annotate-pop { position: absolute; width: 300px; box-sizing: border-box; padding: 8px;
  border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l3);
  box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.28));
  color: var(--dsw-alias-label-primary); z-index: 20; }
.annotate-pop-head { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.annotate-pop-sub { margin-top: 2px; font-size: 11px; color: var(--dsw-alias-label-secondary); opacity: .75;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.annotate-pop-input { width: 100%; box-sizing: border-box; height: 72px; margin-top: 6px; padding: 6px 8px;
  resize: none; border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  caret-color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; outline: none; }
.annotate-pop-input:focus { border-color: var(--dsw-alias-state-business-primary); }
.annotate-pop-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-top: 6px; }
.annotate-check { display: inline-flex; align-items: center; gap: 4px; margin-right: auto;
  color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; user-select: none; }
.annotate-check input { margin: 0; }
.annotate-ghost, .annotate-primary { height: 24px; padding: 0 10px; border-radius: var(--dsw-radius-sm);
  font: inherit; font-size: 12px; cursor: pointer; }
.annotate-ghost { border: 1px solid var(--dsw-alias-border-l3); background: transparent;
  color: var(--dsw-alias-label-secondary); }
.annotate-ghost:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.annotate-primary { border: none; background: var(--dsw-alias-button-primary-fill, #3b82f6);
  color: var(--dsw-alias-label-primary-foreground, #fff); }
.annotate-primary:disabled { opacity: .6; cursor: default; }
.annotate-address::placeholder, .annotate-pop-input::placeholder {
  color: var(--dsw-alias-label-tertiary); opacity: 1; }
/* tab chip 的标题：图标 + 文案（官方 BrowserTitle 的 .titleIcon 也是 flex:none + 4px） */
.annotate-title { display: inline-flex; align-items: center; min-width: 0; }
.annotate-title-icon { flex: none; margin-right: 4px; }
.annotate-title-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

    /**
     * 对话气泡里那一行要不要以 `@` 开头。
     *
     * ⚠️ 这个 `@` 不是装饰：用户气泡的文本在渲染前会过一遍 `projectUserText`
     * （dsh-client-ui-primitives），它会把**行首/空格后的 `@非空白串`** 投影成引用 chip
     * （文件图标 + 标签）。所以 `@标注1 · 批注` 里的 `@标注1` 在气泡里**已经是一个 chip**。
     * 代价：那个 chip 是 `<button>`，点了会 `openFile('标注1')` —— 拿标签当文件路径去打开。
     * 不想要这个可点 chip 就把这里设成 false，气泡里就是纯文字 `标注1 · 批注`。
     */
    const NOTE_CHIP = true;

    /** 宿主半边的落库路由；必须和 index.js 里的 ROUTE_PREFIX 一致。 */
    const HOST_ROUTE = '/api/dsh-annotate/batch';
    /** 截图单独补交的路由（先落文字再补图，见 sendAnnotation）。 */
    const HOST_SHOT_ROUTE = '/api/dsh-annotate/screenshot';
    /**
     * 阶段标记：用 `console.error` 打，因为 DSH 只把 **error 级** 的渲染进程 console 收进崩溃报告
     * （`~/Library/Logs/DeepSeek Harness/crash-*.log` 里那句 "renderer console (error level)"）。
     * 渲染进程一崩，这就是唯一能看出死在哪一步的线索。排查完把这个常量设 false 即可。
     */
    const STAGES = true;
    const stage = (text) => {
      if (STAGES) console.error('[dsh-annotate] stage: ' + text);
    };
    /** 截图区域上限（px）：太大既慢又占图片预算，缩到 800x600 以内更稳。 */
    const MAX_SHOT_WIDTH = 800;
    const MAX_SHOT_HEIGHT = 600;
    /** vConsole 的取用地址（Host 半边原样送出 vendor/vconsole.min.js）。 */
    const VCONSOLE_ROUTE = '/api/dsh-annotate/vconsole.js';
    /** vConsole 开关的偏好 key（默认开；关过之后存 'off'）。 */
    const VCONSOLE_PREF_KEY = 'dsh.annotate.vconsole';
    /**
     * 装进页面的 vConsole 配置。
     * `element` 是「元素」面板（相当于半个 Elements），`network` 会挂 XHR/fetch 钩子 ——
     * 这两个正是调 H5 页面时最常用的，所以默认都开。
     */
    const VCONSOLE_OPTIONS = {
      theme: 'dark',
      defaultPlugins: ['system', 'network', 'element', 'storage'],
      maxLogNumber: 2000,
    };

    /**
     * vConsole 开关：**默认开** —— 打开标注浏览器时页面里就带着调试面板。
     *
     * 只有显式关过（localStorage 里存了 'off'）才不注入；按钮随时可以关。
     * 注入点在 `dom-ready`：vConsole 抓不到它创建之前的日志（页面自己的脚本早跑完了），
     * 但之后的 console / XHR / fetch 全都在。
     */
    const readVConsolePreference = () => {
      try {
        return window.localStorage.getItem(VCONSOLE_PREF_KEY) !== 'off';
      } catch (error) {
        return true;
      }
    };
    const writeVConsolePreference = (on) => {
      try {
        window.localStorage.setItem(VCONSOLE_PREF_KEY, on ? 'on' : 'off');
      } catch (error) {
        /* 存不下就只影响下次默认值 */
      }
    };

    /** H5 宽度开关的偏好 key。 */
    const H5_PREF_KEY = 'dsh.annotate.h5';
    /** H5 视口宽度（iPhone 标准宽度；想换 390/414 改这一个数就行）。 */
    const H5_WIDTH = 375;

    /** H5 宽度开关：默认关。 */
    const readH5Preference = () => {
      try {
        return window.localStorage.getItem(H5_PREF_KEY) === 'on';
      } catch (error) {
        return false;
      }
    };
    const writeH5Preference = (on) => {
      try {
        window.localStorage.setItem(H5_PREF_KEY, on ? 'on' : 'off');
      } catch (error) {
        /* 存不下就只影响下次默认值 */
      }
    };

    /**
     * vConsole 源码只取一次（286KB，来自宿主路由 `GET /api/dsh-annotate/vconsole.js`）。
     *
     * ⚠️ 放在**工厂作用域**：`TabBody` 是工厂作用域里的组件，而 `apply()` 里定义的东西它看不见
     * （踩过两次了：`attachShotToMessage`、这里的 `loadVConsoleSource` —— 报错还会被
     * `submit` 的 try/catch 吞掉）。凡是 TabBody 要用的，要么在工厂作用域，要么走 props。
     */
    let vconsoleSource;

    const loadVConsoleSource = async () => {
      if (typeof vconsoleSource === 'string') return vconsoleSource;
      const response = await fetch(VCONSOLE_ROUTE, { headers: { 'x-dsh-annotate': '1' } });
      if (response.ok !== true) throw new Error('宿主返回 ' + response.status);
      const text = await response.text();
      if (typeof text !== 'string' || text.indexOf('VConsole') < 0) {
        throw new Error('拿到的不是 vConsole（宿主里缺 vendor/vconsole.min.js？）');
      }
      vconsoleSource = text;
      return text;
    };

    /** 截图偏好的 localStorage key（带 v2：换 key 可以保证旧的 "on" 不会再把崩溃那条路打开）。 */
    const SHOT_PREF_KEY = 'dsh.annotate.screenshot.v2';

    /**
     * 截图开关的偏好：**默认关**。
     *
     * 原因：`<webview>.capturePage()` 在这个 App 里没有任何官方先例，实测打开它会
     * 让 Desktop 渲染进程崩掉（crash-*.log: "Desktop renderer exited: crashed"）。
     * 在查清之前，这一步必须由用户显式打开；其余链路（文字批注 + 宿主存储 + 工具）不受影响。
     */
    const readShotPreference = () => {
      try {
        return window.localStorage.getItem(SHOT_PREF_KEY) === 'on';
      } catch (error) {
        return false;
      }
    };
    const writeShotPreference = (on) => {
      try {
        window.localStorage.setItem(SHOT_PREF_KEY, on ? 'on' : 'off');
      } catch (error) {
        /* 存不下就只影响下次默认值 */
      }
    };

    /**
     * 一条标注在**对话里**长什么样 —— 就一行：`@标注N · 你写的批注`。
     *
     * 默认（compact = true）只有这一行：详情存在宿主侧，模型用 `browser_annotations` 工具读。
     * 宿主没收到（插件只加载了 client / 路由不可用）时传 false，把元素定位也写进正文，
     * 免得模型两眼一抹黑 —— 代价就是气泡难看一点。
     */
    const renderNote = (entry, index, compact = true) => {
      const head = '\n' + (NOTE_CHIP ? '@' : '') + '标注' + index + ' · ' + entry.comment;
      if (compact) return head + '\n\n';
      const where = [entry.tag, entry.selector, entry.url]
        .filter((value) => value !== undefined && value !== '')
        .join(' · ');
      // 降级形态：末尾两个换行，用户自己在 chip 后面补的字会另起一段
      return head + '\n\n' + (where === '' ? '' : '（元素：' + where + '）\n\n');
    };

    /** chip 上显示的文字：越短越好（chip 最大宽度 240px）。 */
    const chipLabel = (entry, index) => {
      const hint = entry.elementText === '' ? entry.selector : entry.elementText;
      const short = hint.length > 18 ? hint.slice(0, 17) + '…' : hint;
      return '标注' + index + ' · ' + short;
    };

    /**
     * chip 的 payload 仓库。
     *
     * chip 是内存态（§15.5），payload 却是发送时才读的 —— 所以它必须活得比插件实例久：
     * 否则改一次 client.js 热重载，输入框里已经躺着的 chip 就展开不出内容，
     * `serialize` 一 reject 这次发送就被卡住。存 localStorage 就是为这件事。
     */
    const PAYLOAD_KEY = 'dsh.annotate.payloads';
    const PAYLOAD_LIMIT = 100;

    const createPayloadStore = () => {
      const read = () => {
        try {
          const raw = window.localStorage.getItem(PAYLOAD_KEY);
          if (raw === null) return new Map();
          const parsed = JSON.parse(raw);
          return new Map(Array.isArray(parsed) ? parsed : []);
        } catch (error) {
          console.warn('[dsh-annotate] 读取已保存的标注失败', error);
          return new Map();
        }
      };
      const memory = read();
      const flush = () => {
        try {
          window.localStorage.setItem(
            PAYLOAD_KEY,
            JSON.stringify([...memory].slice(-PAYLOAD_LIMIT)),
          );
        } catch (error) {
          console.warn('[dsh-annotate] 保存标注失败', error);
        }
      };
      return {
        get: (ref) => memory.get(ref),
        set(ref, text) {
          memory.set(ref, text);
          flush();
        },
        delete(ref) {
          memory.delete(ref);
          flush();
        },
      };
    };

    // ───────────────────────────────────────────────────────────── 组件

    /**
     * 内联图标。
     *
     * 路径数据抄自 `dsh-client-ui-primitives` 的 `icons/*`（16×16、Regular = 1px 描边），
     * 但**不 require 那个包** —— 平台种子表只保证 React，require DSH Client 包会随版本碎掉。
     */
    const svgProps = (size, strokeWidth, className, viewBox = '0 0 16 16') => ({
      width: size,
      height: size,
      viewBox,
      fill: 'none',
      xmlns: 'http://www.w3.org/2000/svg',
      'aria-hidden': 'true',
      strokeWidth,
      ...(className === undefined ? {} : { className }),
    });

    /** IconChevronLeftOutlineRegular */
    const ChevronLeftIcon = ({ size = 16 }) =>
      React.createElement('svg', svgProps(size, 1), [
        React.createElement('path', {
          key: 'p',
          d: 'M10 4L6.70711 7.29289C6.31658 7.68342 6.31658 8.31658 6.70711 8.70711L10 12',
          stroke: 'currentColor',
        }),
      ]);

    /** IconChevronRightOutlineRegular */
    const ChevronRightIcon = ({ size = 16 }) =>
      React.createElement('svg', svgProps(size, 1), [
        React.createElement('path', {
          key: 'p',
          d: 'M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4',
          stroke: 'currentColor',
        }),
      ]);

    /** IconRefreshOutlineRegular */
    const RefreshIcon = ({ size = 16 }) =>
      React.createElement('svg', svgProps(size, 1), [
        React.createElement('path', {
          key: 'arc',
          d: 'M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1',
          stroke: 'currentColor',
        }),
        React.createElement('path', {
          key: 'tip',
          d: 'M14.4999 1.5V5.1H10.8999',
          stroke: 'currentColor',
        }),
      ]);

    /**
    /**
     * 标注模式的图标（lucide `pen-line`，24 viewBox）。
     * 24 viewBox 配 strokeWidth 1.5 → 渲染到 16px 时和官方那批「16 viewBox / 1px 描边」一样粗。
     */
    const PenLineIcon = ({ size = 16 }) =>
      React.createElement('svg', svgProps(size, 1.5, undefined, '0 0 24 24'), [
        React.createElement('path', { key: 'line', d: 'M12 20h9', stroke: 'currentColor', strokeLinecap: 'round' }),
        React.createElement('path', {
          key: 'pen',
          d: 'M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z',
          stroke: 'currentColor',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ]);

    /** vConsole 的图标（lucide `square-terminal`，24 viewBox）。 */
    const TerminalIcon = ({ size = 16 }) =>
      React.createElement('svg', svgProps(size, 1.5, undefined, '0 0 24 24'), [
        React.createElement('rect', {
          key: 'frame',
          x: 3,
          y: 3,
          width: 18,
          height: 18,
          rx: 2,
          ry: 2,
          stroke: 'currentColor',
        }),
        React.createElement('path', {
          key: 'prompt',
          d: 'm7 9 3 3-3 3',
          stroke: 'currentColor',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        React.createElement('path', { key: 'line', d: 'M13 15h4', stroke: 'currentColor', strokeLinecap: 'round' }),
      ]);

    /** H5 宽度的图标（lucide `smartphone`，24 viewBox）。 */
    const SmartphoneIcon = ({ size = 16 }) =>
      React.createElement('svg', svgProps(size, 1.5, undefined, '0 0 24 24'), [
        React.createElement('rect', {
          key: 'body',
          x: 5,
          y: 2,
          width: 14,
          height: 20,
          rx: 2,
          ry: 2,
          stroke: 'currentColor',
        }),
        React.createElement('path', { key: 'dot', d: 'M12 18h.01', stroke: 'currentColor', strokeLinecap: 'round' }),
      ]);

    /**
     * IconListPenOutlineRegular —— 「列表 + 笔」。
     *
     * tab chip 上的图标：官方浏览器 tab 用的是地球（`IconGlobeOutlineRegular`），
     * 这里故意换成能一眼区分的「标注列表」字形。想跟官方那个完全一致，
     * 把这里换成地球的 artwork 即可（形状都在 primitives 的 `icons/*` 里）。
     */
    const ListPenIcon = ({ size = 16, className }) =>
      React.createElement('svg', svgProps(size, 1, className), [
        React.createElement('path', { key: 'l1', d: 'M4.9375 5.90295H11.0625', stroke: 'currentColor' }),
        React.createElement('path', { key: 'l2', d: 'M4.9375 9.02991H8.27841', stroke: 'currentColor' }),
        React.createElement('path', {
          key: 'frame',
          d: 'M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V7.61328L13 8.68164V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H8.32812L7.39258 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5Z',
          fill: 'currentColor',
        }),
        React.createElement('path', {
          key: 'pen',
          d: 'M8.97212 14.3693C9.17511 14.5723 9.37811 14.7753 9.5811 14.9783C9.67012 14.8953 9.75914 14.8123 9.84815 14.7293C11.4505 13.2352 13.0528 11.7411 14.6551 10.247C14.7441 10.164 14.8331 10.081 14.9221 9.99803C14.5989 9.6748 14.2756 9.35157 13.9524 9.02834C13.8694 9.11736 13.7864 9.20637 13.7034 9.29539C12.2093 10.8977 10.7152 12.5 9.22113 14.1023C9.13813 14.1913 9.05513 14.2803 8.97212 14.3693Z',
          fill: 'currentColor',
        }),
        React.createElement('path', {
          key: 'tip',
          d: 'M11.6323 13.7841C11.6323 14.0395 11.6323 14.295 11.6323 14.5504C11.6812 14.5523 11.7301 14.5543 11.779 14.5562C12.659 14.5913 13.539 14.6263 14.419 14.6614C14.4679 14.6633 14.5168 14.6653 14.5657 14.6672C14.5657 14.3339 14.5657 14.0006 14.5657 13.6672C14.5168 13.6692 14.4679 13.6711 14.419 13.6731C13.539 13.7081 12.659 13.7432 11.779 13.7783C11.7301 13.7802 11.6812 13.7821 11.6323 13.7841Z',
          fill: 'currentColor',
        }),
      ]);

    /**
     * tab 的 body：工具栏 + webview + 浮层输入框。
     *
     * 框架给的 props：sessionId、useTabInfo；我们 inject 的回调再喂
     * sendAnnotation / attachScreenshot / workspaceKeyFor / notify。
     */
    function TabBody(props) {
      const { sessionId, sendAnnotation, attachScreenshot, attachShotToMessage, markShotOnMessage, workspaceKeyFor, notify, useTabInfo } = props;
      const { tab } = useTabInfo();

      const initialUrl = React.useRef(
        tab.navigation === undefined || tab.navigation.params === undefined
          ? ''
          : tab.navigation.params.url === undefined
            ? ''
            : String(tab.navigation.params.url),
      ).current;

      const [address, setAddress] = React.useState(initialUrl);
      const [loading, setLoading] = React.useState(false);
      const [ready, setReady] = React.useState(false);
      const [mode, setMode] = React.useState(false);
      const [pick, setPick] = React.useState(null);
      const [comment, setComment] = React.useState('');
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      /** 这条是否附带元素截图（默认值来自上次的选择）。 */
      const [shot, setShot] = React.useState(readShotPreference);
      /** 是否把 vConsole 注进页面。 */
      const [vconsole, setVconsole] = React.useState(readVConsolePreference);
      /** vConsole 的注入状态：idle / loading / on / error:<msg>（用于按钮 title）。 */
      const [vcState, setVcState] = React.useState('idle');
      /** 是否切到 H5（窄屏）宽度。 */
      const [h5, setH5] = React.useState(readH5Preference);
      const toggleH5 = (on) => {
        setH5(on);
        writeH5Preference(on);
      };
      const toggleShot = (on) => {
        setShot(on);
        writeShotPreference(on);
      };

      const hostRef = React.useRef(null);
      const viewportRef = React.useRef(null);
      const frameRef = React.useRef(null);
      const textRef = React.useRef(null);
      // 给 webview 的监听器读的「最新值」副本：这样切换 vConsole 不需要重建整个 webview
      const vconsoleRef = React.useRef(false);
      const applyVConsoleRef = React.useRef(null);
      const visible = tab.visible !== false;

      const exec = React.useCallback(async (code) => {
        const element = frameRef.current;
        if (element === null) throw new Error('浏览器载体还没就绪');
        return element.executeJavaScript(code, true);
      }, []);

      const installOverlay = React.useCallback(async () => {
        await exec(OVERLAY_SOURCE);
      }, [exec]);

      // 建载体：lease 是资源，卸载 / 会话切换 / 插件卸载都必须 release。
      React.useLayoutEffect(() => {
        let cancelled = false;
        let lease;
        let bridge;
        const host = hostRef.current;
        if (host === null) return undefined;

        const boot = async () => {
          bridge = desktopBridge();
          if (bridge === undefined) {
            // Web 版（dsh web / 浏览器里跑）没有 <webview>（webviewTag 只有桌面主窗口开），
            // 也没有 dshDesktop.browser 租约 → 页面里的东西一概读不到、vConsole 也注不进去。
            // 官方 Browser tab 在 Web 版是降级成 iframe 的：跨源 iframe 同样读不到元素。
            setError(
              '标注浏览器需要桌面版：Web 版没有 webview / dshDesktop.browser，读不到页面元素，也注不进 vConsole。' +
                '（看页面用官方「浏览器」tab —— 它在 Web 版是 iframe；调页面直接按 F12，那是真 DevTools。）',
            );
            return;
          }
          let acquired;
          try {
            acquired = await bridge.acquire(await workspaceKeyFor(sessionId));
          } catch (err) {
            if (!cancelled) setError('申请浏览器载体失败：' + message(err));
            return;
          }
          if (cancelled) {
            await Promise.resolve(bridge.release(acquired.lease)).catch(() => {});
            return;
          }
          lease = acquired.lease;

          const element = document.createElement('webview');
          element.setAttribute('name', acquired.lease);
          element.setAttribute('partition', acquired.partition);
          element.setAttribute('allowpopups', '');
          // 主进程的 will-attach-webview 只认 about:blank#<lease> 这个前缀
          element.setAttribute('src', 'about:blank#' + acquired.lease);
          element.className = 'annotate-frame';

          let applied = false;
          const remember = sessionId + ':' + tab.id;
          element.addEventListener('dom-ready', () => {
            if (cancelled) return;
            setReady(true);
            if (!applied) {
              applied = true;
              // 打开时给的地址优先；没有就用上次停的地方（热重载 / 重启 App 之后接着看）
              const target = initialUrl !== '' ? initialUrl : readLastUrl(remember);
              if (target !== '') {
                setAddress(target);
                element.loadURL(target).catch(() => {});
              }
            }
            // 导航会清掉注入，每次 dom-ready 都补一次
            installOverlay().catch(() => {});
            // vConsole 也一样：页面一换就没了，开着就自动补回去（**默认就是开的**）。
            // 用 ref 读，免得把这个 effect 绑到 vconsole 状态上、每次切换都重建整个 webview。
            // about:blank 是载体的起点，别往它上面注入（省一次 286KB，也免得空白页上闪个悬浮球）。
            if (vconsoleRef.current && String(element.getURL()).indexOf('about:blank') !== 0) {
              applyVConsoleRef.current(true);
            }
          });
          element.addEventListener('did-start-loading', () => {
            if (!cancelled) setLoading(true);
          });
          element.addEventListener('did-stop-loading', () => {
            if (cancelled) return;
            setLoading(false);
            const url = element.getURL();
            if (url !== '' && url !== 'about:blank') {
              setAddress(url);
              writeLastUrl(remember, url);
            }
          });
          element.addEventListener('did-navigate', (event) => {
            if (cancelled) return;
            setError('');
            if (event.url !== '' && event.url !== 'about:blank') {
              setAddress(event.url);
              writeLastUrl(remember, event.url);
            }
          });
          element.addEventListener('did-navigate-in-page', (event) => {
            if (!cancelled && event.isMainFrame && event.url !== 'about:blank') setAddress(event.url);
          });
          element.addEventListener('did-fail-load', (event) => {
            if (cancelled || !event.isMainFrame || event.errorCode === -3) return;
            setLoading(false);
            setError('页面加载失败：' + (event.errorDescription || String(event.errorCode)));
          });

          host.appendChild(element);
          frameRef.current = element;
        };
        boot();

        return () => {
          cancelled = true;
          const element = frameRef.current;
          frameRef.current = null;
          if (element !== null) element.remove();
          if (lease !== undefined && bridge !== undefined) {
            Promise.resolve(bridge.release(lease)).catch(() => {});
          }
        };
      }, []);

      // 进入 / 退出选点模式；选中 pending 时先暂停，等输入框处理完再恢复。
      React.useEffect(() => {
        if (!ready) return undefined;
        const on = mode && pick === null;
        installOverlay()
          .then(() =>
            exec(
              '(window.__DSH_ANNOTATE__ ? window.__DSH_ANNOTATE__.setPicking(' +
                (on ? 'true' : 'false') +
                ') : null)',
            ),
          )
          .catch(() => {});
        return undefined;
      }, [ready, mode, pick, installOverlay, exec]);

      // 唯一需要轮询的地方：正在选元素时，每 250ms 问一次页面「选好了吗」。
      React.useEffect(() => {
        if (!ready || !mode || pick !== null || !visible) return undefined;
        const element = frameRef.current;
        if (element === null) return undefined;
        let stopped = false;
        const tick = () => {
          element
            .executeJavaScript(
              '(window.__DSH_ANNOTATE__ ? window.__DSH_ANNOTATE__.pull() : null)',
              true,
            )
            .then((out) => {
              if (stopped || out === null || out === undefined) return;
              if (out.pick) {
                setPick(out.pick);
                setComment('');
                return;
              }
              // 用户在页面里按了 Esc
              if (out.picking === false) setMode(false);
            })
            .catch(() => {});
        };
        const timer = window.setInterval(tick, POLL_MS);
        return () => {
          stopped = true;
          window.clearInterval(timer);
        };
      }, [ready, mode, pick, visible]);

      // Esc：主帧自己也要能退出（光标在输入框或工具栏时不会进 guest）。
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          if (pick !== null) {
            setPick(null);
            return;
          }
          if (mode) setMode(false);
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
      }, [mode, pick]);

      React.useEffect(() => {
        if (pick !== null && textRef.current !== null) textRef.current.focus();
      }, [pick]);

      const go = (event) => {
        event.preventDefault();
        const element = frameRef.current;
        if (element === null) return;
        let target = address.trim();
        if (target === '') return;
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) target = 'https://' + target;
        setError('');
        element.loadURL(target).catch((err) => setError('无法打开：' + message(err)));
      };
      const reload = () => {
        const element = frameRef.current;
        if (element !== null) element.reload();
      };
      const back = () => {
        const element = frameRef.current;
        if (element !== null && element.canGoBack()) element.goBack();
      };
      const forward = () => {
        const element = frameRef.current;
        if (element !== null && element.canGoForward()) element.goForward();
      };

      /**
       * 把 vConsole 注进**页面**（不是我们的 React 层）。
       *
       * 这是绕开「DSH 给 guest 强制 `devTools: !app.isPackaged`」的唯一干净办法：
       * vConsole 就是一段页面 JS，用 `executeJavaScript` 塞进去，它自己去 hook 页面的
       * console / XHR / fetch / storage —— 所以打包版照样能用。
       *
       * 注入分两步：先塞源码（它会把 `VConsole` 挂到 window），再实例化。
       * 不能合成一句，因为 UMD 尾巴上可能是行注释，拼一起会被吃掉。
       */
      const applyVConsole = async (on) => {
        const element = frameRef.current;
        if (element === null) return;
        try {
          if (on) {
            setVcState('loading');
            const source = await loadVConsoleSource();
            stage('vconsole:inject ' + source.length + 'B');
            await exec(source + '\n;true');
            const outcome = await exec(
              '(function () { try { if (window.__DSH_VCONSOLE__) return "already"; ' +
                'window.__DSH_VCONSOLE__ = new VConsole(' +
                JSON.stringify(VCONSOLE_OPTIONS) +
                '); return "on"; } catch (error) { return "error:" + String(error && error.message ? error.message : error); } })()',
            );
            stage('vconsole:' + outcome);
            if (typeof outcome === 'string' && outcome.indexOf('error:') === 0) {
              setVcState(outcome);
              setError('vConsole 注入失败：' + outcome.slice(6));
            } else {
              setVcState('on');
            }
          } else {
            stage('vconsole:destroy');
            await exec(
              '(function () { try { if (window.__DSH_VCONSOLE__) { window.__DSH_VCONSOLE__.destroy(); ' +
                'window.__DSH_VCONSOLE__ = null; } try { delete window.VConsole; } catch (error) {} ' +
                'return "off"; } catch (error) { return "error:" + String(error && error.message ? error.message : error); } })()',
            );
            setVcState('idle');
          }
        } catch (error) {
          stage('vconsole:threw ' + message(error));
          setVcState('error:' + message(error));
          setError('vConsole 没装上：' + message(error));
        }
      };

      const toggleVConsole = (on) => {
        setVconsole(on);
        writeVConsolePreference(on);
        applyVConsole(on).catch(() => {});
      };

      /**
       * 截当前选中元素那一块（带上高亮框）。
       *
       * 顺序很重要：先让页面里的 overlay 把蓝框画出来，等一帧再截 —— 这样模型看到的就是
       * 「用户圈的是这里」。截图整块失败（某些页面会拒绝）就退化成截整个视口。
       */
      const captureScreenshot = async (target) => {
        const element = frameRef.current;
        if (element === null) return undefined;
        try {
          stage('capture:flash');
          await exec(
            '(window.__DSH_ANNOTATE__ ? window.__DSH_ANNOTATE__.flash(' +
              JSON.stringify(target.selector === undefined ? '' : target.selector) +
              ', 1500) : false)',
          );
          await new Promise((resolve) => window.setTimeout(resolve, 90));
          const rect =
            target.rect === undefined || target.rect === null
              ? { x: 0, y: 0, width: 0, height: 0 }
              : target.rect;
          const pad = 8;
          const x = Math.max(0, Math.floor(rect.x - pad));
          const y = Math.max(0, Math.floor(rect.y - pad));
          const width = Math.max(1, Math.min(Math.ceil(rect.width + pad * 2), MAX_SHOT_WIDTH));
          const height = Math.max(1, Math.min(Math.ceil(rect.height + pad * 2), MAX_SHOT_HEIGHT));
          stage('capture:start ' + x + ',' + y + ' ' + width + 'x' + height);
          // ⚠️ 这一句是整条链路里唯一没有官方先例的调用（全 App 没有别处用 capturePage）。
          // 只传 rect，不再退化成整屏截图 —— 让这一步的行为尽量单一，崩了也好定位。
          const image = await element.capturePage({ x, y, width, height });
          stage('capture:resolved');
          /**
           * ⚠️ 绝对不要用 `image.toPNG()` / `toJPEG()` / `toBitmap()`。
           *
           * Electron 源码（v44 `shell/common/api/electron_api_native_image.cc`）：
           *   ToPNG()     → electron::Buffer::Copy(isolate, png_span)   // 造一个 Node Buffer
           *   ToDataURL() → webui::GetBitmapDataUrl(bitmap)             // 只返回 std::string
           * 这个 App 的渲染进程是沙箱化的（没有 Node 环境），于是 `toPNG()` 里那句 Buffer
           * 构造会直接 SIGTRAP 把渲染进程打死 —— 实测崩溃栈正是
           * `v8::ValueSerializer::WriteRawBytes`（往新 Buffer 里拷 PNG 字节），
           * 日志停在 `stage: capture:resolved`，`capture:done` 永远打不出来。
           *
           * `toDataURL()` 返回 "data:image/png;base64,...."，不碰 Buffer，安全。
           */
          const dataUrl = image.toDataURL();
          stage('capture:dataurl ' + (typeof dataUrl === 'string' ? dataUrl.length : -1));
          const comma = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
          const base64 = comma < 0 ? '' : dataUrl.slice(comma + 1);
          if (base64 === '') {
            stage('capture:empty');
            return undefined;
          }
          stage('capture:done ' + base64.length + 'B base64');
          return {
            base64,
            mediaType: dataUrl.slice(5, comma).indexOf('jpeg') >= 0 ? 'image/jpeg' : 'image/png',
            width,
            height,
            name: 'annotation-' + Date.now() + '.png',
          };
        } catch (error) {
          stage('capture:threw ' + message(error));
          return undefined;
        }
      };

      const submit = async () => {
        if (pick === null || busy) return;
        const text = comment.trim();
        if (text === '') {
          if (textRef.current !== null) textRef.current.focus();
          return;
        }
        setBusy(true);
        setError('');
        try {
          const entry = {
            selector: pick.selector,
            tag: pick.tag === undefined ? '' : pick.tag,
            elementText: pick.text === undefined ? '' : pick.text,
            html: pick.html === undefined ? '' : pick.html,
            ariaLabel: pick.ariaLabel === undefined ? '' : pick.ariaLabel,
            url: pick.url === undefined ? '' : pick.url,
            title: pick.title === undefined ? '' : pick.title,
            comment: text,
            rect: pick.rect,
            viewport:
              viewportRef.current === null
                ? undefined
                : {
                    width: Math.round(viewportRef.current.getBoundingClientRect().width),
                    height: Math.round(viewportRef.current.getBoundingClientRect().height),
                  },
          };
          // 第一步：文字（+ chip）。这一步失败就整体失败。
          const result = await sendAnnotation(entry);
          if (result !== undefined && result.ok === false) {
            setError(result.message);
            return;
          }
          setPick(null);
          setComment('');

          // 第二步：截图（可崩的那一步）。chip 已经在输入框里了，崩也只丢图。
          if (shot && result !== undefined && result.batchId !== undefined) {
            const screenshot = await captureScreenshot(pick);
            if (screenshot === undefined) {
              notify('warning', '截图没成功，这条只有文字');
            } else if (await attachShotToMessage(screenshot)) {
              // 图跟着消息走（气泡里可见）→ 告诉宿主一声，别让工具说「截图：（无）」
              await markShotOnMessage(result.batchId, result.index);
            } else {
              // 附件那条路不可用 → 退化成「图存宿主、工具返回」
              notify('warning', '截图没能挂到消息上，改成让模型用工具读（气泡里看不到图）');
              await attachScreenshot(result.batchId, result.index, screenshot);
            }
          }
        } catch (err) {
          setError('发送失败：' + message(err));
        } finally {
          setBusy(false);
        }
      };

      // 渲染期同步给监听器用的 ref（不用 effect，免得晚一帧读到旧值）
      vconsoleRef.current = vconsole;
      applyVConsoleRef.current = applyVConsole;

      // 浮层输入框贴在选中元素旁边（guest 的 rect 就是 webview 内的 CSS 像素，直接可用）。
      const popPlacement = (() => {
        if (pick === null) return { display: 'none' };
        // 别信回读来的对象：字段缺失时退化成一个固定位置，绝不让渲染期抛异常
        const rect =
          pick.rect === undefined || pick.rect === null
            ? { x: 8, y: 8, width: 0, height: 0 }
            : pick.rect;
        const viewport = viewportRef.current;
        const box = viewport === null ? null : viewport.getBoundingClientRect();
        // guest 的 x/y 是「webview 内」的坐标；H5 模式下 webview 是居中的，
        // 所以要把 host 相对 viewport 的偏移加回去，否则浮层会整体偏左。
        const host = hostRef.current;
        const hostBox = host === null ? null : host.getBoundingClientRect();
        const hostLeft = hostBox === null || box === null ? 0 : hostBox.left - box.left;
        const hostTop = hostBox === null || box === null ? 0 : hostBox.top - box.top;
        const hostWidth = hostBox === null ? (box === null ? 320 : box.width) : hostBox.width;
        const hostHeight = hostBox === null ? (box === null ? 600 : box.height) : hostBox.height;
        const width = 300;
        const height = 176;
        const limitX = hostLeft + hostWidth - width - 8;
        const limitY = hostTop + hostHeight;
        const below = hostTop + rect.y + rect.height + 8;
        return {
          left: Math.max(hostLeft + 8, Math.min(hostLeft + rect.x, Math.max(hostLeft + 8, limitX))) + 'px',
          top:
            (below + height > limitY ? Math.max(hostTop + 8, hostTop + rect.y - height - 8) : below) + 'px',
        };
      })();

      const frame = frameRef.current;
      const canGoBack = ready && frame !== null && frame.canGoBack();
      const canGoForward = ready && frame !== null && frame.canGoForward();

      return React.createElement(
        'div',
        { className: 'annotate-root' },
        React.createElement(
          'div',
          { key: 'toolbar', className: 'annotate-toolbar' },
          React.createElement(
            'button',
            {
              key: 'back',
              type: 'button',
              className: 'annotate-icon',
              title: '后退',
              disabled: !canGoBack,
              onClick: back,
            },
            React.createElement(ChevronLeftIcon, { size: 16 }),
          ),
          React.createElement(
            'button',
            {
              key: 'forward',
              type: 'button',
              className: 'annotate-icon',
              title: '前进',
              disabled: !canGoForward,
              onClick: forward,
            },
            React.createElement(ChevronRightIcon, { size: 16 }),
          ),
          React.createElement(
            'button',
            {
              key: 'reload',
              type: 'button',
              className: 'annotate-icon',
              title: loading ? '正在加载…' : '刷新',
              disabled: !ready,
              onClick: reload,
            },
            React.createElement(RefreshIcon, { size: 16 }),
          ),
          React.createElement(
            'form',
            { key: 'address', className: 'annotate-form', onSubmit: go },
            React.createElement('input', {
              className: 'annotate-address',
              value: address,
              placeholder: '输入地址后回车',
              spellCheck: false,
              onChange: (event) => setAddress(event.target.value),
            }),
          ),
          React.createElement(
            'button',
            {
              key: 'vconsole',
              type: 'button',
              className: 'annotate-icon' + (vconsole ? ' is-on' : ''),
              title:
                vcState === 'loading'
                  ? 'vConsole 注入中…'
                  : vconsole
                    ? '关掉页面里的 vConsole（它挂在页面里，不是我们的 UI）'
                    : '把 vConsole 注进页面：console / 网络 / 元素 / 存储 都能看（跑在页面里，所以打包版也能用）',
              onClick: () => toggleVConsole(!vconsole),
            },
            React.createElement(TerminalIcon, { size: 16 }),
          ),
          React.createElement(
            'button',
            {
              key: 'h5',
              type: 'button',
              className: 'annotate-icon' + (h5 ? ' is-on' : ''),
              title: h5 ? `切回全宽（现在是 H5 ${H5_WIDTH}px）` : `切到 H5 宽度（${H5_WIDTH}px），页面会按窄屏重排`,
              onClick: () => toggleH5(!h5),
            },
            React.createElement(SmartphoneIcon, { size: 16 }),
          ),
          React.createElement(
            'button',
            {
              key: 'annotate',
              type: 'button',
              className: 'annotate-icon' + (mode ? ' is-on' : ''),
              title: mode
                ? '退出标注模式（Esc）'
                : `标注模式：点页面上的元素，把批注送进对话${h5 ? `（当前 H5 ${H5_WIDTH}px）` : ''}`,
              onClick: () => setMode((on) => !on),
            },
            React.createElement(PenLineIcon, { size: 16 }),
          ),
        ),
        React.createElement(
          'div',
          { key: 'viewport', ref: viewportRef, className: 'annotate-viewport' + (h5 ? ' is-h5' : '') },
          React.createElement('div', { key: 'host', ref: hostRef, className: 'annotate-host' }),
          h5
            ? React.createElement('div', { key: 'h5tag', className: 'annotate-h5-tag' }, `H5 · ${H5_WIDTH}px`)
            : null,
          mode && pick === null
            ? React.createElement(
                'div',
                { key: 'hint', className: 'annotate-hint' },
                '标注模式：点页面上的任意元素 · Esc 退出',
              )
            : null,
          error === ''
            ? null
            : React.createElement('div', { key: 'error', className: 'annotate-error' }, error),
          pick === null
            ? null
            : React.createElement(
                'div',
                { key: 'pop', className: 'annotate-pop', style: popPlacement },
                React.createElement(
                  'div',
                  { key: 'head', className: 'annotate-pop-head' },
                  pick.selector,
                ),
                pick.text === '' || pick.text === undefined
                  ? null
                  : React.createElement('div', { key: 'sub', className: 'annotate-pop-sub' }, pick.text),
                React.createElement('textarea', {
                  key: 'input',
                  ref: textRef,
                  className: 'annotate-pop-input',
                  value: comment,
                  placeholder: '这条批注想改什么？（回车发送，Shift+回车换行）',
                  onChange: (event) => setComment(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter') return;
                    // 回车发送、Shift+回车换行（多行批注还是能用）；⌘/Ctrl+回车照旧
                    if (event.shiftKey) return;
                    event.preventDefault();
                    submit();
                  },
                }),
                React.createElement(
                  'div',
                  { key: 'actions', className: 'annotate-pop-actions' },
                  React.createElement(
                    'label',
                    { key: 'shot', className: 'annotate-check', title: '把选中元素那一块的截图挂到消息上：气泡里能直接看到，模型也一起看到' },
                    React.createElement('input', {
                      type: 'checkbox',
                      checked: shot,
                      disabled: busy,
                      onChange: (event) => toggleShot(event.target.checked),
                    }),
                    React.createElement('span', null, '截图'),
                  ),
                  React.createElement(
                    'button',
                    {
                      key: 'cancel',
                      type: 'button',
                      className: 'annotate-ghost',
                      onClick: () => {
                        setPick(null);
                        setComment('');
                      },
                    },
                    '取消',
                  ),
                  React.createElement(
                    'button',
                    {
                      key: 'send',
                      type: 'button',
                      className: 'annotate-primary',
                      disabled: busy,
                      onClick: submit,
                    },
                    busy ? '发送中…' : '发送到输入框',
                  ),
                ),
              ),
        ),
      );
    }

    /**
     * guide（右侧边栏「+」菜单）里的彩色图标。
     *
     * 官方彩色图标来自 `@deepseek-ai/dsh-client-ui-primitives` 的 `GuideArtwork*`，但那是个
     * **普通组件库**（没有 dsh.client / client bundle），官方插件是在**打包时**把它内联进各自
     * bundle 的；这份 client.js 是手写、原样加载的，没有打包器也 require 不到它，
     * 所以照官方的接口自己画：viewBox 36×36、`size` 由 guide 传 22 或 26、
     * 颜色用官方色板（#539CFA 蓝 / #679EFE 浅蓝 / #FFBC4D 琥珀 / #FFCD78 浅琥珀 / #A797FC 紫 / #45E7A4 青绿）。
     * 不给 icon 时框架会画灰色的 CubeGlyph 兜底 —— 就是之前那个灰方块。
     */
    const AnnotateArtwork = ({ size = 26, className }) =>
      React.createElement(
        'svg',
        {
          width: size,
          height: size,
          className,
          viewBox: '0 0 36 36',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
        },
        [
          // 浏览器窗口 + 标题栏圆点
          React.createElement('rect', { key: 'win', x: 5.5, y: 7.5, width: 25, height: 21, rx: 4,
            stroke: '#539CFA', strokeWidth: 2 }),
          React.createElement('path', { key: 'bar', d: 'M5.5 13.5h25', stroke: '#679EFE', strokeWidth: 2 }),
          React.createElement('circle', { key: 'd1', cx: 9.6, cy: 10.6, r: 1, fill: '#A797FC' }),
          React.createElement('circle', { key: 'd2', cx: 13.1, cy: 10.6, r: 1, fill: '#45E7A4' }),
          // 页面内容
          React.createElement('path', { key: 'line1', d: 'M10 18h7', stroke: '#679EFE', strokeWidth: 2, strokeLinecap: 'round' }),
          // 铅笔（标注）
          React.createElement('path', {
            key: 'pen',
            d: 'M19.4 23.6l7.1-7.1a1.7 1.7 0 0 1 2.4 0l.6.6a1.7 1.7 0 0 1 0 2.4l-7.1 7.1-3.9.9.9-3.9z',
            fill: '#FFBC4D',
          }),
          React.createElement('path', { key: 'tip', d: 'M19.4 23.6l2.9 2.9-3.9.9.9-3.9z', fill: '#FFCD78' }),
        ],
      );

    /**
     * 顶部 tab chip 的标题：图标 + 文案，形状照官方 `BrowserTitle`
     * （官方是 Fragment + `IconGlobeOutlineRegular`；这里包一层 span 自己保证对齐）。
     */
    function TabTitle({ useTabInfo }) {
      const { tab } = useTabInfo();
      return React.createElement(
        'span',
        { className: 'annotate-title' },
        React.createElement(ListPenIcon, { className: 'annotate-title-icon' }),
        React.createElement(
          'span',
          { className: 'annotate-title-text' },
          tab.title === undefined ? '标注浏览器' : tab.title,
        ),
      );
    }

    /**
     * 等一个 snapshot store 进入 ready；超时就用当下的快照，绝不让标注页卡在启动上。
     * @param list - workspaces.list 快照源
     * @param deadlineMs - 最长等待
     */
    function waitReady(list, deadlineMs) {
      return new Promise((resolve) => {
        let stop = () => {};
        let timer;
        const done = () => {
          stop();
          window.clearTimeout(timer);
          resolve();
        };
        const current = list.getSnapshot();
        if (current !== undefined && current.phase === 'ready') {
          resolve();
          return;
        }
        stop = list.subscribe(() => {
          const next = list.getSnapshot();
          if (next !== undefined && next.phase === 'ready') done();
        });
        timer = window.setTimeout(done, deadlineMs);
      });
    }

    /** 由 ctx.inject(['workspaces']) 覆盖；没有 workspaces 服务时退化成会话隔离。 */
    let workspaceKeyFor = (sessionId) => Promise.resolve('session:' + sessionId);

    /**
     * 记住每个标注页最后停在哪。
     *
     * tab 自己的 navigation.params 是「打开时」的参数，事后改不了（tab actions 只有
     * bindCommands / openResource / openTab / close），所以 client.js 一热重载
     * （组件重挂载、lease 重新申请）页面就会退回空白。存一份最后地址，重挂载时接着看。
     */
    const LAST_URL_PREFIX = 'dsh.annotate.lastUrl.';

    const readLastUrl = (key) => {
      try {
        return window.localStorage.getItem(LAST_URL_PREFIX + key) ?? '';
      } catch (error) {
        return '';
      }
    };
    const writeLastUrl = (key, url) => {
      try {
        window.localStorage.setItem(LAST_URL_PREFIX + key, url);
      } catch (error) {
        /* 存不下就算了，不影响浏览 */
      }
    };

    return {
      // 只声明这个插件离不开的服务。sidebarRightTabs 用 ctx.inject([...]) 延迟接入，
      // 缺了（比如换了不带右侧边栏的 build）也只是没有 tab，不影响 chip 那条链路。
      inject: ['slots', 'sessions', 'inputTriggers'],

      apply(ctx) {
        /** ref id -> 发送时展开成什么（chip 的 codec 从这里取）。 */
        const payloads = createPayloadStore();
        /** chip 文案的序号。 */
        let sequence = 0;

        // ── 样式：模块级副作用一律放在 apply 里，用 ctx.effect 收尾
        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-dsh-annotate', '');
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => style.remove();
        }, 'annotate: styles');

        // ── chip 的序列化源：故意不给 trigger，所以它对 @ / 菜单完全不可见，
        //    只承担「发送时把 chip 展开成什么」这一件事（即方案 C：纯 chip）。
        ctx.effect(
          () =>
            ctx.inputTriggers.registerSource({
              name: SOURCE,
              codec: {
                // 刷新 / 切会话后 chip 会退化成这段文字，务必短（§15.5）
                clipboardText: () => '@标注',
                serialize: (ref) => {
                  const note = payloads.get(ref);
                  return note === undefined
                    ? Promise.reject(
                        new Error('标注内容已丢失（可能清过浏览器存储），删掉这个 chip 重新标注'),
                      )
                    : Promise.resolve(note);
                },
              },
            }),
          'annotate: chip codec',
        );

        /** 会话级输入门面；拿不到就降级，不 throw（throw 会让整个 slot entry 白屏）。 */
        const shellFor = (sessionId) => {
          const actx = ctx.sessions.scope(sessionId);
          if (actx === undefined) return undefined;
          const conversation = actx.get('conversation');
          if (conversation === undefined) return undefined;
          return { actx, conversation, shell: conversation.input.for(actx) };
        };

        const notifyFor = (sessionId, level, text) => {
          try {
            const found = shellFor(sessionId);
            if (found !== undefined) found.shell.notify(level, text);
          } catch (error) {
            console.error('[dsh-annotate] notify failed', error);
          }
        };

        /** sessionId → 当前还在攒的批次 id。输入框被清空（消息发出去了）就开始新的一批。 */
        const activeBatch = new Map();

        /**
         * 把一条批注（含可选截图）POST 给宿主半边。
         *
         * 宿主把完整信息存起来，模型用 `browser_annotations` 工具读；消息正文里只留一行。
         * 失败就返回 undefined —— 调用方会降级成「把详情塞进 chip」，信息不会丢。
         */
        const postAnnotation = async (sessionId, entry, draftIsEmpty, screenshot) => {
          const body = {
            batchId: draftIsEmpty ? undefined : activeBatch.get(sessionId),
            sessionId,
            url: entry.url === undefined ? '' : entry.url,
            title: entry.title === undefined ? '' : entry.title,
            viewport: entry.viewport === undefined ? undefined : entry.viewport,
            item: {
              selector: entry.selector === undefined ? '' : entry.selector,
              tag: entry.tag === undefined ? '' : entry.tag,
              elementText: entry.elementText === undefined ? '' : entry.elementText,
              ariaLabel: entry.ariaLabel === undefined ? '' : entry.ariaLabel,
              comment: entry.comment,
              rect: entry.rect === undefined ? undefined : entry.rect,
            },
            screenshot,
          };
          try {
            const response = await fetch(HOST_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-dsh-annotate': '1' },
              body: JSON.stringify(body),
            });
            const payload = await response.json();
            if (response.ok !== true || payload === undefined || payload.ok !== true) {
              const reason =
                payload !== undefined && payload.error !== undefined ? payload.error.message : String(response.status);
              console.warn('[dsh-annotate] 宿主没有收下这条批注：', reason);
              return undefined;
            }
            activeBatch.set(sessionId, payload.value.batchId);
            return payload.value;
          } catch (error) {
            console.warn('[dsh-annotate] 连不上宿主半边（插件可能只加载了 client）：', error);
            return undefined;
          }
        };

        /**
         * 一条标注 = 一个 chip；正文只有一行，详情在宿主侧（或降级塞进 chip）。
         *
         * 顺序是刻意的：**先落文字（不带截图）→ 插 chip → 再补截图**。
         * 截图走的是 `<webview>.capturePage()`，这条路官方代码里没人用过，
         * 万一它把渲染进程搞崩，批注文字和输入框里的 chip 已经在了，只丢一张图。
         */
        const sendAnnotation = async (sessionId, entry) => {
          const found = shellFor(sessionId);
          if (found === undefined) return { ok: false, message: '会话上下文不可用，标注没能写进输入框' };
          const { shell } = found;

          // 输入框还是空的 → 这是新的一条消息 → 开新批次；否则接着上一批攒
          const draft = shell.snapshot === undefined || shell.snapshot.draft === undefined ? '' : shell.snapshot.draft;
          stage('item-post:start');
          const stored = await postAnnotation(sessionId, entry, draft.trim() === '', undefined);
          stage('item-post:' + (stored === undefined ? 'failed' : 'ok ' + stored.batchId + ' #' + stored.index));
          const index = stored === undefined ? ++sequence : stored.index;

          // 宿主收下了 → chip 只带一行；没收下 → 把详情塞进 chip，信息不丢（气泡会难看一点）
          const refId = makeId();
          payloads.set(refId, stored === undefined ? renderNote(entry, index, false) : renderNote(entry, index));

          const accepted = shell.addFiles(
            [
              {
                source: SOURCE,
                ref: refId,
                label: chipLabel(entry, index),
                appearance: 'session',
                clipboardText: '@标注',
              },
            ],
            [],
          );

          if (!accepted) {
            payloads.delete(refId);
            return { ok: false, message: '输入框正在发送 / 确认中，稍后再点一次发送' };
          }

          if (stored === undefined) {
            shell.notify('warning', '宿主没收到这条批注，已把详情写进输入框（模型看不到截图）');
          } else {
            shell.notify('info', '已加入输入框：' + chipLabel(entry, index));
          }
          return { ok: true, batchId: stored === undefined ? undefined : stored.batchId, index };
        };

        /**
         * 把截图作为**消息附件**挂到输入框（官方那条路：`createDrafts` → `addAttachments`）。
         *
         * 这样它既会显示在气泡里（用户能一眼确认圈的是哪儿），也会随消息作为图片发给模型 ——
         * 所以这条成功时**不**再把图 POST 给宿主，避免同一张图喂两遍。
         * @returns 是否挂上去了（false 时调用方退化成「图走宿主、工具返回」）
         */
        const attachShotToMessage = async (sessionId, shot) => {
          const found = shellFor(sessionId);
          if (found === undefined) return false;
          const { conversation, shell } = found;
          if (typeof conversation.createDrafts !== 'function' || typeof shell.addAttachments !== 'function') {
            stage('attach:no-api');
            return false;
          }
          try {
            const bytes = Uint8Array.from(window.atob(shot.base64), (char) => char.charCodeAt(0));
            const file = new File([bytes], shot.name, { type: shot.mediaType });
            const drafts = await Promise.resolve(conversation.createDrafts(sessionId, [file]));
            const ids = (Array.isArray(drafts) ? drafts : [])
              .map((draft) => (typeof draft === 'string' ? draft : draft === undefined || draft === null ? undefined : draft.id))
              .filter((id) => typeof id === 'string' && id !== '');
            if (ids.length === 0) {
              stage('attach:no-draft');
              return false;
            }
            const accepted = shell.addAttachments(ids) !== false;
            stage('attach:' + (accepted ? 'ok ' + ids.length : 'rejected'));
            return accepted;
          } catch (error) {
            stage('attach:threw ' + message(error));
            return false;
          }
        };

        /**
         * 告诉宿主「这条的截图在消息里」，好让工具别再说「截图：（无）」。
         *
         * ⚠️ `attachShotToMessage` / `markShotOnMessage` / `attachScreenshot` 都定义在
         * `apply()` 里，而 `TabBody` 在**工厂作用域** —— 直接引用会 ReferenceError，且被
         * submit 的 try/catch 吞掉（只写进 setError）。所以这几条一律走 props 传进去。
         */
        const markShotOnMessage = async (batchId, index) => {
          try {
            await fetch(HOST_SHOT_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-dsh-annotate': '1' },
              body: JSON.stringify({ batchId, index, onMessage: true }),
            });
          } catch (error) {
            stage('shot-mark:threw ' + message(error));
          }
        };

        /** 退化路径：图存宿主，工具调用时以图片内容块返回。失败只提示。 */
        const attachScreenshot = async (sessionId, batchId, index, screenshot) => {
          stage('shot-post:start ' + screenshot.base64.length + 'B base64');
          try {
            const response = await fetch(HOST_SHOT_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-dsh-annotate': '1' },
              body: JSON.stringify({ batchId, index, screenshot }),
            });
            const payload = await response.json();
            if (response.ok !== true || payload === undefined || payload.ok !== true) {
              const reason =
                payload !== undefined && payload.error !== undefined ? payload.error.message : String(response.status);
              stage('shot-post:failed ' + reason);
              notifyFor(sessionId, 'warning', '截图没能存下（' + reason + '），这条只有文字');
              return;
            }
            stage('shot-post:ok');
          } catch (error) {
            stage('shot-post:threw ' + message(error));
            notifyFor(sessionId, 'warning', '截图没能存下，这条只有文字');
          }
        };

        // ── 右侧边栏：tab 类型 + body
        ctx.inject(['sidebarRightTabs'], (scope) => {
          scope.effect(
            () =>
              scope.sidebarRightTabs.register({
                id: TAB_ID,
                // 不写 patterns：这是「按 kind 打开」的页类型，不认资源地址
                kind: TAB_KIND,
                // 每个会话一个实例：再点一次输入框按钮是「聚焦已有 tab」而不是又开一个
                multiple: false,
                // 切 tab / 切会话 / 折叠时保留 DOM，页面不会被卸载重载
                keepMounted: true,
                title: () => '标注浏览器',
                guide: [
                  {
                    id: 'new',
                    order: 40,
                    title: () => '标注浏览器',
                    description: () => '打开页面，点元素写批注，送进输入框',
                    // 不给 icon 时框架画灰色 CubeGlyph 兜底；给了就用自己的彩色图
                    icon: AnnotateArtwork,
                  },
                ],
              }),
            'annotate: tab type',
          );

          scope.slots.inject('sidebar.right.pane.tab', () =>
            scope.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: TAB_ID,
                inject: (sessionId) => ({
                  sessionId,
                  // 传一层间接：workspaceKeyFor 会被 ctx.inject(['workspaces']) 覆盖，
                  // 这里取到的是当时的值，包一层才能拿到最终实现
                  workspaceKeyFor: (id) => workspaceKeyFor(id),
                  notify: (level, text) => notifyFor(sessionId, level, text),
                  sendAnnotation: (entry) => sendAnnotation(sessionId, entry),
                  attachScreenshot: (batchId, index, screenshot) => attachScreenshot(sessionId, batchId, index, screenshot),
                  attachShotToMessage: (shot) => attachShotToMessage(sessionId, shot),
                  markShotOnMessage: (batchId, index) => markShotOnMessage(batchId, index),
                }),
              },
              TabBody,
            ),
          );

          scope.slots.inject('sidebar.right.pane.tab.title', () =>
            scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, TabTitle),
          );
        });

        // ── workspace 身份：沿用官方浏览器的 key，就能共用同一个 partition / 登录态
        ctx.inject(['workspaces'], (scope) => {
          const list = scope.workspaces.list;
          workspaceKeyFor = async (sessionId) => {
            await waitReady(list, 1500);
            const snapshot = list.getSnapshot();
            const items = snapshot === undefined || snapshot.items === undefined ? [] : snapshot.items;
            const workspace = items.find(
              (item) => item.sessionIds !== undefined && item.sessionIds.indexOf(sessionId) >= 0,
            );
            return workspace === undefined || workspace.path === undefined
              ? 'session:' + sessionId
              : 'cwd:' + workspace.path;
          };
        });
      },
    };
  },
});
