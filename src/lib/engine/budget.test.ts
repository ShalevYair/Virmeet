import { describe, expect, it } from 'vitest';
import { CallBudget } from './budget';

describe('CallBudget', () => {
  it('allows calls until the limit is reached, then blocks', () => {
    const budget = new CallBudget(new Map([['p1', 2]]));
    expect(budget.canCall('p1')).toBe(true);
    budget.record('p1');
    expect(budget.canCall('p1')).toBe(true);
    budget.record('p1');
    expect(budget.canCall('p1')).toBe(false);
  });

  it('treats a persona with no configured limit as unbounded', () => {
    const budget = new CallBudget(new Map());
    budget.record('unlisted');
    budget.record('unlisted');
    expect(budget.canCall('unlisted')).toBe(true);
  });

  it('announces exhaustion exactly once', () => {
    const budget = new CallBudget(new Map([['p1', 1]]));
    budget.record('p1');
    expect(budget.canCall('p1')).toBe(false);
    expect(budget.shouldAnnounceExhausted('p1')).toBe(true);
    expect(budget.shouldAnnounceExhausted('p1')).toBe(false);
  });

  it('never announces exhaustion for a persona still under budget', () => {
    const budget = new CallBudget(new Map([['p1', 5]]));
    budget.record('p1');
    expect(budget.shouldAnnounceExhausted('p1')).toBe(false);
  });
});
