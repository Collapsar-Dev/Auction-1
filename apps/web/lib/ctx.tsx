'use client';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { DICT, ERRORS } from './dict';
import { Lang, fmtAmd, fmtDate } from './format';
import { api, ApiError } from './api';

export interface Me {
  id: number;
  phone: string | null;
  email: string | null;
  emailVerified: boolean;
  lang: Lang;
  kycStatus: string;
  kycRejectReason: string | null;
  level: number;
  fullName: string | null;
  role: 'user' | 'moderator' | 'admin';
  staff: boolean;
  username: string | null;
  sellerBlocked: boolean;
  sellerBlockReason: string | null;
  needsConsents: string[];
  limits: { tier: string; maxActiveBids: number; maxOpenDeals: number; buyingPower: number | null; validUntil: string | null };
  exposure: { activeBids: number[]; openDeals: number[] };
  sanction: { kind: string; ends_at: string | null; reason: string } | null;
}

interface Ctx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (k: string, p?: Record<string, any>) => string;
  tErr: (e: unknown) => string;
  me: Me | null;
  meLoaded: boolean;
  reloadMe: () => Promise<Me | null>;
  serverOffset: number; // serverTime - clientTime, мс
  syncTime: (iso: string) => void;
  devTools: boolean;
}

const C = createContext<Ctx>(null as any);
const fill = (s: string, p?: Record<string, any>) => (p ? s.replace(/\{(\w+)\}/g, (_, k) => (p[k] === undefined ? '' : String(p[k]))) : s);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('hy');
  const [me, setMe] = useState<Me | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  const [serverOffset, setOffset] = useState(0);
  const [devTools, setDevTools] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('lang') as Lang | null;
      if (saved && DICT[saved]) setLangState(saved);
    } catch {}
    api('/meta').then((m) => setDevTools(!!m.devTools)).catch(() => {});
    api('/time').then((r) => syncTime(r.serverTime)).catch(() => {});
  }, []);

  const reloadMe = useCallback(async () => {
    try {
      const m = await api<Me>('/me');
      setMe(m);
      setMeLoaded(true);
      return m;
    } catch {
      setMe(null);
      setMeLoaded(true);
      return null;
    }
  }, []);
  useEffect(() => {
    reloadMe();
  }, [reloadMe]);

  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem('lang', l);
    } catch {}
    document.documentElement.lang = l;
    if (me && !me.staff) api('/me/profile', { method: 'PUT', body: { lang: l } }).catch(() => {});
  };
  const t = useCallback((k: string, p?: Record<string, any>) => fill(DICT[lang][k] ?? DICT.ru[k] ?? k, p), [lang]);
  const tErr = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError) {
        const msg = ERRORS[lang][e.code] ?? ERRORS.ru[e.code];
        if (msg) {
          const money = ['BID_TOO_LOW', 'START_PRICE_TOO_LOW'].includes(e.code) ? ['min'] : ['buyingPower', 'used'];
          const p: Record<string, any> = {};
          for (const [k, v] of Object.entries(e.data || {})) p[k] = typeof v === 'number' && money.includes(k) ? fmtAmd(v) : k === 'minOpensAt' ? fmtDate(v as string) : v;
          return fill(msg, p);
        }
        return e.code;
      }
      return String((e as any)?.message ?? e);
    },
    [lang],
  );
  const syncTime = (iso: string) => setOffset(new Date(iso).getTime() - Date.now());

  return <C.Provider value={{ lang, setLang, t, tErr, me, meLoaded, reloadMe, serverOffset, syncTime, devTools }}>{children}</C.Provider>;
}

export const useApp = () => useContext(C);
