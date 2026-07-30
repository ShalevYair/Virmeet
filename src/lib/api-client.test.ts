import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMeeting, makePersona } from './engine/__tests__/helpers';

const getMeetingMock = vi.fn();
const listPersonasMock = vi.fn();
const getStoredApiKeyMock = vi.fn();
const engineRunMeetingMock = vi.fn();

vi.mock('./store', () => ({
  getMeeting: (...args: unknown[]) => getMeetingMock(...args),
  listPersonas: (...args: unknown[]) => listPersonasMock(...args),
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
const { runMeeting } = await import('./api-client');

beforeEach(() => {
  getMeetingMock.mockReset();
  listPersonasMock.mockReset();
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
