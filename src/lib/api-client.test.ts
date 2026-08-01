import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMeeting, makePersona } from './engine/__tests__/helpers';

const getMeetingMock = vi.fn();
const listPersonasMock = vi.fn();
const updateMeetingMock = vi.fn();
const getStoredApiKeyMock = vi.fn();
const engineRunMeetingMock = vi.fn();

vi.mock('./store', () => ({
  getMeeting: (...args: unknown[]) => getMeetingMock(...args),
  listPersonas: (...args: unknown[]) => listPersonasMock(...args),
  updateMeeting: (...args: unknown[]) => updateMeetingMock(...args),
}));
vi.mock('./api-key', () => ({
  getStoredApiKey: (...args: unknown[]) => getStoredApiKeyMock(...args),
}));
vi.mock('./seed-loader', () => ({
  ensureSeedLoaded: async () => undefined,
}));
vi.mock('./engine/runner', () => ({
  runMeeting: (...args: unknown[]) => engineRunMeetingMock(...args),
}));

// Imported after the mocks above so api-client.ts picks up the mocked modules.
const { runMeeting, meetingsApi, ApiError } = await import('./api-client');

beforeEach(() => {
  getMeetingMock.mockReset();
  listPersonasMock.mockReset();
  updateMeetingMock.mockReset();
  getStoredApiKeyMock.mockReset();
  engineRunMeetingMock.mockReset();
});

describe('runMeeting — pre-flight API key check', () => {
  it('stops before the first model call when no Gemini key is stored', async () => {
    const p1 = makePersona({ name: 'ארכיטקט תשתיות' });
    const p2 = makePersona({ name: 'מנהל פרויקט' });
    const meeting = makeMeeting({ participantIds: [p1.id, p2.id], status: 'draft' });

    getMeetingMock.mockResolvedValue(meeting);
    listPersonasMock.mockResolvedValue([p1, p2]);
    getStoredApiKeyMock.mockReturnValue(null);

    const onError = vi.fn();
    await runMeeting(meeting.id, { onError });

    expect(engineRunMeetingMock).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0] as string).toContain('Gemini');
  });

  it('stops before any model call when the meeting has an unrecognized model id', async () => {
    const p1 = makePersona({ name: 'ארכיטקט תשתיות' });
    const p2 = makePersona({ name: 'מנהל פרויקט' });
    const meeting = makeMeeting({
      participantIds: [p1.id, p2.id],
      status: 'draft',
      model: 'gemini-2.0-flash' as never,
    });

    getMeetingMock.mockResolvedValue(meeting);
    listPersonasMock.mockResolvedValue([p1, p2]);
    getStoredApiKeyMock.mockReturnValue('gem-key');

    const onError = vi.fn();
    await runMeeting(meeting.id, { onError });

    expect(engineRunMeetingMock).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0] as string).toContain('gemini-2.0-flash');
  });

  it('proceeds to the engine once a Gemini key is stored', async () => {
    const p1 = makePersona({ name: 'ארכיטקט תשתיות' });
    const p2 = makePersona({ name: 'מנהל פרויקט' });
    const meeting = makeMeeting({ participantIds: [p1.id, p2.id], status: 'draft' });

    getMeetingMock.mockResolvedValue(meeting);
    listPersonasMock.mockResolvedValue([p1, p2]);
    getStoredApiKeyMock.mockReturnValue('gem-key');
    engineRunMeetingMock.mockResolvedValue(undefined);

    const onError = vi.fn();
    await runMeeting(meeting.id, { onError });

    expect(engineRunMeetingMock).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('runMeeting — resets transcript/usage before a re-run', () => {
  it('clears a previously-cancelled meeting\'s transcript and usage before the engine starts, so a re-run never accumulates onto stale state', async () => {
    const persona = makePersona({ name: 'ארכיטקט' });
    const meeting = makeMeeting({
      participantIds: [persona.id, persona.id],
      status: 'cancelled',
      transcript: [
        {
          id: 'e1',
          phase: 'discussion',
          speakerId: persona.id,
          speakerName: persona.name,
          text: 'שורה מהריצה הקודמת',
          createdAt: new Date().toISOString(),
        },
      ],
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 3 },
    });

    getMeetingMock.mockResolvedValue(meeting);
    listPersonasMock.mockResolvedValue([persona]);
    getStoredApiKeyMock.mockReturnValue('gem-key');
    engineRunMeetingMock.mockResolvedValue(undefined);

    await runMeeting(meeting.id, {});

    expect(updateMeetingMock).toHaveBeenCalledWith(meeting.id, {
      transcript: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 0 },
    });
    // The reset must land before the engine reads the meeting back, or the
    // fix is a no-op.
    const resetOrder = updateMeetingMock.mock.invocationCallOrder[0];
    const engineOrder = engineRunMeetingMock.mock.invocationCallOrder[0];
    expect(resetOrder).toBeLessThan(engineOrder);
  });

  it('is a no-op on a genuine first run of a draft meeting with an already-blank transcript', async () => {
    const persona = makePersona({ name: 'ארכיטקט' });
    const meeting = makeMeeting({ participantIds: [persona.id, persona.id], status: 'draft' });

    getMeetingMock.mockResolvedValue(meeting);
    listPersonasMock.mockResolvedValue([persona]);
    getStoredApiKeyMock.mockReturnValue('gem-key');
    engineRunMeetingMock.mockResolvedValue(undefined);

    await runMeeting(meeting.id, {});

    expect(updateMeetingMock).toHaveBeenCalledWith(meeting.id, {
      transcript: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 0 },
    });
    expect(engineRunMeetingMock).toHaveBeenCalledTimes(1);
  });
});

describe('meetingsApi.update — returning a meeting to draft', () => {
  it('rejects returning a completed meeting to draft', async () => {
    const meeting = makeMeeting({ status: 'completed' });
    getMeetingMock.mockResolvedValue(meeting);

    await expect(meetingsApi.update(meeting.id, { status: 'draft' })).rejects.toThrow(ApiError);
    expect(updateMeetingMock).not.toHaveBeenCalled();
  });

  it('allows returning a failed meeting to draft', async () => {
    const meeting = makeMeeting({ status: 'failed' });
    getMeetingMock.mockResolvedValue(meeting);
    updateMeetingMock.mockResolvedValue({ ...meeting, status: 'draft' });

    await expect(meetingsApi.update(meeting.id, { status: 'draft' })).resolves.toMatchObject({ status: 'draft' });
    expect(updateMeetingMock).toHaveBeenCalledWith(meeting.id, { status: 'draft' });
  });

  it('allows returning a cancelled meeting to draft', async () => {
    const meeting = makeMeeting({ status: 'cancelled' });
    getMeetingMock.mockResolvedValue(meeting);
    updateMeetingMock.mockResolvedValue({ ...meeting, status: 'draft' });

    await expect(meetingsApi.update(meeting.id, { status: 'draft' })).resolves.toMatchObject({ status: 'draft' });
    expect(updateMeetingMock).toHaveBeenCalledWith(meeting.id, { status: 'draft' });
  });
});
