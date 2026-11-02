'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';
import { fmtAmd, fmtDate } from '@/lib/format';
import { useStepUp } from '@/components/StepUp';
import { Countdown } from '@/components/Countdown';

/** SC-14…SC-17: подтверждение сделки, контакты, выписка. */
export default function DealPage() {
  const { lotId } = useParams<{ lotId: string }>();
  const { t, tErr } = useApp();
  const stepUp = useStepUp();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [reason, setReason] = useState('');
  const load = () => api(`/deals/${lotId}`).then(setD).catch((e) => setErr(tErr(e)));
  useEffect(() => {
    load();
  }, [lotId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err && !d) return <p className="error">{err}</p>;
  if (!d) return <p className="muted">{t('loading')}</p>;
  const mine = d.role === 'buyer' ? d.buyerConfirmedAt : d.sellerConfirmedAt;
  const other = d.role === 'buyer' ? d.sellerConfirmedAt : d.buyerConfirmedAt;
  const confirm = async () => {
    setErr('');
    try {
      const tk = await stepUp.run('deal_confirm');
      if (!tk) return;
      await api(`/deals/${lotId}/confirm`, { method: 'POST', headers: { 'x-step-up': tk } });
      load();
    } catch (e) {
      setErr(tErr(e));
    }
  };
  const decline = async () => {
    if (!confirmWin()) return;
    try {
      await api(`/deals/${lotId}/decline`, { body: { reason } });
      load();
    } catch (e) {
      setErr(tErr(e));
    }
  };
  const confirmWin = () => window.confirm(t('decline_deal') + '?');
  const upload = async (f: File | undefined) => {
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    try {
      await api(`/deals/${lotId}/extract`, { method: 'POST', form: fd });
      load();
    } catch (e) {
      setErr(tErr(e));
    }
  };
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <h1>
        {t('deal')} · <Link href={`/lots/${lotId}`}>#{lotId}</Link>
      </h1>
      <div className="card stack">
        <div className="kv">
          <span>{t('status')}</span>
          <b>{t('deal_' + d.status, { days: d.notaryDays })}</b>
          <span></span>
          <span>{t('role_' + d.role)}</span>
          <span>{t('deal_amount')}</span>
          <b>{fmtAmd(d.amount)}</b>
          {d.role === 'seller' && (
            <>
              <span>{t('commission')}</span>
              <span>{fmtAmd(d.commission)}</span>
            </>
          )}
          {d.status === 'awaiting_confirm' && (
            <>
              <span>{t('deal_deadline')}</span>
              <span>
                {fmtDate(d.confirmDeadline)} (<Countdown to={d.confirmDeadline} />)
              </span>
            </>
          )}
        </div>
        {d.failReason && <div className="notice bad">{d.failReason}</div>}
        {d.status === 'awaiting_confirm' && (
          <>
            <div className="row gap">
              <span className={mine ? 'ok' : 'muted'}>{mine ? '✓ ' + t('you_confirmed') : '…'}</span>
              <span className={other ? 'ok' : 'muted'}>{other ? '✓ ' + t('other_confirmed') : t('waiting_other')}</span>
            </div>
            {!mine && (
              <div className="row gap">
                <button className="btn primary" onClick={confirm}>
                  {t('confirm_deal')}
                </button>
              </div>
            )}
          </>
        )}
        {['awaiting_confirm', 'confirmed'].includes(d.status) && (
          <details>
            <summary className="small">{t('decline_deal')}</summary>
            <div className="row gap" style={{ marginTop: 8 }}>
              <input className="input" style={{ maxWidth: 360 }} placeholder={t('decline_reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className="btn danger" onClick={decline}>
                {t('decline_deal')}
              </button>
            </div>
          </details>
        )}
      </div>
      {d.counterparty && (
        <div className="card stack">
          <h3>{t('counterparty')}</h3>
          <div className="kv">
            <span>{t('full_name')}</span>
            <b>{d.counterparty.name}</b>
            <span>{t('phone')}</span>
            <b>{d.counterparty.phone}</b>
          </div>
          <h3>{t('notary_docs')}</h3>
          <ul>
            {d.notaryDocuments.map((k: string) => (
              <li key={k}>{t('doc_' + k)}</li>
            ))}
          </ul>
          {['confirmed', 'extract_uploaded'].includes(d.status) && (
            <label className="f">
              {t('upload_new_extract')}
              <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => upload(e.target.files?.[0])} />
            </label>
          )}
          {d.extractUploadedAt && <div className="small ok">✓ {fmtDate(d.extractUploadedAt)}</div>}
        </div>
      )}
      {err && <p className="error">{err}</p>}
      {stepUp.node}
    </div>
  );
}
