import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ReviewJob } from './webhook.js';

export interface Finding {
  severity: 'low' | 'medium' | 'high';
  file?: string;
  line?: number;
  problem: string;
  fix?: string;
}

export interface ReviewResult {
  approved: boolean;
  summary: string;
  findings: Finding[];
  costUsd: number;
}

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'problem'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'findings'],
  additionalProperties: false,
} as const;

/** Diffs larger than this don't go in the prompt; the reviewer reads the files in the checkout instead. */
const MAX_DIFF_CHARS = 150_000;

const SYSTEM = `You review pull requests for this repository. The PR checkout is the current directory; use Read, Grep and Glob to read the code around the diff.
Answer these 6 questions about the diff:
1) What unexpected input breaks this?
2) Can any state end up false or inconsistent?
3) Are the gate, permission or flag right?
4) Race condition or double execution?
5) Security issue or data leak?
6) Would the tests fail if the code were wrong?
Report only real findings, with file and line. Severity: high = bug or production risk; medium = likely bug, or a test that doesn't protect; low = improvement. Problems in code the PR didn't touch are not findings.
Be direct. The summary is at most 3 sentences.`;

export function buildPrompt(job: ReviewJob, diff: string): string {
  const fits = diff.length <= MAX_DIFF_CHARS;
  const files = [...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
  return [
    `PR #${job.number} in ${job.repo} (base ${job.baseRef}): ${job.title}`,
    `PR description:\n${job.body || '(empty)'}`,
    fits
      ? `Full diff:\n${diff}`
      : `The diff has ${diff.length} characters and didn't fit here. Changed files (read each one in the checkout):\n${files.join('\n')}`,
  ].join('\n\n');
}

export async function review(
  job: ReviewJob,
  diff: string,
  opts: { cwd: string; model: string; maxTurns: number; apiKey: string; instructions?: string },
): Promise<ReviewResult> {
  const messages = query({
    prompt: buildPrompt(job, diff),
    options: {
      cwd: opts.cwd,
      model: opts.model,
      maxTurns: opts.maxTurns,
      systemPrompt: opts.instructions ? `${SYSTEM}\n\nProject context:\n${opts.instructions}` : SYSTEM,
      // Read-only: every other tool leaves the context and any other call is denied.
      permissionMode: 'dontAsk',
      allowedTools: ['Read', 'Grep', 'Glob'],
      disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
      settingSources: [],
      outputFormat: { type: 'json_schema', schema: REVIEW_SCHEMA },
      // Minimal environment: the agent process never sees the GitHub token or the webhook secret.
      env: { ANTHROPIC_API_KEY: opts.apiKey, PATH: process.env.PATH, HOME: process.env.HOME },
    },
  });

  for await (const message of messages) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success') {
      throw new Error(`review ended with ${message.subtype}: ${message.errors.join('; ')}`);
    }
    const out = message.structured_output as { summary: string; findings: Finding[] } | undefined;
    if (!out || !Array.isArray(out.findings)) throw new Error('review returned no structured output');
    return {
      approved: !out.findings.some((f) => f.severity !== 'low'),
      summary: out.summary,
      findings: out.findings,
      costUsd: message.total_cost_usd,
    };
  }
  throw new Error('review ended without a result message');
}

const LABEL = { high: '🔴 high', medium: '🟠 medium', low: '⚪ low' } as const;

/** Own prefix and no "APPROVED": the comment informs, it never acts as an approval for any gate. */
export function formatComment(result: ReviewResult, sha: string): string {
  const verdict = result.approved ? 'no medium or high findings' : 'has medium or high findings';
  const lines = [`[pr-reviewer] ${verdict} · HEAD ${sha.slice(0, 8)}`, '', result.summary];
  if (result.findings.length) {
    lines.push('', '| Severity | Where | Problem | Fix |', '|---|---|---|---|');
    for (const f of result.findings) {
      const where = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '—';
      const cell = (s?: string) => (s ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(`| ${LABEL[f.severity]} | ${where} | ${cell(f.problem)} | ${cell(f.fix)} |`);
    }
  }
  lines.push('', `<sub>Estimated cost: US$ ${result.costUsd.toFixed(3)}</sub>`);
  return lines.join('\n');
}
