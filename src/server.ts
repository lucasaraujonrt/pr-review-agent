import { Hono } from 'hono';
import type { ReviewQueue } from './queue.js';
import { jobFromEvent, verifySignature, type ReviewJob } from './webhook.js';

export function createApp(opts: { webhookSecret: string; repos: string[]; queue: ReviewQueue<ReviewJob> }) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Answers fast (GitHub gives up after 10 s) and reviews in the background.
  app.post('/webhook', async (c) => {
    const body = await c.req.text();
    if (!verifySignature(opts.webhookSecret, body, c.req.header('x-hub-signature-256'))) {
      return c.json({ error: 'invalid signature' }, 401);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const job = jobFromEvent(c.req.header('x-github-event'), payload, opts.repos);
    if ('skip' in job) return c.json({ skipped: job.skip });
    const queued = opts.queue.push(`${job.repo}@${job.headSha}`, job);
    return c.json({ queued, pr: job.number, sha: job.headSha.slice(0, 8) }, 202);
  });

  return app;
}
