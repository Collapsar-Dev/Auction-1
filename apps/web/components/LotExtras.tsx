'use client';
import { useApp } from '@/lib/ctx';
import { fmtAmd, fmtDate } from '@/lib/format';

/** Блок «Документы проверены» (что сверил модератор при одобрении). */
export function VerifiedDocs({ v }: { v: { checkedAt: string; items: { key: string; ok: boolean }[] } | null }) {
  const { t } = useApp();
  if (!v) return null;
  const ok = v.items.filter((i) => i.ok);
  if (!ok.length) return null;
  return (
    <div className="card stack">
      <div className="row between gap">
        <h3 style={{ margin: 0 }}>🛡 {t('verified_docs')}</h3>
        <span className="small muted">
          {t('checked_on')} {fmtDate(v.checkedAt, { dateOnly: true })}
        </span>
      </div>
      <ul className="verified">
        {ok.map((i) => (
          <li key={i.key}>
            <span className="tick">✓</span> {t('ver_' + i.key)}
          </li>
        ))}
      </ul>
      <p className="small muted" style={{ margin: 0 }}>
        {t('verified_hint')}
      </p>
    </div>
  );
}

/** Блок «Независимая оценка»: организация, сумма, дата, документ. */
export function Valuations({ items, startPrice }: { items: any[]; startPrice: number }) {
  const { t } = useApp();
  if (!items?.length) return null;
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>📊 {t('valuation_title')}</h3>
      {items.map((v) => {
        const diff = Math.round(((v.amount - startPrice) / v.amount) * 100);
        return (
          <div key={v.id} className="valuation">
            <div className="row between gap">
              <div>
                <div className="small muted">{t('valuation_org')}</div>
                <b>{v.orgName}</b>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="small muted">{t('valuation_amount')}</div>
                <div className="big-price" style={{ fontSize: 22 }}>
                  {fmtAmd(v.amount)}
                </div>
              </div>
            </div>
            <div className="row between gap small">
              <span className="muted">
                {t('valuation_date')}: {fmtDate(v.valuedAt, { dateOnly: true })}
                {v.reportNo ? ` · ${t('report_no')} ${v.reportNo}` : ''}
              </span>
              <a href={v.documentUrl} target="_blank" rel="noreferrer">
                📄 {t('valuation_doc')}
              </a>
            </div>
            {diff !== 0 && (
              <div className={'small ' + (diff > 0 ? 'ok' : 'muted')}>{diff > 0 ? t('start_vs_valuation', { pct: diff }) : t('start_above_valuation', { pct: -diff })}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
