'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { useApp } from '@/lib/ctx';
import { amountInWords, fmtAmd, fmtDate, fmtNum } from '@/lib/format';
import { useStepUp } from './StepUp';
import { Countdown } from './Countdown';

/** Блок ставки на карточке (PRD 3.3, SC-07…SC-10). */
export function BidBlock({ data, reload }: { data: any; reload: () => void }) {
  const { t, me } = useApp();
  const { lot } = data;
  const status = lot.status;

  if (data.isSeller) return <SellerBlock data={data} reload={reload} />;
  if (status === 'revealing')
    return (
      <div className="card">
        <div className="notice warn">{t('revealing')}</div>
      </div>
    );
  if (!['scheduled', 'live'].includes(status)) return null;
  return (
    <div className="card stack">
      <h3>{t('bid_block')}</h3>
      {status === 'scheduled' && (
        <p>
          {t('soon_text')} <Countdown to={lot.opens_at} onDone={reload} />
        </p>
      )}
      {data.myBidRef ? <MyBid data={data} reload={reload} /> : <Participate data={data} reload={reload} />}
      {!me && <span hidden />}
    </div>
  );
}

/** PRD v2 решение 9: своя ставка, «осталось изменений N из M», история версий и изменение. */
function MyBid({ data, reload }: { data: any; reload: () => void }) {
  const { t, lang } = useApp();
  const lotId = data.lot.id;
  const [b, setB] = useState<any>(null);
  const [editing, setEditing] = useState(false);
  const load = () => api(`/lots/${lotId}/my-bids`).then((r) => setB(r.bid));
  useEffect(() => {
    load();
  }, [lotId]);
  if (!b) return <p className="muted">{t('loading')}</p>;
  const max = b.changesLeft + b.version - 1;
  return (
    <div className="stack">
      <Receipt r={b} />
      <div className={b.changesLeft ? 'notice' : 'notice warn'}>
        <b>{t('changes_left', { left: b.changesLeft, max })}</b>
      </div>
      {b.changesLeft > 0 && data.lot.status === 'live' && !editing && (
        <button className="btn" onClick={() => setEditing(true)}>
          {t('change_bid')}
        </button>
      )}
      {editing && (
        <BidForm
          data={data}
          lang={lang}
          change={{ left: b.changesLeft - 1, max }}
          reload={() => {
            setEditing(false);
            load();
            reload();
          }}
        />
      )}
      {b.versions?.length > 1 && (
        <div className="small stack">
          <b>{t('my_versions')}</b>
          {b.versions.map((v: any) => (
            <div key={v.version} className="row gap">
              <span>v{v.version}</span>
              <b>{fmtAmd(v.amount)}</b>
              <span className="muted">{fmtDate(v.serverReceivedAt, { ms: true })}</span>
              {v.current && <span className="badge">{t('version_current')}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Receipt({ r }: { r: any }) {
  const { t } = useApp();
  return (
    <div className="receipt stack">
      <div>
        <b>
          {t('bid_accepted')}: {fmtAmd(r.amount)}
        </b>
        <div className="small">
          {t('accepted_at')} {fmtDate(r.serverReceivedAt, { ms: true })}
        </div>
      </div>
      <div className="small">
        {t('receipt_no')} <b>{r.receiptNo}</b>
      </div>
      <div className="small">
        {t('commitment')}: <code className="mono">{r.commitment}</code>
      </div>
      <div className="small muted">{t('commitment_hint')}</div>
    </div>
  );
}

function Participate({ data, reload }: { data: any; reload: () => void }) {
  const { t, me, reloadMe, lang, tErr } = useApp();
  const router = useRouter();
  const stepUp = useStepUp();
  const [prepare, setPrepare] = useState(data.lot.status === 'live');
  const [cards, setCards] = useState<any[]>([]);
  const [cardId, setCardId] = useState<number | undefined>();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const steps: any[] = data.steps || [];
  const allDone = steps.every((s) => s.done);
  const plan = steps.find((s) => s.key === 'subscription')?.data?.plan;

  useEffect(() => {
    if (me) api('/cards').then((c) => {
      setCards(c);
      setCardId(c[0]?.id);
    });
  }, [me]);

  const withStepUp = async (action: string, fn: (token: string) => Promise<any>) => {
    setErr('');
    setBusy(true);
    try {
      const token = await stepUp.run(action);
      if (!token) return;
      await fn(token);
      await reloadMe();
      reload();
    } catch (e) {
      setErr(tErr(e));
    } finally {
      setBusy(false);
    }
  };
  const buyAccess = () => withStepUp('subscription', (tk) => api('/subscriptions', { body: { plan, cardId }, headers: { 'x-step-up': tk } }));
  const placeDeposit = () => withStepUp('deposit', (tk) => api(`/lots/${data.lot.id}/deposit`, { body: { cardId }, headers: { 'x-step-up': tk } }));

  const blocked = me?.sanction;
  if (blocked)
    return <div className="notice bad">{blocked.kind === 'funds_request' ? t('funds_requested') : t('blocked_bidding', { until: blocked.ends_at ? fmtDate(blocked.ends_at) : '∞' })}</div>;

  if (data.limitBlock && me) {
    const lb = data.limitBlock;
    return (
      <div className="notice warn stack">
        <b>{t('limit_title')}</b>
        <div>{lb.error === 'LIMIT_OPEN_DEALS' ? t('limit_deal') : lb.error === 'LIMIT_BUYING_POWER' ? t('limit_power') : t('limit_active', { n: lb.lots?.length, limit: lb.limit })}</div>
        <div className="small">
          {t('limit_lots')}:{' '}
          {(lb.lots || []).map((id: number) => (
            <Link key={id} href={`/lots/${id}`} style={{ marginRight: 8 }}>
              #{id}
            </Link>
          ))}
        </div>
        <Link className="btn sm" href="/account?tab=investor">
          {t('raise_limit')}
        </Link>
      </div>
    );
  }

  if (data.lot.status === 'scheduled' && !prepare)
    return (
      <>
        <button className="btn primary" onClick={() => setPrepare(true)}>
          {t('prepare')}
        </button>
        <p className="small muted">{t('prepare_hint')}</p>
      </>
    );

  if (!allDone || data.lot.status === 'scheduled') {
    const firstUndone = steps.findIndex((s) => !s.done);
    return (
      <>
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={s.key} className={s.done ? 'done' : ''}>
              <span className="ico">{s.done ? '✓' : i + 1}</span>
              <span className="grow">
                {t('step_' + s.key)}
                {s.key === 'deposit' && <span className="muted small"> · {fmtAmd(s.data.amount)}</span>}
                {s.key === 'subscription' && plan && <span className="muted small"> · {plan}</span>}
                {s.key === 'subscription' && s.done && s.data?.left !== null && s.data?.left !== undefined && <span className="muted small"> · {t('tries_left', { left: s.data.left, limit: s.data.limit })}</span>}
              </span>
              {!s.done && i === firstUndone && <StepAction k={s.key} lotId={data.lot.id} onBuy={buyAccess} onDeposit={placeDeposit} busy={busy} hasCard={cards.length > 0} />}
            </li>
          ))}
        </ol>
        {me && cards.length > 1 && ['subscription', 'deposit'].includes(steps[firstUndone]?.key) && (
          <label className="f">
            {t('choose_card')}
            <select className="input" value={cardId} onChange={(e) => setCardId(Number(e.target.value))}>
              {cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.mask}
                </option>
              ))}
            </select>
          </label>
        )}
        {me && cards.length === 0 && ['subscription', 'deposit'].includes(steps[firstUndone]?.key) && (
          <p className="small">
            <Link href="/account?tab=cards">{t('bind_card_first')}</Link>
          </p>
        )}
        {steps.find((s) => s.key === 'deposit' && !s.done) && <p className="small muted">{t('deposit_note')}</p>}
        {err && <p className="error">{err}</p>}
        {stepUp.node}
        {!me && <span hidden onClick={() => router.push('/login')} />}
      </>
    );
  }

  return <BidForm data={data} reload={reload} lang={lang} />;
}

function StepAction({ k, lotId, onBuy, onDeposit, busy, hasCard }: { k: string; lotId: number; onBuy: () => void; onDeposit: () => void; busy: boolean; hasCard: boolean }) {
  const { t } = useApp();
  if (k === 'login')
    return (
      <Link className="btn sm primary" href={`/login?next=/lots/${lotId}`}>
        {t('do_step')}
      </Link>
    );
  if (k === 'email' || k === 'kyc')
    return (
      <Link className="btn sm primary" href={`/account?tab=profile&next=/lots/${lotId}`}>
        {t('do_step')}
      </Link>
    );
  if (k === 'subscription')
    return (
      <button className="btn sm primary" disabled={busy || !hasCard} onClick={onBuy}>
        {t('buy')}
      </button>
    );
  return (
    <button className="btn sm primary" disabled={busy || !hasCard} onClick={onDeposit}>
      {t('do_step')}
    </button>
  );
}

function BidForm({ data, reload, lang, change }: { data: any; reload: () => void; lang: any; change?: { left: number; max: number } }) {
  const { t, tErr } = useApp();
  const stepUp = useStepUp();
  const [raw, setRaw] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [rules, setRules] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<any>(null);
  const key = useMemo(() => newIdempotencyKey(), [confirm]); // один ключ на одну попытку подтверждения
  const amount = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const min = data.lot.start_price + 1;
  const valid = Number.isSafeInteger(amount) && amount >= min;

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      const token = await stepUp.run('bid');
      if (!token) return;
      const r = await api(`/lots/${data.lot.id}/bids`, { method: change ? 'PUT' : 'POST', body: { amount: raw, acceptRules: rules }, headers: { 'x-step-up': token, 'idempotency-key': key } });
      setReceipt(r);
      setConfirm(false);
      reload();
    } catch (e) {
      setErr(tErr(e));
    } finally {
      setBusy(false);
    }
  };
  if (receipt && !change) return <Receipt r={receipt} />;
  return (
    <>
      <label className="f">
        {t('bid_amount')}
        <input className="input big" inputMode="numeric" value={raw ? fmtNum(Number(raw)) : ''} onChange={(e) => setRaw(e.target.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 13))} placeholder={fmtNum(min)} />
      </label>
      <div className="small muted">{t('bid_hint', { min: fmtAmd(data.lot.start_price) })}</div>
      {raw && !valid && <div className="small error">{tErr(new ApiError('BID_TOO_LOW', 400, { min }))}</div>}
      <button className="btn primary" disabled={!valid} onClick={() => setConfirm(true)}>
        {change ? t('change_bid') : t('bid_button')}
      </button>
      {err && <p className="error">{err}</p>}
      {confirm && (
        <div className="modal-bg">
          <div className="modal">
            <h3>{change ? t('change_confirm_title') : t('bid_confirm_title')}</h3>
            <div className="big-price">{fmtAmd(amount)}</div>
            <div className="small">
              {t('in_words')}: <i>{amountInWords(amount, lang)}</i>
            </div>
            <div className="notice bad">{change ? t('change_warning', change) : t('bid_warning', { n: data.bidMaxChanges ?? 3 })}</div>
            {!change && (
              <label className="check small">
                <input type="checkbox" checked={rules} onChange={(e) => setRules(e.target.checked)} /> {t('accept_rules')}
              </label>
            )}
            {err && <p className="error">{err}</p>}
            <div className="row gap">
              <button className="btn primary" disabled={(!rules && !change) || busy} onClick={submit}>
                {t('confirm_sms')}
              </button>
              <button className="btn ghost" onClick={() => setConfirm(false)}>
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
      {stepUp.node}
    </>
  );
}

function SellerBlock({ data, reload }: { data: any; reload: () => void }) {
  const { t, tErr } = useApp();
  const router = useRouter();
  const [err, setErr] = useState('');
  const st = data.lot.status;
  const withdraw = async () => {
    if (!confirm(t('withdraw_confirm'))) return;
    try {
      await api(`/lots/${data.lot.id}/withdraw`, { body: {} });
      reload();
    } catch (e) {
      setErr(tErr(e));
    }
  };
  const relaunch = async () => {
    try {
      const r = await api(`/lots/${data.lot.id}/relaunch`, { body: {} });
      router.push(`/sell/${r.id}`);
    } catch (e) {
      setErr(tErr(e));
    }
  };
  return (
    <div className="card stack">
      <div className="notice">{t('seller_view')}</div>
      {['scheduled', 'live'].includes(st) && (
        <button className="btn danger sm" onClick={withdraw}>
          {t('withdraw')}
        </button>
      )}
      {['finished', 'sold'].includes(st) && (
        <Link className="btn primary sm" href={`/deals/${data.lot.id}`}>
          {t('go_deal')}
        </Link>
      )}
      {['no_sale', 'withdrawn'].includes(st) && (
        <button className="btn primary sm" onClick={relaunch}>
          {t('relaunch')}
        </button>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
