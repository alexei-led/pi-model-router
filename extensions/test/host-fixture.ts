import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RawRouterConfig } from '../types';
import { tempDirectory } from './temp-directory';

export const hostFixture = (
  config: RawRouterConfig,
  model: string,
  extensions: string[] = [],
) => {
  const cwd = tempDirectory();
  const agentDir = join(cwd, 'agent');
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, 'model-router.json'), JSON.stringify(config));
  return {
    cwd,
    run: (args: string[], input?: string, timeout = 15_000) =>
      spawnSync(
        process.execPath,
        [
          resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-themes',
          '--no-context-files',
          '--no-session',
          ...['extensions/index.ts', ...extensions].flatMap((path) => [
            '--extension',
            resolve(path),
          ]),
          '--model',
          model,
          ...args,
        ],
        {
          cwd,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: cwd,
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: '1',
          },
          ...(input === undefined ? {} : { input }),
          encoding: 'utf8',
          timeout,
        },
      ),
  };
};
