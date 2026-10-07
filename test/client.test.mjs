import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

// Run the shipped Client entry and its registered button. Only React and the
// transport are stand-ins; no copy of the plugin's click handler is tested.
function mount({ execute, view = { interrupted: true, turn: 7 }, session = {}, locked = false } = {}) {
  const state = [], cleanup = [], serviceReads = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    useState(initial) {
      const index = state.push(initial) - 1;
      return [initial, value => { state[index] = value; }];
    },
    useRef(current) { return { current }; },
    useId() { return 'continue-tooltip-test'; },
    useEffect(effect) { const dispose = effect(); if (dispose) cleanup.push(dispose); },
  };
  let definition, Button;
  runInNewContext(source, {
    Error,
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
  }, { filename: 'client.js' });
  const plugin = definition.factory(name => {
    assert.equal(name, 'react');
    return React;
  });
  const commands = execute ? { execute } : undefined;
  const ctx = {
    effect: callback => callback(),
    locale: { register() {} },
    slots: {
      inject(name, callback) { assert.equal(name, 'conversation.input.activity'); callback(); },
      register(options, component) { assert.equal(options.id, 'local-continue-button'); Button = component; },
    },
    get(key) { serviceReads.push(key); assert.equal(key, 'remote.commands'); return commands; },
    get remote() { throw new Error('cannot get property "remote" without inject'); },
  };
  plugin.apply(ctx);
  const tree = Button({
    sessionId: 'session-contract-test',
    useProjection: key => { assert.equal(key, 'continue-availability'); return view; },
    useSession: select => select({ openState: 'open', running: false, ...session }),
    locked,
    t: key => ({ unavailable: 'command unavailable', failed: 'recovery failed' }[key] ?? key),
  });
  return {
    tree, state, serviceReads,
    button: tree?.children.find(child => child?.type === 'button'),
    unmount() { cleanup.forEach(dispose => dispose()); },
  };
}

const success = { ok: true, value: { commandId: 'command-test', result: { kind: 'success' } } };

// This arity is the generated DSH Client contract, not the JSON RPC envelope.
function positionalExecute(reply, calls) {
  return async function (...args) {
    if (args.length !== 3) throw new Error(`client api: commands/execute expected 3 business argument(s) plus an optional AbortSignal, got ${args.length}`);
    const [sessionId, line, attachments] = args;
    assert.equal(sessionId, 'session-contract-test');
    assert.equal(line, '/continue-session {"expectedTurn":7}');
    assert.equal(Array.isArray(attachments), true);
    assert.equal(attachments.length, 0);
    calls.push(args);
    return typeof reply === 'function' ? reply() : reply;
  };
}

test('button invokes the namespace service with three positional business arguments', async () => {
  const calls = [];
  const ui = mount({ execute: positionalExecute(success, calls) });
  assert.ok(ui.button);
  await ui.button.props.onClick();
  assert.equal(calls.length, 1);
  assert.deepEqual(ui.serviceReads, ['remote.commands']);
  assert.deepEqual(ui.state, [false, null]);
});

test('duplicate clicks submit once while the request is pending', async () => {
  const calls = [];
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const ui = mount({ execute: positionalExecute(() => pending, calls) });
  const first = ui.button.props.onClick();
  assert.equal(ui.state[0], true);
  await ui.button.props.onClick();
  assert.equal(calls.length, 1);
  finish(success);
  await first;
  assert.deepEqual(ui.state, [false, null]);
});

for (const [label, response, message] of [
  ['remote rejection', { ok: false, error: { message: 'permission denied' } }, 'permission denied'],
  ['unknown command', { ok: true, value: undefined }, 'command unavailable'],
  ['command error', { ok: true, value: { result: { kind: 'error', text: 'stale turn' } } }, 'stale turn'],
  ['missing response', undefined, 'recovery failed'],
]) test(`${label} reaches the button error state and releases busy state`, async () => {
  const ui = mount({ execute: positionalExecute(response, []) });
  await ui.button.props.onClick();
  assert.deepEqual(ui.state, [false, message]);
});

test('transport failure permits a later retry', async () => {
  let attempts = 0;
  const ui = mount({ execute: positionalExecute(() => {
    if (++attempts === 1) throw new Error('connection lost');
    return success;
  }, []) });
  await ui.button.props.onClick();
  assert.deepEqual(ui.state, [false, 'connection lost']);
  await ui.button.props.onClick();
  assert.deepEqual(ui.state, [false, null]);
  assert.equal(attempts, 2);
});

test('missing namespace produces an actionable error without accessing ctx.remote', async () => {
  const ui = mount();
  await ui.button.props.onClick();
  assert.deepEqual(ui.state, [false, 'command unavailable']);
});

test('running, completed and locked sessions do not submit', async () => {
  const execute = () => assert.fail('must not submit');
  assert.equal(mount({ execute, session: { running: true } }).tree, null);
  assert.equal(mount({ execute, view: { interrupted: false, turn: 7 } }).tree, null);
  const ui = mount({ execute, locked: true });
  assert.equal(ui.button.props.disabled, true);
  await ui.button.props.onClick();
  assert.deepEqual(ui.serviceReads, []);
});

test('settled request after unmount does not write component state', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const ui = mount({ execute: positionalExecute(() => pending, []) });
  const submitted = ui.button.props.onClick();
  ui.unmount();
  finish({ ok: false, error: { message: 'late failure' } });
  await submitted;
  assert.deepEqual(ui.state, [true, null]);
});
