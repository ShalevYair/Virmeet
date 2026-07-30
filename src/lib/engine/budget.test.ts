import { describe, expect, it } from 'vitest';
import { CallBudget } from './budget';

describe('CallBudget', () => {
  it('allows calls under the limit and blocks once it is reached', () => {
    const budget = new CallBudget(new Map([['p1', 2]]));
    expect(budget.canCall('p1')).toBe(true);
    budget.record('p1');
    expect(budget.canCall('p1')).toBe(true);
    budget.record('p1');
    expect(budget.canCall('p1')).toBe(false);
  });

  it('records usage cumulatively per persona', () => {
    const budget = new CallBudget(new Map([['p1', 3]]));
    budget.record('p1');
    budget.record('p1');
    expect(budget.canCall('p1')).toBe(true);
    budget.record('p1');
    expect(budget.canCall('p1')).toBe(false);
  });

  it('treats personas without a configured limit as unbounded', () => {
    const budget = new CallBudget(new Map());
    for (let i = 0; i < 50; i++) budget.record('p1');
    expect(budget.canCall('p1')).toBe(true);
  });

  it('announces exhaustion exactly once per persona', () => {
    const budget = new CallBudget(new Map([['p1', 1]]));
    expect(budget.shouldAnnounceExhausted('p1')).toBe(false); // not exhausted yet
    budget.record('p1');
    expect(budget.shouldAnnounceExhausted('p1')).toBe(true);
    expect(budget.shouldAnnounceExhausted('p1')).toBe(false);
  });
});
