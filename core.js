/** Pure log fold and shared operation. No runtime imports: independently testable. */
export const KEY = 'continue-availability';
export const DEFAULT_PROMPT = '继续完成刚才被中断的任务，从已有进度接续，避免重复已完成的内容；对结果不明的操作先核实状态。';
export function initialState() {
  return { view: { interrupted: false, open: false, reason: null, turn: 0, time: 0 }, lastUser: null, admitted: true, pending: { 'next-turn': [], 'next-step': [] } };
}
function classify(reason) {
  if (reason.kind === 'aborted') return reason.reason?.kind === 'user' || reason.reason?.kind === 'legacy' ? 'paused' : reason.reason?.kind === 'disposed' ? 'crash' : null;
  if (reason.kind === 'interrupted') return 'crash';
  if (reason.kind === 'max-tokens') return 'length';
  if (reason.kind !== 'error') return null;
  const code = reason.error?.code ?? '';
  if (/TIMEOUT|TIMED_OUT/.test(code)) return 'timeout';
  if (/TRANSPORT|NETWORK|CONNECTION|ECONN/.test(code)) return 'network';
  return 'error';
}
export function fold(state, event) {
  const data = event.data;
  switch (event.type) {
    case 'agent/inbox/spliced': {
      const old = state.pending[data.target];
      if (!old) return state;
      const removed = old.slice(data.start, data.start + (data.removedCount ?? 0));
      const next = old.slice();
      next.splice(data.start, data.removedCount ?? 0, ...data.inserted);
      const claimed = data.outcome === 'canceled' ? undefined : removed.filter(m => m.source?.kind === 'user').at(-1);
      return { ...state, pending: { ...state.pending, [data.target]: next }, ...(claimed ? { lastUser: claimed, admitted: false } : {}) };
    }
    case 'user/message':
      if (data.source?.kind !== 'user') return state;
      return { ...state, lastUser: data, admitted: true };
    case 'turn/start':
      return { ...state, view: { interrupted: true, open: true, reason: 'crash', turn: data.turn, time: event.time } };
    case 'turn/end': {
      const reason = classify(data.reason);
      return { ...state, view: { interrupted: reason !== null, open: false, reason, turn: data.turn, time: event.time } };
    }
    default: return state;
  }
}
const failure = (code, message) => ({ ok: false, code, message });

/** One method used by both command and tool; dependencies are public Host services. */
export class ContinueOperation {
  constructor({ resolveAgent, stateOf, createMessage, config = {} }) {
    this.resolveAgent = resolveAgent;
    this.stateOf = stateOf;
    this.createMessage = createMessage;
    this.config = { strategy: 'continue', continuePrompt: DEFAULT_PROMPT, ...config };
    this.pending = new Set();
  }
  async continueSession({ sessionId, action = this.config.strategy, expectedTurn }, signal) {
    if (typeof sessionId !== 'string' || !sessionId || !['continue', 'retry', 'auto'].includes(action) || (expectedTurn !== undefined && (!Number.isSafeInteger(expectedTurn) || expectedTurn < 1))) return failure('invalid-request', '无效的会话、策略或轮次 / Invalid session, action or turn.');
    if (this.pending.has(sessionId)) return failure('busy', '恢复正在提交 / Recovery is already being submitted.');
    this.pending.add(sessionId);
    try {
      if (signal?.aborted) return failure('cancelled', '操作已取消 / Request cancelled.');
      const resolved = await this.resolveAgent(sessionId);
      if (resolved.error) return failure(resolved.error.code ?? 'resume-failed', resolved.error.message);
      const agent = resolved.agent;
      if (signal?.aborted) return failure('cancelled', '操作已取消 / Request cancelled.');
      if (agent.session.header.origin === 'subagent') return failure('subagent', '请由父会话接续子代理 / Continue this agent from its parent session.');
      if (agent.status !== 'idle') return failure('busy', '会话仍在运行 / The session is still running.');
      const state = this.stateOf(agent.session);
      if (!state) return failure('unavailable', '恢复状态尚未加载 / Recovery state is unavailable.');
      if (!state.view.interrupted) return failure('not-interrupted', '当前没有被中断的轮次 / No interrupted turn.');
      if (expectedTurn !== undefined && state.view.turn !== expectedTurn) return failure('stale', '会话已有更新，请重试 / The session has changed; try again.');
      if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) return failure('queued', '会话已有待处理输入 / The session already has pending input.');
      const selected = action === 'auto' ? (['network', 'timeout'].includes(state.view.reason) ? 'retry' : 'continue') : action;
      // A prompt claimed but never committed must be restored even in continue mode.
      const replay = selected === 'retry' || !state.admitted;
      if (replay && !state.lastUser) return failure('no-user-input', '没有可重试的用户输入 / No user input is available to retry.');
      const content = replay ? structuredClone(state.lastUser.content) : [{ type: 'text', text: this.config.continuePrompt }];
      if (!content?.length) return failure('no-user-input', '用户输入为空 / User input is empty.');
      agent.followup(this.createMessage({ content, source: { kind: 'plugin:@local/continue-plugin' } }));
      return { ok: true, action: replay ? 'retry' : 'continue', turn: state.view.turn, message: '已提交恢复请求 / Recovery submitted.' };
    } catch (error) {
      return failure('recovery-failed', error instanceof Error ? error.message : String(error));
    } finally {
      this.pending.delete(sessionId);
    }
  }
}
export function registerCallers(ctx, operation) {
  ctx.commands.register({
    name: 'continue-session',
    description: 'Continue or retry an interrupted conversation / 接续或重试中断对话',
    input: { hint: '[continue|retry|auto]' },
    handler: async invocation => {
      const raw = invocation.rawInput.trim();
      let request;
      try { request = raw.startsWith('{') ? JSON.parse(raw) : { ...(raw ? { action: raw } : {}) }; }
      catch { return { kind: 'error', text: '无效参数 / Invalid parameters.' }; }
      const result = await operation.continueSession({ action: request.action, expectedTurn: request.expectedTurn, sessionId: invocation.agent.id }, invocation.signal);
      return { kind: result.ok ? 'success' : 'error', text: result.message };
    },
  });
  ctx.tools.register({
    name: 'continue_session',
    description: 'Manually continue or retry an interrupted ordinary session after explicit user intent. retry resubmits its last user input as a new turn and may incur provider charges. Never call this on the currently running session; it returns busy. Uses the same operation as the Continue button.',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' }, action: { type: 'string', enum: ['continue', 'retry', 'auto'] }, expectedTurn: { type: 'integer', minimum: 1 } }, required: ['sessionId'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, code: { type: 'string' }, message: { type: 'string' }, action: { type: 'string' }, turn: { type: 'integer' } }, required: ['ok', 'message'] }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args, exec) => operation.continueSession(args, exec.signal),
  });
}
