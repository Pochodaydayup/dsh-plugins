#!/usr/bin/env node
/**
 * 插件 manifest 体检 —— 装进 App **之前**先跑一遍。
 *
 * 为什么需要：`dsh-client-modules` 是**必需**插件，它要求「声明了 `dsh.client`
 * 就必须能解析出 `./client`」。少一个字段的后果不是「插件不工作」，而是
 * **整个 App 启动失败直接退出**（真实踩过：git-ship 第一版写了 `main` 却漏了 `exports`）：
 *
 *   client-modules: @local/dsh-git-ship declares dsh.client but exports no "./client" bundle
 *   → dsh: startup failed: 1 required plugin did not activate
 *
 * 用法：`node check-manifests.mjs [仓库根目录]`（默认取脚本所在目录），
 * 外加 `--json` 输出机器可读结果。退出码 0 = 全过。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.argv[2] === undefined || process.argv[2].startsWith('--')
  ? path.dirname(fileURLToPath(import.meta.url))
  : process.argv[2]);
const asJson = process.argv.includes('--json');

/** 仓库里每个「带 dsh 字段的包」都是一个插件。 */
const discover = () => {
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const manifestPath = path.join(root, entry.name, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      found.push({ dir: entry.name, manifestPath, manifest: undefined, parseError: String(error.message) });
      continue;
    }
    if (manifest.dsh !== undefined) found.push({ dir: entry.name, manifestPath, manifest });
  }
  return found.sort((left, right) => left.dir.localeCompare(right.dir));
};

const checks = (plugin) => {
  const results = [];
  const add = (ok, label, detail = '') => results.push({ ok, label, detail });
  const { manifest, dir, manifestPath } = plugin;

  if (manifest === undefined) {
    add(false, 'package.json 能解析', plugin.parseError);
    return results;
  }

  const exists = (relative) => typeof relative === 'string' && fs.existsSync(path.join(root, dir, relative));

  add(manifest.type === 'module', 'type: module');
  add(typeof manifest.exports === 'object' && manifest.exports !== null, '有 exports 映射');
  add(exists(manifest.exports?.['.']), 'exports["."] 指向的文件存在', String(manifest.exports?.['.']));

  if (manifest.dsh?.client !== undefined) {
    // ⚠️ 这一条就是会拖垮启动的那种错
    add(exists(manifest.exports?.['./client']), 'dsh.client ⇒ exports["./client"] 必须存在', String(manifest.exports?.['./client']));
    const client = manifest.exports?.['./client'];
    if (exists(client)) {
      const source = fs.readFileSync(path.join(root, dir, client), 'utf8');
      // 语法能编译（模板字符串被截断这类错误，光看 --check 有时会漏）
      try {
        new vm.Script(source, { filename: client });
        add(true, 'client bundle 语法可编译');
      } catch (error) {
        add(false, 'client bundle 语法可编译', String(error.message));
      }
      // ⚠️ 踩过两次：CSS 注释里写反引号会**提前结束模板字符串**
      //（一次变成运行时 ReferenceError，一次直接语法错）—— 这里直接禁掉。
      const cssBlock = /const CSS = `([\s\S]*?)`;/.exec(source);
      if (cssBlock !== null) {
        const offenders = cssBlock[1].split('\n').map((line, index) => ({ line, index })).filter((row) => row.line.includes('`'));
        add(offenders.length === 0, 'CSS 模板里没有反引号', offenders.map((row) => `第 ${row.index + 1} 行`).join(', '));
      }
      // client bundle 的 id 必须等于包名，否则 Loader 认不出这一份
      const id = source.match(/__ModuleLoader__\.load\(\{[\s\S]{0,120}?id:\s*['"]([^'"]+)['"]/);
      add(id !== null && id[1] === manifest.name, 'client bundle 的 id 等于包名', id === null ? '没找到 __ModuleLoader__.load({ id })' : id[1]);
    }
    add(manifest.dsh.client.platform === 'web', 'dsh.client.platform = web');
    for (const dependency of manifest.dsh.client.inject ?? []) {
      add(typeof dependency === 'string' && dependency.startsWith('@deepseek-ai/dsh-client-'), 'client.inject 用完整包名', String(dependency));
    }
  }

  if (manifest.dsh?.bundle?.patch !== undefined) {
    const patch = manifest.dsh.bundle.patch;
    add(exists(patch), 'bundle patch 文件存在', String(patch));
    if (exists(patch)) {
      const text = fs.readFileSync(path.join(root, dir, patch), 'utf8');
      add(text.includes(manifest.name), 'patch 里的 name 和包名一致');
    }
  }

  // Host 半边不能 import @deepseek-ai/*（link: 安装时那条路径下没有这些包）
  const entry = manifest.exports?.['.'];
  if (exists(entry)) {
    const source = fs.readFileSync(path.join(root, dir, entry), 'utf8');
    const imports = [...source.matchAll(/^\s*import[^'"]*from\s*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    const bad = imports.filter((specifier) => specifier.startsWith('@deepseek-ai/'));
    add(bad.length === 0, 'Host 半边没有 import @deepseek-ai/*（link: 装不上）', bad.join(', '));
  }

  return results;
};

const plugins = discover();
const report = plugins.map((plugin) => ({ dir: plugin.dir, name: plugin.manifest?.name ?? '(解析失败)', checks: checks(plugin) }));

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  let failed = 0;
  for (const plugin of report) {
    const bad = plugin.checks.filter((check) => !check.ok);
    failed += bad.length;
    console.log(`\n── ${plugin.name}  (${plugin.dir})`);
    for (const check of plugin.checks) {
      console.log(`   ${check.ok ? '✅' : '❌'} ${check.label}${check.detail === '' ? '' : '  ' + check.detail}`);
    }
  }
  console.log(failed === 0 ? `\n${report.length} 个插件全部通过 ✅` : `\n${failed} 项不通过 ❌`);
}

process.exitCode = report.some((plugin) => plugin.checks.some((check) => !check.ok)) ? 1 : 0;
