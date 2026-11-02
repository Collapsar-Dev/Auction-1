'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';

export default function Page() {
  return (
    <Suspense>
      <Kyc />
    </Suspense>
  );
}
/** Песочница KYC-сервиса (SC-02): тестировщик выбирает, что «вернёт» сервис. */
function Kyc() {
  const session = useSearchParams().get('session') || '';
  const router = useRouter();
  const { reloadMe } = useApp();
  const [f, setF] = useState({ fullName: '', birthDate: '1990-01-01', docNumber: 'AN' + Math.floor(1000000 + Math.random() * 8999999) });
  const [msg, setMsg] = useState('');
  const send = async (decision: string, reason?: string) => {
    try {
      const r = await api('/sandbox/kyc/complete', { body: { sessionId: session, decision, ...f, reason } });
      setMsg(JSON.stringify(r));
      await reloadMe();
      setTimeout(() => router.push('/account?tab=profile'), 1200);
    } catch (e: any) {
      setMsg(e.code);
    }
  };
  return (
    <div className="card stack" style={{ maxWidth: 480, margin: '0 auto', borderTop: '6px solid #6b3fa0' }}>
      <h2>🪪 Sandbox KYC</h2>
      <p className="dev-hint">Песочница сервиса проверки личности. Документ и селфи хранятся у KYC-сервиса; к нам приходит только итог (AU-07).</p>
      <label className="f">
        ФИО (латиницей, как в паспорте)
        <input className="input" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} placeholder="Narek Hovhannisyan" />
      </label>
      <label className="f">
        Дата рождения
        <input className="input" type="date" value={f.birthDate} onChange={(e) => setF({ ...f, birthDate: e.target.value })} />
      </label>
      <label className="f">
        Номер документа
        <input className="input" value={f.docNumber} onChange={(e) => setF({ ...f, docNumber: e.target.value })} />
      </label>
      <div className="row gap">
        <button className="btn primary" onClick={() => send('approved')}>
          Одобрить
        </button>
        <button className="btn" onClick={() => send('manual')}>
          На ручную проверку
        </button>
        <button className="btn danger" onClick={() => send('rejected', 'LIVENESS_FAILED')}>
          Отклонить
        </button>
      </div>
      <p className="small muted">Младше 18 → отказ. Документ, уже привязанный к другому аккаунту → отказ.</p>
      {msg && <pre className="body">{msg}</pre>}
    </div>
  );
}
