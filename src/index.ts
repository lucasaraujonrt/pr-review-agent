import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { GitHub } from './github.js';
import { ReviewQueue } from './queue.js';
import { formatComment, review } from './review.js';
import { createApp } from './server.js';
import type { ReviewJob } from './webhook.js';

const config = loadConfig();
const gh = new GitHub(config.githubToken);

async function handle(job: ReviewJob): Promise<void> {
  const tag = `${job.repo}#${job.number}@${job.headSha.slice(0, 8)}`;
  // A new push landed while this job waited in the queue: this HEAD no longer matters.
  if ((await gh.headSha(job.repo, job.number)) !== job.headSha) {
    console.log(`[pr-reviewer] ${tag}: HEAD moved, skipping`);
    return;
  }
  if (config.setStatus) await gh.status(job.repo, job.headSha, 'pending', 'Reviewing');
  const { dir, cleanup } = await gh.checkout(job.repo, job.headSha, config.workDir);
  try {
    const diff = await gh.diff(job.repo, job.number);
    const result = await review(job, diff, {
      cwd: dir,
      model: config.model,
      maxTurns: config.maxTurns,
      apiKey: config.anthropicApiKey,
      instructions: config.instructions,
    });
    await gh.comment(job.repo, job.number, formatComment(result, job.headSha));
    if (config.setStatus) {
      const n = result.findings.filter((f) => f.severity !== 'low').length;
      await gh.status(job.repo, job.headSha, result.approved ? 'success' : 'failure', result.approved ? 'No medium or high findings' : `${n} medium/high finding(s)`);
    }
    console.log(`[pr-reviewer] ${tag}: ${result.findings.length} finding(s), US$ ${result.costUsd.toFixed(3)}`);
  } catch (error) {
    if (config.setStatus) await gh.status(job.repo, job.headSha, 'error', 'Reviewer failed; see logs').catch(() => {});
    throw error;
  } finally {
    await cleanup();
  }
}

const queue = new ReviewQueue<ReviewJob>(handle);
const app = createApp({ webhookSecret: config.webhookSecret, repos: config.repos, queue });
const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`[pr-reviewer] http://0.0.0.0:${info.port} · ${config.model} · repos ${config.repos.join(', ')} · status ${config.setStatus ? 'on' : 'off'}`);
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[pr-reviewer] ${signal}: shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
