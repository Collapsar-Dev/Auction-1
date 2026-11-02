import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService, STEP_UP_ACTIONS } from './auth.service';

const fp = (req: Request) => ({ ua: String(req.headers['user-agent'] || ''), ip: req.ip || '' });

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('otp')
  otp(@Body() b: any, @Req() req: Request) {
    const { phone } = z.object({ phone: z.string() }).parse(b);
    return this.auth.sendCode(phone, 'login', null, null, fp(req).ip);
  }

  @Post('verify')
  verify(@Body() b: any, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { phone, code, lang } = z.object({ phone: z.string(), code: z.string(), lang: z.string().optional() }).parse(b);
    return this.auth.verifyLogin(phone, code, fp(req).ua, res, lang);
  }

  @Post('refresh')
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.refresh(req, res);
  }

  @Post('logout')
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(req, res);
  }

  @Post('step-up')
  async stepUp(@Body() b: any, @Req() req: Request) {
    const user = await this.auth.user(req);
    const { action, code } = z.object({ action: z.enum(STEP_UP_ACTIONS), code: z.string().optional() }).parse(b);
    if (!code) return this.auth.stepUpRequest(user, action, fp(req).ip);
    return this.auth.stepUpVerify(user, action, code);
  }

  @Post('staff/login')
  staffLogin(@Body() b: any, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { username, password, code } = z.object({ username: z.string(), password: z.string(), code: z.string() }).parse(b);
    return this.auth.staffLogin(username, password, code, fp(req).ua, fp(req).ip, res);
  }

  @Get('session')
  async session(@Req() req: Request) {
    const u = await this.auth.optionalUser(req);
    return { loggedIn: !!u, kind: u?.session_kind ?? null, role: u?.role ?? null };
  }
}
