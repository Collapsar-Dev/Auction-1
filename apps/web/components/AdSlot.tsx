'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';

/** PRD v2 (F10.3): рекламное место. Показывается только одобренная модератором реклама в свои даты. */
export function AdSlot({ slot }: { slot: 'catalog' | 'lot' | 'partners' }) {
  const { t } = useApp();
  const [ads, setAds] = useState<any[]>([]);
  useEffect(() => {
    api(`/ads?slot=${slot}`).then(setAds).catch(() => setAds([]));
  }, [slot]);
  const a = ads[0];
  if (!a) return null;
  return (
    <a href={a.href} target="_blank" rel="noopener sponsored" className="card row gap" style={{ alignItems: 'center', textDecoration: 'none', color: 'inherit' }}>
      <span className="badge">{t('ad_label')}</span>
      <img src={a.image} alt="" style={{ height: 56, borderRadius: 8 }} />
      <span>
        <b>{a.partner}</b> — {a.title}
      </span>
    </a>
  );
}
