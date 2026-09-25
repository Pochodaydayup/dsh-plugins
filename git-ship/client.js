/**
 * Client 半边：输入框上方（`conversation.input.dock`）那条「提交并推送」。
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

    // ────────────────────────────────────────────────────────────── 样式

    const CSS = `
/* 对齐输入框卡片：卡片自己是「width:100% + max-width: var(--dsh-composer-card-max-width) + margin:0 auto」，
   所以这里用**同一个变量**、同一套盒子规则即可 —— 官方 dock 里的 notice 元素就是这么写的：
     .QJwAZG_notice{width:100%;max-width:var(--dsh-composer-card-max-width);margin-bottom:6px;...}
   不要再去抄 side-clearance / dock-inset 那套公式：那是给「带内边距的卡片式工具条」用的，
   而且窗口一放大就会露馅（卡片有 max-width，dock 若没有就必然错位）。 */
.git-ship-root { box-sizing: border-box; width: 100%;
  max-width: var(--dsh-composer-card-max-width, 100%); margin: 0 auto;
  display: flex; flex-direction: column; gap: 6px; font-size: 12px;
  color: var(--dsw-alias-label-primary); }
.git-ship-bar { display: flex; align-items: center; gap: 8px; }
.git-ship-btn { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px;
  cursor: pointer; white-space: nowrap; }
.git-ship-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary); }
.git-ship-btn:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
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
      },
    };
  },
});
