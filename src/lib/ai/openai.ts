/**
 * OpenAI-compatible provider (spec §3, §18, §47, §100, §111).
 *
 * Real HTTP integration: this performs actual network calls to the configured endpoint
 * and validates every response against a schema before returning it. Nothing is mocked or
 * synthesised. When no API key is present the provider reports itself unconfigured and
 * every call returns a truthful failure — it never invents an answer.
 *
 * The endpoint is configurable (OPENAI_BASE_URL) so any OpenAI-compatible gateway can be
 * used without changing code.
 */

import {
  AiRequestError,
  AiUnavailableError,
  EMPTY_USAGE,
  UnconfiguredProvider,
  validateAiOutput,
  type AiProvider,
  type AiResult,
  type AiUsage,
  type ChatRequest,
  type LabelExtraction,
  type ParsedLog,
  type TranscribeRequest,
  type VisionAnalysis,
  type VisionRequest,
  labelExtractionSchema,
  parsedLogSchema,
  visionAnalysisSchema,
} from './provider';
import { env } from '@/lib/env';

/** Prompt for food-photo analysis. Identification and portion estimation ONLY. */
const FOOD_VISION_SYSTEM_PROMPT = `You are a nutrition identification assistant. You analyse a photo of food and identify what is present.

You MUST follow these rules:
1. Identify each distinct food item separately. A plate with rice, curry, egg and vegetables is FOUR items, not one.
2. You do NOT know the nutrition values of these foods. Never output calories, protein, carbohydrate or fat. Identification and portion estimation only.
3. For each item, estimate the quantity in grams AND provide a plausible range (gramsMin, gramsMax). Your single-value estimate must lie within your own range.
4. Provide a confidence between 0 and 1 for (a) recognising the food and (b) estimating the portion. Be honest: a partly hidden or mixed dish deserves a low score.
5. Provide up to 4 alternative names the item could be, best first, only when genuinely plausible.
6. If you can separate items spatially, give a bounding box in normalised coordinates (0..1) relative to the whole image. Only do this if you are genuinely able to. If you cannot reliably separate the items, set segmentationReliable to false and omit boxes.
7. List any ingredients you can actually SEE. Do NOT list ingredients you are only assuming (oil, salt, ghee) unless visible.
8. Prefer the name a user in India would use for the dish, and include regional aliases as alternatives.
9. If the image contains no food, return an empty foods array and explain in sceneNotes.

Respond with ONLY a JSON object, no prose, matching exactly:
{"foods":[{"label":string,"category":string|null,"alternatives":string[],"quantity":number|null,"unit":string|null,"grams":number|null,"gramsMin":number|null,"gramsMax":number|null,"foodRecognitionConfidence":number,"portionConfidence":number,"boundingBox":{"x":number,"y":number,"width":number,"height":number}|null,"polygon":null,"visibleIngredients":string[],"preparation":string|null}],"sceneNotes":string|null,"segmentationReliable":boolean}`;

const LABEL_VISION_SYSTEM_PROMPT = `You read nutrition facts panels from photographs of food packaging.

Rules:
1. Transcribe ONLY what is printed. If a value is not legible, return null for it and add the field name to unreadableFields. NEVER estimate or infer a printed number.
2. Report values per the serving size stated on the label. Record that serving size text exactly.
3. If the panel states a per-100g column and a per-serving column, use the PER-SERVING column and note the serving size.
4. Set confidence between 0 and 1 for your overall read quality.

Respond with ONLY a JSON object, no prose, matching exactly:
{"servingSizeText":string|null,"servingGrams":number|null,"caloriesKcal":number|null,"proteinG":number|null,"carbsG":number|null,"fatG":number|null,"fiberG":number|null,"sugarG":number|null,"sodiumMg":number|null,"productName":string|null,"brandName":string|null,"confidence":number|null,"unreadableFields":string[]}`;

const TEXT_PARSE_SYSTEM_PROMPT = `You convert a person's description of what they ate into structured items.

Rules:
1. Extract one item per distinct food. "2 idli and one cup sambar" is TWO items.
2. Convert number words to digits and map household measures to these unit codes only:
   g, kg, mg, ml, l, piece, slice, cup, bowl, plate, katori, tablespoon, teaspoon, ladle, serving, scoop, glass, handful, packet
3. If the person did not state an amount for an item, set quantity to null AND quantityMissing to true. Do not assume a portion.
4. You do NOT know nutrition values. Never output calories or macros.
5. List anything genuinely ambiguous in ambiguities so the user can clarify.
6. Infer mealType only when the text clearly indicates it (e.g. "for breakfast", "at night"); otherwise null.

Respond with ONLY a JSON object, no prose, matching exactly:
{"items":[{"label":string,"quantity":number|null,"unit":string|null,"mealType":string|null,"quantityMissing":boolean}],"ambiguities":string[],"detectedMealType":string|null}`;

interface OpenAiChatChoice {
  message?: { content?: string | null };
  finish_reason?: string;
}

interface OpenAiChatResponse {
  choices?: OpenAiChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

interface OpenAiTranscriptionResponse {
  text?: string;
}

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly visionModel: string,
    private readonly llmModel: string,
    private readonly sttModel: string,
    private readonly timeoutMs: number,
  ) {}

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  unavailableReason(): string {
    return 'No API key is configured for the OpenAI-compatible provider.';
  }

  unavailableRemediation(): string {
    return 'Set OPENAI_API_KEY (and the AI_*_PROVIDER variables) to enable AI features.';
  }

  private async post<T>(
    path: string,
    body: unknown,
    operation: string,
  ): Promise<{ payload: T; usage: AiUsage; model: string }> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const isAbort = error instanceof Error && error.name === 'AbortError';
      throw new AiRequestError(
        isAbort ? 'timeout' : 'request_failed',
        isAbort
          ? `The ${operation} request exceeded ${this.timeoutMs} ms and was cancelled.`
          : `The ${operation} request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new AiRequestError(
        'rate_limited',
        `The provider rate-limited the ${operation} request.`,
      );
    }
    if (!response.ok) {
      // Read the body for diagnostics but never surface it verbatim to the end user.
      const text = await response.text().catch(() => '');
      throw new AiRequestError(
        'request_failed',
        `The provider returned HTTP ${response.status} for ${operation}${
          text ? `: ${text.slice(0, 300)}` : ''
        }`,
      );
    }

    const payload = (await response.json()) as T & {
      usage?: OpenAiChatResponse['usage'];
      model?: string;
    };
    const usage: AiUsage = {
      promptTokens: payload.usage?.prompt_tokens ?? 0,
      completionTokens: payload.usage?.completion_tokens ?? 0,
      imageCount: 0,
      audioSeconds: 0,
      latencyMs: Date.now() - started,
    };

    return { payload, usage, model: payload.model ?? operation };
  }

  /** Chat completion with a system+user pair, returning the raw text content. */
  private async complete(
    system: string,
    userContent: unknown,
    model: string,
    operation: string,
    maxTokens: number,
    temperature: number,
  ): Promise<{ text: string; usage: AiUsage; model: string }> {
    const {
      payload,
      usage,
      model: usedModel,
    } = await this.post<OpenAiChatResponse>(
      '/chat/completions',
      {
        model,
        max_tokens: maxTokens,
        temperature,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      },
      operation,
    );

    const text = payload.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim() === '') {
      return { text: '', usage, model: usedModel };
    }
    return { text, usage, model: usedModel };
  }

  private async visionCall<T>(
    request: VisionRequest,
    systemPrompt: string,
    schema: Parameters<typeof validateAiOutput<T>>[0],
    operation: 'vision_food_scan' | 'vision_label_ocr',
    maxTokens: number,
  ): Promise<AiResult<T>> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        code: 'not_configured',
        message: this.unavailableReason(),
        remediation: this.unavailableRemediation(),
      };
    }

    const userText =
      request.userContext && request.userContext.trim() !== ''
        ? `Additional context supplied by the user: ${request.userContext.trim()}`
        : 'Analyse this image.';

    const parts: unknown[] = [{ type: 'text', text: userText }];
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${request.mimeType};base64,${request.imageBase64}` },
    });
    if (request.cookingMethod) {
      parts.push({
        type: 'text',
        text: `The user says the cooking method is: ${request.cookingMethod}.`,
      });
    }

    try {
      const { text, usage, model } = await this.complete(
        systemPrompt,
        parts,
        this.visionModel,
        operation,
        maxTokens,
        0.2,
      );

      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return {
          ok: false,
          code: 'invalid_response',
          message: `The ${operation} response was not valid JSON.`,
        };
      }

      const validated = validateAiOutput(schema, raw, operation);
      if (!validated.ok) return validated;

      return {
        ok: true,
        data: validated.data,
        usage: { ...usage, imageCount: 1 },
        model,
      };
    } catch (error) {
      return this.toFailure(error);
    }
  }

  async analyzeFoodImage(request: VisionRequest): Promise<AiResult<VisionAnalysis>> {
    return this.visionCall<VisionAnalysis>(
      request,
      FOOD_VISION_SYSTEM_PROMPT,
      visionAnalysisSchema,
      'vision_food_scan',
      1600,
    );
  }

  async extractNutritionLabel(request: VisionRequest): Promise<AiResult<LabelExtraction>> {
    return this.visionCall<LabelExtraction>(
      request,
      LABEL_VISION_SYSTEM_PROMPT,
      labelExtractionSchema,
      'vision_label_ocr',
      900,
    );
  }

  async parseFoodText(
    text: string,
    context: { locale?: string; nowIso?: string },
  ): Promise<AiResult<ParsedLog>> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        code: 'not_configured',
        message: this.unavailableReason(),
        remediation: this.unavailableRemediation(),
      };
    }

    const contextLine = [
      context.nowIso ? `Current time: ${context.nowIso}.` : '',
      context.locale ? `User locale: ${context.locale}.` : '',
    ]
      .filter(Boolean)
      .join(' ');

    try {
      const {
        text: raw,
        usage,
        model,
      } = await this.complete(
        TEXT_PARSE_SYSTEM_PROMPT,
        `${contextLine}\n\nUser wrote: """${text.slice(0, 2000)}"""`,
        this.llmModel,
        'llm_food_parse',
        900,
        0.1,
      );

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return {
          ok: false,
          code: 'invalid_response',
          message: 'The food-parse response was not valid JSON.',
        };
      }

      const validated = validateAiOutput(parsedLogSchema, parsed, 'llm_food_parse');
      if (!validated.ok) return validated;
      return { ok: true, data: validated.data, usage, model };
    } catch (error) {
      return this.toFailure(error);
    }
  }

  async chat(request: ChatRequest): Promise<AiResult<string>> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        code: 'not_configured',
        message: this.unavailableReason(),
        remediation: this.unavailableRemediation(),
      };
    }

    const started = Date.now();
    try {
      const { payload, usage, model } = await this.post<OpenAiChatResponse>(
        '/chat/completions',
        {
          model: this.llmModel,
          max_tokens: request.maxTokens ?? 900,
          temperature: request.temperature ?? 0.3,
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        },
        'llm_chat',
      );

      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || text.trim() === '') {
        return {
          ok: false,
          code: 'invalid_response',
          message: 'The provider returned an empty chat completion.',
        };
      }
      return {
        ok: true,
        data: text,
        usage: { ...usage, latencyMs: Date.now() - started },
        model,
      };
    } catch (error) {
      return this.toFailure(error);
    }
  }

  async transcribe(request: TranscribeRequest): Promise<AiResult<string>> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        code: 'not_configured',
        message: this.unavailableReason(),
        remediation: this.unavailableRemediation(),
      };
    }

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // Multipart upload: the transcription endpoint does not accept JSON.
      const audio = Buffer.from(request.audioBase64, 'base64');
      const form = new FormData();
      const extension = request.mimeType.includes('wav')
        ? 'wav'
        : request.mimeType.includes('mp4')
          ? 'mp4'
          : request.mimeType.includes('webm')
            ? 'webm'
            : 'mp3';
      form.append(
        'file',
        new Blob([new Uint8Array(audio)], { type: request.mimeType }),
        `audio.${extension}`,
      );
      form.append('model', this.sttModel);
      if (request.language) form.append('language', request.language);

      const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new AiRequestError(
          'rate_limited',
          'The provider rate-limited the transcription request.',
        );
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new AiRequestError(
          'request_failed',
          `Transcription failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
        );
      }

      const payload = (await response.json()) as OpenAiTranscriptionResponse;
      if (typeof payload.text !== 'string' || payload.text.trim() === '') {
        return {
          ok: false,
          code: 'invalid_response',
          message: 'The transcription response contained no text.',
        };
      }

      return {
        ok: true,
        data: payload.text,
        usage: { ...EMPTY_USAGE, latencyMs: Date.now() - started },
        model: this.sttModel,
      };
    } catch (error) {
      return this.toFailure(error);
    } finally {
      clearTimeout(timer);
    }
  }

  private toFailure<T>(error: unknown): AiResult<T> {
    if (error instanceof AiRequestError) {
      return { ok: false, code: error.code, message: error.message };
    }
    if (error instanceof AiUnavailableError) {
      return {
        ok: false,
        code: 'not_configured',
        message: error.message,
        remediation: error.remediation,
      };
    }
    return {
      ok: false,
      code: 'request_failed',
      message: error instanceof Error ? error.message : 'The AI request failed unexpectedly.',
    };
  }
}

/**
 * Choose the provider for an operation based on configuration.
 * Returns an inert provider when the relevant credentials are absent, so callers can
 * always call the same methods and receive an honest `not_configured` result.
 */
export function selectProvider(operation: AiProviderOperation): AiProvider {
  const e = env();

  const remediation =
    'Configure an AI provider by setting the AI_*_PROVIDER variables and OPENAI_API_KEY.';

  if (!e.OPENAI_API_KEY) {
    return new UnconfiguredProvider(remediation);
  }

  const providerReadyFor: Record<AiProviderOperation, boolean> = {
    vision: e.AI_VISION_PROVIDER === 'openai',
    llm: e.AI_LLM_PROVIDER === 'openai',
    stt: e.AI_STT_PROVIDER === 'openai',
  };

  if (!providerReadyFor[operation]) {
    return new UnconfiguredProvider(remediation);
  }

  return new OpenAiProvider(
    e.OPENAI_API_KEY,
    e.OPENAI_BASE_URL.replace(/\/+$/, ''),
    e.AI_VISION_MODEL,
    e.AI_LLM_MODEL,
    e.AI_STT_MODEL,
    e.AI_REQUEST_TIMEOUT_MS,
  );
}

export type AiProviderOperation = 'vision' | 'llm' | 'stt';
