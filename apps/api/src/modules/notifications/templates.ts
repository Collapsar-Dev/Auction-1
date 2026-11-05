import { Lang } from '../../common/format';

type T = { s?: string; b: string };
type Tpl = Record<Lang, T>;

/**
 * Шаблоны уведомлений на трёх языках (SC-20). Плейсхолдеры — {name}.
 * Правило SC-20: до конца аукциона ни один шаблон не содержит данных о чужих ставках и их числе.
 */
export const TEMPLATES: Record<string, Tpl> = {
  kyc_in_review: {
    hy: { s: 'Ձեր փաստաթղթերը ստուգվում են', b: 'KYC ծառայությունն ավարտեց ստուգումը։ Այժմ որոշումը կայացնում է մոդերատորը՝ սովորաբար մինչև 24 ժամ։' },
    ru: { s: 'Документы на проверке', b: 'KYC-сервис закончил проверку. Теперь решение принимает модератор — обычно до 24 часов.' },
    en: { s: 'Documents under review', b: 'The KYC service has finished. A moderator now makes the decision — usually within 24 hours.' },
  },
  register_code: {
    hy: { s: 'Հաստատման կոդ', b: 'Հաստատման կոդ՝ {code}։ Գործում է {minutes} րոպե։' },
    ru: { s: 'Код подтверждения', b: 'Код подтверждения: {code}. Действует {minutes} минут.' },
    en: { s: 'Confirmation code', b: 'Confirmation code: {code}. Valid for {minutes} minutes.' },
  },
  password_reset: {
    hy: { s: 'Գաղտնաբառի վերականգնում', b: 'Նոր գաղտնաբառ սահմանելու հղումը գործում է {minutes} րոպե և միայն մեկ անգամ՝ {link}։ Եթե դուք չեք խնդրել, անտեսեք այս նամակը։' },
    ru: { s: 'Сброс пароля', b: 'Ссылка для нового пароля действует {minutes} минут и работает один раз: {link}. Если вы не запрашивали сброс — просто проигнорируйте письмо.' },
    en: { s: 'Password reset', b: 'The link to set a new password is valid for {minutes} minutes and works once: {link}. If you did not ask for it, ignore this message.' },
  },
  otp_login: {
    hy: { b: 'Մուտքի կոդ՝ {code}։ Գործում է 5 րոպե։' },
    ru: { b: 'Код входа: {code}. Действует 5 минут.' },
    en: { b: 'Login code: {code}. Valid for 5 minutes.' },
  },
  otp_step_up: {
    hy: { b: 'Հաստատման կոդ ({action})՝ {code}։ Գործում է 5 րոպե։' },
    ru: { b: 'Код подтверждения ({action}): {code}. Действует 5 минут.' },
    en: { b: 'Confirmation code ({action}): {code}. Valid for 5 minutes.' },
  },
  email_verify: {
    hy: { s: 'Հաստատեք ձեր email-ը', b: 'Հաստատելու համար անցեք հղումով՝ {link}' },
    ru: { s: 'Подтвердите email', b: 'Чтобы подтвердить адрес, перейдите по ссылке: {link}' },
    en: { s: 'Confirm your email', b: 'To confirm your address, open: {link}' },
  },
  kyc_result: {
    hy: { s: 'Ինքնության ստուգում՝ {result}', b: 'Ինքնության ստուգման արդյունքը՝ {result}. {reason}' },
    ru: { s: 'Проверка личности: {result}', b: 'Результат проверки личности: {result}. {reason}' },
    en: { s: 'Identity check: {result}', b: 'Identity check result: {result}. {reason}' },
  },
  lot_approved: {
    hy: { s: 'Լոտ #{lotId}-ը հաստատված է', b: 'Ձեր լոտը հաստատված է։ Աճուրդը կսկսվի {opensAt}, կավարտվի {closesAt} (Երևանի ժամանակով)։' },
    ru: { s: 'Лот #{lotId} одобрен', b: 'Ваш лот одобрен. Аукцион начнётся {opensAt} и закончится {closesAt} (время ереванское).' },
    en: { s: 'Lot #{lotId} approved', b: 'Your lot is approved. The auction opens {opensAt} and closes {closesAt} (Yerevan time).' },
  },
  lot_returned: {
    hy: { s: 'Լոտ #{lotId}-ը վերադարձված է լրամշակման', b: 'Մոդերատորի մեկնաբանությունը՝ {comment}' },
    ru: { s: 'Лот #{lotId} возвращён на доработку', b: 'Комментарий модератора: {comment}' },
    en: { s: 'Lot #{lotId} returned for changes', b: 'Moderator comment: {comment}' },
  },
  lot_rejected: {
    hy: { s: 'Լոտ #{lotId}-ը մերժված է', b: 'Պատճառը՝ {comment}' },
    ru: { s: 'Лот #{lotId} отклонён', b: 'Причина: {comment}' },
    en: { s: 'Lot #{lotId} rejected', b: 'Reason: {comment}' },
  },
  lot_withdrawn: {
    hy: { s: 'Լոտ #{lotId}-ը հանված է', b: 'Աճուրդը չեղարկված է։ Ձեր ավանդը ազատվում է, հայտերը չեն բացվում և ջնջվում են։ Պատճառը՝ {reason}' },
    ru: { s: 'Лот #{lotId} снят с торгов', b: 'Аукцион отменён. Ваш депозит освобождается, ставки не вскрываются и удаляются. Причина: {reason}' },
    en: { s: 'Lot #{lotId} withdrawn', b: 'The auction is cancelled. Your deposit is released; bids are not opened and are deleted. Reason: {reason}' },
  },
  lot_invalidated: {
    hy: { s: 'Լոտ #{lotId}-ի արդյունքը անվավեր է ճանաչվել', b: 'Պատճառը՝ {reason}։ Ազնիվ մասնակիցների ավանդները ազատվում են։' },
    ru: { s: 'Итог лота #{lotId} признан недействительным', b: 'Причина: {reason}. Депозиты честных участников освобождаются.' },
    en: { s: 'Result of lot #{lotId} declared invalid', b: 'Reason: {reason}. Deposits of honest participants are released.' },
  },
  lot_extended: {
    hy: { b: 'Կայքի խափանման պատճառով լոտ #{lotId}-ի ավարտը տեղափոխվել է {closesAt}։' },
    ru: { b: 'Из-за сбоя сайта конец лота #{lotId} перенесён на {closesAt}.' },
    en: { b: 'Due to a site outage, lot #{lotId} now closes at {closesAt}.' },
  },
  favorite_started: {
    hy: { s: 'Աճուրդը սկսվել է՝ {title}', b: 'Ընտրված լոտ #{lotId}-ի աճուրդը սկսվել է։ Ավարտը՝ {closesAt}։' },
    ru: { s: 'Аукцион начался: {title}', b: 'Аукцион по избранному лоту #{lotId} начался. Конец: {closesAt}.' },
    en: { s: 'Auction started: {title}', b: 'The auction for your favourite lot #{lotId} has started. Closes: {closesAt}.' },
  },
  ending_soon: {
    hy: { s: 'Մինչև ավարտը՝ {left}', b: 'Լոտ #{lotId}-ի ({title}) աճուրդը կավարտվի {closesAt}։ Դուք դեռ հայտ չեք ներկայացրել։' },
    ru: { s: 'До конца аукциона: {left}', b: 'Аукцион по лоту #{lotId} ({title}) закончится {closesAt}. Вы ещё не сделали ставку.' },
    en: { s: 'Auction ends in {left}', b: 'The auction for lot #{lotId} ({title}) closes {closesAt}. You have not placed a bid yet.' },
  },
  bid_receipt: {
    hy: { s: 'Ձեր հայտն ընդունված է՝ լոտ #{lotId}', b: 'Հայտ №{receiptNo}\nԳումար՝ {amount}\nՍերվերի ժամանակ՝ {receivedAt}\nՍտուգիչ կոդ՝ {commitment}\nՀայտը չի կարելի փոխել կամ հետ կանչել։' },
    ru: { s: 'Ваша ставка принята: лот #{lotId}', b: 'Квитанция №{receiptNo}\nСумма: {amount}\nВремя сервера: {receivedAt}\nКонтрольный код: {commitment}\nИзменить или отозвать ставку нельзя.' },
    en: { s: 'Your bid is accepted: lot #{lotId}', b: 'Receipt #{receiptNo}\nAmount: {amount}\nServer time: {receivedAt}\nCommitment code: {commitment}\nThe bid cannot be changed or withdrawn.' },
  },
  results: {
    hy: { s: 'Աճուրդի արդյունքները՝ լոտ #{lotId}', b: '{intro}\n\nԲոլոր հայտերը՝\n{table}\n\n{extra}' },
    ru: { s: 'Итоги аукциона: лот #{lotId}', b: '{intro}\n\nВсе ставки:\n{table}\n\n{extra}' },
    en: { s: 'Auction results: lot #{lotId}', b: '{intro}\n\nAll bids:\n{table}\n\n{extra}' },
  },
  results_no_bids: {
    hy: { s: 'Լոտ #{lotId}-ը չկայացավ', b: 'Աճուրդն ավարտվեց առանց հայտերի։ Կարող եք վերագործարկել լոտը նոր գնով։' },
    ru: { s: 'Лот #{lotId} не состоялся', b: 'Аукцион закончился без ставок. Вы можете перезапустить лот с новой ценой.' },
    en: { s: 'Lot #{lotId} did not sell', b: 'The auction ended with no bids. You can relaunch the lot with a new price.' },
  },
  results_sms: {
    hy: { b: 'Լոտ #{lotId}-ի արդյունքները հրապարակված են, նամակը ձեր փոստում է։' },
    ru: { b: 'Итоги аукциона по лоту #{lotId} опубликованы, письмо у вас на почте.' },
    en: { b: 'Results for lot #{lotId} are published, check your email.' },
  },
  deposit_held: {
    hy: { s: 'Ավանդն արգելափակված է', b: 'Լոտ #{lotId}-ի համար ձեր քարտի ({mask}) վրա արգելափակված է {amount}։ Գումարը չի գանձվում։' },
    ru: { s: 'Депозит заблокирован', b: 'По лоту #{lotId} на вашей карте ({mask}) заблокировано {amount}. Сумма не списывается.' },
    en: { s: 'Deposit held', b: '{amount} is held on your card ({mask}) for lot #{lotId}. It is not charged.' },
  },
  deposit_released: {
    hy: { s: 'Ավանդն ազատված է', b: 'Լոտ #{lotId}-ի ավանդը ({amount}) ազատված է։ Գումարի վերադարձի ժամկետը կախված է ձեր բանկից։' },
    ru: { s: 'Депозит освобождён', b: 'Депозит по лоту #{lotId} ({amount}) освобождён. Срок возврата денег на карту зависит от вашего банка.' },
    en: { s: 'Deposit released', b: 'Your deposit for lot #{lotId} ({amount}) is released. How fast it returns depends on your bank.' },
  },
  deposit_failed: {
    hy: { s: 'Ավանդը չհաջողվեց արգելափակել', b: 'Բանկը մերժեց արգելափակումը։ Ընտրեք այլ քարտ։' },
    ru: { s: 'Не удалось заблокировать депозит', b: 'Банк отклонил блокировку по лоту #{lotId}. Выберите другую карту.' },
    en: { s: 'Deposit hold failed', b: 'The bank declined the hold for lot #{lotId}. Please choose another card.' },
  },
  deal_reminder: {
    hy: { s: 'Հաստատեք գործարքը՝ լոտ #{lotId}', b: 'Հաստատման ժամկետն ավարտվում է {deadline}։ {link}' },
    ru: { s: 'Подтвердите сделку: лот #{lotId}', b: 'Срок подтверждения истекает {deadline}. {link}' },
    en: { s: 'Confirm the deal: lot #{lotId}', b: 'The confirmation deadline is {deadline}. {link}' },
  },
  deal_confirmed: {
    hy: { s: 'Գործարքը հաստատված է՝ լոտ #{lotId}', b: 'Երկու կողմերն էլ հաստատել են։ Մյուս կողմը՝ {otherName}, {otherPhone}։ Նոտարի մոտ պայմանագիրը ստորագրեք {notaryDays} օրվա ընթացքում։' },
    ru: { s: 'Сделка подтверждена: лот #{lotId}', b: 'Обе стороны подтвердили. Другая сторона: {otherName}, {otherPhone}. Подпишите договор у нотариуса в течение {notaryDays} дней.' },
    en: { s: 'Deal confirmed: lot #{lotId}', b: 'Both parties confirmed. Counterparty: {otherName}, {otherPhone}. Sign at a notary within {notaryDays} days.' },
  },
  deal_failed: {
    hy: { s: 'Գործարքը չկայացավ՝ լոտ #{lotId}', b: '{reason}' },
    ru: { s: 'Сделка не состоялась: лот #{lotId}', b: '{reason}' },
    en: { s: 'Deal failed: lot #{lotId}', b: '{reason}' },
  },
  partner_request_new: {
    hy: { s: 'Նոր հայտ #{id}', b: 'Ծառայություն՝ {service}։ {comment}' },
    ru: { s: 'Новая заявка #{id}', b: 'Услуга: {service}. {comment}' },
    en: { s: 'New request #{id}', b: 'Service: {service}. {comment}' },
  },
  partner_request_answer: {
    hy: { s: 'Հայտ #{id}՝ {partner}', b: 'Կարգավիճակ՝ {status}։ {reply}' },
    ru: { s: 'Заявка #{id}: {partner}', b: 'Статус: {status}. {reply}' },
    en: { s: 'Request #{id}: {partner}', b: 'Status: {status}. {reply}' },
  },
  partner_decision: {
    hy: { s: 'Գործընկերոջ հայտ՝ {name}', b: 'Որոշում՝ {status}։ {reason}' },
    ru: { s: 'Заявка партнёра: {name}', b: 'Решение: {status}. {reason}' },
    en: { s: 'Partner application: {name}', b: 'Decision: {status}. {reason}' },
  },
  ad_decision: {
    hy: { s: 'Գովազդ #{id}՝ {title}', b: 'Որոշում՝ {status}։ {reason}' },
    ru: { s: 'Реклама #{id}: {title}', b: 'Решение: {status}. {reason}' },
    en: { s: 'Ad #{id}: {title}', b: 'Decision: {status}. {reason}' },
  },
  lot_message: {
    hy: { s: 'Լոտ #{lotId}՝ հաղորդագրություն մոդերատորից', b: '{text}\n\nՊատասխանել՝ {link}' },
    ru: { s: 'Лот #{lotId}: сообщение от модератора', b: '{text}\n\nОтветить: {link}' },
    en: { s: 'Lot #{lotId}: message from the moderator', b: '{text}\n\nReply: {link}' },
  },
  seller_deposit_failed: {
    hy: { s: 'Լոտ #{lotId}՝ վաճառողի երաշխիքը չարգելափակվեց', b: 'Չհաջողվեց արգելափակել {amount} ձեր քարտի վրա։ Մինչ երաշխիքն արգելափակված չէ, գրանցումը լոտին փակ է։ Ստուգեք քարտը կամ ավելացրեք նորը։' },
    ru: { s: 'Лот #{lotId}: взнос продавца не заблокирован', b: 'Не удалось заблокировать {amount} на вашей карте. Пока взнос не заблокирован, регистрация на лот закрыта. Проверьте карту или добавьте новую.' },
    en: { s: 'Lot #{lotId}: seller guarantee not held', b: 'We could not hold {amount} on your card. Registration for the lot stays closed until the guarantee is held. Check the card or add a new one.' },
  },
  seller_forfeit_compensation: {
    hy: { s: 'Լոտ #{lotId}՝ փոխհատուցում', b: 'Վաճառողը հրաժարվեց կամ հանեց լոտը։ Նրա երաշխիքից ձեզ հասնում է {amount} փոխհատուցում։' },
    ru: { s: 'Лот #{lotId}: компенсация', b: 'Продавец снял лот или отказался от сделки. Из его взноса вам причитается компенсация {amount}.' },
    en: { s: 'Lot #{lotId}: compensation', b: 'The seller withdrew the lot or refused the deal. You are due {amount} compensation from the seller guarantee.' },
  },
  forfeit_payout: {
    hy: { s: 'Լոտ #{lotId}՝ պահված երաշխիք', b: 'Հրաժարված մասնակցի երաշխիքը պահվել է։ Ձեզ հասնում է {amount} (հարթակի բաժնից հետո)։' },
    ru: { s: 'Лот #{lotId}: удержанный взнос', b: 'Взнос отказавшегося участника удержан. Вам причитается {amount} (за вычетом доли платформы).' },
    en: { s: 'Lot #{lotId}: withheld guarantee', b: 'The guarantee of the refusing bidder was withheld. You are due {amount} (after the platform share).' },
  },
  deal_sold: {
    hy: { s: 'Գործարքը ավարտված է՝ լոտ #{lotId}', b: 'Լոտը նշված է «Վաճառված»։ {extra}' },
    ru: { s: 'Сделка завершена: лот #{lotId}', b: 'Лот отмечен как «Продано». {extra}' },
    en: { s: 'Deal completed: lot #{lotId}', b: 'The lot is marked as sold. {extra}' },
  },
  lot_offered_second: {
    hy: { s: 'Լոտ #{lotId}-ը առաջարկվում է ձեզ', b: 'Վերևի տեղը հրաժարվեց (դուք {place}-րդ տեղում եք)։ Լոտը առաջարկվում է ձեզ՝ ձեր հայտի գնով {amount}։ Հաստատեք գործարքը {hours} ժամվա ընթացքում՝ {link}' },
    ru: { s: 'Лот #{lotId} предложен вам', b: 'Место выше отказалось от сделки (вы на {place}-м месте). Лот переходит к вам по вашей ставке {amount}. Подтвердите сделку в течение {hours} ч: {link}' },
    en: { s: 'Lot #{lotId} is offered to you', b: 'The place above refused (you are in place {place}). The lot passes to you at your bid of {amount}. Confirm the deal within {hours} h: {link}' },
  },
  lot_passed_second_seller: {
    hy: { s: 'Լոտ #{lotId}՝ գործարքը {place}-րդ տեղի հետ', b: 'Գնորդը հրաժարվեց։ Լոտն անցնում է {place}-րդ տեղի մասնակցին՝ {amount}։ Հաստատեք գործարքը {hours} ժամվա ընթացքում՝ {link}' },
    ru: { s: 'Лот #{lotId}: сделка с {place}-м местом', b: 'Покупатель отказался. Лот переходит участнику с {place}-го места по его ставке {amount}. Подтвердите сделку в течение {hours} ч: {link}' },
    en: { s: 'Lot #{lotId}: deal with place {place}', b: 'The buyer refused. The lot passes to the place-{place} bidder at {amount}. Confirm the deal within {hours} h: {link}' },
  },
  commission_charged: {
    hy: { s: 'Միջնորդավճարը գանձված է', b: 'Լոտ #{lotId}-ի համար գանձվել է {amount}։ Կտրոն №{receiptNo}' },
    ru: { s: 'Комиссия списана', b: 'По лоту #{lotId} списано {amount}. Чек №{receiptNo}' },
    en: { s: 'Commission charged', b: '{amount} was charged for lot #{lotId}. Receipt #{receiptNo}' },
  },
  commission_failed: {
    hy: { s: 'Միջնորդավճարը չհաջողվեց գանձել', b: 'Վճարեք {amount} հղումով՝ {link}։ Մինչ վճարումը նոր լոտեր ստեղծել հնարավոր չէ։' },
    ru: { s: 'Не удалось списать комиссию', b: 'Оплатите {amount} по ссылке: {link}. До оплаты создание новых лотов недоступно.' },
    en: { s: 'Commission charge failed', b: 'Please pay {amount}: {link}. Creating new lots is blocked until paid.' },
  },
  subscription_paid: {
    hy: { s: 'Տարեկան մուտքն ակտիվ է', b: 'Սակագին՝ {plan}, մինչև {endsAt}։ Վճարված է {amount}, կտրոն №{receiptNo}։' },
    ru: { s: 'Годовой доступ активен', b: 'Тариф: {plan}, действует до {endsAt}. Оплачено {amount}, чек №{receiptNo}.' },
    en: { s: 'Annual access is active', b: 'Plan: {plan}, valid until {endsAt}. Paid {amount}, receipt #{receiptNo}.' },
  },
  subscription_expiring: {
    hy: { s: 'Տարեկան մուտքը շուտով կավարտվի', b: 'Ձեր «{plan}» մուտքն ավարտվում է {endsAt}։ Ավտոմատ երկարաձգում չկա։' },
    ru: { s: 'Годовой доступ скоро закончится', b: 'Ваш доступ «{plan}» заканчивается {endsAt}. Автопродления нет — продлите в личном кабинете.' },
    en: { s: 'Annual access expires soon', b: 'Your “{plan}” access ends {endsAt}. There is no auto-renewal.' },
  },
  funds_proof_decided: {
    hy: { s: 'Ներդրողի կարգավիճակ՝ {result}', b: '{details}' },
    ru: { s: 'Статус «Инвестор»: {result}', b: '{details}' },
    en: { s: 'Investor status: {result}', b: '{details}' },
  },
  investor_expiring: {
    hy: { s: 'Ներդրողի կարգավիճակը շուտով կավարտվի', b: 'Կարգավիճակը գործում է մինչև {validUntil}։ Թարմացրեք միջոցների հաստատումը։' },
    ru: { s: 'Статус «Инвестор» скоро закончится', b: 'Статус действует до {validUntil}. Обновите подтверждение средств.' },
    en: { s: 'Investor status expires soon', b: 'Valid until {validUntil}. Please refresh your proof of funds.' },
  },
  risk_action: {
    hy: { s: 'Մասնակցի ստուգում', b: '{details}' },
    ru: { s: 'Проверка участника', b: '{details}' },
    en: { s: 'Participant review', b: '{details}' },
  },
  sanction: {
    hy: { s: 'Հայտերի արգելափակում', b: '{details}' },
    ru: { s: 'Блокировка ставок', b: '{details}' },
    en: { s: 'Bidding block', b: '{details}' },
  },
  dispute_answered: {
    hy: { s: 'Պատասխան ձեր դիմումին՝ լոտ #{lotId}', b: '{reply}' },
    ru: { s: 'Ответ на ваше обращение: лот #{lotId}', b: '{reply}' },
    en: { s: 'Reply to your dispute: lot #{lotId}', b: '{reply}' },
  },
  admin_alarm: {
    hy: { s: 'ՏԱԳՆԱՊ՝ {title}', b: '{details}' },
    ru: { s: 'ТРЕВОГА: {title}', b: '{details}' },
    en: { s: 'ALERT: {title}', b: '{details}' },
  },
  phone_change_code: {
    hy: { b: 'Հեռախոսահամարի փոփոխության կոդ՝ {code}' },
    ru: { b: 'Код для смены номера телефона: {code}' },
    en: { b: 'Phone number change code: {code}' },
  },
};

export function render(template: string, lang: Lang, payload: Record<string, unknown>) {
  const t = TEMPLATES[template]?.[lang] ?? TEMPLATES[template]?.ru;
  if (!t) throw new Error('Unknown template ' + template);
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k) => (payload[k] === undefined || payload[k] === null ? '' : String(payload[k])));
  return { subject: t.s ? fill(t.s) : null, body: fill(t.b) };
}

/** Небольшие фразы для писем с итогами. */
export const PHRASES: Record<string, Record<Lang, string>> = {
  you: { hy: 'Սա դուք եք', ru: 'Это вы', en: 'This is you' },
  participant: { hy: 'Մասնակից', ru: 'Участник', en: 'Participant' },
  winner: { hy: 'հաղթող', ru: 'победитель', en: 'winner' },
  intro_participant: { hy: 'Ձեր հայտը՝ {amount}, տեղը՝ {place} / {total}։ Ստուգիչ կոդ՝ {commitment}', ru: 'Ваша ставка: {amount}, место {place} из {total}. Контрольный код: {commitment}', en: 'Your bid: {amount}, place {place} of {total}. Commitment code: {commitment}' },
  intro_seller: { hy: 'Ձեր լոտի աճուրդն ավարտվել է։ Հաղթող հայտ՝ {amount}։', ru: 'Аукцион по вашему лоту завершён. Победная ставка: {amount}.', en: 'The auction for your lot has ended. Winning bid: {amount}.' },
  extra_winner: { hy: 'Դուք հաղթեցիք։ Հաստատեք գործարքը {hours} ժամվա ընթացքում՝ {link}', ru: 'Вы выиграли! Подтвердите сделку в течение {hours} ч: {link}', en: 'You won! Confirm the deal within {hours} h: {link}' },
  extra_loser: { hy: 'Ձեր ավանդն ազատվում է։ Վերադարձի ժամկետը կախված է ձեր բանկից։', ru: 'Ваш депозит освобождается. Срок возврата денег на карту зависит от вашего банка.', en: 'Your deposit is being released. The timing depends on your bank.' },
  extra_chain: {
    hy: 'Դուք {place}-րդ տեղում եք։ Եթե նախորդ տեղերը հրաժարվեն, լոտը կառաջարկվի ձեզ՝ ձեր հայտի գնով, որոշման համար {hours} ժամ։ Մինչ պայմանագիրը ձեր ավանդը մնում է արգելափակված։',
    ru: 'Вы на {place}-м месте. Если места выше откажутся, лот предложат вам по вашей ставке, на решение — {hours} ч. До подписания договора ваш взнос остаётся заблокированным.',
    en: 'You are in place {place}. If the places above refuse, the lot will be offered to you at your bid, with {hours} h to decide. Your guarantee stays held until the contract is signed.',
  },
  extra_runner_up: {
    hy: 'Դուք երկրորդ տեղում եք։ Եթե հաղթողը {days} օրվա ընթացքում հրաժարվի, լոտը կառաջարկվի ձեզ՝ ձեր հայտի գնով։ Մինչ այդ ձեր ավանդը մնում է արգելափակված։',
    ru: 'Вы на 2-м месте. Если победитель откажется в течение {days} дней, лот будет предложен вам по вашей ставке. До этого ваш депозит остаётся заблокированным.',
    en: 'You are in 2nd place. If the winner refuses within {days} days, the lot will be offered to you at your bid. Until then your deposit stays held.',
  },
  extra_seller: { hy: 'Խնդրում ենք հաստատել գործարքը {hours} ժամվա ընթացքում՝ {link}', ru: 'Пожалуйста, подтвердите сделку в течение {hours} ч: {link}', en: 'Please confirm the deal within {hours} h: {link}' },
};
export const phrase = (k: string, lang: Lang, payload: Record<string, unknown> = {}) =>
  PHRASES[k][lang].replace(/\{(\w+)\}/g, (_, p) => String(payload[p] ?? ''));
