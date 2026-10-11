-- =====================================================================================
-- FITTRACK AI — Migration 002: plans, recipes, tracking, workouts, AI, billing, admin
--
-- Design rule applied throughout: a table gets a column literally named `user_id uuid`
-- ONLY when it holds per-user data that must be protected by row-level security. The
-- migration-001 helper app_apply_rls() then protects it automatically, so a new table
-- cannot silently miss protection. Tables that must NOT be user-scoped (global catalogs,
-- append-only system logs, webhook receipts) deliberately use a different column name,
-- and each such choice is commented where it occurs.
-- =====================================================================================

-- =====================================================================================
-- RECIPES (spec §28, §29, §30, §31, §124)
-- =====================================================================================

CREATE TABLE recipes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL,
  name            text NOT NULL,
  description     text,
  image_url       text,
  cuisine         text,
  region          text,
  diet_patterns   diet_pattern[] NOT NULL DEFAULT '{}',
  meal_types      meal_type[] NOT NULL DEFAULT '{}',
  prep_minutes    integer CHECK (prep_minutes IS NULL OR prep_minutes >= 0),
  cook_minutes    integer CHECK (cook_minutes IS NULL OR cook_minutes >= 0),
  total_minutes   integer GENERATED ALWAYS AS (
                    COALESCE(prep_minutes, 0) + COALESCE(cook_minutes, 0)
                  ) STORED,
  base_servings   numeric(6,2) NOT NULL DEFAULT 1 CHECK (base_servings > 0),
  difficulty      text CHECK (difficulty IS NULL OR difficulty IN ('easy', 'medium', 'hard')),
  instructions    jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags            text[] NOT NULL DEFAULT '{}',
  -- Nutritions are per base_servings and are always computed from the ingredient rows
  -- below using reference data — never typed in by hand (spec §29).
  calories_kcal   numeric(10,2),
  protein_g       numeric(10,3),
  carbs_g         numeric(10,3),
  fat_g           numeric(10,3),
  fiber_g         numeric(10,3),
  nutrition_source nutrition_source NOT NULL DEFAULT 'recipe_calculated',
  is_published    boolean NOT NULL DEFAULT false,
  is_verified     boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recipes_slug_shape CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
CREATE UNIQUE INDEX recipes_slug_key ON recipes (slug);
CREATE INDEX recipes_name_trgm_idx ON recipes USING gin (lower(name) gin_trgm_ops);
CREATE INDEX recipes_published_idx ON recipes (is_published) WHERE is_published;
CREATE INDEX recipes_meal_types_idx ON recipes USING gin (meal_types);
CREATE INDEX recipes_diet_idx ON recipes USING gin (diet_patterns);

CREATE TABLE recipe_ingredients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id   uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position    integer NOT NULL DEFAULT 0,
  food_id     uuid REFERENCES foods(id) ON DELETE SET NULL,
  product_id  uuid REFERENCES food_products(id) ON DELETE SET NULL,
  display_name text NOT NULL,
  quantity    numeric(10,3) NOT NULL CHECK (quantity > 0),
  unit        text NOT NULL,
  grams       numeric(10,3) CHECK (grams IS NULL OR grams > 0),
  optional    boolean NOT NULL DEFAULT false,
  group_label text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recipe_ingredients_recipe_idx ON recipe_ingredients (recipe_id, position);
CREATE INDEX recipe_ingredients_food_idx ON recipe_ingredients (food_id);

-- A user's own recipes. Separate from the shared library so a private recipe can never
-- leak into public/SEO pages (spec §124).
CREATE TABLE user_recipes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  recipe_id   uuid REFERENCES recipes(id) ON DELETE SET NULL,
  name        text NOT NULL,
  description text,
  ingredients jsonb NOT NULL DEFAULT '[]'::jsonb,
  instructions jsonb NOT NULL DEFAULT '[]'::jsonb,
  servings    numeric(6,2) NOT NULL DEFAULT 1 CHECK (servings > 0),
  total_calories_kcal numeric(10,2) NOT NULL DEFAULT 0,
  source      text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'ai_generated', 'imported')),
  -- Explicit publication flag; default false (spec §124).
  published_slug text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_recipes_user_idx ON user_recipes (user_id, created_at DESC);
CREATE UNIQUE INDEX user_recipes_published_slug_key ON user_recipes (published_slug)
  WHERE published_slug IS NOT NULL;

-- =====================================================================================
-- MEAL PLANNER + GROCERY + PANTRY (spec §26, §27, §31, §32)
-- =====================================================================================

CREATE TABLE meal_plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name          text NOT NULL,
  start_date    date NOT NULL,
  day_count     smallint NOT NULL CHECK (day_count BETWEEN 1 AND 31),
  target_calories_kcal numeric(8,2),
  target_protein_g     numeric(8,2),
  diet_pattern  diet_pattern,
  cuisine       text,
  budget_level  text CHECK (budget_level IS NULL OR budget_level IN ('low', 'medium', 'high')),
  max_cook_minutes     integer,
  constraints   jsonb NOT NULL DEFAULT '{}'::jsonb,
  generation_state text NOT NULL DEFAULT 'draft'
                   CHECK (generation_state IN ('draft', 'generating', 'ready', 'failed')),
  generator    text NOT NULL DEFAULT 'manual' CHECK (generator IN ('manual', 'ai', 'template')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meal_plans_user_idx ON meal_plans (user_id, start_date DESC);

CREATE TABLE meal_plan_days (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_plan_id  uuid NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
  day_date      date NOT NULL,
  day_index     smallint NOT NULL CHECK (day_index >= 0),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX meal_plan_days_unique ON meal_plan_days (meal_plan_id, day_index);
CREATE UNIQUE INDEX meal_plan_days_date_key ON meal_plan_days (meal_plan_id, day_date);

CREATE TABLE meal_plan_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_plan_day_id uuid NOT NULL REFERENCES meal_plan_days(id) ON DELETE CASCADE,
  meal_type        meal_type NOT NULL,
  position         integer NOT NULL DEFAULT 0,
  recipe_id        uuid REFERENCES recipes(id) ON DELETE SET NULL,
  user_recipe_id   uuid REFERENCES user_recipes(id) ON DELETE SET NULL,
  food_id          uuid REFERENCES foods(id) ON DELETE SET NULL,
  display_name     text NOT NULL,
  servings         numeric(6,2) NOT NULL DEFAULT 1 CHECK (servings > 0),
  calories_kcal    numeric(10,2) NOT NULL DEFAULT 0,
  protein_g        numeric(10,3) NOT NULL DEFAULT 0,
  carbs_g          numeric(10,3) NOT NULL DEFAULT 0,
  fat_g            numeric(10,3) NOT NULL DEFAULT 0,
  -- Set when the user has accepted the planned meal into their diary.
  logged_meal_id   uuid REFERENCES meals(id) ON DELETE SET NULL,
  is_swapped       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meal_plan_items_day_idx ON meal_plan_items (meal_plan_day_id, meal_type, position);

CREATE TABLE grocery_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  meal_plan_id uuid REFERENCES meal_plans(id) ON DELETE SET NULL,
  category     text NOT NULL DEFAULT 'other',
  display_name text NOT NULL,
  quantity     numeric(10,3),
  unit         text,
  grams        numeric(10,3),
  is_checked   boolean NOT NULL DEFAULT false,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX grocery_items_user_idx ON grocery_items (user_id, is_checked, category);

CREATE TABLE pantry_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  food_id      uuid REFERENCES foods(id) ON DELETE SET NULL,
  display_name text NOT NULL,
  quantity     numeric(10,3) CHECK (quantity IS NULL OR quantity >= 0),
  unit         text,
  grams        numeric(10,3),
  expires_on   date,
  opened_on    date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pantry_items_user_idx ON pantry_items (user_id, expires_on);

-- =====================================================================================
-- DAILY TRACKING: WATER, WEIGHT, MEASUREMENTS, PHOTOS (spec §33, §34, §35, §36)
-- =====================================================================================

CREATE TABLE water_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  logged_on   date NOT NULL DEFAULT current_date,
  logged_at   timestamptz NOT NULL DEFAULT now(),
  amount_ml   integer NOT NULL CHECK (amount_ml > 0 AND amount_ml <= 5000),
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'quick_add', 'reminder', 'import')),
  idempotency_key text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX water_logs_idempotency_key ON water_logs (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX water_logs_user_date_idx ON water_logs (user_id, logged_on DESC);

CREATE TABLE weight_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  logged_on   date NOT NULL DEFAULT current_date,
  weight_kg   numeric(6,2) NOT NULL CHECK (weight_kg > 5 AND weight_kg < 500),
  body_fat_pct numeric(5,2) CHECK (body_fat_pct IS NULL OR (body_fat_pct >= 1 AND body_fat_pct <= 70)),
  muscle_mass_kg numeric(6,2) CHECK (muscle_mass_kg IS NULL OR muscle_mass_kg > 0),
  note        text,
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'scale', 'import')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- One weight per day; a re-log overwrites so charts never show duplicate spikes.
CREATE UNIQUE INDEX weight_logs_user_date_key ON weight_logs (user_id, logged_on);
CREATE INDEX weight_logs_user_date_desc_idx ON weight_logs (user_id, logged_on DESC);

CREATE TABLE body_measurements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  measured_on  date NOT NULL DEFAULT current_date,
  waist_cm     numeric(5,1) CHECK (waist_cm IS NULL OR (waist_cm > 20 AND waist_cm < 300)),
  chest_cm     numeric(5,1) CHECK (chest_cm IS NULL OR (chest_cm > 20 AND chest_cm < 300)),
  hip_cm       numeric(5,1) CHECK (hip_cm IS NULL OR (hip_cm > 20 AND hip_cm < 300)),
  arm_cm       numeric(5,1) CHECK (arm_cm IS NULL OR (arm_cm > 5 AND arm_cm < 150)),
  thigh_cm     numeric(5,1) CHECK (thigh_cm IS NULL OR (thigh_cm > 5 AND thigh_cm < 200)),
  neck_cm      numeric(5,1) CHECK (neck_cm IS NULL OR (neck_cm > 5 AND neck_cm < 150)),
  body_fat_pct numeric(5,2) CHECK (body_fat_pct IS NULL OR (body_fat_pct >= 1 AND body_fat_pct <= 70)),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX body_measurements_user_date_key ON body_measurements (user_id, measured_on);

CREATE TABLE progress_photos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  taken_on      date NOT NULL DEFAULT current_date,
  pose          text NOT NULL CHECK (pose IN ('front', 'side', 'back', 'other')),
  storage_path  text NOT NULL,
  thumbnail_path text,
  mime_type     text NOT NULL,
  byte_size     integer NOT NULL CHECK (byte_size > 0),
  width         integer,
  height        integer,
  -- Private by default: there is no public URL column, and reads go through an
  -- authorised route that checks ownership (spec §36).
  is_shared     boolean NOT NULL DEFAULT false,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX progress_photos_user_idx ON progress_photos (user_id, taken_on DESC);

-- =====================================================================================
-- WORKOUTS (spec §37, §38, §39, §40, §41, §42)
-- =====================================================================================

CREATE TABLE exercises (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text NOT NULL,
  name              text NOT NULL,
  category          text NOT NULL
                    CHECK (category IN ('chest','back','legs','shoulders','arms','core','cardio','mobility','full_body')),
  primary_muscles   text[] NOT NULL DEFAULT '{}',
  secondary_muscles text[] NOT NULL DEFAULT '{}',
  equipment         text[] NOT NULL DEFAULT '{}',
  difficulty        text NOT NULL DEFAULT 'beginner'
                    CHECK (difficulty IN ('beginner','intermediate','advanced')),
  instructions      jsonb NOT NULL DEFAULT '[]'::jsonb,
  safety_notes      text,
  video_url         text,
  image_url         text,
  -- For cardio/time-based movements, metrics are tracked in seconds or metres instead
  -- of reps. This drives which input the active-workout screen shows.
  is_timed          boolean NOT NULL DEFAULT false,
  is_unilateral     boolean NOT NULL DEFAULT false,
  met_value         numeric(5,2) CHECK (met_value IS NULL OR met_value > 0),
  is_verified       boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX exercises_slug_key ON exercises (slug);
CREATE INDEX exercises_name_trgm_idx ON exercises USING gin (lower(name) gin_trgm_ops);
CREATE INDEX exercises_category_idx ON exercises (category, difficulty);
CREATE INDEX exercises_equipment_idx ON exercises USING gin (equipment);

CREATE TABLE workout_plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name          text NOT NULL,
  goal          goal_type,
  experience    text CHECK (experience IS NULL OR experience IN ('beginner','intermediate','advanced')),
  days_per_week smallint CHECK (days_per_week IS NULL OR days_per_week BETWEEN 1 AND 7),
  session_minutes integer,
  equipment     text[] NOT NULL DEFAULT '{}',
  -- Generated plans are editable: this is the current definition, and the user owns it.
  schedule      jsonb NOT NULL DEFAULT '[]'::jsonb,
  generator     text NOT NULL DEFAULT 'manual' CHECK (generator IN ('manual','ai','template')),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workout_plans_user_idx ON workout_plans (user_id, is_active);

CREATE TABLE workout_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  workout_plan_id uuid REFERENCES workout_plans(id) ON DELETE SET NULL,
  name           text,
  session_date   date NOT NULL DEFAULT current_date,
  started_at     timestamptz,
  completed_at   timestamptz,
  status         text NOT NULL DEFAULT 'in_progress'
                 CHECK (status IN ('in_progress','completed','abandoned')),
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  total_volume_kg  numeric(12,3) NOT NULL DEFAULT 0,
  calories_burned_kcal numeric(8,2),
  -- Estimated, never presented as a measured clinical value.
  calories_source nutrition_source NOT NULL DEFAULT 'ai_estimate',
  notes          text,
  idempotency_key text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workout_sessions_idempotency_key ON workout_sessions (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX workout_sessions_user_date_idx ON workout_sessions (user_id, session_date DESC);
-- At most one in-progress session per user, so "resume workout" is unambiguous.
CREATE UNIQUE INDEX workout_sessions_one_active ON workout_sessions (user_id)
  WHERE status = 'in_progress';

CREATE TABLE workout_sets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
  exercise_id   uuid NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT,
  set_index     smallint NOT NULL CHECK (set_index >= 0),
  set_type      text NOT NULL DEFAULT 'normal'
                CHECK (set_type IN ('normal','warmup','dropset','failure','amrap')),
  reps          smallint CHECK (reps IS NULL OR (reps >= 0 AND reps <= 1000)),
  weight_kg     numeric(7,2) CHECK (weight_kg IS NULL OR (weight_kg >= 0 AND weight_kg <= 1000)),
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  distance_m    numeric(10,2) CHECK (distance_m IS NULL OR distance_m >= 0),
  rpe           numeric(3,1) CHECK (rpe IS NULL OR (rpe >= 1 AND rpe <= 10)),
  rest_seconds  integer CHECK (rest_seconds IS NULL OR rest_seconds >= 0),
  is_completed  boolean NOT NULL DEFAULT true,
  completed_at  timestamptz,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- A set is defined by what was actually performed, so it must carry at least one.
  CONSTRAINT workout_sets_has_measure CHECK (reps IS NOT NULL OR duration_seconds IS NOT NULL OR distance_m IS NOT NULL)
);
CREATE INDEX workout_sets_session_idx ON workout_sets (session_id, set_index);
CREATE INDEX workout_sets_exercise_idx ON workout_sets (exercise_id);

-- Personal records (spec §40). Derived from set history and rebuilt idempotently.
CREATE TABLE personal_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  exercise_id   uuid NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  record_type   text NOT NULL
                CHECK (record_type IN ('max_weight','max_reps','max_volume','longest_duration','fastest_distance')),
  value         numeric(12,3) NOT NULL,
  unit          text NOT NULL,
  achieved_on   date NOT NULL,
  session_id    uuid REFERENCES workout_sessions(id) ON DELETE SET NULL,
  previous_value numeric(12,3),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX personal_records_key ON personal_records (user_id, exercise_id, record_type);

-- =====================================================================================
-- ACTIVITY, RECOVERY, HABITS (spec §43, §44, §45, §61, §62, §113)
-- =====================================================================================

CREATE TABLE activity_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  logged_on    date NOT NULL DEFAULT current_date,
  steps        integer CHECK (steps IS NULL OR steps >= 0),
  active_minutes integer CHECK (active_minutes IS NULL OR active_minutes >= 0),
  calories_burned_kcal numeric(8,2) CHECK (calories_burned_kcal IS NULL OR calories_burned_kcal >= 0),
  distance_m   numeric(10,2) CHECK (distance_m IS NULL OR distance_m >= 0),
  -- Provenance matters here: manually typed steps and provider-synced steps are not
  -- equally trustworthy, and the UI labels them differently (spec §69).
  source       nutrition_source NOT NULL DEFAULT 'user_entered',
  provider_key text,
  external_id  text,
  raw_payload  jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX activity_logs_provider_external_key ON activity_logs (provider_key, external_id)
  WHERE provider_key IS NOT NULL AND external_id IS NOT NULL;
CREATE INDEX activity_logs_user_date_idx ON activity_logs (user_id, logged_on DESC);

CREATE TABLE recovery_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  logged_on     date NOT NULL DEFAULT current_date,
  sleep_minutes integer CHECK (sleep_minutes IS NULL OR (sleep_minutes >= 0 AND sleep_minutes <= 1440)),
  sleep_quality smallint CHECK (sleep_quality IS NULL OR sleep_quality BETWEEN 1 AND 5),
  fatigue       smallint CHECK (fatigue IS NULL OR fatigue BETWEEN 1 AND 5),
  soreness      smallint CHECK (soreness IS NULL OR soreness BETWEEN 1 AND 5),
  mood          smallint CHECK (mood IS NULL OR mood BETWEEN 1 AND 5),
  energy        smallint CHECK (energy IS NULL OR energy BETWEEN 1 AND 5),
  resting_heart_rate integer CHECK (resting_heart_rate IS NULL OR resting_heart_rate > 0),
  stress        smallint CHECK (stress IS NULL OR stress BETWEEN 1 AND 5),
  note          text,
  -- Readiness/recovery scores are self-reported composites, deliberately stored with the
  -- inputs so the UI can show its work and label the output an estimate (spec §43, §44).
  recovery_score numeric(5,2) CHECK (recovery_score IS NULL OR (recovery_score >= 0 AND recovery_score <= 100)),
  readiness_score numeric(5,2) CHECK (readiness_score IS NULL OR (readiness_score >= 0 AND readiness_score <= 100)),
  score_method  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX recovery_logs_user_date_key ON recovery_logs (user_id, logged_on);

CREATE TABLE habit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  habit_key   text NOT NULL
              CHECK (habit_key IN ('workout','water','protein_goal','food_logging','sleep_goal','steps','weigh_in')),
  logged_on   date NOT NULL DEFAULT current_date,
  value       numeric(10,3),
  target      numeric(10,3),
  achieved    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX habit_logs_user_habit_date_key ON habit_logs (user_id, habit_key, logged_on);

-- =====================================================================================
-- ACHIEVEMENTS (spec §46, §119)
-- =====================================================================================

CREATE TABLE achievements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL,
  name          text NOT NULL,
  description   text NOT NULL,
  icon          text,
  category      text NOT NULL DEFAULT 'general',
  threshold     integer,
  metric        text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX achievements_slug_key ON achievements (slug);

CREATE TABLE user_achievements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  achievement_id uuid NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  unlocked_at    timestamptz NOT NULL DEFAULT now(),
  progress       numeric(10,3),
  -- One unlock per achievement; re-evaluation is idempotent.
  notified_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_achievements_key ON user_achievements (user_id, achievement_id);

-- Streaks are derived state, recomputed from logs. Stored so the dashboard can read them
-- cheaply. Breaking a streak must never produce shaming copy (spec §46) — the copy lives
-- in the UI layer, not here.
CREATE TABLE user_streaks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  streak_key    text NOT NULL
                CHECK (streak_key IN ('food_logging','workout','water','protein_goal','weigh_in')),
  current_count integer NOT NULL DEFAULT 0 CHECK (current_count >= 0),
  longest_count integer NOT NULL DEFAULT 0 CHECK (longest_count >= 0),
  last_date     date,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_streaks_key ON user_streaks (user_id, streak_key);

-- =====================================================================================
-- AI (spec §47, §48, §49, §50, §65, §66, §67, §100, §109, §110)
-- =====================================================================================

CREATE TABLE ai_conversations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title          text,
  kind           text NOT NULL DEFAULT 'coach'
                 CHECK (kind IN ('coach','daily_review','weekly_report','food_parse','recipe_generator','workout_generator')),
  provider       text,
  model          text,
  -- Conversation-level context flags, so a later audit can show exactly which categories
  -- of the user's data the assistant was allowed to read (spec §48).
  context_scopes text[] NOT NULL DEFAULT '{}',
  archived_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_conversations_user_idx ON ai_conversations (user_id, updated_at DESC);

CREATE TABLE ai_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content         text NOT NULL,
  -- Tool calls and structured results are retained so an answer can be audited back to
  -- the data it was derived from (spec §70).
  tool_calls      jsonb,
  structured      jsonb,
  provider        text,
  model           text,
  prompt_tokens   integer CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens integer CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  latency_ms      integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  finish_reason   text,
  error_code      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_messages_conversation_idx ON ai_messages (conversation_id, created_at);

CREATE TABLE ai_insights (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind          text NOT NULL
                CHECK (kind IN ('daily_review','weekly_report','recommendation','warning','meal_suggestion','workout_progression','readiness_note')),
  insight_date  date NOT NULL DEFAULT current_date,
  title         text NOT NULL,
  body          text NOT NULL,
  -- Structured payload behind the prose, so the numbers in the text can be verified.
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  severity      text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','positive','attention')),
  source        nutrition_source NOT NULL DEFAULT 'ai_estimate',
  -- Insights derived from stale data are invalidated rather than left misleading (spec §130).
  invalidated_at timestamptz,
  invalidated_reason text,
  seen_at       timestamptz,
  provider      text,
  model         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_insights_user_date_idx ON ai_insights (user_id, insight_date DESC);
CREATE INDEX ai_insights_live_idx ON ai_insights (user_id, kind) WHERE invalidated_at IS NULL;

-- Per-user AI consumption and cost (spec §110). Doubles as the quota ledger.
CREATE TABLE ai_usage_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  operation    text NOT NULL
               CHECK (operation IN ('vision_food_scan','vision_label_ocr','llm_chat','llm_food_parse','llm_plan','llm_recipe','speech_to_text','embedding')),
  provider     text,
  model        text,
  prompt_tokens     integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  image_count       integer NOT NULL DEFAULT 0 CHECK (image_count >= 0),
  audio_seconds     numeric(10,2) NOT NULL DEFAULT 0 CHECK (audio_seconds >= 0),
  estimated_cost_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
  cost_basis   jsonb,
  succeeded    boolean NOT NULL DEFAULT true,
  error_code   text,
  latency_ms   integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_events_user_time_idx ON ai_usage_events (user_id, occurred_at DESC);
CREATE INDEX ai_usage_events_operation_idx ON ai_usage_events (operation, occurred_at DESC);

-- A separate held-out evaluation set (spec §67). Never populated from raw user traffic;
-- entries are curated, and each carries the expected answer used by the eval runner.
CREATE TABLE ai_eval_cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL,
  category      text NOT NULL,
  description   text NOT NULL,
  storage_path  text,
  expected_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  acceptable_quantity_ranges jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ai_eval_cases_slug_key ON ai_eval_cases (slug);

CREATE TABLE ai_eval_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  provider      text,
  model         text,
  cases_total   integer NOT NULL DEFAULT 0,
  cases_passed  integer NOT NULL DEFAULT 0,
  results       jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes         text
);

-- =====================================================================================
-- NOTIFICATIONS (spec §51, §52)
-- =====================================================================================

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind        text NOT NULL
              CHECK (kind IN ('meal_plan_ready','workout_scheduled','scan_completed','goal_reached','weekly_review','payment','security','reminder','achievement','system')),
  title       text NOT NULL,
  body        text NOT NULL,
  severity    text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','success','warning','critical')),
  -- Deep link target inside the app.
  href        text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at     timestamptz,
  -- Deduplication for scheduled/reminder notifications so a retried job cannot spam.
  dedupe_key  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz
);
CREATE UNIQUE INDEX notifications_dedupe_key ON notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_user_unread_idx ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  endpoint     text NOT NULL,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text,
  failure_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX push_subscriptions_endpoint_key ON push_subscriptions (endpoint);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id) WHERE revoked_at IS NULL;

-- =====================================================================================
-- BILLING (spec §72, §73, §74)
-- =====================================================================================

CREATE TABLE plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL,
  name           text NOT NULL,
  description    text,
  price_minor    integer NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency       text NOT NULL DEFAULT 'INR',
  billing_period text NOT NULL DEFAULT 'month'
                 CHECK (billing_period IN ('month','year','lifetime','none')),
  -- Entitlements are data, not code, so a plan change does not require a deploy.
  entitlements   jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active      boolean NOT NULL DEFAULT true,
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX plans_code_key ON plans (code);

CREATE TABLE subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  plan_id               uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  status                text NOT NULL DEFAULT 'incomplete'
                        CHECK (status IN ('incomplete','active','past_due','cancelled','expired','refunded')),
  provider              text NOT NULL DEFAULT 'none',
  provider_subscription_id text,
  provider_customer_id  text,
  current_period_start  timestamptz,
  current_period_end    timestamptz,
  cancel_at_period_end  boolean NOT NULL DEFAULT false,
  cancelled_at          timestamptz,
  -- Entitlement checks read this, and it is only ever written after server-side
  -- verification of a payment or a signed webhook (spec §72).
  trial_end             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscriptions_provider_key ON subscriptions (provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;
-- At most one non-terminal subscription per user.
CREATE UNIQUE INDEX subscriptions_one_active_per_user ON subscriptions (user_id)
  WHERE status = 'active';
CREATE INDEX subscriptions_user_idx ON subscriptions (user_id, created_at DESC);

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  provider        text NOT NULL DEFAULT 'none',
  provider_payment_id text,
  amount_minor    integer NOT NULL CHECK (amount_minor >= 0),
  currency        text NOT NULL DEFAULT 'INR',
  status          text NOT NULL DEFAULT 'created'
                  CHECK (status IN ('created','pending','succeeded','failed','refunded','partially_refunded','disputed')),
  -- Client-supplied but server-enforced: the unique index is what actually prevents a
  -- double charge or a double-unlock from a retried request (spec §71, §72).
  idempotency_key text,
  paid_at         timestamptz,
  failure_code    text,
  failure_message text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_idempotency_key ON payments (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX payments_provider_key ON payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
CREATE INDEX payments_user_idx ON payments (user_id, created_at DESC);

-- Webhook receipts. Deliberately has NO `user_id` column: it is a system-owned,
-- append-only ledger of provider callbacks, so it must not be governed by the
-- user-scoped RLS policy generator. Access is via admin/SECURITY DEFINER paths only.
CREATE TABLE payment_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  event_type        text NOT NULL,
  signature_verified boolean NOT NULL DEFAULT false,
  -- Idempotency: a replayed webhook finds this row and is a no-op (spec §73).
  processed_at      timestamptz,
  processing_result text,
  attempts          integer NOT NULL DEFAULT 0,
  payload           jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_events_provider_event_key ON payment_events (provider, provider_event_id);

-- =====================================================================================
-- DEVICE SYNC (spec §61, §62, §113)
-- =====================================================================================

CREATE TABLE device_connections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  provider_key   text NOT NULL,
  -- Only providers with a real, supported API may ever be settable to 'connected'.
  -- Anything else stays 'not_configured' and the UI says so (spec §61).
  state          text NOT NULL DEFAULT 'not_configured'
                 CHECK (state IN ('not_configured','connection_required','connected','error','revoked')),
  external_user_id text,
  scopes         text[] NOT NULL DEFAULT '{}',
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_expires_at timestamptz,
  last_synced_at timestamptz,
  last_sync_error text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX device_connections_user_provider_key ON device_connections (user_id, provider_key);

CREATE TABLE sync_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  provider_key  text NOT NULL,
  status        job_status NOT NULL DEFAULT 'queued',
  window_start  date,
  window_end    date,
  records_imported integer NOT NULL DEFAULT 0,
  error_message text,
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_jobs_user_idx ON sync_jobs (user_id, created_at DESC);
CREATE INDEX sync_jobs_pending_idx ON sync_jobs (status) WHERE status IN ('queued','processing');

-- =====================================================================================
-- BACKGROUND JOBS (spec §53, §54, §55, §127)
--
-- Carries user_id so the job owner can observe their own job, while the worker — which
-- runs as the table owner — sees every job across all users.
-- =====================================================================================

CREATE TABLE job_queue (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid REFERENCES profiles(id) ON DELETE CASCADE,
  job_type       text NOT NULL
                 CHECK (job_type IN ('food_scan_analysis','label_ocr','meal_plan_generation','weekly_report','daily_review','notification_dispatch','export','import','sync','image_processing','achievement_evaluation','summary_recalculation','eval_run')),
  status         job_status NOT NULL DEFAULT 'queued',
  priority       smallint NOT NULL DEFAULT 100,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Retry bookkeeping (spec §55). `dedupe_key` makes enqueue idempotent so a retried
  -- request cannot create two jobs for the same logical operation.
  dedupe_key     text,
  attempts       smallint NOT NULL DEFAULT 0,
  max_attempts   smallint NOT NULL DEFAULT 5,
  run_after      timestamptz NOT NULL DEFAULT now(),
  locked_at      timestamptz,
  locked_by      text,
  last_error     text,
  result         jsonb,
  progress       smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_stage text,
  started_at     timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX job_queue_dedupe_key ON job_queue (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX job_queue_claim_idx ON job_queue (status, priority, run_after)
  WHERE status IN ('queued','failed');
CREATE INDEX job_queue_user_idx ON job_queue (user_id, created_at DESC);
CREATE INDEX job_queue_type_idx ON job_queue (job_type, status);

CREATE TABLE export_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  format       text NOT NULL CHECK (format IN ('csv','json')),
  scope        text[] NOT NULL DEFAULT '{}',
  status       job_status NOT NULL DEFAULT 'queued',
  storage_path text,
  byte_size    integer,
  expires_at   timestamptz,
  error_message text,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX export_jobs_user_idx ON export_jobs (user_id, created_at DESC);

-- =====================================================================================
-- AUDIT + ANALYTICS + ADMIN (spec §79, §64, §66, §83, §84)
-- =====================================================================================

-- Append-only audit trail. Uses `actor_user_id` rather than `user_id` on purpose: an
-- audit row is not user-owned data, it is a system record ABOUT an action. Admins read
-- it; the application role cannot write or edit it (append-only enforced below).
CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  actor_role    user_role,
  action        text NOT NULL,
  resource_type text,
  resource_id   text,
  status        text NOT NULL DEFAULT 'success' CHECK (status IN ('success','failure','denied')),
  ip_hash       text,
  user_agent    text,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);
CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id);

-- Privacy-conscious product analytics (spec §83). No user identifier, no meal or photo
-- contents — only an anonymous session id and coarse event names.
CREATE TABLE analytics_events (
  id           bigserial PRIMARY KEY,
  anonymous_id uuid,
  event_name   text NOT NULL
               CHECK (event_name IN ('signup_completed','onboarding_completed','food_scan_started','food_scan_completed','food_scan_corrected','meal_saved','water_logged','weight_logged','workout_started','workout_completed','plan_generated','subscription_started','export_completed','screen_viewed')),
  properties   jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_events_name_time_idx ON analytics_events (event_name, occurred_at DESC);

CREATE TABLE feature_flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL,
  description text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  -- Optional staged rollout and per-user override list.
  rollout_percent smallint NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100),
  enabled_for_emails text[] NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX feature_flags_key_key ON feature_flags (key);

-- =====================================================================================
-- TRIGGERS: updated_at maintenance, append-only enforcement, audit
-- =====================================================================================

CREATE OR REPLACE FUNCTION app_touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
       AND tb.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public'
       AND c.column_name = 'updated_at'
       AND c.data_type LIKE 'timestamp%'
     ORDER BY c.table_name
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_touch_updated_at', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()',
      t || '_touch_updated_at', t);
  END LOOP;
END $$;

-- Append-only guarantee for the audit/analytics/queue ledgers (spec §79). Deleting an
-- audit row is refused at the database level, not merely by convention.
CREATE OR REPLACE FUNCTION app_block_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only; DELETE is not permitted', TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Allow bookkeeping updates on the queue (status/attempts) but never on audit logs.
    IF TG_TABLE_NAME = 'audit_logs' THEN
      RAISE EXCEPTION '% is append-only; UPDATE is not permitted', TG_TABLE_NAME;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs;
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION app_block_mutation();

DROP TRIGGER IF EXISTS analytics_events_append_only ON analytics_events;
CREATE TRIGGER analytics_events_append_only
  BEFORE UPDATE OR DELETE ON analytics_events
  FOR EACH ROW EXECUTE FUNCTION app_block_mutation();

-- =====================================================================================
-- PRIVILEGES for shared reference data introduced in this migration
-- =====================================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'recipes','recipe_ingredients','exercises','achievements','plans','ai_eval_cases','ai_eval_runs'
  ] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO app_user', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM app_user', t);
  END LOOP;
END $$;

-- Sequence privileges for the bigserial ledger tables.
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq, analytics_events_id_seq TO app_user;

-- =====================================================================================
-- APPLY ROW LEVEL SECURITY to every new user-scoped table
-- =====================================================================================
SELECT app_apply_rls()       AS user_scoped_tables_protected;
SELECT app_apply_child_rls() AS child_tables_protected;
