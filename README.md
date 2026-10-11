# FITTRACK AI

A real-time, AI-assisted fitness and nutrition website: photograph a meal, confirm what the
AI identified, and watch your nutrition, water and training update live.

**The governing principle: no invented numbers.** The vision model only *identifies* food.
Every calorie, macro and micronutrient value comes from a stored reference row with an
attributed source, or the result is explicitly labelled unavailable. When an integration has
no credentials, it reports `Not configured` instead of returning fabricated data.

---

## Current status

This is an in-progress build. What exists is real and verified; what does not exist yet is
listed plainly rather than implied to work.

### Implemented and verified

| Area | State | Evidence |
|---|---|---|
| Database schema | 69 tables, 41 user-scoped | `npm run db:status` → RLS audit PASS |
| Migrations | 2 versioned migrations, checksum drift detection | `npm run db:migrate` |
| Row-level security | Enforced via `FORCE ROW LEVEL SECURITY` | 12 isolation tests |
| Nutrition engine | Deterministic, no LLM in arithmetic | 28 tests |
| Unit / serving engine | Fails loudly rather than guessing | 21 tests |
| Food reference data | 110 foods (95 Indian), 283 servings, 628 aliases | `npm run db:audit` → PASS |
| Exercise library | 90 exercises, 9 categories, 23 with verified METs | `npm run db:audit` |
| Meal logging | Transactional, idempotent, recomputes summaries | 10 tests |
| Scan pipeline | Real pipeline, honest unconfigured state | 7 tests |
| AI adapters | Real HTTP integration, schema-validated | typechecked |
| Realtime event bus | Commit-safe publication, per-user isolation | covered in meal tests |
| Auth crypto | scrypt (N=2^17), token rotation support | typechecked |
| Health endpoint | Reports genuine DB/queue/integration state | verified over HTTP |
| Production build | Passes | `npx next build` |

### Not yet built

These are specified in the brief and **not** yet implemented. Stating this plainly is part of
the product's contract with its user:

- **UI**: only the landing page and health endpoint exist. The dashboard, scan review screen,
  nutrition diary, workout screens, progress charts, admin area and settings are not built.
- **HTTP API surface**: services are implemented and tested, but the route handlers that
  expose them (auth, meals, scans, water, weight, workouts, coach, billing) are not.
- **Background worker**: the job queue table and retry semantics exist; no worker process
  drains it yet, so scanning is currently synchronous.
- **Payments**: entitlement model, idempotent webhook receipt table and provider seams exist;
  no provider integration or checkout flow.
- **AI coach / meal planner**: provider adapter and context design exist; the feature flows
  are not implemented.
- **PWA, push notifications, CSV/JSON export, public SEO food pages, admin tooling**: not started.
- **E2E browser tests**: not written (unit and integration tests only).

### Substrate decision (important)

No PostgreSQL server, Docker, or package manager exists on this machine, and installing one
requires interactive credentials this build could not supply. The app therefore runs on
**PGlite 0.5.8 — genuine PostgreSQL 18.3 compiled to WebAssembly**, not an emulation.

Verified against this exact engine: real transactions and `ROLLBACK`, real `FORCE`d RLS
enforced under `SET ROLE`, plpgsql triggers, generated columns, partial and trigram GIN
indexes, savepoints, and full-text search.

Two constraints, both handled:

1. **PGlite is single-writer.** Two processes opening one data directory do not raise a lock
   error — writes silently vanish. Exactly one process may own a data directory. Tests are
   therefore serialised (`fileParallelism: false`), and each test file uses its own directory.
2. **`pgvector` is unavailable.** Nothing in the schema uses embedding columns. Semantic
   search will need a different substrate.

To move to a real server, set `DB_SUBSTRATE=postgres` and `DATABASE_URL`. The client refuses to
start rather than silently falling back, so the switch is always deliberate.

---

## Getting started

```bash
npm install
npm run db:migrate      # apply schema
npm run db:seed         # load reference data (idempotent)
npm run dev             # http://localhost:3000
```

Verify everything:

```bash
npm run verify          # typecheck + lint + tests + production build
npm run db:audit        # data quality audit
npm run db:status       # schema and RLS coverage
```

---

## Configuration

All configuration is server-side. **No secret is ever exposed to the browser**: nothing is
`NEXT_PUBLIC_*`, so no key can be inlined into a client bundle.

Copy `.env.example` to `.env.local`. Every value is optional in development — the app runs and
reports honestly on what is missing. In production, `productionReadinessProblems()` fails the
boot rather than serving a silently degraded system.

| Variable | Purpose | Without it |
|---|---|---|
| `DB_SUBSTRATE` | `pglite` (default) or `postgres` | Embedded real Postgres |
| `DATABASE_URL` | Required when substrate is `postgres` | Boot error |
| `SESSION_SECRET` | Keys session tokens and IP hashing | Required in production |
| `AI_VISION_PROVIDER` + `OPENAI_API_KEY` | Photo food analysis | Reports `not_configured` |
| `AI_LLM_PROVIDER` + `OPENAI_API_KEY` | Coach, text parsing, planner | Reports `not_configured` |
| `AI_STT_PROVIDER` + `OPENAI_API_KEY` | Voice logging | Reports `not_configured` |
| `NUTRITION_PROVIDER` | `local` or `openfoodfacts` | Barcode lookup limited to local products |
| `PAYMENT_PROVIDER` + keys | Subscription checkout | Checkout disabled, honestly |

`GET /api/health` reports live state for each of these.

---

## Architecture

```
Browser
  → Next.js (App Router, server components)
  → Route handlers / server actions
  → Service layer        src/db/*.ts        business rules, transactions
  → Tenant layer         src/db/tenant.ts   RLS context, audit
  → Real Postgres        69 tables, 41 with forced RLS
  → Event bus            src/lib/events.ts  per-user fan-out to open dashboards
```

### The four invariants

**1. Row-level security is the authority on data access.**
Every user-scoped query runs inside a transaction as the non-superuser role with
`app.current_user_id` set. A query that forgets a `WHERE user_id = ...` clause returns zero
rows rather than another user's data. `app_apply_rls()` discovers every table with a `user_id`
column and installs policies automatically, so a new table cannot silently miss protection. The
test suite asserts the discovered set matches the set the application believes it owns.

**2. No nutrient value originates from a language model.**
Nutrient arithmetic is pure functions in `src/lib/nutrition.ts`. There is no code path that
produces a number without a stored reference row; when the reference is missing the result is
`nutritionUnavailable` and the UI offers alternatives or manual entry.

**3. A household unit converts only when the food declares that serving.**
There is no global "1 cup = 240 ml" table, because a cup of rice and a cup of sambar weigh
different amounts. `1 cup` for a food that does not define a cup serving is a hard failure, not
a guess. Millilitres are never treated as grams.

**4. Events publish only after commit.**
`emitAfterCommit` buffers events in an `AsyncLocalStorage` scope and flushes them once the
transaction commits. A subscriber can never observe rolled-back state. Emitting outside a
transaction scope throws, so this cannot be bypassed by accident.

### Data provenance

Every nutrient value carries its source, and the UI shows it: `database_record`,
`user_entered`, `package_label`, `ai_estimate`, `recipe_calculated`, or `imported`. Portion
estimates from photos are presented as ranges ("185 g (160–210 g)") and labelled
`AI Estimated Portion` — never as measurements.

---

## Testing

78 automated tests, all against real PostgreSQL:

| Suite | Tests | Covers |
|---|---|---|
| `src/db/tenant.test.ts` | 12 | RLS isolation, forgery rejection, fail-closed, context leakage |
| `src/lib/units.test.ts` | 21 | Conversions and, critically, refused conversions |
| `src/lib/nutrition.test.ts` | 28 | Scaling, remaining nutrients, safety floors, confidence |
| `src/db/meals.test.ts` | 10 | Transaction, idempotency, recalculation, realtime |
| `src/db/scans.test.ts` | 7 | Matching, unconfigured honesty, correction capture |

The negative tests matter most: they assert that the system *refuses* to produce a number when
it has no basis for one.

```bash
npm test                       # all tests
npx vitest run src/db/tenant.test.ts   # RLS isolation only
```

---

## Data provenance notes

Nutrition values reference IFCT 2017 (Indian Food Composition Tables, NIN Hyderabad) and USDA
FoodData Central. Where no published entry exists, values are computed from ingredient rows and
the assumed preparation is stated in `preparationNote`.

MET values come from the 2011 Compendium of Physical Activities. Eleven values are attributed to
specific verified codes; the rest are documented proxies, and walking/running deliberately carry
none because those Compendium headings could not be verified. The file header lists each case.

---

## Security

- scrypt password hashing (N=2^17, r=8, p=1), constant-time verification, versioned format
- Session and reset tokens: 256-bit CSPRNG, only SHA-256 digests stored
- Forced RLS on all 41 user-scoped tables; forgery blocked by `WITH CHECK`
- Append-only audit and analytics ledgers, enforced by trigger
- Content-Security-Policy, HSTS, `X-Content-Type-Options`, Referrer-Policy, Permissions-Policy
- Private routes marked `noindex`; a skip link and visible focus states throughout
- Uploads validated by magic bytes, not by declared MIME type or filename
- EXIF stripped (food photos routinely carry GPS coordinates)
- Random storage keys; user filenames never used as identifiers

---

## Roadmap

1. Route handlers for auth, meals, scans, tracking
2. Dashboard UI (real-time, with the capability states surfaced)
3. Scan review screen with confidence badges and alternative matching
4. Background worker draining `job_queue`
5. Workout, progress and coach screens
6. Payment provider integration and checkout
7. PWA, exports, admin tooling, public SEO pages
8. End-to-end browser tests
"# LLM" 
