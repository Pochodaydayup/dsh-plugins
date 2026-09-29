/**
 * 自测：`node selftest.mjs`（不需要起 App、不联网）。
 *
 * 覆盖补头层的全部行为边界：命中/不命中、已有同名头、Request 对象入参、
 * 自定义头与 UA、域名规则、ctx 探测失败时的回落、非法 URL 放行、重复 apply 只包一层。
 * 退出码 0 = 全过。
 */

import assert from 'node:assert/strict';

const INSTALLED = Symbol.for('@local/dsh-opencode-session/installed');
const { apply } = await import('./index.js');

/** 记录每次 fetch 收到的 (input, init)，并回一个 200。 */
function stubFetch() {
  const calls = [];
  const impl = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  globalThis.fetch = impl;
  return calls;
}

/** 装一次插件；返回卸载函数。 */
function install(config, ctx = {}) {
  delete globalThis[INSTALLED];
  const calls = stubFetch();
  apply(ctx, config);
  return { calls, uninstall: () => { delete globalThis[INSTALLED]; } };
}

const header = (call, key) => new Headers(call.init?.headers).get(key);

let passed = 0;
let failed = 0;
const test = async (label, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`✅ ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`❌ ${label}\n   ${String(error.message).split('\n').slice(0, 3).join('\n   ')}`);
  }
};

/** 官方搜索插件的真实请求形状。 */
const searchCall = (base) =>
  fetch(`${base}/messages`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'x-api-key': 'sk-test',
      authorization: 'Bearer sk-test',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'deepseek-harness/0.0.1',
    },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash' }),
  });

await test('命中 opencode.ai：补上 x-opencode-session（用 DSH 会话 id）', async () => {
  const { calls, uninstall } = install({}, { get: () => ({ currentInitiator: () => ({ session: { id: 'session-42' } }) }) });
  await searchCall('https://opencode.ai/zen/go/v1');
  assert.equal(calls.length, 1);
  assert.equal(header(calls[0], 'x-opencode-session'), 'session-42');
  uninstall();
});

await test('原有请求头、body、method 一个不动', async () => {
  const { calls, uninstall } = install({ sessionId: 'fixed' });
  await searchCall('https://opencode.ai/zen/go/v1');
  const { init } = calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(header(calls[0], 'x-api-key'), 'sk-test');
  assert.equal(header(calls[0], 'anthropic-version'), '2023-06-01');
  assert.equal(header(calls[0], 'user-agent'), 'deepseek-harness/0.0.1');
  assert.equal(init.body, JSON.stringify({ model: 'deepseek-v4.1-flash' }));
  uninstall();
});

await test('非命中域名（DeepSeek 官方 / Anthropic）原样放行，不加头', async () => {
  const { calls, uninstall } = install({ sessionId: 'fixed' });
  await searchCall('https://api.deepseek.com/anthropic/v1');
  await fetch('https://api.anthropic.com/v1/messages', { headers: { 'x-api-key': 'k' } });
  assert.equal(header(calls[0], 'x-opencode-session'), null);
  assert.equal(header(calls[1], 'x-opencode-session'), null);
  uninstall();
});

await test('已有 x-opencode-session 时不覆盖', async () => {
  const { calls, uninstall } = install({ sessionId: 'plugin-value' });
  await fetch('https://opencode.ai/zen/go/v1/messages', { headers: { 'x-opencode-session': 'caller-value' } });
  assert.equal(header(calls[0], 'x-opencode-session'), 'caller-value');
  uninstall();
});

await test('Request 对象入参：保留自身头，并补上会话头', async () => {
  const { calls, uninstall } = install({ sessionId: 'req-id' });
  const request = new Request('https://opencode.ai/zen/go/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': 'from-request' },
    body: 'ping',
  });
  await fetch(request);
  assert.equal(header(calls[0], 'x-api-key'), 'from-request');
  assert.equal(header(calls[0], 'x-opencode-session'), 'req-id');
  uninstall();
});

await test('子域也命中；查询串保留', async () => {
  const { calls, uninstall } = install({ sessionId: 'sub' });
  await fetch('https://api.opencode.ai/zen/go/v1/models?limit=5');
  assert.equal(header(calls[0], 'x-opencode-session'), 'sub');
  assert.equal(String(calls[0].input), 'https://api.opencode.ai/zen/go/v1/models?limit=5');
  uninstall();
});

await test('hosts 可换成别的网关（大小写、*. 前缀、前导点都归一化）', async () => {
  const { calls, uninstall } = install({ hosts: ['*.Example.COM', '.internal.test'], sessionId: 'x' });
  await fetch('https://api.example.com/v1/messages');
  await fetch('https://gw.internal.test/v1/messages');
  await fetch('https://opencode.ai/zen/go/v1/messages');
  assert.equal(header(calls[0], 'x-opencode-session'), 'x');
  assert.equal(header(calls[1], 'x-opencode-session'), 'x');
  assert.equal(header(calls[2], 'x-opencode-session'), null);
  uninstall();
});

await test('自定义 headers 与 userAgent 只在缺失时补', async () => {
  const { calls, uninstall } = install({
    sessionId: 'x',
    userAgent: 'dsh/1.0',
    headers: { 'x-extra': 'v', 'x-api-key': 'should-not-win' },
  });
  await fetch('https://opencode.ai/zen/go/v1/messages', { headers: { 'x-api-key': 'caller' } });
  assert.equal(header(calls[0], 'x-extra'), 'v');
  assert.equal(header(calls[0], 'user-agent'), 'dsh/1.0');
  assert.equal(header(calls[0], 'x-api-key'), 'caller');
  uninstall();
});

await test('ctx 探测抛错时回落，请求照发且仍有会话头', async () => {
  const { calls, uninstall } = install({}, { get: () => { throw new Error('no agents service'); } });
  await searchCall('https://opencode.ai/zen/go/v1');
  const value = header(calls[0], 'x-opencode-session');
  assert.equal(typeof value, 'string');
  assert.ok(value.length > 0);
  uninstall();
});

await test('相对 / 非法 URL 原样放行，不抛错', async () => {
  const { calls, uninstall } = install({ sessionId: 'x' });
  await fetch('/api/local', { headers: {} });
  assert.equal(header(calls[0], 'x-opencode-session'), null);
  uninstall();
});

await test('重复 apply 只包一层（注入一次，不透传两次）', async () => {
  const { calls, uninstall } = install({ sessionId: 'once' });
  apply({}, { sessionId: 'twice' });
  await fetch('https://opencode.ai/zen/go/v1/messages');
  assert.equal(calls.length, 1);
  assert.equal(header(calls[0], 'x-opencode-session'), 'once');
  uninstall();
});

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exitCode = failed === 0 ? 0 : 1;
