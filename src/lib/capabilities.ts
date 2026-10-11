/**
 * Capability model (spec §61, §68, §72, §136).
 *
 * The product spec is explicit: when a feature depends on an external API or credential
 * that is not available, build the real integration architecture and surface a truthful
 * "Not configured" / "Connection required" state — never fabricate data.
 *
 * This module is the single source of truth for "what can this deployment actually do".
 * Both server APIs and the UI read it, so an unavailable feature is never silently
 * rendered as if it worked.
 */

import { env } from './env';

export type CapabilityState = 'available' | 'not_configured' | 'unsupported';

export interface Capability {
  /** Stable machine key, safe to persist and to send to the client. */
  readonly key: string;
  /** Whether the feature can actually run right now. */
  readonly state: CapabilityState;
  /** Short user-facing explanation shown in place of the feature. */
  readonly reason: string;
  /** What an operator must configure to enable it. Never contains secret values. */
  readonly remediation?: string;
}

export interface CapabilityReport {
  readonly generatedAt: string;
  readonly substrate: string;
  readonly capabilities: readonly Capability[];
  /** Feature keys that are genuinely usable now. */
  readonly available: readonly string[];
}

function cap(
  key: string,
  state: CapabilityState,
  reason: string,
  remediation?: string,
): Capability {
  return remediation === undefined ? { key, state, reason } : { key, state, reason, remediation };
}

/** Normalise a raw state to a plain JSON-serialisable capability record. */
export function serializeCapability(c: Capability): Capability {
  return c;
}

export function capabilityReport(): CapabilityReport {
  const e = env();

  const vision: Capability =
    e.AI_VISION_PROVIDER !== 'none' && e.OPENAI_API_KEY
      ? cap('ai_food_vision', 'available', `Vision analysis enabled (${e.AI_VISION_MODEL}).`)
      : cap(
          'ai_food_vision',
          'not_configured',
          'AI photo food analysis is not configured on this deployment.',
          'Set AI_VISION_PROVIDER=openai and OPENAI_API_KEY to enable photo analysis.',
        );

  const llm: Capability =
    e.AI_LLM_PROVIDER !== 'none' && e.OPENAI_API_KEY
      ? cap('ai_llm', 'available', `Language model enabled (${e.AI_LLM_MODEL}).`)
      : cap(
          'ai_llm',
          'not_configured',
          'AI coach, text parsing and meal-plan generation are not configured.',
          'Set AI_LLM_PROVIDER=openai and OPENAI_API_KEY to enable language features.',
        );

  const stt: Capability =
    e.AI_STT_PROVIDER !== 'none' && e.OPENAI_API_KEY
      ? cap('ai_speech_to_text', 'available', `Speech-to-text enabled (${e.AI_STT_MODEL}).`)
      : cap(
          'ai_speech_to_text',
          'not_configured',
          'Voice logging is not configured on this deployment.',
          'Set AI_STT_PROVIDER=openai and OPENAI_API_KEY to enable voice logging.',
        );

  const barcode: Capability = cap(
    'barcode_scanner',
    'available',
    'Barcode scanning runs in the browser using the device camera.',
  );

  const labelOcr: Capability = cap(
    'nutrition_label_ocr',
    'available',
    'Nutrition label OCR runs locally in the browser.',
  );

  const productLookup: Capability =
    e.NUTRITION_PROVIDER === 'local'
      ? cap(
          'barcode_product_lookup',
          'not_configured',
          'Scanned barcodes can only be resolved against products already in the local database.',
          'Set NUTRITION_PROVIDER=openfoodfacts to look up packaged products online.',
        )
      : cap(
          'barcode_product_lookup',
          'available',
          `Packaged-product lookups use ${e.OPENFOODFACTS_BASE_URL}.`,
        );

  const payments: Capability =
    e.PAYMENT_PROVIDER === 'none'
      ? cap(
          'payments',
          'not_configured',
          'Subscription checkout is not configured. Plan entitlements are not for sale.',
          'Set PAYMENT_PROVIDER and its keys to enable checkout.',
        )
      : cap(
          'payments',
          'available',
          `Checkout uses the ${e.PAYMENT_PROVIDER} provider with server-side verification.`,
        );

  const push: Capability =
    e.NODE_ENV === 'production'
      ? cap('browser_push', 'available', 'Browser push reminders are available.')
      : cap(
          'browser_push',
          'unsupported',
          'Browser push requires HTTPS; it is unavailable on this origin.',
        );

  const activityProviders: Capability = cap(
    'device_activity_sync',
    'not_configured',
    'No activity provider is connected. Steps and sleep must be entered manually.',
    'Connect a provider in Settings to import activity data.',
  );

  const capabilities = [
    vision,
    llm,
    stt,
    barcode,
    labelOcr,
    productLookup,
    payments,
    push,
    activityProviders,
  ] as const;

  return {
    generatedAt: new Date().toISOString(),
    substrate: e.DB_SUBSTRATE === 'postgres' ? 'postgres' : 'pglite',
    capabilities,
    available: capabilities.filter((c) => c.state === 'available').map((c) => c.key),
  };
}

/** Look up one capability by key. */
export function capability(key: string): Capability {
  const found = capabilityReport().capabilities.find((c) => c.key === key);
  if (!found) {
    return cap(key, 'unsupported', `Unknown capability "${key}".`);
  }
  return found;
}

export function isAvailable(key: string): boolean {
  return capability(key).state === 'available';
}
