import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';

// Optional local compatibility check against actual DSH-distributed artifacts.
// No network or model requests are sent. Cordis lifecycle and Connection are
// stand-ins; namespace method selection, arity checks and RPC mapping are real.
const [gatewayPath, commandsPath] = process.argv.slice(2);
assert.ok(gatewayPath && commandsPath,
  'Usage: node scripts/check-client-runtime.mjs <gateway-client.js> <commands-typert.remote-client.js>');
function loadClient(path, dependencies) {
  let definition;
  runInNewContext(readFileSync(path, 'utf8'), {
    AbortController, AbortSignal, Error, crypto: webcrypto,
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
  }, { filename: String(path) });
  return definition.factory(name => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected module ${name}`);
    return dependencies[name];
  });
}

const services = new Map(), calls = [], cleanup = [];
let reply = { ok: true, value: { commandId: 'runtime-check', result: { kind: 'success' } } };
class Service {
  constructor(ctx, name) { this.ctx = ctx; services.set(name, this); }
}
const connection = {
  rpc: {
    // Supply a stream entry to prevent WebSocket fallback; it must not be used.
    open() { assert.fail('unexpected stream request'); },
    async call(path, endpoint, payload, signal) {
      calls.push({ path, endpoint, payload, signal });
      return reply;
    },
  },
  start() { return { stop() {} }; },
  registerGenerationSource() { return () => {}; },
};
services.set('connection', connection);
const ctx = {
  get: key => services.get(key),
  reflect: { props: {} },
  typert: {
    contexts: { getClient() { return undefined; } },
    remotes: { register() { return () => {}; } },
  },
  emit() {},
  effect(effect) { const dispose = effect(); cleanup.push(dispose); return dispose; },
  plugin(definition) {
    definition.apply(ctx);
    return Object.assign(Promise.resolve(), { dispose: async () => {} });
  },
};
const gateway = loadClient(gatewayPath, { '@deepseek-ai/cordis': { Service } });
gateway.apply(ctx);

// Generated descriptor schema factories are lazy; importing their metadata
// here needs no zod implementation. The actual Remote adapter reads metadata.
const descriptorText = readFileSync(commandsPath, 'utf8');
assert.ok(descriptorText.includes('export const TYPERT_REMOTE ='));
const descriptorContext = { module: { exports: {} } };
runInNewContext(descriptorText
  .replace(/^import \{ z \} from 'zod'\r?\n/m, '')
  .replace('export const TYPERT_REMOTE =', 'const TYPERT_REMOTE =')
  .replace('export default TYPERT_REMOTE', 'module.exports = TYPERT_REMOTE'), descriptorContext,
{ filename: commandsPath });
const contribution = descriptorContext.module.exports;
const remote = services.get('remote');
const unmount = await remote.mountContribution(ctx, contribution);
try {
  const commands = services.get('remote.commands');
  const sessionId = 'session-runtime-check';
  const line = '/continue-session {"expectedTurn":7}';
  await assert.rejects(commands.execute({ agentId: sessionId, line, submittedAttachments: [] }),
    /commands\/execute expected 3 business argument\(s\) plus an optional AbortSignal, got 1/);
  assert.equal(calls.length, 0, 'old shape must fail before RPC');
  console.log('PASS: actual DSH Client adapter reproduces the reported error for the old object call');

  const plugin = loadClient(new URL('../client.js', import.meta.url), { react: { createElement() {} } });
  await plugin.submitRecovery(commands, sessionId, 7, key => key);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api');
  assert.equal(calls[0].endpoint, 'commands/execute');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload)), {
    args: { agentId: sessionId, line, submittedAttachments: [] },
  });
  assert.ok(calls[0].signal instanceof AbortSignal);
  console.log('PASS: patched plugin passes actual DSH Client arity validation and RPC argument mapping');

  reply = { ok: false, error: { code: 'gateway/internal', message: 'runtime failure', details: {} } };
  await assert.rejects(plugin.submitRecovery(commands, sessionId, 7, key => key), /runtime failure/);
  console.log('PASS: actual Remote error envelope reaches the plugin error handler');
} finally {
  await unmount();
  for (const dispose of cleanup.reverse()) await dispose?.();
}
