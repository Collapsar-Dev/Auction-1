'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';
import { fmtAmd, fmtDate } from '@/lib/format';

/** Простая админка (3.2): только на русском. Суммы ставок до итога не видны и здесь (R-06). */
const TABS: [string, string, boolean][] = [
  ['moderation', 'Модерация', false],
  ['lots', 'Лоты', false],
  ['users', 'Пользователи', false],
  ['kyc', 'Проверка личности', false],
  ['deposits', 'Депозиты', false],
  ['deals', 'Сделки', false],
  ['risk', 'Риски (6A)', false],
  ['funds', 'Подтверждение средств', false],
  ['sanctions', 'Блокировки', false],
  ['disputes', 'Споры', false],
  ['outages', 'Сбои', true],
  ['notifications', 'Уведомления', false],
  ['settings', 'Настройки', true],
  ['plans', 'Тарифы', true],
  ['audit', 'Журнал', true],
  ['chain', 'Хэш-цепочки', false],
  ['partners', 'Партнёры', false],
  ['ads', 'Реклама', false],
];

export default function Page() {
  return (
    <Suspense>
      <Admin />
    </Suspense>
  );
}

function Admin() {
  const { me, meLoaded } = useApp();
  const router = useRouter();
  const tab = useSearchParams().get('tab') || 'moderation';
  const [ov, setOv] = useState<any>({});
  useEffect(() => {
    if (meLoaded && (!me || !me.staff)) router.push('/staff/login');
    if (me?.staff) api('/admin/overview').then(setOv).catch(() => {});
  }, [meLoaded, me, tab]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!me?.staff) return <p className="muted">Загрузка…</p>;
  const counts: Record<string, number> = { moderation: ov.moderation, kyc: ov.kycManual, risk: ov.riskOpen, funds: ov.fundsPending, deposits: ov.disputedDeposits, deals: ov.dealsOpen, disputes: ov.disputesOpen, outages: ov.outages, notifications: ov.emailFailed };
  return (
    <>
      <h1>
        Админка <span className="muted small">({me.username}, {me.role})</span>
      </h1>
      <div className="admin-nav">
        {TABS.filter(([, , adminOnly]) => !adminOnly || me.role === 'admin').map(([k, label]) => (
          <button key={k} className={'btn sm ' + (tab === k ? 'primary' : '')} onClick={() => router.push('/admin?tab=' + k)}>
            {label}
            {counts[k] ? <span className="pill">{counts[k]}</span> : null}
          </button>
        ))}
      </div>
      {tab === 'moderation' && <LotsTab status="moderation" />}
      {tab === 'lots' && <LotsTab />}
      {tab === 'users' && <Users />}
      {tab === 'kyc' && <KycManual />}
      {tab === 'deposits' && <Deposits />}
      {tab === 'deals' && <Deals />}
      {tab === 'risk' && <Risk />}
      {tab === 'funds' && <Funds />}
      {tab === 'sanctions' && <Sanctions />}
      {tab === 'disputes' && <Disputes />}
      {tab === 'outages' && <Outages />}
      {tab === 'notifications' && <Notifications />}
      {tab === 'chain' && <Chain />}
      {tab === 'partners' && <PartnersAdmin />}
      {tab === 'ads' && <AdsAdmin />}
      {tab === 'settings' && <Settings />}
      {tab === 'plans' && <Plans />}
      {tab === 'audit' && <Audit />}
    </>
  );
}

function useLoad<T = any[]>(path: string, deps: any[] = []) {
  const [d, setD] = useState<T | null>(null);
  const [k, setK] = useState(0);
  useEffect(() => {
    api(path).then(setD).catch((e) => setD({ error: e.code } as any));
  }, [path, k, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return [d, () => setK((x) => x + 1)] as const;
}
function T({ rows, cols }: { rows: any[] | null; cols: [string, (r: any) => any][] }) {
  if (!rows) return <p className="muted">Загрузка…</p>;
  if ((rows as any).error) return <p className="error">{(rows as any).error}</p>;
  if (!rows.length) return <p className="muted">Пусто</p>;
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
const ask = (q: string) => window.prompt(q) || '';
async function act(fn: () => Promise<any>, reload: () => void) {
  try {
    await fn();
    reload();
  } catch (e: any) {
    alert('Ошибка: ' + e.code + (e.data ? ' ' + JSON.stringify(e.data) : ''));
  }
}

function LotsTab({ status }: { status?: string }) {
  const [rows] = useLoad('/admin/lots' + (status ? '?status=' + status : ''));
  return (
    <T
      rows={rows}
      cols={[
        ['#', (r) => <Link href={`/admin/lots/${r.id}`}>#{r.id}</Link>],
        ['Статус', (r) => r.status],
        ['Объект', (r) => `${r.property_type}, ${r.settlement}, ${r.street}`],
        ['Кадастр', (r) => r.cadastral_no],
        ['Продавец', (r) => r.seller_name],
        ['Цена', (r) => fmtAmd(r.start_price)],
        ['Конец', (r) => fmtDate(r.closes_at)],
      ]}
    />
  );
}

function Users() {
  const [q, setQ] = useState('');
  const [rows, reload] = useLoad('/admin/users?q=' + encodeURIComponent(q));
  return (
    <div className="stack">
      <input className="input" style={{ maxWidth: 320 }} placeholder="Поиск: телефон, email, ФИО" value={q} onChange={(e) => setQ(e.target.value)} />
      <T
        rows={rows}
        cols={[
          ['#', (r) => <Link href={`/admin/users/${r.id}`}>#{r.id}</Link>],
          ['Телефон', (r) => r.phone],
          ['ФИО', (r) => r.full_name],
          ['Email', (r) => r.email],
          ['Роль', (r) => r.role],
          ['KYC', (r) => r.kyc_status],
          ['Статус', (r) => r.status + (r.seller_blocked ? ' · продавец заблокирован' : '')],
          [
            '',
            (r) =>
              r.role === 'user' && (
                <button className="btn sm" onClick={() => act(() => api(`/admin/users/${r.id}/status`, { body: { status: r.status === 'active' ? 'blocked' : 'active', reason: ask('Причина') } }), reload)}>
                  {r.status === 'active' ? 'Заблокировать' : 'Разблокировать'}
                </button>
              ),
          ],
        ]}
      />
    </div>
  );
}

/** PRD v2 решение 2 (F11.1): заключение KYC-сервиса → решение модератора; отказ и возврат — только с причиной. */
function KycManual() {
  const [rows, reload] = useLoad<any[]>('/admin/kyc');
  const decide = (id: number, approve: boolean, prefix = '') => {
    if (approve) return act(() => api(`/admin/users/${id}/kyc`, { body: { approve: true } }), reload);
    const reason = ask(prefix ? 'Что исправить (увидит пользователь)' : 'Причина отказа (увидит пользователь)');
    if (!reason) return;
    act(() => api(`/admin/users/${id}/kyc`, { body: { approve: false, reason: prefix + reason } }), reload);
  };
  return (
    <T
      rows={rows}
      cols={[
        ['#', (r) => <Link href={`/admin/users/${r.id}`}>#{r.id}</Link>],
        ['Контакт', (r) => r.phone || r.email],
        ['ФИО', (r) => r.full_name || '—'],
        ['Дата рождения', (r) => r.birth_date || '—'],
        ['KYC-сервис', (r) => <b className={r.provider === 'approved' ? '' : 'error'}>{r.provider === 'approved' ? '✓ совпало' : 'сомнение'}</b>],
        ['Подано', (r) => fmtDate(r.submitted_at || r.created_at)],
        [
          '',
          (r) => (
            <div className="row gap-s">
              <button className="btn sm primary" onClick={() => decide(r.id, true)}>
                Подтвердить
              </button>
              <button className="btn sm" onClick={() => decide(r.id, false, 'Исправьте: ')}>
                Вернуть на исправление
              </button>
              <button className="btn sm danger" onClick={() => decide(r.id, false)}>
                Отклонить
              </button>
            </div>
          ),
        ],
      ]}
    />
  );
}

function Deposits() {
  const [rows, reload] = useLoad('/admin/deposits');
  return (
    <T
      rows={rows}
      cols={[
        ['#', (r) => r.id],
        ['Лот', (r) => <Link href={`/admin/lots/${r.lot_id}`}>#{r.lot_id}</Link>],
        ['Участник', (r) => `${r.full_name} (${r.phone})`],
        ['Сумма', (r) => fmtAmd(r.amount)],
        ['Карта', (r) => r.mask],
        ['Статус', (r) => <b className={r.status === 'disputed' ? 'error' : ''}>{r.status}</b>],
        ['Блокировка до', (r) => fmtDate(r.hold_expires_at)],
        [
          '',
          (r) =>
            r.status === 'disputed' && (
              <div className="row gap-s">
                <button className="btn sm" onClick={() => act(() => api(`/admin/deposits/${r.id}/decide`, { body: { action: 'release', reason: ask('Причина (Q-01)') } }), reload)}>
                  Освободить
                </button>
                <button className="btn sm danger" onClick={() => act(() => api(`/admin/deposits/${r.id}/decide`, { body: { action: 'charge', reason: ask('Основание (разрешение юриста, Q-01)') } }), reload)}>
                  Списать
                </button>
              </div>
            ),
        ],
      ]}
    />
  );
}

function Deals() {
  const [rows, reload] = useLoad('/admin/deals');
  return (
    <T
      rows={rows}
      cols={[
        ['Лот', (r) => <Link href={`/admin/lots/${r.lot_id}`}>#{r.lot_id}</Link>],
        ['Покупатель', (r) => r.buyer_name],
        ['Продавец', (r) => r.seller_name],
        ['Цена', (r) => fmtAmd(r.amount)],
        ['Статус', (r) => r.status],
        ['Срок подтверждения', (r) => fmtDate(r.confirm_deadline)],
        ['Подтв. продавец / покупатель', (r) => `${r.seller_confirmed_at ? '✓' : '—'} / ${r.buyer_confirmed_at ? '✓' : '—'}`],
        [
          '',
          (r) =>
            r.status === 'extract_uploaded' && (
              <button className="btn sm primary" onClick={() => confirm('Отметить «Продано»? Депозит победителя освободится, с продавца спишется комиссия.') && act(() => api(`/admin/deals/${r.lot_id}/sold`, { method: 'POST' }), reload)}>
                Продано
              </button>
            ),
        ],
      ]}
    />
  );
}

function Risk() {
  const [rows, reload] = useLoad('/admin/risk');
  const doAct = (id: number, action: string) => {
    const comment = ask('Комментарий (обязательно)');
    if (!comment) return;
    const body: any = { action, comment };
    if (action === 'set_limit') body.buyingPower = Number(ask('Покупательский лимит, ֏') || 0);
    act(() => api(`/admin/risk/${id}/action`, { body }), reload);
  };
  return (
    <T
      rows={rows}
      cols={[
        ['#', (r) => r.id],
        ['Сигнал', (r) => <b>{r.signal}</b>],
        ['Участник', (r) => <Link href={`/admin/users/${r.user_id}`}>{r.full_name}</Link>],
        ['Лот', (r) => (r.lot_id ? <Link href={`/admin/lots/${r.lot_id}`}>#{r.lot_id}</Link> : '—')],
        ['Детали', (r) => <code className="mono">{JSON.stringify(r.details)}</code>],
        ['Победы / отказы', (r) => `${r.wins} / ${r.refusals}`],
        ['Статус', (r) => r.status + (r.comment ? ` — ${r.comment}` : '')],
        [
          '',
          (r) =>
            r.status === 'open' && (
              <select className="input" defaultValue="" onChange={(e) => e.target.value && doAct(r.id, e.target.value)}>
                <option value="">Действие…</option>
                <option value="clear">Снять сигнал</option>
                <option value="request_funds">Запросить документы о средствах</option>
                <option value="set_limit">Изменить лимит</option>
                <option value="block">Заблокировать (лестница 6A.3)</option>
                <option value="to_lawyer">Передать юристу</option>
              </select>
            ),
        ],
      ]}
    />
  );
}

function Funds() {
  const [rows, reload] = useLoad('/admin/funds-proofs');
  return (
    <T
      rows={rows}
      cols={[
        ['#', (r) => r.id],
        ['Участник', (r) => `${r.full_name} (${r.phone})`],
        ['Документ', (r) => (r.url ? <a href={r.url} target="_blank">открыть (ссылка 5 мин)</a> : 'удалён')],
        ['Статус', (r) => r.status],
        [
          '',
          (r) =>
            r.status === 'pending' && (
              <div className="row gap-s">
                <button className="btn sm primary" onClick={() => act(() => api(`/admin/funds-proofs/${r.id}/decide`, { body: { approve: true, buyingPower: Number(ask('Лимит, ֏') || 0), comment: 'ok' } }), reload)}>
                  Одобрить
                </button>
                <button className="btn sm danger" onClick={() => act(() => api(`/admin/funds-proofs/${r.id}/decide`, { body: { approve: false, comment: ask('Причина') } }), reload)}>
                  Отказать
                </button>
              </div>
            ),
        ],
      ]}
    />
  );
}

function Sanctions() {
  const [rows, reload] = useLoad('/admin/sanctions');
  const { me } = useApp();
  return (
    <T
      rows={rows}
      cols={[
        ['#', (r) => r.id],
        ['Участник', (r) => <Link href={`/admin/users/${r.user_id}`}>{r.full_name}</Link>],
        ['Вид', (r) => r.kind + (r.strike_no ? ` (случай ${r.strike_no})` : '')],
        ['С', (r) => fmtDate(r.starts_at)],
        ['До', (r) => (r.ends_at ? fmtDate(r.ends_at) : '∞')],
        ['Причина', (r) => r.reason],
        ['', (r) => (r.voided_at ? 'не засчитан' : me?.role === 'admin' && <button className="btn sm" onClick={() => act(() => api(`/admin/sanctions/${r.id}/void`, { body: { comment: ask('Уважительная причина') } }), reload)}>Не засчитывать</button>)],
      ]}
    />
  );
}

function Disputes() {
  const [rows, reload] = useLoad('/admin/disputes');
  const [v, setV] = useState<any>(null);
  return (
    <div className="stack">
      <T
        rows={rows}
        cols={[
          ['#', (r) => r.id],
          ['Лот', (r) => <Link href={`/lots/${r.lot_id}`}>#{r.lot_id}</Link>],
          ['Участник', (r) => r.full_name],
          ['Сообщение', (r) => r.message],
          ['Статус', (r) => r.status + (r.admin_reply ? ' — ' + r.admin_reply : '')],
          [
            '',
            (r) => (
              <div className="row gap-s">
                <button className="btn sm" onClick={() => api(`/admin/disputes/${r.id}/verify`).then(setV)}>
                  Сверить
                </button>
                {r.status === 'open' && (
                  <button className="btn sm primary" onClick={() => act(() => api(`/admin/disputes/${r.id}/reply`, { body: { reply: ask('Ответ с доказательствами') } }), reload)}>
                    Ответить
                  </button>
                )}
              </div>
            ),
          ],
        ]}
      />
      {v && (
        <div className="card">
          <h3>Сверка квитанции</h3>
          <pre className="body">{JSON.stringify(v, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function Outages() {
  const [rows, reload] = useLoad('/admin/outages');
  const [f, setF] = useState({ startedAt: '', endedAt: '' });
  return (
    <div className="stack">
      <p className="muted small">SC-18: сервер сам фиксирует простой при перезапуске (по «пульсу»). Ставки по затронутым лотам не вскрываются до решения администратора.</p>
      <div className="card row gap">
        <label className="f">
          Начало (ISO)
          <input className="input" value={f.startedAt} onChange={(e) => setF({ ...f, startedAt: e.target.value })} placeholder="2026-11-02T10:00:00Z" />
        </label>
        <label className="f">
          Конец (ISO)
          <input className="input" value={f.endedAt} onChange={(e) => setF({ ...f, endedAt: e.target.value })} />
        </label>
        <button className="btn" onClick={() => act(() => api('/admin/outages', { body: f }), reload)}>
          Зафиксировать сбой вручную
        </button>
      </div>
      <T
        rows={rows}
        cols={[
          ['#', (r) => r.id],
          ['Период', (r) => `${fmtDate(r.started_at)} — ${fmtDate(r.ended_at)}`],
          ['Лоты', (r) => (r.lot_ids || []).join(', ')],
          ['Статус', (r) => r.status],
          [
            '',
            (r) =>
              r.status === 'detected' && (
                <div className="row gap-s">
                  <button className="btn sm primary" onClick={() => act(() => api(`/admin/outages/${r.id}/decide`, { body: { apply: true } }), reload)}>
                    Сдвинуть конец на 24 ч
                  </button>
                  <button className="btn sm" onClick={() => act(() => api(`/admin/outages/${r.id}/decide`, { body: { apply: false } }), reload)}>
                    Отклонить
                  </button>
                </div>
              ),
          ],
        ]}
      />
    </div>
  );
}

function Notifications() {
  const [rows] = useLoad('/admin/notifications');
  return (
    <T
      rows={rows}
      cols={[
        ['#', (r) => r.id],
        ['Канал', (r) => r.channel],
        ['Кому', (r) => r.to_addr],
        ['Шаблон', (r) => r.template],
        ['Тема', (r) => r.subject],
        ['Статус', (r) => <b className={r.status === 'failed' ? 'error' : r.status === 'sent' ? 'ok' : ''}>{r.status}</b>],
        ['Попыток', (r) => r.attempts],
        ['Ошибка', (r) => <span className="small">{r.last_error}</span>],
        ['Создано', (r) => fmtDate(r.created_at)],
      ]}
    />
  );
}

function Settings() {
  const [d, reload] = useLoad<any>('/admin/settings');
  if (!d) return <p className="muted">Загрузка…</p>;
  return (
    <div className="stack">
      <p className="muted small">Все числа правил — здесь. При одобрении лота текущие правила копируются в лот (rules_snapshot).</p>
      <T
        rows={Object.entries(d.values).filter(([k]) => k !== 'consent_versions')}
        cols={[
          ['Ключ', ([k]) => <code className="mono">{k}</code>],
          ['Значение', ([, v]) => JSON.stringify(v)],
          ['По умолчанию', ([k]) => <span className="muted">{JSON.stringify(d.defaults[k])}</span>],
          [
            '',
            ([k, v]) =>
              typeof v === 'number' && (
                <button
                  className="btn sm"
                  onClick={() => {
                    const nv = window.prompt(k, String(v));
                    if (nv !== null) act(() => api('/admin/settings/' + k, { method: 'PUT', body: { value: Number(nv) } }), reload);
                  }}
                >
                  Изменить
                </button>
              ),
          ],
        ]}
      />
    </div>
  );
}

function Plans() {
  const [rows, reload] = useLoad('/admin/plans');
  return (
    <T
      rows={rows}
      cols={[
        ['Код', (r) => r.code],
        ['Название', (r) => r.name_i18n.ru],
        ['Цена', (r) => fmtAmd(r.price)],
        ['Порог начальной цены', (r) => (r.max_start_price ? fmtAmd(r.max_start_price) : 'без ограничений')],
        ['Активен', (r) => (r.is_active ? 'да' : 'нет')],
        [
          '',
          (r) => (
            <button
              className="btn sm"
              onClick={() => {
                const p = window.prompt('Новая цена, ֏', String(r.price));
                if (p) act(() => api('/admin/plans/' + r.id, { method: 'PUT', body: { price: Number(p) } }), reload);
              }}
            >
              Цена
            </button>
          ),
        ],
      ]}
    />
  );
}

function Audit() {
  const [rows] = useLoad('/admin/audit');
  return (
    <T
      rows={rows}
      cols={[
        ['#', (r) => r.id],
        ['Время', (r) => fmtDate(r.at, { ms: true })],
        ['Кто', (r) => r.username || r.full_name || r.actor_id || 'system'],
        ['Действие', (r) => <b>{r.action}</b>],
        ['Объект', (r) => `${r.entity}:${r.entity_id ?? ''}`],
        ['Данные', (r) => <code className="mono">{r.after ? JSON.stringify(r.after).slice(0, 160) : ''}</code>],
      ]}
    />
  );
}

/** PRD v2 (F11.3): целостность журнала аудита и цепочек счетов участников. */
function Chain() {
  const [r, setR] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      setR(await api('/admin/chain/verify'));
    } finally {
      setBusy(false);
    }
  };
  const line = (ok: boolean, text: string) => <div className={'notice ' + (ok ? 'ok' : 'bad')}>{text}</div>;
  return (
    <div className="stack">
      <button className="btn primary" disabled={busy} onClick={run}>
        Проверить целостность цепочек
      </button>
      {r && (
        <>
          {line(r.audit.ok, r.audit.ok ? `✓ Журнал аудита: ${r.audit.rows} записей, цепочка цела` : `✕ Журнал аудита: расхождение в записи #${r.audit.brokenAt.refId} (${r.audit.brokenAt.reason})`)}
          {line(r.ledger.ok, r.ledger.ok ? `✓ Счета участников: ${r.ledger.chains} цепочек, ${r.ledger.rows} записей` : `✕ Счета: нарушено ${r.ledger.broken.length} цепочек — ${r.ledger.broken.map((b: any) => `${b.chain} #${b.brokenAt.refId}`).join(', ')}`)}
          <p className="small muted">Проверено {fmtDate(r.checkedAt)}. Суммы ставок в журнал не пишутся до итога (R-06) — только контрольные коды.</p>
        </>
      )}
    </div>
  );
}

/** PRD v2 (F11.4): проверка лицензий партнёров. */
function PartnersAdmin() {
  const [rows, reload] = useLoad<any[]>('/admin/partners');
  const decide = (id: number, action: string) => {
    const reason = action === 'approve' ? undefined : ask('Причина (увидит партнёр)');
    if (action !== 'approve' && !reason) return;
    act(() => api(`/admin/partners/${id}/decide`, { body: { action, reason } }), reload);
  };
  return (
    <T
      rows={rows}
      cols={[
        ['#', (r) => r.id],
        ['Партнёр', (r) => `${r.name} · ${r.kind} · ${r.city}`],
        ['Владелец', (r) => `${r.owner_name || '—'} (KYC: ${r.kyc_status})`],
        ['Лицензия', (r) => <a href={r.license_url} target="_blank">{r.license_no}</a>],
        ['Статус', (r) => <b className={r.status === 'pending' ? 'error' : ''}>{r.status}</b>],
        [
          '',
          (r) => (
            <div className="row gap-s">
              {r.status !== 'active' && (
                <button className="btn sm primary" onClick={() => decide(r.id, 'approve')}>
                  Одобрить
                </button>
              )}
              {r.status === 'pending' && (
                <button className="btn sm" onClick={() => decide(r.id, 'reject')}>
                  Отклонить
                </button>
              )}
              {r.status === 'active' && (
                <button className="btn sm danger" onClick={() => decide(r.id, 'block')}>
                  Заблокировать
                </button>
              )}
            </div>
          ),
        ],
      ]}
    />
  );
}

/** PRD v2 (F11.4): модерация рекламы — качество, формат, содержание, цена и сроки. */
function AdsAdmin() {
  const [rows, reload] = useLoad<any[]>('/admin/ads');
  const decide = (id: number, action: string) => {
    const reason = action === 'approve' ? undefined : ask('Причина (увидит партнёр)');
    if (action !== 'approve' && !reason) return;
    act(() => api(`/admin/ads/${id}/decide`, { body: { action, reason } }), reload);
  };
  return (
    <T
      rows={rows}
      cols={[
        ['#', (r) => r.id],
        ['Креатив', (r) => <img src={r.image} alt="" style={{ height: 40 }} />],
        ['Партнёр / текст', (r) => `${r.partner_name}: ${r.title}`],
        ['Место', (r) => r.slot],
        ['Период', (r) => `${String(r.starts_on).slice(0, 10)} — ${String(r.ends_on).slice(0, 10)}`],
        ['Цена', (r) => fmtAmd(r.price)],
        ['Ссылка', (r) => <a href={r.url} target="_blank" rel="noopener">{r.url}</a>],
        ['Статус', (r) => `${r.status} · ${r.impressions}/${r.clicks}`],
        [
          '',
          (r) => (
            <div className="row gap-s">
              {r.status === 'pending' && (
                <>
                  <button className="btn sm primary" onClick={() => decide(r.id, 'approve')}>
                    Одобрить
                  </button>
                  <button className="btn sm" onClick={() => decide(r.id, 'reject')}>
                    Вернуть
                  </button>
                </>
              )}
              {r.status === 'approved' && (
                <button className="btn sm danger" onClick={() => decide(r.id, 'stop')}>
                  Остановить
                </button>
              )}
            </div>
          ),
        ],
      ]}
    />
  );
}
