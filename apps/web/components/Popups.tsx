'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';

/** PRD v2: pop-up в кабинете (возврат или начисление попытки и т. п.) — показывается, пока не закрыт. */
export function Popups() {
  const { me, t } = useApp();
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => {
    if (me) api('/me/popups').then(setItems).catch(() => setItems([]));
  }, [me?.id]);
  const p = items[0];
  if (!p) return null;
  const close = async () => {
    await api(`/me/popups/${p.id}/read`, { body: {} }).catch(() => undefined);
    setItems(items.slice(1));
  };
  return (
    <div className="modal-bg" role="dialog" aria-modal="true">
      <div className="modal stack">
        <h3>{p.subject}</h3>
        <p>{p.body}</p>
        <button className="btn primary" onClick={close}>
          {t('popup_ok')}
        </button>
      </div>
    </div>
  );
}
