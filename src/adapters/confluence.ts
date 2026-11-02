import api, { route, type APIResponse } from '@forge/api';

export interface PageSummary {
  id: string;
  title: string;
  version: number;
  body?: string;
}

async function readJson<T>(res: APIResponse, what: string): Promise<T> {
  if (!res.ok) throw new Error(`Confluence ${what} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const confluence = {
  async getPage(pageId: string, withBody = false): Promise<PageSummary> {
    const res = await api
      .asApp()
      .requestConfluence(route`/wiki/api/v2/pages/${pageId}?body-format=${withBody ? 'storage' : 'none'}`, {
        headers: { Accept: 'application/json' },
      });
    const page = await readJson<{ id: string; title: string; version: { number: number }; body?: { storage?: { value?: string } } }>(
      res,
      `get page ${pageId}`,
    );
    return { id: page.id, title: page.title, version: page.version.number, body: page.body?.storage?.value };
  },

  async getPageVersion(pageId: string): Promise<number> {
    return (await this.getPage(pageId)).version;
  },
};
