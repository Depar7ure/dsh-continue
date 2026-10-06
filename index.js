import { Service } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { z } from 'zod';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { KEY, DEFAULT_PROMPT, initialState, fold, ContinueOperation, registerCallers } from './core.js';

const viewSchema = z.object({ interrupted: z.boolean(), open: z.boolean(), reason: z.string().nullable(), turn: z.number(), time: z.number() });
const stateSchema = z.object({ view: viewSchema, lastUser: z.unknown().nullable(), admitted: z.boolean(), pending: z.object({ 'next-turn': z.array(z.unknown()), 'next-step': z.array(z.unknown()) }) });
export default class ContinueService extends Service {
  static inject = ['sessionProjections', 'sessionController', 'commands', 'tools'];
  static Config = Schema.object({
    strategy: Schema.union([Schema.const('continue'), Schema.const('retry'), Schema.const('auto')]).default('continue'),
    continuePrompt: Schema.string().min(1).default(DEFAULT_PROMPT),
  });
  constructor(ctx, config) {
    super(ctx, 'continueRecovery');
    ctx.sessionProjections.register({ key: KEY, stateSchema, stateVersion: 1, init: initialState, apply: fold, wire: { viewSchema, view: state => state.view } });
    this.operation = new ContinueOperation({
      resolveAgent: id => ctx.sessionController.resolveAgent(id),
      stateOf: session => ctx.sessionProjections.stateOf(session, KEY),
      createMessage: createUserMessage,
      config,
    });
    registerCallers(ctx, this);
  }
  continueSession(request, signal) { return this.operation.continueSession(request, signal); }
}
