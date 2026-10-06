import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(manifest.name, '@local/continue-plugin');
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
assert.equal(manifest.dsh.client.platform, 'web');
assert.equal(manifest.exports['./client'], './client.js');
for (const file of ['index.js', 'core.js', 'client.js', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json']) assert.ok(existsSync(file), file);
for (const lang of ['en', 'zh']) assert.ok(JSON.parse(readFileSync(`locale/${lang}.json`, 'utf8')).meta.title);
for (const file of ['index.js', 'core.js', 'client.js']) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  assert.equal(result.status, 0, `${file}: ${result.error ?? 'syntax error'}`);
}
const client = readFileSync('client.js', 'utf8');
assert.ok(!client.includes("require('@deepseek-ai/"));
assert.ok(!client.includes('document.body'));
const injected = new Set([...client.match(/inject:\s*\[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
const ctxBuiltins = new Set(['effect', 'get', 'inject']);
for (const [, service] of client.matchAll(/ctx\.(\w+)/g)) {
  if (!ctxBuiltins.has(service)) assert.ok(injected.has(service), `Client ctx.${service} requires inject`);
}
assert.ok(client.includes("id: '@local/continue-plugin'"));
assert.ok(client.includes("name: 'conversation.input.activity'"));
assert.ok(!/#[0-9a-f]{3,8}\b/i.test(client));
assert.ok([...client.matchAll(/var\((--[^,)]+)/g)].every(match => match[1].startsWith('--dsw-alias-')));
console.log('PASS: manifest, entry files, locale metadata, JS syntax and Client styling constraints');
