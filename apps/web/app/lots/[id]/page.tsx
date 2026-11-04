'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useApp } from '@/lib/ctx';
import { fmtAmd, fmtDate } from '@/lib/format';
import { Countdown } from '@/components/Countdown';
import { StageBadge } from '@/components/Shell';
import { BidBlock } from '@/components/BidBlock';
import { ResultTable } from '@/components/ResultTable';
import { VerifiedDocs, Valuations } from '@/components/LotExtras';

export default function LotPage() {
  const { id } = useParams<{ id: string }>();
  const { t, lang, me, syncTime, tErr } = useApp();
  const router = useRouter();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [img, setImg] = useState(0);
  const timer = useRef<any>(null);

  const load = useCallback(async () => {
    try {
      const r = await api(`/lots/${id}`);
      setD(r);
      syncTime(r.serverTime);
    } catch (e) {
      setErr(tErr(e));
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load, me?.id]);
  // во время вскрытия — опрашиваем часто, во время торгов — редко
  useEffect(() => {
    clearInterval(timer.current);
    const st = d?.lot?.status;
    if (st === 'revealing') timer.current = setInterval(load, 2500);
    else if (st === 'live' || st === 'scheduled') timer.current = setInterval(load, 20000);
    return () => clearInterval(timer.current);
  }, [d?.lot?.status, load]);

  if (err) return <p className="error">{err}</p>;
  if (!d) return <p className="muted">{t('loading')}</p>;
  const { lot, property: p } = d;
  const desc = p.description_i18n?.[lang] || p.description_i18n?.ru || p.description_i18n?.en || '';
  const yn = (v: boolean | null) => (v === null || v === undefined ? '—' : v ? t('yes') : t('no'));
  const specs: [string, any][] = [
    [t('area'), `${p.area_m2} ${t('m2')}`],
    [t('rooms'), p.rooms],
    [t('bathrooms'), p.bathrooms],
    [t('year_built'), p.year_built],
    [t('heating'), p.heating],
    [t('condition'), p.condition],
    ...(p.property_type === 'house'
      ? ([
          [t('land_area'), `${p.land_area_m2} ${t('m2')}`],
          [t('floors'), p.floors],
          [t('wall_material'), p.wall_material],
          [t('gas'), yn(p.gas)],
          [t('water'), yn(p.water)],
          [t('sewage'), yn(p.sewage)],
        ] as [string, any][])
      : ([
          [t('floor'), `${p.floor} / ${p.building_floors}`],
          [t('building_type'), p.building_type],
          [t('elevator'), yn(p.has_elevator)],
          [t('balcony'), yn(p.has_balcony)],
          [t('parking'), yn(p.parking)],
        ] as [string, any][])),
  ];
  const toggleFav = async () => {
    if (!me) return router.push(`/login?next=/lots/${id}`);
    await api(`/me/favorites/${id}`, { method: d.isFavorite ? 'DELETE' : 'PUT' });
    load();
  };
  const bbox = p.geo_lat ? `${p.geo_lng - 0.01},${p.geo_lat - 0.006},${p.geo_lng + 0.01},${p.geo_lat + 0.006}` : null;

  return (
    <div className="lot-layout">
      <div className="stack">
        <div className="row between gap">
          <h1 style={{ margin: 0 }}>
            {t('type_' + p.property_type)} · {p.settlement}
          </h1>
          <StageBadge stage={lot.stage} />
        </div>
        <div className="muted">
          {t('region_' + p.region)}, {p.settlement}, {p.street} · #{lot.id}
        </div>
        <div className="gallery">
          <div className="main-img" style={{ backgroundImage: d.photos[img] ? `url(${d.photos[img]})` : undefined }} />
          <div className="thumbs">
            {d.photos.map((ph: string, i: number) => (
              <button key={ph} className={i === img ? 'on' : ''} style={{ backgroundImage: `url(${ph})` }} onClick={() => setImg(i)} aria-label={`photo ${i + 1}`} />
            ))}
          </div>
        </div>
        {d.result && (
          <div className="card">
            <ResultTable result={d.result} lotId={lot.id} startPrice={lot.start_price} reload={load} />
          </div>
        )}
        <div className="card">
          <h2>{t('specs')}</h2>
          <div className="specs">
            {specs.map(([k, v]) => (
              <div key={k}>
                <span>{k}</span>
                <span>{v ?? '—'}</span>
              </div>
            ))}
          </div>
          {desc && (
            <>
              <h3 style={{ marginTop: 16 }}>{t('description')}</h3>
              <p className="desc">{desc}</p>
            </>
          )}
        </div>
        <Valuations items={d.valuations} startPrice={lot.start_price} />
        {bbox && (
          <div className="card">
            <h3>
              {t('address')}: {p.settlement}, {p.street}
            </h3>
            <iframe className="map" title="map" loading="lazy" src={`https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik`} />
          </div>
        )}
      </div>

      <aside className="side stack">
        <div className="card stack">
          <div>
            <div className="muted small">{t('start_price')}</div>
            <div className="big-price">{fmtAmd(lot.start_price)}</div>
          </div>
          <div className="kv">
            <span>{t('opens_at')}</span>
            <span>{fmtDate(lot.opens_at)}</span>
            <span>{t('closes_at')}</span>
            <span>
              {fmtDate(lot.closes_at)}
              {lot.extended_at ? ' ⚠' : ''}
            </span>
            {lot.status === 'scheduled' && (
              <>
                <span>{t('starts_in')}</span>
                <Countdown to={lot.opens_at} onDone={load} />
              </>
            )}
            {lot.status === 'live' && (
              <>
                <span>{t('ends_in')}</span>
                <Countdown to={lot.closes_at} onDone={load} />
              </>
            )}
            <span>{t('deposit')}</span>
            <span>{fmtAmd(lot.deposit_amount)}</span>
            {d.requiredPlan && (
              <>
                <span>{t('required_plan')}</span>
                <span>
                  {d.requiredPlan.name_i18n[lang]} · {fmtAmd(d.requiredPlan.price)}
                  {t('per_year')}
                </span>
              </>
            )}
          </div>
          {!d.isSeller && (
            <button className="btn sm ghost" onClick={toggleFav}>
              {d.isFavorite ? t('favorite_remove') : t('favorite_add')}
            </button>
          )}
        </div>
        <BidBlock data={d} reload={load} />
        <VerifiedDocs v={d.verification} />
        <div className="card">
          <h3>{t('rules_short')}</h3>
          <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <li key={i}>{t('rules_short_' + i)}</li>
            ))}
          </ul>
          <Link href="/rules" className="small">
            {t('rules_page')} →
          </Link>
        </div>
      </aside>
    </div>
  );
}
