'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';
import { fmtAmd, fmtDate } from '@/lib/format';

/** PRD v2 (F10.3): кабинет партнёра — заявка с лицензией, входящие заявки клиентов, реклама и её статистика. */
export default function PartnerCabinet() {
  const { t, tErr, me, meLoaded } = useApp();
  const [d, setD] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const load = () => api('/partner').then(setD).catch((e) => setMsg(tErr(e)));
  useEffect(() => {
    if (me) load();
  }, [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (meLoaded && !me) return <Link href="/login?next=/partner">{t('login_title')}</Link>;
  if (!d) return <p className="muted">{t('loading')}</p>;
  const p = d.partner;
  const post = async (path: string, form: FormData | any) => {
    setMsg('');
    try {
      await api(path, form instanceof FormData ? { method: 'POST', form } : { body: form });
      setMsg(t('done'));
      load();
    } catch (e) {
      setMsg(tErr(e));
    }
  };
  return (
    <div className="stack">
      <h1>{t('partner_cabinet')}</h1>
      {(!p || p.status === 'rejected') && (
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            post('/partner/apply', new FormData(e.currentTarget));
          }}
        >
          {p?.status === 'rejected' && <div className="notice bad">{t('partner_rejected', { reason: p.reject_reason })}</div>}
          <p className="muted">{t('partner_apply_note')}</p>
          <div className="form-grid">
            <label className="f">
              {t('pkind')}
              <select className="input" name="kind" defaultValue="notary">
                {['notary', 'insurance', 'appraisal', 'lawyer'].map((k) => (
                  <option key={k} value={k}>
                    {t('pkind_' + k)}
                  </option>
                ))}
              </select>
            </label>
            <label className="f">
              {t('pname')}
              <input className="input" name="name" required />
            </label>
            <label className="f">
              {t('pcity')}
              <input className="input" name="city" required />
            </label>
            <label className="f">
              {t('price_from')}
              <input className="input" name="price_from" />
            </label>
            <label className="f">
              {t('license_no')}
              <input className="input" name="license_no" required />
            </label>
            <label className="f">
              {t('license_file')}
              <input type="file" name="license" accept="application/pdf,image/jpeg,image/png" required />
            </label>
          </div>
          <label className="f">
            {t('pdesc')}
            <textarea className="input" name="description" rows={3} />
          </label>
          <button className="btn primary">{t('send')}</button>
        </form>
      )}
      {p && p.status !== 'rejected' && (
        <div className={'notice ' + (p.status === 'active' ? 'ok' : 'warn')}>
          <b>{p.name}</b> · {t('pkind_' + p.kind)} · {t('pstatus_' + p.status)}
        </div>
      )}
      {p?.status === 'active' && (
        <>
          <div className="card stack">
            <h3>{t('client_requests')}</h3>
            {d.requests.length === 0 && <p className="small muted">—</p>}
            {d.requests.map((r: any) => (
              <div key={r.id} className="stack small" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                <div className="row gap" style={{ flexWrap: 'wrap' }}>
                  <b>#{r.id}</b>
                  <span>{t('svc_' + r.service)}</span>
                  <span className="badge">{t('rq_' + r.status)}</span>
                  <span className="muted">{fmtDate(r.created_at)}</span>
                  <span>
                    {r.client_name || '—'} · {r.client_phone || r.client_email}
                  </span>
                  {r.lot_id && <Link href={`/lots/${r.lot_id}`}>#{r.lot_id}</Link>}
                </div>
                {r.comment && <span className="muted">«{r.comment}»</span>}
                {r.status === 'new' && (
                  <div className="row gap">
                    <button className="btn sm primary" onClick={() => post(`/partner/requests/${r.id}`, { status: 'accepted', reply: window.prompt(t('reply_optional')) || undefined })}>
                      {t('accept_request')}
                    </button>
                    <button className="btn sm" onClick={() => post(`/partner/requests/${r.id}`, { status: 'rejected', reply: window.prompt(t('reason')) || '' })}>
                      {t('reject_request')}
                    </button>
                  </div>
                )}
                {r.status === 'accepted' && (
                  <button className="btn sm" style={{ alignSelf: 'start' }} onClick={() => post(`/partner/requests/${r.id}`, { status: 'done', reply: r.reply || undefined })}>
                    {t('mark_done')}
                  </button>
                )}
              </div>
            ))}
          </div>
          <form
            className="card stack"
            onSubmit={(e) => {
              e.preventDefault();
              post('/partner/ads', new FormData(e.currentTarget));
            }}
          >
            <h3>{t('ad_request')}</h3>
            <div className="form-grid">
              <label className="f">
                {t('ad_slot')}
                <select className="input" name="slot">
                  {['catalog', 'lot', 'partners'].map((s) => (
                    <option key={s} value={s}>
                      {t('slot_' + s)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="f">
                {t('ad_title')}
                <input className="input" name="title" required maxLength={120} />
              </label>
              <label className="f">
                {t('ad_url')}
                <input className="input" name="url" type="url" required placeholder="https://" />
              </label>
              <label className="f">
                {t('ad_from')}
                <input className="input" name="starts_on" type="date" required />
              </label>
              <label className="f">
                {t('ad_to')}
                <input className="input" name="ends_on" type="date" required />
              </label>
              <label className="f">
                {t('ad_creative')}
                <input type="file" name="creative" accept="image/jpeg,image/png,image/webp" required />
              </label>
            </div>
            <p className="small muted">{t('ad_rules')}</p>
            <button className="btn primary">{t('send_to_moderator')}</button>
          </form>
          {d.ads.length > 0 && (
            <div className="card stack small">
              <h3>{t('my_ads')}</h3>
              {d.ads.map((a: any) => (
                <div key={a.id} className="row gap" style={{ flexWrap: 'wrap' }}>
                  <b>{a.title}</b>
                  <span>{t('slot_' + a.slot)}</span>
                  <span>
                    {String(a.starts_on).slice(0, 10)} — {String(a.ends_on).slice(0, 10)}
                  </span>
                  <span>{fmtAmd(a.price)}</span>
                  <span className="badge">{t('adst_' + a.status)}</span>
                  {a.reject_reason && <span className="error">{a.reject_reason}</span>}
                  <span className="muted">
                    {t('impressions')}: {a.impressions} · {t('clicks')}: {a.clicks}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {msg && <p className="notice">{msg}</p>}
    </div>
  );
}
