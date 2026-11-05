'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';
import { fmtAmd, fmtDate } from '@/lib/format';
import { useStepUp } from '@/components/StepUp';
import { StatusBadge } from '@/components/Shell';

const TABS = ['profile', 'access', 'cards', 'bids', 'lots', 'seller', 'deals', 'deposits', 'payments', 'favorites', 'notifications', 'investor'];

export default function Page() {
  return (
    <Suspense>
      <Account />
    </Suspense>
  );
}

function Account() {
  const { t, me, meLoaded } = useApp();
  const router = useRouter();
  const sp = useSearchParams();
  const tab = sp.get('tab') || 'profile';
  useEffect(() => {
    if (meLoaded && !me) router.push('/login?next=/account');
    if (me?.staff) router.push('/admin');
    if (me && me.needsConsents.length) router.push('/login?next=/account');
  }, [meLoaded, me]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!me) return <p className="muted">{t('loading')}</p>;
  return (
    <>
      <h1>{t('nav_account')}</h1>
      <div className="tabs">
        {TABS.map((k) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => router.push('/account?tab=' + k)}>
            {t('tab_' + k)}
          </button>
        ))}
      </div>
      {tab === 'profile' && <Profile />}
      {tab === 'access' && <Access />}
      {tab === 'cards' && <Cards />}
      {tab === 'bids' && <Bids />}
      {tab === 'lots' && <Lots />}
      {tab === 'deals' && <Deals />}
      {tab === 'deposits' && <Deposits />}
      {tab === 'seller' && <SellerPlans />}
      {tab === 'payments' && <Payments />}
      {tab === 'favorites' && <Favorites />}
      {tab === 'notifications' && <Notifications />}
      {tab === 'investor' && <Investor />}
    </>
  );
}

function Profile() {
  const { t, tErr, me, reloadMe } = useApp();
  const next = useSearchParams().get('next');
  const [email, setEmail] = useState(me!.email || '');
  const [msg, setMsg] = useState('');
  const [devLink, setDevLink] = useState('');
  const [bio, setBio] = useState(false);
  const [phone, setPhone] = useState('');
  const [codes, setCodes] = useState<any>(null);
  const [cOld, setCOld] = useState('');
  const [cNew, setCNew] = useState('');
  const save = async () => {
    try {
      const r = await api('/me/profile', { method: 'PUT', body: { email } });
      setMsg(t('saved'));
      setDevLink(r.devLink || '');
      reloadMe();
    } catch (e) {
      setMsg(tErr(e));
    }
  };
  const kyc = async () => {
    try {
      const r = await api('/kyc/session', { body: { acceptBiometrics: bio } });
      window.location.href = r.url;
    } catch (e) {
      setMsg(tErr(e));
    }
  };
  const phoneStart = async () => {
    try {
      setCodes(await api('/me/phone/start', { body: { phone } }));
    } catch (e) {
      setMsg(tErr(e));
    }
  };
  const phoneConfirm = async () => {
    try {
      await api('/me/phone/confirm', { body: { phone, codeOld: cOld, codeNew: cNew } });
      setCodes(null);
      setMsg(t('saved'));
      reloadMe();
    } catch (e) {
      setMsg(tErr(e));
    }
  };
  return (
    <div className="stack">
      {next && me!.emailVerified && me!.kycStatus === 'verified' && (
        <div className="notice ok">
          <Link href={next}>← {t('back')}</Link>
        </div>
      )}
      <div className="card stack">
        <div className="kv">
          <span>{t('phone')}</span>
          <span>{me!.phone}</span>
          <span>{t('level')}</span>
          <span>L{me!.level}</span>
          <span>{t('full_name')}</span>
          <span>{me!.fullName || '—'}</span>
        </div>
        <label className="f">
          {t('email')} — {me!.email ? (me!.emailVerified ? t('email_verified') : t('email_unverified')) : ''}
          <div className="row gap">
            <input className="input" style={{ maxWidth: 320 }} value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
            <button className="btn" onClick={save}>
              {t('save')}
            </button>
          </div>
        </label>
        {devLink && (
          <p className="dev-hint">
            Dev: <a href={devLink}>{devLink}</a>
          </p>
        )}
      </div>
      <div className="card stack">
        <h3>
          {t('kyc')}: {t('kyc_' + me!.kycStatus)}
        </h3>
        {me!.kycRejectReason && <p className="error">{me!.kycRejectReason}</p>}
        {me!.kycStatus !== 'verified' && me!.kycStatus !== 'manual' && (
          <>
            <label className="check small">
              <input type="checkbox" checked={bio} onChange={(e) => setBio(e.target.checked)} /> {t('kyc_biometrics')}
            </label>
            <button className="btn primary" disabled={!bio || !me!.emailVerified} onClick={kyc}>
              {t('kyc_start')}
            </button>
            {!me!.emailVerified && <p className="small muted">{t('step_email')}</p>}
          </>
        )}
      </div>
      <div className="card stack">
        <h3>{me?.phone ? t('phone_change') : t('phone_add')}</h3>
        {!me?.phone && <p className="small muted">{t('phone_add_hint')}</p>}
        {!codes ? (
          <div className="row gap">
            <input className="input" style={{ maxWidth: 220 }} placeholder="+374 …" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <button className="btn" onClick={phoneStart}>
              {t('get_code')}
            </button>
          </div>
        ) : (
          <>
            {(codes.devCodeOld || codes.devCodeNew) && (
              <p className="dev-hint">
                Dev: {codes.devCodeOld ? codes.devCodeOld + ' / ' : ''}
                {codes.devCodeNew}
              </p>
            )}
            <div className="row gap">
              {me?.phone && <input className="input" style={{ maxWidth: 180 }} placeholder={t('code_old')} value={cOld} onChange={(e) => setCOld(e.target.value)} />}
              <input className="input" style={{ maxWidth: 180 }} placeholder={t('code_new')} value={cNew} onChange={(e) => setCNew(e.target.value)} />
              <button className="btn primary" onClick={phoneConfirm}>
                {t('confirm')}
              </button>
            </div>
          </>
        )}
      </div>
      {msg && <p className="notice">{msg}</p>}
    </div>
  );
}

function Access() {
  const { t, tErr, lang } = useApp();
  const stepUp = useStepUp();
  const [plans, setPlans] = useState<any[]>([]);
  const [sub, setSub] = useState<any>(null);
  const [cards, setCards] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const [tries, setTries] = useState<any>(null);
  const load = () => {
    api('/plans').then(setPlans);
    api('/me/subscription').then(setSub);
    api('/subscriptions/participations').then(setTries);
    api('/cards').then(setCards);
  };
  useEffect(load, []);
  const run = async (path: string, body: any) => {
    setMsg('');
    try {
      const tk = await stepUp.run('subscription');
      if (!tk) return;
      const r = await api(path, { body: { ...body, cardId: cards[0]?.id }, headers: { 'x-step-up': tk } });
      setMsg(`${t('done')} · ${r.receiptNo}`);
      load();
    } catch (e) {
      setMsg(tErr(e));
    }
  };
  const active = sub?.active || [];
  // PRD v2: повышение на любой более дорогой тариф (доплата разницы, срок не меняется)
  const curPlan = plans.find((p) => active.some((s: any) => s.plan_id === p.id));
  const upgrades = curPlan ? plans.filter((p) => p.price > curPlan.price) : [];
  const leftOf = (s: any) => tries?.subscriptions?.find((x: any) => x.id === s.id);
  return (
    <div className="stack">
      <p className="muted">{t('access_note')}</p>
      {active.length === 0 && <div className="notice warn">{t('no_access')}</div>}
      {active.map((s: any) => (
        <div key={s.id} className="notice ok">
          {s.name_i18n[lang]} — {t('active_until')} {fmtDate(s.ends_at)} {s.source === 'admin_grant' ? '(admin)' : ''}
          {leftOf(s) && (
            <div>
              <b>{leftOf(s).limit === null ? t('tries_unlimited') : t('tries_left', { left: leftOf(s).left, limit: leftOf(s).limit })}</b>
            </div>
          )}
        </div>
      ))}
      <div className="grid">
        {plans.map((p) => (
          <div key={p.id} className="card stack">
            <h3>{p.name_i18n[lang]}</h3>
            <div className="big-price">
              {fmtAmd(p.price)} <span className="small muted">{t('per_year')}</span>
            </div>
            <p className="small">
              {p.participation_limit ? t('plan_tries', { n: p.participation_limit }) : p.max_start_price ? t('plan_basic_desc', { max: fmtAmd(p.max_start_price) }) : t('plan_unlimited')}
              {p.sees_valuation_amount && <span className="muted"> · {t('plan_sees_valuation')}</span>}
            </p>
            <button className="btn primary" disabled={!cards.length} onClick={() => run('/subscriptions', { plan: p.code })}>
              {active.find((s: any) => s.plan_code === p.code) ? t('renew') : t('buy')}
            </button>
          </div>
        ))}
      </div>
      {upgrades.map((p) => (
        <button key={p.id} className="btn" onClick={() => run('/subscriptions/upgrade', { plan: p.code })}>
          {t('upgrade_to', { plan: p.name_i18n[lang], diff: fmtAmd(p.price - curPlan.price) })}
        </button>
      ))}
      {tries?.history?.length > 0 && (
        <div className="card stack small">
          <b>{t('tries_history')}</b>
          {tries.history.map((c: any) => (
            <div key={c.id} className="row gap">
              <span className="muted">{fmtDate(c.created_at)}</span>
              <span>{t('credit_' + c.type)}</span>
              {c.lot_id && <Link href={`/lots/${c.lot_id}`}>#{c.lot_id}</Link>}
              <b>{c.type === 'spent' ? '−1' : '+1'}</b>
              {c.reason && <span className="muted">{c.reason}</span>}
            </div>
          ))}
        </div>
      )}
      {!cards.length && (
        <Link href="/account?tab=cards" className="small">
          {t('bind_card_first')}
        </Link>
      )}
      {msg && <p className="notice">{msg}</p>}
      {stepUp.node}
    </div>
  );
}

function Cards() {
  const { t, tErr } = useApp();
  const stepUp = useStepUp();
  const [cards, setCards] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const load = () => api('/cards').then(setCards);
  useEffect(() => {
    load();
  }, []);
  const bind = async () => {
    try {
      const tk = await stepUp.run('card_bind');
      if (!tk) return;
      const r = await api('/cards/bind', { method: 'POST', headers: { 'x-step-up': tk } });
      window.location.href = r.formUrl;
    } catch (e) {
      setMsg(tErr(e));
    }
  };
  const remove = async (id: number) => {
    try {
      const tk = await stepUp.run('card_delete');
      if (!tk) return;
      await api('/cards/' + id, { method: 'DELETE', headers: { 'x-step-up': tk } });
      load();
    } catch (e) {
      setMsg(tErr(e));
    }
  };
  return (
    <div className="stack">
      <p className="muted small">{t('card_note')}</p>
      {cards.map((c) => (
        <div key={c.id} className="card row between">
          <b>{c.mask}</b>
          <span className="muted small">{c.holder_name}</span>
          <button className="btn sm danger" onClick={() => remove(c.id)}>
            {t('remove')}
          </button>
        </div>
      ))}
      <button className="btn primary" onClick={bind}>
        {t('bind_card')}
      </button>
      {msg && <p className="error">{msg}</p>}
      {stepUp.node}
    </div>
  );
}

function List({ rows, cols }: { rows: any[] | null; cols: [string, (r: any) => any][] }) {
  const { t } = useApp();
  if (!rows) return <p className="muted">{t('loading')}</p>;
  if (!rows.length) return <p className="muted">{t('no_items')}</p>;
  return (
    <div className="card table-wrap">
      <table className="t">
        <thead>
          <tr>
            {cols.map(([h]) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map(([h, f]) => (
                <td key={h}>{f(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function useRows(path: string) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    api(path).then(setRows).catch(() => setRows([]));
  }, [path]);
  return rows;
}

function Bids() {
  const { t } = useApp();
  const rows = useRows('/me/bids');
  return (
    <List
      rows={rows}
      cols={[
        ['#', (r) => <Link href={`/lots/${r.lotId}`}>#{r.lotId}</Link>],
        [t('address'), (r) => `${r.property.settlement}, ${r.property.street}`],
        [t('your_bid'), (r) => <b>{fmtAmd(r.amount)}</b>],
        [t('time'), (r) => <span className="small">{fmtDate(r.serverReceivedAt, { ms: true })}</span>],
        [t('receipt_no'), (r) => <span className="small">{r.receiptNo}</span>],
        [t('status'), (r) => (['finished', 'sold', 'no_sale', 'invalidated'].includes(r.lotStatus) ? (r.won ? <b className="ok">{t('won')}</b> : t('lost')) : t('pending_result'))],
      ]}
    />
  );
}

function Lots() {
  const { t } = useApp();
  const rows = useRows('/me/lots');
  return (
    <div className="stack">
      <Link href="/sell" className="btn primary" style={{ alignSelf: 'start' }}>
        {t('create_lot')}
      </Link>
      <List
        rows={rows}
        cols={[
          ['#', (r) => r.id],
          [t('address'), (r) => (r.settlement ? `${r.settlement}, ${r.street}` : '—')],
          [t('start_price'), (r) => fmtAmd(r.start_price)],
          [t('closes_at'), (r) => fmtDate(r.closes_at)],
          [t('status'), (r) => <StatusBadge status={r.status} />],
          [
            '',
            (r) =>
              ['draft', 'needs_changes'].includes(r.status) ? (
                <Link href={`/sell/${r.id}`}>{t('continue_edit')}</Link>
              ) : r.status === 'moderation' || r.status === 'rejected' ? (
                <Link href={`/sell/${r.id}`}>{t('open')}</Link>
              ) : (
                <Link href={`/lots/${r.id}`}>{t('open')}</Link>
              ),
          ],
        ]}
      />
    </div>
  );
}

function Deals() {
  const { t } = useApp();
  const rows = useRows('/me/deals');
  return (
    <List
      rows={rows}
      cols={[
        ['#', (r) => <Link href={`/deals/${r.lot_id}`}>#{r.lot_id}</Link>],
        [t('address'), (r) => `${r.settlement}, ${r.street}`],
        [t('deal_amount'), (r) => fmtAmd(r.amount)],
        ['', (r) => t('role_' + r.role)],
        [t('status'), (r) => t('deal_' + r.status, { days: 10 })],
      ]}
    />
  );
}

/** PRD v2 «Счёт участника» (F6): блокировки взносов и итоги. Деньги пока блокируются на карте (§7, вариант A). */
function Deposits() {
  const { t } = useApp();
  const [acc, setAcc] = useState<any>(null);
  useEffect(() => {
    api('/me/account').then(setAcc);
  }, []);
  if (!acc) return <p className="muted">{t('loading')}</p>;
  const tiles: [string, number][] = [
    [t('acc_blocked'), acc.totals.blocked + acc.totals.releasing],
    [t('acc_released'), acc.totals.released],
    [t('acc_charged'), acc.totals.charged],
  ];
  return (
    <div className="stack">
      <div className="grid">
        {tiles.map(([l, v]) => (
          <div key={l} className="card">
            <div className="small muted">{l}</div>
            <div className="big-price">{fmtAmd(v)}</div>
          </div>
        ))}
      </div>
      <p className="small muted">{t('acc_model_card')}</p>
      <LedgerCheck />
      <List
        rows={acc.items}
        cols={[
          ['#', (r) => <Link href={`/lots/${r.lot_id}`}>#{r.lot_id} {r.settlement}</Link>],
          [t('amount'), (r) => fmtAmd(r.amount) + (r.guarantee_percent !== null ? ` · ${r.guarantee_percent}%` : '')],
          [t('choose_card'), (r) => (r.amount === 0 ? '—' : r.mask)],
          [t('status'), (r) => t('dep_' + r.status)],
          ['', (r) => <span className="small muted">{fmtDate(r.updated_at || r.created_at)}</span>],
        ]}
      />
    </div>
  );
}

function Payments() {
  const { t, tErr } = useApp();
  const [k, setK] = useState(0);
  const rows = useRows('/me/payments?' + k);
  const pay = async (id: number) => {
    try {
      await api(`/me/payments/${id}/pay`, { body: {} });
      setK(k + 1);
    } catch (e) {
      alert(tErr(e));
    }
  };
  return (
    <List
      rows={rows}
      cols={[
        ['#', (r) => r.id],
        ['', (r) => r.kind],
        [t('amount'), (r) => fmtAmd(r.amount)],
        [t('status'), (r) => r.status],
        ['', (r) => r.receipt_no],
        ['', (r) => fmtDate(r.created_at)],
        [
          '',
          (r) =>
            r.kind === 'commission' && ['failed', 'pending'].includes(r.status) ? (
              <button className="btn sm primary" onClick={() => pay(r.id)}>
                {t('pay')}
              </button>
            ) : null,
        ],
      ]}
    />
  );
}

function Favorites() {
  const { t } = useApp();
  const rows = useRows('/me/favorites');
  return (
    <List
      rows={rows}
      cols={[
        ['#', (r) => <Link href={`/lots/${r.id}`}>#{r.id}</Link>],
        [t('address'), (r) => `${r.settlement}, ${r.street}`],
        [t('start_price'), (r) => fmtAmd(r.start_price)],
        [t('closes_at'), (r) => fmtDate(r.closes_at)],
        [t('status'), (r) => <StatusBadge status={r.status} />],
      ]}
    />
  );
}

function Notifications() {
  const { t } = useApp();
  const rows = useRows('/me/notifications');
  if (!rows) return <p className="muted">{t('loading')}</p>;
  if (!rows.length) return <p className="muted">{t('no_items')}</p>;
  return (
    <div className="stack">
      {rows.map((n) => (
        <div key={n.id} className="card">
          <div className="row between small muted">
            <span>
              {n.channel.toUpperCase()} · {n.template} · {n.status}
            </span>
            <span>{fmtDate(n.created_at)}</span>
          </div>
          {n.subject && <b>{n.subject}</b>}
          <pre className="body">{n.body}</pre>
        </div>
      ))}
    </div>
  );
}

function Investor() {
  const { t, tErr, me } = useApp();
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState('');
  const [k, setK] = useState(0);
  const rows = useRows('/me/funds-proofs?' + k);
  const upload = async () => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      await api('/me/funds-proof', { method: 'POST', form: fd });
      setMsg(t('sent'));
      setK(k + 1);
    } catch (e) {
      setMsg(tErr(e));
    }
  };
  const l = me!.limits;
  return (
    <div className="stack">
      <div className="card">
        <h3>{t('current_limits')}</h3>
        <div className="kv">
          <span>{t('tier')}</span>
          <span>{l.tier === 'investor' ? t('tier_investor') : t('tier_standard')}</span>
          <span>{t('max_active_bids')}</span>
          <span>{l.maxActiveBids}</span>
          <span>{t('max_open_deals')}</span>
          <span>{l.maxOpenDeals}</span>
          {l.buyingPower !== null && (
            <>
              <span>{t('buying_power')}</span>
              <span>{fmtAmd(l.buyingPower)}</span>
              <span>{t('active_until')}</span>
              <span>{fmtDate(l.validUntil)}</span>
            </>
          )}
        </div>
      </div>
      <div className="card stack">
        <p>{t('investor_text')}</p>
        <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <button className="btn primary" disabled={!file} onClick={upload} style={{ alignSelf: 'start' }}>
          {t('upload')}
        </button>
        {msg && <p className="notice">{msg}</p>}
      </div>
      <List
        rows={rows}
        cols={[
          ['#', (r) => r.id],
          [t('status'), (r) => r.status],
          ['', (r) => r.comment],
          ['', (r) => fmtDate(r.created_at)],
        ]}
      />
    </div>
  );
}

/** PRD v2 (F8): мои транзакции с хэш-цепочкой; пересчёт SHA-256 — прямо в браузере, без доверия серверу. */
function LedgerCheck() {
  const { t } = useApp();
  const [d, setD] = useState<any>(null);
  const [res, setRes] = useState<{ ok: boolean; n: number; bad?: number } | null>(null);
  useEffect(() => {
    api('/me/ledger').then(setD);
  }, []);
  const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, '0')).join('');
  const check = async () => {
    let prev = d.genesis;
    for (const e of d.entries) {
      const h = await sha([prev, e.id, e.user_id, e.kind, e.amount, e.ref, e.created_at].join('|'));
      if (e.prev_hash !== prev || h !== e.hash) return setRes({ ok: false, n: d.entries.length, bad: e.id });
      prev = e.hash;
    }
    setRes({ ok: true, n: d.entries.length });
  };
  if (!d) return null;
  return (
    <div className="card stack">
      <div className="row gap" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <b>{t('ledger_title')}</b>
        <button className="btn sm" disabled={!d.entries.length} onClick={check}>
          {t('ledger_check')}
        </button>
      </div>
      {res && <div className={'notice ' + (res.ok ? 'ok' : 'bad')}>{res.ok ? t('ledger_ok', { n: res.n }) : t('ledger_bad', { id: res.bad })}</div>}
      {d.entries.length === 0 && <p className="small muted">{t('ledger_empty')}</p>}
      {[...d.entries].reverse().map((e: any) => (
        <div key={e.id} className="row gap small" style={{ flexWrap: 'wrap' }}>
          <span className="muted">{fmtDate(e.created_at)}</span>
          <span>{t('led_' + e.kind)}</span>
          {e.lot_id && <Link href={`/lots/${e.lot_id}`}>#{e.lot_id}</Link>}
          <b>{e.kind.startsWith('try_') ? (e.kind === 'try_spent' ? '−1' : '+1') : fmtAmd(e.amount)}</b>
          <code className="mono muted" title={e.hash}>
            {e.prev_hash.slice(0, 4)}… → {e.hash.slice(0, 4)}…
          </code>
        </div>
      ))}
      <p className="small muted">{t('ledger_hint')}</p>
    </div>
  );
}

/** PRD v2 решения 16–17 (F3.3, F8.2): тариф продавца и взносы продавца. */
function SellerPlans() {
  const { t, tErr, lang } = useApp();
  const stepUp = useStepUp();
  const [plans, setPlans] = useState<any[]>([]);
  const [mine, setMine] = useState<any>(null);
  const [cards, setCards] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const load = () => {
    api('/seller/plans').then(setPlans);
    api('/me/seller').then(setMine);
    api('/cards').then(setCards);
  };
  useEffect(load, []);
  const buy = async (code: string) => {
    setMsg('');
    try {
      const tk = await stepUp.run('subscription');
      if (!tk) return;
      const r = await api('/seller/subscriptions', { body: { plan: code, cardId: cards[0]?.id }, headers: { 'x-step-up': tk } });
      setMsg(`${t('done')} · ${r.receiptNo}`);
      load();
    } catch (e) {
      setMsg(tErr(e));
    }
  };
  return (
    <div className="stack">
      <p className="muted">{t('seller_plans_note')}</p>
      {(mine?.subscriptions || []).map((s: any) => (
        <div key={s.id} className="notice ok">
          {plans.find((p) => p.code === s.plan)?.name_i18n[lang] ?? s.plan} — {s.limit === null ? t('seller_unlimited_left', { active: mine.activeLots, max: s.maxActive }) : t('seller_left', { left: s.left, limit: s.limit })}
          {s.endsAt && <span className="small"> · {t('active_until')} {fmtDate(s.endsAt)}</span>}
        </div>
      ))}
      <div className="grid">
        {plans.map((p) => (
          <div key={p.id} className="card stack">
            <h3>{p.name_i18n[lang]}</h3>
            <div className="big-price">{fmtAmd(p.price)}</div>
            <p className="small">
              {p.listing_limit === null ? t('seller_plan_unlimited', { max: p.max_active }) : t('seller_plan_n', { n: p.listing_limit })}
              {p.period_days ? ` · ${t('per_year')}` : ''}
            </p>
            <button className="btn primary" disabled={!cards.length} onClick={() => buy(p.code)}>
              {t('buy')}
            </button>
          </div>
        ))}
      </div>
      {!cards.length && (
        <Link href="/account?tab=cards" className="small">
          {t('bind_card_first')}
        </Link>
      )}
      <p className="small muted">{t('seller_plan_rules')}</p>
      {mine?.deposits?.length > 0 && (
        <div className="card stack small">
          <b>{t('seller_deposits_title')}</b>
          {mine.deposits.map((d: any) => (
            <div key={d.lot_id} className="row gap">
              <Link href={`/lots/${d.lot_id}`}>#{d.lot_id}</Link>
              <b>{fmtAmd(d.amount)}</b>
              <span>{t('sdep_' + d.status)}</span>
              {d.status === 'charged' && <span className="error">−{fmtAmd(d.charged_amount)}</span>}
            </div>
          ))}
        </div>
      )}
      {msg && <p className="notice">{msg}</p>}
      {stepUp.node}
    </div>
  );
}
