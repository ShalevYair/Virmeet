import { describe, expect, it } from 'vitest';
import {
  computeDistinctivenessReport,
  redact,
  renderReport,
  shuffle,
} from '../eval-distinctiveness.ts';

describe('redact', () => {
  it('strips the speaker\'s own name and role from their statement', () => {
    const persona = { name: 'ארכיטקט תשתיות', role: 'ארכיטקט תשתיות' };
    const text = 'אני, ארכיטקט תשתיות, חושב שזה יעבוד.';
    expect(redact(text, persona)).toBe('אני, [פרסונה], חושב שזה יעבוד.');
  });

  it('leaves mentions of other participants alone (that content is fair game)', () => {
    const persona = { name: 'אליס', role: 'תפקיד' };
    const text = 'אני חושב שבוב טועה.';
    expect(redact(text, persona)).toBe(text);
  });

  it('is a no-op when name and role never appear in the text', () => {
    const persona = { name: 'אליס', role: 'ארכיטקטית' };
    const text = 'התשתית לא תעמוד בעומס הזה.';
    expect(redact(text, persona)).toBe(text);
  });
});

describe('shuffle', () => {
  it('preserves all elements, just reorders them', () => {
    const original = [1, 2, 3, 4, 5];
    const shuffled = shuffle(original);
    expect(shuffled).toHaveLength(original.length);
    expect([...shuffled].sort()).toEqual([...original].sort());
    // Original array must not be mutated.
    expect(original).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('computeDistinctivenessReport', () => {
  const participantNames = ['אליס', 'בוב'];

  it('scores 100% and passes when every guess is correct', () => {
    const anonymized = [
      { label: 'a1', actualSpeakerName: 'אליס', text: 'x' },
      { label: 'a2', actualSpeakerName: 'בוב', text: 'y' },
      { label: 'a3', actualSpeakerName: 'אליס', text: 'z' },
      { label: 'a4', actualSpeakerName: 'בוב', text: 'w' },
    ];
    const assignments = [
      { label: 'a1', speaker: 'אליס' },
      { label: 'a2', speaker: 'בוב' },
      { label: 'a3', speaker: 'אליס' },
      { label: 'a4', speaker: 'בוב' },
    ];
    const report = computeDistinctivenessReport(anonymized, assignments, participantNames);
    expect(report.accuracy).toBe(1);
    expect(report.baseline).toBeCloseTo(0.5);
    expect(report.ratio).toBeCloseTo(2);
    expect(report.passed).toBe(true);
  });

  it('scores at baseline and fails when guesses are effectively random (spec P7 self-check)', () => {
    // If every persona were fed the identical prompt, guesses would cluster around
    // chance — this is the plan's own sanity check that the metric itself works.
    const anonymized = [
      { label: 'a1', actualSpeakerName: 'אליס', text: 'x' },
      { label: 'a2', actualSpeakerName: 'בוב', text: 'y' },
      { label: 'a3', actualSpeakerName: 'אליס', text: 'z' },
      { label: 'a4', actualSpeakerName: 'בוב', text: 'w' },
    ];
    // Model guesses "אליס" for everything — no signal, at-or-below chance overall.
    const assignments = [
      { label: 'a1', speaker: 'אליס' },
      { label: 'a2', speaker: 'אליס' },
      { label: 'a3', speaker: 'אליס' },
      { label: 'a4', speaker: 'אליס' },
    ];
    const report = computeDistinctivenessReport(anonymized, assignments, participantNames);
    expect(report.accuracy).toBeCloseTo(0.5); // got both "אליס" statements right, both "בוב" wrong
    expect(report.ratio).toBeCloseTo(1);
    expect(report.passed).toBe(false);
  });

  it('builds a confusion matrix keyed by actual speaker', () => {
    const anonymized = [
      { label: 'a1', actualSpeakerName: 'אליס', text: 'x' },
      { label: 'a2', actualSpeakerName: 'אליס', text: 'y' },
    ];
    const assignments = [
      { label: 'a1', speaker: 'בוב' },
      { label: 'a2', speaker: 'בוב' },
    ];
    const report = computeDistinctivenessReport(anonymized, assignments, participantNames);
    expect(report.confusion.get('אליס')?.get('בוב')).toBe(2);
  });

  it('treats a missing assignment as an incorrect, non-crashing guess', () => {
    const anonymized = [{ label: 'a1', actualSpeakerName: 'אליס', text: 'x' }];
    const report = computeDistinctivenessReport(anonymized, [], participantNames);
    expect(report.correct).toBe(0);
    expect(report.passed).toBe(false);
  });
});

describe('renderReport', () => {
  it('renders a readable Hebrew report with both possible verdicts', () => {
    const passing = computeDistinctivenessReport(
      [{ label: 'a1', actualSpeakerName: 'אליס', text: 'x' }],
      [{ label: 'a1', speaker: 'אליס' }],
      ['אליס', 'בוב']
    );
    expect(renderReport(passing)).toContain('הפרסונות נבדלות מספיק');

    const failing = computeDistinctivenessReport(
      [{ label: 'a1', actualSpeakerName: 'אליס', text: 'x' }],
      [{ label: 'a1', speaker: 'בוב' }],
      ['אליס', 'בוב']
    );
    expect(renderReport(failing)).toContain('הפרסונות אינן נבדלות');
  });
});
