import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { loadConfig } from './config.js';
import { ReviewQueue } from './queue.js';
import { buildPrompt, formatComment } from './review.js';
import { createApp } from './server.js';
import { jobFromEvent, verifySignature, type ReviewJob } from './webhook.js';

const SECRET = 's3cr3t';
const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
const REPOS = ['acme/app'];

function payload(over: Record<string, unknown> = {}) {
  return {
    action: 'opened',
    repository: { full_name: 'acme/app' },
    pull_request: {
      number: 7,
      draft: false,
      title: 'fix: x',
      body: 'body',
      head: { sha: 'abcdef1234567890', repo: { full_name: 'acme/app' } },
      base: { ref: 'main' },
    },
    ...over,
  };
}

test('signature: accepts the right one, rejects wrong, missing and wrong-length', () => {
  assert.equal(verifySignature(SECRET, 'x', sign('x')), true);
  assert.equal(verifySignature(SECRET, 'x', sign('y')), false);
  assert.equal(verifySignature(SECRET, 'x', undefined), false);
  assert.equal(verifySignature(SECRET, 'x', 'sha256=00'), false);
});

test('event: only opened/updated pull_request, not draft, not fork, only allowed repos', () => {
  assert.equal((jobFromEvent('pull_request', payload(), REPOS) as ReviewJob).headSha, 'abcdef1234567890');
  assert.deepEqual(jobFromEvent('push', payload(), REPOS), { skip: 'event push' });
  assert.deepEqual(jobFromEvent('pull_request', payload({ action: 'closed' }), REPOS), { skip: 'action closed' });
  assert.ok('skip' in jobFromEvent('pull_request', payload({ repository: { full_name: 'other/repo' } }), REPOS));
  const draft = payload();
  (draft.pull_request as any).draft = true;
  assert.deepEqual(jobFromEvent('pull_request', draft, REPOS), { skip: 'draft' });
  const fork = payload();
  (fork.pull_request as any).head.repo.full_name = 'stranger/app';
  assert.deepEqual(jobFromEvent('pull_request', fork, REPOS), { skip: 'fork PR' });
});

test('queue: the same HEAD is reviewed only once', async () => {
  const done: string[] = [];
  const q = new ReviewQueue<string>(async (j) => void done.push(j));
  assert.equal(q.push('a@1', 'a'), true);
  assert.equal(q.push('a@1', 'a'), false);
  assert.equal(q.push('a@2', 'b'), true);
  await q.idle();
  assert.deepEqual(done, ['a', 'b']);
});

test('queue: a failing job does not stop the next ones', async () => {
  const done: string[] = [];
  const q = new ReviewQueue<string>(async (j) => {
    if (j === 'bad') throw new Error('failed');
    done.push(j);
  });
  q.push('1', 'bad');
  q.push('2', 'good');
  await q.idle();
  assert.deepEqual(done, ['good']);
});

test('webhook: 401 without signature, 202 queued, redelivery not queued again', async () => {
  const jobs: ReviewJob[] = [];
  const queue = new ReviewQueue<ReviewJob>(async (j) => void jobs.push(j));
  const app = createApp({ webhookSecret: SECRET, repos: REPOS, queue });
  const body = JSON.stringify(payload());
  const post = (sig?: string) =>
    app.request('/webhook', { method: 'POST', body, headers: { 'x-github-event': 'pull_request', ...(sig ? { 'x-hub-signature-256': sig } : {}) } });
  assert.equal((await post()).status, 401);
  const first = await post(sign(body));
  assert.equal(first.status, 202);
  assert.equal(((await first.json()) as any).queued, true);
  assert.equal(((await (await post(sign(body))).json()) as any).queued, false);
  await queue.idle();
  assert.equal(jobs.length, 1);
});

test('comment: own prefix, never an approval marker', () => {
  const c = formatComment({ approved: true, summary: 'ok', findings: [], costUsd: 0.12 }, 'abcdef1234567890');
  assert.ok(c.startsWith('[pr-reviewer] '));
  assert.ok(!c.includes('[code-review]'));
  assert.ok(!c.includes('APPROVED'));
});

test('comment: table with escaped pipe', () => {
  const c = formatComment(
    { approved: false, summary: 's', findings: [{ severity: 'high', file: 'a.ts', line: 3, problem: 'x | y' }], costUsd: 0 },
    'abcdef1234567890',
  );
  assert.ok(c.includes('`a.ts:3`'));
  assert.ok(c.includes('x \\| y'));
});

test('prompt: a large diff is never silently cut, it becomes a file list', () => {
  const job = jobFromEvent('pull_request', payload(), REPOS) as ReviewJob;
  const big = `diff --git a/src/x.ts b/src/x.ts\n${'+a\n'.repeat(80_000)}`;
  const p = buildPrompt(job, big);
  assert.ok(p.includes("didn't fit"));
  assert.ok(p.includes('src/x.ts'));
  assert.ok(!p.includes('+a\n+a\n+a\n+a'));
});

test('config: secrets and repos required, status off by default', () => {
  assert.throws(() => loadConfig({}), /GITHUB_WEBHOOK_SECRET/);
  assert.throws(() => loadConfig({ GITHUB_WEBHOOK_SECRET: 'a', GITHUB_TOKEN: 'b', ANTHROPIC_API_KEY: 'c' }), /REVIEW_REPOS/);
  const c = loadConfig({ GITHUB_WEBHOOK_SECRET: 'a', GITHUB_TOKEN: 'b', ANTHROPIC_API_KEY: 'c', REVIEW_REPOS: ' Acme/App , acme/api ' });
  assert.equal(c.setStatus, false);
  assert.deepEqual(c.repos, ['acme/app', 'acme/api']);
  assert.equal(c.model, 'claude-sonnet-5-5');
});
