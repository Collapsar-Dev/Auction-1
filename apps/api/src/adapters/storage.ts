import { Injectable } from '@nestjs/common';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Хранилище файлов (S3-совместимое в бою). В разработке — локальная папка.
 * Фото — публично, выписки и документы — закрыто, доступ по временной подписанной ссылке.
 */
@Injectable()
export class Storage {
  root = process.env.STORAGE_DIR || path.resolve(process.cwd(), 'storage');
  constructor() {
    fs.mkdirSync(path.join(this.root, 'public'), { recursive: true });
    fs.mkdirSync(path.join(this.root, 'private'), { recursive: true });
  }
  put(buf: Buffer, ext: string, isPrivate: boolean) {
    const key = (isPrivate ? 'private/' : 'public/') + crypto.randomUUID() + '.' + ext.replace(/[^a-z0-9]/gi, '').slice(0, 5);
    fs.writeFileSync(path.join(this.root, key), buf);
    return key;
  }
  putNamed(key: string, buf: Buffer | string) {
    fs.mkdirSync(path.dirname(path.join(this.root, key)), { recursive: true });
    fs.writeFileSync(path.join(this.root, key), buf);
    return key;
  }
  read(key: string) {
    const p = path.join(this.root, path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, ''));
    if (!p.startsWith(this.root)) return null;
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  publicUrl(key: string) {
    return '/api/files/' + key;
  }
  signedUrl(key: string, now: Date, ttlSec = 300) {
    const exp = Math.floor(now.getTime() / 1000) + ttlSec;
    const sig = crypto.createHmac('sha256', process.env.APP_SECRET || 'dev-secret-change-me').update(key + exp).digest('hex').slice(0, 32);
    return `/api/files/${key}?exp=${exp}&sig=${sig}`;
  }
  verify(key: string, exp: string, sig: string, now: Date) {
    if (!exp || !sig || Number(exp) * 1000 < now.getTime()) return false;
    const good = crypto.createHmac('sha256', process.env.APP_SECRET || 'dev-secret-change-me').update(key + exp).digest('hex').slice(0, 32);
    return crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig.padEnd(32).slice(0, 32)));
  }
}
