window.__ModuleLoader__.load({
  id: '@local/continue-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const dictionaries = {
      en: { label: 'Continue / retry', busy: 'Submitting recovery…', failed: 'Could not continue', unavailable: 'The Continue command is unavailable.', close: 'Dismiss', hint: 'Continue the interrupted conversation. Provider charges may apply.' },
      zh: { label: '继续 / 重试', busy: '正在提交恢复请求…', failed: '无法继续', unavailable: 'Continue 命令暂不可用。', close: '关闭提示', hint: '接续被中断的对话，可能产生模型服务费用。' },
    };
    const css = `
.continue-control{position:relative;display:flex;align-items:center;flex:none}
.continue-button{box-sizing:border-box;corner-shape:round;background:var(--dsw-alias-button-info-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-toast-label);cursor:pointer;border:none;border-radius:999px;flex:none;place-items:center;width:34px;height:34px;min-width:34px;padding:0;transition:background-color .1s;display:grid;transform:translateY(-2px)}
.continue-button:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,var(--dsw-alias-brand-primary))}
.continue-button:disabled{opacity:.4;cursor:default}
.continue-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.continue-tooltip{display:none;position:absolute;bottom:calc(100% + 9px);right:0;z-index:30;width:max-content;max-width:240px;box-sizing:border-box;border-radius:6px;padding:6px 9px;font-size:12px;line-height:18px;background:var(--dsw-alias-tooltip-bg,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-toast-label);pointer-events:none}
.continue-control:hover .continue-tooltip,.continue-control:focus-within .continue-tooltip{display:block}
.continue-toast{position:absolute;bottom:calc(100% + 10px);right:0;z-index:31;width:280px;max-width:70vw;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.continue-toast button{float:right;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0 0 4px 8px;font:inherit}
`;
    // Client methods take positional arguments; the Remote proxy builds the RPC object.
    async function submitRecovery(commands, sessionId, expectedTurn, t) {
      if (!commands || typeof commands.execute !== 'function') throw new Error(t('unavailable'));
      const line = '/continue-session ' + JSON.stringify({ expectedTurn });
      const response = await commands.execute(sessionId, line, []);
      if (!response || response.ok !== true) throw new Error(response?.error?.message ?? t('failed'));
      if (!response.value) throw new Error(t('unavailable'));
      if (response.value.result?.kind === 'error') throw new Error(response.value.result.text ?? t('failed'));
      return response.value;
    }
    return {
      submitRecovery,
      inject: ['slots', 'locale'],
      apply(ctx) {
        for (const [language, dictionary] of Object.entries(dictionaries)) ctx.effect(() => ctx.locale.register('local-continue', language, dictionary));
        function ContinueButton({ sessionId, useProjection, useSession, locked, t }) {
          const view = useProjection('continue-availability');
          const running = useSession(s => s.running) ?? false;
          const removed = useSession(s => s.removed) ?? false;
          const subagent = useSession(s => s.subagent) ?? null;
          const open = useSession(s => s.openState) === 'open';
          const [busy, setBusy] = React.useState(false);
          const [error, setError] = React.useState(null);
          const inFlight = React.useRef(false);
          const mounted = React.useRef(false);
          const tooltipId = React.useId();
          React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
          React.useEffect(() => { setError(null); }, [sessionId, view?.turn]);
          async function recover() {
            if (inFlight.current || running || locked) return;
            inFlight.current = true;
            setBusy(true);
            setError(null);
            try {
              await submitRecovery(ctx.get('remote.commands'), sessionId, view.turn, t);
            } catch (cause) {
              if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              inFlight.current = false;
              if (mounted.current) setBusy(false);
            }
          }
          if (removed || subagent || !open || running || !view?.interrupted) return null;
          return h('span', { className: 'continue-control' },
            h('style', null, css),
            h('button', { type: 'button', className: 'continue-button', disabled: locked || busy, 'aria-label': t(busy ? 'busy' : 'label'), 'aria-describedby': tooltipId, 'aria-busy': busy, onMouseDown: event => event.preventDefault(), onClick: recover },
              h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
                h('path', { d: 'M3 2.5L10 8L3 13.5Z', fill: 'currentColor' }),
                h('path', { d: 'M12 2.5V13.5', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }))),
            h('span', { id: tooltipId, role: 'tooltip', className: 'continue-tooltip' }, t(busy ? 'busy' : 'hint')),
            error && h('span', { role: 'alert', className: 'continue-toast' },
              h('button', { type: 'button', 'aria-label': t('close'), onClick: () => setError(null) }, '×'),
              h('strong', null, t('failed')), h('br'), error));
        }
        ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({ name: 'conversation.input.activity', id: 'local-continue-button', order: 5, locale: 'local-continue' }, ContinueButton));
      },
    };
  },
});
