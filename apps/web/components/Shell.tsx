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
          <Logo />
          <span className="logo-text">
            {t('brand').split('·')[0]}
            <span>·{t('brand').split('·')[1]}</span>
          </span>
        </Link>
        <nav className="main">
          <Link href="/">{t('nav_catalog')}</Link>
          {!me?.staff && <Link href="/sell">{t('nav_sell')}</Link>}
          <Link href="/partners">{t('nav_partners')}</Link>
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

/** PRD v2 §2: статусы для покупателя, в порядке каталога, с цветной точкой. */
export const STAGES = ['in_progress', 'registration_open', 'upcoming', 'awaiting_contract', 'finished', 'no_sale', 'cancelled'];
export const STAGE_DOT: Record<string, string> = {
  in_progress: '#8E1B3A',
  registration_open: '#1F7A4A',
  upcoming: '#F6A04D',
  awaiting_contract: '#6A4BC4',
  finished: '#6B4A3A',
  no_sale: '#A08C80',
  cancelled: '#B3261E',
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
