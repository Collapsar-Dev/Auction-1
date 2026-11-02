'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';

/**
 * Повторный SMS-код перед действием с деньгами и ставками (AU-03).
 * Использование: const token = await stepUp.run('bid') — открывает окно и ждёт ввода кода.
 */
export function useStepUp() {
  const [state, setState] = useState<{ action: string; resolve: (t: string | null) => void; devCode?: string } | null>(null);
  const run = async (action: string) => {
    const r = await api('/auth/step-up', { body: { action } });
    return new Promise<string | null>((resolve) => setState({ action, resolve, devCode: r.devCode }));
  };
  const node = state ? <StepUpDialog {...state} onClose={() => setState(null)} /> : null;
  return { run, node };
}

function StepUpDialog({ action, resolve, devCode, onClose }: { action: string; resolve: (t: string | null) => void; devCode?: string; onClose: () => void }) {
  const { t, tErr } = useApp();
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api('/auth/step-up', { body: { action, code } });
      resolve(r.stepUpToken);
      onClose();
    } catch (e) {
      setErr(tErr(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-bg">
      <div className="modal">
        <h3>
          {t('stepup_title')} · {t('act_' + action)}
        </h3>
        <p className="muted">{t('stepup_text')}</p>
        {devCode && (
          <p className="dev-hint">
            {t('dev_code')}: <b>{devCode}</b>
          </p>
        )}
        <input className="input big" inputMode="numeric" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && submit()} placeholder="••••••" />
        {err && <p className="error">{err}</p>}
        <div className="row gap">
          <button className="btn primary" disabled={code.length !== 6 || busy} onClick={submit}>
            {t('confirm')}
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              resolve(null);
              onClose();
            }}
          >
            {t('cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
