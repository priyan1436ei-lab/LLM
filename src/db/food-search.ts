/**
 * Food matching engine (spec §11, §12, §20, §85, §9).
 *
 * Turns a free-text label — from a vision model, a voice transcript, or the user's typing —
 * into a specific stored food row, so its nutrition comes from the database rather than from
 * the model.
 *
 * Lookup order, cheapest and most certain first:
 *   1. Exact alias match (the normalization layer: "dahi" / "thayir" / "curd" all resolve).
 *   2. Exact canonical-name match.
 *   3. Prefix match on canonical name or alias.
 *   4. Trigram similarity, using the pg_trgm GIN indexes.
 *
 * When nothing clears the confidence floor the result is `no_match`, and the caller must
 * offer alternatives or manual entry. It never returns a low-quality guess as if it were
 * certain — a wrong food silently logged is worse than asking the user.
 */

import type { TransactionClient } from './client';
import { round, type ServingDefinition } from '@/lib/units';

export interface FoodMatch {
  readonly foodId: string;
  readonly canonicalName: string;
  readonly categorySlug: string | null;
  readonly region: string | null;
  /** 1.0 for an exact alias hit, lower for fuzzy matches. */
  readonly confidence: number;
  readonly matchedOn: string;
  readonly matchKind: 'alias' | 'canonical' | 'prefix' | 'trigram';
  /** The food's own default serving, in the canonical shape the unit engine expects. */
  readonly defaultServing: ServingDefinition | null;
}

export interface FoodSearchResult {
  readonly query: string;
  readonly best: FoodMatch | null;
  readonly alternatives: readonly FoodMatch[];
  /** True when the caller should ask the user to confirm rather than auto-accept. */
  readonly requiresConfirmation: boolean;
}

/** Below this similarity a trigram hit is reported but not trusted as the answer. */
const TRIGRAM_FLOOR = 0.3;
/** Above this similarity the match is treated as confident enough to preselect. */
const AUTO_ACCEPT = 0.62;

interface MatchRow {
  food_id: string;
  canonical_name: string;
  category_slug: string | null;
  region: string | null;
  matched_on: string;
  match_kind: string;
  similarity: number | string;
  serving_id: string | null;
  serving_label: string | null;
  serving_unit: string | null;
  serving_amount: string | number | null;
  serving_grams: string | number | null;
  serving_approximate: boolean | null;
}

function toMatch(row: MatchRow, confidenceOverride?: number): FoodMatch {
  const confidence =
    confidenceOverride ??
    (row.match_kind === 'alias' || row.match_kind === 'canonical'
      ? 1
      : row.match_kind === 'prefix'
        ? 0.9
        : round(Number(row.similarity ?? 0), 4));

  return {
    foodId: row.food_id,
    canonicalName: row.canonical_name,
    categorySlug: row.category_slug,
    region: row.region,
    confidence,
    matchedOn: row.matched_on,
    matchKind: row.match_kind as FoodMatch['matchKind'],
    defaultServing:
      row.serving_id && row.serving_label && row.serving_unit
        ? {
            id: row.serving_id,
            label: row.serving_label,
            unit: row.serving_unit,
            amount: Number(row.serving_amount ?? 1),
            grams: Number(row.serving_grams ?? 0),
            is_approximate: Boolean(row.serving_approximate),
          }
        : null,
  };
}

const MATCH_SELECT = `
  SELECT
    f.id            AS food_id,
    f.canonical_name,
    c.slug          AS category_slug,
    f.region,
    f.canonical_name AS matched_on,
    $2::text        AS match_kind,
    $3::real        AS similarity,
    s.id            AS serving_id,
    s.label         AS serving_label,
    s.unit          AS serving_unit,
    s.amount        AS serving_amount,
    s.grams         AS serving_grams,
    s.is_approximate AS serving_approximate
  FROM foods f
  LEFT JOIN food_categories c ON c.id = f.category_id
  LEFT JOIN food_servings s ON s.food_id = f.id AND s.is_default
`;

/**
 * Find the best stored food for a label, plus alternatives for the user to choose from.
 */
export async function matchFood(
  tx: TransactionClient,
  query: string,
  limit = 5,
): Promise<FoodSearchResult> {
  const normalised = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalised === '') {
    return { query, best: null, alternatives: [], requiresConfirmation: true };
  }

  const candidates: FoodMatch[] = [];
  const seen = new Set<string>();

  const add = (match: FoodMatch): void => {
    if (seen.has(match.foodId)) return;
    seen.add(match.foodId);
    candidates.push(match);
  };

  // 1. Exact alias (includes the canonical name, which is seeded as an alias too).
  const aliasRows = await tx.query<MatchRow>(
    `SELECT f.id AS food_id, f.canonical_name, c.slug AS category_slug, f.region,
            a.alias AS matched_on, 'alias'::text AS match_kind, 1.0::real AS similarity,
            s.id AS serving_id, s.label AS serving_label, s.unit AS serving_unit,
            s.amount AS serving_amount, s.grams AS serving_grams, s.is_approximate AS serving_approximate
       FROM food_aliases a
       JOIN foods f ON f.id = a.food_id
       LEFT JOIN food_categories c ON c.id = f.category_id
       LEFT JOIN food_servings s ON s.food_id = f.id AND s.is_default
      WHERE lower(a.alias) = $1
      -- Higher match_weight means a more specific synonym; prefer it.
      ORDER BY a.match_weight DESC, f.is_verified DESC
      LIMIT $2`,
    [normalised, limit],
  );
  for (const row of aliasRows) add(toMatch(row));

  // 2. Exact canonical name on its own (in case an alias row is missing).
  if (candidates.length === 0) {
    const canonicalRows = await tx.query<MatchRow>(
      `${MATCH_SELECT} WHERE lower(f.canonical_name) = $1 ORDER BY f.is_verified DESC LIMIT $4`,
      [normalised, 'canonical', 1, limit],
    );
    for (const row of canonicalRows) add(toMatch(row));
  }

  // 3. Prefix match, for instant search as the user types.
  if (candidates.length < limit) {
    const prefixRows = await tx.query<MatchRow>(
      `SELECT f.id AS food_id, f.canonical_name, c.slug AS category_slug, f.region,
              f.canonical_name AS matched_on, 'prefix'::text AS match_kind, 0.9::real AS similarity,
              s.id AS serving_id, s.label AS serving_label, s.unit AS serving_unit,
              s.amount AS serving_amount, s.grams AS serving_grams, s.is_approximate AS serving_approximate
         FROM foods f
         LEFT JOIN food_categories c ON c.id = f.category_id
         LEFT JOIN food_servings s ON s.food_id = f.id AND s.is_default
        WHERE lower(f.canonical_name) LIKE $1
           OR EXISTS (SELECT 1 FROM food_aliases a WHERE a.food_id = f.id AND lower(a.alias) LIKE $1)
        ORDER BY length(f.canonical_name), f.canonical_name
        LIMIT $2`,
      [`${normalised}%`, limit],
    );
    for (const row of prefixRows) add(toMatch(row));
  }

  // 4. Trigram similarity, driven by the GIN indexes. This is what makes a typo work.
  if (candidates.length < limit) {
    const trigramRows = await tx.query<MatchRow>(
      `SELECT f.id AS food_id, f.canonical_name, c.slug AS category_slug, f.region,
              f.canonical_name AS matched_on, 'trigram'::text AS match_kind,
              similarity(lower(f.canonical_name), $1) AS similarity,
              s.id AS serving_id, s.label AS serving_label, s.unit AS serving_unit,
              s.amount AS serving_amount, s.grams AS serving_grams, s.is_approximate AS serving_approximate
         FROM foods f
         LEFT JOIN food_categories c ON c.id = f.category_id
         LEFT JOIN food_servings s ON s.food_id = f.id AND s.is_default
        WHERE lower(f.canonical_name) % $1
           OR EXISTS (SELECT 1 FROM food_aliases a WHERE a.food_id = f.id AND lower(a.alias) % $1)
        ORDER BY similarity(lower(f.canonical_name), $1) DESC, f.canonical_name
        LIMIT $2`,
      [normalised, limit],
    );
    for (const row of trigramRows) {
      const match = toMatch(row);
      if (match.confidence >= TRIGRAM_FLOOR) add(match);
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);

  const best = candidates[0] ?? null;
  return {
    query,
    best,
    alternatives: candidates.slice(1, limit),
    // Only a confident, exact hit is accepted without asking the user.
    requiresConfirmation: best === null || best.confidence < AUTO_ACCEPT,
  };
}

/**
 * Resolve a list of AI-detected labels to stored foods.
 * Each entry reports its own match quality so the review screen can show exactly which
 * items need attention (spec §8, §9, §70).
 */
export async function matchDetectedFoods(
  tx: TransactionClient,
  labels: readonly { label: string; alternatives?: readonly string[] }[],
  limit = 4,
): Promise<
  {
    label: string;
    match: FoodSearchResult;
  }[]
> {
  const results: {
    label: string;
    match: FoodSearchResult;
  }[] = [];

  for (const item of labels) {
    let match = await matchFood(tx, item.label, limit);

    // If the primary label did not resolve, try the model's alternative names before
    // giving up — this is exactly what the alternatives list is for.
    if (match.best === null && item.alternatives && item.alternatives.length > 0) {
      for (const alternative of item.alternatives) {
        const retry = await matchFood(tx, alternative, limit);
        if (retry.best) {
          match = {
            ...retry,
            // A match found via an alternative is inherently less certain.
            best: { ...retry.best, confidence: round(retry.best.confidence * 0.85, 4) },
            requiresConfirmation: true,
          };
          break;
        }
      }
    }

    results.push({ label: item.label, match });
  }

  return results;
}

/** Popular foods, for the empty state of the food picker. */
export async function recentAndFrequentFoods(
  tx: TransactionClient,
  userId: string,
  limit = 8,
): Promise<
  {
    foodId: string;
    canonicalName: string;
    timesLogged: number;
    lastLogged: string | null;
  }[]
> {
  const rows = await tx.query<{
    food_id: string;
    canonical_name: string;
    times_logged: number;
    last_logged: string | null;
  }>(
    `SELECT mi.food_id, f.canonical_name,
            count(*)::int AS times_logged,
            max(m.meal_date)::text AS last_logged
       FROM meal_items mi
       JOIN meals m ON m.id = mi.meal_id
       JOIN foods f ON f.id = mi.food_id
      WHERE m.user_id = $1 AND mi.food_id IS NOT NULL
      GROUP BY mi.food_id, f.canonical_name
      ORDER BY times_logged DESC, last_logged DESC
      LIMIT $2`,
    [userId, limit],
  );

  return rows.map((r) => ({
    foodId: r.food_id,
    canonicalName: r.canonical_name,
    timesLogged: Number(r.times_logged),
    lastLogged: r.last_logged,
  }));
}
