'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';

export default function Page() {
  return (
    <Suspense>
      <Return />
    </Suspense>
  );
}
/** Возврат со страницы банка: сервер сам запрашивает статус заказа у шлюза (6.2.4). */
function Return() {
  const { t, tErr } = useApp();
  const orderId = useSearchParams().get('orderId');
  const router = useRouter();
  const [msg, setMsg] = useState(t('loading'));
  useEffect(() => {
    if (!orderId) return;
    api('/cards/bind/complete', { body: { orderId } })
      .then((c) => {
        setMsg('✓ ' + c.mask);
        setTimeout(() => router.push('/account?tab=cards'), 1200);
      })
      .catch((e) => setMsg(tErr(e)));
  }, [orderId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="card" style={{ maxWidth: 480, margin: '0 auto' }}>
      <h2>{t('tab_cards')}</h2>
      <p>{msg}</p>
    </div>
  );
}
