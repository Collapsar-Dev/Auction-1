'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/ctx';
import { api } from '@/lib/api';
import { Lang } from '@/lib/format';

export function Header() {
  const { t, lang, setLang, me, reloadMe, devTools } = useApp();
  const router = useRouter();
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    await reloadMe();
    router.push('/');
  };
  return (
    <header className="top">
      <div className="container bar">
        <Link href="/" className="logo">
          {t('brand').split('·')[0]}
          <span>·{t('brand').split('·')[1]}</span>
        </Link>
        <nav className="main">
          <Link href="/">{t('nav_catalog')}</Link>
          {!me?.staff && <Link href="/sell">{t('nav_sell')}</Link>}
          <Link href="/rules">{t('nav_rules')}</Link>
          {me?.staff && <Link href="/admin">{t('nav_admin')}</Link>}
          {devTools && <Link href="/dev">{t('nav_dev')}</Link>}
        </nav>
        <div className="langs">
          {(['hy', 'ru', 'en'] as Lang[]).map((l) => (
            <button key={l} className={lang === l ? 'on' : ''} onClick={() => setLang(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
        {me ? (
          <div className="row gap-s">
            {!me.staff && (
              <Link className="btn sm" href="/account">
                {t('nav_account')}
              </Link>
            )}
            <button className="btn sm ghost" onClick={logout}>
              {t('nav_logout')}
            </button>
          </div>
        ) : (
          <Link className="btn sm primary" href="/login">
            {t('nav_login')}
          </Link>
        )}
      </div>
    </header>
  );
}

export function Footer() {
  const { t } = useApp();
  return (
    <footer className="bottom">
      <div className="container">
        <div className="links">
          <Link href="/rules">{t('nav_rules')}</Link>
          <Link href="/rules#terms">{t('footer_terms')}</Link>
          <Link href="/rules#privacy">{t('footer_privacy')}</Link>
          <Link href="/rules#contacts">{t('footer_contacts')}</Link>
          <Link href="/staff/login">Staff</Link>
        </div>
        <div>{t('footer_note')}</div>
      </div>
    </footer>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const { t } = useApp();
  return <span className={'badge ' + status}>{t('status_' + status)}</span>;
}
