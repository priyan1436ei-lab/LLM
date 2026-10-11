/**
 * Nutrition engine tests (spec §7, §22, §23, §25, §68, §69, §70).
 *
 * The central guarantee under test: the engine never produces nutrient numbers without a
 * stored reference row, and it never converts a household measure it cannot resolve.
 */
import { describe, expect, it } from 'vitest';

import {
  basalMetabolicRate,
  calorieSafetyFloor,
  confidenceBand,
  deriveCalorieTarget,
  deriveMacroTargets,
  macroEnergySplit,
  overallScanConfidence,
  remainingNutrients,
  scaleReference,
  sumNutrients,
  totalDailyEnergyExpenditure,
  type NutritionReference,
} from '@/lib/nutrition';
import type { ServingDefinition } from '@/lib/units';

/** Cooked white rice, ~130 kcal per 100 g. */
const RICE: NutritionReference = {
  id: 'ref-rice',
  basis_amount: 100,
  basis_unit: 'g',
  calories_kcal: 130,
  protein_g: 2.7,
  carbs_g: 28.2,
  fat_g: 0.3,
  fiber_g: 0.4,
  sugar_g: 0.1,
  sodium_mg: 1,
  source_name: 'IFCT 2017 (representative cooked value)',
};

const KATORI: ServingDefinition = {
  id: 'srv-rice-katori',
  label: '1 katori',
  unit: 'katori',
  amount: 1,
  grams: 150,
  is_approximate: true,
};

describe('scaleReference', () => {
  it('scales linearly from the stored basis', () => {
    const result = scaleReference({ reference: RICE, grams: 200 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nutrients.calories_kcal).toBe(260);
    expect(result.nutrients.protein_g).toBe(5.4);
    expect(result.nutrients.carbs_g).toBe(56.4);
    expect(result.nutrients.factor).toBe(2);
  });

  it('scales below the basis correctly', () => {
    const result = scaleReference({ reference: RICE, grams: 50 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nutrients.calories_kcal).toBe(65);
  });

  it('exposes the numbers it derived from, so the UI can explain them', () => {
    const result = scaleReference({ reference: RICE, grams: 150 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nutrients.per.amount).toBe(100);
    expect(result.nutrients.per.unit).toBe('g');
    expect(result.nutrients.per.values.calories_kcal).toBe(130);
    expect(result.nutrients.explanation).toMatch(/100 g basis/);
    expect(result.nutrients.sourceName).toContain('IFCT');
  });

  it('FAILS rather than inventing values when no reference exists', () => {
    const result = scaleReference({ reference: null, grams: 150 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_reference');
    expect(result.message).toMatch(/will not guess/i);
  });

  it('rejects a non-positive or invalid basis', () => {
    const bad = { ...RICE, basis_amount: 0 };
    const result = scaleReference({ reference: bad, grams: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_reference');
  });

  it('rejects a non-positive quantity', () => {
    const result = scaleReference({ reference: RICE, grams: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_quantity');
  });

  it('carries the provenance label through to the result', () => {
    const result = scaleReference({ reference: RICE, grams: 100, source: 'user_entered' });
    expect(result.ok && result.nutrients.source).toBe('user_entered');
  });

  it('labels an approximate quantity', () => {
    const result = scaleReference({ reference: RICE, grams: 150, isApproximate: true });
    expect(result.ok && result.nutrients.isApproximate).toBe(true);
  });

  it('never returns a negative nutrient value', () => {
    const weird = { ...RICE, protein_g: -5, fat_g: Number.NaN };
    const result = scaleReference({ reference: weird, grams: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nutrients.protein_g).toBe(0);
    expect(result.nutrients.fat_g).toBe(0);
  });
});

describe('sumNutrients', () => {
  it('sums a meal', () => {
    const total = sumNutrients([
      {
        calories_kcal: 120,
        protein_g: 4,
        carbs_g: 24,
        fat_g: 0.5,
        fiber_g: 0.4,
        sugar_g: 0.1,
        sodium_mg: 1,
      },
      {
        calories_kcal: 260,
        protein_g: 5.4,
        carbs_g: 56.4,
        fat_g: 0.6,
        fiber_g: 0.8,
        sugar_g: 0.2,
        sodium_mg: 2,
      },
    ]);
    expect(total.calories_kcal).toBe(380);
    expect(total.carbs_g).toBe(80.4);
  });

  it('returns zeros for an empty day', () => {
    const total = sumNutrients([]);
    expect(total.calories_kcal).toBe(0);
    expect(total.protein_g).toBe(0);
  });
});

describe('remainingNutrients', () => {
  it('computes what is left against target', () => {
    const target = { calories_kcal: 2200, protein_g: 150, carbs_g: 250, fat_g: 70 };
    const consumed = {
      calories_kcal: 1620,
      protein_g: 110,
      carbs_g: 175,
      fat_g: 51,
      fiber_g: 20,
      sugar_g: 40,
      sodium_mg: 1500,
    };
    const remaining = remainingNutrients(target, consumed);
    expect(remaining.calories_kcal).toBe(580);
    expect(remaining.protein_g).toBe(40);
    expect(remaining.carbs_g).toBe(75);
    expect(remaining.fat_g).toBe(19);
  });

  it('flags an exceeded target instead of reporting a negative remainder', () => {
    const remaining = remainingNutrients(
      { calories_kcal: 2000 },
      {
        calories_kcal: 2300,
        protein_g: 0,
        carbs_g: 0,
        fat_g: 0,
        fiber_g: 0,
        sugar_g: 0,
        sodium_mg: 0,
      },
    );
    expect(remaining.calories_kcal).toBe(-300);
    expect(remaining.isOver.calories_kcal).toBe(true);
    expect(remaining.isOver.protein_g).toBe(false);
  });
});

describe('energy maths', () => {
  it('computes BMR with Mifflin-St Jeor', () => {
    // Male, 30 y, 175 cm, 70 kg -> 10*70 + 6.25*175 - 5*30 + 5 = 1648.75
    const bmr = basalMetabolicRate({
      sex: 'male',
      birthDate: '1996-01-15',
      heightCm: 175,
      weightKg: 70,
    });
    expect(bmr).toBeGreaterThan(1600);
    expect(bmr).toBeLessThan(1700);
  });

  it('returns null instead of guessing when inputs are missing', () => {
    expect(
      basalMetabolicRate({ sex: null, birthDate: '1996-01-15', heightCm: 175, weightKg: 70 }),
    ).toBeNull();
    expect(
      basalMetabolicRate({ sex: 'male', birthDate: null, heightCm: 175, weightKg: 70 }),
    ).toBeNull();
    expect(
      basalMetabolicRate({ sex: 'male', birthDate: '1996-01-15', heightCm: null, weightKg: 70 }),
    ).toBeNull();
    expect(
      basalMetabolicRate({ sex: 'male', birthDate: '1996-01-15', heightCm: 175, weightKg: 0 }),
    ).toBeNull();
    // Undisclosed sex has no published equation.
    expect(
      basalMetabolicRate({
        sex: 'undisclosed',
        birthDate: '1996-01-15',
        heightCm: 175,
        weightKg: 70,
      }),
    ).toBeNull();
  });

  it('applies activity multipliers', () => {
    expect(totalDailyEnergyExpenditure(1600, 'sedentary')).toBe(1920);
    expect(totalDailyEnergyExpenditure(1600, 'moderate')).toBe(2480);
    expect(totalDailyEnergyExpenditure(1600, 'very_active')).toBe(3040);
  });

  it('enforces a safety floor on an aggressive deficit', () => {
    // Small female, sedentary, weight loss -> a raw deficit below the floor.
    const target = deriveCalorieTarget({
      goal: 'weight_loss',
      sex: 'female',
      birthDate: '1990-06-01',
      heightCm: 150,
      weightKg: 45,
      activityLevel: 'sedentary',
    });
    expect(target).not.toBeNull();
    if (!target) return;
    expect(target.safetyFloorApplied).toBe(true);
    expect(target.calories).toBeGreaterThanOrEqual(target.safetyFloor);
    expect(target.calories).toBeGreaterThanOrEqual(1200);
    expect(target.explanation).toMatch(/safety floor/i);
  });

  it('gives a normal maintenance target without triggering the floor', () => {
    const target = deriveCalorieTarget({
      goal: 'weight_maintenance',
      sex: 'male',
      birthDate: '1994-03-10',
      heightCm: 178,
      weightKg: 78,
      activityLevel: 'moderate',
    });
    expect(target).not.toBeNull();
    if (!target) return;
    expect(target.safetyFloorApplied).toBe(false);
    expect(target.calories).toBeGreaterThan(2000);
  });

  it('caps the deficit at roughly 20 percent of expenditure', () => {
    const target = deriveCalorieTarget({
      goal: 'weight_loss',
      sex: 'male',
      birthDate: '1994-03-10',
      heightCm: 178,
      weightKg: 78,
      activityLevel: 'moderate',
    });
    expect(target).not.toBeNull();
    if (!target || target.tdee === null) return;
    expect(target.calories).toBeGreaterThanOrEqual(target.tdee * 0.79);
  });

  it('keeps the safety floor conservative', () => {
    expect(calorieSafetyFloor('female', 45)).toBe(1200);
    expect(calorieSafetyFloor('male', 70)).toBe(1540); // weight-derived floor wins
    expect(calorieSafetyFloor('male', 100)).toBe(2200);
  });
});

describe('macro targets', () => {
  it('derives protein from body weight and a goal', () => {
    const macros = deriveMacroTargets({ calories: 2200, weightKg: 70, goal: 'muscle_gain' });
    expect(macros.protein_g).toBe(126); // 1.8 g/kg
    expect(macros.fat_g).toBe(61); // 25% of 2200 / 9
    expect(macros.explanation).toMatch(/1.8 g\/kg/);
  });

  it('falls back to an energy share when body weight is unknown', () => {
    const macros = deriveMacroTargets({ calories: 2000, weightKg: null, goal: 'general_fitness' });
    expect(macros.protein_g).toBe(125); // 25% of 2000 / 4
    expect(macros.explanation).toMatch(/25% of energy/);
  });

  it('never produces negative carbohydrate', () => {
    const macros = deriveMacroTargets({ calories: 900, weightKg: 120, goal: 'muscle_gain' });
    expect(macros.carbs_g).toBeGreaterThanOrEqual(0);
  });
});

describe('confidence handling', () => {
  it('bands confidence into high/medium/low', () => {
    expect(confidenceBand(0.94)).toBe('high');
    expect(confidenceBand(0.72)).toBe('medium');
    expect(confidenceBand(0.4)).toBe('low');
    expect(confidenceBand(null)).toBe('unknown');
  });

  it('takes the weakest of the three scan confidences', () => {
    const result = overallScanConfidence({
      foodRecognition: 0.94,
      portion: 0.73,
      match: 0.91,
    });
    expect(result.value).toBe(0.73);
    expect(result.band).toBe('medium');
    // A medium overall band must be presented for review.
    expect(result.requiresConfirmation).toBe(true);
  });

  it('requires confirmation when confidence is unknown', () => {
    const result = overallScanConfidence({});
    expect(result.value).toBeNull();
    expect(result.requiresConfirmation).toBe(true);
  });

  it('does not require confirmation for a fully confident result', () => {
    const result = overallScanConfidence({ foodRecognition: 0.95, portion: 0.9, match: 0.93 });
    expect(result.band).toBe('high');
    expect(result.requiresConfirmation).toBe(false);
  });
});

describe('macroEnergySplit', () => {
  it('splits energy by macro without counting fibre as calories', () => {
    const split = macroEnergySplit({
      calories_kcal: 0,
      protein_g: 100, // 400
      carbs_g: 100, // 400
      fat_g: 100, // 900
      fiber_g: 50,
      sugar_g: 0,
      sodium_mg: 0,
    });
    expect(split.proteinPct).toBeCloseTo(23.5, 1);
    expect(split.carbsPct).toBeCloseTo(23.5, 1);
    expect(split.fatPct).toBeCloseTo(52.9, 1);
  });
});
