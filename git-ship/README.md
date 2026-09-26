# git-ship —— 「提交并推送」+ 右侧「Git Diff」tab

两块东西：

| 位置 | 功能 |
|---|---|
| 输入框上方 | **提交并推送**：点一下直接发一条 `@提交并推送`，由 AI 分析本次对话的改动并执行 git |
| 右侧边栏（`+` → Git Diff） | **Git Diff**：看这个会话仓库的未提交改动，逐个文件看 diff，标出「本次对话改过」的 |

---
## 一、提交并推送（输入框上方）

点一下 = **直接把一条用户消息发出去**（`conversation.sendSession(session, text, [], 'queue')`）——
不 setDraft、不放 chip、不点发送，**完全不经过输入框**，你写在输入框里的草稿也不会被动。

```
[⑂ 提交并推送]   ← 点一下
        ↓  直接发一条消息，正文只有一个 token
气泡里出现一个 chip：[提交并推送]
模型收到的正文：      @提交并推送
        ↓
含义由宿主侧提供（气泡里都看不见）：
  · system prompt 段落 plugin:dsh-git-ship：解释这个 token + 给出 5 步流程
  · 工具 git_ship_changes：只读返回「本次会话改过哪些文件」+ 分支/upstream/未提交清单
        ↓
模型据此 git status 核对 → 只提交本次对话改过的文件 → commit → push → 汇报
```

**为什么正文只有一个 token**：气泡里显示的文字**就是**模型收到的文字（`sendSession` 只有一份字符串），
所以「气泡里不显示文案」等价于「模型的消息正文里没有文案」。真正的说明只能放在模型能读、
气泡里看不见的地方 —— 也就是上面的 system prompt + 工具。

**插件不做任何 git 写操作**：提交/推送交给模型的 bash 工具，走你平时的审批策略。
宿主半边只有一段 system prompt 说明 + 一个只读工具（`rev-parse` / `status` / `rev-list`）。

---

## 二、Git Diff（右侧边栏 tab）

在右侧边栏点 **`+` → Git Diff** 打开（每个会话一个实例，切换 tab / 会话不卸载，选中状态保留）。

```
┌────────────────────────────────────────────────┐
│ feat/diff → origin/feat/diff ↑2 ↓0  [5 个改动] [本次对话 2]  [只看本次] [刷新] │
├────────────────────────────────────────────────┤
│ M a.txt            ●  +5/-1                    │   ← ● = 本次对话改过
│ U new.txt          ●  +3/-0                    │
│ D sub/b.txt                                    │
│ R keep/moved.txt                               │
│ M bin.dat                                      │
├────────────────────────────────────────────────┤
│ [工作区] [已暂存]      ← 两边都有内容时才出现     │
│  @@ -1 +1,3 @@                                 │
│ -a                                             │
│ +a changed                                     │
│ +more                                          │
└────────────────────────────────────────────────┘
```

数据来自宿主半边两条**只读**路由（和 annotate 同一套安全约定：只回环 + 必须带 `x-dsh-git-ship: 1`）：

| 路由 | 返回 |
|---|---|
| `POST /api/git-ship/status` | 分支 / upstream / ahead-behind / 未提交文件（含「本次对话改过」标记与增删行数） |
| `POST /api/git-ship/diff` | 单个文件的统一 diff：`worktree`（工作区）+ `index`（已暂存）两段，另有 `binary` / `truncated` / `untracked` |

细节：

- **未跟踪文件**（`??`）`git diff` 是空的，这里由宿主合成一段「全新增」的 diff（上限 512KB / 4000 行，超了就只报大小）。
- **二进制**只标记 `binary: true` 不展开；**重命名**按 `original → path` 取 diff（带 `-M`）。
- `path` **必须**是这次 `git status` 里真实存在的条目 —— 不把客户端给的字符串塞进 git 参数，
  所以 `../../etc/passwd`、`a.txt; cat /etc/passwd` 这类都被 409 挡掉（已测）。
- 前端一次最多画 3000 行，超了在底部提示「用 `git diff -- <path>` 看完整内容」。
- **宿主半边改完要重启**：客户端热重载后如果路由还没挂上，tab 会直接说
  「宿主半边还没重启：只读路由没挂上，重启一次 App 就好」，而不是空白。

---

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
