import api, { route, type APIResponse } from '@forge/api';

async function readJson<T>(res: APIResponse, what: string): Promise<T> {
  if (!res.ok) throw new Error(`Jira ${what} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const jira = {
  /** Number of issues matching `jql` (approximate count endpoint; throws on invalid JQL). */
  async countIssues(jql: string): Promise<number> {
    const res = await api.asApp().requestJira(route`/rest/api/3/search/approximate-count`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql }),
    });
    const body = await readJson<{ count: number }>(res, 'issue count');
    return body.count;
  },
};
