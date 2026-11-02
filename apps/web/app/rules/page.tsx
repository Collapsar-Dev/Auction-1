'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useApp } from '@/lib/ctx';
import { fmtAmd } from '@/lib/format';

type Sec = { id: string; title: string; items: string[] };

/** Правила торгов простым языком, соглашение, политика данных, контакты (3.2). Числа берутся из настроек. */
export default function Rules() {
  const { lang } = useApp();
  const [m, setM] = useState<any>(null);
  useEffect(() => {
    api('/meta').then(setM);
  }, []);
  if (!m) return null;
  const r = m.rules;
  const full = m.plans.find((p: any) => p.code === 'full');
  const basic = m.plans.find((p: any) => p.code === 'basic');
  const v = {
    min: fmtAmd(r.min_start_price),
    dmin: r.duration_min_hours / 24,
    dmax: r.duration_max_hours / 24,
    depPct: r.deposit_bp / 100,
    depMin: fmtAmd(r.deposit_min),
    depMax: fmtAmd(r.deposit_max),
    comPct: r.commission_bp / 100,
    comMin: fmtAmd(r.commission_min),
    hours: r.deal_confirm_hours,
    notary: r.notary_days,
    basic: basic ? fmtAmd(basic.price) : '',
    basicMax: basic?.max_start_price ? fmtAmd(basic.max_start_price) : '',
    full: full ? fmtAmd(full.price) : '',
    bids: r.standard_max_active_bids,
  };
  const S: Record<string, Sec[]> = {
    ru: [
      {
        id: 'rules',
        title: 'Правила торгов (аукцион тип 1)',
        items: [
          `Продавец задаёт начальную цену (не меньше ${v.min}) и заранее соглашается продать за любую ставку выше неё.`,
          `У аукциона есть точное время начала и конца (от ${v.dmin} до ${v.dmax} дней). Время на сайте — ереванское, сроки считает сервер.`,
          'Каждый участник делает ровно одну ставку — любое целое число драмов больше начальной цены, без шага и округления.',
          'Ставку нельзя изменить, повысить, снизить или отозвать. Повторная ставка отклоняется.',
          'До конца аукциона о ставках не видно ничего: ни сумм, ни числа ставок, ни числа участников — никому, включая продавца и сотрудников платформы. Вы видите только свою ставку.',
          'Ставка принята, если сервер получил её строго до времени конца. Время конца не продлевается из-за поздних ставок. Исключение — сбой сайта в последний час дольше 5 минут: тогда конец сдвигается на 24 часа, участники получают SMS.',
          'В момент конца все ставки открываются одновременно для всех: суммы от большей к меньшей, время каждой и победитель. Рядом с каждой ставкой показывается ID участника (без имени и телефона). Каждый участник и продавец получают письмо с итогами.',
          'Побеждает самая высокая ставка; при равных суммах — та, что пришла раньше по времени сервера. Победитель платит свою ставку.',
          `Для участия нужны: подтверждённый email, проверка личности, годовой доступ (Базовый ${v.basic} — лоты до ${v.basicMax}; Полный ${v.full} — все лоты) и депозит по лоту: ${v.depPct}% от начальной цены, не меньше ${v.depMin} и не больше ${v.depMax}. Депозит блокируется на карте и не списывается.`,
          `Обычный участник может одновременно иметь не больше ${v.bids} ставок без итога (включая незакрытые сделки) и одну открытую сделку. Статус «Инвестор» с подтверждением средств повышает лимит.`,
          `После итога победитель и продавец подтверждают сделку в течение ${v.hours} часов и получают контакты друг друга. Договор подписывается у нотариуса в течение ${v.notary} дней.`,
          'Отказ или молчание победителя: лот «не состоялся», депозит остаётся заблокированным до решения администратора, ставки блокируются на 30 дней (второй случай — 180 дней, третий — бессрочно).',
          'Второй шанс: если победитель откажется от сделки в течение 5 дней после итога, лот переходит участнику со 2-го места по его ставке. Поэтому депозит 2-го места держится эти 5 дней.',
          'Отказ продавца: депозит победителя освобождается, продавцу блокируется создание новых лотов.',
          `Комиссия платформы — только с продавца и только если сделка состоялась: ${v.comPct}% от цены, не меньше ${v.comMin}.`,
          'Итог можно оспорить в течение 48 часов: администратор сверит ваш контрольный код с журналом ставок.',
        ],
      },
      { id: 'terms', title: 'Пользовательское соглашение (v1.0)', items: ['Сайт проводит аукционы и фиксирует результат; сделка по объекту заключается у нотариуса вне сайта.', 'Один человек — один аккаунт. Продавец и его родственники не участвуют в своём лоте.', 'Годовой доступ — оплата сервиса платформы, не возвращается и не засчитывается в цену объекта.'] },
      { id: 'privacy', title: 'Политика обработки данных (v1.0)', items: ['Документ и селфи хранятся у KYC-сервиса. У нас — только итог проверки, ФИО, дата рождения и хэш номера документа.', 'Номер карты вводится только на странице банка; мы храним маску и идентификатор привязки.', 'Суммы ставок до конца аукциона хранятся только в зашифрованном виде и не видны никому.'] },
      { id: 'contacts', title: 'Контакты', items: ['Email: support@auction.local', 'Телефон: +374 10 000000 (демо)'] },
    ],
    en: [
      {
        id: 'rules',
        title: 'Auction rules (type 1)',
        items: [
          `The seller sets a starting price (at least ${v.min}) and agrees in advance to sell for any bid above it.`,
          `Each auction has an exact start and end time (${v.dmin}–${v.dmax} days). Times are shown in Yerevan time; the server keeps the clock.`,
          'Each participant places exactly one bid — any whole number of dram above the starting price, no increments or rounding.',
          'A bid cannot be changed, raised, lowered or withdrawn. A second bid is rejected.',
          'Until the end nothing about bids is visible: no amounts, no number of bids or participants — to anyone, including the seller and staff. You only see your own bid.',
          'A bid counts if the server receives it strictly before the end time. The end time is never extended for late bids — except a site outage longer than 5 minutes in the last hour, which moves the end by 24 hours.',
          'At the end all bids are opened at once for everyone: amounts from highest to lowest, time of each, and the winner. Each bid shows the bidder ID (no name or phone). Every participant and the seller receive an email.',
          'The highest bid wins; on a tie, the one received earlier by the server. The winner pays their own bid.',
          `To bid you need a confirmed email, identity check, annual access (Basic ${v.basic} — lots up to ${v.basicMax}; Full ${v.full} — all lots) and a per-lot deposit: ${v.depPct}% of the starting price, between ${v.depMin} and ${v.depMax}. The deposit is held on your card, not charged.`,
          `A standard participant may have at most ${v.bids} bids without result (including open deals) and one open deal. Investor status with proof of funds raises the limit.`,
          `After the result the winner and seller confirm within ${v.hours} hours and receive each other’s contacts. The contract is signed at a notary within ${v.notary} days.`,
          'If the winner refuses or stays silent: no sale, the deposit stays held pending an admin decision, bidding is blocked for 30 days (second time 180 days, third time permanently).',
          'Second chance: if the winner refuses within 5 days of the result, the lot passes to the 2nd-place bidder at their bid; their deposit stays held for those 5 days.',
          'If the seller refuses: the winner’s deposit is released and the seller cannot create new lots.',
          `Platform commission is paid by the seller only if the deal closes: ${v.comPct}% of the price, at least ${v.comMin}.`,
          'You can dispute a result within 48 hours: the admin checks your commitment code against the bid log.',
        ],
      },
      { id: 'terms', title: 'Terms of use (v1.0)', items: ['The site runs auctions and records results; the property sale is signed at a notary outside the site.', 'One person — one account. Sellers and their relatives do not bid on their own lots.', 'Annual access is a platform service fee; non-refundable and not part of the property price.'] },
      { id: 'privacy', title: 'Data policy (v1.0)', items: ['Documents and selfies stay with the KYC provider. We keep only the result, name, birth date and a hash of the document number.', 'Card numbers are entered only on the bank page; we keep the mask and binding id.', 'Bid amounts are stored encrypted until the end and are visible to no one.'] },
      { id: 'contacts', title: 'Contacts', items: ['Email: support@auction.local', 'Phone: +374 10 000000 (demo)'] },
    ],
    hy: [
      {
        id: 'rules',
        title: 'Աճուրդի կանոններ (տեսակ 1)',
        items: [
          `Վաճառողը սահմանում է մեկնարկային գին (առնվազն ${v.min}) և նախապես համաձայնում է վաճառել դրանից բարձր ցանկացած հայտով։`,
          `Աճուրդն ունի ճշգրիտ սկիզբ և ավարտ (${v.dmin}–${v.dmax} օր)։ Ժամանակը՝ Երևանի, ժամկետները հաշվում է սերվերը։`,
          'Յուրաքանչյուր մասնակից ներկայացնում է ուղիղ մեկ հայտ՝ մեկնարկային գնից բարձր դրամի ցանկացած ամբողջ թիվ։',
          'Հայտը չի կարելի փոխել, բարձրացնել, իջեցնել կամ հետ կանչել։',
          'Մինչև ավարտը հայտերի մասին ոչինչ տեսանելի չէ ոչ ոքի, ներառյալ վաճառողին և աշխատակիցներին։ Դուք տեսնում եք միայն ձեր հայտը։',
          'Հայտն ընդունվում է, եթե սերվերը ստացել է այն ավարտից խիստ առաջ։ Ավարտը չի երկարաձգվում, բացառությամբ վերջին ժամում 5 րոպեից երկար խափանման դեպքի (+24 ժ)։',
          'Ավարտին բոլոր հայտերը բացվում են բոլորի համար միաժամանակ, անունները թաքցված են։ Յուրաքանչյուր հայտի կողքին երևում է մասնակցի ID-ն։ Մասնակիցները և վաճառողը ստանում են նամակ։',
          'Հաղթում է ամենաբարձր հայտը, հավասարության դեպքում՝ ավելի վաղ ստացվածը։ Հաղթողը վճարում է իր հայտը։',
          'Եթե հաղթողը 5 օրվա ընթացքում հրաժարվի, լոտը կանցնի երկրորդ տեղին՝ նրա հայտի գնով։',
          `Մասնակցության համար պետք են՝ հաստատված email, ինքնության ստուգում, տարեկան մուտք (Հիմնական ${v.basic}, Լրիվ ${v.full}) և ավանդ՝ մեկնարկային գնի ${v.depPct}%, ${v.depMin}–${v.depMax}։`,
          `Հաղթողը և վաճառողը հաստատում են գործարքը ${v.hours} ժամում, պայմանագիրը՝ նոտարի մոտ ${v.notary} օրում։`,
          `Միջնորդավճարը վճարում է միայն վաճառողը և միայն գործարքի դեպքում՝ ${v.comPct}%, առնվազն ${v.comMin}։`,
        ],
      },
      { id: 'terms', title: 'Օգտագործման համաձայնագիր (v1.0)', items: ['Կայքն անցկացնում է աճուրդներ, գործարքը կնքվում է նոտարի մոտ։', 'Մեկ մարդ՝ մեկ հաշիվ։'] },
      { id: 'privacy', title: 'Տվյալների քաղաքականություն (v1.0)', items: ['Փաստաթղթերը պահվում են KYC ծառայությունում, մեզ մոտ՝ միայն արդյունքը, անունը, ծննդյան ամսաթիվը և փաստաթղթի համարի հեշը։'] },
      { id: 'contacts', title: 'Կոնտակտներ', items: ['Email: support@auction.local'] },
    ],
  };
  return (
    <div className="stack" style={{ maxWidth: 860 }}>
      {S[lang].map((s) => (
        <section key={s.id} id={s.id} className="card">
          <h2>{s.title}</h2>
          <ol style={{ paddingLeft: 20, margin: 0 }} className="stack">
            {s.items.map((i, k) => (
              <li key={k}>{i}</li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
