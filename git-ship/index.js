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
 *
 * 另外还给客户端的 **Git Diff 右侧 tab** 提供一条**只读** HTTP 路由（Web 版没有插件宿主进程时
 * tab 拿不到数据，所以走 HTTP 而不是工具）：
 *   POST /api/git-ship/diffs → 分支/upstream + **所有**未提交文件 + **每个文件的 diff**
 * 一次给全：tab 要「默认全部展开」，分开要点 N 次；而且全量 diff 只要 2 次 git 调用
 * （`git diff` + `git diff --cached`，按 `diff --git` 切段），比逐文件跑更省。
 * 依旧：只回环、必须带 `x-dsh-git-ship: 1` 标记头、只跑只读 git 命令。
 */

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

/** 路由前缀（Git Diff tab 用）。 */
const ROUTE_PREFIX = '/api/git-ship';
/** 自定义标记头：这条路由不走 web 的登录 cookie。 */
const HEADER = 'x-dsh-git-ship';
/** 请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024;
/** 单个文件 diff 的字符上限（超了截断并标注）。 */
const MAX_DIFF_CHARS = 200_000;
/** 整份响应里 diff 的总字符上限（超了后面的文件就不展开）。 */
const MAX_TOTAL_DIFF_CHARS = 2_500_000;
/** 未跟踪文件合成 diff 时，最多读这么多字节 / 这么多行。 */
const MAX_UNTRACKED_BYTES = 512 * 1024;
const MAX_UNTRACKED_LINES = 4000;
/** 只读 git 命令的超时。 */
const GIT_TIMEOUT_MS = 30_000;
/**
 * diff 的上下文行数。默认的 `-U3` 折不出「N 行未修改」（一段最多 6 行），
 * 而且看改动时前后看不到几行代码；`-U10` 让折叠与展开都有意义。
 */
const GIT_CONTEXT = '10';
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

/** 只接受本机回环请求。 */
const isLoopback = (req) => {
  const socket = req.socket;
  const address = socket === undefined || socket === null ? '' : socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === '';
};

const sendJson = (res, status, payload) => {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
};

const fail = (res, status, code, message) => sendJson(res, status, { ok: false, error: { code, message } });

const readJsonBody = (req) =>
  new Promise((resolve_, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve_(text === '' ? {} : JSON.parse(text));
      } catch (error) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });

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

/**
 * 把一整份 `git diff` 按文件切段。
 *
 * 只认**行首**（没有 `+`/`-`/空格前缀）的 `diff --git a/x b/y` —— diff 正文里的行一定带前缀，
 * 所以正文不可能被误判成段头。
 * 带特殊字符的路径 git 会用引号包起来，这种这里可能匹配不到：调用方有「单独再跑一次」的兜底。
 * @returns Map<path, 该文件的整段 diff>
 */
const splitByFile = (text) => {
  const map = new Map();
  let current = null;
  let buffer = [];
  for (const line of text.split('\n')) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head !== null) {
      if (current !== null) map.set(current, buffer.join('\n'));
      current = head[2];
      buffer = [line];
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  if (current !== null) map.set(current, buffer.join('\n'));
  return map;
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

/** systemPrompt 写说明，tools 挂只读工具，sessions 解析工作目录，webServer 挂 tab 用的只读路由。 */
export const inject = ['systemPrompt', 'tools', 'sessions', 'webServer'];


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

  /**
   * sessionId → 工作目录。
   *
   * 四层兜底，顺序照官方 `dsh-api-workspace-files` 的 `workspaceFileScope.resolve`：
   *   ① 会话事件里记下的（本轮见过活动的会话）
   *   ② `ctx.sessions.get(id)` —— 这个宿主进程里**活着**的会话
   *   ③ `ctx.get('sessionPersistence').stat(id).header.cwd` —— 落盘但**还没被加载**的会话
   *      （重启后立刻打开 tab 就是这种情况：Session 在磁盘上，本体还没进宿主进程）
   *   ④ `ctx.sandboxPolicy.workspaceRoot` —— 进程级默认工作区（官方也拿它兜底）
   * 路径只从这些地方来，**不接受客户端传**。
   */
  const cwdOf = async (sessionId) => {
    const known = cwdBySession.get(sessionId);
    if (known !== undefined) return known;

    let live;
    try {
      live = ctx.sessions.get(sessionId);
    } catch (error) {
      live = undefined;
    }
    if (live !== undefined) {
      rememberCwd(live);
      const cwd = live.header === undefined ? undefined : live.header.cwd;
      if (typeof cwd === 'string' && cwd !== '') return cwd;
    }

    try {
      const persistence = ctx.get('sessionPersistence');
      const stored = persistence === undefined ? undefined : await persistence.stat(sessionId);
      const cwd = stored === undefined || stored.header === undefined ? undefined : stored.header.cwd;
      if (typeof cwd === 'string' && cwd !== '') {
        cwdBySession.set(sessionId, cwd);
        return cwd;
      }
    } catch (error) {
      /* 没有持久化服务 / 读失败 → 继续兜底 */
    }

    const fallback = ctx.sandboxPolicy === undefined ? undefined : ctx.sandboxPolicy.workspaceRoot;
    if (typeof fallback === 'string' && fallback !== '') {
      console.log(`[dsh-git-ship] 会话 ${sessionId} 没有工作目录，退回进程默认工作区 ${fallback}`);
      return fallback;
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
    const cwd = await cwdOf(sessionId);
    if (cwd === undefined) {
      return {
        error: {
          code: 'no-session',
          message:
            '拿不到这个会话的工作目录：宿主进程里没有活着的会话、持久化层里也没查到、' +
            '进程默认工作区也没有。请先在会话里说一句话（让宿主把会话加载起来）再试。',
        },
      };
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

  /**
   * 读**所有**未提交文件的 diff。
   *
   * 两次 git 调用拿到全量（工作区 + 已暂存），按 `diff --git` 切段后按路径分给各文件；
   * 未跟踪文件 `git diff` 是空的，自己合成一段「全新增」；切段没命中的（特殊字符路径等）
   * 再单独跑一次兜底。
   *
   * 安全要点：真正的路径检查在调用方 —— 只处理 `git status` 里出现过的条目，
   * 不把客户端给的字符串塞进 git 参数。
   */
  const readAllDiffs = async (repo) => {
    const worktreeAll = await git(['diff', `-U${GIT_CONTEXT}`, '--no-color', '-M'], repo.root);
    const indexAll = await git(['diff', '--cached', `-U${GIT_CONTEXT}`, '--no-color', '-M'], repo.root);
    const worktreeMap = splitByFile(worktreeAll.stdout);
    const indexMap = splitByFile(indexAll.stdout);

    const cut = (text) => {
      const value = typeof text === 'string' ? text : '';
      return value.length > MAX_DIFF_CHARS
        ? { text: value.slice(0, MAX_DIFF_CHARS), truncated: true }
        : { text: value, truncated: false };
    };

    const files = [];
    let budget = MAX_TOTAL_DIFF_CHARS;
    for (const entry of repo.files) {
      const base = {
        path: entry.path,
        status: entry.status,
        label: statusLabel(entry.status),
        ...(entry.original === undefined ? {} : { original: entry.original }),
      };

      // 未跟踪：合成「全新增」
      if (entry.status.indexOf('?') >= 0) {
        if (budget <= 0) {
          files.push({ ...base, worktree: '', index: '', binary: false, truncated: true, note: '总输出已达上限，未展开' });
          continue;
        }
        const absolute = resolve(repo.root, entry.path);
        if (absolute !== repo.root && !absolute.startsWith(repo.root + sep)) {
          files.push({ ...base, worktree: '', index: '', binary: false, truncated: false, note: '这个路径不在仓库里，没展开' });
          continue;
        }
        let buffer;
        try {
          const stats = await stat(absolute);
          if (stats.size > MAX_UNTRACKED_BYTES) {
            files.push({
              ...base, worktree: '', index: '', binary: false, truncated: true,
              note: `文件 ${stats.size} 字节，超过 ${MAX_UNTRACKED_BYTES} 字节，不在这里展开`,
            });
            continue;
          }
          buffer = await readFile(absolute);
        } catch (error) {
          files.push({
            ...base, worktree: '', index: '', binary: false, truncated: false,
            note: `读不了这个文件：${String(error && error.message ? error.message : error)}`,
          });
          continue;
        }
        if (buffer.subarray(0, 8192).includes(0)) {
          files.push({ ...base, worktree: '', index: '', binary: true, truncated: false });
          continue;
        }
        const lines = buffer.toString('utf8').split('\n');
        const capped = lines.slice(0, MAX_UNTRACKED_LINES);
        const text = [
          `diff --git a/${entry.path} b/${entry.path}`,
          'new file mode 100644',
          '--- /dev/null',
          `+++ b/${entry.path}`,
          `@@ -0,0 +1,${capped.length} @@`,
          capped.map((line) => `+${line}`).join('\n'),
        ].join('\n');
        const piece = cut(text);
        budget -= piece.text.length;
        files.push({
          ...base,
          worktree: piece.text,
          index: '',
          binary: false,
          untracked: true,
          truncated: piece.truncated || lines.length > capped.length,
        });
        continue;
      }

      // 已跟踪：先从全量切段里取，取不到再单独跑（特殊字符路径 / 改名等）
      const candidates = entry.original === undefined ? [entry.path] : [entry.path, entry.original];
      const pick = (map) => {
        for (const candidate of candidates) {
          const found = map.get(candidate);
          if (found !== undefined && found !== '') return found;
        }
        return '';
      };
      let worktreeText = pick(worktreeMap);
      let indexText = pick(indexMap);
      let fallbackTruncated = false;
      if (worktreeText === '' && indexText === '') {
        const extraWorktree = await git(['diff', `-U${GIT_CONTEXT}`, '--no-color', '-M', '--', ...candidates], repo.root);
        const extraIndex = await git(['diff', '--cached', `-U${GIT_CONTEXT}`, '--no-color', '-M', '--', ...candidates], repo.root);
        worktreeText = extraWorktree.ok ? extraWorktree.stdout : '';
        indexText = extraIndex.ok ? extraIndex.stdout : '';
        fallbackTruncated = !extraWorktree.ok && !extraIndex.ok;
      }
      const worktreePiece = cut(worktreeText);
      const indexPiece = cut(indexText);
      budget -= worktreePiece.text.length + indexPiece.text.length;
      if (budget <= 0) {
        files.push({ ...base, worktree: '', index: '', binary: false, truncated: true, note: '总输出已达上限，未展开' });
        continue;
      }
      files.push({
        ...base,
        worktree: worktreePiece.text,
        index: indexPiece.text,
        binary: /Binary files|GIT binary patch/.test(worktreePiece.text + indexPiece.text),
        truncated: worktreePiece.truncated || indexPiece.truncated || fallbackTruncated,
      });
    }
    return files;
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) =>
          (async () => {
            if (!isLoopback(req)) {
              fail(res, 403, 'forbidden', '只接受本机回环请求');
              return;
            }
            // 这条路由不走 web 的登录 cookie，所以要自定义头：跨站请求带自定义头必须过 CORS 预检，
            // 而我们从不给 CORS 头 → 网页发不进来。
            if (req.headers === undefined || req.headers[HEADER] !== '1') {
              fail(res, 403, 'forbidden', `缺少 ${HEADER} 标记头`);
              return;
            }
            const url = new URL(req.url ?? '/', 'http://x');
            const path = url.pathname;
            if (req.method !== 'POST') {
              fail(res, 405, 'method', `只支持 POST（收到 ${req.method} ${path}）`);
              return;
            }
            if (path !== `${ROUTE_PREFIX}/diffs`) {
              fail(res, 404, 'not-found', `未知路由 ${req.method} ${path}（只有只读的 /diffs）`);
              return;
            }
            let body;
            try {
              body = await readJsonBody(req);
            } catch (error) {
              fail(res, 400, 'bad-request', String(error && error.message ? error.message : error));
              return;
            }
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
            if (sessionId === '') {
              fail(res, 400, 'bad-request', '缺 sessionId');
              return;
            }
            const repo = await readRepo(sessionId);
            if (repo.error !== undefined) {
              fail(res, 409, repo.error.code, repo.error.message);
              return;
            }
            const chat = chatFilesOf(sessionId, repo.cwd);
            // 只喂 git status 里真实存在的条目给 diff 读取器（路径白名单在这里收口）
            const limited = repo.files.slice(0, MAX_FILES);
            const diffs = await readAllDiffs({ ...repo, files: limited });
            const byPath = new Map(diffs.map((file) => [file.path, file]));
            const files = limited.map((file) => {
              const chatInfo = chat.merged.get(resolve(repo.root, file.path));
              const diff = byPath.get(file.path);
              return {
                path: file.path,
                status: file.status,
                label: statusLabel(file.status),
                ...(file.original === undefined ? {} : { original: file.original }),
                fromChat: chatInfo !== undefined,
                ...(chatInfo === undefined || chatInfo.added === undefined ? {} : { added: chatInfo.added }),
                ...(chatInfo === undefined || chatInfo.deleted === undefined ? {} : { deleted: chatInfo.deleted }),
                worktree: diff === undefined ? '' : diff.worktree,
                index: diff === undefined ? '' : diff.index,
                binary: diff !== undefined && diff.binary === true,
                truncated: diff !== undefined && diff.truncated === true,
                ...(diff === undefined || diff.untracked !== true ? {} : { untracked: true }),
                ...(diff === undefined || diff.note === undefined ? {} : { note: diff.note }),
              };
            });
            sendJson(res, 200, {
              ok: true,
              value: {
                cwd: repo.cwd,
                root: repo.root,
                branch: repo.branch,
                detached: repo.detached,
                upstream: repo.upstream,
                ahead: repo.ahead,
                behind: repo.behind,
                files,
                total: repo.files.length,
                truncated: repo.files.length > files.length,
                chatKnown: chat.known,
                chatReason: chat.reason,
                fromChat: files.filter((file) => file.fromChat).length,
              },
            });
          })().catch((error) => {
            try {
              fail(res, 500, 'internal', String(error && error.message ? error.message : error));
            } catch (writeError) {
              console.error('[dsh-git-ship] 路由回包失败', writeError);
            }
          }),
      }),
    'git-ship: read-only routes',
  );

  console.log(
    `[dsh-git-ship] host half ready: prompt + git_ship_changes + ${ROUTE_PREFIX}/diffs（全部只读，不做 git 写操作）`,
  );
}
