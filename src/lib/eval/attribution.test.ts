import { describe, expect, it, vi } from 'vitest';
import type { TranscriptEntry } from '../types';
import { buildAttributionInput, scoreAttribution, type AttributionParticipant } from './attribution';

function entry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    id: `entry-${Math.random()}`,
    phase: 'discussion',
    speakerId: 'p1',
    speakerName: 'א',
    text: 'טקסט',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const participants: AttributionParticipant[] = [
  { id: 'p1', name: 'א', role: 'ארכיטקט' },
  { id: 'p2', name: 'ב', role: 'מנהל מוצר' },
];

describe('buildAttributionInput', () => {
  it('keeps only discussion-phase lines spoken by a known participant', () => {
    const transcript: TranscriptEntry[] = [
      entry({ phase: 'prep', speakerId: 'p1', text: 'prep line' }),
      entry({ phase: 'discussion', speakerId: 'system', text: 'system line' }),
      entry({ phase: 'discussion', speakerId: 'facilitator', text: 'facilitator line' }),
      entry({ phase: 'discussion', speakerId: 'p1', text: 'p1 says A' }),
      entry({ phase: 'discussion', speakerId: 'p2', text: 'p2 says B' }),
      entry({ phase: 'convergence', speakerId: 'p1', text: 'convergence line' }),
    ];

    const { items, truth } = buildAttributionInput(transcript, participants, 1);

    expect(items).toHaveLength(2);
    const texts = items.map((i) => i.text).sort();
    expect(texts).toEqual(['p1 says A', 'p2 says B']);
    for (const item of items) {
      expect(truth.get(item.index)).toBeDefined();
    }
  });

  it('produces the same shuffle for the same seed, and (typically) a different one for a different seed', () => {
    const transcript: TranscriptEntry[] = Array.from({ length: 10 }, (_, i) =>
      entry({ speakerId: i % 2 === 0 ? 'p1' : 'p2', text: `line ${i}` })
    );

    const a = buildAttributionInput(transcript, participants, 42);
    const b = buildAttributionInput(transcript, participants, 42);
    expect(a.items.map((i) => i.text)).toEqual(b.items.map((i) => i.text));

    const c = buildAttributionInput(transcript, participants, 7);
    expect(c.items.map((i) => i.text)).not.toEqual(a.items.map((i) => i.text));
  });

  it('maps truth to the participant name, not the raw speakerId', () => {
    const transcript: TranscriptEntry[] = [entry({ speakerId: 'p2', text: 'only line' })];
    const { truth } = buildAttributionInput(transcript, participants, 1);
    expect(truth.get(0)).toBe('ב');
  });
});

describe('scoreAttribution', () => {
  it('scores perfect guesses as 100% accuracy with full recall/precision per persona', () => {
    const truth = new Map([
      [0, 'א'],
      [1, 'ב'],
      [2, 'א'],
    ]);
    const guesses = [
      { index: 0, personaName: 'א' },
      { index: 1, personaName: 'ב' },
      { index: 2, personaName: 'א' },
    ];

    const score = scoreAttribution(truth, guesses, participants);
    expect(score.total).toBe(3);
    expect(score.correct).toBe(3);
    expect(score.accuracy).toBe(1);
    expect(score.chance).toBeCloseTo(0.5);
    expect(score.perPersona.find((p) => p.name === 'א')).toMatchObject({ recall: 1, precision: 1 });
  });

  it('computes chance as 1/N and handles wrong/missing guesses without crashing', () => {
    const truth = new Map([
      [0, 'א'],
      [1, 'ב'],
    ]);
    const guesses = [{ index: 0, personaName: 'ב' }]; // index 1 unanswered, index 0 wrong

    const score = scoreAttribution(truth, guesses, participants);
    expect(score.correct).toBe(0);
    expect(score.accuracy).toBe(0);
    expect(score.chance).toBeCloseTo(0.5);
    expect(score.confusion['א']['ב']).toBe(1);
    expect(score.confusion['ב']['(ללא תשובה)']).toBe(1);
  });
});

describe('runAttributionTest', () => {
  it('never forwards persona prompts or files to the judge — only name and role reach the prompt', async () => {
    vi.resetModules();
    const callModelMock = vi.fn().mockResolvedValue({
      text: JSON.stringify({ assignments: [{ index: 0, personaName: 'א' }] }),
      webSearches: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      refused: false,
      truncated: false,
    });
    vi.doMock('../llm', () => ({ callModel: callModelMock }));

    const { runAttributionTest } = await import('./attribution');
    const guesses = await runAttributionTest(
      { items: [{ index: 0, text: 'משהו שנאמר' }], truth: new Map([[0, 'א']]) },
      participants,
      { model: 'claude-sonnet-5', apiKey: 'k' }
    );

    expect(guesses).toEqual([{ index: 0, personaName: 'א' }]);
    const callArgs = callModelMock.mock.calls[0][0];
    const promptText = JSON.stringify(callArgs);
    // The type system already prevents AttributionParticipant from carrying
    // `prompt`/`files`, but assert on the actual call payload too so a future
    // refactor that widens the type can't silently leak it.
    expect(promptText).not.toContain('prompt');
    expect(promptText).not.toContain('files');
    vi.doUnmock('../llm');
  });
});
