-- =====================================================================================
-- FITTRACK AI — Migration 001: foundation, identity, nutrition reference, meals, scans
-- Target engine: PostgreSQL 18 (PGlite 0.5.8 WASM locally, any Postgres in production)
--
-- Notes on engine portability, established by direct probes of this engine version:
--   * gen_random_uuid()  -> built in (pgcrypto/uuid-ossp are NOT available here)
--   * lower() expression indexes are used instead of citext (NOT available here)
--   * pg_trgm is registered at connection time by the client and enabled below
--   * vector/pgvector is NOT available -> no embedding columns are defined anywhere
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Extensions (spec §85 — trigram search for food lookup)
-- -------------------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- -------------------------------------------------------------------------------------
-- Application roles (spec §74, §75)
--
-- `app_user`    : the role every user-scoped request runs as. All RLS is enforced here.
-- `app_admin`   : the role admin paths run as. Admin reads go through SECURITY DEFINER
--                 functions so privilege escalation is explicit and auditable.
-- Neither role is a superuser; both are NOLOGIN because the app switches into them.
-- -------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    CREATE ROLE app_admin NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user, app_admin;

-- Future tables/sequences created by migrations are automatically usable by the app
-- role. RLS policies are applied separately (and automatically) by app_apply_rls().
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO app_admin;

-- -------------------------------------------------------------------------------------
-- Context helper (spec §75)
--
-- Reads the per-transaction user id that the data-access layer sets with
-- `SET LOCAL app.current_user_id = $uuid`. Returns NULL when unset or blank, so a
-- policy that does not match anything fails CLOSED (no rows) rather than opening up.
-- Verified: a missing context yields zero visible rows, never the whole table.
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid $$;

COMMENT ON FUNCTION app_current_user_id() IS
  'Per-transaction acting user id for row-level security. NULL (fail-closed) when unset.';

-- =====================================================================================
-- ENUMERATED DOMAINS
-- =====================================================================================
CREATE TYPE user_role          AS ENUM ('user', 'pro_user', 'nutrition_editor', 'admin', 'super_admin');
CREATE TYPE meal_type          AS ENUM ('breakfast', 'lunch', 'snack', 'dinner', 'pre_workout', 'post_workout');
CREATE TYPE meal_source        AS ENUM ('manual', 'search', 'photo_scan', 'barcode', 'label_ocr', 'voice', 'text_ai', 'plan', 'recipe', 'import');
CREATE TYPE diet_pattern       AS ENUM ('omnivore', 'vegetarian', 'eggetarian', 'vegan', 'pescatarian', 'jain', 'keto', 'low_carb', 'high_protein');
CREATE TYPE goal_type          AS ENUM ('weight_loss', 'weight_maintenance', 'weight_gain', 'muscle_gain', 'general_fitness', 'medical_management');
CREATE TYPE sex_at_birth       AS ENUM ('male', 'female', 'other', 'undisclosed');
CREATE TYPE activity_level     AS ENUM ('sedentary', 'light', 'moderate', 'active', 'very_active');

-- Trust/provenance of a number shown to the user (spec §69, §70).
CREATE TYPE nutrition_source   AS ENUM ('database_record', 'user_entered', 'package_label', 'ai_estimate', 'recipe_calculated', 'imported');

-- Lifecycle of an asynchronous job (spec §53, §54).
CREATE TYPE job_status         AS ENUM ('queued', 'processing', 'completed', 'failed', 'cancelled');

-- Confidence banding for AI output (spec §8).
CREATE TYPE confidence_band    AS ENUM ('high', 'medium', 'low');

CREATE TYPE scan_status        AS ENUM ('queued', 'uploading', 'analyzing', 'calculating', 'ready', 'failed', 'cancelled');

-- =====================================================================================
-- IDENTITY (spec §2, §76)
-- =====================================================================================

CREATE TABLE profiles (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text        NOT NULL,
  email_verified_at  timestamptz,
  password_hash      text        NOT NULL,
  display_name       text,
  role               user_role   NOT NULL DEFAULT 'user',
  -- Onboarding is persisted, so a returning user resumes where they left off (spec §136).
  onboarding_step    text,
  onboarding_done_at timestamptz,
  timezone           text        NOT NULL DEFAULT 'Asia/Kolkata',
  locale             text        NOT NULL DEFAULT 'en-IN',
  account_status     text        NOT NULL DEFAULT 'active'
                     CHECK (account_status IN ('active', 'suspended', 'pending_deletion', 'deleted')),
  anonymous_id       uuid,       -- survives account deletion so audit history stays coherent
  last_seen_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CONSTRAINT profiles_email_shape CHECK (position('@' in email) > 1)
);

-- Case-insensitive uniqueness without citext (unavailable on this engine).
CREATE UNIQUE INDEX profiles_email_lower_key ON profiles (lower(email));
CREATE INDEX profiles_role_idx ON profiles (role);
CREATE INDEX profiles_created_at_idx ON profiles (created_at DESC);

-- Body metrics used by BMR/TDEE maths. Kept apart from mutable self-reported vitals.
CREATE TABLE user_body_stats (
  user_id          uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  sex              sex_at_birth,
  birth_date       date,
  height_cm        numeric(5,1) CHECK (height_cm IS NULL OR (height_cm > 50 AND height_cm < 260)),
  activity_level   activity_level NOT NULL DEFAULT 'moderate',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_preferences (
  user_id                 uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  diet_pattern            diet_pattern NOT NULL DEFAULT 'omnivore',
  allergies               text[] NOT NULL DEFAULT '{}',
  disliked_foods          text[] NOT NULL DEFAULT '{}',
  preferred_cuisines      text[] NOT NULL DEFAULT '{}',
  -- Metric vs imperial is presentation only; storage is always canonical SI units.
  unit_system             text NOT NULL DEFAULT 'metric' CHECK (unit_system IN ('metric', 'imperial')),
  week_starts_on          smallint NOT NULL DEFAULT 1 CHECK (week_starts_on BETWEEN 0 AND 6),
  reminders_enabled       boolean NOT NULL DEFAULT false,
  reminder_settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  analytics_opt_out       boolean NOT NULL DEFAULT false,
  ai_data_sharing_opt_in  boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE health_goals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  goal           goal_type NOT NULL,
  title          text NOT NULL,
  target_value   numeric(10,2),
  target_unit    text,
  start_value    numeric(10,2),
  start_date     date NOT NULL DEFAULT current_date,
  target_date    date,
  achieved_at    timestamptz,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX health_goals_user_active_idx ON health_goals (user_id, is_active);

-- Daily nutrient targets. Derived from goals + body stats, but stored so a user can
-- override them (spec §25 — the user stays in control of their own targets).
CREATE TABLE nutrition_goals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  effective_from       date NOT NULL DEFAULT current_date,
  calories_kcal        numeric(8,2) NOT NULL CHECK (calories_kcal > 0),
  protein_g            numeric(8,2),
  carbs_g              numeric(8,2),
  fat_g                numeric(8,2),
  fiber_g              numeric(8,2),
  water_ml             integer,
  -- Safety rail (spec §25): the engine refuses to persist a dangerously low target,
  -- and records whether this value was computed by the app or set by the user.
  computed_by          text NOT NULL DEFAULT 'engine' CHECK (computed_by IN ('engine', 'user', 'clinician')),
  safety_floor_applied boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX nutrition_goals_user_effective_key ON nutrition_goals (user_id, effective_from);

-- Sessions (spec §76, §128). Only a hash of the token is stored, never the token.
CREATE TABLE user_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  token_hash         text NOT NULL UNIQUE,
  -- Rotation family: reusing a superseded refresh token invalidates the whole family,
  -- which is how token-theft replay is contained.
  family_id          uuid NOT NULL DEFAULT gen_random_uuid(),
  rotated_from       uuid,
  user_agent         text,
  ip_hash            text,
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoked_reason     text,
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id, created_at DESC);
CREATE INDEX user_sessions_active_idx ON user_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE email_verification_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  ip_hash     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================================
-- NUTRITION REFERENCE LAYER (spec §11, §12, §13, §68, §69)
--
-- Design rule from the spec: the vision model only IDENTIFIES foods. Every nutrient
-- number shown to a user comes from a row in this schema, or is explicitly labelled
-- as user-entered / AI-estimated. There is no code path that invents nutrient values.
-- =====================================================================================

CREATE TABLE food_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  parent_id  uuid REFERENCES food_categories(id) ON DELETE SET NULL,
  sort_order integer NOT NULL DEFAULT 0
);

-- The normalization layer (spec §11): "Dahi" / "Curd" / "Plain Yogurt" can be distinct
-- foods that share one family, letting search and matching treat them as equivalent
-- while nutrition still comes from the specific food record.
CREATE TABLE food_families (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  notes      text
);

CREATE TABLE foods (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name     text NOT NULL,
  -- Precomputed lowercase form so lookups can use a plain btree index.
  normalized_name    text NOT NULL,
  category_id        uuid REFERENCES food_categories(id) ON DELETE SET NULL,
  family_id          uuid REFERENCES food_families(id) ON DELETE SET NULL,
  -- Regional / cuisine tagging, e.g. 'south_indian', 'north_indian', 'global'.
  region             text,
  description        text,
  -- Default household portion used when the user gives no quantity.
  default_serving_id uuid,
  -- Only verified rows may be presented as authoritative reference values.
  is_verified        boolean NOT NULL DEFAULT false,
  verification_note  text,
  created_by         uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT foods_canonical_name_shape CHECK (length(btrim(canonical_name)) > 0)
);

CREATE UNIQUE INDEX foods_canonical_name_lower_key ON foods (lower(canonical_name));
CREATE INDEX foods_normalized_trgm_idx ON foods USING gin (normalized_name gin_trgm_ops);
CREATE INDEX foods_canonical_trgm_idx   ON foods USING gin (lower(canonical_name) gin_trgm_ops);
CREATE INDEX foods_category_idx         ON foods (category_id);
CREATE INDEX foods_family_idx           ON foods (family_id);
CREATE INDEX foods_region_idx           ON foods (region) WHERE region IS NOT NULL;

-- Regional aliases (spec §12): one food, many local names and spellings.
CREATE TABLE food_aliases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  food_id        uuid NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  alias          text NOT NULL,
  normalized_alias text NOT NULL,
  language       text NOT NULL DEFAULT 'en',
  region         text,
  -- Relative confidence that this alias truly denotes this food (1.0 = unambiguous).
  match_weight   numeric(3,2) NOT NULL DEFAULT 1.0 CHECK (match_weight > 0 AND match_weight <= 1),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX food_aliases_unique ON food_aliases (food_id, lower(alias), language);
CREATE INDEX food_aliases_normalized_trgm_idx ON food_aliases USING gin (normalized_alias gin_trgm_ops);
CREATE INDEX food_aliases_food_idx ON food_aliases (food_id);

-- Serving-size engine (spec §13). Every serving resolves to a canonical gram/ml amount
-- so any unit the user picks can be converted to the reference basis deterministically.
CREATE TABLE food_servings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  food_id      uuid NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  label        text NOT NULL,          -- what the user sees: "1 katori", "1 idli"
  unit         text NOT NULL,          -- canonical unit code: katori, cup, piece, g ...
  amount       numeric(10,3) NOT NULL CHECK (amount > 0),
  grams        numeric(10,3) NOT NULL CHECK (grams > 0),
  -- Household measures are inherently approximate; this drives the "AI Estimated"
  -- language and the confidence band shown in the UI.
  is_approximate boolean NOT NULL DEFAULT false,
  is_default     boolean NOT NULL DEFAULT false,
  source         nutrition_source NOT NULL DEFAULT 'database_record',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX food_servings_unique ON food_servings (food_id, lower(label));
-- At most one default serving per food.
CREATE UNIQUE INDEX food_servings_one_default ON food_servings (food_id) WHERE is_default;

ALTER TABLE foods
  ADD CONSTRAINT foods_default_serving_fk
  FOREIGN KEY (default_serving_id) REFERENCES food_servings(id) ON DELETE SET NULL;

-- Canonical nutrient values, always stored per 100 g of the edible portion so that
-- quantity scaling is one multiplication (spec §7).
CREATE TABLE nutrition_reference (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  food_id        uuid NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  basis_amount   numeric(10,3) NOT NULL DEFAULT 100 CHECK (basis_amount > 0),
  basis_unit     text NOT NULL DEFAULT 'g' CHECK (basis_unit IN ('g', 'ml')),
  calories_kcal  numeric(10,2) NOT NULL CHECK (calories_kcal >= 0),
  protein_g      numeric(10,3) NOT NULL DEFAULT 0 CHECK (protein_g >= 0),
  carbs_g        numeric(10,3) NOT NULL DEFAULT 0 CHECK (carbs_g >= 0),
  fat_g          numeric(10,3) NOT NULL DEFAULT 0 CHECK (fat_g >= 0),
  fiber_g        numeric(10,3) NOT NULL DEFAULT 0 CHECK (fiber_g >= 0),
  sugar_g        numeric(10,3) NOT NULL DEFAULT 0 CHECK (sugar_g >= 0),
  sodium_mg      numeric(10,2) NOT NULL DEFAULT 0 CHECK (sodium_mg >= 0),
  -- Micronutrients stay in a jsonb bag: the set varies per food and per source, and
  -- nothing in the product logic aggregates across them yet.
  micronutrients jsonb NOT NULL DEFAULT '{}'::jsonb,
  source         nutrition_source NOT NULL DEFAULT 'database_record',
  -- Provenance is mandatory: a reference value without a source is not trustworthy,
  -- and the UI shows this to the user (spec §69, §70).
  source_name    text,
  source_url     text,
  source_ref     text,
  verified_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Cooking method materially changes nutrients for the same food (spec §15).
  cooking_method text,
  CONSTRAINT nutrition_reference_calorie_macro_sanity CHECK (
    -- 1 g fat = 9 kcal, 1 g carb/protein = 4 kcal. Allow generous slack for fibre,
    -- alcohol and rounding, but reject physically impossible rows.
    calories_kcal <= (carbs_g + protein_g) * 4 + fat_g * 9 + 40
  )
);
CREATE UNIQUE INDEX nutrition_reference_food_method_key
  ON nutrition_reference (food_id, COALESCE(cooking_method, ''), COALESCE(source_ref, ''));
CREATE INDEX nutrition_reference_food_idx ON nutrition_reference (food_id);
CREATE INDEX nutrition_reference_verified_idx ON nutrition_reference (verified_at) WHERE verified_at IS NOT NULL;

-- Packaged products (spec §16) — brand + product + barcode, kept separate from the
-- generic `foods` table so a branded item never overwrites a whole-food reference.
CREATE TABLE food_brands (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  normalized_name text NOT NULL,
  country    text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX food_brands_name_lower_key ON food_brands (lower(name));

CREATE TABLE food_products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id       uuid REFERENCES food_brands(id) ON DELETE SET NULL,
  name           text NOT NULL,
  normalized_name text NOT NULL,
  -- An optional link to a generic food for macro-equivalent fallbacks.
  food_id        uuid REFERENCES foods(id) ON DELETE SET NULL,
  serving_label  text,
  serving_grams  numeric(10,3),
  calories_kcal  numeric(10,2),
  protein_g      numeric(10,3),
  carbs_g        numeric(10,3),
  fat_g          numeric(10,3),
  fiber_g        numeric(10,3),
  sugar_g        numeric(10,3),
  sodium_mg      numeric(10,2),
  micronutrients jsonb NOT NULL DEFAULT '{}'::jsonb,
  source         nutrition_source NOT NULL DEFAULT 'package_label',
  source_name    text,
  source_ref     text,
  image_url      text,
  verified_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX food_products_name_trgm_idx ON food_products USING gin (normalized_name gin_trgm_ops);
CREATE INDEX food_products_brand_idx ON food_products (brand_id);

CREATE TABLE barcodes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL,
  symbology      text NOT NULL DEFAULT 'unknown',
  product_id     uuid REFERENCES food_products(id) ON DELETE CASCADE,
  -- A barcode with no product is a real state: it is recorded so "Product Not Found"
  -- can be shown truthfully and revisited, instead of guessing nutrition (spec §16, §68).
  lookup_state   text NOT NULL DEFAULT 'pending'
                 CHECK (lookup_state IN ('pending', 'found', 'not_found', 'rejected')),
  last_looked_up_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX barcodes_code_key ON barcodes (code);
CREATE INDEX barcodes_product_idx ON barcodes (product_id);

-- =====================================================================================
-- MEALS (spec §20, §21, §22, §71, §87, §88)
-- =====================================================================================

CREATE TABLE meals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  meal_type        meal_type NOT NULL,
  meal_date        date NOT NULL,
  logged_at        timestamptz NOT NULL DEFAULT now(),
  title            text,
  notes            text,
  source           meal_source NOT NULL DEFAULT 'manual',
  -- Double-submit protection (spec §71). Enforced by a partial unique index so the
  -- database, not the UI, is the authority on whether an operation already happened.
  idempotency_key  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX meals_idempotency_key ON meals (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX meals_user_date_idx ON meals (user_id, meal_date DESC);
CREATE INDEX meals_user_logged_idx ON meals (user_id, logged_at DESC);

CREATE TABLE meal_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_id            uuid NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  position           integer NOT NULL DEFAULT 0,
  -- Exactly one of food_id / product_id is normally set; both may be null for a
  -- purely manual entry, which is why the label and quantities below are required.
  food_id            uuid REFERENCES foods(id) ON DELETE SET NULL,
  product_id         uuid REFERENCES food_products(id) ON DELETE SET NULL,
  display_name       text NOT NULL,
  quantity           numeric(10,3) NOT NULL CHECK (quantity > 0),
  unit               text NOT NULL,
  -- Resolved grams so every item shares one comparable basis (spec §13).
  grams              numeric(10,3) NOT NULL CHECK (grams > 0),
  serving_id         uuid REFERENCES food_servings(id) ON DELETE SET NULL,
  -- Snapshot of the values actually used, so editing a reference food later cannot
  -- retroactively change what the user's history said they ate.
  calories_kcal      numeric(10,2) NOT NULL CHECK (calories_kcal >= 0),
  protein_g          numeric(10,3) NOT NULL CHECK (protein_g >= 0),
  carbs_g            numeric(10,3) NOT NULL CHECK (carbs_g >= 0),
  fat_g              numeric(10,3) NOT NULL CHECK (fat_g >= 0),
  fiber_g            numeric(10,3) NOT NULL DEFAULT 0 CHECK (fiber_g >= 0),
  sugar_g            numeric(10,3) NOT NULL DEFAULT 0 CHECK (sugar_g >= 0),
  sodium_mg          numeric(10,2) NOT NULL DEFAULT 0 CHECK (sodium_mg >= 0),
  -- Provenance shown in the UI (spec §70).
  nutrition_source   nutrition_source NOT NULL DEFAULT 'database_record',
  -- Which scan produced this item, when applicable, so corrections stay linked.
  scan_result_id     uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meal_items_meal_idx ON meal_items (meal_id, position);
CREATE INDEX meal_items_food_idx ON meal_items (food_id);

-- One-tap re-logging (spec §21).
CREATE TABLE food_favorites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  food_id    uuid NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX food_favorites_key ON food_favorites (user_id, food_id);

CREATE TABLE saved_meals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name            text NOT NULL,
  default_meal_type meal_type NOT NULL DEFAULT 'lunch',
  -- Full item list as jsonb, because a saved meal is a reusable template that must
  -- survive changes to the foods it was built from.
  items           jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_calories_kcal numeric(10,2) NOT NULL DEFAULT 0,
  times_used      integer NOT NULL DEFAULT 0,
  last_used_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_meals_user_idx ON saved_meals (user_id, created_at DESC);

-- =====================================================================================
-- FOOD SCANNING (spec §3, §4, §8, §9, §10, §54, §58, §112)
-- =====================================================================================

CREATE TABLE food_scans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status            scan_status NOT NULL DEFAULT 'queued',
  -- Random storage path; the user's original filename is NEVER used as an identifier
  -- (spec §77). Kept for display only.
  storage_path      text,
  thumbnail_path    text,
  original_filename text,
  mime_type         text,
  byte_size         integer,
  width             integer,
  height            integer,
  -- Content hash lets us warn about a re-uploaded identical image (spec §112).
  content_sha256    text,
  -- 'Tell AI More' free-text context, e.g. "made with 2 tsp oil" (spec §14).
  user_context      text,
  cooking_method    text,
  provider          text,
  model             text,
  error_code        text,
  error_message     text,
  idempotency_key   text,
  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX food_scans_idempotency_key ON food_scans (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX food_scans_user_idx ON food_scans (user_id, created_at DESC);
CREATE INDEX food_scans_status_idx ON food_scans (status) WHERE status IN ('queued', 'analyzing', 'calculating');
CREATE INDEX food_scans_hash_idx ON food_scans (user_id, content_sha256) WHERE content_sha256 IS NOT NULL;

CREATE TABLE food_scan_results (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id              uuid NOT NULL REFERENCES food_scans(id) ON DELETE CASCADE,
  position             integer NOT NULL DEFAULT 0,
  -- What the model proposed, kept verbatim so a correction can be diffed against it.
  detected_label       text NOT NULL,
  detected_category    text,
  matched_food_id      uuid REFERENCES foods(id) ON DELETE SET NULL,
  matched_product_id   uuid REFERENCES food_products(id) ON DELETE SET NULL,
  -- Alternative candidates for user confirmation (spec §9).
  alternatives         jsonb NOT NULL DEFAULT '[]'::jsonb,
  estimated_quantity   numeric(10,3),
  estimated_unit       text,
  estimated_grams      numeric(10,3),
  -- Portion ranges are first-class, because a photo cannot yield an exact weight
  -- (spec §6). The UI shows "185 g (160-210 g)".
  estimated_grams_min  numeric(10,3),
  estimated_grams_max  numeric(10,3),
  -- Segmentation box in normalised 0..1 coordinates, plus a polygon when available
  -- (spec §5). Null means no reliable region — the UI then must not draw one.
  bounding_box         jsonb,
  polygon              jsonb,
  food_recognition_confidence numeric(4,3) CHECK (food_recognition_confidence BETWEEN 0 AND 1),
  portion_confidence          numeric(4,3) CHECK (portion_confidence BETWEEN 0 AND 1),
  match_confidence            numeric(4,3) CHECK (match_confidence BETWEEN 0 AND 1),
  -- Resolved nutrition for the estimated quantity, from the matched reference row.
  resolved_calories_kcal numeric(10,2),
  resolved_protein_g     numeric(10,3),
  resolved_carbs_g       numeric(10,3),
  resolved_fat_g         numeric(10,3),
  resolved_fiber_g       numeric(10,3),
  nutrition_source       nutrition_source,
  -- True when no reference row could be matched. The UI must then offer alternative
  -- foods / manual entry instead of displaying invented numbers (spec §68).
  nutrition_unavailable  boolean NOT NULL DEFAULT false,
  user_confirmed       boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX food_scan_results_scan_idx ON food_scan_results (scan_id, position);

ALTER TABLE meal_items
  ADD CONSTRAINT meal_items_scan_result_fk
  FOREIGN KEY (scan_result_id) REFERENCES food_scan_results(id) ON DELETE SET NULL;

-- Reviewed feedback dataset (spec §10). Corrections are NEVER used to train a live
-- model directly; they accumulate here for offline evaluation.
CREATE TABLE food_corrections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  scan_id             uuid REFERENCES food_scans(id) ON DELETE SET NULL,
  scan_result_id      uuid REFERENCES food_scan_results(id) ON DELETE SET NULL,
  original_label      text,
  original_food_id    uuid REFERENCES foods(id) ON DELETE SET NULL,
  original_quantity   numeric(10,3),
  original_unit       text,
  original_grams      numeric(10,3),
  corrected_food_id   uuid REFERENCES foods(id) ON DELETE SET NULL,
  corrected_quantity  numeric(10,3),
  corrected_unit      text,
  corrected_grams     numeric(10,3),
  correction_kind     text NOT NULL
                      CHECK (correction_kind IN ('wrong_food', 'wrong_quantity', 'missing_food', 'wrong_nutrition_match', 'extra_item')),
  original_confidence numeric(4,3),
  notes               text,
  -- Review workflow gate: a row contributes to evaluation only once reviewed (spec §65).
  review_state        text NOT NULL DEFAULT 'pending'
                      CHECK (review_state IN ('pending', 'approved', 'rejected', 'merged')),
  reviewed_by         uuid REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX food_corrections_user_idx ON food_corrections (user_id, created_at DESC);
CREATE INDEX food_corrections_review_idx ON food_corrections (review_state) WHERE review_state = 'pending';

-- Simple thumbs up/down on an analysis (spec §121).
CREATE TABLE user_feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('food_scan', 'meal', 'ai_message', 'recipe', 'workout_plan', 'app')),
  subject_id  uuid,
  rating      smallint CHECK (rating IS NULL OR rating IN (-1, 1)),
  category    text,
  message     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_feedback_user_idx ON user_feedback (user_id, created_at DESC);

-- =====================================================================================
-- DAILY SUMMARY (spec §88) — server-maintained rollup, recomputed on every write
-- =====================================================================================

CREATE TABLE daily_summaries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  summary_date        date NOT NULL,
  calories_kcal       numeric(10,2) NOT NULL DEFAULT 0,
  protein_g           numeric(10,3) NOT NULL DEFAULT 0,
  carbs_g             numeric(10,3) NOT NULL DEFAULT 0,
  fat_g               numeric(10,3) NOT NULL DEFAULT 0,
  fiber_g             numeric(10,3) NOT NULL DEFAULT 0,
  sugar_g             numeric(10,3) NOT NULL DEFAULT 0,
  sodium_mg           numeric(10,2) NOT NULL DEFAULT 0,
  water_ml            integer NOT NULL DEFAULT 0,
  workout_minutes     integer NOT NULL DEFAULT 0,
  steps               integer NOT NULL DEFAULT 0,
  sleep_minutes       integer,
  meals_logged        integer NOT NULL DEFAULT 0,
  -- Bumped on every recalculation so clients can discard stale realtime payloads.
  revision            bigint NOT NULL DEFAULT 1,
  calculated_at       timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX daily_summaries_user_date_key ON daily_summaries (user_id, summary_date);
CREATE INDEX daily_summaries_date_idx ON daily_summaries (summary_date DESC);

-- =====================================================================================
-- ROW LEVEL SECURITY ENGINE (spec §75)
--
-- Instead of hand-writing policies per table (and inevitably forgetting one), this
-- function discovers every base table in `public` that has a `user_id uuid` column,
-- forces RLS on it, and installs the four ownership policies. A new user-data table
-- therefore gets protection automatically, and the test suite asserts that the set of
-- RLS-protected tables matches the set the application believes it owns.
-- =====================================================================================
CREATE OR REPLACE FUNCTION app_apply_rls() RETURNS integer
  LANGUAGE plpgsql
  AS $$
DECLARE
  target text;
  applied integer := 0;
BEGIN
  FOR target IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name   = c.table_name
       AND t.table_type   = 'BASE TABLE'
     WHERE c.table_schema = 'public'
       AND c.column_name  = 'user_id'
       AND c.data_type    = 'uuid'
     ORDER BY c.table_name
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target);
    -- FORCE means the table owner is subject to policies too, so a bug that forgets to
    -- switch role cannot silently read everyone's rows.
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', target);

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO app_user', target);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', target || '_owner_select', target);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', target || '_owner_insert', target);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', target || '_owner_update', target);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', target || '_owner_delete', target);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO app_user USING (user_id = app_current_user_id())',
      target || '_owner_select', target);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO app_user WITH CHECK (user_id = app_current_user_id())',
      target || '_owner_insert', target);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO app_user USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id())',
      target || '_owner_update', target);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO app_user USING (user_id = app_current_user_id())',
      target || '_owner_delete', target);

    applied := applied + 1;
  END LOOP;
  RETURN applied;
END $$;

COMMENT ON FUNCTION app_apply_rls() IS
  'Idempotently enables FORCEd RLS and owner policies on every public table with a user_id column. Called at the end of each migration.';

-- Child tables have no user_id of their own and are protected through their parent.
CREATE OR REPLACE FUNCTION app_apply_child_rls() RETURNS integer
  LANGUAGE plpgsql
  AS $$
DECLARE
  spec record;
  applied integer := 0;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('meal_items',       'meal_id',          'SELECT, INSERT, UPDATE, DELETE', 'EXISTS (SELECT 1 FROM public.meals p WHERE p.id = meal_items.meal_id AND p.user_id = app_current_user_id())'),
      ('food_scan_results','scan_id',          'SELECT, INSERT, UPDATE, DELETE', 'EXISTS (SELECT 1 FROM public.food_scans p WHERE p.id = food_scan_results.scan_id AND p.user_id = app_current_user_id())'),
      ('meal_plan_days',   'meal_plan_id',     'SELECT, INSERT, UPDATE, DELETE', 'EXISTS (SELECT 1 FROM public.meal_plans p WHERE p.id = meal_plan_days.meal_plan_id AND p.user_id = app_current_user_id())'),
      ('meal_plan_items',  'meal_plan_day_id', 'SELECT, INSERT, UPDATE, DELETE', 'EXISTS (SELECT 1 FROM public.meal_plan_days d JOIN public.meal_plans p ON p.id = d.meal_plan_id WHERE d.id = meal_plan_items.meal_plan_day_id AND p.user_id = app_current_user_id())'),
      ('workout_sets',     'session_id',       'SELECT, INSERT, UPDATE, DELETE', 'EXISTS (SELECT 1 FROM public.workout_sessions s WHERE s.id = workout_sets.session_id AND s.user_id = app_current_user_id())'),
      ('ai_messages',      'conversation_id',  'SELECT, INSERT, UPDATE, DELETE', 'EXISTS (SELECT 1 FROM public.ai_conversations c WHERE c.id = ai_messages.conversation_id AND c.user_id = app_current_user_id())')
    ) AS t(table_name, fk_column, privs, using_expr)
  LOOP
    -- Only act when the table actually exists (later migrations add them).
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = spec.table_name AND table_type = 'BASE TABLE'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', spec.table_name);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', spec.table_name);
      EXECUTE format('GRANT %s ON public.%I TO app_user', spec.privs, spec.table_name);

      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec.table_name || '_owner_parent_select', spec.table_name);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec.table_name || '_owner_parent_write', spec.table_name);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec.table_name || '_owner_parent_delete', spec.table_name);

      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO app_user USING (%s)',
        spec.table_name || '_owner_parent_select', spec.table_name, spec.using_expr);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO app_user USING (%s) WITH CHECK (%s)',
        spec.table_name || '_owner_parent_write', spec.table_name, spec.using_expr, spec.using_expr);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO app_user USING (%s)',
        spec.table_name || '_owner_parent_delete', spec.table_name, spec.using_expr);

      applied := applied + 1;
    END IF;
  END LOOP;
  RETURN applied;
END $$;

-- Shared reference data: readable by every authenticated user, writable only by the
-- owner role (i.e. by migrations and reviewed admin flows), never by app_user.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'food_categories','food_families','foods','food_aliases','food_servings',
    'nutrition_reference','food_brands','food_products','barcodes'
  ] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO app_user', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM app_user', t);
  END LOOP;
END $$;

SELECT app_apply_rls()   AS user_scoped_tables_protected;
SELECT app_apply_child_rls() AS child_tables_protected;
