import { Injectable } from '@nestjs/common';

/**
 * Серверные часы. Все сроки считает сервер (PRD 1).
 * В тестах и dev-режиме время можно сдвигать (offset), в боевом режиме — запрещено.
 */
@Injectable()
export class Clock {
  private offsetMs = 0;
  private frozen: number | null = null;
  now(): Date {
    return new Date(this.frozen ?? Date.now() + this.offsetMs);
  }
  ms(): number {
    return this.now().getTime();
  }
  canTravel() {
    return process.env.NODE_ENV === 'test' || process.env.DEV_TOOLS === 'true';
  }
  set(d: Date) {
    if (!this.canTravel()) throw new Error('time travel disabled');
    this.frozen = d.getTime();
  }
  advance(ms: number) {
    if (!this.canTravel()) throw new Error('time travel disabled');
    if (this.frozen !== null) this.frozen += ms;
    else this.offsetMs += ms;
  }
  reset() {
    this.frozen = null;
    this.offsetMs = 0;
  }
  getOffset() {
    return this.frozen !== null ? this.frozen - Date.now() : this.offsetMs;
  }
}

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
