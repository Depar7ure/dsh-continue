import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, fold, ContinueOperation, registerCallers } from '../core.js';
const event = (type, data) => ({ type, data, time: 100, seq: 0 });
const start = state => fold(state, event('turn/start', { turn: 1 }));
const end = (state, reason) => fold(state, event('turn/end', { turn: 1, reason }));
const user = { id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'original task' }, { type: 'image', attachment: { attachmentId: 'img' } }] };
function fixture(reason = { kind: 'aborted', reason: { kind: 'user' } }) {
  let state = end(fold(start(initialState()), event('user/message', user)), reason);
  const sent = [];
  const agent = { id: 's1', status: 'idle', session: { header: {} }, inbox: { nextTurn: [], nextStep: [] }, followup(message) { sent.push(message); this.status = 'running'; } };
  const operation = new ContinueOperation({ resolveAgent: async () => ({ agent }), stateOf: () => state, createMessage: message => ({ id: 'new-id', role: 'user', ...message }) });
  return { operation, agent, sent, setState: value => { state = value; }, getState: () => state };
}
for (const [reason, expected] of [
  [{ kind: 'aborted', reason: { kind: 'user' } }, 'paused'],
  [{ kind: 'aborted', reason: { kind: 'disposed' } }, 'crash'],
  [{ kind: 'interrupted' }, 'crash'],
  [{ kind: 'error', error: { code: 'TIMEOUT' } }, 'timeout'],
  [{ kind: 'error', error: { code: 'LLM_STREAM_IDLE_TIMEOUT' } }, 'timeout'],
  [{ kind: 'error', error: { code: 'TRANSPORT' } }, 'network'],
  [{ kind: 'error', error: { code: 'SERVER' } }, 'error'],
  [{ kind: 'max-tokens' }, 'length'],
  [{ kind: 'completed' }, null],
  [{ kind: 'forked' }, null],
  [{ kind: 'blocked' }, null],
  [{ kind: 'aborted', reason: { kind: 'parent' } }, null],
  [{ kind: 'aborted', reason: { kind: 'hook', reason: 'policy' } }, null],
]) test(`classify ${JSON.stringify(reason)}`, () => {
  const state = end(start(initialState()), reason);
  assert.equal(state.view.reason, expected);
  assert.equal(state.view.interrupted, expected !== null);
  assert.equal(state.view.open, false);
});
test('cold unclosed turn is recoverable; retry notices never mark normal completion interrupted', () => {
  const state = start(initialState());
  assert.equal(state.view.open, true);
  assert.equal(state.view.interrupted, true);
  assert.equal(fold(state, event('llm/retry', { code: 'TIMEOUT' })), state);
  assert.equal(end(state, { kind: 'completed' }).view.interrupted, false);
});
test('irrelevant events preserve state and private updates preserve wire reference', () => {
  const state = initialState();
  assert.equal(fold(state, event('tool/result', {})), state);
  const next = fold(state, event('user/message', user));
  assert.equal(next.view, state.view);
  assert.equal(state.lastUser, null);
});
test('default continue submits exactly one plugin message and rejects next click', async () => {
  const f = fixture();
  assert.equal((await f.operation.continueSession({ sessionId: 's1' })).action, 'continue');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].source.kind, 'plugin');
  assert.equal((await f.operation.continueSession({ sessionId: 's1' })).code, 'busy');
});
test('retry copies original multimodal input without reusing message identity', async () => {
  const f = fixture();
  assert.equal((await f.operation.continueSession({ sessionId: 's1', action: 'retry' })).ok, true);
  assert.deepEqual(f.sent[0].content, user.content);
  assert.notEqual(f.sent[0].content, user.content);
  assert.notEqual(f.sent[0].id, user.id);
});
test('auto retries transport errors', async () => {
  const f = fixture({ kind: 'error', error: { code: 'TRANSPORT' } });
  assert.equal((await f.operation.continueSession({ sessionId: 's1', action: 'auto' })).action, 'retry');
});
test('normal completion, stale turn, pending input and subagents do not send', async () => {
  const f = fixture({ kind: 'completed' });
  assert.equal((await f.operation.continueSession({ sessionId: 's1' })).code, 'not-interrupted');
  f.setState(start(initialState()));
  assert.equal((await f.operation.continueSession({ sessionId: 's1', expectedTurn: 2 })).code, 'stale');
  f.agent.inbox.nextTurn.push(user);
  assert.equal((await f.operation.continueSession({ sessionId: 's1' })).code, 'queued');
  f.agent.session.header.origin = 'subagent';
  assert.equal((await f.operation.continueSession({ sessionId: 's1' })).code, 'subagent');
  assert.equal(f.sent.length, 0);
});
test('claimed input interrupted before admission is restored in continue mode', async () => {
  let state = fold(initialState(), event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [user] }));
  state = start(state);
  state = fold(state, event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }));
  state = end(state, { kind: 'aborted', reason: { kind: 'user' } });
  assert.equal(state.admitted, false);
  const f = fixture(); f.setState(state);
  assert.equal((await f.operation.continueSession({ sessionId: 's1' })).action, 'retry');
  assert.deepEqual(f.sent[0].content, user.content);
});
test('cancelled queued input is not mistaken for a claimed prompt', () => {
  let state = fold(initialState(), event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [user] }));
  state = fold(state, event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }));
  assert.equal(state.lastUser, null);
});
test('cold resolution concurrency and errors release the lock', async () => {
  const f = fixture(); let finish;
  f.operation.resolveAgent = () => new Promise(resolve => { finish = resolve; });
  const first = f.operation.continueSession({ sessionId: 's1' });
  assert.equal((await f.operation.continueSession({ sessionId: 's1' })).code, 'busy');
  finish({ error: { code: 'writer-held', message: 'owned elsewhere' } });
  assert.equal((await first).code, 'writer-held');
  assert.equal(f.operation.pending.size, 0);
});
test('abort and followup failures are explicit, allow later retry', async () => {
  const f = fixture();
  assert.equal((await f.operation.continueSession({ sessionId: 's1' }, AbortSignal.abort())).code, 'cancelled');
  f.agent.followup = () => { throw new Error('write failed'); };
  assert.equal((await f.operation.continueSession({ sessionId: 's1' })).message, 'write failed');
  assert.equal(f.operation.pending.size, 0);
});
test('command and tool invoke same service and return equivalent outcomes', async () => {
  const run = async caller => {
    const f = fixture(); let command, tool;
    registerCallers({ commands: { register: value => { command = value; } }, tools: { register: value => { tool = value; } } }, f.operation);
    const result = caller === 'tool' ? await tool.execute({ sessionId: 's1', action: 'retry', expectedTurn: 1 }, {}) : await command.handler({ agent: f.agent, rawInput: '{"action":"retry","expectedTurn":1}' });
    return { f, result };
  };
  const command = await run('command'), tool = await run('tool');
  assert.equal(command.result.kind, 'success');
  assert.equal(tool.result.ok, true);
  assert.equal(command.result.text, tool.result.message);
  assert.deepEqual(command.f.sent, tool.f.sent);
});
