import api, { route, type APIResponse } from '@forge/api';

export interface PageSummary {
  id: string;
  title: string;
  version: number;
  spaceId: string;
  authorId?: string;
  webUrl?: string;
  body?: string;
}

interface RawPage {
  id: string;
  title: string;
  spaceId?: string;
  authorId?: string;
  version: { number: number };
  body?: { storage?: { value?: string } };
  _links?: { base?: string; webui?: string };
}

async function readJson<T>(res: APIResponse, what: string): Promise<T> {
  if (!res.ok) throw new Error(`Confluence ${what} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const confluence = {
  async getPage(pageId: string, withBody = false): Promise<PageSummary> {
    // Confluence v2 rejects `body-format=none` with 400; omit the parameter when no body is needed.
    const path = withBody
      ? route`/wiki/api/v2/pages/${pageId}?body-format=storage`
      : route`/wiki/api/v2/pages/${pageId}`;
    const res = await api.asApp().requestConfluence(path, { headers: { Accept: 'application/json' } });
    const page = await readJson<RawPage>(res, `get page ${pageId}`);
    const links = page._links;
    return {
      id: page.id,
      title: page.title,
      version: page.version.number,
      spaceId: String(page.spaceId ?? ''),
      authorId: page.authorId,
      webUrl: links?.base && links.webui ? `${links.base}${links.webui}` : undefined,
      body: page.body?.storage?.value,
    };
  },

  async getPageVersion(pageId: string): Promise<number> {
    return (await this.getPage(pageId)).version;
  },

  /** Lower-cased label names on the page (first 100). */
  async getPageLabels(pageId: string): Promise<string[]> {
    const res = await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${pageId}/labels?limit=100`, {
      headers: { Accept: 'application/json' },
    });
    const body = await readJson<{ results?: { name?: string }[] }>(res, `get labels of page ${pageId}`);
    return (body.results ?? []).map((l) => (l.name ?? '').toLowerCase()).filter((n) => n !== '');
  },

  /**
   * True when the current user may edit the page (`update` in its permitted operations). Runs as the user, so
   * it must only be called from a resolver. 401/403/404 mean "no"; Forge platform errors (e.g. missing user
   * consent) propagate so the UI bridge can show the consent prompt.
   */
  async canEditPage(pageId: string): Promise<boolean> {
    const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${pageId}/operations`, {
      headers: { Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) return false;
    const body = await readJson<{ operations?: { operation?: string; targetType?: string }[] }>(res, `get operations of page ${pageId}`);
    return (body.operations ?? []).some((o) => o.operation === 'update');
  },

  /**
   * The page as the current user sees it: undefined when they cannot view it (401/403/404). Runs as the user
   * (resolvers and Rovo actions only); platform errors such as missing consent propagate.
   */
  async viewPageAsUser(pageId: string): Promise<{ title: string; webUrl?: string } | undefined> {
    const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${pageId}`, {
      headers: { Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) return undefined;
    const page = await readJson<RawPage>(res, `view page ${pageId}`);
    const links = page._links;
    return { title: page.title, webUrl: links?.base && links.webui ? `${links.base}${links.webui}` : undefined };
  },

  /**
   * Title, version and storage body as the current user sees them; undefined on 401/403/404. Runs as the user
   * (resolvers only); platform errors propagate.
   */
  async getPageAsUser(pageId: string): Promise<{ title: string; version: number; body: string } | undefined> {
    const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${pageId}?body-format=storage`, {
      headers: { Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) return undefined;
    const page = await readJson<RawPage>(res, `get page ${pageId} as user`);
    const body = page.body?.storage?.value;
    // Writing back a body that was not returned would wipe the page.
    if (typeof body !== 'string') throw new Error(`Confluence get page ${pageId} as user returned no storage body`);
    return { title: page.title, version: page.version.number, body };
  },

  /**
   * Replaces the body as the current user (they become a page contributor), as version `version`; returns the
   * saved version. Runs as the user (resolvers only); a version conflict or missing permission throws.
   */
  async updatePageAsUser(pageId: string, page: { title: string; body: string; version: number; message: string }): Promise<number> {
    const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${pageId}`, {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: pageId,
        status: 'current',
        title: page.title,
        body: { representation: 'storage', value: page.body },
        version: { number: page.version, message: page.message },
      }),
    });
    const saved = await readJson<RawPage>(res, `update page ${pageId} as user`);
    return saved.version.number;
  },

  /**
   * Whether the current user may administer the space (v2 space operations, as the user). False on 401/403/404;
   * other failures throw (callers fail closed).
   */
  async canAdministerSpace(spaceId: string): Promise<boolean> {
    const res = await api.asUser().requestConfluence(route`/wiki/api/v2/spaces/${spaceId}/operations`, {
      headers: { Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) return false;
    const body = await readJson<{ operations?: { operation?: string; targetType?: string }[] }>(res, `get operations of space ${spaceId}`);
    return (body.operations ?? []).some((o) => o.operation === 'administer' && o.targetType === 'space');
  },

  /** The space with this key, or undefined. */
  async findSpace(key: string): Promise<{ id: string; key: string } | undefined> {
    const res = await api.asApp().requestConfluence(route`/wiki/api/v2/spaces?keys=${key}&limit=1`, {
      headers: { Accept: 'application/json' },
    });
    const body = await readJson<{ results?: { id: string | number; key: string }[] }>(res, `find space ${key}`);
    const space = body.results?.[0];
    return space ? { id: String(space.id), key: space.key } : undefined;
  },

  /** Creates a global space (v1 API: v2 space creation needs a scope Tripwire does not request). */
  async createSpace(key: string, name: string, description: string): Promise<{ id: string; key: string }> {
    const res = await api.asApp().requestConfluence(route`/wiki/rest/api/space`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, name, description: { plain: { value: description, representation: 'plain' } } }),
    });
    const body = await readJson<{ id: string | number; key: string }>(res, `create space ${key}`);
    return { id: String(body.id), key: body.key };
  },

  /** The current page with exactly this title in the space, or undefined. */
  async findPageByTitle(spaceId: string, title: string): Promise<{ id: string; webUrl?: string } | undefined> {
    const res = await api
      .asApp()
      .requestConfluence(route`/wiki/api/v2/spaces/${spaceId}/pages?title=${title}&status=current&limit=1`, {
        headers: { Accept: 'application/json' },
      });
    const body = await readJson<{ results?: RawPage[]; _links?: { base?: string } }>(res, `find page in space ${spaceId}`);
    const page = body.results?.[0];
    if (!page) return undefined;
    const base = body._links?.base;
    return { id: String(page.id), webUrl: base && page._links?.webui ? `${base}${page._links.webui}` : undefined };
  },

  /** Creates a current page from storage-format XHTML. */
  async createPage(spaceId: string, title: string, storage: string): Promise<{ id: string; webUrl?: string }> {
    const res = await api.asApp().requestConfluence(route`/wiki/api/v2/pages`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ spaceId, status: 'current', title, body: { representation: 'storage', value: storage } }),
    });
    const page = await readJson<RawPage>(res, `create page "${title}"`);
    const links = page._links;
    return { id: String(page.id), webUrl: links?.base && links.webui ? `${links.base}${links.webui}` : undefined };
  },

  /**
   * Replaces the body of a current page (storage-format XHTML) as a new version; returns that version number. With
   * `readVersion` (the version the new body was built from) a page edited since then is not overwritten: this
   * throws, and Confluence itself rejects the write when an edit lands between the version check and the PUT.
   */
  async updatePage(pageId: string, storage: string, versionMessage: string, readVersion?: number): Promise<number> {
    const current = await this.getPage(pageId);
    if (readVersion !== undefined && current.version !== readVersion) {
      throw new Error(`Confluence update page ${pageId} skipped: page is at version ${current.version}, the edit was made on ${readVersion}`);
    }
    const res = await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${pageId}`, {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: pageId,
        status: 'current',
        title: current.title,
        body: { representation: 'storage', value: storage },
        version: { number: current.version + 1, message: versionMessage },
      }),
    });
    const page = await readJson<RawPage>(res, `update page ${pageId}`);
    return page.version.number;
  },

  /** Adds a global label (v1 API: v2 has no label write endpoint). */
  async addPageLabel(pageId: string, label: string): Promise<void> {
    const res = await api.asApp().requestConfluence(route`/wiki/rest/api/content/${pageId}/label`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify([{ prefix: 'global', name: label }]),
    });
    await readJson<unknown>(res, `add label to page ${pageId}`);
  },

  async getSpaceKey(spaceId: string): Promise<string> {
    const res = await api.asApp().requestConfluence(route`/wiki/api/v2/spaces/${spaceId}`, {
      headers: { Accept: 'application/json' },
    });
    const body = await readJson<{ key: string }>(res, `get space ${spaceId}`);
    return body.key;
  },
};
