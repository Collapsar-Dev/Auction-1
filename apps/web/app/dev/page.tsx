'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';

/** Инструменты тестировщика (только DEV_TOOLS=true): все SMS и письма, коды TOTP, управление временем. */
export default function Dev() {
  const [out, setOut] = useState<any[]>([]);
  const [totp, setTotp] = useState<any>(null);
  const [filter, setFilter] = useState('');
  const [lotId, setLotId] = useState('1');
  const [sec, setSec] = useState('60');
  const [msg, setMsg] = useState('');
  const load = () => {
    api('/dev/outbox' + (filter ? '?to=' + encodeURIComponent(filter) : '')).then(setOut).catch((e) => setMsg(e.code));
    api('/dev/totp').then(setTotp).catch(() => {});
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (p: string, body: any) => {
    try {
      setMsg(JSON.stringify(await api(p, { body })));
      load();
    } catch (e: any) {
      setMsg('Ошибка: ' + e.code);
    }
  };
  return (
    <div className="stack">
      <h1>Dev-инструменты</h1>
      <div className="notice warn">Только для тестирования. В боевом режиме (DEV_TOOLS≠true) этих страниц и API нет.</div>
      <div className="grid">
        <div className="card stack">
          <h3>TOTP сотрудников</h3>
          {totp?.staff.map((s: any) => (
            <div key={s.username} className="row between">
              <span>
                {s.username} ({s.role})
              </span>
              <b style={{ fontSize: 22, letterSpacing: 2 }}>{s.code}</b>
            </div>
          ))}
          <p className="small muted">Секреты для Google Authenticator: {totp?.staff.map((s: any) => `${s.username}: ${s.secret}`).join(' · ')}</p>
        </div>
        <div className="card stack">
          <h3>Время лота</h3>
          <p className="small muted">Сдвинуть конец лота на «сейчас + N секунд», чтобы увидеть вскрытие, не дожидаясь недели.</p>
          <div className="row gap">
            <input className="input" style={{ width: 80 }} value={lotId} onChange={(e) => setLotId(e.target.value)} placeholder="лот" />
            <input className="input" style={{ width: 100 }} value={sec} onChange={(e) => setSec(e.target.value)} placeholder="сек" />
            <button className="btn" onClick={() => run(`/dev/lots/${lotId}/times`, { closesInSec: Number(sec) })}>
              Конец через N с
            </button>
          </div>
          <button className="btn sm" onClick={() => run(`/dev/lots/${lotId}/times`, { opensInSec: 0, closesInSec: Number(sec) })}>
            Открыть сейчас и закрыть через N с
          </button>
        </div>
        <div className="card stack">
          <h3>Часы сервера</h3>
          <p className="small muted">Сдвиг серверного времени — для сроков 48 ч, напоминаний, истечения доступа.</p>
          <div className="row gap">
            <button className="btn sm" onClick={() => run('/dev/clock', { advanceHours: 1 })}>
              +1 ч
            </button>
            <button className="btn sm" onClick={() => run('/dev/clock', { advanceHours: 24 })}>
              +24 ч
            </button>
            <button className="btn sm" onClick={() => run('/dev/clock', { advanceHours: 49 })}>
              +49 ч
            </button>
            <button className="btn sm" onClick={() => run('/dev/clock', { reset: true })}>
              Сброс
            </button>
            <button className="btn sm" onClick={() => run('/dev/tick', {})}>
              Запустить фоновые задачи
            </button>
          </div>
        </div>
      </div>
      {msg && <pre className="body">{msg}</pre>}
      <div className="card stack">
        <div className="row between gap">
          <h3 style={{ margin: 0 }}>Исходящие SMS и письма</h3>
          <input className="input" style={{ maxWidth: 260 }} placeholder="фильтр: телефон или email" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        {out.map((n) => (
          <div key={n.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <div className="row between small muted">
              <span>
                #{n.id} · {n.channel.toUpperCase()} → {n.to_addr || '—'} {n.full_name ? `(${n.full_name})` : ''} · {n.template} · <b>{n.status}</b> {n.sealed ? '🔒' : ''} {n.last_error || ''}
              </span>
              <span>{fmtDate(n.created_at)}</span>
            </div>
            {n.subject && <b>{n.subject}</b>}
            <pre className="body">{n.body}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}
