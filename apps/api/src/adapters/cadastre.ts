import { Injectable } from '@nestjs/common';

export interface CadastreResult {
  found: boolean;
  /** собственник по выписке — тот же человек, что подал лот (в бою — сверка с данными проверки личности) */
  ownerIsApplicant: boolean;
  encumbrance: 'none' | 'arrest' | 'mortgage';
  areaM2: number | null;
  checkedAt: string;
}

/**
 * Песочница кадастра (как FakeGateway / FakeKyc). В бою — запрос в Комитет кадастра РА.
 * Номер ДД-ДДД-ДДДД-ДДДД. Последний блок:
 *   9999 — не найден; 0013 — арест; 0014 — ипотека; 0007 — собственник другой человек; иначе — собственник = заявитель.
 */
@Injectable()
export class FakeCadastre {
  async lookup(cadastralNo: string, now: Date): Promise<CadastreResult> {
    const no = String(cadastralNo || '').trim();
    const last = no.split('-').pop() ?? '';
    const base = { checkedAt: now.toISOString() };
    if (!/^\d{2}-\d{3}-\d{4}-\d{4}$/.test(no) || last === '9999') return { ...base, found: false, ownerIsApplicant: false, encumbrance: 'none', areaM2: null };
    return {
      ...base,
      found: true,
      ownerIsApplicant: last !== '0007',
      encumbrance: last === '0013' ? 'arrest' : last === '0014' ? 'mortgage' : 'none',
      areaM2: null,
    };
  }
}
