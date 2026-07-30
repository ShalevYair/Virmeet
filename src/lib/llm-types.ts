// Virmeet — provider-agnostic shapes for the model-call abstraction.
// anthropic.ts and gemini.ts each implement callModel() against these types;
// llm.ts dispatches between them by model id (see getModelProvider in types.ts).

export interface SystemBlock {
  type: 'text';
  text: string;
  /** If true, a cache breakpoint is placed here. Anthropic supports up to 4. */
  cacheBreakpoint?: boolean;
}

export interface CallModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface WebSearchOptions {
  maxUses: number;
}

export interface CallModelOptions {
  model: string;
  system: SystemBlock[];
  messages: CallModelMessage[];
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  webSearch?: WebSearchOptions;
  /** JSON schema for structured output. Must set additionalProperties:false and required on every field. */
  jsonSchema?: Record<string, unknown>;
  /** Optional key sent by the browser for this run, preferred over the server-side env key for this model's provider. Never logged or persisted. */
  apiKey?: string;
}

export interface CallModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface WebSearchQuery {
  query: string;
}

export interface CallModelResult {
  text: string;
  webSearches: WebSearchQuery[];
  usage: CallModelUsage;
  refused: boolean;
  /** True iff the response was cut off by the max_tokens limit — `text` is a partial response, not a complete one. Always false when `refused` is true. */
  truncated: boolean;
}
