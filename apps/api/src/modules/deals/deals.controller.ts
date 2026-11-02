import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { fail } from '../../common/errors';
import { AuthService } from '../auth/auth.service';
import { DealsService } from './deals.service';

@Controller('deals')
export class DealsController {
  constructor(private auth: AuthService, private deals: DealsService) {}
  @Get(':lotId')
  async view(@Param('lotId', ParseIntPipe) id: number, @Req() req: Request) {
    return this.deals.view(await this.auth.user(req), id);
  }
  @Post(':lotId/confirm')
  async confirm(@Param('lotId', ParseIntPipe) id: number, @Req() req: Request) {
    return this.deals.confirm(await this.auth.user(req), id, (req.headers['x-step-up'] as string) || undefined);
  }
  @Post(':lotId/decline')
  async decline(@Param('lotId', ParseIntPipe) id: number, @Body() b: any, @Req() req: Request) {
    return this.deals.decline(await this.auth.user(req), id, String(b?.reason || ''));
  }
  @Post(':lotId/extract')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
  async extract(@Param('lotId', ParseIntPipe) id: number, @UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    if (!file) fail('FILE_REQUIRED');
    return this.deals.uploadExtract(await this.auth.user(req), id, file);
  }
}
