'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';
import { fmtAmd, fmtDate } from '@/lib/format';
import { Countdown } from '@/components/Countdown';
import { StageBadge, STAGES } from '@/components/Shell';
import { AdSlot } from '@/components/AdSlot';
import { CatalogMap } from '@/components/CatalogMap';

const REGIONS = ['Yerevan', 'Aragatsotn', 'Ararat', 'Armavir', 'Gegharkunik', 'Kotayk', 'Lori', 'Shirak', 'Syunik', 'Tavush', 'Vayots Dzor'];

export default function Catalog() {
  const { t, syncTime } = useApp();
  const [f, setF] = useState<Record<string, string>>({ sort: 'stage' });
  const [items, setItems] = useState<any[] | null>(null);
  const [view, setView] = useState<'grid' | 'map'>('grid'); // макет AprCatalog: сетка / карта
  const [showF, setShowF] = useState(false); // на телефоне фильтры свёрнуты
  useEffect(() => {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    api('/lots?' + q).then((r) => {
      setItems(r.items);
      syncTime(r.serverTime);
    });
  }, [f]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });

  return (
    <>
      <SearchHero f={f} setF={setF} items={items} />
      <AdSlot slot="catalog" />
      <button className="btn filters-toggle" onClick={() => setShowF(!showF)}>
        {t('filters')} {Object.keys(f).filter((k) => k !== 'sort' && f[k]).length ? `· ${Object.keys(f).filter((k) => k !== 'sort' && f[k]).length}` : ''} {showF ? '▲' : '▼'}
      </button>
      <div className={'filters' + (showF ? '' : ' collapsed')}>
        <label className="f">
          {t('f_type')}
          <select className="input" value={f.type || ''} onChange={set('type')}>
            <option value="">{t('f_any')}</option>
            <option value="house">{t('type_house')}</option>
            <option value="apartment">{t('type_apartment')}</option>
          </select>
        </label>
        <label className="f">
          {t('f_region')}
          <select className="input" value={f.region || ''} onChange={set('region')}>
            <option value="">{t('f_any')}</option>
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {t('region_' + r)}
              </option>
            ))}
          </select>
        </label>
        <label className="f">
          {t('f_price')} {t('f_from')}
          <input className="input" inputMode="numeric" value={f.priceMin || ''} onChange={set('priceMin')} />
        </label>
        <label className="f">
          {t('f_price')} {t('f_to')}
          <input className="input" inputMode="numeric" value={f.priceMax || ''} onChange={set('priceMax')} />
        </label>
        <label className="f">
          {t('f_area')} {t('f_from')}
          <input className="input" inputMode="numeric" value={f.areaMin || ''} onChange={set('areaMin')} />
        </label>
        <label className="f">
          {t('f_area')} {t('f_to')}
          <input className="input" inputMode="numeric" value={f.areaMax || ''} onChange={set('areaMax')} />
        </label>
        <label className="f">
          {t('f_rooms')}
          <select className="input" value={f.rooms || ''} onChange={set('rooms')}>
            <option value="">{t('f_any')}</option>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value="5">5+</option>
          </select>
        </label>
        <label className="f">
          {t('f_status')}
          <select className="input" value={f.stage || ''} onChange={set('stage')}>
            <option value="">{t('f_any')}</option>
            {STAGES.map((st) => (
              <option key={st} value={st}>
                {t('stage_' + st)}
              </option>
            ))}
          </select>
        </label>
        <label className="f">
          {t('sort')}
          <select className="input" value={f.sort} onChange={set('sort')}>
            <option value="stage">{t('sort_stage')}</option>
            <option value="ending">{t('sort_ending')}</option>
            <option value="new">{t('sort_new')}</option>
            <option value="price_asc">{t('sort_price_asc')}</option>
            <option value="price_desc">{t('sort_price_desc')}</option>
          </select>
        </label>
        <button className="btn ghost" onClick={() => setF({ sort: 'stage' })}>
          {t('reset')}
        </button>
      </div>
      <div id="results-anchor" />
      <div className="row between gap" style={{ marginBottom: 12 }}>
        <span className="muted small">{items ? t('found_n', { n: items.length }) : ''}</span>
        <div className="view-toggle">
          <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')}>
            {t('grid_view')}
          </button>
          <button className={view === 'map' ? 'on' : ''} onClick={() => setView('map')}>
            {t('map_view')}
          </button>
        </div>
      </div>
      {items === null ? (
        <p className="muted">{t('loading')}</p>
      ) : items.length === 0 ? (
        <p className="muted">{t('nothing_found')}</p>
      ) : view === 'map' ? (
        <CatalogMap items={items} />
      ) : (
        <div className="grid" id="results">
          {items.map((l) => (
            <LotTile key={l.id} l={l} />
          ))}
        </div>
      )}
    </>
  );
}

function LotTile({ l }: { l: any }) {
  const { t } = useApp();
  return (
    <Link href={`/lots/${l.id}`} className="lot-tile">
      <div className="img" style={{ backgroundImage: l.cover ? `url(${l.cover})` : undefined }}>
        <span className="badge-wrap" style={{ position: 'absolute', top: 10, left: 10 }}>
          <StageBadge stage={l.stage} />
        </span>
      </div>
      <div className="body">
        <div className="price">{fmtAmd(l.start_price)}</div>
        <div>
          {t('type_' + l.property_type)} · {l.area_m2} {t('m2')} · {l.rooms} {t('rooms_n')}
        </div>
        <div className="meta">
          {t('region_' + l.region)}, {l.settlement}, {l.street}
        </div>
        <div className="meta" style={{ marginTop: 6 }}>
          {l.status === 'scheduled' && (
            <>
              {t('starts_in')} <Countdown to={l.opens_at} />
            </>
          )}
          {l.status === 'live' && (
            <>
              {t('ends_in')} <Countdown to={l.closes_at} />
            </>
          )}
          {!['scheduled', 'live'].includes(l.status) && (
            <>
              {t('ended_at')} {fmtDate(l.closes_at)}
            </>
          )}
        </div>
      </div>
    </Link>
  );
}

/** Вариант 8 «Поиск на первом экране» (канвас), в стиле «Абрикос»: поля управляют каталогом ниже. */
function SearchHero({ f, setF, items }: { f: Record<string, string>; setF: (v: Record<string, string>) => void; items: any[] | null }) {
  const { t } = useApp();
  const live = (items || []).filter((l) => l.stage === 'in_progress').length;
  const go = () => document.getElementById('results-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const chips: [string, Record<string, string>][] = [
    [t('chip_yerevan'), { region: 'Yerevan' }],
    [t('chip_houses'), { type: 'house' }],
    [t('chip_upto20'), { priceMax: '20000000' }],
    [t('stage_in_progress'), { stage: 'in_progress' }],
    [t('stage_registration_open'), { stage: 'registration_open' }],
  ];
  const on = (c: Record<string, string>) => Object.entries(c).every(([k, v]) => f[k] === v);
  const toggle = (c: Record<string, string>) => {
    const next = { ...f };
    if (on(c)) Object.keys(c).forEach((k) => delete next[k]);
    else Object.assign(next, c);
    setF(next);
  };
  return (
    <section className="search-hero">
      <svg aria-hidden="true" className="sh-art" viewBox="0 0 1280 420" preserveAspectRatio="xMidYMax slice">
        <circle cx="1040" cy="110" r="70" fill="var(--accent)" opacity=".18" />
        <path d="M0 250 L200 120 L360 200 L560 70 L760 190 L980 90 L1280 210 V420 H0Z" fill="var(--hero-2)" />
        <path d="M0 330 L300 250 L620 310 L900 240 L1280 310 V420 H0Z" fill="var(--hero-3)" />
        <g fill="var(--accent)" opacity=".85">
          <rect x="160" y="340" width="12" height="10" />
          <rect x="186" y="340" width="12" height="10" />
          <rect x="420" y="360" width="12" height="10" />
          <rect x="900" y="345" width="12" height="10" />
          <rect x="926" y="345" width="12" height="10" />
          <rect x="1100" y="370" width="12" height="10" />
        </g>
      </svg>
      <div className="sh-body">
        {live > 0 && (
          <span className="sh-live">
            <span style={{ color: 'var(--brand)' }}>●</span> {t('live_now', { n: live })}
          </span>
        )}
        <h1>{t('hero_title')}</h1>
        <p>{t('hero_text')}</p>
        <form
          className="sh-form"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <label>
            {t('f_region')}
            <select value={f.region || ''} onChange={(e) => setF({ ...f, region: e.target.value })}>
              <option value="">{t('f_any')}</option>
              {REGIONS.map((r) => (
                <option key={r} value={r}>
                  {t('region_' + r)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('f_type')}
            <select value={f.type || ''} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="">{t('f_any')}</option>
              <option value="apartment">{t('type_apartment')}</option>
              <option value="house">{t('type_house')}</option>
            </select>
          </label>
          <label>
            {t('budget_to')}
            <select value={f.priceMax || ''} onChange={(e) => setF({ ...f, priceMax: e.target.value })}>
              <option value="">{t('f_any')}</option>
              {[10, 20, 40, 60, 100, 200].map((m) => (
                <option key={m} value={String(m * 1e6)}>
                  {fmtAmd(m * 1e6)}
                </option>
              ))}
            </select>
          </label>
          <button className="btn primary">{items ? t('find_n', { n: items.length }) : t('find')}</button>
        </form>
        <div className="sh-chips">
          {chips.map(([l, c]) => (
            <button key={l} type="button" className={on(c) ? 'on' : ''} onClick={() => toggle(c)}>
              {l}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
