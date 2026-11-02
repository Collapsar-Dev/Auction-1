'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

/** SC-01: телефон +374 → 6-значный код; новому пользователю — соглашение и политика данных. */
function Login() {
  const { t, tErr, lang, reloadMe, me } = useApp();
  const router = useRouter();
  const next = useSearchParams().get('next') || '/';
  const [phone, setPhone] = useState('+374 ');
  const [sent, setSent] = useState<any>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [left, setLeft] = useState(0);
  const [consents, setConsents] = useState<string[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (me && !me.staff && me.needsConsents.length) setConsents(me.needsConsents);
  }, [me]);
  useEffect(() => {
    if (left <= 0) return;
    const id = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(id);
  }, [left]);

  const send = async () => {
    setErr('');
    try {
      const r = await api('/auth/otp', { body: { phone } });
      setSent(r);
      setLeft(r.resendInSec);
    } catch (e) {
      setErr(tErr(e));
    }
  };
  const verify = async () => {
    setErr('');
    try {
      const r = await api('/auth/verify', { body: { phone, code, lang } });
      if (r.needsConsents.length) {
        setConsents(r.needsConsents);
        await reloadMe();
        return;
      }
      await reloadMe();
      router.push(next);
    } catch (e) {
      setErr(tErr(e));
    }
  };
  const accept = async () => {
    try {
      await api('/me/consents', { body: { kinds: consents } });
      await reloadMe();
      router.push(next);
    } catch (e) {
      setErr(tErr(e));
    }
  };

  if (consents.length)
    return (
      <div className="card stack" style={{ maxWidth: 520, margin: '0 auto' }}>
        <h2>{t('consents_title')}</h2>
        <p>{t('consents_text')}</p>
        {consents.map((k) => (
          <label key={k} className="check">
            <input type="checkbox" checked={!!checked[k]} onChange={(e) => setChecked({ ...checked, [k]: e.target.checked })} />
            <Link href={`/rules#${k}`} target="_blank">
              {t('consent_' + k)}
            </Link>
          </label>
        ))}
        <button className="btn primary" disabled={!consents.every((k) => checked[k])} onClick={accept}>
          {t('accept')}
        </button>
        {err && <p className="error">{err}</p>}
      </div>
    );

  return (
    <div className="card stack" style={{ maxWidth: 420, margin: '0 auto' }}>
      <h2>{t('login_title')}</h2>
      {!sent ? (
        <>
          <label className="f">
            {t('phone')}
            <input className="input big" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} autoFocus />
          </label>
          <button className="btn primary" onClick={send}>
            {t('get_code')}
          </button>
          <p className="small muted">Demo: +374 91 000001 … +374 91 000011</p>
        </>
      ) : (
        <>
          <div className="muted">{sent.phone}</div>
          {sent.devCode && (
            <p className="dev-hint">
              {t('dev_code')}: <b>{sent.devCode}</b>
            </p>
          )}
          <label className="f">
            {t('code')}
            <input className="input big" inputMode="numeric" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && verify()} />
          </label>
          <button className="btn primary" disabled={code.length !== 6} onClick={verify}>
            {t('enter')}
          </button>
          <div className="row gap between small">
            {left > 0 ? (
              <span className="muted">{t('resend_in', { s: left })}</span>
            ) : (
              <button className="btn sm ghost" onClick={send}>
                {t('resend')}
              </button>
            )}
            <button
              className="btn sm ghost"
              onClick={() => {
                setSent(null);
                setCode('');
              }}
            >
              {t('change_number')}
            </button>
          </div>
        </>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
