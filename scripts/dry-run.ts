// Usage: tsx scripts/dry-run.ts <owner/repo> <number>
// Reviews a PR locally and prints the comment, posting nothing to GitHub.
// Without ANTHROPIC_API_KEY, the SDK's binary uses your local Claude Code login.
import { execFileSync } from 'node:child_process';
import { GitHub } from '../src/github.js';
import { formatComment, review } from '../src/review.js';

const [repo, num] = process.argv.slice(2);
if (!repo || !num) throw new Error('Usage: tsx scripts/dry-run.ts <owner/repo> <number>');
const token = process.env.GITHUB_TOKEN || execFileSync('gh', ['auth', 'token']).toString().trim();
const gh = new GitHub(token);
const pr = (await (await fetch(`https://api.github.com/repos/${repo}/pulls/${num}`, { headers: { Authorization: `Bearer ${token}` } })).json()) as any;
const job = { repo, number: Number(num), headSha: pr.head.sha, baseRef: pr.base.ref, title: pr.title, body: pr.body ?? '' };
const { dir, cleanup } = await gh.checkout(repo, job.headSha, process.env.TMPDIR ?? '/tmp');
try {
  const diff = await gh.diff(repo, job.number);
  const result = await review(job, diff, { cwd: dir, model: process.env.REVIEW_MODEL || 'claude-sonnet-5-5', maxTurns: 40, apiKey: process.env.ANTHROPIC_API_KEY ?? '', instructions: process.env.REVIEW_INSTRUCTIONS });
  console.log(formatComment(result, job.headSha));
} finally {
  await cleanup();
}
