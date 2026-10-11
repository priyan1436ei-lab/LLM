import Link from 'next/link';

import { capabilityReport } from '@/lib/capabilities';

/**
 * Public landing page (spec §125).
 *
 * Shows what the deployment can actually do. Capabilities that are not configured are
 * labelled as such on the public page too — the product does not advertise a feature it
 * cannot deliver (spec §136).
 */

export const dynamic = 'force-dynamic';

export default function HomePage() {
  const report = capabilityReport();
  const available = new Set(report.available);

  const features: { title: string; body: string; capability?: string }[] = [
    {
      title: 'Photo food logging',
      body: 'Photograph a plate, review what the AI identified, correct the portion, and save. Nutrition comes from a stored reference, not a guess.',
      capability: 'ai_food_vision',
    },
    {
      title: 'Indian food, done properly',
      body: 'Idli, dosa, sambar, kootu, poriyal, payasam and hundreds more, with regional aliases so search finds what you actually call it.',
    },
    {
      title: 'Barcode scanning',
      body: 'Scan a packaged product to pull its label values straight into your diary.',
      capability: 'barcode_scanner',
    },
    {
      title: 'Nutrition label OCR',
      body: 'Photograph a nutrition panel and confirm the extracted values before they are saved.',
      capability: 'nutrition_label_ocr',
    },
    {
      title: 'Text and voice logging',
      body: 'Type or say "two idli, one cup sambar and a boiled egg" and confirm the parsed items.',
      capability: 'ai_llm',
    },
    {
      title: 'Real-time dashboard',
      body: 'Calories, macros, water and training update as you log — on every device you have open.',
    },
    {
      title: 'Workouts and progress',
      body: 'Exercise library, live session logging, personal records, weight and measurement trends.',
    },
    {
      title: 'AI coach',
      body: 'Answers drawn from your own logged data, never from another account.',
      capability: 'ai_llm',
    },
  ];

  const unavailable = features.filter((f) => f.capability && !available.has(f.capability));

  return (
    <main id="main" className="mx-auto max-w-6xl px-6 py-16">
      <header className="mb-14">
        <p className="pill accent-cyan mb-5">Real database · Real transactions · Honest states</p>
        <h1 className="text-balance text-4xl font-semibold tracking-tight text-mist-100 sm:text-6xl">
          Know what you ate,
          <span className="accent-lime"> without the guesswork.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-mist-300">
          FITTRACK AI identifies your food from a photo, then reads the nutrition from a real
          reference database. Every estimate is labelled as an estimate, and anything it cannot
          resolve is stated plainly instead of being filled in with invented numbers.
        </p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Link
            href="/dashboard"
            className="rounded-xl bg-neon-lime px-6 py-3 text-sm font-semibold text-graphite-950 transition hover:brightness-110"
          >
            Open the dashboard
          </Link>
          <Link
            href="/api/health"
            className="glass rounded-xl px-6 py-3 text-sm font-semibold text-mist-100 transition hover:bg-white/10"
          >
            System status
          </Link>
        </div>
      </header>

      {unavailable.length > 0 && (
        <section
          aria-labelledby="not-configured-heading"
          className="glass mb-10 border-neon-amber/30 p-6"
        >
          <h2 id="not-configured-heading" className="text-sm font-semibold text-neon-amber">
            Not configured on this deployment
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-mist-300">
            These features have the real integration built, but no provider credentials are set
            here. They will report &ldquo;Not configured&rdquo; rather than returning fabricated
            results. Configure the relevant environment variables to enable them.
          </p>
          <ul className="mt-4 space-y-2">
            {unavailable.map((feature) => (
              <li key={feature.title} className="text-sm text-mist-300">
                <span className="text-mist-100">{feature.title}</span>
                {' — '}
                {report.capabilities.find((c) => c.key === feature.capability)?.reason}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="features-heading">
        <h2 id="features-heading" className="sr-only">
          Features
        </h2>
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => {
            const isAvailable = !feature.capability || available.has(feature.capability);
            return (
              <li key={feature.title} className="glass p-6">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-base font-semibold text-mist-100">{feature.title}</h3>
                  <span
                    className={`pill shrink-0 ${isAvailable ? 'accent-lime' : 'text-neon-amber'}`}
                  >
                    {isAvailable ? 'Ready' : 'Not configured'}
                  </span>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-mist-500">{feature.body}</p>
              </li>
            );
          })}
        </ul>
      </section>

      <footer className="mt-16 border-t border-white/10 pt-8 text-sm text-mist-600">
        <p>
          Nutrition reference data is attributed to its published source. Portion sizes from photos
          are estimates and are always labelled as such.
        </p>
      </footer>
    </main>
  );
}
