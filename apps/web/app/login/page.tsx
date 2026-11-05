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
  // PRD v2 решение 1: по умолчанию — email или телефон + пароль; SMS-вход остаётся
  const [mode, setMode] = useState<'password' | 'register' | 'forgot' | 'sms'>('password');

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

  const done = async (r: any) => {
    await reloadMe();
    if (r?.needsConsents?.length) setConsents(r.needsConsents);
    else router.push(next);
  };
  const tabs = (
    <div className="tabs">
      {(['password', 'register', 'sms'] as const).map((m) => (
        <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
          {t('auth_tab_' + m)}
        </button>
      ))}
    </div>
  );
  if (mode === 'password')
    return (
      <div className="card stack" style={{ maxWidth: 420, margin: '0 auto' }}>
        {tabs}
        <PasswordLogin onDone={done} onForgot={() => setMode('forgot')} />
      </div>
    );
  if (mode === 'register')
    return (
      <div className="card stack" style={{ maxWidth: 420, margin: '0 auto' }}>
        {tabs}
        <Register onDone={done} />
      </div>
    );
  if (mode === 'forgot')
    return (
      <div className="card stack" style={{ maxWidth: 420, margin: '0 auto' }}>
        {tabs}
        <Forgot onBack={() => setMode('password')} />
      </div>
    );

  return (
    <div className="card stack" style={{ maxWidth: 420, margin: '0 auto' }}>
      {tabs}
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

/** Вход: email или телефон + пароль (PRD v2, F1.1). */
function PasswordLogin({ onDone, onForgot }: { onDone: (r: any) => void; onForgot: () => void }) {
  const { t, tErr } = useApp();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setErr('');
    setBusy(true);
    try {
      onDone(await api('/auth/login', { body: { login, password } }));
    } catch (e) {
      setErr(tErr(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h2>{t('login_pw_title')}</h2>
      <label className="f">
        {t('email_or_phone')}
        <input className="input big" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoFocus />
      </label>
      <label className="f">
        {t('password')}
        <input className="input big" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" onKeyDown={(e) => e.key === 'Enter' && go()} />
      </label>
      {err && <p className="error">{err}</p>}
      <button className="btn primary" disabled={busy || !login || !password} onClick={go}>
        {t('enter')}
      </button>
      <button className="btn ghost" onClick={onForgot}>
        {t('forgot_password')}
      </button>
    </>
  );
}

/** Регистрация: email или телефон + пароль → код подтверждения (F1.1 → F1.3). */
function Register({ onDone }: { onDone: (r: any) => void }) {
  const { t, tErr, lang } = useApp();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [agree, setAgree] = useState(false);
  const [sent, setSent] = useState<any>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const register = async () => {
    setErr('');
    try {
      setSent(await api('/auth/register', { body: { login, password, lang, acceptTerms: agree } }));
    } catch (e) {
      setErr(tErr(e));
    }
  };
  const confirm = async () => {
    setErr('');
    try {
      onDone(await api('/auth/register/confirm', { body: { login, code } }));
    } catch (e) {
      setErr(tErr(e));
    }
  };
  const resend = async () => {
    setErr('');
    try {
      const r = await api('/auth/register/resend', { body: { login } });
      setSent({ ...sent, ...r });
    } catch (e) {
      setErr(tErr(e));
    }
  };
  if (sent)
    return (
      <>
        <h2>{t('confirm_title')}</h2>
        <p className="small">{t(sent.channel === 'email' ? 'confirm_sent_email' : 'confirm_sent_sms', { to: login })}</p>
        {sent.devCode && (
          <p className="dev-hint">
            {t('dev_code')}: <b>{sent.devCode}</b>
          </p>
        )}
        <label className="f">
          {t('code')}
          <input className="input big" inputMode="numeric" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && confirm()} />
        </label>
        {err && <p className="error">{err}</p>}
        <button className="btn primary" disabled={code.length !== 6} onClick={confirm}>
          {t('confirm')}
        </button>
        <button className="btn ghost" onClick={resend}>
          {t('resend_code')}
        </button>
      </>
    );
  return (
    <>
      <h2>{t('register_title')}</h2>
      <label className="f">
        {t('email_or_phone')}
        <input className="input big" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoFocus />
      </label>
      <label className="f">
        {t('password')}
        <input className="input big" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        <span className="small muted">{t('password_rule')}</span>
      </label>
      <label className="check small">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>
          <Link href="/rules#terms" target="_blank">
            {t('consent_terms')}
          </Link>{' '}
          ·{' '}
          <Link href="/rules#privacy" target="_blank">
            {t('consent_privacy')}
          </Link>
        </span>
      </label>
      {err && <p className="error">{err}</p>}
      <button className="btn primary" disabled={!login || !password || !agree} onClick={register}>
        {t('register_btn')}
      </button>
      <p className="small muted">{t('register_note')}</p>
    </>
  );
}

/** «Забыли пароль» (F1.2): ответ всегда одинаковый. */
function Forgot({ onBack }: { onBack: () => void }) {
  const { t, tErr } = useApp();
  const [login, setLogin] = useState('');
  const [sent, setSent] = useState<any>(null);
  const [err, setErr] = useState('');
  const go = async () => {
    setErr('');
    try {
      setSent(await api('/auth/password/forgot', { body: { login } }));
    } catch (e) {
      setErr(tErr(e));
    }
  };
  return (
    <>
      <h2>{t('forgot_password')}</h2>
      {sent ? (
        <>
          <div className="notice ok">{t('forgot_sent', { minutes: sent.ttlMin })}</div>
          {sent.devToken && (
            <p className="dev-hint">
              Dev: <Link href={`/reset-password?token=${sent.devToken}`}>{t('reset_link')}</Link>
            </p>
          )}
        </>
      ) : (
        <>
          <label className="f">
            {t('email_or_phone')}
            <input className="input big" value={login} onChange={(e) => setLogin(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && go()} />
          </label>
          {err && <p className="error">{err}</p>}
          <button className="btn primary" disabled={!login} onClick={go}>
            {t('send_link')}
          </button>
        </>
      )}
      <button className="btn ghost" onClick={onBack}>
        ← {t('login_pw_title')}
      </button>
    </>
  );
}
