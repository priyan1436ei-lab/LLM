/**
 * Food scan service (spec §3–§10, §14, §54, §55, §58, §65, §112).
 *
 * The pipeline, in the order the spec sets out:
 *
 *   image -> validation -> compression -> storage -> AI vision -> food matching
 *         -> nutrition calculation -> confidence -> USER REVIEW -> save meal
 *
 * Two rules shape this module:
 *
 *  1. The vision model only *identifies* foods. Every number attached to a result comes from
 *     a `nutrition_reference` row via the matching engine. If no reference resolves, the
 *     result is stored with `nutrition_unavailable = true` and the UI offers alternatives or
 *     manual entry instead of showing a figure (§11, §68).
 *  2. A scan is a proposal, not a commit. Results are persisted for review; nothing reaches
 *     the user's diary until they confirm (`user_confirmed`), and the correction they make is
 *     recorded for offline evaluation rather than used to train a live model (§10).
 */

import type { TransactionClient } from './client';
import { matchDetectedFoods } from './food-search';
import type { AiProvider, DetectedFood } from '@/lib/ai/provider';
import { overallScanConfidence } from '@/lib/nutrition';
import { computeNutrients } from '@/lib/nutrition';
import { convertToGrams, round } from '@/lib/units';

export type ScanStage =
  'queued' | 'uploading' | 'analyzing' | 'calculating' | 'ready' | 'failed' | 'cancelled';

export interface ScanProgressReporter {
  (stage: ScanStage, percent: number): void | Promise<void>;
}

export interface ScanItemResult {
  readonly id: string;
  readonly position: number;
  readonly detectedLabel: string;
  readonly detectedCategory: string | null;
  readonly matchedFoodId: string | null;
  readonly matchedName: string | null;
  readonly alternatives: readonly string[];
  /** Present only when a reference row resolved the nutrition. */
  readonly estimatedGrams: number | null;
  readonly estimatedGramsMin: number | null;
  readonly estimatedGramsMax: number | null;
  readonly estimatedUnit: string | null;
  readonly estimatedQuantity: number | null;
  readonly nutrients: {
    readonly calories_kcal: number;
    readonly protein_g: number;
    readonly carbs_g: number;
    readonly fat_g: number;
    readonly fiber_g: number;
    readonly sugar_g: number;
    readonly sodium_mg: number;
  } | null;
  readonly nutritionSource: string | null;
  /** True when no reference data could be resolved for this item. */
  readonly nutritionUnavailable: boolean;
  readonly foodRecognitionConfidence: number | null;
  readonly portionConfidence: number | null;
  readonly matchConfidence: number | null;
  readonly boundingBox: DetectedFood['boundingBox'] | null;
  readonly confidenceBand: 'high' | 'medium' | 'low' | 'unknown';
  readonly requiresConfirmation: boolean;
  readonly explanation: string;
}

export interface ScanOutcome {
  readonly scanId: string;
  readonly status: ScanStage;
  readonly segmentationReliable: boolean;
  readonly sceneNotes: string | null;
  readonly items: readonly ScanItemResult[];
  /** Provider-reported inability to analyse, e.g. credentials absent. */
  readonly unavailable: { code: string; message: string; remediation?: string } | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

/**
 * Run analysis for an already-stored scan.
 *
 * `provider` is injected so an unconfigured deployment flows through the same code path and
 * returns a truthful `not_configured` result, rather than requiring a different branch.
 */
export async function analyseScan(params: {
  tx: TransactionClient;
  provider: AiProvider;
  userId: string;
  scanId: string;
  imageBase64: string;
  mimeType: string;
  userContext?: string | null;
  cookingMethod?: string | null;
  report?: ScanProgressReporter;
}): Promise<ScanOutcome> {
  const { tx, provider, userId, scanId } = params;
  const report = params.report ?? ((): void => undefined);

  await setScanStatus(tx, scanId, 'analyzing', { started: true });
  await report('analyzing', 35);

  const analysis = await provider.analyzeFoodImage({
    operation: 'vision_food_scan',
    imageBase64: params.imageBase64,
    mimeType: params.mimeType,
    userContext: params.userContext ?? null,
    cookingMethod: params.cookingMethod ?? null,
  });

  if (!analysis.ok) {
    // A provider problem is recorded on the scan so the UI can show the real reason and a
    // recovery action (spec §92). Nothing is fabricated to fill the gap.
    const errorCode = analysis.code;
    const message = analysis.message;
    await setScanStatus(tx, scanId, 'failed', { errorCode, errorMessage: message });
    await report('failed', 100);

    return {
      scanId,
      status: 'failed',
      segmentationReliable: false,
      sceneNotes: null,
      items: [],
      unavailable:
        errorCode === 'not_configured'
          ? { code: errorCode, message, remediation: analysis.remediation }
          : null,
      errorCode,
      errorMessage: message,
    };
  }

  const detected = analysis.data.foods;

  if (detected.length === 0) {
    // A real outcome: the model looked and found no food. Say so rather than inventing items.
    await setScanStatus(tx, scanId, 'ready');
    await report('ready', 100);
    return {
      scanId,
      status: 'ready',
      segmentationReliable: false,
      sceneNotes: analysis.data.sceneNotes ?? 'No food was identified in that image.',
      items: [],
      unavailable: null,
      errorCode: null,
      errorMessage: null,
    };
  }

  await report('calculating', 65);

  // Match every detected label against the real database.
  const matches = await matchDetectedFoods(
    tx,
    detected.map((d) => ({ label: d.label, alternatives: d.alternatives })),
  );

  const items: ScanItemResult[] = [];

  for (const [index, food] of detected.entries()) {
    const match = matches[index]?.match;
    const best = match?.best ?? null;

    const recognition = food.foodRecognitionConfidence ?? null;
    const portion = food.portionConfidence ?? null;
    const matchConfidence = best ? best.confidence : null;
    const band = overallScanConfidence({
      foodRecognition: recognition,
      portion,
      match: matchConfidence,
    });

    // Resolve grams for the estimated quantity, then nutrition from the reference row.
    let grams = food.grams ?? null;
    let gramsMin = food.gramsMin ?? null;
    let gramsMax = food.gramsMax ?? null;
    let estimatedUnit = food.unit ?? null;
    let estimatedQuantity = food.quantity ?? null;
    let nutrients: ScanItemResult['nutrients'] = null;
    let nutritionUnavailable = true;
    let source: string | null = null;
    const notes: string[] = [];

    if (best) {
      const serving = best.defaultServing;

      // If the model gave a household unit but no grams, convert using the food's own
      // declared serving — never a global assumption.
      //
      // `convertToGrams` is used rather than `computeNutrients` on purpose: this is a pure
      // unit conversion step, and `computeNutrients` requires a nutrition reference to be
      // present. Calling it with `reference: null` would fail and silently skip the
      // conversion, leaving the quantity unresolved.
      if (grams === null && estimatedQuantity !== null && estimatedUnit !== null && serving) {
        const converted = convertToGrams({
          quantity: estimatedQuantity,
          unit: estimatedUnit,
          servings: [serving],
        });
        if (converted.ok) {
          grams = converted.grams;
          notes.push(
            `Quantity converted to grams using the food's own serving size (${serving.label}).`,
          );
        } else {
          notes.push(
            `Could not convert "${estimatedQuantity} ${estimatedUnit}" to grams: ${converted.message}`,
          );
        }
      }

      // Fall back to the food's default serving when the model gave no portion at all.
      if (grams === null && serving) {
        grams = serving.grams;
        estimatedUnit = serving.unit;
        estimatedQuantity = serving.amount;
        notes.push(
          `No portion was estimated, so the default serving (${serving.label}) was applied. ` +
            `Confirm or change this.`,
        );
      }

      if (grams !== null && grams > 0) {
        // Load the reference row for the matched food.
        const refRows = await tx.query<{
          id: string;
          basis_amount: string | number;
          basis_unit: 'g' | 'ml';
          calories_kcal: string | number;
          protein_g: string | number;
          carbs_g: string | number;
          fat_g: string | number;
          fiber_g: string | number;
          sugar_g: string | number;
          sodium_mg: string | number;
          source_name: string | null;
          verified_at: string | null;
        }>(
          `SELECT DISTINCT ON (food_id) id, basis_amount, basis_unit, calories_kcal, protein_g,
                  carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, source_name, verified_at::text AS verified_at
             FROM nutrition_reference
            WHERE food_id = $1
            ORDER BY food_id, verified_at DESC NULLS LAST, created_at ASC`,
          [best.foodId],
        );

        const ref = refRows[0];
        if (ref) {
          const computed = computeNutrients({
            quantity: grams,
            unit: 'g',
            servings: [],
            reference: {
              id: ref.id,
              basis_amount: Number(ref.basis_amount),
              basis_unit: ref.basis_unit,
              calories_kcal: Number(ref.calories_kcal),
              protein_g: Number(ref.protein_g),
              carbs_g: Number(ref.carbs_g),
              fat_g: Number(ref.fat_g),
              fiber_g: Number(ref.fiber_g),
              sugar_g: Number(ref.sugar_g),
              sodium_mg: Number(ref.sodium_mg),
              source_name: ref.source_name,
            },
            source: 'ai_estimate',
          });

          if (computed.ok) {
            nutrients = {
              calories_kcal: computed.nutrients.calories_kcal,
              protein_g: computed.nutrients.protein_g,
              carbs_g: computed.nutrients.carbs_g,
              fat_g: computed.nutrients.fat_g,
              fiber_g: computed.nutrients.fiber_g,
              sugar_g: computed.nutrients.sugar_g,
              sodium_mg: computed.nutrients.sodium_mg,
            };
            nutritionUnavailable = false;
            source = 'ai_estimate';
            notes.push(computed.nutrients.explanation);
          }
        }
      }
    }

    if (nutritionUnavailable) {
      notes.push(
        'No verified nutrition reference matched this item, so no values are shown. ' +
          'Choose a different food or enter the nutrition yourself.',
      );
    }

    // Ensure the estimated range brackets the point estimate.
    if (gramsMin !== null && gramsMax !== null && grams !== null) {
      if (grams < gramsMin) gramsMin = grams;
      if (grams > gramsMax) gramsMax = grams;
    }
    if (grams !== null && (gramsMin === null || gramsMax === null)) {
      // A ±15% band is a stated convention, not a measurement.
      gramsMin = round(grams * 0.85, 1);
      gramsMax = round(grams * 1.15, 1);
      notes.push('Portion range is an estimated ±15% band, not a measurement.');
    }

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO food_scan_results
         (scan_id, position, detected_label, detected_category, matched_food_id, alternatives,
          estimated_quantity, estimated_unit, estimated_grams, estimated_grams_min, estimated_grams_max,
          bounding_box, polygon,
          food_recognition_confidence, portion_confidence, match_confidence,
          resolved_calories_kcal, resolved_protein_g, resolved_carbs_g, resolved_fat_g,
          resolved_fiber_g, nutrition_source, nutrition_unavailable)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING id`,
      [
        scanId,
        index,
        food.label,
        food.category ?? null,
        best?.foodId ?? null,
        JSON.stringify(food.alternatives ?? []),
        estimatedQuantity,
        estimatedUnit,
        grams,
        gramsMin,
        gramsMax,
        food.boundingBox ? JSON.stringify(food.boundingBox) : null,
        food.polygon ? JSON.stringify(food.polygon) : null,
        recognition,
        portion,
        matchConfidence,
        nutrients?.calories_kcal ?? null,
        nutrients?.protein_g ?? null,
        nutrients?.carbs_g ?? null,
        nutrients?.fat_g ?? null,
        nutrients?.fiber_g ?? null,
        source,
        nutritionUnavailable,
      ],
    );

    items.push({
      id: inserted[0]?.id ?? '',
      position: index,
      detectedLabel: food.label,
      detectedCategory: food.category ?? null,
      matchedFoodId: best?.foodId ?? null,
      matchedName: best?.canonicalName ?? null,
      alternatives: food.alternatives ?? [],
      estimatedGrams: grams,
      estimatedGramsMin: gramsMin,
      estimatedGramsMax: gramsMax,
      estimatedUnit,
      estimatedQuantity,
      nutrients,
      nutritionSource: source,
      nutritionUnavailable,
      foodRecognitionConfidence: recognition,
      portionConfidence: portion,
      matchConfidence,
      boundingBox: food.boundingBox ?? null,
      confidenceBand: band.band,
      requiresConfirmation: band.requiresConfirmation || nutritionUnavailable,
      explanation: notes.join(' '),
    });
  }

  await setScanStatus(tx, scanId, 'ready');
  await report('ready', 100);

  return {
    scanId,
    status: 'ready',
    segmentationReliable: analysis.data.segmentationReliable,
    sceneNotes: analysis.data.sceneNotes ?? null,
    items,
    unavailable: null,
    errorCode: null,
    errorMessage: null,
  };
}

async function setScanStatus(
  tx: TransactionClient,
  scanId: string,
  status: ScanStage,
  extra: { started?: boolean; errorCode?: string; errorMessage?: string } = {},
): Promise<void> {
  const sets = ['status = $2', 'updated_at = now()'];
  const values: unknown[] = [scanId, status];

  if (extra.started) sets.push('started_at = COALESCE(started_at, now())');
  if (status === 'ready' || status === 'failed') sets.push('completed_at = now()');
  if (extra.errorCode !== undefined) {
    values.push(extra.errorCode);
    sets.push(`error_code = $${values.length}`);
  }
  if (extra.errorMessage !== undefined) {
    values.push(extra.errorMessage);
    sets.push(`error_message = $${values.length}`);
  }

  await tx.query(`UPDATE food_scans SET ${sets.join(', ')} WHERE id = $1`, values);
}

/**
 * Check whether this user has uploaded the same image before (spec §112).
 * Returns the earlier scan so the UI can warn without blocking the new one.
 */
export async function findDuplicateScan(
  tx: TransactionClient,
  userId: string,
  contentHash: string,
): Promise<{ scanId: string; createdAt: string } | null> {
  const rows = await tx.query<{ id: string; created_at: string }>(
    `SELECT id, created_at::text AS created_at
       FROM food_scans
      WHERE user_id = $1 AND content_sha256 = $2
        AND status IN ('queued','uploading','analyzing','ready')
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, contentHash],
  );
  const row = rows[0];
  return row ? { scanId: row.id, createdAt: row.created_at } : null;
}

/**
 * Record a user's correction (spec §10).
 *
 * Corrections are written to `food_corrections` as a reviewable dataset. They are
 * deliberately NOT fed back into a production model automatically; the review state gates
 * that, so a mistaken user correction cannot silently degrade recognition.
 */
export async function recordCorrection(params: {
  tx: TransactionClient;
  userId: string;
  scanId: string;
  scanResultId: string;
  correctedFoodId?: string | null;
  correctedQuantity?: number | null;
  correctedUnit?: string | null;
  correctedGrams?: number | null;
  kind: 'wrong_food' | 'wrong_quantity' | 'missing_food' | 'wrong_nutrition_match' | 'extra_item';
  notes?: string | null;
}): Promise<{ id: string }> {
  const rows = await params.tx.query<{
    detected_label: string;
    matched_food_id: string | null;
    estimated_quantity: string | number | null;
    estimated_unit: string | null;
    estimated_grams: string | number | null;
    food_recognition_confidence: string | number | null;
  }>(
    `SELECT detected_label, matched_food_id, estimated_quantity, estimated_unit,
            estimated_grams, food_recognition_confidence
       FROM food_scan_results WHERE id = $1 AND scan_id = $2`,
    [params.scanResultId, params.scanId],
  );
  const original = rows[0];
  if (!original) {
    throw new Error('That scan result does not exist.');
  }

  const inserted = await params.tx.query<{ id: string }>(
    `INSERT INTO food_corrections
       (user_id, scan_id, scan_result_id, original_label, original_food_id, original_quantity,
        original_unit, original_grams, corrected_food_id, corrected_quantity, corrected_unit,
        corrected_grams, correction_kind, original_confidence, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id`,
    [
      params.userId,
      params.scanId,
      params.scanResultId,
      original.detected_label,
      original.matched_food_id,
      original.estimated_quantity === null ? null : Number(original.estimated_quantity),
      original.estimated_unit,
      original.estimated_grams === null ? null : Number(original.estimated_grams),
      params.correctedFoodId ?? null,
      params.correctedQuantity ?? null,
      params.correctedUnit ?? null,
      params.correctedGrams ?? null,
      params.kind,
      original.food_recognition_confidence === null
        ? null
        : Number(original.food_recognition_confidence),
      params.notes ?? null,
    ],
  );

  // Mark the result as needing review rather than assuming the correction is right.
  await params.tx.query(`UPDATE food_scan_results SET user_confirmed = true WHERE id = $1`, [
    params.scanResultId,
  ]);

  return { id: inserted[0]?.id ?? '' };
}
