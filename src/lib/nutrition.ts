/**
 * Nutrition engine (spec §7, §11, §22, §23, §68, §69, §70, §111).
 *
 * This module is deliberately pure: given a reference value and a confirmed quantity it
 * returns nutrients. There is no network access and no model call here, and the spec
 * explicitly requires that nutrient arithmetic never involves an LLM (§111).
 *
 * The governing rule from the spec:
 *   "AI must NOT generate final nutrition values from memory."
 * The vision model only identifies food. Numbers come from a stored reference row, or
 * the result is labelled unavailable. `computeNutrients` therefore requires a reference
 * and has no branch that fabricates one.
 */

import { convertToGrams, round, type ServingDefinition } from './units';

/** A nutrient reference row, always expressed per `basisAmount` of `basisUnit`. */
export interface NutritionReference {
  readonly id: string;
  readonly basis_amount: number;
  readonly basis_unit: 'g' | 'ml';
  readonly calories_kcal: number;
  readonly protein_g: number;
  readonly carbs_g: number;
  readonly fat_g: number;
  readonly fiber_g: number;
  readonly sugar_g: number;
  readonly sodium_mg: number;
  readonly micronutrients?: Record<string, number> | null;
  readonly source?: string | null;
  readonly source_name?: string | null;
}

/** Provenance labels surfaced to the user (spec §69). */
export type NutrientSource =
  | 'database_record'
  | 'user_entered'
  | 'package_label'
  | 'ai_estimate'
  | 'recipe_calculated'
  | 'imported';

export interface NutrientValues {
  readonly calories_kcal: number;
  readonly protein_g: number;
  readonly carbs_g: number;
  readonly fat_g: number;
  readonly fiber_g: number;
  readonly sugar_g: number;
  readonly sodium_mg: number;
}

export interface NutrientBreakdown extends NutrientValues {
  /** The numbers this result was scaled from, so the UI can show its work (spec §70). */
  readonly per: {
    readonly amount: number;
    readonly unit: 'g' | 'ml';
    readonly values: NutrientValues;
  };
  /** The quantity actually used, after conversion. */
  readonly grams: number;
  /** Multiplier applied to the reference values. */
  readonly factor: number;
  readonly source: NutrientSource;
  readonly sourceName: string | null;
  /** True when the input quantity was a household measure, not a weighed mass. */
  readonly isApproximate: boolean;
  readonly explanation: string;
}

export type ComputeFailureReason = 'missing_reference' | 'invalid_reference' | 'invalid_quantity';

export interface ComputeFailure {
  readonly ok: false;
  readonly reason: ComputeFailureReason;
  readonly message: string;
}

export interface ComputeSuccess {
  readonly ok: true;
  readonly nutrients: NutrientBreakdown;
}

export type ComputeResult = ComputeSuccess | ComputeFailure;

const NUTRIENT_KEYS = [
  'calories_kcal',
  'protein_g',
  'carbs_g',
  'fat_g',
  'fiber_g',
  'sugar_g',
  'sodium_mg',
] as const;

function sanitize(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * Scale a reference row to a confirmed quantity.
 *
 * Spec §7 gives the formula exactly:
 *   nutrient amount = nutrition per reference serving × confirmed quantity ratio
 * This implements that, with the ratio always computed on grams.
 */
export function scaleReference(params: {
  readonly reference: NutritionReference | null | undefined;
  readonly grams: number;
  readonly source?: NutrientSource;
  readonly isApproximate?: boolean;
}): ComputeResult {
  const { reference, grams } = params;

  if (!reference) {
    return {
      ok: false,
      reason: 'missing_reference',
      message:
        'No nutrition reference is available for this food. Choose another food or enter ' +
        'the nutrition manually — the app will not guess values.',
    };
  }

  const basis = sanitize(reference.basis_amount);
  if (basis <= 0) {
    return {
      ok: false,
      reason: 'invalid_reference',
      message: `Nutrition reference ${reference.id} has a non-positive basis amount.`,
    };
  }

  if (!Number.isFinite(grams) || grams <= 0) {
    return {
      ok: false,
      reason: 'invalid_quantity',
      message: 'Quantity must resolve to a positive number of grams.',
    };
  }

  const factor = grams / basis;
  const per: NutrientValues = {
    calories_kcal: sanitize(reference.calories_kcal),
    protein_g: sanitize(reference.protein_g),
    carbs_g: sanitize(reference.carbs_g),
    fat_g: sanitize(reference.fat_g),
    fiber_g: sanitize(reference.fiber_g),
    sugar_g: sanitize(reference.sugar_g),
    sodium_mg: sanitize(reference.sodium_mg),
  };

  const decimals = reference.basis_unit === 'g' ? 3 : 3;
  const values: NutrientValues = {
    calories_kcal: round(per.calories_kcal * factor, 2),
    protein_g: round(per.protein_g * factor, decimals),
    carbs_g: round(per.carbs_g * factor, decimals),
    fat_g: round(per.fat_g * factor, decimals),
    fiber_g: round(per.fiber_g * factor, decimals),
    sugar_g: round(per.sugar_g * factor, decimals),
    sodium_mg: round(per.sodium_mg * factor, 2),
  };

  const source = params.source ?? 'database_record';

  return {
    ok: true,
    nutrients: {
      ...values,
      per: { amount: round(basis, 3), unit: reference.basis_unit, values: per },
      grams: round(grams, 3),
      factor: round(factor, 6),
      source,
      sourceName: reference.source_name ?? null,
      isApproximate: params.isApproximate ?? false,
      explanation:
        `${round(grams, 1)} g ÷ ${round(basis, 1)} ${reference.basis_unit} basis = ` +
        `×${round(factor, 3)} applied to the stored reference values` +
        (reference.source_name ? ` from ${reference.source_name}` : '') +
        '.',
    },
  };
}

/**
 * End-to-end: a user quantity + unit for a food with declared servings and a reference
 * row, resolved to nutrients. This is the single entry point meal logging uses.
 */
export function computeNutrients(params: {
  readonly quantity: number;
  readonly unit: string;
  readonly servings: readonly ServingDefinition[];
  readonly reference: NutritionReference | null | undefined;
  readonly source?: NutrientSource;
}): ComputeResult {
  const conversion = convertToGrams({
    quantity: params.quantity,
    unit: params.unit,
    servings: params.servings,
  });

  if (!conversion.ok) {
    return {
      ok: false,
      reason: 'invalid_quantity',
      message: conversion.message,
    };
  }

  return scaleReference({
    reference: params.reference,
    grams: conversion.grams,
    source: params.source,
    isApproximate: conversion.isApproximate,
  });
}

/** Sum a list of nutrient breakdowns, e.g. all items in a meal or a whole day. */
export function sumNutrients(items: readonly NutrientValues[]): NutrientValues {
  const total: Record<string, number> = {};
  for (const key of NUTRIENT_KEYS) total[key] = 0;

  for (const item of items) {
    for (const key of NUTRIENT_KEYS) {
      total[key] = (total[key] ?? 0) + sanitize(item[key]);
    }
  }

  return {
    calories_kcal: round(total.calories_kcal ?? 0, 2),
    protein_g: round(total.protein_g ?? 0, 3),
    carbs_g: round(total.carbs_g ?? 0, 3),
    fat_g: round(total.fat_g ?? 0, 3),
    fiber_g: round(total.fiber_g ?? 0, 3),
    sugar_g: round(total.sugar_g ?? 0, 3),
    sodium_mg: round(total.sodium_mg ?? 0, 2),
  };
}

export interface RemainingNutrients extends NutrientValues {
  /** Negative values mean the target was exceeded; the UI shows "over" rather than "remaining". */
  readonly isOver: Record<keyof NutrientValues, boolean>;
}

/** Remaining = target − consumed (spec §23). */
export function remainingNutrients(
  target: Partial<NutrientValues>,
  consumed: NutrientValues,
): RemainingNutrients {
  const diff = (t: number | undefined, c: number): number =>
    round(sanitize(t ?? 0) - sanitize(c), 2);
  const remaining: NutrientValues = {
    calories_kcal: diff(target.calories_kcal, consumed.calories_kcal),
    protein_g: diff(target.protein_g, consumed.protein_g),
    carbs_g: diff(target.carbs_g, consumed.carbs_g),
    fat_g: diff(target.fat_g, consumed.fat_g),
    fiber_g: diff(target.fiber_g, consumed.fiber_g),
    sugar_g: diff(target.sugar_g, consumed.sugar_g),
    sodium_mg: diff(target.sodium_mg, consumed.sodium_mg),
  };
  return {
    ...remaining,
    isOver: {
      calories_kcal: remaining.calories_kcal < 0,
      protein_g: remaining.protein_g < 0,
      carbs_g: remaining.carbs_g < 0,
      fat_g: remaining.fat_g < 0,
      fiber_g: remaining.fiber_g < 0,
      sugar_g: remaining.sugar_g < 0,
      sodium_mg: remaining.sodium_mg < 0,
    },
  };
}

// =====================================================================================
// Energy targets (spec §25)
// =====================================================================================

export type SexAtBirth = 'male' | 'female' | 'other' | 'undisclosed';
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';

const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

/** Mifflin-St Jeor. Requires sex, birth date and height; returns null when any is absent. */
export function basalMetabolicRate(params: {
  readonly sex: SexAtBirth | null;
  readonly birthDate: string | null;
  readonly heightCm: number | null;
  readonly weightKg: number;
}): number | null {
  const { sex, birthDate, heightCm, weightKg } = params;
  if (!sex || sex === 'undisclosed' || !birthDate || !heightCm) return null;
  if (!Number.isFinite(weightKg) || weightKg <= 0) return null;

  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - birth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < birth.getUTCDate())) age -= 1;
  if (age < 13 || age > 120) return null;

  // 'other' has no published equation; we use the midpoint of the two constants.
  const base = sex === 'male' ? 5 : sex === 'female' ? -161 : -78;
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + base;
  return bmr > 0 ? round(bmr, 1) : null;
}

export function totalDailyEnergyExpenditure(bmr: number, level: ActivityLevel): number {
  return round(bmr * ACTIVITY_FACTORS[level], 1);
}

/**
 * Safety floors (spec §25: "Avoid unsafe calorie targets").
 *
 * These are conservative guard rails, not clinical advice. When a computed target falls
 * below the floor the engine clamps it, flags `safetyFloorApplied`, and the UI explains
 * why — the app never silently prescribes a starvation diet.
 */
export const MINIMUM_CALORIES_BY_SEX: Record<SexAtBirth, number> = {
  male: 1500,
  female: 1200,
  other: 1350,
  undisclosed: 1350,
};

export function calorieSafetyFloor(sex: SexAtBirth | null, weightKg: number | null): number {
  const bySeed = MINIMUM_CALORIES_BY_SEX[sex ?? 'undisclosed'];
  // A higher absolute floor for very large bodies, still conservative.
  const byWeight = weightKg && weightKg > 0 ? Math.min(weightKg * 22, 2200) : 0;
  return round(Math.max(bySeed, byWeight), 0);
}

export interface CalorieTargetResult {
  readonly calories: number;
  readonly bmr: number | null;
  readonly tdee: number | null;
  readonly safetyFloor: number;
  readonly safetyFloorApplied: boolean;
  /** Plain-language reason for the number, shown on the goals screen. */
  readonly explanation: string;
}

export type GoalType =
  | 'weight_loss'
  | 'weight_maintenance'
  | 'weight_gain'
  | 'muscle_gain'
  | 'general_fitness'
  | 'medical_management';

/**
 * Derive a daily calorie target. Deficits/surpluses are capped at ~20% of TDEE, which is
 * the conservative end of common guidance, and the result is clamped by the safety floor.
 */
export function deriveCalorieTarget(params: {
  readonly goal: GoalType;
  readonly sex: SexAtBirth | null;
  readonly birthDate: string | null;
  readonly heightCm: number | null;
  readonly weightKg: number | null;
  readonly activityLevel: ActivityLevel;
}): CalorieTargetResult | null {
  const weight = params.weightKg;
  if (!weight || weight <= 0) return null;

  const bmr = basalMetabolicRate({
    sex: params.sex,
    birthDate: params.birthDate,
    heightCm: params.heightCm,
    weightKg: weight,
  });
  if (bmr === null) return null;

  const tdee = totalDailyEnergyExpenditure(bmr, params.activityLevel);

  const adjustment: Record<GoalType, number> = {
    weight_loss: -0.2,
    weight_maintenance: 0,
    weight_gain: 0.1,
    muscle_gain: 0.1,
    general_fitness: 0,
    medical_management: 0,
  };

  const raw = tdee * (1 + adjustment[params.goal]);
  const floor = calorieSafetyFloor(params.sex, weight);
  const applied = raw < floor;
  const calories = round(Math.max(raw, floor), 0);

  const direction =
    adjustment[params.goal] < 0
      ? 'deficit'
      : adjustment[params.goal] > 0
        ? 'surplus'
        : 'maintenance';

  return {
    calories,
    bmr,
    tdee,
    safetyFloor: floor,
    safetyFloorApplied: applied,
    explanation: applied
      ? `A ${direction} target from your estimated energy expenditure would fall below the ` +
        `safety floor of ${floor} kcal, so the target was raised to ${calories} kcal.`
      : `Estimated energy expenditure ${round(tdee, 0)} kcal with a ` +
        `${round(Math.abs(adjustment[params.goal]) * 100, 0)}% ${direction} = ${calories} kcal.`,
  };
}

/** Macro targets from energy and a protein-per-kg preference (spec §25). */
export function deriveMacroTargets(params: {
  readonly calories: number;
  readonly weightKg: number | null;
  readonly goal: GoalType;
  readonly dietPattern?: string;
}): { protein_g: number; carbs_g: number; fat_g: number; fiber_g: number; explanation: string } {
  const { calories, weightKg, goal } = params;

  // Protein g/kg by goal, within commonly cited ranges.
  const proteinPerKg =
    goal === 'muscle_gain'
      ? 1.8
      : goal === 'weight_loss'
        ? 1.6
        : goal === 'weight_gain'
          ? 1.6
          : 1.2;
  const proteinFromWeight = weightKg ? weightKg * proteinPerKg : null;
  // Without a body weight, fall back to a share of energy rather than guessing a mass.
  const protein_g = round(proteinFromWeight ?? (calories * 0.25) / 4, 0);

  // Fat at 25% of energy, which keeps enough room for carbohydrate.
  const fat_g = round((calories * 0.25) / 9, 0);
  const remainingKcal = Math.max(calories - protein_g * 4 - fat_g * 9, 0);
  const carbs_g = round(remainingKcal / 4, 0);

  // 14 g fibre per 1000 kcal is the widely used reference intake.
  const fiber_g = round((calories / 1000) * 14, 0);

  return {
    protein_g,
    carbs_g,
    fat_g,
    fiber_g,
    explanation:
      `Protein ${protein_g} g (${weightKg ? `${proteinPerKg} g/kg` : '25% of energy'}), ` +
      `fat 25% of energy (${fat_g} g), carbohydrate fills the remainder (${carbs_g} g), ` +
      `fibre 14 g per 1000 kcal (${fiber_g} g).`,
  };
}

/** Confidence banding for display (spec §8). */
export function confidenceBand(
  confidence: number | null | undefined,
): 'high' | 'medium' | 'low' | 'unknown' {
  if (confidence === null || confidence === undefined || !Number.isFinite(confidence))
    return 'unknown';
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

/**
 * Combine the three confidences the spec requires (§8) into the single band that gates
 * user confirmation. The weakest link governs, because a confident food match with a bad
 * portion estimate is still an unreliable entry.
 */
export function overallScanConfidence(params: {
  readonly foodRecognition?: number | null;
  readonly portion?: number | null;
  readonly match?: number | null;
}): {
  value: number | null;
  band: 'high' | 'medium' | 'low' | 'unknown';
  requiresConfirmation: boolean;
} {
  const parts = [params.foodRecognition, params.portion, params.match].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  if (parts.length === 0) {
    return { value: null, band: 'unknown', requiresConfirmation: true };
  }
  const value = round(Math.min(...parts), 3);
  const band = confidenceBand(value);
  return {
    value,
    band,
    // Anything below high confidence is presented as an editable estimate.
    requiresConfirmation: band !== 'high',
  };
}

/** Energy split for display, e.g. the macro ring on the dashboard. */
export function macroEnergySplit(values: NutrientValues): {
  proteinPct: number;
  carbsPct: number;
  fatPct: number;
} {
  const p = sanitize(values.protein_g) * 4;
  const c = sanitize(values.carbs_g) * 4;
  const f = sanitize(values.fat_g) * 9;
  const total = p + c + f;
  if (total <= 0) return { proteinPct: 0, carbsPct: 0, fatPct: 0 };
  return {
    proteinPct: round((p / total) * 100, 1),
    carbsPct: round((c / total) * 100, 1),
    fatPct: round((f / total) * 100, 1),
  };
}
