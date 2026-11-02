import api, { route, type APIResponse, type Route } from '@forge/api';

/** Jira replied with a non-2xx status. */
export class JiraError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'JiraError';
  }
}

/** Jira cannot be reached as the app: the call failed before any HTTP status (Jira not installed) or was refused (401/403). */
export class JiraUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraUnavailableError';
  }
}

/** Atlassian Document Format document; only built by `src/core/revisit.ts`. */
export type AdfDoc = { type: 'doc'; version: 1; content: unknown[] };

type Method = 'GET' | 'POST' | 'PUT';

function messageOf(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string>; message?: string };
    const parts = [...(body.errorMessages ?? []), ...Object.entries(body.errors ?? {}).map(([k, v]) => `${k}: ${v}`), body.message].filter(Boolean);
    if (parts.length) return `Jira ${status}: ${parts.join('; ')}`;
  } catch {
    // not JSON
  }
  return `Jira ${status}: ${text.slice(0, 200) || 'no body'}`;
}

/** Calls the Jira REST API as the app. Throws JiraError for non-2xx replies, JiraUnavailableError when Jira is unreachable. */
async function request<T>(method: Method, path: Route, body?: unknown): Promise<T> {
  let res: APIResponse;
  try {
    res = await api.asApp().requestJira(path, {
      method,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new JiraUnavailableError(`Jira request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new JiraUnavailableError(messageOf(res.status, text));
  if (!res.ok) throw new JiraError(res.status, messageOf(res.status, text));
  return (text ? JSON.parse(text) : undefined) as T;
}

/** True for Jira 429 replies; the evaluator rethrows these so the batch is retried later. */
export function isJiraRateLimited(err: unknown): boolean {
  return err instanceof JiraError && err.status === 429;
}

interface IssueTypeMeta {
  id: string;
  name: string;
  subtask?: boolean;
}

export const jira = {
  /** Number of issues matching `jql` (approximate count endpoint; throws on invalid JQL). */
  async countIssues(jql: string): Promise<number> {
    const body = await request<{ count: number }>('POST', route`/rest/api/3/search/approximate-count`, { jql });
    return body.count;
  },

  /** Strict server-side JQL validation (fields, functions, values) without running a search. */
  async parseJql(jql: string): Promise<{ ok: true } | { ok: false; errors: string[] }> {
    const body = await request<{ queries?: { errors?: string[] }[] }>('POST', route`/rest/api/3/jql/parse?validation=strict`, {
      queries: [jql],
    });
    const errors = body.queries?.[0]?.errors ?? [];
    return errors.length === 0 ? { ok: true } : { ok: false, errors };
  },

  /** True when `accountId` holds the global Jira ADMINISTER permission. */
  async isAdmin(accountId: string): Promise<boolean> {
    const body = await request<{ globalPermissions?: string[] }>('POST', route`/rest/api/3/permissions/check`, {
      accountId,
      globalPermissions: ['ADMINISTER'],
    });
    return (body.globalPermissions ?? []).includes('ADMINISTER');
  },

  /** Undefined when the project does not exist (or the app cannot see it). */
  async getProject(key: string): Promise<{ id: string; key: string; name: string } | undefined> {
    try {
      const p = await request<{ id: string; key: string; name: string }>('GET', route`/rest/api/3/project/${key}`);
      return { id: String(p.id), key: p.key, name: p.name };
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) return undefined;
      throw err;
    }
  },

  /** Creates a company-managed Kanban software project (simplified classic template) led by `leadAccountId` (demo seed only). */
  async createProject(input: { key: string; name: string; description: string; leadAccountId: string }): Promise<{ id: string; key: string }> {
    const created = await request<{ id: number | string; key: string }>('POST', route`/rest/api/3/project`, {
      key: input.key,
      name: input.name,
      description: input.description,
      projectTypeKey: 'software',
      projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-simplified-kanban-classic',
      leadAccountId: input.leadAccountId,
      assigneeType: 'UNASSIGNED',
    });
    return { id: String(created.id), key: created.key };
  },

  /** Creates work items of the project's Task type in bulk (50 per request). Returns the new issue keys. */
  async bulkCreateIssues(projectKey: string, issues: readonly { summary: string; description: AdfDoc; labels: string[] }[]): Promise<string[]> {
    if (issues.length === 0) return [];
    const issuetype = { id: await jira.taskTypeId(projectKey) };
    const keys: string[] = [];
    for (let i = 0; i < issues.length; i += 50) {
      const batch = issues.slice(i, i + 50);
      const res = await request<{ issues?: { key: string }[]; errors?: { failedElementNumber?: number; elementErrors?: unknown }[] }>(
        'POST',
        route`/rest/api/3/issue/bulk`,
        {
          issueUpdates: batch.map((n) => ({
            fields: { project: { key: projectKey }, issuetype, summary: n.summary, description: n.description, labels: n.labels },
          })),
        },
      );
      keys.push(...(res.issues ?? []).map((x) => x.key));
      if (res.errors?.length) {
        throw new JiraError(400, `Jira rejected ${res.errors.length} issue(s): ${JSON.stringify(res.errors[0]).slice(0, 300)}`);
      }
    }
    return keys;
  },

  /** Issue type for Revisit tasks: Task, else Story, else the first non-subtask type of the project. */
  async taskTypeId(projectKey: string): Promise<string> {
    const body = await request<{ issueTypes?: IssueTypeMeta[]; values?: IssueTypeMeta[] }>(
      'GET',
      route`/rest/api/3/issue/createmeta/${projectKey}/issuetypes`,
    );
    const types = (body.issueTypes ?? body.values ?? []).filter((t) => !t.subtask);
    const pick = types.find((t) => t.name === 'Task') ?? types.find((t) => t.name === 'Story') ?? types[0];
    if (!pick) throw new JiraError(400, `Jira project ${projectKey} has no issue type that can be created`);
    return String(pick.id);
  },

  /** Creates a work item; retries once without the assignee when Jira rejects it (owner not assignable). */
  async createIssue(input: {
    projectKey: string;
    summary: string;
    description: AdfDoc;
    labels: string[];
    assigneeAccountId?: string;
  }): Promise<{ id: string; key: string; url: string }> {
    const issuetype = { id: await jira.taskTypeId(input.projectKey) };
    const fields = (withAssignee: boolean) => ({
      project: { key: input.projectKey },
      issuetype,
      summary: input.summary,
      description: input.description,
      labels: input.labels,
      ...(withAssignee && input.assigneeAccountId ? { assignee: { accountId: input.assigneeAccountId } } : {}),
    });
    let created: { id: string; key: string; self: string };
    try {
      created = await request('POST', route`/rest/api/3/issue`, { fields: fields(true) });
    } catch (err) {
      if (!(err instanceof JiraError && err.status === 400 && /assignee/i.test(err.message) && input.assigneeAccountId)) throw err;
      console.warn('Tripwire createIssue: assignee rejected, retrying unassigned', { projectKey: input.projectKey });
      created = await request('POST', route`/rest/api/3/issue`, { fields: fields(false) });
    }
    return { id: String(created.id), key: created.key, url: `${new URL(created.self).origin}/browse/${created.key}` };
  },

  /** Undefined when the issue does not exist. */
  async getIssue(key: string): Promise<{ key: string; statusCategory?: string } | undefined> {
    try {
      const issue = await request<{ key: string; fields?: { status?: { statusCategory?: { key?: string } } } }>(
        'GET',
        route`/rest/api/3/issue/${key}?fields=status`,
      );
      return { key: issue.key, statusCategory: issue.fields?.status?.statusCategory?.key };
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) return undefined;
      throw err;
    }
  },
};
