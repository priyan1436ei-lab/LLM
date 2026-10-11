// Plain JavaScript flat config. `eslint-config-next` default-exports an array of config
// objects, so it is spread directly rather than invoked.
import nextConfig from 'eslint-config-next';

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      '.data/**',
      'next-env.d.ts',
      'coverage/**',
      // The curated seed datasets are large generated-style data files; formatting and
      // linting them adds noise without catching real problems. They are type-checked.
      'src/db/seed-data/**',
    ],
  },
  ...nextConfig,
];

export default config;
