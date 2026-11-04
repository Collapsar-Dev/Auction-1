'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';
import { fmtAmd, fmtDate } from '@/lib/format';

async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** R-09: все ставки от большей к меньшей, время каждой, победитель; имена скрыты; «Это вы». */
export function ResultTable({ result, lotId, reload }: { result: any; lotId: number; startPrice: number; reload: () => void }) {
  const { t, tErr, me } = useApp();
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [dispute, setDispute] = useState('');
  const [dMsg, setDMsg] = useState('');
  const verifyAll = async () => {
    const out: Record<string, boolean> = {};
    for (const b of result.bids) out[b.bidId] = (await sha256hex(`${b.amount}${b.salt}${b.bidId}`)) === b.commitment;
    setChecks(out);
  };
  const mine = result.bids.find((b: any) => b.isMe);
  const sendDispute = async () => {
    try {
      await api(`/lots/${lotId}/disputes`, { body: { message: dispute, commitment: mine?.commitment } });
      setDMsg(t('sent'));
      setDispute('');
    } catch (e) {
      setDMsg(tErr(e));
    }
  };
  return (
    <div className="stack">
      <h2>{t('results')}</h2>
      {result.youWon && (
        <div className="notice ok row between gap">
          <b>{t('you_won')}</b>
          <Link className="btn primary sm" href={`/deals/${lotId}`}>
            {t('go_deal')}
          </Link>
        </div>
      )}
      {result.secondChance?.transferred && <div className="notice warn">{t('second_chance_done', { place: result.secondChance.place ?? 2 })}</div>}
      {result.bids.length > 1 && !result.secondChance?.days && result.secondChance?.chainPlaces > 1 && !result.secondChance.transferred && (
        <div className="notice">{t('chain_note', { n: Math.min(result.secondChance.chainPlaces, result.bids.length) })}</div>
      )}
      {result.bids.length > 1 && result.secondChance?.days > 0 && !result.secondChance.transferred && (
        <div className="notice">{t('second_chance_note', { days: result.secondChance.days, until: fmtDate(result.secondChance.until) })}</div>
      )}
      {result.bids.length === 0 ? (
        <p className="muted">{t('no_bids')}</p>
      ) : (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t('place')}</th>
                <th>{t('participant_id')}</th>
                <th>{t('amount')}</th>
                <th>{t('time')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {result.bids.map((b: any) => (
                <tr key={b.bidId} className={(b.isMe ? 'me ' : '') + (b.isWinner ? 'win' : '')}>
                  <td>{b.place}</td>
                  <td>{b.userId ? <span className="uid">ID {b.userId}</span> : `${t('participant')} ${b.label}`}</td>
                  <td>{fmtAmd(b.amount)}</td>
                  <td className="small">{fmtDate(b.at, { ms: true })}</td>
                  <td className="small">
                    {b.isWinner && <span className="badge finished">{t('winner')}</span>} {b.isBuyer && !b.isWinner && <span className="badge live">{t('buyer_now')}</span>} {b.isMe && <span className="badge revealing">{t('this_is_you')}</span>}{' '}
                    {b.bidId in checks && <span className={checks[b.bidId] ? 'ok' : 'error'}>{checks[b.bidId] ? '✓' : '✗'}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">
        {t('results')}: {fmtDate(result.revealedAt, { ms: true })}
      </p>
      {result.bids.length > 0 && (
        <details>
          <summary className="small">{t('verify_title')}</summary>
          <p className="small muted">{t('verify_hint')}</p>
          {mine && (
            <p className="small">
              {t('commitment')}: <code className="mono">{mine.commitment}</code>
            </p>
          )}
          <button className="btn sm" onClick={verifyAll}>
            {t('verify_btn')}
          </button>
        </details>
      )}
      {mine && me && (
        <details>
          <summary className="small">{t('dispute')}</summary>
          <textarea className="input" placeholder={t('dispute_text')} value={dispute} onChange={(e) => setDispute(e.target.value)} />
          <div className="row gap" style={{ marginTop: 8 }}>
            <button className="btn sm" disabled={dispute.length < 5} onClick={sendDispute}>
              {t('send')}
            </button>
            {dMsg && <span className="small">{dMsg}</span>}
          </div>
        </details>
      )}
      <span hidden onClick={reload} />
    </div>
  );
}
