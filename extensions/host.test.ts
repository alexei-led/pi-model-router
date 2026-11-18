import assert from 'node:assert/strict';
import { test } from 'vitest';
import { hostFixture } from './test/host-fixture';

const views = ['usage', 'settings', 'status', ''] as const;
const expected = [
  /Retained active-branch history: 0/u,
  /Router \/ offline/u,
  /Router on\nProfile/u,
  /Router \/ offline/u,
];

test.each(['print', 'json', 'rpc'] as const)(
  'Pi %s loads the router and exposes all command views without inference',
  { timeout: 20_000 },
  (mode) => {
    const fixture = hostFixture(
      { profiles: { offline: { medium: { model: 'openai/gpt-6.2-sol' } } } },
      'router/offline',
    );
    const commands = views.map((view) => `/router ${view}`);
    const result = fixture.run(
      mode === 'rpc'
        ? ['--mode', 'rpc']
        : [
            mode === 'print' ? '--print' : '--mode',
            ...(mode === 'json' ? ['json'] : []),
            ...commands,
          ],
      mode === 'rpc'
        ? `${[
            { id: 'state', type: 'get_state' },
            ...commands.map((message, index) => ({
              id: `view-${index}`,
              type: 'prompt',
              message,
            })),
          ]
            .map((command) => JSON.stringify(command))
            .join('\n')}\n`
        : undefined,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Failed to load extension|Error:/u);
    if (mode === 'print') {
      assert.equal(result.stdout, '');
      for (const pattern of expected) assert.match(result.stderr, pattern);
      assert.equal(result.stderr.match(/Router \/ offline/gu)?.length, 3);
      return;
    }
    const entries: Record<string, unknown>[] = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      entries.some((entry) => entry.type === 'agent_start'),
      false,
    );
    if (mode === 'rpc') {
      const state = entries.find((entry) => entry.id === 'state');
      assert.equal(state?.success, true);
      assert.deepEqual(
        entries
          .filter(
            (entry) =>
              typeof entry.id === 'string' && entry.id.startsWith('view-'),
          )
          .map((entry) => [entry.id, entry.success])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        views.map((_view, index) => [`view-${index}`, true]),
      );
      const data = state?.data;
      assert.ok(data && typeof data === 'object' && 'model' in data);
      const model = data.model;
      assert.ok(
        model &&
          typeof model === 'object' &&
          'provider' in model &&
          'id' in model,
      );
      assert.equal(model.provider, 'router');
      assert.equal(model.id, 'offline');
      const notices = entries.filter(
        (entry) =>
          entry.type === 'extension_ui_request' && entry.method === 'notify',
      );
      const text = notices.map((entry) => entry.message).join('\n');
      for (const pattern of expected) assert.match(text, pattern);
      assert.equal(text.match(/Router \/ offline/gu)?.length, 3);
      return;
    }
    const messages = entries
      .filter((entry) => entry.type === 'message_end')
      .map((entry) => entry.message);
    assert.equal(messages.length, views.length);
    for (const [index, message] of messages.entries()) {
      assert.ok(
        message &&
          typeof message === 'object' &&
          'customType' in message &&
          'content' in message,
      );
      assert.equal(
        message.customType,
        views[index] === 'status' ? 'router-status' : 'router-inspector',
      );
      assert.equal(typeof message.content, 'string');
      const pattern = expected[index];
      assert.ok(pattern);
      assert.match(String(message.content), pattern);
    }
  },
);
