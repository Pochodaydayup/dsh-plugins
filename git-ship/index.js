/**
 * Host 半边：**只读**地帮模型回答「本次对话改了哪些文件」。
 *
 * 为什么需要它：客户端点按钮后只发一个 chip（消息正文就是 `@提交并推送`），气泡里没有正文文案。
 * 而气泡文本 = 模型收到的文本，所以模型的「该干什么」只能来自宿主侧：
 *   1. `ctx.systemPrompt.section(...)` —— 一段说明，告诉模型 `@提交并推送` 是什么意思、按哪几步做；
 *   2. `git_ship_changes` 工具 —— 只读地返回本次会话改过的文件 + 当前仓库状态，模型先调它再动手。
 * 两者都不出现在气泡里。
 *
 * 这个插件**不做任何 git 写操作**：提交/推送交给模型的 bash 工具，走你平时的审批策略。
 *
 * 「本次对话改的」从哪来：官方 `@deepseek-ai/dsh-workspace-changes` 为每个顶层 turn 记一份改动摘要，
 * 并用 `workspace/changes` 会话事件（只带 turn 号）公告；摘要留在宿主侧，用
 * `ctx.workspaceChanges.summary(sessionId, seq)` 取。这里订阅 `session/event` 攒 seq 再取并集。
 *
 * ⚠️ 已知边界：摘要内存态（宿主重启即失）；插件只收到它加载之后的事件。拿不到就如实回报，
 * 让模型自己判断，而不是瞎猜。
 *
 * ⚠️ 和 annotate 插件同一条硬约束：**不能 import `@deepseek-ai/*`**（link: 安装时解析不到），
 * 所以工具定义按 `defineTool()` 编译后的原始 JSON Schema 形状手写，一切从 ctx 上取。
 */

import { execFile } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

/** 只读 git 命令的超时。 */
const GIT_TIMEOUT_MS = 30_000;
/** 工具返回里最多列多少个文件。 */
const MAX_FILES = 500;

/**
 * 跑一条**只读** git 命令。
 * `GIT_TERMINAL_PROMPT=0` 防挂在交互提示上；`GIT_OPTIONAL_LOCKS=0` 不碰锁文件。
 */
const git = (args, cwd) =>
  new Promise((resolve_) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout, stderr) => {
        resolve_({
          ok: error === null,
          stdout: String(stdout === undefined ? '' : stdout),
          stderr: String(stderr === undefined ? '' : stderr),
          message: error === null ? '' : String(error.message),
        });
      },
    );
  });

const firstLine = (text) => text.split('\n').find((line) => line.trim() !== '') ?? '';

/**
 * 解析 `git status --porcelain=v1 -z`。
 * 两个实测过的坑：路径**相对仓库根**（哪怕 cwd 在子目录）；`R`/`C` 条目是**两段**
 * （原始字节 `R  renamed.txt\0a.txt\0`，第二段才是原名）。
 */
const parseStatus = (out) => {
  const parts = out.split('\0');
  const files = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (entry === '') continue;
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    let original;
    if (status[0] === 'R' || status[0] === 'C') original = parts[(index += 1)];
    files.push({ status, path: filePath, ...(original === undefined ? {} : { original }) });
  }
  return files;
};

/** 状态码 → 人话。 */
const statusLabel = (status) => {
  const code = status.trim() === '' ? '?' : status.trim();
  if (code.indexOf('?') >= 0) return '新增未跟踪';
  if (code.indexOf('R') >= 0) return '改名';
  if (code.indexOf('C') >= 0) return '复制';
  if (code.indexOf('A') >= 0) return '新增';
  if (code.indexOf('D') >= 0) return '删除';
  if (code.indexOf('M') >= 0) return '修改';
  if (code.indexOf('U') >= 0) return '冲突';
  return code;
};

/** cordis 插件名。 */
export const name = 'git-ship';

/** systemPrompt 写说明，tools 挂只读工具，sessions 把 sessionId 解析成工作目录。 */
export const inject = ['systemPrompt', 'tools', 'sessions'];


/**
 * 注入系统提示的说明。没有它，模型看到一条只有 `@提交并推送` 的消息会一头雾水。
 * 这段不进气泡、也不占用户消息的正文。
 */
const GUIDANCE = [
  '用户可能点击输入框上方的「提交并推送」按钮：那样发出来的消息**正文只有一个 `@提交并推送`**（一个引用 chip），没有别的文字。',
  '看到它（或用户说「提交并推送」「把这次改动提上去」）时，按下面做：',
  '1. 先调用 `git_ship_changes` 工具：它只读地告诉你当前分支 / upstream / 未提交文件，以及宿主记录到的**本次会话改过**的文件；',
  '2. 再用 `git status --porcelain` 核对当下的真实状态，**只提交本次会话改过的那些文件**，不要顺手带上无关的改动；',
  '3. commit message **先对齐仓库已有风格**：跑 `git log --oneline -20`（必要时 `git log -20 --pretty=%s`）看历史 —— 语言、前缀、是否 Conventional Commits / emoji / 工单号，一律照它来，别自作主张换语言或加前缀；',
  '   如果仓库还没有历史（刚 init、一个提交都没有）：用 `<type>: <描述>` 规范，type 取 feat / fix / chore / docs / refactor / test / perf / style / build / ci，描述用与用户交流相同的语言，需要时写成 `<type>(<scope>): <描述>`；一次提交只做一件事；',
  '4. 然后 `git add -- <这些文件> && git commit -m "<message>" && git push`（当前分支没有 upstream 时按需 `-u`）；',
  '5. 分不清哪些算本次对话的改动、或遇到冲突 / 推送被拒，用 ask_user_question 问用户，别猜；',
  '6. 做完汇报：commit hash、commit message、推送结果、以及剩下的 `git status`。',
].join('');

/**
 * 手写的工具定义：字段形状 = `defineTool()` 编译后的结果
 * （`parameters` / `output.schema` 是**原始 JSON Schema**，不是那套友好 DSL —— 因为 import 不到 dsh-tools）。
 */
function createChangesTool(chatFilesOf, readRepo) {
  return {
    name: 'git_ship_changes',
    description:
      '只读地列出「本次对话改过的文件」和当前 git 仓库状态（分支 / upstream / 领先落后 / 未提交文件）。' +
      '用户点了输入框上方的「提交并推送」（消息正文只有一个 `@提交并推送` chip）时，先调用它，再据此执行 git add/commit/push。' +
      '它只读，不会改任何东西。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: {
          type: 'string',
          description: '要查的会话 id。省略就用调用方自己的会话（通常不用传）。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean' },
          sessionId: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['found', 'sessionId', 'text'],
      },
      render: (_args, value) => [
        { type: 'text', text: typeof value?.text === 'string' ? value.text : '没有可用的仓库信息' },
      ],
    },
    async execute(args, exec) {
      const asked = args !== undefined && typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
      const sessionId =
        asked !== ''
          ? asked
          : exec !== undefined && exec.agent !== undefined && typeof exec.agent.id === 'string'
            ? exec.agent.id
            : '';
      if (sessionId === '') {
        return { found: false, sessionId: '', text: '拿不到会话 id，没法判断「本次对话改了什么」。' };
      }
      const repo = await readRepo(sessionId);
      if (repo.error !== undefined) {
        return {
          found: false,
          sessionId,
          text: `读不到仓库状态：${repo.error.message}\n（你仍然可以自己跑 git status 判断，或者问用户仓库在哪。）`,
        };
      }
      const chat = chatFilesOf(sessionId, repo.cwd);
      const lines = [];
      lines.push(`仓库：${repo.root}`);
      lines.push(
        `分支：${repo.branch}${repo.upstream === '' ? '（没有 upstream）' : ` → ${repo.upstream}`}` +
          (repo.ahead === 0 && repo.behind === 0 ? '' : `，领先 ${repo.ahead} / 落后 ${repo.behind}`),
      );
      lines.push(`工作区未提交：${repo.files.length} 个文件`);
      const marked = repo.files
        .map((file) => ({ file, info: chat.merged.get(resolve(repo.root, file.path)) }))
        .filter((entry) => entry.info !== undefined);
      if (chat.known === false) {
        lines.push('');
        lines.push(`⚠️ 宿主这次**没有**本次对话的改动摘要（${chat.reason}），所以下面无法区分哪些是本次对话改的。`);
        lines.push('请根据你自己的记忆 + `git status` 判断；拿不准就用 ask_user_question 问用户。');
        lines.push('全部未提交文件：');
        for (const file of repo.files.slice(0, MAX_FILES)) lines.push(`  - ${file.path}（${statusLabel(file.status)}）`);
      } else {
        lines.push('');
        lines.push(`本次对话改过（宿主记录，建议只提交这些）：${marked.length} 个`);
        if (marked.length === 0) {
          lines.push('  （一个都没有 —— 要么这次对话没改文件，要么摘要已过期，请以 git 为准）');
        } else {
          for (const { file, info } of marked.slice(0, MAX_FILES)) {
            const counts = info.added === undefined ? '' : `  +${info.added}/-${info.deleted}`;
            lines.push(`  - ${file.path}（${statusLabel(file.status)}）${counts}`);
          }
        }
        const others = repo.files.filter((file) => chat.merged.get(resolve(repo.root, file.path)) === undefined);
        if (others.length > 0) {
          lines.push('');
          lines.push(`其它未提交（**不要**顺手带上）：${others.length} 个`);
          for (const file of others.slice(0, MAX_FILES)) lines.push(`  - ${file.path}（${statusLabel(file.status)}）`);
        }
      }
      lines.push('');
      lines.push('提醒：这份清单来自会话改动摘要，路径可能已变、也可能混有用户手工改的东西；提交前用 `git status --porcelain` 核对。');
      return { found: true, sessionId, text: lines.join('\n') };
    },
  };
}

/**
 * 挂说明 + 只读工具 + 会话跟踪。
 * @param ctx - 宿主插件上下文。
 */
export function apply(ctx) {
  /** sessionId → 工作目录（来自会话头，不接受客户端传路径）。 */
  const cwdBySession = new Map();
  /** sessionId → 见过的 `workspace/changes` 事件 seq。 */
  const seqsBySession = new Map();
  let warnedNoSeq = false;
  let sawChangesEvent = false;

  const rememberCwd = (session) => {
    if (session === undefined || session === null) return;
    const cwd = session.header === undefined ? undefined : session.header.cwd;
    if (typeof cwd === 'string' && cwd !== '') cwdBySession.set(session.id, cwd);
  };

  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        rememberCwd(session);
        if (event === undefined || event === null || event.type !== 'workspace/changes') return;
        sawChangesEvent = true;
        const seq = event.seq;
        if (!Number.isSafeInteger(seq)) {
          if (!warnedNoSeq) {
            warnedNoSeq = true;
            console.warn('[dsh-git-ship] workspace/changes 事件没有 seq，无法关联「本次对话改的」文件');
          }
          return;
        }
        const set = seqsBySession.get(session.id);
        if (set === undefined) seqsBySession.set(session.id, new Set([seq]));
        else set.add(seq);
      }),
    'git-ship: session tracking',
  );

  /** sessionId → 工作目录：先看事件里记的，再问 sessions 服务。 */
  const cwdOf = (sessionId) => {
    const known = cwdBySession.get(sessionId);
    if (known !== undefined) return known;
    try {
      const session = ctx.sessions.get(sessionId);
      rememberCwd(session);
      const cwd = session === undefined || session.header === undefined ? undefined : session.header.cwd;
      if (typeof cwd === 'string' && cwd !== '') return cwd;
    } catch (error) {
      /* 会话不在这个宿主进程里 → 交给调用方报错 */
    }
    return undefined;
  };

  /** 本次对话改过的文件：各 turn 的 workspaceChanges 摘要取并集。 */
  const chatFilesOf = (sessionId, cwd) => {
    const merged = new Map();
    const service = ctx.get('workspaceChanges');
    if (service === undefined) return { merged, known: false, reason: '宿主没装 workspace-changes' };
    const seqs = seqsBySession.get(sessionId);
    if (seqs === undefined || seqs.size === 0) {
      return {
        merged,
        known: false,
        reason: sawChangesEvent ? '这个会话还没有 workspace/changes 事件' : '插件加载后还没见过 workspace/changes 事件',
      };
    }
    for (const seq of seqs) {
      let summary;
      try {
        summary = service.summary(sessionId, seq);
      } catch (error) {
        continue;
      }
      if (summary === undefined || summary === null || !Array.isArray(summary.files)) continue;
      for (const file of summary.files) {
        if (file === null || typeof file !== 'object' || typeof file.path !== 'string') continue;
        // 摘要里的路径：工作目录内是相对路径，之外是绝对路径
        const absolute = isAbsolute(file.path) ? file.path : resolve(cwd, file.path);
        merged.set(absolute, {
          added: typeof file.added === 'number' ? file.added : undefined,
          deleted: typeof file.deleted === 'number' ? file.deleted : undefined,
          turn: summary.turn,
        });
      }
    }
    return { merged, known: true, reason: '' };
  };

  /** 读一次仓库状态（纯只读命令）。 */
  const readRepo = async (sessionId) => {
    const cwd = cwdOf(sessionId);
    if (cwd === undefined) {
      return { error: { code: 'no-session', message: '拿不到这个会话的工作目录（会话可能已结束，或宿主是旧进程）' } };
    }
    const rootResult = await git(['rev-parse', '--show-toplevel'], cwd);
    if (!rootResult.ok) {
      return {
        error: {
          code: 'not-a-repo',
          message: `这个工作目录不在 git 仓库里（${cwd}）：${firstLine(rootResult.stderr) || rootResult.message}`,
        },
      };
    }
    const root = rootResult.stdout.trim();
    const branchResult = await git(['symbolic-ref', '--short', 'HEAD'], root);
    const upstreamResult = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root);
    const upstream = upstreamResult.ok ? upstreamResult.stdout.trim() : '';
    let ahead = 0;
    let behind = 0;
    if (upstream !== '') {
      const count = await git(['rev-list', '--left-right', '--count', `${upstream}...HEAD`], root);
      if (count.ok) {
        const fields = count.stdout.trim().split(/\s+/);
        behind = Number.parseInt(fields[0], 10) || 0;
        ahead = Number.parseInt(fields[1], 10) || 0;
      }
    }
    const statusResult = await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], root);
    if (!statusResult.ok) {
      return { error: { code: 'status-failed', message: firstLine(statusResult.stderr) || statusResult.message } };
    }
    return {
      cwd,
      root,
      branch: branchResult.ok ? branchResult.stdout.trim() : 'HEAD（游离）',
      detached: !branchResult.ok,
      upstream,
      ahead,
      behind,
      files: parseStatus(statusResult.stdout),
    };
  };

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'plugin:dsh-git-ship',
        order: 175,
        text: GUIDANCE,
      }),
    'git-ship: guidance',
  );

  ctx.effect(
    () => ctx.tools.register(createChangesTool(chatFilesOf, readRepo)),
    'git-ship: git_ship_changes tool',
  );

  console.log('[dsh-git-ship] host half ready: system prompt section + git_ship_changes（只读，不做 git 写操作）');
}
