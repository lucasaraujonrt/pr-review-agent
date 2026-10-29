import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export interface ReviewJob {
  repo: string;
  number: number;
  headSha: string;
  baseRef: string;
  title: string;
  body: string;
}

const ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

/** Returns the job to review, or why the event is ignored. */
export function jobFromEvent(event: string | undefined, payload: any, repos: string[]): ReviewJob | { skip: string } {
  if (event !== 'pull_request') return { skip: `event ${event}` };
  if (!ACTIONS.has(payload?.action)) return { skip: `action ${payload?.action}` };
  const pr = payload.pull_request;
  const repo = String(payload.repository?.full_name ?? '').toLowerCase();
  if (!repos.includes(repo)) return { skip: `repo ${repo} not allowed` };
  if (pr?.draft) return { skip: 'draft' };
  if (pr?.head?.repo?.full_name?.toLowerCase() !== repo) return { skip: 'fork PR' };
  return {
    repo,
    number: pr.number,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    title: pr.title ?? '',
    body: pr.body ?? '',
  };
}
