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
    const packageName = '@alexeiled/pi-model-router';
    const packed: unknown = JSON.parse(output);
    // npm 12 keys the report by package name. Older versions return an array.
    const archive: unknown = Array.isArray(packed)
      ? packed[0]
      : packed && typeof packed === 'object' && packageName in packed
        ? packed[packageName]
        : undefined;
    if (
      !archive ||
      typeof archive !== 'object' ||
      !('files' in archive) ||
      !Array.isArray(archive.files)
    )
      throw new Error('npm pack did not report the package files');
    const paths = (archive.files as unknown[]).map((file) => {
      if (
        !file ||
        typeof file !== 'object' ||
        !('path' in file) ||
        typeof file.path !== 'string'
      )
        throw new Error('npm pack returned an invalid file entry');
      return file.path;
    });

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
