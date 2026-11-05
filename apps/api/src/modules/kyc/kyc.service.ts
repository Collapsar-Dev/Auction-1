import { Injectable } from '@nestjs/common';
import { Db } from '../../common/db';
import { Clock } from '../../common/clock';
import { fail } from '../../common/errors';
import { sha256 } from '../../common/hash';
import { Audit } from '../../common/audit';
import { FakeKyc, KycResult } from '../../adapters/kyc';
import { AuthService, User } from '../auth/auth.service';
import { NotifyService } from '../notifications/notify.service';
import { SettingsService } from '../../common/settings';

/** SC-02 Проверка личности. У нас хранится только итог, ФИО, дата рождения и хэш документа (AU-07). */
@Injectable()
export class KycService {
  constructor(private db: Db, private clock: Clock, private kyc: FakeKyc, private auth: AuthService, private audit: Audit, private notify: NotifyService, private settings: SettingsService) {}

  async start(user: User, acceptBiometrics: boolean) {
    if (user.kyc_status === 'verified') fail('KYC_ALREADY_VERIFIED');
    if (!acceptBiometrics && (await this.auth.missingConsents(user.id, ['biometrics'])).length) fail('CONSENT_REQUIRED', 403, { missing: ['biometrics'] });
    if (acceptBiometrics) await this.auth.accept(user.id, ['biometrics']);
    const s = await this.kyc.createSession(user.id);
    await this.db.q(`UPDATE users SET kyc_session_id=$2, kyc_status='pending', kyc_reject_reason=NULL WHERE id=$1`, [user.id, s.sessionId]);
    return s;
  }

  static docHash(docNumber: string) {
    return sha256('doc:' + docNumber.replace(/\s/g, '').toUpperCase());
  }

  async handleResult(r: KycResult) {
    const user = await this.db.maybe<User>('SELECT * FROM users WHERE kyc_session_id=$1', [r.sessionId]);
    if (!user) fail('KYC_SESSION_NOT_FOUND', 404);
    if (r.decision === 'manual') {
      await this.db.q(`UPDATE users SET kyc_status='manual', kyc_pending=$2 WHERE id=$1`, [user!.id, JSON.stringify({ fullName: r.fullName, birthDate: r.birthDate, docHash: r.docNumber ? KycService.docHash(r.docNumber) : null })]);
      return { status: 'manual' };
    }
    if (r.decision === 'rejected') return this.reject(user!, r.reason || 'KYC_REJECTED');
    const docHash = KycService.docHash(r.docNumber || '');
    // PRD v2 решение 2: KYC-сервис даёт заключение, решение принимает модератор.
    // Жёсткие правила (возраст, «один документ — один аккаунт») по-прежнему отклоняют сразу.
    if ((await this.settings.all()).kyc_require_moderator) {
      const bad = await this.hardCheck(user!, r.fullName ?? '', r.birthDate ?? '', docHash);
      if (bad) return this.reject(user!, bad);
      await this.db.q(`UPDATE users SET kyc_status='manual', kyc_pending=$2 WHERE id=$1`, [
        user!.id,
        JSON.stringify({ fullName: r.fullName, birthDate: r.birthDate, docHash, provider: 'approved', submittedAt: this.clock.now().toISOString() }),
      ]);
      await this.audit.log(user!.id, 'kyc.submitted', 'user', user!.id, null, { provider: 'approved' });
      await this.notify.queue(user!.id, 'email', 'kyc_in_review', {});
      return { status: 'manual' };
    }
    return this.approve(user!, r.fullName!, r.birthDate!, docHash, null);
  }

  /** Возраст 18+ и уникальность документа (R-14). Возвращает причину отказа или null. */
  private async hardCheck(user: User, fullName: string, birthDate: string, docHash: string) {
    if (!fullName || !birthDate) return 'KYC_DATA_MISSING';
    const bd = new Date(birthDate + 'T00:00:00Z');
    const now = this.clock.now();
    let age = now.getUTCFullYear() - bd.getUTCFullYear();
    const m = now.getUTCMonth() - bd.getUTCMonth();
    if (m < 0 || (m === 0 && now.getUTCDate() < bd.getUTCDate())) age--;
    if (age < 18) return 'UNDER_18';
    const other = await this.db.maybe<{ id: number }>('SELECT id FROM users WHERE doc_hash=$1 AND id<>$2', [docHash, user.id]);
    if (other) return 'DOC_ALREADY_USED';
    return null;
  }

  async approve(user: User, fullName: string, birthDate: string, docHash: string, actorId: number | null) {
    const bad = await this.hardCheck(user, fullName, birthDate, docHash); // R-14: один человек — один аккаунт
    if (bad) return this.reject(user, bad);
    await this.db.q(`UPDATE users SET kyc_status='verified', kyc_level=2, full_name=$2, birth_date=$3, doc_hash=$4, kyc_pending=NULL, kyc_reject_reason=NULL WHERE id=$1`, [
      user.id,
      fullName,
      birthDate,
      docHash,
    ]);
    await this.audit.log(actorId ?? user.id, 'kyc.verified', 'user', user.id);
    await this.notify.queue(user.id, 'email', 'kyc_result', { result: '✓', reason: '' });
    return { status: 'verified' };
  }

  async reject(user: User, reason: string, actorId: number | null = null) {
    await this.db.q(`UPDATE users SET kyc_status='rejected', kyc_reject_reason=$2, kyc_pending=NULL WHERE id=$1`, [user.id, reason]);
    await this.audit.log(actorId ?? user.id, 'kyc.rejected', 'user', user.id, null, { reason });
    await this.notify.queue(user.id, 'email', 'kyc_result', { result: '✗', reason });
    return { status: 'rejected', reason };
  }
}
