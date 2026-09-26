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
 *    `/api/git-ship/status` 与 `/api/git-ship/diff` —— 复用 annotate 那套「回环 + 标记头」的安全约定。
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
.git-ship-btn { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px;
  cursor: pointer; white-space: nowrap; }
.git-ship-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary); }
.git-ship-btn:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }

/* ── Git Diff tab ───────────────────────────────────────────────────── */
.git-diff-root { display: flex; flex-direction: column; height: 100%; min-height: 0;
  font-size: 12px; color: var(--dsw-alias-label-primary); }
.git-diff-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l3); flex: none; min-width: 0; }
.git-diff-repo { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-secondary); font-size: 11px; }
.git-diff-chip { flex: none; padding: 1px 6px; border-radius: 999px; font-size: 10px; line-height: 16px;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary); }
.git-diff-chip.is-chat { color: var(--dsw-alias-state-business-primary); }
.git-diff-btn { flex: none; display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; cursor: pointer; }
.git-diff-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.git-diff-btn:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.git-diff-btn.is-on { color: var(--dsw-alias-state-business-primary); border-color: currentColor; }
.git-diff-files { flex: none; max-height: 38%; overflow: auto; border-bottom: 1px solid var(--dsw-alias-border-l3); }
.git-diff-file { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 10px;
  border: none; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer;
  text-align: left; min-width: 0; }
.git-diff-file:hover { background: var(--dsw-alias-interactive-bg-hover); }
.git-diff-file.is-active { background: var(--dsw-alias-bg-layer-3); }
.git-diff-status { flex: none; width: 18px; text-align: center; font-weight: 600; font-size: 11px;
  color: var(--dsw-alias-label-tertiary); }
.git-diff-status.is-add { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-state-business-primary)); }
.git-diff-status.is-del { color: var(--dsw-alias-state-error-primary); }
.git-diff-status.is-mod { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-primary)); }
.git-diff-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  direction: rtl; text-align: left; font-family: var(--dsw-font-family-mono, ui-monospace, monospace); }
.git-diff-counts { flex: none; font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.git-diff-dot { flex: none; width: 6px; height: 6px; border-radius: 999px;
  background: var(--dsw-alias-state-business-primary); }
.git-diff-body { flex: 1; min-height: 0; overflow: auto; font-family: var(--dsw-font-family-mono, ui-monospace, monospace); }
.git-diff-line { display: flex; white-space: pre; font-size: 11px; line-height: 17px; }
.git-diff-line > .git-diff-sign { flex: none; width: 18px; text-align: center; opacity: .6; user-select: none; }
.git-diff-line > .git-diff-text { flex: 1; min-width: 0; padding-right: 10px; }
.git-diff-line.is-add { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2ea043) 14%, transparent); }
.git-diff-line.is-del { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f85149) 14%, transparent); }
.git-diff-line.is-hunk { color: var(--dsw-alias-state-business-primary); }
.git-diff-line.is-meta { color: var(--dsw-alias-label-tertiary); }
.git-diff-modes { display: flex; gap: 6px; padding: 6px 10px; flex: none;
  border-bottom: 1px solid var(--dsw-alias-border-l3); }
.git-diff-note { padding: 10px; color: var(--dsw-alias-label-tertiary); line-height: 18px; }
.git-diff-note.is-error { color: var(--dsw-alias-state-error-primary); }
.git-diff-empty { padding: 16px 12px; color: var(--dsw-alias-label-tertiary); text-align: center; line-height: 20px; }
.git-diff-title { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.git-diff-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
     * 把一段统一 diff 拆成行（带类型），供渲染用。
     * @returns {{ lines: {type: string, text: string}[], hidden: number }}
     */
    const parseDiff = (text) => {
      const raw = typeof text === 'string' && text !== '' ? text.split('\n') : [];
      if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const lines = [];
      let hidden = 0;
      for (const line of raw) {
        let type = 'context';
        if (line.startsWith('@@')) type = 'hunk';
        else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')
          || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')
          || line.startsWith('similarity') || line.startsWith('rename ') || line.startsWith('Binary files')
          || line.startsWith('old mode') || line.startsWith('new mode')) type = 'meta';
        else if (line.startsWith('+')) type = 'add';
        else if (line.startsWith('-')) type = 'del';
        if (lines.length >= MAX_DIFF_LINES) {
          hidden += 1;
          continue;
        }
        lines.push({ type, text: line });
      }
      return { lines, hidden };
    };

    /**
     * 右侧边栏的「Git Diff」面板。
     * @param props - 框架给的 { useTabInfo } + inject 的 { sessionId, loadStatus, loadDiff }。
     */
    function GitDiffTab(props) {
      ensureCss();
      const { sessionId, loadStatus, loadDiff, useTabInfo } = props;
      /** loading | ready | error */
      const [phase, setPhase] = React.useState('loading');
      const [error, setError] = React.useState('');
      const [status, setStatus] = React.useState(null);
      const [selected, setSelected] = React.useState('');
      const [diff, setDiff] = React.useState(null);
      const [diffPhase, setDiffPhase] = React.useState('idle'); // idle | loading | error
      const [diffError, setDiffError] = React.useState('');
      const [mode, setMode] = React.useState('worktree'); // worktree | index
      const [onlyChat, setOnlyChat] = React.useState(false);
      const [busy, setBusy] = React.useState(false);

      const visible = useTabInfo === undefined ? true : useTabInfo().tab.visible !== false;
      /**
       * loader 走 ref：`inject` 每次渲染都会给出**新的函数身份**，直接进 useEffect 依赖
       * 会变成「每次渲染都重新取数」。所以依赖只留 `selected` / `visible` 这些真值。
       */
      const loadersRef = React.useRef({ loadStatus, loadDiff });
      loadersRef.current = { loadStatus, loadDiff };
      const selectedRef = React.useRef(selected);
      selectedRef.current = selected;

      const refresh = React.useCallback(
        async (keepSelection) => {
          setBusy(true);
          try {
            const value = await loadersRef.current.loadStatus();
            setStatus(value);
            setPhase('ready');
            setError('');
            const files = value.files === undefined ? [] : value.files;
            const current = keepSelection === true ? selectedRef.current : '';
            const stillThere = files.some((file) => file.path === current);
            if (!stillThere) {
              setSelected(files.length === 0 ? '' : files[0].path);
              setDiff(null);
            }
          } catch (problem) {
            setPhase('error');
            setError(problem instanceof Error ? problem.message : String(problem));
          } finally {
            setBusy(false);
          }
        },
        [],
      );

      // 打开时读一次；tab 从隐藏变可见时再读一次（省得看到过期数据）
      React.useEffect(() => {
        if (visible && status === null && phase !== 'error') refresh(false);
      }, [visible, status, phase, refresh]);

      // 选中的文件变了 → 读它的 diff
      React.useEffect(() => {
        if (selected === '') {
          setDiff(null);
          return undefined;
        }
        let cancelled = false;
        setDiffPhase('loading');
        setMode('worktree');
        loadersRef.current
          .loadDiff(selected)
          .then((value) => {
            if (cancelled) return;
            setDiff(value);
            setDiffPhase('idle');
            setDiffError('');
          })
          .catch((problem) => {
            if (cancelled) return;
            setDiff(null);
            setDiffPhase('error');
            setDiffError(problem instanceof Error ? problem.message : String(problem));
          });
        return () => {
          cancelled = true;
        };
      }, [selected]);

      if (phase === 'loading') {
        return React.createElement('div', { className: 'git-diff-root' },
          React.createElement('div', { className: 'git-diff-note' }, '正在读仓库状态…'));
      }
      if (phase === 'error') {
        return React.createElement('div', { className: 'git-diff-root' }, [
          React.createElement('div', { key: 'n', className: 'git-diff-note is-error' }, error),
          React.createElement('div', { key: 'b', className: 'git-diff-modes' },
            React.createElement('button', { type: 'button', className: 'git-diff-btn', onClick: () => refresh(false) }, '重试')),
        ]);
      }

      const files = status.files === undefined ? [] : status.files;
      const shown = onlyChat ? files.filter((file) => file.fromChat === true) : files;
      const head = [];
      head.push(
        React.createElement('div', { key: 'head', className: 'git-diff-head' }, [
          React.createElement('span', { key: 'repo', className: 'git-diff-repo', title: status.root },
            `${status.branch}${status.upstream === '' ? '' : ' → ' + status.upstream}` +
              (status.ahead === 0 && status.behind === 0 ? '' : `  ↑${status.ahead} ↓${status.behind}`)),
          React.createElement('span', { key: 'n', className: 'git-diff-chip' }, `${files.length} 个改动`),
          status.fromChat > 0
            ? React.createElement('span', { key: 'c', className: 'git-diff-chip is-chat' }, `本次对话 ${status.fromChat}`)
            : null,
          React.createElement('button', {
            key: 'filter', type: 'button',
            className: 'git-diff-btn' + (onlyChat ? ' is-on' : ''),
            onClick: () => setOnlyChat(!onlyChat),
            title: '只看本次对话改过的文件',
          }, '只看本次'),
          React.createElement('button', {
            key: 'refresh', type: 'button', className: 'git-diff-btn', disabled: busy,
            onClick: () => refresh(true),
          }, busy ? '读取中…' : '刷新'),
        ].filter(Boolean)),
      );

      if (files.length === 0) {
        head.push(React.createElement('div', { key: 'clean', className: 'git-diff-empty' }, '工作区干净，没有未提交的改动'));
        return React.createElement('div', { className: 'git-diff-root' }, head);
      }

      head.push(
        React.createElement('div', { key: 'files', className: 'git-diff-files' },
          shown.map((file) => {
            const badge = badgeOf(file.status);
            return React.createElement('button', {
              key: file.path,
              type: 'button',
              className: 'git-diff-file' + (file.path === selected ? ' is-active' : ''),
              title: file.original === undefined ? file.path : `${file.original} → ${file.path}`,
              onClick: () => setSelected(file.path),
            }, [
              React.createElement('span', { key: 's', className: 'git-diff-status ' + badge.className }, badge.text),
              React.createElement('span', { key: 'p', className: 'git-diff-path' }, file.path),
              file.fromChat === true ? React.createElement('span', { key: 'd', className: 'git-diff-dot', title: '本次对话改过' }) : null,
              file.added === undefined ? null
                : React.createElement('span', { key: 'n', className: 'git-diff-counts' }, `+${file.added}/-${file.deleted}`),
            ].filter(Boolean));
          })),
      );

      const body = [];
      if (shown.length === 0) {
        body.push(React.createElement('div', { key: 'none', className: 'git-diff-empty' }, '没有「本次对话」改过的文件'));
      } else if (diffPhase === 'error') {
        body.push(React.createElement('div', { key: 'e', className: 'git-diff-note is-error' }, diffError));
      } else if (diffPhase === 'loading' || diff === null) {
        body.push(React.createElement('div', { key: 'l', className: 'git-diff-note' }, '正在读 diff…'));
      } else {
        const indexText = typeof diff.index === 'string' ? diff.index : '';
        const worktreeText = typeof diff.worktree === 'string' ? diff.worktree : '';
        const both = indexText !== '' && worktreeText !== '';
        const active = both ? (mode === 'index' ? indexText : worktreeText) : worktreeText !== '' ? worktreeText : indexText;
        const activeName = both ? (mode === 'index' ? '已暂存' : '工作区') : worktreeText !== '' ? '工作区' : '已暂存';
        if (both) {
          body.push(React.createElement('div', { key: 'm', className: 'git-diff-modes' }, [
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
        if (diff.binary === true) {
          body.push(React.createElement('div', { key: 'b', className: 'git-diff-note' }, '二进制文件，不展开 diff'));
        }
        if (typeof diff.note === 'string' && diff.note !== '') {
          body.push(React.createElement('div', { key: 'note', className: 'git-diff-note' }, diff.note));
        }
        const parsed = parseDiff(active);
        body.push(
          React.createElement('div', { key: 'body', className: 'git-diff-body' }, [
            ...parsed.lines.map((line, index) =>
              React.createElement('div', { key: index, className: 'git-diff-line is-' + line.type }, [
                React.createElement('span', { key: 's', className: 'git-diff-sign' },
                  line.type === 'add' ? '+' : line.type === 'del' ? '-' : ''),
                React.createElement('span', { key: 't', className: 'git-diff-text' }, line.text),
              ])),
            parsed.hidden > 0 || diff.truncated === true
              ? React.createElement('div', { key: 'trunc', className: 'git-diff-note' },
                  `（已截断，还有 ${parsed.hidden > 0 ? parsed.hidden + ' 行' : '更多内容'}没显示；完整内容请用 git diff ${activeName === '已暂存' ? '--cached ' : ''}-- ${diff.path}）`)
              : null,
          ].filter(Boolean)),
        );
      }

      return React.createElement('div', { className: 'git-diff-root' }, [...head, ...body]);
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
              ? new Error('宿主半边还没重启：只读路由（/api/git-ship/status、/diff）没挂上。重启一次 App 就好。')
              : new Error(`宿主返回了非 JSON（HTTP ${response.status}）`);
          }
          if (payload.ok !== true) {
            const message = payload.error === undefined ? `HTTP ${response.status}` : payload.error.message;
            throw new Error(message);
          }
          return payload.value;
        };

        const loadStatus = (sessionId) => postJson('/status', { sessionId });
        const loadDiff = (sessionId, path) => postJson('/diff', { sessionId, path });
        /** 每个会话一组**身份稳定**的 loader（inject 每次渲染都会调用，不能返回新函数）。 */
        const loaders = new Map();
        const loadersFor = (sessionId) => {
          const existing = loaders.get(sessionId);
          if (existing !== undefined) return existing;
          const created = {
            loadStatus: () => loadStatus(sessionId),
            loadDiff: (path) => loadDiff(sessionId, path),
          };
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
