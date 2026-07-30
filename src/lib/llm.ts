// Virmeet — dispatches a model call to the right provider by model id, so the
// engine (runner.ts) can call one callModel() without caring whether a given
// persona is running on Claude or Gemini.

import { getModelProvider } from './types';
import { callModel as callAnthropicModel } from './anthropic';
import { callModel as callGeminiModel } from './gemini';
import type { CallModelOptions, CallModelResult } from './llm-types';

export async function callModel(opts: CallModelOptions): Promise<CallModelResult> {
  return getModelProvider(opts.model) === 'gemini' ? callGeminiModel(opts) : callAnthropicModel(opts);
}
