'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/ctx';
import { fmtAmd } from '@/lib/format';
import { STAGE_DOT } from './Shell';

// Схематичная карта Армении (без внешних тайлов и ключей): область — подпись в своём центре, лот — точка по координатам.
const B = { latMin: 38.8, latMax: 41.35, lngMin: 43.35, lngMax: 46.7 };
const W = 1000;
const H = Math.round((W * (B.latMax - B.latMin)) / ((B.lngMax - B.lngMin) * Math.cos((40 * Math.PI) / 180)));
const xy = (lat: number, lng: number) => ({ x: ((lng - B.lngMin) / (B.lngMax - B.lngMin)) * W, y: ((B.latMax - lat) / (B.latMax - B.latMin)) * H });
const REGIONS: [string, number, number][] = [
  ['Shirak', 40.82, 43.85], ['Lori', 40.97, 44.5], ['Tavush', 40.92, 45.12], ['Aragatsotn', 40.45, 44.18], ['Kotayk', 40.5, 44.78],
  ['Gegharkunik', 40.28, 45.25], ['Armavir', 40.12, 43.98], ['Yerevan', 40.18, 44.51], ['Ararat', 39.92, 44.68], ['Vayots Dzor', 39.74, 45.38], ['Syunik', 39.35, 46.15],
];

/** PRD v2 (F4, макет AprCatalog): каталог на карте. */
export function CatalogMap({ items }: { items: any[] }) {
  const { t } = useApp();
  const [hover, setHover] = useState<any>(null);
  const pins = items.filter((l) => l.geo);
  // близкие лоты (≤ 40 px на схеме) — одна точка с числом
  const clusters: { key: string; x: number; y: number; items: any[] }[] = [];
  for (const l of pins) {
    const p = xy(l.geo.lat, l.geo.lng);
    const c = clusters.find((k) => Math.hypot(k.x - p.x, k.y - p.y) < 40);
    if (c) c.items.push(l);
    else clusters.push({ key: 'c' + l.id, x: p.x, y: p.y, items: [l] });
  }
  return (
    <div className="card" style={{ padding: 12, position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 18, background: 'var(--surface-2)' }} role="img" aria-label={t('map_view')}>
        <rect x="8" y="8" width={W - 16} height={H - 16} rx="40" fill="var(--accent-soft)" stroke="var(--line)" strokeWidth="3" />
        {REGIONS.map(([r, lat, lng]) => {
          const p = xy(lat, lng);
          return (
            <text key={r} x={p.x} y={p.y + 34} textAnchor="middle" fontSize="20" fontWeight="700" fill="var(--muted)" opacity="0.5">
              {t('region_' + r)}
            </text>
          );
        })}
        {clusters.map((c) => {
          const one = c.items.length === 1 ? c.items[0] : null;
          const body = (
            <g onMouseEnter={() => setHover(c)} onClick={() => setHover(c)} style={{ cursor: 'pointer' }}>
              <circle cx={c.x} cy={c.y} r={one ? 16 : 24} fill={one ? STAGE_DOT[one.stage] ?? '#999' : 'var(--brand)'} stroke="#fff" strokeWidth="4" />
              {one ? (
                <text x={c.x} y={c.y - 24} textAnchor="middle" fontSize="18" fontWeight="800" fill="var(--text)">
                  {one.start_price < 1e7 ? (one.start_price / 1e6).toFixed(1).replace(/\.0$/, "") : Math.round(one.start_price / 1e6)}M
                </text>
              ) : (
                <text x={c.x} y={c.y + 7} textAnchor="middle" fontSize="20" fontWeight="800" fill="#fff">
                  {c.items.length}
                </text>
              )}
            </g>
          );
          return one ? (
            <Link key={c.key} href={`/lots/${one.id}`}>
              {body}
            </Link>
          ) : (
            <g key={c.key}>{body}</g>
          );
        })}
      </svg>
      {hover && (
        <div className="card small" style={{ position: 'absolute', left: 20, bottom: 44, padding: 12, maxWidth: 360 }} onMouseLeave={() => setHover(null)}>
          {hover.items.map((l: any) => (
            <Link key={l.id} href={`/lots/${l.id}`} style={{ display: 'block', color: 'inherit', padding: '4px 0' }}>
              <b>{fmtAmd(l.start_price)}</b> · {t('stage_' + l.stage)}
              <div className="muted">
                {t('type_' + l.property_type)} · {l.area_m2} {t('m2')} · {l.settlement}, {l.street}
              </div>
            </Link>
          ))}
        </div>
      )}
      <p className="small muted" style={{ margin: '8px 4px 0' }}>
        {t('map_note', { n: pins.length, total: items.length })}
      </p>
    </div>
  );
}
