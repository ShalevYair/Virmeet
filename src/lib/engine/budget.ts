// Virmeet — per-persona API call budget enforcement (spec §4 "אכיפת תקציב").

/**
 * Tracks how many model calls each persona has made during a single meeting
 * run. Once a persona reaches its `maxApiCalls`, `canCall()` returns false and
 * the runner skips that persona in later discussion rounds, logging a Hebrew
 * `system` transcript line the first time it happens.
 */
export class CallBudget {
  private readonly used = new Map<string, number>();
  private readonly announced = new Set<string>();

  constructor(private readonly limits: Map<string, number>) {}

  canCall(personaId: string): boolean {
    const limit = this.limits.get(personaId) ?? Infinity;
    const used = this.used.get(personaId) ?? 0;
    return used < limit;
  }

  /** Call after a successful (or attempted) model call to consume one unit of budget. */
  record(personaId: string): void {
    this.used.set(personaId, (this.used.get(personaId) ?? 0) + 1);
  }

  /** True the first time a given persona's budget is exhausted — used so we log the "reached budget" line exactly once. */
  shouldAnnounceExhausted(personaId: string): boolean {
    if (this.canCall(personaId)) return false;
    if (this.announced.has(personaId)) return false;
    this.announced.add(personaId);
    return true;
  }
}
