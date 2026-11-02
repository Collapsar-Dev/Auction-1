'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';

export default function Sell() {
  const { t, tErr, me, meLoaded } = useApp();
  const router = useRouter();
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!meLoaded) return;
    if (!me) return router.push('/login?next=/sell');
    api('/lots', { method: 'POST' })
      .then((r) => router.replace(`/sell/${r.id}`))
      .catch((e) => setErr(tErr(e)));
  }, [meLoaded, me]); // eslint-disable-line react-hooks/exhaustive-deps
  return err ? (
    <div className="notice warn">
      {err} — <a href="/account?tab=profile">{t('nav_account')}</a>
    </div>
  ) : (
    <p className="muted">{t('loading')}</p>
  );
}
