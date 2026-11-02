import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Storage } from '../../adapters/storage';
import { Clock } from '../../common/clock';

const TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf' };

/** Фото — публично; выписки и документы — только по временной подписанной ссылке. */
@Controller('files')
export class FilesController {
  constructor(private storage: Storage, private clock: Clock) {}
  @Get('*')
  get(@Req() req: Request, @Res() res: Response, @Query('exp') exp: string, @Query('sig') sig: string) {
    const key = decodeURIComponent(req.path.replace(/^\/api\/files\//, ''));
    if (key.includes('..')) return res.status(400).end();
    if (key.startsWith('private/') && !this.storage.verify(key, exp, sig, this.clock.now())) return res.status(403).json({ error: 'FORBIDDEN' });
    if (!key.startsWith('private/') && !key.startsWith('public/')) return res.status(404).end();
    const buf = this.storage.read(key);
    if (!buf) return res.status(404).end();
    const ext = key.split('.').pop()!.toLowerCase();
    res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (ext === 'svg') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader('Cache-Control', key.startsWith('public/') ? 'public, max-age=86400' : 'private, no-store');
    return res.send(buf);
  }
}
