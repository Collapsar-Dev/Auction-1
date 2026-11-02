import { Injectable } from '@nestjs/common';
import { Db, Queryable } from './db';
import { Clock } from './clock';

/** Журнал действий — только добавление (7.2). */
@Injectable()
export class Audit {
  constructor(private db: Db, private clock: Clock) {}
  async log(actorId: number | null, action: string, entity: string, entityId: string | number | null, before: unknown = null, after: unknown = null, t: Queryable = this.db) {
    await t.q('INSERT INTO audit_log(actor_id, action, entity, entity_id, before, after, at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      actorId,
      action,
      entity,
      entityId === null ? null : String(entityId),
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      this.clock.now(),
    ]);
  }
}
