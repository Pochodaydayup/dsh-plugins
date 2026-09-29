/**
 * Host 半边：给**发往 OpenCode 网关**的请求补上 `x-opencode-session` 头。
 *
 * 为什么需要它：OpenCode Go（`https://opencode.ai/zen/go/v1`，$10/月那档订阅）要求客户端
 * 「每个会话发一个稳定的 session ID 在 `x-opencode-session` 里」，网关靠它做路由与
 * prompt 缓存；缺这个头时部分接口直接 400：
 *
 *   HTTP 400 Request is missing x-opencode-session and cannot be routed efficiently.
 *
 * 而官方 web 搜索插件 `@deepseek-ai/dsh-web-search-deepseek` 的请求头是**写死**的
 * （`x-api-key` / `authorization` / `anthropic-version` / `content-type` / `accept` /
 * `user-agent`），config 里只有 `apiKey|apiKeyEnv|baseURL|model|apiVersion|maxTokens|maxUses`，
 * **没有任何加 header 的口子** —— 它走的是自己的 `fetch`，不经过 `ctx.llm`，
 * 所以「换个 provider / 加个 header」在配置层面无解。
 *
 * 这个插件的做法：在**宿主原生 `fetch`** 外面包一层，命中配置域名的请求补头，
 * 其余请求原样放行。它不关心是哪个插件/哪条链路发的请求，所以：
 *   - 修好 web 搜索（`POST {baseURL}/messages`）；
 *   - 顺带把**对话**请求也带上会话头（DeepSeek Harness 在 opencode 的「已知问题客户端」
 *     名单里：会话信息只在部分模型路径上传，官方建议所有适配器都发）。
 *
 * 设计约束（和 annotate / git-ship 同一条）：**不能 import `@deepseek-ai/*`**
 * （`link:` 安装时那条路径下没有这些包），所以这里不引 schemastery，config 手动归一化；
 * 除了 `node:crypto`（取兜底 uuid）之外没有依赖。
 *
 * 只做一件事：补头。不改 body、不重试、不代理、不落盘、不记 key。
 */

import { randomUUID } from 'node:crypto';

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'opencode-session';

/** 默认要补头的域名：OpenCode Go / Zen 网关。 */
const DEFAULT_HOSTS = ['opencode.ai'];

/** OpenCode Go 要求的会话头名。 */
const DEFAULT_SESSION_HEADER = 'x-opencode-session';

/** 重复加载时避免二次包裹（热重载 / 同一配置层被应用两次）。 */
const INSTALLED = Symbol.for('@local/dsh-opencode-session/installed');

/** 进程内兜底会话 id（拿不到 DSH 会话时用，保证同进程内稳定）。 */
let fallbackSessionId;

/**
 * 归一化一个域名条目：`opencode.ai` / `.opencode.ai` / `*.opencode.ai` 等价。
 * @param host - 配置里的原始条目。
 * @returns 小写、无前导点/通配的域名。
 */
const normalizeHost = (host) => host.trim().toLowerCase().replace(/^\*\./u, '').replace(/^\./u, '');

/**
 * 取非空字符串数组，否则回落。
 * @param value - 配置值。
 * @param fallback - 回落值。
 * @returns 过滤后的字符串数组。
 */
const stringArray = (value, fallback) => {
  if (!Array.isArray(value)) return fallback;
  const kept = value.filter((item) => typeof item === 'string' && item.trim().length > 0).map(normalizeHost);
  return kept.length > 0 ? kept : fallback;
};

/**
 * 取非空字符串，否则回落。
 * @param value - 配置值。
 * @param fallback - 回落值（`undefined` 表示「没有就不设」）。
 * @returns 字符串或 `undefined`。
 */
const stringOr = (value, fallback) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;

/**
 * 归一化插件配置。未知字段忽略；`headers` 只收字符串值。
 * @param config - Loader 传进来的原始配置（可能为空）。
 * @returns 本次加载生效的配置。
 */
function normalizeConfig(config) {
  const raw = config === undefined || config === null ? {} : config;
  const headers = {};
  if (raw.headers !== undefined && raw.headers !== null && typeof raw.headers === 'object') {
    for (const [key, value] of Object.entries(raw.headers)) {
      if (typeof value === 'string') headers[key] = value;
    }
  }
  return {
    hosts: stringArray(raw.hosts, DEFAULT_HOSTS),
    sessionHeader: stringOr(raw.sessionHeader, DEFAULT_SESSION_HEADER),
    sessionId: stringOr(raw.sessionId, undefined),
    userAgent: stringOr(raw.userAgent, undefined),
    headers,
    debug: raw.debug === true,
  };
}

/**
 * 把 fetch 的入参解析成 URL。相对路径、非法 URL 一律返回 `undefined`（原样放行）。
 * @param input - `fetch` 的第一个参数。
 * @returns URL，或 `undefined`。
 */
function toUrl(input) {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    if (input !== null && typeof input === 'object' && typeof input.url === 'string') return new URL(input.url);
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * 域名是否命中其一（自身或子域）。
 * @param hostname - 请求的域名。
 * @param hosts - 归一化后的域名列表。
 * @returns 是否命中。
 */
const hostMatches = (hostname, hosts) => {
  const host = hostname.toLowerCase();
  return hosts.some((pattern) => host === pattern || host.endsWith(`.${pattern}`));
};

/**
 * 取本次请求该用的会话 id：字面配置 → 当前 DSH 会话 → 环境变量 → 进程内兜底。
 *
 * 用 DSH 自己的 `session-<n>` 而不是另造一个随机值，是为了让网关侧的路由/缓存
 * 和宿主里的会话一一对应（出问题能对上号）。任何一步拿不到都静默往下走，
 * 绝不因为探测失败而让请求挂掉。
 *
 * @param ctx - 宿主插件上下文。
 * @param config - 归一化后的配置。
 * @returns 会话 id。
 */
function sessionIdFor(ctx, config) {
  if (config.sessionId !== undefined) return config.sessionId;
  try {
    const id = ctx?.get?.('agents')?.currentInitiator?.()?.session?.id;
    if (typeof id === 'string' && id.length > 0) return id;
  } catch {
    // 宿主形状变化（或此刻没有发起者）时走后面的兜底，不打扰请求。
  }
  const ambient = process.env.DSH_SESSION_ID;
  if (typeof ambient === 'string' && ambient.length > 0) return ambient;
  fallbackSessionId ??= `dsh-${process.pid}-${randomUUID()}`;
  return fallbackSessionId;
}

/**
 * 在原生 `fetch` 外面包一层：命中域名就补头（不覆盖已有的同名头）。
 * @param ctx - 宿主插件上下文。
 * @param config - 归一化后的配置。
 * @returns 卸载函数（恢复原生 fetch）。
 */
function install(ctx, config) {
  const original = globalThis.fetch;
  if (typeof original !== 'function') {
    ctx?.logger?.('opencode-session')?.warn?.('globalThis.fetch 不可用，跳过补头');
    return () => {};
  }

  const wrapped = function fetchWithSessionHeader(input, init) {
    const url = toUrl(input);
    if (url === undefined || !hostMatches(url.hostname, config.hosts)) return original.call(this, input, init);

    // 从 Request 对象上继承原始头（init.headers 会整体替换 Request 自己的头，所以要先并进来）。
    const base = init?.headers ?? (typeof Request === 'function' && input instanceof Request ? input.headers : undefined);
    const headers = new Headers(base);
    if (!headers.has(config.sessionHeader)) headers.set(config.sessionHeader, sessionIdFor(ctx, config));
    if (config.userAgent !== undefined && !headers.has('user-agent')) headers.set('user-agent', config.userAgent);
    for (const [key, value] of Object.entries(config.headers)) if (!headers.has(key)) headers.set(key, value);

    if (config.debug) {
      try {
        ctx?.logger?.('opencode-session')?.info?.(`${config.sessionHeader} → ${url.origin}${url.pathname}`);
      } catch {
        // 日志失败不影响请求。
      }
    }
    return original.call(this, input, { ...init, headers });
  };

  globalThis.fetch = wrapped;
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
  };
}

/**
 * 挂上补头层。走 `ctx.effect` 以便卸载/重载时恢复原生 `fetch`。
 * @param ctx - 宿主插件上下文。
 * @param config - Loader 传入的配置。
 */
export function apply(ctx, config) {
  if (globalThis[INSTALLED] === true) return;
  const normalized = normalizeConfig(config);
  globalThis[INSTALLED] = true;
  const dispose = install(ctx, normalized);
  ctx?.effect?.(() => {
    return () => {
      dispose();
      globalThis[INSTALLED] = false;
    };
  });
}
