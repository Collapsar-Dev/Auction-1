'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <Reset />
    </Suspense>
  );
}

/** F1.2 шаг 3: новый пароль по одноразовой ссылке; после — все другие сессии завершены. */
function Reset() {
  const { t, tErr } = useApp();
  const token = useSearchParams().get('token') || '';
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setErr('');
    if (p1 !== p2) return setErr(t('passwords_differ'));
    try {
      await api('/auth/password/reset', { body: { token, password: p1 } });
      setOk(true);
    } catch (e) {
      setErr(tErr(e));
    }
  };
  return (
    <div className="card stack" style={{ maxWidth: 420, margin: '0 auto' }}>
      <h2>{t('new_password')}</h2>
      {ok ? (
        <>
          <div className="notice ok">{t('password_changed')}</div>
          <Link className="btn primary" href="/login">
            {t('login_title')}
          </Link>
        </>
      ) : (
        <>
          <input className="input big" type="password" placeholder={t('password')} value={p1} onChange={(e) => setP1(e.target.value)} autoComplete="new-password" autoFocus />
          <input className="input big" type="password" placeholder={t('password_repeat')} value={p2} onChange={(e) => setP2(e.target.value)} autoComplete="new-password" onKeyDown={(e) => e.key === 'Enter' && go()} />
          <span className="small muted">{t('password_rule')}</span>
          {err && <p className="error">{err}</p>}
          <button className="btn primary" disabled={!p1 || !p2} onClick={go}>
            {t('save')}
          </button>
        </>
      )}
    </div>
  );
}
