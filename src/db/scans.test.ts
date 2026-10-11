/**
 * Scan pipeline tests (spec §3, §8, §9, §11, §68, §92, §112).
 *
 * The load-bearing assertions here are the negative ones: an unconfigured provider must
 * produce a truthful `not_configured` state, and an identified food with no matching
 * reference row must yield `nutritionUnavailable` rather than invented numbers.
 *
 * The provider is a real implementation of the `AiProvider` interface, so the pipeline runs
 * unmodified; only the network call is replaced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  AiProvider,
  AiResult,
  ChatRequest,
  LabelExtraction,
  ParsedLog,
  TranscribeRequest,
  VisionAnalysis,
  VisionRequest,
} from '@/lib/ai/provider';
import { UnconfiguredProvider } from '@/lib/ai/provider';

let tempDir: string;
let userId: string;
let foodIds: Record<string, string> = {};

/** A provider that returns a fixed identification, to drive the matching pipeline. */
class StubVisionProvider implements AiProvider {
  readonly name = 'stub';
  constructor(private readonly analysis: VisionAnalysis) {}
  isConfigured(): boolean {
    return true;
  }
  unavailableReason(): string {
    return '';
  }
  unavailableRemediation(): string {
    return '';
  }
  async analyzeFoodImage(): Promise<AiResult<VisionAnalysis>> {
    return {
      ok: true,
      data: this.analysis,
      usage: { promptTokens: 0, completionTokens: 0, imageCount: 1, audioSeconds: 0, latencyMs: 1 },
      model: 'stub',
    };
  }
  async extractNutritionLabel(): Promise<AiResult<LabelExtraction>> {
    return { ok: false, code: 'not_configured', message: 'not used' };
  }
  async parseFoodText(): Promise<AiResult<ParsedLog>> {
    return { ok: false, code: 'not_configured', message: 'not used' };
  }
  async chat(_r: ChatRequest): Promise<AiResult<string>> {
    return { ok: false, code: 'not_configured', message: 'not used' };
  }
  async transcribe(_r: TranscribeRequest): Promise<AiResult<string>> {
    return { ok: false, code: 'not_configured', message: 'not used' };
  }
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'fittrack-scan-'));
  process.env.PGLITE_DATA_DIR = tempDir;
  process.env.APP_ENV = 'development';

  const { migrate } = await import('@/db/migrate');
  await migrate();

  const { transaction } = await import('@/db/client');
  const { seedReferenceData } = await import('@/db/seed');
  await transaction(async (tx) => {
    await seedReferenceData(tx);
    const r = await tx.query<{ id: string }>(
      `INSERT INTO profiles (email, password_hash, display_name)
       VALUES ('scanner@example.test','x','Scanner') RETURNING id`,
    );
    userId = r[0]!.id;

    // Grab a few seeded foods so tests can reference known nutrition.
    // Names must match the seeded canonical names exactly: the dataset uses "Rice", not
    // "Cooked Rice".
    const foods = await tx.query<{ id: string; canonical_name: string }>(
      `SELECT id, canonical_name FROM foods WHERE canonical_name IN ('Idli','Rice','Chicken Curry')`,
    );
    foodIds = Object.fromEntries(foods.map((f) => [f.canonical_name, f.id]));
  });
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/client');
  await closeDb();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

/** Create a scan row the way the upload route would, without touching the network. */
async function createScan(idempotencyKey?: string, contentHash?: string): Promise<string> {
  const { transaction } = await import('@/db/client');
  return transaction(async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO food_scans (user_id, status, content_sha256, mime_type, byte_size, idempotency_key)
       VALUES ($1,'queued',$2,'image/jpeg',12345,$3) RETURNING id`,
      [userId, contentHash ?? null, idempotencyKey ?? null],
    );
    return r[0]!.id;
  });
}

describe('unconfigured provider', () => {
  it('reports not_configured instead of inventing an analysis', async () => {
    const { withUserTransaction } = await import('@/db/operations');
    const { analyseScan } = await import('@/db/scans');

    const scanId = await createScan();
    const provider = new UnconfiguredProvider('Set AI_VISION_PROVIDER and OPENAI_API_KEY.');

    const outcome = await withUserTransaction({ userId, role: 'user' }, (tx) =>
      analyseScan({
        tx,
        provider,
        userId,
        scanId,
        imageBase64: 'ZmFrZQ==',
        mimeType: 'image/jpeg',
      }),
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.items).toHaveLength(0);
    expect(outcome.unavailable?.code).toBe('not_configured');
    expect(outcome.unavailable?.remediation).toContain('AI_VISION_PROVIDER');
    expect(outcome.errorCode).toBe('not_configured');

    // The scan row must record the real reason, not a fabricated result.
    const { transaction } = await import('@/db/client');
    const row = await transaction(async (tx) => {
      const r = await tx.query<{ status: string; error_code: string | null }>(
        `SELECT status, error_code FROM food_scans WHERE id = $1`,
        [scanId],
      );
      return r[0]!;
    });
    expect(row.status).toBe('failed');
    expect(row.error_code).toBe('not_configured');
  });
});

describe('identified foods resolve real nutrition', () => {
  it('matches detected labels and computes nutrition from the reference rows', async () => {
    const { withUserTransaction } = await import('@/db/operations');
    const { analyseScan } = await import('@/db/scans');

    const scanId = await createScan();
    const provider = new StubVisionProvider({
      foods: [
        {
          label: 'Idli',
          category: 'breakfast',
          alternatives: ['Idly'],
          quantity: 2,
          unit: 'piece',
          grams: null,
          gramsMin: null,
          gramsMax: null,
          foodRecognitionConfidence: 0.95,
          portionConfidence: 0.8,
          boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
          polygon: null,
          visibleIngredients: [],
          preparation: 'steamed',
        },
        {
          label: 'Rice',
          category: 'rice',
          alternatives: [],
          quantity: 1,
          unit: 'katori',
          grams: null,
          gramsMin: null,
          gramsMax: null,
          foodRecognitionConfidence: 0.92,
          portionConfidence: 0.7,
          boundingBox: null,
          polygon: null,
          visibleIngredients: [],
          preparation: null,
        },
      ],
      sceneNotes: 'South Indian breakfast plate.',
      segmentationReliable: true,
    });

    const outcome = await withUserTransaction({ userId, role: 'user' }, (tx) =>
      analyseScan({
        tx,
        provider,
        userId,
        scanId,
        imageBase64: 'ZmFrZQ==',
        mimeType: 'image/jpeg',
      }),
    );

    expect(outcome.status).toBe('ready');
    expect(outcome.items).toHaveLength(2);
    expect(outcome.segmentationReliable).toBe(true);

    const idli = outcome.items[0]!;
    expect(idli.matchedName).toBe('Idli');
    expect(idli.nutritionUnavailable).toBe(false);
    // 2 idli x 45 g = 90 g, converted via the food's own declared serving size.
    expect(idli.estimatedGrams).toBe(90);
    expect(idli.nutrients).not.toBeNull();
    expect(idli.nutrients!.calories_kcal).toBeGreaterThan(0);
    // Portion range must bracket the point estimate.
    expect(idli.estimatedGramsMin!).toBeLessThanOrEqual(idli.estimatedGrams!);
    expect(idli.estimatedGramsMax!).toBeGreaterThanOrEqual(idli.estimatedGrams!);
    // Nutrition is an estimate and is labelled as such.
    expect(idli.nutritionSource).toBe('ai_estimate');

    const rice = outcome.items[1]!;
    expect(rice.matchedName).toBe('Rice');
    expect(rice.estimatedGrams).toBe(150); // 1 katori
    expect(rice.nutritionUnavailable).toBe(false);
  });

  it('marks an unmatched food as nutrition-unavailable rather than inventing values', async () => {
    const { withUserTransaction } = await import('@/db/operations');
    const { analyseScan } = await import('@/db/scans');

    const scanId = await createScan();
    const provider = new StubVisionProvider({
      foods: [
        {
          label: 'Zzzq Nonexistent Dish Xyz',
          category: null,
          alternatives: [],
          quantity: null,
          unit: null,
          grams: null,
          gramsMin: null,
          gramsMax: null,
          foodRecognitionConfidence: 0.4,
          portionConfidence: null,
          boundingBox: null,
          polygon: null,
          visibleIngredients: [],
          preparation: null,
        },
      ],
      sceneNotes: null,
      segmentationReliable: false,
    });

    const outcome = await withUserTransaction({ userId, role: 'user' }, (tx) =>
      analyseScan({
        tx,
        provider,
        userId,
        scanId,
        imageBase64: 'ZmFrZQ==',
        mimeType: 'image/jpeg',
      }),
    );

    const item = outcome.items[0]!;
    expect(item.matchedFoodId).toBeNull();
    expect(item.nutritionUnavailable).toBe(true);
    expect(item.nutrients).toBeNull();
    expect(item.requiresConfirmation).toBe(true);
    expect(item.explanation).toMatch(/no verified nutrition reference/i);
  });

  it('reports an empty result honestly when the image holds no food', async () => {
    const { withUserTransaction } = await import('@/db/operations');
    const { analyseScan } = await import('@/db/scans');

    const scanId = await createScan();
    const provider = new StubVisionProvider({
      foods: [],
      sceneNotes: 'No food detected; the image shows a laptop.',
      segmentationReliable: false,
    });

    const outcome = await withUserTransaction({ userId, role: 'user' }, (tx) =>
      analyseScan({
        tx,
        provider,
        userId,
        scanId,
        imageBase64: 'ZmFrZQ==',
        mimeType: 'image/jpeg',
      }),
    );

    expect(outcome.status).toBe('ready');
    expect(outcome.items).toHaveLength(0);
    expect(outcome.sceneNotes).toMatch(/no food/i);
  });

  it('flags items needing confirmation when confidence is not high', async () => {
    const { withUserTransaction } = await import('@/db/operations');
    const { analyseScan } = await import('@/db/scans');

    const scanId = await createScan();
    const provider = new StubVisionProvider({
      foods: [
        {
          label: 'Idli',
          category: 'breakfast',
          alternatives: [],
          quantity: 1,
          unit: 'piece',
          grams: null,
          gramsMin: null,
          gramsMax: null,
          foodRecognitionConfidence: 0.55,
          portionConfidence: 0.4,
          boundingBox: null,
          polygon: null,
          visibleIngredients: [],
          preparation: null,
        },
      ],
      sceneNotes: null,
      segmentationReliable: false,
    });

    const outcome = await withUserTransaction({ userId, role: 'user' }, (tx) =>
      analyseScan({
        tx,
        provider,
        userId,
        scanId,
        imageBase64: 'ZmFrZQ==',
        mimeType: 'image/jpeg',
      }),
    );

    const item = outcome.items[0]!;
    expect(item.confidenceBand).toBe('low');
    expect(item.requiresConfirmation).toBe(true);
    // All three confidences the spec requires must be present and separate.
    expect(item.foodRecognitionConfidence).toBe(0.55);
    expect(item.portionConfidence).toBe(0.4);
    expect(item.matchConfidence).toBe(1); // exact alias hit
  });
});

describe('duplicate detection', () => {
  it('finds a previously analysed identical image', async () => {
    const { transaction } = await import('@/db/client');
    const { findDuplicateScan } = await import('@/db/scans');

    const hash = 'a'.repeat(64);
    const first = await createScan(undefined, hash);

    // A live scan is created first, then a duplicate hash is detected against it.
    const found = await transaction(async (tx) => findDuplicateScan(tx, userId, hash));
    expect(found?.scanId).toBe(first);
  });
});

describe('correction capture', () => {
  it('stores the original AI result alongside the correction for review', async () => {
    const { withUserTransaction } = await import('@/db/operations');
    const { analyseScan, recordCorrection } = await import('@/db/scans');
    const { transaction } = await import('@/db/client');

    const scanId = await createScan();
    const provider = new StubVisionProvider({
      foods: [
        {
          label: 'Idli',
          category: null,
          alternatives: [],
          quantity: 1,
          unit: 'piece',
          grams: null,
          gramsMin: null,
          gramsMax: null,
          foodRecognitionConfidence: 0.6,
          portionConfidence: 0.5,
          boundingBox: null,
          polygon: null,
          visibleIngredients: [],
          preparation: null,
        },
      ],
      sceneNotes: null,
      segmentationReliable: false,
    });

    const outcome = await withUserTransaction({ userId, role: 'user' }, (tx) =>
      analyseScan({ tx, provider, userId, scanId, imageBase64: 'ZmZk', mimeType: 'image/jpeg' }),
    );
    const resultId = outcome.items[0]!.id;

    await withUserTransaction({ userId, role: 'user' }, (tx) =>
      recordCorrection({
        tx,
        userId,
        scanId,
        scanResultId: resultId,
        correctedFoodId: foodIds['Rice'] ?? null,
        correctedQuantity: 2,
        correctedUnit: 'katori',
        kind: 'wrong_food',
        notes: 'It was rice, not idli.',
      }),
    );

    const row = await transaction(async (tx) => {
      const r = await tx.query<{
        original_label: string;
        corrected_food_id: string | null;
        corrected_quantity: string | number | null;
        correction_kind: string;
        review_state: string;
        original_confidence: string | number | null;
      }>(
        `SELECT original_label, corrected_food_id, corrected_quantity, correction_kind, review_state, original_confidence FROM food_corrections WHERE scan_id = $1`,
        [scanId],
      );
      return r[0]!;
    });

    expect(row.original_label).toBe('Idli');
    expect(row.corrected_food_id).toBe(foodIds['Rice']);
    expect(Number(row.corrected_quantity)).toBe(2);
    expect(row.correction_kind).toBe('wrong_food');
    // Must enter the review queue, never auto-train a production model (spec §10).
    expect(row.review_state).toBe('pending');
    expect(Number(row.original_confidence)).toBeCloseTo(0.6, 2);
  });
});
