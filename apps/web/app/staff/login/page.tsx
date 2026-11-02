'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';

/** AU-05: сотрудники входят по паролю + коду из приложения-аутентификатора (TOTP). */
export default function StaffLogin() {
  const { tErr, reloadMe, devTools } = useApp();
  const router = useRouter();
  const [f, setF] = useState({ username: '', password: '', code: '' });
  const [err, setErr] = useState('');
  const submit = async () => {
    setErr('');
    try {
      await api('/auth/staff/login', { body: f });
      await reloadMe();
      router.push('/admin');
    } catch (e) {
      setErr(tErr(e));
    }
  };
  return (
    <div className="card stack" style={{ maxWidth: 400, margin: '0 auto' }}>
      <h2>Вход для сотрудников</h2>
      <input className="input" placeholder="Логин" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
      <input className="input" type="password" placeholder="Пароль" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      <input className="input" inputMode="numeric" maxLength={6} placeholder="Код TOTP" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, '') })} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <button className="btn primary" onClick={submit}>
        Войти
      </button>
      {devTools && (
        <p className="dev-hint">
          Dev: admin / Admin123! или moderator / Moder123!; текущий TOTP — на странице <a href="/dev">/dev</a>
        </p>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
