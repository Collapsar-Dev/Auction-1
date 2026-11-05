'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';
import { fmtDate } from '@/lib/format';
import { AdSlot } from '@/components/AdSlot';

const KINDS = ['', 'notary', 'insurance', 'appraisal', 'lawyer'];
const SERVICES: Record<string, string[]> = {
  notary: ['notary_contract', 'notary_poa'],
  insurance: ['insurance_title', 'insurance_property'],
  appraisal: ['appraisal_report'],
  lawyer: ['lawyer_check', 'lawyer_support'],
};

/** PRD v2 (F10.1–F10.2): лицензированные партнёры и заявка на услугу (например, страховка к лоту). */
export default function Partners() {
  const { t, tErr, me } = useApp();
  const [kind, setKind] = useState('');
  const [list, setList] = useState<any[] | null>(null);
  const [open, setOpen] = useState<any>(null);
  const [service, setService] = useState('');
  const [comment, setComment] = useState('');
  const [msg, setMsg] = useState('');
  const [mine, setMine] = useState<any[]>([]);
  useEffect(() => {
    api('/partners' + (kind ? `?kind=${kind}` : '')).then(setList);
  }, [kind]);
  useEffect(() => {
    if (me && !me.staff) api('/me/service-requests').then(setMine).catch(() => {});
  }, [me]);
  const send = async () => {
    setMsg('');
    try {
      await api(`/partners/${open.id}/requests`, { body: { service, comment } });
      setMsg(t('request_sent'));
      setOpen(null);
      setComment('');
      api('/me/service-requests').then(setMine);
    } catch (e) {
      setMsg(tErr(e));
    }
  };
  return (
    <div className="stack">
      <h1>{t('partners_title')}</h1>
      <p className="muted">{t('partners_note')}</p>
      <div className="row gap" style={{ flexWrap: 'wrap' }}>
        {KINDS.map((k) => (
          <button key={k || 'all'} className={'btn sm ' + (kind === k ? 'primary' : '')} onClick={() => setKind(k)}>
            {k ? t('pkind_' + k) : t('f_any')}
          </button>
        ))}
      </div>
      <AdSlot slot="partners" />
      {list && list.length === 0 && <p className="muted">{t('partners_empty')}</p>}
      <div className="grid">
        {(list || []).map((p) => (
          <div key={p.id} className="card stack">
            <div className="row between gap">
              <b>{p.name}</b>
              <span className="badge">{t('licensed')} ✓</span>
            </div>
            <div className="small muted">
              {t('pkind_' + p.kind)} · {p.city}
            </div>
            <div className="small">{p.description}</div>
            {p.price_from && <div className="small">
                <b>{p.price_from}</b>
              </div>}
            {me && !me.staff ? (
              <button
                className="btn primary sm"
                onClick={() => {
                  setOpen(p);
                  setService(SERVICES[p.kind][0]);
                }}
              >
                {t('order_service')}
              </button>
            ) : (
              <Link className="btn sm" href="/login?next=/partners">
                {t('order_service')}
              </Link>
            )}
          </div>
        ))}
      </div>
      {open && (
        <div className="modal-bg" role="dialog" aria-modal="true">
          <div className="modal stack">
            <h3>{open.name}</h3>
            <label className="f">
              {t('service')}
              <select className="input" value={service} onChange={(e) => setService(e.target.value)}>
                {SERVICES[open.kind].map((s) => (
                  <option key={s} value={s}>
                    {t('svc_' + s)}
                  </option>
                ))}
              </select>
            </label>
            <label className="f">
              {t('comment')}
              <textarea className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
            <div className="row gap">
              <button className="btn primary" onClick={send}>
                {t('send')}
              </button>
              <button className="btn ghost" onClick={() => setOpen(null)}>
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
      {msg && <p className="notice">{msg}</p>}
      {mine.length > 0 && (
        <div className="card stack small">
          <b>{t('my_requests')}</b>
          {mine.map((r) => (
            <div key={r.id} className="row gap" style={{ flexWrap: 'wrap' }}>
              <span className="muted">{fmtDate(r.created_at)}</span>
              <b>{r.partner_name}</b>
              <span>{t('svc_' + r.service)}</span>
              <span className="badge">{t('rq_' + r.status)}</span>
              {r.reply && <span>«{r.reply}»</span>}
            </div>
          ))}
        </div>
      )}
      <p className="small">
        <Link href="/partner">{t('become_partner')}</Link>
      </p>
    </div>
  );
}
