# git-ship —— 「提交并推送」+ 右侧「Git Diff」tab

两块东西：

| 位置 | 功能 |
|---|---|
| 输入框上方 | **提交并推送**：点一下直接发一条 `@提交并推送`，由 AI 分析本次对话的改动并执行 git |

**这条只在「确认这个会话的仓库确实有未提交改动」时才出现**（否则整条不渲染）：

| 情况 | 显示？ | 靠什么判断 |
|---|---|---|
| 有未提交改动，且 cwd 来自这个会话 | ✅ | `/status` 成功 + `cwdSource === 'session'` + `total > 0` |
| 工作区干净 | ❌ | `total === 0` |
| **本地项目不是 git 仓库** | ❌ | 宿主 409 `not-a-repo`（`git rev-parse --show-toplevel` 失败） |
| **新开的对话，还没开始发消息** | ❌ | 会话事件窗口为空（`props.session.entries.length === 0`） |
| 会话还没有工作目录（宿主只能拿进程默认工作区兜底） | ❌ | `cwdSource === 'sandbox'` |
| 宿主路由没挂上 / 网络失败 / 401 | ❌ | 读不到状态 → 当作「没有改动」（**宁可少显示，也不谎报有改动**） |

判断用的是一条**轻量**只读路由 `POST /api/git-ship/status`（只回分支 + 未提交文件列表，不算 diff，
实测 payload 比 `/diffs` 小 61%）。dock 挂载时查一次、之后每 **5 秒**一次（`document.visibilityState`
为 hidden 时跳过）、窗口聚焦时补一次。

## 装

在 App 里：**设置 → 插件 → 安装**，填这个目录的绝对路径：

```
/Users/zm00138ml/work/AI/dsh-plugins/git-ship
```

装完点 **立即启用**，然后**重启 App**（Host 半边的路由要重启才挂上；只加载 client 的话，
点按钮会提示「连不上宿主半边」）。

## 它怎么知道「本次对话改了哪些文件」

官方 `@deepseek-ai/dsh-workspace-changes` 为每个顶层 turn 记一份改动摘要（git 快照 + 文件工具编辑的
整文件抓取），并用 `workspace/changes` 会话事件公告。这个插件订阅 `session/event` 攒下事件的 `seq`，
再用 `ctx.workspaceChanges.summary(sessionId, seq)` 把各 turn 的路径并起来 —— 那就是「本次对话改的」。

拿不到摘要时（宿主重启过 / 插件是会话中途才装的 / 没装 workspace-changes），面板会**明说**
「无法确认哪些是本次对话改的」，并默认全选，让你自己核对。

## commit message 的风格

提示词（宿主那段的第 3 步）要求 AI **先看这个仓库已有的风格**再写：

```bash
git log --oneline -20        # 语言、前缀、有没有 Conventional Commits / emoji / 工单号
```

- **有历史** → 照那个风格写，不换语言、不自作主张加/去前缀；
- **没有历史**（刚 `git init`、一个提交都没有）→ 用 `<type>: <描述>`：
  `type` 取 `feat / fix / chore / docs / refactor / test / perf / style / build / ci`，
  描述用与用户交流相同的语言，必要时 `<type>(<scope>): <描述>`；一次提交只做一件事。

这样「语言」是**跟着仓库走**的：英文仓库写英文、中文仓库写中文，没历史时才落到默认规范。

## 边界（都是设计取舍，不是 bug）

| 情况 | 行为 |
|---|---|
| 宿主重启后 | 旧 turn 的摘要没了（官方就是内存态）→ 退化成「按工作区未提交改动列出」 |
| 会话中途才装插件 | 装之前那些 turn 拿不到 → 同上 |
| 改名（R）的文件 | git 状态给「新路径 + 原名」，摘要里可能是旧路径 → 那个文件不会带「本次对话」徽标 |
| 非 git 仓库 | preview 失败，消息里会写「宿主没给出改动摘要」，AI 自己去 `git status` 判断 |
| 宿主没给出摘要 | 同上——照发，只是少一份参考 |
| 没有 upstream | 提示里会把「没有 upstream」写出来，由 AI 决定要不要 `-u`；推送被拒（权限/凭证/冲突）由它汇报并问你 |
| 纯 shell 改动 | 有 git 时靠工作区快照覆盖；没 git 的目录只会列出文件工具的编辑 |

## 安全

- 唯一的 `/preview` 路由也要求**回环**（`127.0.0.1`/`::1`）+ 自定义头 `x-dsh-git-ship: 1`。
  自定义头挡住「用户浏览器里别的网页往这里发请求」（跨站带自定义头必须过 CORS 预检，而这里不给 CORS 头）。
- **工作目录只从会话头拿**（`session.header.cwd`），不接受客户端传路径 ——
  否则任何本地进程都能让它在任意仓库里提交。
- 宿主只跑**只读** git 命令（`rev-parse` / `status` / `rev-list`），并且都带 `GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`。
- 真正改仓库的是 AI 的 bash 工具 —— 你在会话里本来就能看到它每一步、也能拦它。

## 开发

| | |
|---|---|
| 热重载 | `client.js` 改完 ~0.5 秒生效；`index.js`（Host 半边）要重启 App |
| 离线测试 | `/tmp/gitship-host-test.js`（真仓库端到端：preview / commit / push / 错误分支）、`/tmp/gitship-client-test.js`（dock 注册 + 面板交互） |
| 契约 | client bundle 只能 `require('react')`；Host 半边不能 `import '@deepseek-ai/*'`（link: 安装时解析不到） |
