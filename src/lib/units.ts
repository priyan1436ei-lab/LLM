/**
 * Unit and serving-size engine (spec §6, §7, §13).
 *
 * Core invariant: every quantity the user enters is resolved to GRAMS before any
 * nutrient maths happens. Nutriment reference values are stored per 100 g, so scaling
 * is a single multiplication and never depends on how the user phrased the portion.
 *
 * Deliberate constraint: a household unit ("katori", "bowl", "cup") can only be
 * converted when the food itself declares a serving for that unit. There is no global
 * "1 cup = 240 ml" table, because a cup of rice and a cup of sambar weigh different
 * amounts. When no serving matches, conversion FAILS LOUDLY rather than guessing —
 * that failure is what stops invented nutrition reaching the user (spec §68).
 */

/** Canonical storage units. Everything is persisted in one of these. */
export const MASS_UNITS = ['g', 'kg', 'mg'] as const;
export const VOLUME_UNITS = ['ml', 'l'] as const;
export const COUNT_UNITS = [
  'piece',
  'slice',
  'cup',
  'bowl',
  'plate',
  'katori',
  'tablespoon',
  'teaspoon',
  'ladle',
  'serving',
  'scoop',
  'glass',
  'handful',
  'packet',
] as const;

export type MassUnit = (typeof MASS_UNITS)[number];
export type VolumeUnit = (typeof VOLUME_UNITS)[number];
export type CountUnit = (typeof COUNT_UNITS)[number];
export type Unit = MassUnit | VolumeUnit | CountUnit | string;

export type UnitKind = 'mass' | 'volume' | 'count';

const MASS_SET = new Set<string>(MASS_UNITS);
const VOLUME_SET = new Set<string>(VOLUME_UNITS);
const COUNT_SET = new Set<string>(COUNT_UNITS);

/** Exact ratios to the canonical mass unit (grams). */
const MASS_TO_GRAMS: Record<string, number> = {
  mg: 0.001,
  g: 1,
  kg: 1000,
};

/** Exact ratios to the canonical volume unit (millilitres). */
const VOLUME_TO_ML: Record<string, number> = {
  ml: 1,
  l: 1000,
};

/**
 * Spelling variants we accept from user input, AI output and OCR text, mapped onto the
 * canonical tokens above. OCR in particular produces plural and abbreviation variants.
 */
const UNIT_ALIASES: Record<string, string> = {
  gram: 'g',
  grams: 'g',
  gm: 'g',
  gms: 'g',
  gr: 'g',
  kilogram: 'kg',
  kilograms: 'kg',
  kgs: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  milligram: 'mg',
  milligrams: 'mg',
  ml_: 'ml',
  milliliter: 'ml',
  millilitre: 'ml',
  milliliters: 'ml',
  millilitres: 'ml',
  mls: 'ml',
  cc: 'ml',
  liter: 'l',
  litre: 'l',
  liters: 'l',
  litres: 'l',
  ltr: 'l',
  tbsp: 'tablespoon',
  tbsps: 'tablespoon',
  tablespoon: 'tablespoon',
  tablespoons: 'tablespoon',
  tblsp: 'tablespoon',
  tsp: 'teaspoon',
  tsps: 'teaspoon',
  teaspoon: 'teaspoon',
  teaspoons: 'teaspoon',
  pc: 'piece',
  pcs: 'piece',
  pieces: 'piece',
  no: 'piece',
  nos: 'piece',
  unit: 'piece',
  units: 'piece',
  slices: 'slice',
  cups: 'cup',
  bowls: 'bowl',
  plates: 'plate',
  katoris: 'katori',
  katoori: 'katori',
  bowl_: 'bowl',
  ladles: 'ladle',
  servings: 'serving',
  serve: 'serving',
  scoops: 'scoop',
  glasses: 'glass',
  glass_: 'glass',
  handfuls: 'handful',
  packet: 'packet',
  packets: 'packet',
  pkt: 'packet',
  // Indian household measures that appear in real logs and AI output.
  dabba: 'katori',
  vati: 'katori',
  tumbler: 'glass',
  chammach: 'teaspoon',
  chamach: 'teaspoon',
};

/** Normalise a raw unit string to its canonical token. Returns null if unknown. */
export function normalizeUnit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/^a /, '');
  if (cleaned === '') return null;
  if (MASS_SET.has(cleaned) || VOLUME_SET.has(cleaned) || COUNT_SET.has(cleaned)) return cleaned;
  const alias = UNIT_ALIASES[cleaned];
  if (alias) return alias;
  // Strip a trailing plural "s" as a last resort ("scoops" -> "scoop").
  if (cleaned.length > 3 && cleaned.endsWith('s')) {
    const singular = cleaned.slice(0, -1);
    if (MASS_SET.has(singular) || VOLUME_SET.has(singular) || COUNT_SET.has(singular)) {
      return singular;
    }
    const alias2 = UNIT_ALIASES[singular];
    if (alias2) return alias2;
  }
  return null;
}

export function unitKind(unit: string): UnitKind | null {
  if (MASS_SET.has(unit)) return 'mass';
  if (VOLUME_SET.has(unit)) return 'volume';
  if (COUNT_SET.has(unit)) return 'count';
  return null;
}

/** A serving definition as loaded from `food_servings`. */
export interface ServingDefinition {
  readonly id: string;
  readonly label: string;
  readonly unit: string;
  readonly amount: number;
  readonly grams: number;
  readonly is_approximate: boolean;
}

export type ConversionFailureReason =
  'unknown_unit' | 'no_serving_for_unit' | 'invalid_serving_definition' | 'non_positive_quantity';

export interface ConversionSuccess {
  readonly ok: true;
  readonly grams: number;
  /** True when the conversion relied on a household measure rather than a mass unit. */
  readonly isApproximate: boolean;
  /** How the conversion was performed, so the UI can explain it (spec §70). */
  readonly method: 'mass' | 'serving';
  readonly explanation: string;
}

export interface ConversionFailure {
  readonly ok: false;
  readonly reason: ConversionFailureReason;
  readonly message: string;
}

export type ConversionResult = ConversionSuccess | ConversionFailure;

/**
 * Resolve a user-supplied (quantity, unit) for a specific food into grams.
 *
 * Order of resolution:
 *  1. A mass unit converts exactly (g/kg/mg).
 *  2. Otherwise a serving row whose unit matches supplies the gram weight.
 *  3. Otherwise conversion fails — no density guessing, no default cup.
 *
 * Volume units are NOT converted to grams here. Converting ml to grams requires a
 * density, which we only have if the food declares a serving in that unit; treating
 * 1 ml as 1 g would be an invented number for anything that is not water.
 */
export function convertToGrams(params: {
  readonly quantity: number;
  readonly unit: string;
  readonly servings: readonly ServingDefinition[];
}): ConversionResult {
  const { quantity, servings } = params;

  if (!Number.isFinite(quantity) || quantity <= 0) {
    return {
      ok: false,
      reason: 'non_positive_quantity',
      message: 'Quantity must be a positive number.',
    };
  }

  const unit = normalizeUnit(params.unit);
  if (!unit) {
    return {
      ok: false,
      reason: 'unknown_unit',
      message: `Unrecognised unit "${params.unit}". Choose a supported unit or enter grams.`,
    };
  }

  const kind = unitKind(unit);
  if (kind === 'mass') {
    const factor = MASS_TO_GRAMS[unit];
    if (factor === undefined) {
      return { ok: false, reason: 'unknown_unit', message: `Unsupported mass unit "${unit}".` };
    }
    const grams = round(quantity * factor, 3);
    return {
      ok: true,
      grams,
      isApproximate: false,
      method: 'mass',
      explanation: `${quantity} ${unit} = ${grams} g (exact mass conversion).`,
    };
  }

  // Serving-based conversion: find a serving declared in this exact unit.
  const candidates = servings.filter((s) => normalizeUnit(s.unit) === unit);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'no_serving_for_unit',
      message:
        `No serving size is defined for "${unit}" on this food, so it cannot be ` +
        `converted to grams. Enter the amount in grams, or pick a defined serving.`,
    };
  }

  // Prefer a non-approximate serving when several are declared for the same unit.
  const serving = candidates.find((s) => !s.is_approximate) ?? candidates[0]!;
  if (
    !Number.isFinite(serving.grams) ||
    !Number.isFinite(serving.amount) ||
    serving.grams <= 0 ||
    serving.amount <= 0
  ) {
    return {
      ok: false,
      reason: 'invalid_serving_definition',
      message: `The serving "${serving.label}" has an invalid definition and cannot be used.`,
    };
  }

  const gramsPerUnit = serving.grams / serving.amount;
  const grams = round(quantity * gramsPerUnit, 3);
  const isApproximate = serving.is_approximate || kind === 'volume';

  return {
    ok: true,
    grams,
    isApproximate,
    method: 'serving',
    explanation:
      `${quantity} × ${serving.label} (${round(serving.grams, 1)} g) = ${grams} g` +
      (isApproximate ? ' — approximate household measure.' : '.'),
  };
}

/**
 * Reverse lookup: express grams in a food's most natural unit, for display.
 * Falls back to grams when no serving fits.
 */
export function gramsToBestDisplay(
  grams: number,
  servings: readonly ServingDefinition[],
): { quantity: number; unit: string; isApproximate: boolean } {
  const preferred =
    servings.find((s) => s.unit === 'katori') ?? servings.find((s) => s.unit === 'piece');
  if (preferred && preferred.grams > 0) {
    return {
      quantity: round(grams / preferred.grams, 2),
      unit: preferred.unit,
      isApproximate: true,
    };
  }
  return { quantity: round(grams, 1), unit: 'g', isApproximate: false };
}

/** Round to a fixed number of decimals without floating-point drift. */
export function round(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Approximate gram equivalents for household measures.
 *
 * IMPORTANT — this table is ONLY for items where the user has supplied their own nutrient
 * values (the `user_entered` path). In that case the gram figure is descriptive metadata
 * for the logged item, and it is never used to derive nutrition.
 *
 * It must NOT be used on the `database_record` path. There, converting "1 cup" to grams
 * without the specific food declaring its own serving weight would inject an assumed
 * density into real nutrient arithmetic — the exact class of invented number the spec
 * forbids (§68). That path fails instead. See `convertToGrams`.
 */
const APPROXIMATE_HOUSEHOLD_GRAMS: Record<string, number> = {
  teaspoon: 5,
  tablespoon: 15,
  ladle: 60,
  katori: 150,
  cup: 200,
  bowl: 250,
  plate: 350,
  glass: 250,
  scoop: 30,
  handful: 30,
  slice: 30,
  packet: 100,
  piece: 100,
  serving: 100,
};

/**
 * Best-effort gram figure for a household measure, for the manual-entry path only.
 * Returns null when the unit is unknown, so the caller can ask the user for a weight
 * rather than storing a made-up number.
 */
export function approximateHouseholdGrams(quantity: number, unit: string): number | null {
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const normalized = normalizeUnit(unit);
  if (!normalized) return null;

  const kind = unitKind(normalized);
  if (kind === 'mass') {
    const factor = MASS_TO_GRAMS[normalized];
    return factor === undefined ? null : round(quantity * factor, 3);
  }
  if (kind === 'volume') {
    // A volume measure with no food-specific density. Documented as approximate.
    const ml = quantity * (VOLUME_TO_ML[normalized] ?? 0);
    return ml > 0 ? round(ml, 3) : null;
  }

  const perUnit = APPROXIMATE_HOUSEHOLD_GRAMS[normalized];
  if (perUnit === undefined) return null;
  return round(quantity * perUnit, 3);
}

/** Human-readable unit label for display, e.g. "1 katori" vs "250 g". */
export function formatQuantity(quantity: number, unit: string): string {
  const q = round(quantity, quantity < 10 ? 2 : 1);
  const unitLabel = q === 1 ? unit : pluralizeUnit(unit);
  return `${q} ${unitLabel}`;
}

function pluralizeUnit(unit: string): string {
  if (unit === 'g' || unit === 'kg' || unit === 'ml' || unit === 'l' || unit === 'mg') return unit;
  if (unit.endsWith('s')) return unit;
  return `${unit}s`;
}
