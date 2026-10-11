/**
 * Unit / serving-size engine tests (spec §6, §7, §13).
 *
 * These assert both the arithmetic AND the refusal behaviour: converting a unit the food
 * does not define must fail rather than produce a guessed weight, because a guessed
 * weight becomes invented nutrition downstream (spec §68).
 */
import { describe, expect, it } from 'vitest';

import {
  convertToGrams,
  formatQuantity,
  gramsToBestDisplay,
  normalizeUnit,
  round,
  unitKind,
  type ServingDefinition,
} from '@/lib/units';

function serving(over: Partial<ServingDefinition> = {}): ServingDefinition {
  return {
    id: 's1',
    label: '1 katori',
    unit: 'katori',
    amount: 1,
    grams: 150,
    is_approximate: true,
    ...over,
  };
}

describe('normalizeUnit', () => {
  it('canonicalises mass units and their spellings', () => {
    expect(normalizeUnit('g')).toBe('g');
    expect(normalizeUnit('Gram')).toBe('g');
    expect(normalizeUnit(' gms ')).toBe('g');
    expect(normalizeUnit('KG')).toBe('kg');
    expect(normalizeUnit('kilograms')).toBe('kg');
    expect(normalizeUnit('mg')).toBe('mg');
  });

  it('canonicalises volume units and abbreviations', () => {
    expect(normalizeUnit('ml')).toBe('ml');
    expect(normalizeUnit('mls')).toBe('ml');
    expect(normalizeUnit('Litre')).toBe('l');
    expect(normalizeUnit('cc')).toBe('ml');
  });

  it('maps household measures, including Indian ones', () => {
    expect(normalizeUnit('katoris')).toBe('katori');
    expect(normalizeUnit('dabba')).toBe('katori');
    expect(normalizeUnit('vati')).toBe('katori');
    expect(normalizeUnit('tbsp')).toBe('tablespoon');
    expect(normalizeUnit('chammach')).toBe('teaspoon');
    expect(normalizeUnit('tumbler')).toBe('glass');
    expect(normalizeUnit('pieces')).toBe('piece');
    expect(normalizeUnit('slices')).toBe('slice');
  });

  it('returns null for units it genuinely does not know', () => {
    expect(normalizeUnit('furlong')).toBeNull();
    expect(normalizeUnit('')).toBeNull();
    expect(normalizeUnit(null)).toBeNull();
    expect(normalizeUnit('   ')).toBeNull();
  });
});

describe('unitKind', () => {
  it('classifies units', () => {
    expect(unitKind('g')).toBe('mass');
    expect(unitKind('ml')).toBe('volume');
    expect(unitKind('katori')).toBe('count');
    expect(unitKind('nonsense')).toBeNull();
  });
});

describe('convertToGrams — exact mass conversions', () => {
  it('converts grams unchanged', () => {
    const r = convertToGrams({ quantity: 185, unit: 'g', servings: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.grams).toBe(185);
    expect(r.method).toBe('mass');
    expect(r.isApproximate).toBe(false);
  });

  it('converts kg and mg exactly', () => {
    const kg = convertToGrams({ quantity: 1.5, unit: 'kg', servings: [] });
    expect(kg.ok && kg.grams).toBe(1500);

    const mg = convertToGrams({ quantity: 500, unit: 'mg', servings: [] });
    expect(mg.ok && mg.grams).toBe(0.5);
  });

  it('accepts unit spellings from OCR and AI output', () => {
    const r = convertToGrams({ quantity: 200, unit: 'Grams', servings: [] });
    expect(r.ok && r.grams).toBe(200);
  });
});

describe('convertToGrams — serving-based conversions', () => {
  it('uses the food-declared serving weight, not a global assumption', () => {
    // 1 katori of this food is declared as 150 g.
    const r = convertToGrams({ quantity: 1.5, unit: 'katori', servings: [serving()] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.grams).toBe(225);
    expect(r.method).toBe('serving');
    expect(r.isApproximate).toBe(true);
  });

  it('handles a serving whose amount is greater than one', () => {
    // "2 pieces = 60 g" -> one piece is 30 g, so 3 pieces is 90 g.
    const r = convertToGrams({
      quantity: 3,
      unit: 'piece',
      servings: [serving({ id: 's2', label: '2 pieces', unit: 'piece', amount: 2, grams: 60 })],
    });
    expect(r.ok && r.grams).toBe(90);
  });

  it('resolves an idli-style piece count against its own declared weight', () => {
    const idli = serving({ id: 's3', label: '1 idli', unit: 'piece', amount: 1, grams: 45 });
    const r = convertToGrams({ quantity: 2, unit: 'pieces', servings: [idli] });
    expect(r.ok && r.grams).toBe(90);
  });

  it('prefers the non-approximate serving when two define the same unit', () => {
    const r = convertToGrams({
      quantity: 1,
      unit: 'cup',
      servings: [
        serving({
          id: 'approx',
          label: '1 cup (approx)',
          unit: 'cup',
          grams: 200,
          is_approximate: true,
        }),
        serving({ id: 'exact', label: '1 cup', unit: 'cup', grams: 240, is_approximate: false }),
      ],
    });
    expect(r.ok && r.grams).toBe(240);
    expect(r.ok && r.isApproximate).toBe(false);
  });
});

describe('convertToGrams — refusals (the anti-hallucination guarantee)', () => {
  it('FAILS when the food declares no serving for the requested unit', () => {
    const r = convertToGrams({ quantity: 2, unit: 'katori', servings: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no_serving_for_unit');
    expect(r.message).toMatch(/cannot be converted to grams/i);
  });

  it('does NOT treat millilitres as grams', () => {
    // Converting ml -> g needs a density we do not have; 1 ml = 1 g would be invented.
    const r = convertToGrams({ quantity: 250, unit: 'ml', servings: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no_serving_for_unit');
  });

  it('converts millilitres only when the food itself declares a volume serving', () => {
    const r = convertToGrams({
      quantity: 250,
      unit: 'ml',
      servings: [
        serving({ label: '1 glass', unit: 'ml', amount: 250, grams: 250, is_approximate: false }),
      ],
    });
    expect(r.ok && r.grams).toBe(250);
  });

  it('rejects unknown units', () => {
    const r = convertToGrams({ quantity: 1, unit: 'furlong', servings: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_unit');
  });

  it('rejects non-positive and non-finite quantities', () => {
    for (const q of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = convertToGrams({ quantity: q, unit: 'g', servings: [] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('non_positive_quantity');
    }
  });

  it('rejects a serving row with an invalid definition', () => {
    const r = convertToGrams({
      quantity: 1,
      unit: 'katori',
      servings: [serving({ grams: 0 })],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_serving_definition');
  });
});

describe('gramsToBestDisplay', () => {
  it('prefers katori, then piece, else grams', () => {
    expect(gramsToBestDisplay(300, [serving()]).unit).toBe('katori');
    expect(gramsToBestDisplay(300, []).unit).toBe('g');
    expect(gramsToBestDisplay(90, [serving({ unit: 'piece', grams: 45 })]).quantity).toBe(2);
  });
});

describe('formatQuantity', () => {
  it('pluralises household units but leaves mass units alone', () => {
    expect(formatQuantity(1, 'katori')).toBe('1 katori');
    expect(formatQuantity(2, 'katori')).toBe('2 katoris');
    expect(formatQuantity(250, 'g')).toBe('250 g');
    expect(formatQuantity(1.5, 'kg')).toBe('1.5 kg');
  });
});

describe('round', () => {
  it('rounds without floating-point drift', () => {
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(0.1 + 0.2, 2)).toBe(0.3);
    expect(round(120.4567, 1)).toBe(120.5);
    expect(round(Number.NaN, 2)).toBe(0);
  });
});
