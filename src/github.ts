import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const API = 'https://api.github.com';

export class GitHub {
  constructor(private readonly token: string) {}

  private async request(path: string, init: RequestInit = {}, accept = 'application/vnd.github+json'): Promise<Response> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pr-review-agent',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: ${res.status}`);
    return res;
  }

  async diff(repo: string, number: number): Promise<string> {
    return (await this.request(`/repos/${repo}/pulls/${number}`, {}, 'application/vnd.github.diff')).text();
  }

  async headSha(repo: string, number: number): Promise<string> {
    const pr = (await (await this.request(`/repos/${repo}/pulls/${number}`)).json()) as { head: { sha: string } };
    return pr.head.sha;
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    await this.request(`/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  }

  async status(repo: string, sha: string, state: 'pending' | 'success' | 'failure' | 'error', description: string): Promise<void> {
    await this.request(`/repos/${repo}/statuses/${sha}`, {
      method: 'POST',
      body: JSON.stringify({ state, context: 'pr-reviewer', description: description.slice(0, 140) }),
    });
  }

  /** Shallow checkout of the PR commit into a temp dir. The token goes in a header, never in the URL or logs. */
  async checkout(repo: string, sha: string, workDir: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    await run('mkdir', ['-p', workDir]);
    const dir = await mkdtemp(join(workDir, 'pr-'));
    const auth = Buffer.from(`x-access-token:${this.token}`).toString('base64');
    const git = (...args: string[]) =>
      run('git', ['-c', `http.extraHeader=Authorization: Basic ${auth}`, ...args], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
    try {
      await git('init', '-q');
      await git('fetch', '-q', '--depth', '1', `https://github.com/${repo}.git`, sha);
      await git('checkout', '-q', 'FETCH_HEAD');
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      // Only the error name: the message would include the git args, and with them the token.
      throw new Error(`checkout of ${repo}@${sha.slice(0, 8)} failed (${error instanceof Error ? error.name : 'error'})`);
    }
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }
}
