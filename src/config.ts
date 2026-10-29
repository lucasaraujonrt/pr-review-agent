export interface Config {
  port: number;
  webhookSecret: string;
  githubToken: string;
  anthropicApiKey: string;
  /** Accepted "owner/repo" names; webhooks from any other repo are ignored. */
  repos: string[];
  model: string;
  workDir: string;
  maxTurns: number;
  /** Project context appended to the reviewer prompt (stack, conventions, what matters). */
  instructions: string;
  /** Off by default: the comment is posted, but no check blocks the PR. */
  setStatus: boolean;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function int(name: string, raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`Invalid ${name}: "${raw}" (integer >= ${min}).`);
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: int('PORT', env.PORT, 3000, 1),
    webhookSecret: required(env, 'GITHUB_WEBHOOK_SECRET'),
    githubToken: required(env, 'GITHUB_TOKEN'),
    anthropicApiKey: required(env, 'ANTHROPIC_API_KEY'),
    repos: required(env, 'REVIEW_REPOS')
      .split(',')
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean),
    model: env.REVIEW_MODEL?.trim() || 'claude-sonnet-5-5',
    workDir: env.WORK_DIR?.trim() || '/tmp/pr-reviewer',
    maxTurns: int('REVIEW_MAX_TURNS', env.REVIEW_MAX_TURNS, 40, 1),
    instructions: env.REVIEW_INSTRUCTIONS?.trim() ?? '',
    // Safe by default: only exactly "on" enables it.
    setStatus: env.REVIEW_SET_STATUS === 'on',
  };
}
