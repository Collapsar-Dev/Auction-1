'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';
import { fmtAmd, fmtDate } from '@/lib/format';

const CHECKS: [string, string][] = [
  ['extract', 'Выписка из кадастра проверена (не старше 15 раб. дней) *'],
  ['owner_match', 'Собственник в выписке = продавец, все собственники согласны *'],
  ['no_encumbrance', 'Нет ареста и ипотеки без согласия банка'],
  ['photos_match', 'Данные и фото соответствуют выписке'],
  ['valuation', 'Отчёт об оценке проверен (если приложен)'],
];

/** SC-05: модератор сверяет выписку с данными продавца и фото. Отмеченные пункты видны покупателям. */
export default function AdminLot() {
  const { id } = useParams<{ id: string }>();
  const { me } = useApp();
  const [d, setD] = useState<any>(null);
  const [comment, setComment] = useState('');
  const [check, setCheck] = useState<Record<string, boolean>>({ extract: false, owner_match: false, no_encumbrance: false, photos_match: false, valuation: false });
  const [msg, setMsg] = useState('');
  const load = () => api('/admin/lots/' + id).then(setD).catch((e) => setMsg(e.code));
  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <p className="muted">{msg || 'Загрузка…'}</p>;
  const run = async (path: string, body: any) => {
    setMsg('');
    try {
      const r = await api(path, { body });
      setMsg('Готово: ' + JSON.stringify(r));
      load();
    } catch (e: any) {
      setMsg('Ошибка: ' + e.code + ' ' + JSON.stringify(e.data));
    }
  };
  const p = d.property;
  return (
    <div className="stack">
      <Link href="/admin">← Админка</Link>
      <h1>
        Лот #{d.lot.id} · {d.lot.status}
      </h1>
      <div className="lot-layout">
        <div className="stack">
          <div className="card">
            <h3>Объект</h3>
            <div className="kv">
              <span>Тип</span>
              <span>{p.property_type}</span>
              <span>Адрес</span>
              <span>
                {p.region}, {p.settlement}, {p.street}
              </span>
              <span>Кадастровый №</span>
              <b>{p.cadastral_no}</b>
              <span>Площадь / комнаты</span>
              <span>
                {p.area_m2} м² / {p.rooms}
              </span>
              <span>Начальная цена</span>
              <b>{fmtAmd(d.lot.start_price)}</b>
              <span>Время</span>
              <span>
                {fmtDate(d.lot.opens_at)} — {fmtDate(d.lot.closes_at)}
              </span>
              <span>Депозит</span>
              <span>{fmtAmd(d.lot.deposit_amount)}</span>
            </div>
          </div>
          <div className="card">
            <h3>Продавец</h3>
            <div className="kv">
              <span>ФИО (KYC)</span>
              <b>{d.seller.full_name}</b>
              <span>Телефон</span>
              <span>{d.seller.phone}</span>
              <span>KYC</span>
              <span>{d.seller.kyc_status}</span>
            </div>
          </div>
          <div className="card stack">
            <h3>Выписка из кадастра (закрыто, ссылка на 5 мин)</h3>
            {d.extracts.map((e: any) => (
              <a key={e.id} href={e.url} target="_blank">
                Открыть выписку · загружена {fmtDate(e.uploadedAt)}
              </a>
            ))}
            <p className="small muted">Проверьте: собственник в выписке = продавец (все собственники согласны); нет ареста и ипотеки без согласия банка; данные и фото соответствуют выписке.</p>
          </div>
          {d.valuations?.length > 0 && (
            <div className="card stack">
              <h3>Оценка (публично)</h3>
              {d.valuations.map((v: any) => (
                <div key={v.id} className="small">
                  <b>{v.org_name}</b> · {fmtAmd(v.amount)} · {fmtDate(v.valued_at, { dateOnly: true })} · {v.report_no} ·{' '}
                  <a href={v.url} target="_blank">
                    отчёт
                  </a>
                </div>
              ))}
            </div>
          )}
          <div className="card">
            <h3>Фото ({d.photos.length})</h3>
            <div className="photo-grid">
              {d.photos.map((u: string) => (
                <div key={u} className="ph" style={{ backgroundImage: `url(${u})` }} />
              ))}
            </div>
          </div>
        </div>
        <aside className="side stack">
          {d.lot.status === 'moderation' && (
            <div className="card stack">
              <h3>Решение модератора</h3>
              <textarea className="input" placeholder="Комментарий (обязателен для возврата и отказа)" value={comment} onChange={(e) => setComment(e.target.value)} />
              <div className="stack small">
                {CHECKS.map(([k, label]) => (
                  <label key={k} className="check">
                    <input type="checkbox" checked={!!check[k]} onChange={(e) => setCheck({ ...check, [k]: e.target.checked })} /> {label}
                  </label>
                ))}
              </div>
              <button className="btn primary" disabled={!check.extract || !check.owner_match} onClick={() => run(`/admin/lots/${id}/moderate`, { decision: 'approve', comment, checklist: check })}>
                Одобрить → «Скоро»
              </button>
              <button className="btn" onClick={() => run(`/admin/lots/${id}/moderate`, { decision: 'return', comment })}>
                Вернуть на доработку
              </button>
              <button className="btn danger" onClick={() => run(`/admin/lots/${id}/moderate`, { decision: 'reject', comment })}>
                Отклонить
              </button>
            </div>
          )}
          {me?.role === 'admin' && ['scheduled', 'live'].includes(d.lot.status) && (
            <div className="card stack">
              <h3>Снятие лота (R-15)</h3>
              <p className="small muted">Все депозиты освобождаются, ставки не вскрываются и удаляются. Суммы ставок не видны и администратору.</p>
              <button className="btn danger" onClick={() => run(`/admin/lots/${id}/withdraw`, { reason: window.prompt('Веская причина') || '' })}>
                Снять лот
              </button>
            </div>
          )}
          {me?.role === 'admin' && ['finished'].includes(d.lot.status) && (
            <div className="card stack">
              <h3>Подставной участник (S-4)</h3>
              <button className="btn danger" onClick={() => run(`/admin/lots/${id}/invalidate`, { reason: window.prompt('Доказанная причина') || '' })}>
                Объявить лот недействительным
              </button>
            </div>
          )}
          {d.deal && (
            <div className="card">
              <h3>Сделка</h3>
              <pre className="body">{JSON.stringify({ ...d.deal, new_extract_key: undefined }, null, 2)}</pre>
              {d.deal.new_extract_url && (
                <a href={d.deal.new_extract_url} target="_blank">
                  Выписка с новым собственником
                </a>
              )}
            </div>
          )}
          <div className="card">
            <h3>История модерации</h3>
            {d.moderation.map((m: any) => (
              <div key={m.id} className="small">
                {fmtDate(m.created_at)} · {m.username} · <b>{m.decision}</b> {m.comment}
              </div>
            ))}
          </div>
          {msg && <p className="notice">{msg}</p>}
        </aside>
      </div>
    </div>
  );
}
