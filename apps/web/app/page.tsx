'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';
import { fmtAmd, fmtDate } from '@/lib/format';
import { Countdown } from '@/components/Countdown';
import { StageBadge, STAGES } from '@/components/Shell';
import { AdSlot } from '@/components/AdSlot';

const REGIONS = ['Yerevan', 'Aragatsotn', 'Ararat', 'Armavir', 'Gegharkunik', 'Kotayk', 'Lori', 'Shirak', 'Syunik', 'Tavush', 'Vayots Dzor'];

export default function Catalog() {
  const { t, syncTime } = useApp();
  const [f, setF] = useState<Record<string, string>>({ sort: 'stage' });
  const [items, setItems] = useState<any[] | null>(null);
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
      <section className="hero">
        <h1>{t('hero_title')}</h1>
        <p>{t('hero_text')}</p>
      </section>
      <AdSlot slot="catalog" />
      <div className="filters">
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
      {items === null ? (
        <p className="muted">{t('loading')}</p>
      ) : items.length === 0 ? (
        <p className="muted">{t('nothing_found')}</p>
      ) : (
        <div className="grid">
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
