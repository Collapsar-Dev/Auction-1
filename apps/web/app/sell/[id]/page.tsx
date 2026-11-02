'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';
import { fmtAmd, fmtDate, fromYerevanInput, toYerevanInput } from '@/lib/format';
import { StatusBadge } from '@/components/Shell';

const REGIONS = ['Yerevan', 'Aragatsotn', 'Ararat', 'Armavir', 'Gegharkunik', 'Kotayk', 'Lori', 'Shirak', 'Syunik', 'Tavush', 'Vayots Dzor'];
const HEATING = ['central', 'gas', 'electric', 'none', 'other'];
const CONDITION = ['new', 'renovated', 'good', 'needs_repair', 'shell'];
const WALLS = ['stone', 'tuff', 'brick', 'concrete', 'wood', 'other'];
const BUILDING = ['stone', 'panel', 'monolith', 'brick', 'other'];

/** SC-04: мастер из 5 шагов, черновик сохраняется на каждом. */
export default function Wizard() {
  const { id } = useParams<{ id: string }>();
  const { t, tErr, devTools } = useApp();
  const [d, setD] = useState<any>(null);
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<any>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [accept, setAccept] = useState(false);
  const [done, setDone] = useState(false);

  const load = async (goTo?: number) => {
    const r = await api(`/lots/${id}/draft`);
    setD(r);
    const p = r.property;
    setForm({
      ...p,
      description_i18n: p.description_i18n || {},
      start_price: r.lot.start_price ?? '',
      opens_at: toYerevanInput(r.lot.opens_at),
      closes_at: toYerevanInput(r.lot.closes_at),
    });
    if (goTo) setStep(goTo);
    else setStep(Math.min(5, r.lot.draft_step || 1));
  };
  useEffect(() => {
    load().catch((e) => setErr(tErr(e)));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err && !d) return <p className="error">{err}</p>;
  if (!d) return <p className="muted">{t('loading')}</p>;
  const editable = ['draft', 'needs_changes'].includes(d.lot.raw_status);
  const set = (k: string, num = false) => (e: any) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : num ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value });
  const setDesc = (l: string) => (e: any) => setForm({ ...form, description_i18n: { ...form.description_i18n, [l]: e.target.value } });
  const n = (v: any) => (v === '' || v === null || v === undefined ? undefined : Number(v));

  const save = async (s: number) => {
    setErr('');
    setBusy(true);
    try {
      let data: any = {};
      if (s === 1) data = { property_type: form.property_type, region: form.region, settlement: form.settlement, street: form.street, cadastral_no: form.cadastral_no, geo_lat: n(form.geo_lat) ?? null, geo_lng: n(form.geo_lng) ?? null };
      if (s === 2) {
        data = { area_m2: n(form.area_m2), rooms: n(form.rooms), bathrooms: n(form.bathrooms), year_built: n(form.year_built), heating: form.heating, condition: form.condition, description_i18n: form.description_i18n };
        if (form.property_type === 'house') Object.assign(data, { land_area_m2: n(form.land_area_m2), floors: n(form.floors), wall_material: form.wall_material, gas: !!form.gas, water: !!form.water, sewage: !!form.sewage });
        else Object.assign(data, { floor: n(form.floor), building_floors: n(form.building_floors), building_type: form.building_type, has_elevator: !!form.has_elevator, has_balcony: !!form.has_balcony, parking: !!form.parking });
      }
      if (s === 4) data = { start_price: n(form.start_price), opens_at: fromYerevanInput(form.opens_at), closes_at: fromYerevanInput(form.closes_at) };
      await api(`/lots/${id}`, { method: 'PATCH', body: { step: s, data } });
      await load(s + 1);
    } catch (e) {
      setErr(tErr(e));
    } finally {
      setBusy(false);
    }
  };
  const upload = async (files: FileList | null, kind: 'photo' | 'extract') => {
    if (!files) return;
    setErr('');
    for (const f of Array.from(files)) {
      const fd = new FormData();
      fd.append('file', f);
      try {
        await api(`/lots/${id}/media?kind=${kind}`, { method: 'POST', form: fd });
      } catch (e) {
        setErr(tErr(e));
      }
    }
    load(3);
  };
  const demoPhotos = async () => {
    for (let i = 0; i < 10; i++) {
      const hue = (i * 37 + Number(id) * 50) % 360;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="hsl(${hue},45%,82%)"/><rect x="250" y="230" width="300" height="250" fill="hsl(${hue},40%,40%)"/><polygon points="220,240 400,110 580,240" fill="hsl(${(hue + 30) % 360},40%,30%)"/><text x="30" y="570" font-family="Arial" font-size="26" fill="#222">Demo ${i + 1}</text></svg>`;
      const fd = new FormData();
      fd.append('file', new Blob([svg], { type: 'image/svg+xml' }), `demo${i}.svg`);
      await api(`/lots/${id}/media?kind=photo`, { method: 'POST', form: fd }).catch((e) => setErr(tErr(e)));
    }
    const pdf = new Blob(['%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF'], { type: 'application/pdf' });
    if (!d.extracts.length) {
      const fd = new FormData();
      fd.append('file', pdf, 'extract.pdf');
      await api(`/lots/${id}/media?kind=extract`, { method: 'POST', form: fd }).catch(() => {});
    }
    load(3);
  };
  const removeMedia = async (mid: number) => {
    await api(`/lots/${id}/media/${mid}`, { method: 'DELETE' });
    load(3);
  };
  const submit = async () => {
    setErr('');
    try {
      await api(`/lots/${id}/submit`, { body: { acceptRules: accept } });
      setDone(true);
      load(5);
    } catch (e) {
      setErr(tErr(e));
    }
  };

  const L = d.limits;
  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <div className="row between gap">
        <h1 style={{ margin: 0 }}>
          {t('wizard_title')} #{id}
        </h1>
        <StatusBadge status={d.lot.raw_status} />
      </div>
      {d.moderation?.[0] && d.moderation[0].decision !== 'approve' && (
        <div className="notice warn">
          {t('moderation_comment')}: {d.moderation[0].comment}
        </div>
      )}
      {!editable && (
        <div className="notice">
          {done ? t('submitted') : t('status_' + d.lot.raw_status)} · <Link href={`/lots/${id}`}>{t('open')}</Link>
        </div>
      )}
      <div className="wizard-steps">
        {[1, 2, 3, 4, 5].map((s) => (
          <span key={s} className={s === step ? 'on' : s < (d.lot.draft_step || 1) ? 'done' : ''} onClick={() => editable && s <= (d.lot.draft_step || 1) && setStep(s)} style={{ cursor: 'pointer' }}>
            {s}. {t('w' + s)}
          </span>
        ))}
      </div>

      <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
        {step === 1 && (
          <div className="card stack">
            <div className="form-grid">
              <label className="f">
                {t('f_type')}
                <select className="input" value={form.property_type || ''} onChange={set('property_type')}>
                  <option value="">—</option>
                  <option value="house">{t('type_house')}</option>
                  <option value="apartment">{t('type_apartment')}</option>
                </select>
              </label>
              <label className="f">
                {t('f_region')}
                <select className="input" value={form.region || ''} onChange={set('region')}>
                  <option value="">—</option>
                  {REGIONS.map((r) => (
                    <option key={r} value={r}>
                      {t('region_' + r)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="f">
                {t('settlement')}
                <input className="input" value={form.settlement || ''} onChange={set('settlement')} />
              </label>
              <label className="f">
                {t('street')}
                <input className="input" value={form.street || ''} onChange={set('street')} />
              </label>
              <label className="f">
                {t('cadastral')}
                <input className="input" placeholder="01-001-0001-0001" value={form.cadastral_no || ''} onChange={set('cadastral_no')} />
              </label>
              <label className="f">
                {t('lat')}
                <input className="input" placeholder="40.18" value={form.geo_lat ?? ''} onChange={set('geo_lat')} />
              </label>
              <label className="f">
                {t('lng')}
                <input className="input" placeholder="44.51" value={form.geo_lng ?? ''} onChange={set('geo_lng')} />
              </label>
            </div>
            <Nav onNext={() => save(1)} busy={busy} />
          </div>
        )}
        {step === 2 && (
          <div className="card stack">
            <div className="form-grid">
              <Num label={t('area') + ', ' + t('m2')} v={form.area_m2} on={set('area_m2', true)} />
              <Num label={t('rooms')} v={form.rooms} on={set('rooms', true)} />
              <Num label={t('bathrooms')} v={form.bathrooms} on={set('bathrooms', true)} />
              <Num label={t('year_built')} v={form.year_built} on={set('year_built', true)} />
              <Sel label={t('heating')} v={form.heating} on={set('heating')} opts={HEATING} />
              <Sel label={t('condition')} v={form.condition} on={set('condition')} opts={CONDITION} />
              {form.property_type === 'house' ? (
                <>
                  <Num label={t('land_area') + ', ' + t('m2')} v={form.land_area_m2} on={set('land_area_m2', true)} />
                  <Num label={t('floors')} v={form.floors} on={set('floors', true)} />
                  <Sel label={t('wall_material')} v={form.wall_material} on={set('wall_material')} opts={WALLS} />
                  <Chk label={t('gas')} v={form.gas} on={set('gas')} />
                  <Chk label={t('water')} v={form.water} on={set('water')} />
                  <Chk label={t('sewage')} v={form.sewage} on={set('sewage')} />
                </>
              ) : (
                <>
                  <Num label={t('floor')} v={form.floor} on={set('floor', true)} />
                  <Num label={t('floors')} v={form.building_floors} on={set('building_floors', true)} />
                  <Sel label={t('building_type')} v={form.building_type} on={set('building_type')} opts={BUILDING} />
                  <Chk label={t('elevator')} v={form.has_elevator} on={set('has_elevator')} />
                  <Chk label={t('balcony')} v={form.has_balcony} on={set('has_balcony')} />
                  <Chk label={t('parking')} v={form.parking} on={set('parking')} />
                </>
              )}
            </div>
            {['hy', 'ru', 'en'].map((l) => (
              <label key={l} className="f">
                {t('description_' + l)}
                <textarea className="input" value={form.description_i18n?.[l] || ''} onChange={setDesc(l)} />
              </label>
            ))}
            <Nav onBack={() => setStep(1)} onNext={() => save(2)} busy={busy} />
          </div>
        )}
        {step === 3 && (
          <div className="card stack">
            <h3>
              {t('photos')} ({d.photos.length}) <span className="muted small">{t('photos_hint', { min: L.photosMin, max: L.photosMax })}</span>
            </h3>
            <div className="photo-grid">
              {d.photos.map((p: any) => (
                <div key={p.id} className="ph" style={{ backgroundImage: `url(${p.url})` }}>
                  {editable && (
                    <button className="btn sm" onClick={() => removeMedia(p.id)}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
            <input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(e) => upload(e.target.files, 'photo')} />
            {devTools && editable && (
              <button className="btn sm" style={{ alignSelf: 'start' }} onClick={demoPhotos}>
                {t('add_demo_photos')}
              </button>
            )}
            <h3>{t('extract')}</h3>
            <div className="small">{d.extracts.length ? `✓ ${d.extracts.length}` : '—'}</div>
            <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => upload(e.target.files, 'extract')} />
            <Nav onBack={() => setStep(2)} onNext={() => save(3)} busy={busy} />
          </div>
        )}
        {step === 4 && (
          <div className="card stack">
            <p className="small muted">{t('terms_hint', { min: fmtAmd(L.minStartPrice), dmin: L.durationMinHours, dmax: L.durationMaxHours, delay: L.startDelayHours })}</p>
            <div className="form-grid">
              <Num label={t('start_price') + ', ֏'} v={form.start_price} on={set('start_price', true)} />
              <label className="f">
                {t('opens_at')} (Yerevan)
                <input className="input" type="datetime-local" value={form.opens_at || ''} onChange={set('opens_at')} />
              </label>
              <label className="f">
                {t('closes_at')} (Yerevan)
                <input className="input" type="datetime-local" value={form.closes_at || ''} onChange={set('closes_at')} />
              </label>
            </div>
            {d.preview && (
              <div className="kv">
                <span>{t('your_deposit_for_buyers')}</span>
                <span>{fmtAmd(d.preview.deposit)}</span>
                <span>{t('your_commission')}</span>
                <span>≥ {fmtAmd(d.preview.commission)}</span>
                <span>{t('required_plan')}</span>
                <span>{d.preview.suggestedPlan}</span>
              </div>
            )}
            <Nav onBack={() => setStep(3)} onNext={() => save(4)} busy={busy} />
          </div>
        )}
        {step === 5 && (
          <div className="card stack">
            <h3>{t('w5')}</h3>
            <div className="kv">
              <span>{t('f_type')}</span>
              <span>{form.property_type && t('type_' + form.property_type)}</span>
              <span>{t('address')}</span>
              <span>
                {form.region && t('region_' + form.region)}, {form.settlement}, {form.street}
              </span>
              <span>{t('area')}</span>
              <span>
                {form.area_m2} {t('m2')}, {form.rooms} {t('rooms_n')}
              </span>
              <span>{t('photos')}</span>
              <span>{d.photos.length}</span>
              <span>{t('start_price')}</span>
              <span>{fmtAmd(d.lot.start_price)}</span>
              <span>{t('opens_at')}</span>
              <span>{fmtDate(d.lot.opens_at)}</span>
              <span>{t('closes_at')}</span>
              <span>{fmtDate(d.lot.closes_at)}</span>
              <span>{t('deposit')}</span>
              <span>{fmtAmd(d.preview?.deposit)}</span>
              <span>{t('commission')}</span>
              <span>{fmtAmd(d.preview?.commission)}</span>
            </div>
            <label className="check small">
              <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /> {t('seller_offer')}
            </label>
            {d.submitBlockers.length > 0 && (
              <div className="notice warn">
                {t('missing')}:{' '}
                {d.submitBlockers.map((b: string) => (
                  <Link key={b} href={b === 'CARD_REQUIRED' ? '/account?tab=cards' : '/account?tab=profile'} style={{ marginRight: 8 }}>
                    {b === 'KYC_REQUIRED' ? t('step_kyc') : b === 'CARD_REQUIRED' ? t('bind_card') : b}
                  </Link>
                ))}
              </div>
            )}
            <div className="row gap">
              <button className="btn ghost" onClick={() => setStep(4)}>
                {t('back')}
              </button>
              <button className="btn primary" disabled={!accept || d.submitBlockers.length > 0} onClick={submit}>
                {t('submit')}
              </button>
            </div>
          </div>
        )}
      </fieldset>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

function Nav({ onBack, onNext, busy }: { onBack?: () => void; onNext: () => void; busy: boolean }) {
  const { t } = useApp();
  return (
    <div className="row gap">
      {onBack && (
        <button className="btn ghost" onClick={onBack}>
          {t('back')}
        </button>
      )}
      <button className="btn primary" disabled={busy} onClick={onNext}>
        {t('next')}
      </button>
    </div>
  );
}
const Num = ({ label, v, on }: { label: string; v: any; on: any }) => (
  <label className="f">
    {label}
    <input className="input" inputMode="numeric" value={v ?? ''} onChange={on} />
  </label>
);
const Sel = ({ label, v, on, opts }: { label: string; v: any; on: any; opts: string[] }) => (
  <label className="f">
    {label}
    <select className="input" value={v || ''} onChange={on}>
      <option value="">—</option>
      {opts.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  </label>
);
const Chk = ({ label, v, on }: { label: string; v: any; on: any }) => (
  <label className="row gap-s" style={{ paddingTop: 18 }}>
    <input type="checkbox" checked={!!v} onChange={on} /> {label}
  </label>
);
