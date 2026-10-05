import { RosterImportError } from './rosterErrors.js';
import {
  ROSTER_EXTRACTION_INSTRUCTIONS,
  ROSTER_EXTRACTION_SCHEMA,
  validateExtraction,
  type RosterExtraction,
} from './rosterSchema.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const TIMEOUT_MS = 25_000;
const RETRY_DELAY_MS = 1_500;
/** Hasura actions drop 5xx bodies, so the app never sees the error code. 422 still carries it. */
const FORWARDED_ERROR = 422;
/** A dense month is ~4k output tokens; the cap stops a looping response from running up cost. */
const MAX_OUTPUT_TOKENS = 16_384;

export type RosterLlmInput =
  | { kind: 'text'; text: string }
  | { kind: 'file'; mimeType: string; bytes: Buffer };

export interface RosterLlmResult {
  extraction: RosterExtraction;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

type GenerateContentResponse = {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

function modelList(): string[] {
  const listed = (process.env.ROSTER_LLM_MODELS ?? '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  if (listed.length) return listed;
  const single = process.env.ROSTER_LLM_MODEL?.trim();
  return single ? [single] : [];
}

export function rosterLlmConfig() {
  const provider = (process.env.ROSTER_LLM_PROVIDER ?? 'gemini').trim().toLowerCase();
  /** Sending the raw file skips redaction, so it must only be enabled when the route does not train on inputs. */
  const allowRawFiles = process.env.ROSTER_LLM_ALLOW_RAW_FILES?.trim().toLowerCase() === 'true';
  if (provider === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim() ?? '';
    const models = modelList();
    return { provider, enabled: Boolean(apiKey) && models.length > 0, apiKey, models, allowRawFiles };
  }
  const apiKey = process.env.GEMINI_API_KEY?.trim() ?? '';
  const model = process.env.ROSTER_LLM_MODEL?.trim() || DEFAULT_MODEL;
  return {
    provider: 'gemini' as const,
    enabled: provider === 'gemini' && Boolean(apiKey),
    apiKey,
    models: [model],
    allowRawFiles,
  };
}

function requestBody(input: RosterLlmInput) {
  const inputPart =
    input.kind === 'text'
      ? { text: `--- ROSTER TEXT ---\n${input.text}` }
      : { inline_data: { mime_type: input.mimeType, data: input.bytes.toString('base64') } };

  return {
    system_instruction: { parts: [{ text: ROSTER_EXTRACTION_INSTRUCTIONS }] },
    contents: [{ role: 'user', parts: [inputPart] }],
    // Temperature stays at the Gemini 3 default: Google warns lower values can cause looping.
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      responseMimeType: 'application/json',
      responseJsonSchema: ROSTER_EXTRACTION_SCHEMA,
    },
  };
}

function openRouterContent(input: RosterLlmInput) {
  if (input.kind === 'text') {
    return `--- ROSTER TEXT ---\n${input.text}`;
  }
  const data = input.bytes.toString('base64');
  if (input.mimeType === 'application/pdf') {
    return [
      { type: 'text', text: 'Extract the duties from this roster PDF.' },
      { type: 'file', file: { filename: 'roster.pdf', file_data: `data:application/pdf;base64,${data}` } },
    ];
  }
  return [
    { type: 'text', text: 'Extract the duties from this roster image.' },
    { type: 'image_url', image_url: { url: `data:${input.mimeType};base64,${data}` } },
  ];
}

function openRouterBody(models: string[], input: RosterLlmInput) {
  return {
    models,
    messages: [
      { role: 'system', content: ROSTER_EXTRACTION_INSTRUCTIONS },
      { role: 'user', content: openRouterContent(input) },
    ],
    provider: { data_collection: 'deny' },
    max_tokens: MAX_OUTPUT_TOKENS,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'roster_extraction', strict: true, schema: ROSTER_EXTRACTION_SCHEMA },
    },
  };
}

type OpenRouterResponse = {
  model?: string;
  choices?: { message?: { content?: string | Array<{ text?: string }> } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

async function callOnce(url: string, headers: Record<string, string>, body: unknown, label: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new RosterImportError('ROSTER_PARSER_TIMEOUT', `${label} request timed out`, FORWARDED_ERROR);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const isRetryable = (status: number) => status === 429 || status >= 500;

function providerFailure(status: number, label: string): RosterImportError {
  if (status === 429) {
    return new RosterImportError('ROSTER_PARSER_BUSY', `${label} rate limit reached`, 429);
  }
  // The error body can echo request content, so only the status is kept.
  if (status >= 500) {
    return new RosterImportError('ROSTER_PARSER_TIMEOUT', `${label} request failed with status ${status}`, FORWARDED_ERROR);
  }
  return new RosterImportError('ROSTER_PARSER_UNAVAILABLE', `${label} request failed with status ${status}`, FORWARDED_ERROR);
}

async function callWithRetry(url: string, headers: Record<string, string>, body: unknown, label: string): Promise<Response> {
  let response = await callOnce(url, headers, body, label);
  if (isRetryable(response.status)) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    response = await callOnce(url, headers, body, label);
  }
  return response;
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return trimmed ? JSON.parse(trimmed) : null;
  } catch {
    return null;
  }
}

function geminiResult(payload: GenerateContentResponse, model: string): RosterLlmResult | null {
  const text = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? '')
    .join('')
    .trim();
  const extraction = validateExtraction(parseJsonText(text ?? ''));
  if (!extraction) return null;
  return {
    extraction,
    model,
    inputTokens: payload.usageMetadata?.promptTokenCount ?? null,
    outputTokens: payload.usageMetadata?.candidatesTokenCount ?? null,
  };
}

function openRouterResult(payload: OpenRouterResponse, fallbackModel: string): RosterLlmResult | null {
  const content = payload.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : content?.map((part) => part.text ?? '').join('');
  const extraction = validateExtraction(parseJsonText(text ?? ''));
  if (!extraction) return null;
  return {
    extraction,
    model: payload.model || fallbackModel,
    inputTokens: payload.usage?.prompt_tokens ?? null,
    outputTokens: payload.usage?.completion_tokens ?? null,
  };
}

export async function extractRosterDuties(input: RosterLlmInput): Promise<RosterLlmResult> {
  const config = rosterLlmConfig();
  if (!config.enabled) {
    throw new RosterImportError('ROSTER_PARSER_UNAVAILABLE', 'Roster LLM is not configured', FORWARDED_ERROR);
  }

  if (config.provider === 'openrouter') {
    return extractWithOpenRouter(input, config.apiKey, config.models);
  }
  return extractWithGemini(input, config.apiKey, config.models[0]);
}

async function extractWithGemini(input: RosterLlmInput, apiKey: string, model: string): Promise<RosterLlmResult> {
  const body = requestBody(input);
  const response = await callWithRetry(
    `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
    { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body,
    'Gemini',
  );
  if (!response.ok) throw providerFailure(response.status, 'Gemini');

  const payload = (await response.json()) as GenerateContentResponse;
  const result = geminiResult(payload, model);
  if (!result) {
    throw new RosterImportError(
      'ROSTER_PARSE_INVALID',
      `Gemini returned no valid extraction (finishReason ${payload.candidates?.[0]?.finishReason ?? 'unknown'})`,
    );
  }
  return result;
}

async function extractWithOpenRouter(input: RosterLlmInput, apiKey: string, models: string[]): Promise<RosterLlmResult> {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
  const response = await callWithRetry(OPENROUTER_URL, headers, openRouterBody(models, input), 'OpenRouter');
  if (!response.ok) throw providerFailure(response.status, 'OpenRouter');

  const payload = (await response.json()) as OpenRouterResponse;
  const result = openRouterResult(payload, models[0]);
  if (result) return result;

  const remaining = models.slice(1);
  if (!remaining.length) {
    throw new RosterImportError('ROSTER_PARSE_INVALID', 'OpenRouter returned no valid extraction');
  }

  const retry = await callWithRetry(OPENROUTER_URL, headers, openRouterBody(remaining, input), 'OpenRouter');
  if (!retry.ok) throw providerFailure(retry.status, 'OpenRouter');
  const retryPayload = (await retry.json()) as OpenRouterResponse;
  const retryResult = openRouterResult(retryPayload, remaining[0]);
  if (!retryResult) {
    throw new RosterImportError('ROSTER_PARSE_INVALID', 'OpenRouter returned no valid extraction');
  }
  return retryResult;
}
