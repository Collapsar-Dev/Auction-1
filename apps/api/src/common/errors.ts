import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { ZodError } from 'zod';

/** Ошибка бизнес-правила: код (для перевода на сайте) + HTTP-статус + данные. */
export class AppError extends Error {
  constructor(public code: string, public status = 400, public data: Record<string, unknown> = {}) {
    super(code);
  }
}

export const fail = (code: string, status = 400, data: Record<string, unknown> = {}): never => {
  throw new AppError(code, status, data);
};

@Catch()
export class AllErrorsFilter implements ExceptionFilter {
  catch(err: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: err.code, ...err.data });
    }
    if (err instanceof ZodError) {
      return res.status(400).json({ error: 'VALIDATION', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err instanceof HttpException) {
      return res.status(err.getStatus()).json({ error: 'HTTP_' + err.getStatus(), message: err.message });
    }
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'CONFLICT' });
    }
    // 7.4.4: суммы ставок никогда не попадают в логи — логируем только тип и сообщение
    console.error('[error]', err?.name, err?.message);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}
