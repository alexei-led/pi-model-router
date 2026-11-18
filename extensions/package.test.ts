import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('published package', () => {
  it('ships only the extension and user-facing reference files', () => {
    const output = execFileSync(
      'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      { encoding: 'utf8' },
    );
    const [archive] = JSON.parse(output) as {
      files: { path: string }[];
    }[];
    const paths = archive?.files.map((file) => file.path) ?? [];

    expect(paths).toContain('extensions/index.ts');
    expect(paths).toContain('model-router.example.json');
    expect(paths).not.toContain('package-lock.json');
    expect(paths).not.toContain('AGENTS.md');
    expect(
      paths.filter(
        (path) =>
          path.includes('node_modules/') ||
          path.startsWith('extensions/test/') ||
          path.endsWith('.test.ts'),
      ),
    ).toEqual([]);
    expect(
      paths.filter(
        (path) =>
          !path.startsWith('extensions/') &&
          ![
            'CHANGELOG.md',
            'LICENSE',
            'README.md',
            'model-router.example.json',
            'package.json',
          ].includes(path),
      ),
    ).toEqual([]);
  });

  it('declares no direct runtime dependencies', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      bundledDependencies?: string[];
    };

    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.optionalDependencies ?? {}).toEqual({});
    expect(manifest.bundledDependencies ?? []).toEqual([]);
  });
});
