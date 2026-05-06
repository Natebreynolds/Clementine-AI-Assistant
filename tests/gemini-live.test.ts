import { describe, expect, it } from 'vitest';

import { buildGeminiLiveSetup } from '../src/voice/gemini-live.js';

describe('Gemini Live relay config', () => {
  it('builds the raw WebSocket setup payload with audio, transcripts, and voice', () => {
    const setup = buildGeminiLiveSetup({
      model: 'models/gemini-3.1-flash-live-preview',
      voiceName: 'Kore',
      systemInstruction: 'Speak briefly.',
    }) as { config: Record<string, any> };

    expect(setup.config.model).toBe('models/gemini-3.1-flash-live-preview');
    expect(setup.config.responseModalities).toEqual(['AUDIO']);
    expect(setup.config.inputAudioTranscription).toEqual({});
    expect(setup.config.outputAudioTranscription).toEqual({});
    expect(setup.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(setup.config.systemInstruction.parts[0].text).toBe('Speak briefly.');
  });
});
