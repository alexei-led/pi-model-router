import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['extensions/**/*.ts'],
      exclude: ['extensions/**/*.test.ts', 'extensions/test/**'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 90,
        lines: 90,
        perFile: {
          statements: 80,
          branches: 60,
          functions: 80,
          lines: 80,
        },
        'extensions/choice.ts': {
          statements: 80,
          branches: 65,
          functions: 80,
          lines: 80,
          perFile: true,
        },
        'extensions/classifier.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
          perFile: true,
        },
        'extensions/provider*.ts': {
          statements: 80,
          branches: 70,
          functions: 80,
          lines: 80,
          perFile: true,
        },
        'extensions/routing.ts': {
          statements: 80,
          branches: 90,
          functions: 80,
          lines: 80,
          perFile: true,
        },
        'extensions/state.ts': {
          statements: 80,
          branches: 90,
          functions: 80,
          lines: 80,
          perFile: true,
        },
      },
    },
  },
});
