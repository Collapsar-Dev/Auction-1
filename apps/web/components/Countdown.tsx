'use client';
import { useEffect, useState } from 'react';
import { useApp } from '@/lib/ctx';

/** Таймер сверяется со временем сервера (SC-10): показывает разницу до момента target по серверным часам. */
export function useServerNow(tickMs = 1000) {
  const { serverOffset } = useApp();
  const [now, setNow] = useState(() => Date.now() + serverOffset);
  useEffect(() => {
    setNow(Date.now() + serverOffset);
    const id = setInterval(() => setNow(Date.now() + serverOffset), tickMs);
    return () => clearInterval(id);
  }, [serverOffset, tickMs]);
  return now;
}

export function Countdown({ to, onDone }: { to: string; onDone?: () => void }) {
  const { t } = useApp();
  const now = useServerNow();
  const left = Math.max(0, new Date(to).getTime() - now);
  useEffect(() => {
    if (left === 0 && onDone) onDone();
  }, [left === 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = Math.floor(left / 86400000);
  const h = Math.floor((left % 86400000) / 3600000);
  const m = Math.floor((left % 3600000) / 60000);
  const s = Math.floor((left % 60000) / 1000);
  return (
    <span className={'countdown' + (left < 3600000 ? ' urgent' : '')}>
      {d > 0 && `${d}${t('d')} `}
      {String(h).padStart(2, '0')}
      {t('h')} {String(m).padStart(2, '0')}
      {t('min')} {String(s).padStart(2, '0')}
      {t('s')}
    </span>
  );
}
