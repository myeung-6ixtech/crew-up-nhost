import { RosterImportError } from './rosterErrors.js';
import {
  ROSTER_EXTRACTION_INSTRUCTIONS,
  ROSTER_EXTRACTION_SCHEMA,
  validateExtraction,
  type RosterExtraction,
} from './rosterSchema.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const TIMEOUT_MS = 25_000;
const RETRY_DELAY_MS = 1_500;
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

export function rosterLlmConfig() {
  const provider = (process.env.ROSTER_LLM_PROVIDER ?? 'gemini').trim().toLowerCase();
  const apiKey = process.env.GEMINI_API_KEY?.trim() ?? '';
  const model = process.env.ROSTER_LLM_MODEL?.trim() || DEFAULT_MODEL;
  /** Sending the raw file skips redaction, so it must only be enabled on a paid-tier key. */
  const allowRawFiles = process.env.ROSTER_LLM_ALLOW_RAW_FILES?.trim().toLowerCase() === 'true';
  return { enabled: provider === 'gemini' && Boolean(apiKey), apiKey, model, allowRawFiles };
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

async function callOnce(model: string, apiKey: string, body: unknown): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new RosterImportError('ROSTER_PARSER_TIMEOUT', 'Gemini request timed out', 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const isRetryable = (status: number) => status === 429 || status >= 500;

export async function extractRosterDuties(input: RosterLlmInput): Promise<RosterLlmResult> {
  const { enabled, apiKey, model } = rosterLlmConfig();
  if (!enabled) {
    throw new RosterImportError('ROSTER_PARSER_UNAVAILABLE', 'Roster LLM is not configured', 503);
  }

  const body = requestBody(input);
  let response = await callOnce(model, apiKey, body);
  if (isRetryable(response.status)) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    response = await callOnce(model, apiKey, body);
  }

  if (response.status === 429) {
    throw new RosterImportError('ROSTER_PARSER_BUSY', 'Gemini rate limit reached', 429);
  }
  if (!response.ok) {
    // The error body can echo request content, so only the status is kept.
    throw new RosterImportError(
      response.status >= 500 ? 'ROSTER_PARSER_TIMEOUT' : 'ROSTER_PARSER_UNAVAILABLE',
      `Gemini request failed with status ${response.status}`,
      503,
    );
  }

  const payload = (await response.json()) as GenerateContentResponse;
  const text = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? '')
    .join('')
    .trim();

  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  const extraction = validateExtraction(parsed);
  if (!extraction) {
    throw new RosterImportError(
      'ROSTER_PARSE_INVALID',
      `Gemini returned no valid extraction (finishReason ${payload.candidates?.[0]?.finishReason ?? 'unknown'})`,
    );
  }

  return {
    extraction,
    model,
    inputTokens: payload.usageMetadata?.promptTokenCount ?? null,
    outputTokens: payload.usageMetadata?.candidatesTokenCount ?? null,
  };
}
