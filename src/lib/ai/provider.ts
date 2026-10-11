/**
 * AI provider abstraction (spec §3, §47, §61, §100, §111, §136).
 *
 * Architectural rule this file exists to enforce: the rest of the application never talks
 * to a model vendor directly. It asks a provider for a *validated structured result*, and
 * a provider that is not configured returns `not_configured` — it does not return
 * plausible-looking fiction.
 *
 * The spec is explicit that unavailable credentials must produce a real integration
 * architecture plus a truthful "Not configured" state. `AiUnavailableError` and the
 * `AiResult` union are how that truth travels up to the UI.
 */

import { z } from 'zod';

export type AiOperation =
  | 'vision_food_scan'
  | 'vision_label_ocr'
  | 'llm_chat'
  | 'llm_food_parse'
  | 'llm_plan'
  | 'llm_recipe'
  | 'speech_to_text';

export interface AiUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly imageCount: number;
  readonly audioSeconds: number;
  readonly latencyMs: number;
}

export const EMPTY_USAGE: AiUsage = {
  promptTokens: 0,
  completionTokens: 0,
  imageCount: 0,
  audioSeconds: 0,
  latencyMs: 0,
};

/** Thrown when a feature is requested but its provider has no credentials. */
export class AiUnavailableError extends Error {
  readonly code = 'not_configured' as const;
  readonly remediation: string;

  constructor(operation: AiOperation, remediation: string) {
    super(
      `The "${operation}" feature requires an AI provider that is not configured on this ` +
        `deployment.`,
    );
    this.name = 'AiUnavailableError';
    this.remediation = remediation;
  }
}

/** Thrown when the provider responded but the payload was unusable. */
export class AiResponseError extends Error {
  readonly code = 'invalid_response' as const;
  readonly detail: string;

  constructor(detail: string, detailRaw?: string) {
    super(`The AI provider returned an unusable response: ${detail}`);
    this.name = 'AiResponseError';
    this.detail = detailRaw ?? detail;
  }
}

/** Thrown on transport failure, timeout, or an HTTP error from the provider. */
export class AiRequestError extends Error {
  readonly code: 'request_failed' | 'timeout' | 'rate_limited';

  constructor(code: 'request_failed' | 'timeout' | 'rate_limited', message: string) {
    super(message);
    this.name = 'AiRequestError';
    this.code = code;
  }
}

export type AiResult<T> =
  | { readonly ok: true; readonly data: T; readonly usage: AiUsage; readonly model: string }
  | {
      readonly ok: false;
      readonly code:
        'not_configured' | 'invalid_response' | 'request_failed' | 'timeout' | 'rate_limited';
      readonly message: string;
      readonly remediation?: string;
    };

// =====================================================================================
// Structured output contracts (spec §100)
//
// Every AI output is parsed through one of these schemas. If a model returns malformed
// JSON, or values out of range, it is treated as a failure — never written to the
// database "best effort". This is what prevents an arbitrary AI payload from becoming a
// stored meal.
// =====================================================================================

/** A single food the model believes it saw. Identification only — no nutrition. */
export const detectedFoodSchema = z.object({
  label: z.string().min(1).max(200),
  category: z.string().max(100).nullish(),
  /** Alternatives the user may confirm instead (spec §9). */
  alternatives: z.array(z.string().min(1).max(200)).max(6).default([]),
  quantity: z.number().positive().max(100_000).nullish(),
  unit: z.string().max(40).nullish(),
  grams: z.number().positive().max(100_000).nullish(),
  gramsMin: z.number().positive().max(100_000).nullish(),
  gramsMax: z.number().positive().max(100_000).nullish(),
  foodRecognitionConfidence: z.number().min(0).max(1).nullish(),
  portionConfidence: z.number().min(0).max(1).nullish(),
  /** Normalised 0..1 box; omitted when segmentation is unreliable (spec §5). */
  boundingBox: z
    .object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().min(0).max(1),
      height: z.number().min(0).max(1),
    })
    .nullish(),
  polygon: z
    .array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }))
    .max(64)
    .nullish(),
  /** Ingredients the model thinks were used, for the "Tell AI More" flow (spec §14). */
  visibleIngredients: z.array(z.string().max(120)).max(20).default([]),
  preparation: z.string().max(200).nullish(),
});

export type DetectedFood = z.infer<typeof detectedFoodSchema>;

export const visionAnalysisSchema = z.object({
  foods: z.array(detectedFoodSchema).max(20),
  /** Overall scene notes, e.g. "mixed thali, hard to separate items". */
  sceneNotes: z.string().max(1000).nullish(),
  /**
   * Set true when the model could not confidently separate items. The UI must then not
   * draw segmentation overlays, per spec §5.
   */
  segmentationReliable: z.boolean().default(false),
});

export type VisionAnalysis = z.infer<typeof visionAnalysisSchema>;

/** Nutrition label OCR (spec §17). Values are per the label's stated serving. */
export const labelExtractionSchema = z.object({
  servingSizeText: z.string().max(120).nullish(),
  servingGrams: z.number().positive().max(100_000).nullish(),
  caloriesKcal: z.number().min(0).max(100_000).nullish(),
  proteinG: z.number().min(0).max(10_000).nullish(),
  carbsG: z.number().min(0).max(10_000).nullish(),
  fatG: z.number().min(0).max(10_000).nullish(),
  fiberG: z.number().min(0).max(10_000).nullish(),
  sugarG: z.number().min(0).max(10_000).nullish(),
  sodiumMg: z.number().min(0).max(1_000_000).nullish(),
  productName: z.string().max(200).nullish(),
  brandName: z.string().max(200).nullish(),
  /** Per-field confidence so low-quality reads force user confirmation (spec §17). */
  confidence: z.number().min(0).max(1).nullish(),
  /**
   * Fields the model could not read. The UI leaves these blank and asks the user, rather
   * than accepting a guessed number off a blurry label.
   */
  unreadableFields: z.array(z.string().max(60)).max(20).default([]),
});

export type LabelExtraction = z.infer<typeof labelExtractionSchema>;

/** Free-text or voice logging parsed into food items (spec §18, §19). */
export const parsedLogSchema = z.object({
  items: z
    .array(
      z.object({
        label: z.string().min(1).max(200),
        quantity: z.number().positive().max(100_000).nullish(),
        unit: z.string().max(40).nullish(),
        mealType: z
          .enum(['breakfast', 'lunch', 'snack', 'dinner', 'pre_workout', 'post_workout'])
          .nullish(),
        /** True when the user never stated an amount, so the UI must ask (spec §19). */
        quantityMissing: z.boolean().default(false),
      }),
    )
    .max(30),
  /** Anything the model wants the user to clarify. */
  ambiguities: z.array(z.string().max(300)).max(10).default([]),
  detectedMealType: z
    .enum(['breakfast', 'lunch', 'snack', 'dinner', 'pre_workout', 'post_workout'])
    .nullish(),
});

export type ParsedLog = z.infer<typeof parsedLogSchema>;

export interface VisionRequest {
  readonly operation: Extract<AiOperation, 'vision_food_scan' | 'vision_label_ocr'>;
  readonly imageBase64: string;
  readonly mimeType: string;
  /** User-supplied context such as "made with 2 tsp oil" (spec §14). */
  readonly userContext?: string | null;
  readonly cookingMethod?: string | null;
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface TranscribeRequest {
  readonly audioBase64: string;
  readonly mimeType: string;
  readonly language?: string | null;
}

export interface AiProvider {
  readonly name: string;
  /** True only when the provider has everything it needs to make a real call. */
  isConfigured(): boolean;
  /** Explanation shown to the user when not configured. */
  unavailableReason(): string;
  unavailableRemediation(): string;

  analyzeFoodImage(request: VisionRequest): Promise<AiResult<VisionAnalysis>>;
  extractNutritionLabel(request: VisionRequest): Promise<AiResult<LabelExtraction>>;
  parseFoodText(
    text: string,
    context: { locale?: string; nowIso?: string },
  ): Promise<AiResult<ParsedLog>>;
  chat(request: ChatRequest): Promise<AiResult<string>>;
  transcribe(request: TranscribeRequest): Promise<AiResult<string>>;
}

/**
 * Validate and narrow a parsed provider payload. Returns a failure result rather than
 * throwing, so callers handle malformed AI output as an expected condition.
 */
export function validateAiOutput<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  operation: AiOperation,
): AiResult<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return {
      ok: false,
      code: 'invalid_response',
      message: `The ${operation} response did not match the expected shape (${issues}).`,
    };
  }
  return { ok: true, data: parsed.data, usage: EMPTY_USAGE, model: 'unknown' };
}

/**
 * A provider that is deliberately inert. Used when no credentials are configured, so the
 * application can run and be demonstrably real while clearly reporting that the AI
 * features are unavailable. It NEVER fabricates a result.
 */
export class UnconfiguredProvider implements AiProvider {
  readonly name = 'none';

  constructor(private readonly operationRemediation: string) {}

  isConfigured(): boolean {
    return false;
  }

  unavailableReason(): string {
    return 'No AI provider is configured on this deployment.';
  }

  unavailableRemediation(): string {
    return this.operationRemediation;
  }

  private unavailable<T>(operation: AiOperation): AiResult<T> {
    return {
      ok: false,
      code: 'not_configured',
      message: this.unavailableReason(),
      remediation: this.operationRemediation,
    };
  }

  async analyzeFoodImage(): Promise<AiResult<VisionAnalysis>> {
    return this.unavailable('vision_food_scan');
  }
  async extractNutritionLabel(): Promise<AiResult<LabelExtraction>> {
    return this.unavailable('vision_label_ocr');
  }
  async parseFoodText(): Promise<AiResult<ParsedLog>> {
    return this.unavailable('llm_food_parse');
  }
  async chat(): Promise<AiResult<string>> {
    return this.unavailable('llm_chat');
  }
  async transcribe(): Promise<AiResult<string>> {
    return this.unavailable('speech_to_text');
  }
}

// =====================================================================================
// Cost accounting (spec §110)
// =====================================================================================

/**
 * Published per-million-token prices, used to estimate spend. Values that are not known
 * for certain are marked so the dashboard reports "unknown" rather than a false number.
 */
export interface ModelPricing {
  readonly promptPerMillionUsd: number;
  readonly completionPerMillionUsd: number;
  readonly perImageUsd?: number;
  readonly perAudioMinuteUsd?: number;
}

const PRICING: Record<string, ModelPricing> = {
  'gpt-4o-mini': { promptPerMillionUsd: 0.15, completionPerMillionUsd: 0.6 },
  'gpt-4o': { promptPerMillionUsd: 2.5, completionPerMillionUsd: 10 },
  'gpt-4.1-mini': { promptPerMillionUsd: 0.4, completionPerMillionUsd: 1.6 },
  'whisper-1': { promptPerMillionUsd: 0, completionPerMillionUsd: 0, perAudioMinuteUsd: 0.006 },
};

export interface CostEstimate {
  readonly usd: number;
  readonly basis: Record<string, number>;
  /** True when the model is not in the pricing table, so the figure is an undercount. */
  readonly pricingUnknown: boolean;
}

export function estimateCost(model: string, usage: AiUsage): CostEstimate {
  const pricing = PRICING[model];
  if (!pricing) {
    return { usd: 0, basis: { reason: 1 }, pricingUnknown: true };
  }

  const prompt = (usage.promptTokens / 1_000_000) * pricing.promptPerMillionUsd;
  const completion = (usage.completionTokens / 1_000_000) * pricing.completionPerMillionUsd;
  const image = usage.imageCount * (pricing.perImageUsd ?? 0);
  const audio = (usage.audioSeconds / 60) * (pricing.perAudioMinuteUsd ?? 0);

  return {
    usd: Number((prompt + completion + image + audio).toFixed(6)),
    basis: { prompt, completion, image, audio },
    pricingUnknown: false,
  };
}
