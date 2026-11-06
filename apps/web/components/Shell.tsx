'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useApp } from '@/lib/ctx';
import { api } from '@/lib/api';
import { Lang } from '@/lib/format';

export function Header() {
  const { t, lang, setLang, me, reloadMe, devTools } = useApp();
  const router = useRouter();
  const path = usePathname();
  const [open, setOpen] = useState(false); // мобильное меню ☰
  useEffect(() => setOpen(false), [path]);
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    await reloadMe();
    router.push('/');
  };
  return (
    <header className="top">
      <div className="container bar">
        <Link href="/" className="logo">
          <Logo />
          <span className="logo-text">
            {t('brand').split('·')[0]}
            <span>·{t('brand').split('·')[1]}</span>
          </span>
        </Link>
        <button className="menu-btn" aria-label={t('menu')} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '✕' : '☰'}
        </button>
        <nav className={'main' + (open ? ' open' : '')}>
          <Link href="/">{t('nav_catalog')}</Link>
          {!me?.staff && <Link href="/sell">{t('nav_sell')}</Link>}
          <Link href="/partners">{t('nav_partners')}</Link>
          <Link href="/rules">{t('nav_rules')}</Link>
          {me?.staff && <Link href="/admin">{t('nav_admin')}</Link>}
          {devTools && <Link href="/dev">{t('nav_dev')}</Link>}
        </nav>
        <div className={'langs' + (open ? ' open' : '')}>
          {(['hy', 'ru', 'en'] as Lang[]).map((l) => (
            <button key={l} className={lang === l ? 'on' : ''} onClick={() => setLang(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
        {me ? (
          <div className={'row gap-s user-btns' + (open ? ' open' : '')}>
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
          <Link className="btn sm primary login-btn" href="/login">
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

/** PRD v2 §2: статусы для покупателя, в порядке каталога, с цветной точкой. */
export const STAGES = ['in_progress', 'registration_open', 'upcoming', 'awaiting_contract', 'finished', 'no_sale', 'cancelled'];
export const STAGE_DOT: Record<string, string> = {
  in_progress: '#C2410C',
  registration_open: '#146C2E',
  upcoming: '#D9A441',
  awaiting_contract: '#7E22CE',
  finished: '#5B5B66',
  no_sale: '#A08C80',
  cancelled: '#B91C1C',
};
export function StageBadge({ stage }: { stage: string }) {
  const { t } = useApp();
  return (
    <span className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: STAGE_DOT[stage] ?? '#999' }} />
      {t('stage_' + stage)}
    </span>
  );
}

/** Логотип «Абрикос»: абрикос с листиком (бренд-бук на канвасе, страница Identity). */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 32 32">
      <circle cx="16" cy="18" r="12" fill="#F6A04D" />
      <path d="M16 6c2-4 6-4 8-3-1 3-4 5-8 3z" fill="#3E7D3A" />
    </svg>
  );
}
