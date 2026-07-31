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
  it("stops before the first model call and names the participants whose model has no matching key", async () => {
    const claude1 = makePersona({ name: 'ארכיטקט תשתיות', model: 'claude-sonnet-5' });
    const claude2 = makePersona({ name: 'מנהל פרויקט', model: 'claude-sonnet-5' });
    const gemini1 = makePersona({ name: 'מומחה אבטחה', model: 'gemini-3.1-pro-preview' });
    const meeting = makeMeeting({
      participantIds: [claude1.id, claude2.id, gemini1.id],
      status: 'draft',
    });

    getMeetingMock.mockResolvedValue(meeting);
    listPersonasMock.mockResolvedValue([claude1, claude2, gemini1]);
    // Only a Gemini key was entered — matches the plan's first-run scenario.
    getStoredApiKeyMock.mockImplementation((provider: string) => (provider === 'gemini' ? 'gem-key' : null));

    const onError = vi.fn();
    await runMeeting(meeting.id, { onError });

    expect(engineRunMeetingMock).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    const message = onError.mock.calls[0][0] as string;
    expect(message).toContain(claude1.name);
    expect(message).toContain(claude2.name);
    expect(message).not.toContain(gemini1.name);
  });

  it('stops before any model call when a participant has an unrecognized model id', async () => {
    const known = makePersona({ name: 'ארכיטקט תשתיות', model: 'claude-sonnet-5' });
    const unknown = makePersona({ name: 'מומחה חיצוני', model: 'gemini-2.0-flash' });
    const meeting = makeMeeting({ participantIds: [known.id, unknown.id], status: 'draft' });

    getMeetingMock.mockResolvedValue(meeting);
    listPersonasMock.mockResolvedValue([known, unknown]);
    getStoredApiKeyMock.mockImplementation(() => 'ant-key');

    const onError = vi.fn();
    await runMeeting(meeting.id, { onError });

    expect(engineRunMeetingMock).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    const message = onError.mock.calls[0][0] as string;
    expect(message).toContain(unknown.name);
    expect(message).toContain('gemini-2.0-flash');
    expect(message).not.toContain(known.name);
  });

  it('proceeds to the engine once every participant model matches an available key', async () => {
    const gemini1 = makePersona({ name: 'מומחה אבטחה', model: 'gemini-3.1-pro-preview' });
    const claude1 = makePersona({ name: 'ארכיטקט תשתיות', model: 'claude-sonnet-5' });
    const meeting = makeMeeting({ participantIds: [gemini1.id, claude1.id], status: 'draft' });

    getMeetingMock.mockResolvedValue(meeting);
    listPersonasMock.mockResolvedValue([gemini1, claude1]);
    getStoredApiKeyMock.mockImplementation((provider: string) => (provider === 'gemini' ? 'gem-key' : 'ant-key'));
    engineRunMeetingMock.mockResolvedValue(undefined);

    const onError = vi.fn();
    await runMeeting(meeting.id, { onError });

    expect(engineRunMeetingMock).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('runMeeting — resets transcript/usage before a re-run', () => {
  it('clears a previously-cancelled meeting\'s transcript and usage before the engine starts, so a re-run never accumulates onto stale state', async () => {
    const persona = makePersona({ name: 'ארכיטקט', model: 'claude-sonnet-5' });
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
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, apiCalls: 3 },
    });

    getMeetingMock.mockResolvedValue(meeting);
    listPersonasMock.mockResolvedValue([persona]);
    getStoredApiKeyMock.mockImplementation(() => 'ant-key');
    engineRunMeetingMock.mockResolvedValue(undefined);

    await runMeeting(meeting.id, {});

    expect(updateMeetingMock).toHaveBeenCalledWith(meeting.id, {
      transcript: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, apiCalls: 0 },
    });
    // The reset must land before the engine reads the meeting back, or the
    // fix is a no-op.
    const resetOrder = updateMeetingMock.mock.invocationCallOrder[0];
    const engineOrder = engineRunMeetingMock.mock.invocationCallOrder[0];
    expect(resetOrder).toBeLessThan(engineOrder);
  });

  it('is a no-op on a genuine first run of a draft meeting with an already-blank transcript', async () => {
    const persona = makePersona({ name: 'ארכיטקט', model: 'claude-sonnet-5' });
    const meeting = makeMeeting({ participantIds: [persona.id, persona.id], status: 'draft' });

    getMeetingMock.mockResolvedValue(meeting);
    listPersonasMock.mockResolvedValue([persona]);
    getStoredApiKeyMock.mockImplementation(() => 'ant-key');
    engineRunMeetingMock.mockResolvedValue(undefined);

    await runMeeting(meeting.id, {});

    expect(updateMeetingMock).toHaveBeenCalledWith(meeting.id, {
      transcript: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, apiCalls: 0 },
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
