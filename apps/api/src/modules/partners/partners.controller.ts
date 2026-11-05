import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { PartnersService } from './partners.service';

/** PRD v2 (F10, F11.4): справочник партнёров, заявки, кабинет партнёра, реклама и их модерация. */
@Controller()
export class PartnersController {
  constructor(private auth: AuthService, private partners: PartnersService) {}

  @Get('partners')
  list(@Query('kind') kind?: string) {
    return this.partners.list(kind);
  }
  @Post('partners/:id/requests')
  async request(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() req: Request) {
    return this.partners.request(await this.auth.user(req), id, b);
  }
  @Get('me/service-requests')
  async myRequests(@Req() req: Request) {
    return this.partners.myRequests(await this.auth.user(req));
  }

  @Get('partner')
  async mine(@Req() req: Request) {
    return this.partners.mine(await this.auth.user(req));
  }
  @Post('partner/apply')
  @UseInterceptors(FileInterceptor('license', { limits: { fileSize: 15 * 1024 * 1024 } }))
  async apply(@Body() b: any, @UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    return this.partners.apply(await this.auth.user(req), b, file);
  }
  @Post('partner/requests/:id')
  async answer(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() req: Request) {
    return this.partners.answer(await this.auth.user(req), id, b);
  }
  @Post('partner/ads')
  @UseInterceptors(FileInterceptor('creative', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async ad(@Body() b: any, @UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    return this.partners.submitAd(await this.auth.user(req), b, file);
  }

  @Get('ads')
  ads(@Query('slot') slot: string) {
    return this.partners.adsFor(String(slot || ''));
  }
  @Get('ads/:id/click')
  async click(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    res.redirect(302, await this.partners.click(id));
  }

  @Get('admin/partners')
  async adminPartners(@Req() req: Request) {
    await this.auth.staff(req);
    return this.partners.adminPartners();
  }
  @Post('admin/partners/:id/decide')
  async decidePartner(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() req: Request) {
    return this.partners.decidePartner(await this.auth.staff(req), id, b);
  }
  @Get('admin/ads')
  async adminAds(@Req() req: Request) {
    await this.auth.staff(req);
    return this.partners.adminAds();
  }
  @Post('admin/ads/:id/decide')
  async decideAd(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() req: Request) {
    return this.partners.decideAd(await this.auth.staff(req), id, b);
  }
}
