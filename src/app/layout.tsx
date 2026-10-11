import type { Metadata, Viewport } from 'next';

import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? 'http://localhost:3000'),
  title: {
    default: 'FITTRACK AI — AI food scanning, nutrition and training',
    template: '%s · FITTRACK AI',
  },
  description:
    'Photograph a meal, confirm what the AI identified, and see your calories, macros, water and training update in real time. Built around a real food database, not invented numbers.',
  applicationName: 'FITTRACK AI',
  keywords: [
    'calorie tracker',
    'Indian food nutrition',
    'AI food scanner',
    'macro tracking',
    'workout tracker',
  ],
  openGraph: {
    type: 'website',
    siteName: 'FITTRACK AI',
    title: 'FITTRACK AI — AI food scanning, nutrition and training',
    description:
      'Log food by photo, text or barcode. Nutrition comes from a real database, with every estimate clearly labelled.',
  },
  robots: {
    // The private dashboard must never be indexed (spec §125).
    index: true,
    follow: true,
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: '#07090c',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN">
      <body className="min-h-dvh antialiased">
        {/* Keyboard users must be able to skip the navigation (spec §93). */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-graphite-800 focus:px-4 focus:py-2 focus:text-mist-100"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
