'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';
import { fmtAmd, fmtDate } from '@/lib/format';

export default function AdminUser() {
  const { id } = useParams<{ id: string }>();
  const { me } = useApp();
  const [d, setD] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const load = () => api('/admin/users/' + id).then(setD).catch((e) => setMsg(e.code));
  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <p className="muted">{msg || 'Загрузка…'}</p>;
  const run = async (path: string, body: any) => {
    try {
      await api(path, { body });
      setMsg('Готово');
      load();
    } catch (e: any) {
      setMsg('Ошибка: ' + e.code);
    }
  };
  const u = d.user;
  return (
    <div className="stack">
      <Link href="/admin?tab=users">← Пользователи</Link>
      <h1>
        #{u.id} {u.full_name || u.phone}
      </h1>
      <div className="card">
        <div className="kv">
          <span>Телефон</span>
          <span>{u.phone}</span>
          <span>Email</span>
          <span>
            {u.email} {u.email_verified_at ? '✓' : '(не подтверждён)'}
          </span>
          <span>KYC</span>
          <span>
            {u.kyc_status} {u.kyc_reject_reason || ''}
          </span>
          <span>Дата рождения</span>
          <span>{u.birth_date ? fmtDate(u.birth_date, { dateOnly: true }) : '—'}</span>
          <span>Статус</span>
          <span>{u.status}</span>
          <span>Продавец</span>
          <span>{u.seller_blocked ? `заблокирован (${u.seller_block_reason})` : 'ок'}</span>
          <span>Лимиты</span>
          <span>{d.limits ? `${d.limits.tier}: ${d.limits.max_active_bids} ставок, ${d.limits.max_open_deals} сделок, ${fmtAmd(d.limits.buying_power)} до ${fmtDate(d.limits.valid_until)}` : 'обычный'}</span>
        </div>
      </div>
      {me?.role === 'admin' && (
        <div className="card row gap">
          <button className="btn" onClick={() => run(`/admin/users/${id}/grant-access`, { plan: 'full', reason: window.prompt('Причина (пилот)') || '' })}>
            Выдать «Полный» доступ бесплатно
          </button>
          {u.seller_blocked && (
            <button className="btn" onClick={() => run(`/admin/users/${id}/seller-unblock`, { reason: window.prompt('Причина') || '' })}>
              Разблокировать как продавца
            </button>
          )}
        </div>
      )}
      {u.kyc_status === 'manual' && (
        <div className="card row gap">
          <button className="btn primary" onClick={() => run(`/admin/users/${id}/kyc`, { approve: true })}>
            Подтвердить KYC
          </button>
          <button className="btn danger" onClick={() => run(`/admin/users/${id}/kyc`, { approve: false, reason: window.prompt('Причина (увидит пользователь)') || '' })}>
            Отклонить / вернуть
          </button>
        </div>
      )}
      <Block title="Годовой доступ" rows={d.subscriptions} cols={['code', 'source', 'price_paid', 'starts_at', 'ends_at', 'status']} />
      <Block title="Депозиты" rows={d.deposits} cols={['lot_id', 'amount', 'status', 'hold_expires_at']} />
      <Block title="Победы" rows={d.wins} cols={['lot_id', 'amount', 'status']} />
      <Block title="Сигналы" rows={d.riskFlags} cols={['signal', 'lot_id', 'status', 'comment']} />
      <Block title="Блокировки" rows={d.sanctions} cols={['kind', 'strike_no', 'starts_at', 'ends_at', 'reason', 'voided_at']} />
      <Block title="Карты" rows={d.cards} cols={['mask', 'status']} />
      {msg && <p className="notice">{msg}</p>}
    </div>
  );
}
function Block({ title, rows, cols }: { title: string; rows: any[]; cols: string[] }) {
  return (
    <div className="card table-wrap">
      <h3>{title}</h3>
      {!rows.length ? (
        <p className="muted small">—</p>
      ) : (
        <table className="t">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c}>{c.endsWith('_at') ? fmtDate(r[c]) : c === 'amount' || c === 'price_paid' ? fmtAmd(r[c]) : String(r[c] ?? '—')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
