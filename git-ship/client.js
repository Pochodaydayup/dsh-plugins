/**
 * Client 半边，两块东西：
 *
 * ① 输入框上方（`conversation.input.dock`）那条「提交并推送」；
 *
 * 点一下 = **直接把一条用户消息发出去**（`conversation.sendSession`），
 * 完全不经过输入框：不 setDraft、不放 chip、不点发送。消息正文只有一个 token `@提交并推送`，
 * 用户气泡的 `projectUserText` 会把行首的 `@非空白串` 投影成一个引用 chip，所以气泡里看到的就是
 * 一个 chip（没有任何别的文案）。
 *
 * 为什么要「正文只有一个 token」：气泡显示的文字**就是**模型收到的文字（只有一份字符串），
 * 所以要让模型知道该干什么，说明只能放在模型能读、气泡里看不见的地方 —— 见 `index.js`：
 * system prompt 段落（解释这个 token + 5 步流程）+ `git_ship_changes` 工具（只读的精确清单）。
 *
 * ② 右侧边栏的「Git Diff」tab（`sidebarRightTabs` + `sidebar.right.pane.tab[.title]`）：
 *    纯 React 面板（不像标注浏览器那样需要 webview），数据来自宿主那两条**只读**路由
 *    `/api/git-ship/diffs`（一次给全：状态 + 所有文件的 diff）—— 复用 annotate 那套「回环 + 标记头」的安全约定。
 *
 * 约束：只能 `require('react')`。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-git-ship',
  factory: (require) => {
    const React = require('react');

    /** 按钮上的字。 */
    const BUTTON_LABEL = '提交并推送';
    /** 发出去的消息正文 —— 就这一个 token，含义由宿主侧的 system prompt 段落解释。 */
    const MESSAGE_TEXT = '@提交并推送';

    /** 只读路由前缀，和 index.js 保持一致。 */
    const ROUTE_PREFIX = '/api/git-ship';
    /** 标记头。 */
    const MARKER = 'x-dsh-git-ship';

    /** 右侧 tab 的身份（id 同时是两个 keyed slot 的 key）。 */
    const DIFF_TAB_ID = 'git-diff';
    const DIFF_TAB_KIND = 'git-diff';
    /** 一次渲染最多画多少行 diff（再长就截断，避免点一个大文件卡住界面）。 */
    const MAX_DIFF_LINES = 3000;
    /** 连续多少行未修改就折起来（点击可展开）。 */
    const COLLAPSE_MIN = 6;
    /** 轮询间隔：只在「tab 可见 + 窗口聚焦」时按这个间隔重读，默认开，可关。 */
    const POLL_MS = 3000;

    // ────────────────────────────────────────────────────────────── 样式

    const CSS = `
/* 对齐输入框卡片 —— 照卡片真实的盒子推导，而不是猜公式。
   卡片那一侧的真实规则（从 dsh-client-ui-conversation 的 CSS 里读出来）：
     .QJwAZG_root { padding: 0 var(--dsh-composer-side-clearance) 4px; }   ← 外层内边距
     .QJwAZG_card { box-sizing: border-box; width: 100%;
                    max-width: var(--dsh-composer-card-max-width); }      ← 卡片本体
   所以卡片的盒子 = min(栈宽 - 2c, 卡片上限)。我的条子和那层 root 是兄弟，
   想要内容盒完全重合，就得「同一圈 padding + 上限补回那两圈」：
     我的边框盒 = min(栈宽, 卡片上限 + 2c) → 内容盒 = min(栈宽 - 2c, 卡片上限)  ✓ 两者恒等
   （c = --dsh-composer-side-clearance，16px；embedded 变体里是 8px，会自动跟着变。） */
.git-ship-root { box-sizing: border-box; width: 100%;
  max-width: calc(var(--dsh-composer-card-max-width, 100%) + var(--dsh-composer-side-clearance, 16px)
    + var(--dsh-composer-side-clearance, 16px));
  padding: 0 var(--dsh-composer-side-clearance, 16px);
  margin: 0 auto; display: flex; flex-direction: column; gap: 6px; font-size: 12px;
  color: var(--dsw-alias-label-primary); }
.git-ship-bar { display: flex; align-items: center; gap: 8px; }
/* 不透明底：它是带文字的按钮，透明底在输入框上方会跟背景糊在一起。
   用「抬升表面」变量（bg-layer-1 → hover bg-layer-2），跟随主题且完全不透明。 */
.git-ship-btn { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px;
  cursor: pointer; white-space: nowrap; }
.git-ship-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary); }
.git-ship-btn:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; opacity: .7; }

/* ── Git Diff tab ───────────────────────────────────────────────────── */
/* 字号**跟着 App 的字号设置走**（--dsh-content-font-size 由主题服务按用户设置写入，默认 14px），
   不写死 px，这样用户在设置里调大字号，diff 也跟着变大。 */
.git-diff-root { display: flex; flex-direction: column; flex: auto; height: 100%; min-height: 0; overflow: hidden;
  font-size: var(--dsh-content-font-size-secondary, 13px); color: var(--dsw-alias-label-primary); }
.git-diff-scroll { flex: 1; min-height: 0; overflow: auto; background: var(--dsw-alias-bg-base); }
.git-diff-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l3); flex: none; min-width: 0; }
.git-diff-repo { min-width: 0; flex: 1 1 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-secondary); font-size: 12px; }
.git-diff-chip { flex: none; padding: 1px 7px; border-radius: 999px; font-size: 11px; line-height: 18px;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary); }
.git-diff-chip.is-chat { color: var(--dsw-alias-state-business-primary); }
.git-diff-btn { flex: none; display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.git-diff-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.git-diff-btn:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.git-diff-btn.is-on { color: var(--dsw-alias-state-business-primary); border-color: currentColor; }
.git-diff-modes { display: flex; gap: 6px; padding: 6px 10px; flex: none;
  border-bottom: 1px solid var(--dsw-alias-border-l3); }
.git-diff-note { padding: 8px 10px; color: var(--dsw-alias-label-tertiary); line-height: 18px; }
.git-diff-note.is-error { color: var(--dsw-alias-state-error-primary); }
.git-diff-empty { padding: 16px 12px; color: var(--dsw-alias-label-tertiary); text-align: center; line-height: 20px; }
.git-diff-title { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.git-diff-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 文件段：浅色头（不是厚重的灰条），sticky 在滚动容器顶部 */
.git-diff-section { border-bottom: 1px solid var(--dsw-alias-border-l3); }
.git-diff-section-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 9px;
  border: none; background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  cursor: pointer; text-align: left; min-width: 0; position: sticky; top: 0; z-index: 2;
  border-bottom: 1px solid var(--dsw-alias-border-l3); }
.git-diff-section-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
.git-diff-chevron { flex: none; width: 10px; color: var(--dsw-alias-label-tertiary); font-size: 10px; }
.git-diff-badge { flex: none; min-width: 20px; height: 17px; padding: 0 3px; border-radius: 3px;
  font-size: 10px; line-height: 17px; text-align: center; font-weight: 600;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary); }
.git-diff-badge.is-ts { color: var(--dsw-alias-label-primary-bluish, var(--dsw-alias-state-business-primary)); }
.git-diff-badge.is-js { color: var(--dsw-alias-state-warn-label); }
.git-diff-badge.is-css, .git-diff-badge.is-html { color: var(--dsw-alias-state-business-primary); }
.git-diff-status { flex: none; width: 13px; text-align: center; font-weight: 600; font-size: 11px;
  color: var(--dsw-alias-label-tertiary); }
.git-diff-status.is-add { color: var(--dsw-alias-state-success-primary); }
.git-diff-status.is-del { color: var(--dsw-alias-state-error-primary); }
.git-diff-status.is-mod { color: var(--dsw-alias-state-warn-label); }
.git-diff-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  text-align: left; font-family: var(--dsw-font-family-mono, ui-monospace, monospace);
  font-size: var(--dsh-content-font-size-secondary, 13px); }
.git-diff-counts { flex: none; font-size: 12px; font-family: var(--dsw-font-family-mono, ui-monospace, monospace); }
.git-diff-counts .add { color: var(--dsw-alias-state-success-primary); }
.git-diff-counts .del { color: var(--dsw-alias-state-error-primary); }
.git-diff-dot { flex: none; width: 6px; height: 6px; border-radius: 999px;
  background: var(--dsw-alias-state-business-primary); }
.git-diff-side { flex: none; font-size: 11px; padding: 0 6px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-tertiary); }

.git-diff-body { font-family: var(--dsw-font-family-mono, ui-monospace, monospace); }
/* 一行 = [行号][符号][代码]。默认自动换行，宽度随面板自适应（见 .is-wrap 那两条）；
   关掉换行时整行按内容撑开、横向滚。 */
.git-diff-line { display: flex; white-space: pre; min-width: max-content;
  font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.65; }
.git-diff-line > .git-diff-gutter { flex: none; width: 50px; padding-right: 9px; text-align: right;
  /* 行号是要读的：用 secondary。dimmed 是色板里最淡的一档（浅色主题下 #e1e5ee），做正文完全看不清 */
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary)); user-select: none;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); }
.git-diff-line > .git-diff-sign { flex: none; width: 16px; text-align: center; user-select: none;
  color: var(--dsw-alias-label-tertiary); }
.git-diff-line > .git-diff-text { flex: none; padding-right: 12px; }
/* 自动换行：行宽锁在面板宽度内，长行走同一列继续（不再撑出横向滚动条） */
.git-diff-root.is-wrap .git-diff-line { white-space: pre-wrap; min-width: 0; width: 100%; }
.git-diff-root.is-wrap .git-diff-line > .git-diff-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.git-diff-line.is-add { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 13%, transparent); }
.git-diff-line.is-del { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 13%, transparent); }
.git-diff-line.is-add > .git-diff-gutter { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 20%, transparent); }
.git-diff-line.is-del > .git-diff-gutter { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 20%, transparent); }
.git-diff-line.is-hunk > .git-diff-text { color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary)); }
.git-diff-line.is-meta { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.git-diff-line.is-meta > .git-diff-text { padding-left: 6px; }

/* 语法高亮：只用主题语义变量（随明暗主题自动切换） */
.git-diff-tok.is-keyword { color: var(--dsw-alias-state-error-primary); }
.git-diff-tok.is-type { color: var(--dsw-alias-label-primary-bluish, var(--dsw-alias-state-business-primary)); }
.git-diff-tok.is-string { color: var(--dsw-alias-state-success-primary); }
.git-diff-tok.is-number { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-business-primary)); }
.git-diff-tok.is-comment { color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary)); }
.git-diff-tok.is-key { color: var(--dsw-alias-label-primary-bluish, var(--dsw-alias-state-business-primary)); }
.git-diff-tok.is-func { color: var(--dsw-alias-state-business-primary); }
.git-diff-tok.is-tag { color: var(--dsw-alias-state-error-primary); }

/* 「N 行未修改」折叠条 */
.git-diff-fold { display: flex; align-items: center; gap: 8px; padding: 3px 8px 3px 4px;
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary));
  font-size: var(--dsh-content-font-size-secondary, 13px); cursor: pointer; user-select: none;
  background: var(--dsw-alias-bg-layer-1); }
.git-diff-fold:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.git-diff-fold-icon { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 17px;
  border: 1px solid var(--dsw-alias-border-l3); border-radius: 3px; font-size: 9px; line-height: 1; }
`;

    const ensureCss = () => {
      if (document.getElementById('dsh-git-ship-style') !== null) return;
      const style = document.createElement('style');
      style.id = 'dsh-git-ship-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    };

    /** git 分支图标（lucide `git-branch` 的画法，24 viewBox + 1.8 描边）。 */
    const GitIcon = ({ size = 14 }) =>
      React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          strokeWidth: 1.8,
          stroke: 'currentColor',
          'aria-hidden': 'true',
        },
        [
          React.createElement('circle', { key: 'a', cx: 6, cy: 6, r: 2.5 }),
          React.createElement('circle', { key: 'b', cx: 6, cy: 18, r: 2.5 }),
          React.createElement('circle', { key: 'c', cx: 18, cy: 9, r: 2.5 }),
          React.createElement('path', { key: 'd', d: 'M6 8.5v7' }),
          React.createElement('path', { key: 'e', d: 'M8.5 6h4a3 3 0 0 1 3 3v0' }),
        ],
      );

    // ────────────────────────────────────────────────────────────── 组件

    /**
     * 输入框上方的那一条：只有一个按钮，点一下放 chip 并按需发送。
     * @param props - 框架给的 { session, input } + inject 的 { sendChip }。
     */
    function GitShipBar(props) {
      ensureCss();
      const sendNow = props.sendNow;
      const [busy, setBusy] = React.useState(false);
      const onClick = () => {
        if (busy || typeof sendNow !== 'function') return;
        setBusy(true);
        // 不显示任何成功文案；失败会由宿主/会话的 notify 提示（否则「点了没反应」没法排查）
        Promise.resolve(sendNow()).then(
          () => setBusy(false),
          () => setBusy(false),
        );
      };

      return React.createElement(
        'div',
        { className: 'git-ship-root' },
        React.createElement('div', { className: 'git-ship-bar' }, [
          React.createElement(
            'button',
            {
              key: 'go',
              type: 'button',
              className: 'git-ship-btn',
              disabled: busy,
              title: '直接发一条「提交并推送」消息：AI 会分析本次对话的改动并执行 git',
              onClick,
            },
            [
              React.createElement(GitIcon, { key: 'icon', size: 14 }),
              React.createElement('span', { key: 't' }, BUTTON_LABEL),
            ],
          ),
        ]),
      );
    }

    /** git 分支图标（和 dock 那个同一个画法）。 */
    const DiffIcon = ({ size = 14 }) =>
      React.createElement(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', strokeWidth: 1.8,
          stroke: 'currentColor', 'aria-hidden': 'true' },
        [
          React.createElement('path', { key: 'a', d: 'M4 6h6a4 4 0 0 1 4 4v8' }),
          React.createElement('path', { key: 'b', d: 'M4 18h8' }),
          React.createElement('circle', { key: 'c', cx: 18, cy: 8, r: 2.5 }),
          React.createElement('circle', { key: 'd', cx: 6, cy: 6, r: 2.5 }),
          React.createElement('circle', { key: 'e', cx: 6, cy: 18, r: 2.5 }),
        ],
      );

    /** 状态码 → 徽章文字与配色 class。 */
    const badgeOf = (status) => {
      const code = status.trim() === '' ? '?' : status.trim();
      if (code.indexOf('?') >= 0) return { text: 'U', className: 'is-add' };
      if (code.indexOf('R') >= 0) return { text: 'R', className: 'is-mod' };
      if (code.indexOf('C') >= 0) return { text: 'C', className: 'is-mod' };
      if (code.indexOf('A') >= 0) return { text: 'A', className: 'is-add' };
      if (code.indexOf('D') >= 0) return { text: 'D', className: 'is-del' };
      if (code.indexOf('M') >= 0) return { text: 'M', className: 'is-mod' };
      return { text: code.slice(0, 1), className: '' };
    };

    /**
     * 语法高亮的配色**只用主题语义变量**（`--dsw-alias-*`）—— 它们本身随明暗主题切换，
     * 所以不用自己维护两套色板，暗色下也不会瞎。
     */
    const TOKEN_CLASS = {
      keyword: 'is-keyword',
      type: 'is-type',
      string: 'is-string',
      number: 'is-number',
      comment: 'is-comment',
      key: 'is-key',
      func: 'is-func',
      tag: 'is-tag',
    };

    const KEYWORDS = new Set(
      ('const let var function return if else for while do switch case break continue new class extends super this ' +
        'typeof instanceof in of export import from default async await yield try catch finally throw delete void ' +
        'static get set type interface enum implements namespace declare readonly public private protected abstract ' +
        'as is keyof infer satisfies def elif lambda pass raise with global nonlocal assert del not and or end then ' +
        'func package struct map chan go defer select impl fn pub use mod match where loop mut ref').split(' '),
    );
    const TYPE_WORDS = new Set(
      ('string number boolean any unknown never void object symbol bigint null undefined true false NaN Infinity ' +
        'Record Promise Array Map Set Date Error JSON Math Object String Number Boolean Symbol Function').split(' '),
    );

    /** 扩展名 → 语言（决定用哪几条高亮规则）。 */
    const languageOf = (path) => {
      const name = String(path).toLowerCase();
      const dot = name.lastIndexOf('.');
      const ext = dot < 0 ? '' : name.slice(dot + 1);
      if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'].indexOf(ext) >= 0) return 'js';
      if (['json', 'jsonc'].indexOf(ext) >= 0) return 'json';
      if (['css', 'wxss', 'scss', 'less', 'styl'].indexOf(ext) >= 0) return 'css';
      if (['html', 'htm', 'wxml', 'xml', 'vue', 'svelte', 'svg'].indexOf(ext) >= 0) return 'html';
      if (['md', 'mdx'].indexOf(ext) >= 0) return 'md';
      if (['py'].indexOf(ext) >= 0) return 'py';
      if (['sh', 'bash', 'zsh', 'fish'].indexOf(ext) >= 0) return 'sh';
      if (['yml', 'yaml', 'toml', 'ini', 'conf'].indexOf(ext) >= 0) return 'conf';
      if (['go', 'rs', 'java', 'kt', 'swift', 'php', 'rb', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'sql'].indexOf(ext) >= 0) return 'code';
      return 'plain';
    };
    /** 哪些语言里 `#` 是注释（CSS 里 `#fff` 是颜色，不能当注释）。 */
    const hashComments = (lang) => lang === 'py' || lang === 'sh' || lang === 'conf' || lang === 'md';

    /**
     * 极简逐行高亮：注释 / 字符串 / 数字 / 关键字 / 类型 / 对象键 / 函数名 / 标签。
     *
     * 故意不做真正的词法分析：**逐行、无跨行状态**（多行字符串或块注释只会高亮到行尾）。
     * 换来的是没有依赖、不会因为某个冷门语法出错，日常看 diff 足够。
     * @returns {{ text: string, cls: string }[]}
     */
    const highlight = (text, lang) => {
      const tokens = [];
      const push = (value, cls) => {
        if (value === '') return;
        const last = tokens[tokens.length - 1];
        if (cls === '' && last !== undefined && last.cls === '') last.text += value;
        else tokens.push({ text: value, cls });
      };
      let rest = text;
      const isHash = hashComments(lang);
      while (rest !== '') {
        let match;
        const comment = isHash
          ? /^(?:\/\/[^]*|\/\*[^]*|#[^]*|<!--[^]*)/.exec(rest)
          : /^(?:\/\/[^]*|\/\*[^]*|<!--[^]*)/.exec(rest);
        if (comment !== null) {
          push(comment[0], TOKEN_CLASS.comment);
          rest = rest.slice(comment[0].length);
          continue;
        }
        match = /^(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)/.exec(rest);
        if (match !== null && match[0] !== '') {
          push(match[0], TOKEN_CLASS.string);
          rest = rest.slice(match[0].length);
          continue;
        }
        match = /^(?:\d[\w.]*)/.exec(rest);
        if (match !== null) {
          push(match[0], TOKEN_CLASS.number);
          rest = rest.slice(match[0].length);
          continue;
        }
        match = /^(?:<\/?[\w:-]+|\/?>|\/>)/.exec(rest);
        if (match !== null && (lang === 'html' || lang === 'code')) {
          push(match[0], TOKEN_CLASS.tag);
          rest = rest.slice(match[0].length);
          continue;
        }
        match = /^[A-Za-z_$][\w$]*/.exec(rest);
        if (match !== null) {
          const word = match[0];
          rest = rest.slice(word.length);
          if (KEYWORDS.has(word)) push(word, TOKEN_CLASS.keyword);
          else if (TYPE_WORDS.has(word)) push(word, TOKEN_CLASS.type);
          else {
            const after = /^\s*(\??:|\(|=(?!=)>)/.exec(rest);
            if (after !== null) push(word, after[1] === '(' || after[1] === '=>' ? TOKEN_CLASS.func : TOKEN_CLASS.key);
            else push(word, '');
          }
          continue;
        }
        match = /^[\s\S]/.exec(rest);
        push(match[0], '');
        rest = rest.slice(1);
      }
      return tokens;
    };

    /** 文件类型徽章（照 Sourcegraph 那种小方标）。 */
    const fileBadge = (path) => {
      const name = String(path).toLowerCase();
      const ext = name.lastIndexOf('.') < 0 ? '' : name.slice(name.lastIndexOf('.') + 1);
      if (['ts', 'tsx'].indexOf(ext) >= 0) return { text: 'TS', cls: 'is-ts' };
      if (['js', 'jsx', 'mjs', 'cjs'].indexOf(ext) >= 0) return { text: 'JS', cls: 'is-js' };
      if (['json', 'jsonc'].indexOf(ext) >= 0) return { text: '{}', cls: 'is-json' };
      if (['html', 'wxml', 'xml', 'vue'].indexOf(ext) >= 0) return { text: '<>', cls: 'is-html' };
      if (['css', 'wxss', 'scss', 'less'].indexOf(ext) >= 0) return { text: '#', cls: 'is-css' };
      if (['md', 'mdx'].indexOf(ext) >= 0) return { text: 'M↓', cls: 'is-md' };
      return { text: '·', cls: 'is-other' };
    };

    /**
     * 把一段统一 diff 拆成**块**：行（带行号）与「未修改行」折叠块。
     *
     * 行号语义照 Sourcegraph 那种单列：删除行显示旧行号，其余显示新行号。
     * @returns {{ blocks: object[], hidden: number, added: number, deleted: number }}
     */
    const parseDiff = (text) => {
      const raw = typeof text === 'string' && text !== '' ? text.split('\n') : [];
      if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const blocks = [];
      let hidden = 0;
      let added = 0;
      let deleted = 0;
      let oldNo = 0;
      let newNo = 0;
      const contextRun = [];
      const flushContext = () => {
        if (contextRun.length === 0) return;
        if (contextRun.length >= COLLAPSE_MIN) {
          blocks.push({ kind: 'fold', key: blocks.length, lines: contextRun.slice(), count: contextRun.length });
        } else {
          for (const line of contextRun) blocks.push(line);
        }
        contextRun.length = 0;
      };
      for (const line of raw) {
        if (line.startsWith('@@')) {
          flushContext();
          const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
          if (head !== null) {
            oldNo = Number(head[1]);
            newNo = Number(head[2]);
          }
          blocks.push({ kind: 'line', type: 'hunk', text: line, gutter: '' });
          continue;
        }
        if (
          line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') ||
          line.startsWith('+++ ') || line.startsWith('new file') || line.startsWith('deleted file') ||
          line.startsWith('similarity') || line.startsWith('rename ') || line.startsWith('Binary files') ||
          line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('\\ No newline')
        ) {
          flushContext();
          blocks.push({ kind: 'line', type: 'meta', text: line, gutter: '' });
          continue;
        }
        if (line.startsWith('+')) {
          flushContext();
          added += 1;
          blocks.push({ kind: 'line', type: 'add', text: line.slice(1), gutter: String(newNo), sign: '+' });
          newNo += 1;
          continue;
        }
        if (line.startsWith('-')) {
          flushContext();
          deleted += 1;
          blocks.push({ kind: 'line', type: 'del', text: line.slice(1), gutter: String(oldNo), sign: '-' });
          oldNo += 1;
          continue;
        }
        const body = line.startsWith(' ') ? line.slice(1) : line;
        contextRun.push({ kind: 'line', type: 'context', text: body, gutter: String(newNo), sign: ' ' });
        oldNo += 1;
        newNo += 1;
      }
      flushContext();
      // 行数上限：把超出的行标成 hidden（保持块结构，折叠块按需截断）
      const kept = [];
      let drawn = 0;
      for (const block of blocks) {
        if (block.kind === 'fold') {
          const room = Math.max(0, MAX_DIFF_LINES - drawn);
          if (room === 0) {
            hidden += block.count;
            continue;
          }
          kept.push(block);
          drawn += Math.min(block.count, room);
          continue;
        }
        if (drawn >= MAX_DIFF_LINES) {
          hidden += 1;
          continue;
        }
        kept.push(block);
        drawn += 1;
      }
      return { blocks: kept, hidden, added, deleted };
    };

    /**
     * 右侧边栏的「Git Diff」面板。
     *
     * **默认把所有文件的 diff 全部展开**（像 `git diff` 的输出），每段段头可以单独折叠。
     * 布局：header 固定，下面 `.git-diff-scroll` 是**唯一**的滚动容器（每段不要再自己加 overflow，
     * 否则会互相挤压、外层反而滚不动）。
     * @param props - 框架给的 { useTabInfo } + inject 的 { sessionId, loadDiffs }。
     */
    function GitDiffTab(props) {
      ensureCss();
      const { loadDiffs, useTabInfo } = props;
      /** loading | ready | error */
      const [phase, setPhase] = React.useState('loading');
      const [error, setError] = React.useState('');
      const [data, setData] = React.useState(null);
      const [collapsed, setCollapsed] = React.useState({});
      /** 展开过的「N 行未修改」块：键是 `${path}:${块序号}` */
      const [expanded, setExpanded] = React.useState({});
      const [mode, setMode] = React.useState('worktree'); // worktree | index
      const [onlyChat, setOnlyChat] = React.useState(false);
      /** 自动换行：默认开，这样 diff 宽度跟着面板/窗口自适应，不用横向滚。 */
      const [wrap, setWrap] = React.useState(true);
      /** 3 秒轮询：默认开，仅在 tab 可见且窗口聚焦时跑。 */
      const [poll, setPoll] = React.useState(true);
      /** 有请求在路上时就跳过这一拍，避免堆叠（大仓库一次 git diff 可能几百毫秒）。 */
      const inFlightRef = React.useRef(false);
      const [busy, setBusy] = React.useState(false);

      const visible = useTabInfo === undefined ? true : useTabInfo().tab.visible !== false;
      // loader 走 ref：inject 每次渲染都给新函数身份，进依赖会变成每次渲染重新取数
      const loaderRef = React.useRef(loadDiffs);
      loaderRef.current = loadDiffs;
      /** 上一次的可见状态：用来识别「隐藏 → 可见」这个转变。 */
      const wasVisibleRef = React.useRef(false);
      /** 上一次读到数据的时间（显示在头部，回答「这份 diff 是什么时候的」）。 */
      const [loadedAt, setLoadedAt] = React.useState(0);

      /**
       * @param silent - true 表示后台轮询：不显示「读取中…」，免得每 3 秒闪一次按钮文案。
       *   ⚠️ 不要写成 `onClick={refresh}` —— React 会把事件对象当第一个参数传进来。
       */
      const refresh = React.useCallback(async (silent) => {
        const quiet = silent === true;
        if (!quiet) setBusy(true);
        inFlightRef.current = true;
        try {
          const value = await loaderRef.current();
          setData(value);
          setPhase('ready');
          setError('');
          setLoadedAt(Date.now());
        } catch (problem) {
          setPhase('error');
          setError(problem instanceof Error ? problem.message : String(problem));
        } finally {
          inFlightRef.current = false;
          if (!quiet) setBusy(false);
        }
      }, []);

      /**
       * 什么时候自动取一次数据 —— **只有这两种事件，没有轮询**：
       *   ① 首次显示（挂载）；
       *   ② tab 从隐藏变可见（切走再切回来）；
       *   ③ 窗口重新获得焦点（在编辑器里改完代码切回来）。
       * 其余时间靠头部那个「刷新」按钮手动取。
       *
       * ⚠️ 早先这里写的是 `!loadedRef.current || data === null`：第一次之后就再也不满足了，
       * 所以「切回来补一次」根本没生效（注释与行为不符）。改成用 wasVisibleRef 认「变可见」这个转变。
       */
      React.useEffect(() => {
        if (!visible) {
          wasVisibleRef.current = false;
          return undefined;
        }
        const becameVisible = !wasVisibleRef.current;
        wasVisibleRef.current = true;
        if (becameVisible || data === null) refresh();

        const onFocus = () => {
          if (wasVisibleRef.current) refresh();
        };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
      }, [visible, data, refresh]);

      /**
       * 3 秒轮询（可关）。两重闸门，避免白烧 CPU：
       *   ① 只在 tab 可见时存在；② 窗口失焦就**停掉定时器**（不是空转），回到前台再恢复。
       * 另外上一拍还没回来就跳过，不堆叠。
       */
      React.useEffect(() => {
        if (!poll || !visible) return undefined;
        let timer;
        const tick = () => {
          if (inFlightRef.current) return;
          refresh(true);   // 静默：不切「读取中…」
        };
        const start = () => {
          if (timer === undefined) timer = window.setInterval(tick, POLL_MS);
        };
        const stop = () => {
          if (timer !== undefined) {
            window.clearInterval(timer);
            timer = undefined;
          }
        };
        const focused = () => typeof document.hasFocus !== 'function' || document.hasFocus();
        if (focused()) start();
        const onFocus = () => start();
        const onBlur = () => stop();
        window.addEventListener('focus', onFocus);
        window.addEventListener('blur', onBlur);
        return () => {
          stop();
          window.removeEventListener('focus', onFocus);
          window.removeEventListener('blur', onBlur);
        };
      }, [poll, visible, refresh]);

      if (phase === 'loading') {
        return React.createElement('div', { className: 'git-diff-root' },
          React.createElement('div', { className: 'git-diff-note' }, '正在读仓库状态与 diff…'));
      }
      if (phase === 'error') {
        return React.createElement('div', { className: 'git-diff-root' }, [
          React.createElement('div', { key: 'n', className: 'git-diff-note is-error' }, error),
          React.createElement('div', { key: 'b', className: 'git-diff-modes' },
            React.createElement('button', { type: 'button', className: 'git-diff-btn', onClick: refresh }, '重试')),
        ]);
      }

      const allFiles = data.files === undefined ? [] : data.files;
      const files = onlyChat ? allFiles.filter((file) => file.fromChat === true) : allFiles;
      const anyBothSides = allFiles.some((file) => (file.worktree || '') !== '' && (file.index || '') !== '');
      /** 按全局模式取该文件要显示的那一侧；请求的那侧为空就退回另一侧并标出来。 */
      const pickBody = (file) => {
        const worktree = typeof file.worktree === 'string' ? file.worktree : '';
        const index = typeof file.index === 'string' ? file.index : '';
        if (mode === 'index') {
          return index !== '' ? { text: index, side: '已暂存', fellBack: false }
            : { text: worktree, side: '工作区', fellBack: true };
        }
        return worktree !== '' ? { text: worktree, side: '工作区', fellBack: false }
          : { text: index, side: '已暂存', fellBack: true };
      };

      /** 画一行：行号槽 + 符号 + 高亮后的代码。 */
      const renderLine = (line, lang, key) =>
        React.createElement('div', { key, className: 'git-diff-line is-' + line.type }, [
          React.createElement('span', { key: 'g', className: 'git-diff-gutter' }, line.gutter === undefined ? '' : line.gutter),
          React.createElement('span', { key: 's', className: 'git-diff-sign' }, line.sign === undefined ? '' : line.sign),
          line.type === 'meta' || line.type === 'hunk'
            ? React.createElement('span', { key: 't', className: 'git-diff-text' }, line.text)
            : React.createElement('span', { key: 't', className: 'git-diff-text' },
                highlight(line.text, lang).map((token, index) =>
                  token.cls === ''
                    ? token.text
                    : React.createElement('span', { key: index, className: 'git-diff-tok ' + token.cls }, token.text))),
        ]);

      const head = React.createElement('div', { key: 'head', className: 'git-diff-head' }, [
        React.createElement('span', { key: 'repo', className: 'git-diff-repo', title: data.root },
          `${data.branch}${data.upstream === '' ? '' : ' → ' + data.upstream}` +
            (data.ahead === 0 && data.behind === 0 ? '' : `  ↑${data.ahead} ↓${data.behind}`) +
            (loadedAt === 0 ? '' : `  ·  ${new Date(loadedAt).toTimeString().slice(0, 8)}`)),
        React.createElement('span', { key: 'n', className: 'git-diff-chip' }, `${allFiles.length} 个改动`),
        data.fromChat > 0
          ? React.createElement('span', { key: 'c', className: 'git-diff-chip is-chat' }, `本次对话 ${data.fromChat}`)
          : null,
        React.createElement('button', {
          key: 'filter', type: 'button',
          className: 'git-diff-btn' + (onlyChat ? ' is-on' : ''),
          onClick: () => setOnlyChat(!onlyChat),
          title: '只看本次对话改过的文件',
        }, '只看本次'),
        React.createElement('button', {
          key: 'poll', type: 'button',
          className: 'git-diff-btn' + (poll ? ' is-on' : ''),
          onClick: () => setPoll(!poll),
          title: poll
            ? '关掉 3 秒轮询（改成手动刷新）'
            : `打开 3 秒轮询（仅在 tab 可见且窗口聚焦时）`,
        }, '3s 轮询'),
        React.createElement('button', {
          key: 'wrap', type: 'button',
          className: 'git-diff-btn' + (wrap ? ' is-on' : ''),
          onClick: () => setWrap(!wrap),
          title: wrap ? '关掉自动换行：长行横向滚动' : '打开自动换行：宽度跟着面板走',
        }, '自动换行'),
        React.createElement('button', {
          key: 'refresh', type: 'button', className: 'git-diff-btn', disabled: busy,
          title: loadedAt === 0 ? '重新读一次' : `重新读一次（上次 ${new Date(loadedAt).toLocaleTimeString()}）`,
          onClick: () => refresh(),
        }, busy ? '读取中…' : '刷新'),
      ].filter(Boolean));

      if (allFiles.length === 0) {
        return React.createElement('div', { className: 'git-diff-root' + (wrap ? ' is-wrap' : '') }, [
          head,
          React.createElement('div', { key: 'clean', className: 'git-diff-empty' }, '工作区干净，没有未提交的改动'),
        ]);
      }

      const nodes = [head];
      if (files.length === 0) {
        nodes.push(React.createElement('div', { key: 'none', className: 'git-diff-empty' }, '没有「本次对话」改过的文件'));
        return React.createElement('div', { className: 'git-diff-root' + (wrap ? ' is-wrap' : '') }, nodes);
      }

      if (anyBothSides) {
        nodes.push(React.createElement('div', { key: 'modes', className: 'git-diff-modes' }, [
          React.createElement('button', {
            key: 'w', type: 'button',
            className: 'git-diff-btn' + (mode === 'worktree' ? ' is-on' : ''),
            onClick: () => setMode('worktree'),
          }, '工作区'),
          React.createElement('button', {
            key: 'i', type: 'button',
            className: 'git-diff-btn' + (mode === 'index' ? ' is-on' : ''),
            onClick: () => setMode('index'),
          }, '已暂存'),
        ]));
      }

      // 全部展开（默认）；未修改的长段折起来，点一下就地展开
      let drawn = 0;
      let stopped = false;
      const sections = [];
      for (const file of files) {
        const badge = badgeOf(file.status);
        const fileBadgeMark = fileBadge(file.path);
        const isCollapsed = collapsed[file.path] === true;
        const body = pickBody(file);
        const lang = languageOf(file.path);
        const parsed = isCollapsed ? { blocks: [], hidden: 0, added: 0, deleted: 0 } : parseDiff(body.text);
        const counts = parsed.added === 0 && parsed.deleted === 0
          ? (file.added === undefined ? null : `+${file.added}/-${file.deleted}`)
          : `+${parsed.added}/-${parsed.deleted}`;
        const rows = [];
        for (const block of parsed.blocks) {
          if (drawn >= MAX_DIFF_LINES) { stopped = true; break; }
          if (block.kind === 'fold') {
            const foldKey = `${file.path}:${String(block.key)}`;
            if (expanded[foldKey] === true) {
              for (const line of block.lines) {
                if (drawn >= MAX_DIFF_LINES) { stopped = true; break; }
                drawn += 1;
                rows.push(renderLine(line, lang, rows.length));
              }
            } else {
              rows.push(
                React.createElement('div', {
                  key: 'fold' + String(block.key),
                  className: 'git-diff-fold',
                  title: '展开这段未修改的代码',
                  onClick: () => setExpanded({ ...expanded, [foldKey]: true }),
                }, [
                  React.createElement('span', { key: 'i', className: 'git-diff-fold-icon' }, '⌄⌃'),
                  React.createElement('span', { key: 't' }, `${block.count} 行未修改`),
                ]),
              );
            }
            continue;
          }
          drawn += 1;
          rows.push(renderLine(block, lang, rows.length));
        }
        sections.push(
          React.createElement('div', { key: file.path, className: 'git-diff-section' }, [
            React.createElement('button', {
              key: 'h',
              type: 'button',
              className: 'git-diff-section-head',
              onClick: () => setCollapsed({ ...collapsed, [file.path]: !isCollapsed }),
              title: isCollapsed ? '展开' : '折叠',
            }, [
              React.createElement('span', { key: 'c', className: 'git-diff-chevron' }, isCollapsed ? '▶' : '▼'),
              React.createElement('span', { key: 'b', className: 'git-diff-badge ' + fileBadgeMark.cls }, fileBadgeMark.text),
              React.createElement('span', { key: 'p', className: 'git-diff-path' }, file.path),
              counts === null ? null
                : React.createElement('span', { key: 'n', className: 'git-diff-counts' }, counts),
              file.fromChat === true ? React.createElement('span', { key: 'd', className: 'git-diff-dot', title: '本次对话改过' }) : null,
              React.createElement('span', { key: 's', className: 'git-diff-side' }, body.side),
            ].filter(Boolean)),
            ...(isCollapsed ? [] : [
              file.binary === true
                ? React.createElement('div', { key: 'bin', className: 'git-diff-note' }, '二进制文件，不展开 diff')
                : null,
              ...(typeof file.note === 'string' && file.note !== ''
                ? [React.createElement('div', { key: 'note', className: 'git-diff-note' }, file.note)]
                : []),
              React.createElement('div', { key: 'body', className: 'git-diff-body' }, rows),
              file.truncated === true
                ? React.createElement('div', { key: 'trunc', className: 'git-diff-note' },
                    `（这个文件太长，只显示了一部分；完整内容用 git diff ${body.side === '已暂存' ? '--cached ' : ''}-- ${file.path}）`)
                : null,
            ].filter(Boolean)),
          ].filter(Boolean)),
        );
        if (stopped) break;
      }

      const scroller = [React.createElement('div', { key: 'sections' }, sections)];
      if (stopped) {
        scroller.push(React.createElement('div', { key: 'stopped', className: 'git-diff-note' },
          `已显示到 ${MAX_DIFF_LINES} 行的上限，其余没展开；折叠上面的文件，或用 git diff 看完整内容。`));
      }
      nodes.push(React.createElement('div', { key: 'scroll', className: 'git-diff-scroll' }, scroller));
      return React.createElement('div', { className: 'git-diff-root' + (wrap ? ' is-wrap' : '') }, nodes);
    }

    /** 顶部 tab chip：图标 + 文案。 */
    function GitDiffTitle({ useTabInfo }) {
      ensureCss();
      const { tab } = useTabInfo();
      return React.createElement(
        'span',
        { className: 'git-diff-title' },
        React.createElement(DiffIcon, { size: 14 }),
        React.createElement('span', { className: 'git-diff-title-text' },
          tab.title === undefined ? 'Git Diff' : tab.title),
      );
    }

    return {
      /** slots 挂 dock；sessions 取会话作用域（sendSession 在 conversation 服务上）。 */
      inject: ['slots', 'sessions'],
      /**
       * 注册输入框上方那一条。
       * @param ctx - client 插件上下文。
       */
      apply(ctx) {
        /**
         * 找到 `sendSession` 真正要的那个对象。
         *
         * ⚠️ 别用 dock props 里的 `session`：那是 `useSession(snapshot => snapshot)` 给的**快照**，
         * 没有 `beginSubmission` / `prompt`，传进去 `sendSession` 会当场抛 TypeError
         * （表现就是「点了没反应」）。官方 sink 用的是 `binding.session`，这里也一样。
         */
        const resolveSession = (sessionId, fromProps) => {
          const looksLikeSession = (value) =>
            value !== undefined && value !== null && typeof value.beginSubmission === 'function';
          try {
            const binding = typeof ctx.sessions.binding === 'function' ? ctx.sessions.binding(sessionId) : undefined;
            const fromBinding = binding === undefined || binding === null ? undefined : binding.session;
            if (looksLikeSession(fromBinding)) return fromBinding;
            if (looksLikeSession(fromProps)) return fromProps;
          } catch (error) {
            console.warn('[dsh-git-ship] 解析会话对象失败', error);
          }
          return undefined;
        };

        /** 失败时说出来：成功不显示任何文案，但「点了没反应」得能排查。 */
        const report = (sessionId, text) => {
          console.warn('[dsh-git-ship] ' + text);
          try {
            const actx = ctx.sessions.scope(sessionId);
            const conversation = actx === undefined ? undefined : actx.get('conversation');
            if (conversation !== undefined) conversation.input.for(actx).notify('warning', text);
          } catch (error) {
            /* notify 失败就算了，console 里有 */
          }
        };

        /**
         * 直接把一条用户消息发出去（官方 sink 走的就是这条路）。
         *
         * 不用输入框：不 setDraft、不放 chip、不 submit。
         * `sendSession(session, text, [], 'queue')` 返回 `{kind:'success'}` / `{kind:'error'}`。
         * @returns {Promise<{sent: boolean}>}
         */
        const sendNow = async (sessionId, fromProps) => {
          const session = resolveSession(sessionId, fromProps);
          if (session === undefined) {
            report(sessionId, '拿不到会话对象，消息没发出去（多半是会话作用域还没就绪）');
            return { sent: false };
          }
          const actx = ctx.sessions.scope(sessionId);
          const conversation = actx === undefined ? undefined : actx.get('conversation');
          if (conversation === undefined || typeof conversation.sendSession !== 'function') {
            report(sessionId, 'conversation.sendSession 不可用，消息没发出去');
            return { sent: false };
          }
          try {
            const outcome = await conversation.sendSession(session, MESSAGE_TEXT, [], 'queue');
            if (outcome === undefined || outcome.kind !== 'success') {
              report(sessionId, `sendSession 没成功：${JSON.stringify(outcome)}`);
              return { sent: false };
            }
            return { sent: true };
          } catch (error) {
            report(sessionId, '发送失败：' + (error instanceof Error ? error.message : String(error)));
            return { sent: false };
          }
        };

        /**
         * 打宿主的只读路由。
         *
         * ⚠️ 这两个路由是**宿主半边**（index.js）注册的，改完要重启 App 才生效；
         * 客户端热重载后如果路由还没挂上，会拿到 401/404/非 JSON —— 这里翻译成人话。
         */
        const postJson = async (path, body) => {
          let response;
          try {
            response = await fetch(`${ROUTE_PREFIX}${path}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', [MARKER]: '1' },
              body: JSON.stringify(body),
            });
          } catch (error) {
            throw new Error('连不上宿主：' + (error instanceof Error ? error.message : String(error)));
          }
          let payload;
          try {
            payload = await response.json();
          } catch (error) {
            payload = undefined;
          }
          if (payload === undefined) {
            throw response.status === 401 || response.status === 404
              ? new Error('宿主半边还没重启：只读路由（/api/git-ship/diffs）没挂上。重启一次 App 就好。')
              : new Error(`宿主返回了非 JSON（HTTP ${response.status}）`);
          }
          if (payload.ok !== true) {
            const message = payload.error === undefined ? `HTTP ${response.status}` : payload.error.message;
            throw new Error(message);
          }
          return payload.value;
        };

        /** 一次拿全：仓库状态 + 所有文件的 diff（宿主一条 /diffs 路由）。 */
        const loadDiffs = (sessionId) => postJson('/diffs', { sessionId });
        /** 每个会话一组**身份稳定**的 loader（inject 每次渲染都会调用，不能返回新函数）。 */
        const loaders = new Map();
        const loadersFor = (sessionId) => {
          const existing = loaders.get(sessionId);
          if (existing !== undefined) return existing;
          const created = { loadDiffs: () => loadDiffs(sessionId) };
          loaders.set(sessionId, created);
          return created;
        };

        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'git-ship',
              // 官方 queue 是 20、goal 是 10；取 30 排在它们之后
              order: 30,
              /** dock 组件的 props 是 { session, input, ...inject 的返回值 }。 */
              inject: (sessionId) => ({
                sessionId,
                sendNow: (fromProps) => sendNow(sessionId, fromProps),
              }),
            },
            GitShipBar,
          ),
        );

        // ── 右侧边栏：Git Diff tab（类型 + body + chip 标题）
        // sidebarRightTabs 用 ctx.inject 延迟接入：没有右侧边栏的 build 只是没有这个 tab，
        // 不影响 dock 上那条「提交并推送」。
        ctx.inject(['sidebarRightTabs'], (scope) => {
          scope.effect(
            () =>
              scope.sidebarRightTabs.register({
                id: DIFF_TAB_ID,
                kind: DIFF_TAB_KIND,
                // 每个会话一个实例：再点一次是「聚焦已有 tab」
                multiple: false,
                // 切 tab / 切会话不卸载，滚动位置和选中的文件都留着
                keepMounted: true,
                title: () => 'Git Diff',
                guide: [
                  {
                    id: 'new',
                    order: 45,
                    title: () => 'Git Diff',
                    description: () => '看这个会话仓库的改动，逐个文件看 diff',
                  },
                ],
              }),
            'git-ship: diff tab type',
          );

          scope.slots.inject('sidebar.right.pane.tab', () =>
            scope.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: DIFF_TAB_ID,
                inject: (sessionId) => ({ sessionId, ...loadersFor(sessionId) }),
              },
              GitDiffTab,
            ),
          );

          scope.slots.inject('sidebar.right.pane.tab.title', () =>
            scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: DIFF_TAB_ID }, GitDiffTitle),
          );
        });
      },
    };
  },
});
