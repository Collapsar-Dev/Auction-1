/** Печатает текущие TOTP-коды сотрудников из сида (для входа в /staff/login без телефона). */
import { totp } from '../src/common/totp';
const secrets = { admin: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', moderator: 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU' };
for (const [u, s] of Object.entries(secrets)) console.log(`${u.padEnd(10)} ${totp(s, Date.now())}`);
