import { describe, expect, it } from 'vitest';
import { CallBudget } from '../engine/budget';

describe('CallBudget', () => {
  it('allows calls up to the limit and blocks once exhausted', () => {
    const budget = new CallBudget(new Map([['p1', 2]]));
    expect(budget.canCall('p1')).toBe(true);
    budget.record('p1');
    expect(budget.canCall('p1')).toBe(true);
    budget.record('p1');
    expect(budget.canCall('p1')).toBe(false);
  });

  it('treats a persona with no configured limit as unbounded', () => {
    const budget = new CallBudget(new Map());
    for (let i = 0; i < 50; i++) {
      expect(budget.canCall('unknown')).toBe(true);
      budget.record('unknown');
    }
  });

  it('tracks personas independently', () => {
    const budget = new CallBudget(
      new Map([
        ['p1', 1],
        ['p2', 3],
      ])
    );
    budget.record('p1');
    expect(budget.canCall('p1')).toBe(false);
    expect(budget.canCall('p2')).toBe(true);
  });

  it('announces exhaustion exactly once per persona', () => {
    const budget = new CallBudget(new Map([['p1', 1]]));
    // Not exhausted yet — no announcement due.
    expect(budget.shouldAnnounceExhausted('p1')).toBe(false);

    budget.record('p1');
    // Now exhausted — first check should announce...
    expect(budget.shouldAnnounceExhausted('p1')).toBe(true);
    // ...but only once, even if checked again on later turns.
    expect(budget.shouldAnnounceExhausted('p1')).toBe(false);
    expect(budget.shouldAnnounceExhausted('p1')).toBe(false);
  });
});
