import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';

export const tempDirectory = () => {
  const path = mkdtempSync(join(tmpdir(), 'pi-router-test-'));
  onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
