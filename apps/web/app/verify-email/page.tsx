'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';

export default function Page() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
function Verify() {
  const { t, tErr, reloadMe } = useApp();
  const token = useSearchParams().get('token');
  const [msg, setMsg] = useState(t('loading'));
  useEffect(() => {
    if (!token) return;
    api('/me/verify-email', { body: { token } })
      .then(() => {
        setMsg('✓ ' + t('email_verified'));
        reloadMe();
      })
      .catch((e) => setMsg(tErr(e)));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="card stack" style={{ maxWidth: 480, margin: '0 auto' }}>
      <h2>{t('email')}</h2>
      <p>{msg}</p>
      <Link href="/account">{t('nav_account')} →</Link>
    </div>
  );
}
