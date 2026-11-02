'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { fmtAmd } from '@/lib/format';

export default function Page() {
  return (
    <Suspense>
      <Bank />
    </Suspense>
  );
}
/** Песочница платёжной страницы банка (фейковый ArCa). Номер карты вводится только здесь. */
function Bank() {
  const orderId = useSearchParams().get('orderId') || '';
  const [o, setO] = useState<any>(null);
  const [pan, setPan] = useState('4111 1111 1111 1111');
  const [holder, setHolder] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    api('/sandbox/bank/' + orderId).then(setO).catch((e) => setErr(e.code));
  }, [orderId]);
  const pay = async (pass3ds: boolean) => {
    try {
      const r = await api('/sandbox/bank/' + orderId, { body: { pan, holderName: holder || undefined, pass3ds } });
      window.location.href = r.returnUrl;
    } catch (e: any) {
      setErr(e.code);
    }
  };
  return (
    <div className="card stack" style={{ maxWidth: 440, margin: '0 auto', borderTop: '6px solid #1d4f91' }}>
      <h2>🏦 Sandbox Bank · ArCa</h2>
      <p className="dev-hint">Это песочница банка для разработки (P-1). В бою здесь будет страница банка-эквайера.</p>
      {o && (
        <div className="small muted">
          Заказ {o.orderId.slice(0, 18)}… · проверочная сумма {fmtAmd(o.amount)} (отменяется сразу)
        </div>
      )}
      <label className="f">
        Номер карты
        <input className="input" value={pan} onChange={(e) => setPan(e.target.value)} />
      </label>
      <label className="f">
        Имя держателя (необязательно; сверяется с ФИО)
        <input className="input" placeholder="ARAM PETROSYAN" value={holder} onChange={(e) => setHolder(e.target.value)} />
      </label>
      <div className="small muted">
        Тестовые карты: 4111 1111 1111 1111 — всё проходит · 4000 0000 0000 0002 — отказ блокировок · 4000 0000 0000 0069 — отказ списаний
      </div>
      <div className="row gap">
        <button className="btn primary" onClick={() => pay(true)}>
          Оплатить (3-D Secure ✓)
        </button>
        <button className="btn danger" onClick={() => pay(false)}>
          Провалить 3-D Secure
        </button>
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}
