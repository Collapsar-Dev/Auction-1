'use client';
import { useApp } from '@/lib/ctx';
import { fmtDate } from '@/lib/format';

/** PRD v2 решение 11 (макет V2Lot): 4 даты лота — показ, регистрация, торги, итог/договор; текущий этап выделен. */
export function LotTimeline({ lot }: { lot: any }) {
  const { t } = useApp();
  const order = ['upcoming', 'registration_open', 'in_progress', 'awaiting_contract'];
  const cur = ['finished', 'no_sale', 'cancelled'].includes(lot.stage) ? 4 : Math.max(0, order.indexOf(lot.stage));
  const steps = [
    { k: 'tl_published', d: lot.published_at },
    { k: 'tl_registration', d: lot.registration_opens_at },
    { k: 'tl_bidding', d: lot.opens_at, d2: lot.closes_at },
    { k: 'tl_contract', d: lot.closes_at },
  ];
  return (
    <div className="timeline">
      {steps.map((s, i) => {
        const state = i < cur ? 'done' : i === cur ? 'now' : 'next';
        return (
          <div key={s.k} className={'tl-step ' + state}>
            <span className="tl-dot">{state === 'done' ? '✓' : i + 1}</span>
            <div>
              <b>{t(s.k)}</b>
              <div className="small muted">
                {s.d ? fmtDate(s.d) : '—'}
                {s.d2 ? ` — ${fmtDate(s.d2)}` : ''}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
