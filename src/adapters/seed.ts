import { summarise, type EvalOutcome } from '../core/evaluator';
import { normaliseSettings, type Settings } from '../core/settings';
import { EVALUABLE_STATUSES } from '../core/state';
import type { confluence as confluenceAdapter } from './confluence';
import type { AdfDoc, jira as jiraAdapter } from './jira';
import type { Repo } from './repo';

/** Demo data for the "Defer CSV export" story: project SUP, label `export`, space DEC, a decision page. */
export const DEMO = {
  projectKey: 'SUP',
  projectName: 'Customer Support',
  label: 'export',
  baselineTickets: 7,
  busyMonthTickets: 30,
  spaceKey: 'DEC',
  spaceName: 'Decisions',
  pageTitle: 'Defer CSV export',
  decisionLabel: 'decision',
} as const;

/** JQL used to count demo tickets (same project/label as the page's quantitative assumption). */
export const DEMO_JQL = `project = ${DEMO.projectKey} AND labels = ${DEMO.label}`;

/** Resolver invocations are cut at 25 s: stop starting new work after this much time. */
export const TIME_BUDGET_MS = 18_000;
/** How long to wait for Jira search to see the new tickets before evaluating. */
export const INDEX_WAIT_MS = 5000;
const INDEX_POLL_MS = 1000;
/** Lock names (one per button) and how long a lock/cooldown lasts. */
export const LOAD_LOCK = 'demo-load';
export const SIMULATE_LOCK = 'demo-simulate';
export const LOCK_SECONDS = 60;
export const BUSY_MESSAGE = 'Demo seeding already running, try again in a minute.';
/** App value that remembers the demo page and whether the busy month tickets exist. */
export const DEMO_STATE_KEY = 'demo';

export const DEMO_PAGE_STORAGE = [
  '<h2>Decision</h2>',
  '<p>We will <strong>defer the CSV export feature</strong> for reports until Q2 2027 and spend the next two sprints on the scheduled reporting API instead.</p>',
  '<p><strong>Status:</strong> Decided · <strong>Decided on:</strong> 3 November 2026 · <strong>Owner:</strong> Product, Reporting squad</p>',
  '<h2>Context</h2>',
  '<p>CSV export has been on the roadmap for a year. It would take roughly one sprint to build and keep the export service running costs us on-call time. Demand so far is low and mostly comes from a handful of accounts that can use the API.</p>',
  '<h2>Assumptions</h2>',
  '<ul>',
  '<li>Fewer than 10 customer requests for CSV export per month (support tickets labelled export in project SUP).</li>',
  '<li>The scheduled reporting API ships before 31 March 2027, so customers who need raw data can pull it without CSV.</li>',
  '<li>Enterprise customers keep using the existing PDF reports; Customer Success checks in with them every quarter.</li>',
  '</ul>',
  '<h2>Revisit when</h2>',
  '<p>Any of the assumptions above stops being true. If CSV requests reach 10 or more in a month, we reopen this decision.</p>',
].join('');

const BASELINE_SUMMARIES = [
  'Customer asks for CSV export of monthly report',
  'Can we download the usage table as CSV?',
  'Export invoices to spreadsheet',
  'Need CSV export for finance reconciliation',
  'Request: export filtered list to CSV',
  'Excel/CSV download for audit log',
  'Bulk export of report data',
];

const BUSY_SUMMARIES = [
  'CSV export needed for quarterly board pack',
  'Customer escalation: no way to export report data',
  'Export dashboard widgets to CSV',
  'Finance team blocked without CSV export',
  'Request for CSV download of transactions',
  'Report export to spreadsheet for BI import',
];

const doc = (text: string): AdfDoc => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const ticket = (summary: string) => ({
  summary,
  description: doc('Demo support ticket created by Tripwire "Load demo data". The customer asks for a CSV export.'),
  labels: [DEMO.label],
});

/** Raised for problems the admin can fix; the resolver shows the message as is. */
export class SeedError extends Error {}

export interface SeedDeps {
  jira: Pick<typeof jiraAdapter, 'getProject' | 'createProject' | 'countIssues' | 'bulkCreateIssues'>;
  confluence: Pick<
    typeof confluenceAdapter,
    'findSpace' | 'createSpace' | 'findPageByTitle' | 'createPage' | 'getPageLabels' | 'addPageLabel' | 'canEditPage'
  >;
  repo: Pick<
    Repo,
    | 'getSettings'
    | 'saveSettings'
    | 'getDecisionByPage'
    | 'listTripwires'
    | 'getTripwireContext'
    | 'findOpenRevisit'
    | 'acquireAppLock'
    | 'releaseAppLock'
    | 'getAppValue'
    | 'setAppValue'
  >;
  enqueueExtraction: (pageId: string, force: boolean, requestedBy?: string) => Promise<string>;
  evaluate: (ids: readonly string[]) => Promise<{ results: EvalOutcome[]; rateLimited: boolean }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

interface DemoState {
  pageId?: string;
  /** Set once "Simulate a busy month" created its tickets; later clicks only evaluate. */
  simulatedTickets?: number;
  simulatedAt?: string;
}

async function readDemoState(repo: SeedDeps['repo']): Promise<DemoState> {
  const raw = await repo.getAppValue(DEMO_STATE_KEY);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const v = raw as Record<string, unknown>;
  return {
    ...(typeof v.pageId === 'string' && /^\d{1,20}$/.test(v.pageId) ? { pageId: v.pageId } : {}),
    ...(typeof v.simulatedTickets === 'number' ? { simulatedTickets: v.simulatedTickets } : {}),
    ...(typeof v.simulatedAt === 'string' ? { simulatedAt: v.simulatedAt } : {}),
  };
}

/**
 * Settings the demo needs, keeping what the admin already chose: the Revisit project is only filled in when
 * empty, SUP is added to the allowed projects and DEC to a non-empty watched-space list. Throws `SettingsError`.
 */
export function demoSettings(current: Settings): Settings {
  return normaliseSettings({
    ...current,
    revisitProjectKey: current.revisitProjectKey ?? DEMO.projectKey,
    decisionLabel: current.decisionLabel || DEMO.decisionLabel,
    allowedProjectKeys: current.allowedProjectKeys.includes(DEMO.projectKey)
      ? current.allowedProjectKeys
      : [...current.allowedProjectKeys, DEMO.projectKey],
    watchedSpaceKeys:
      current.watchedSpaceKeys.length > 0 && !current.watchedSpaceKeys.includes(DEMO.spaceKey)
        ? [...current.watchedSpaceKeys, DEMO.spaceKey]
        : current.watchedSpaceKeys,
  });
}

/** Runs `body` under the named lock. Kept for the full cooldown on success when `cooldown` (search lags behind writes). */
async function withLock<T>(deps: SeedDeps, name: string, cooldown: boolean, body: () => Promise<T>): Promise<T> {
  if (!(await deps.repo.acquireAppLock(name, new Date(deps.now()).toISOString(), LOCK_SECONDS))) throw new SeedError(BUSY_MESSAGE);
  let ok = false;
  try {
    const result = await body();
    ok = true;
    return result;
  } finally {
    if (!ok || !cooldown) await deps.repo.releaseAppLock(name);
  }
}

export interface LoadDemoResult {
  projectKey: string;
  revisitProjectKey: string;
  issueCount: number;
  spaceKey: string;
  pageId: string;
  pageUrl?: string;
  /** Whether the caller can edit the demo page (needed to accept its tripwire); null when it could not be checked. */
  canEdit: boolean | null;
  extractionJobId?: string;
  created: { project: boolean; issues: number; space: boolean; page: boolean; label: boolean };
}

/**
 * Idempotent demo setup: creates what is missing (project SUP, 7 `export` tickets, space DEC, the labelled
 * "Defer CSV export" page), adds SUP to the settings and queues extraction of the page. A 60 s lock covers
 * double clicks and Jira's search lag (the ticket count would be stale right after creating tickets).
 */
export async function loadDemoData(accountId: string, deps: SeedDeps): Promise<LoadDemoResult> {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(accountId)) throw new SeedError('Unknown user.');
  const { jira, confluence, repo } = deps;
  // Validate the merged settings before creating anything.
  const settings = demoSettings(await repo.getSettings());

  return withLock(deps, LOAD_LOCK, true, async () => {
    let projectCreated = false;
    if (!(await jira.getProject(DEMO.projectKey))) {
      await jira.createProject({
        key: DEMO.projectKey,
        name: DEMO.projectName,
        description: 'Customer support tickets. Demo data created by Tripwire.',
        leadAccountId: accountId,
      });
      projectCreated = true;
    }

    const existing = projectCreated ? 0 : await jira.countIssues(DEMO_JQL);
    const missing = Math.max(0, DEMO.baselineTickets - existing);
    if (missing > 0) {
      await jira.bulkCreateIssues(DEMO.projectKey, BASELINE_SUMMARIES.slice(0, missing).map(ticket));
    }

    // Before the page exists, so its extraction already allows JQL in SUP.
    await repo.saveSettings(settings);

    let spaceCreated = false;
    let space = await confluence.findSpace(DEMO.spaceKey);
    if (!space) {
      space = await confluence.createSpace(DEMO.spaceKey, DEMO.spaceName, 'Product and engineering decisions. Demo data created by Tripwire.');
      spaceCreated = true;
    }

    let pageCreated = false;
    let page = await confluence.findPageByTitle(space.id, DEMO.pageTitle);
    if (!page) {
      page = await confluence.createPage(space.id, DEMO.pageTitle, DEMO_PAGE_STORAGE);
      pageCreated = true;
    }

    // The page must carry the label Tripwire watches, which the admin may have changed from `decision`.
    let labelAdded = false;
    if (!(await confluence.getPageLabels(page.id)).includes(settings.decisionLabel)) {
      await confluence.addPageLabel(page.id, settings.decisionLabel);
      labelAdded = true;
    }
    await repo.setAppValue(DEMO_STATE_KEY, { ...(await readDemoState(repo)), pageId: page.id });

    // Adding a label fires no page event, so queue extraction ourselves; the caller becomes the decision owner.
    const extractionJobId =
      pageCreated || labelAdded || !(await repo.getDecisionByPage(page.id))
        ? await deps.enqueueExtraction(page.id, false, accountId)
        : undefined;

    // The space is created as the app and apps cannot grant space permissions, so check the caller can edit
    // the page instead of assuming the site's default space permissions apply.
    let canEdit: boolean | null;
    try {
      canEdit = await confluence.canEditPage(page.id);
    } catch (err) {
      console.warn('tripwire loadDemoData: could not check page access', { pageId: page.id, error: err instanceof Error ? err.message : String(err) });
      canEdit = null;
    }

    return {
      projectKey: DEMO.projectKey,
      revisitProjectKey: settings.revisitProjectKey ?? DEMO.projectKey,
      issueCount: existing + missing,
      spaceKey: space.key,
      pageId: page.id,
      ...(page.webUrl ? { pageUrl: page.webUrl } : {}),
      canEdit,
      ...(extractionJobId ? { extractionJobId } : {}),
      created: { project: projectCreated, issues: missing, space: spaceCreated, page: pageCreated, label: labelAdded },
    };
  });
}

export interface SimulateResult {
  /** Tickets created by this click (0 when an earlier click already created them). */
  created: number;
  issueCount: number;
  /** False when Jira search had not caught up with the new tickets; evaluation is skipped then. */
  indexed: boolean;
  passes: ({ total: number; rateLimited: boolean } & ReturnType<typeof summarise>)[];
  /** False when fewer than two passes ran (time budget, rate limit or search lag): click again to finish. */
  complete: boolean;
  revisits: { tripwireId: string; issueKey: string }[];
}

/** Waits until Jira's approximate count sees at least `target` demo tickets (search is eventually consistent). */
async function waitForCount(target: number, deps: SeedDeps): Promise<{ count: number; indexed: boolean }> {
  const deadline = deps.now() + INDEX_WAIT_MS;
  for (;;) {
    const count = await deps.jira.countIssues(DEMO_JQL);
    if (count >= target) return { count, indexed: true };
    if (deps.now() >= deadline) return { count, indexed: false };
    await deps.sleep(INDEX_POLL_MS);
  }
}

/**
 * "A busy month": adds 30 `export` tickets to SUP once, then evaluates the demo decision's confirmed tripwires
 * twice in a row so a crossed threshold gets its two strikes, trips and opens a Revisit task (inline, no queue).
 * The tickets are remembered in the `demo` app value: when time runs out, clicking again only evaluates.
 */
export async function simulateBusyMonth(deps: SeedDeps): Promise<SimulateResult> {
  const { jira, repo } = deps;
  const deadline = deps.now() + TIME_BUDGET_MS;
  const state = await readDemoState(repo);
  if (!state.pageId || !(await jira.getProject(DEMO.projectKey))) throw new SeedError('Run "Load demo data" first.');
  const decision = await repo.getDecisionByPage(state.pageId);
  const ids = decision ? (await repo.listTripwires(decision.id)).filter((t) => EVALUABLE_STATUSES.includes(t.status)).map((t) => t.id) : [];
  if (ids.length === 0) {
    throw new SeedError(`No confirmed tripwires yet. Open "${DEMO.pageTitle}" in Confluence and accept its tripwire first.`);
  }

  return withLock(deps, SIMULATE_LOCK, false, async () => {
    let created = 0;
    let target = 0;
    if (state.simulatedTickets === undefined) {
      const before = await jira.countIssues(DEMO_JQL);
      const keys = await jira.bulkCreateIssues(
        DEMO.projectKey,
        Array.from({ length: DEMO.busyMonthTickets }, (_, i) => ticket(`${BUSY_SUMMARIES[i % BUSY_SUMMARIES.length]} (#${i + 1})`)),
      );
      created = keys.length;
      target = before + created;
      await repo.setAppValue(DEMO_STATE_KEY, { ...state, simulatedTickets: created, simulatedAt: new Date(deps.now()).toISOString() });
    }
    const { count, indexed } = await waitForCount(target, deps);

    const passes: SimulateResult['passes'] = [];
    const revisitIds = new Set<string>();
    // A reading taken before search sees the tickets would reset the strikes, so skip evaluating then.
    while (indexed && passes.length < 2 && deps.now() < deadline) {
      const { results, rateLimited } = await deps.evaluate(ids);
      passes.push({ ...summarise(results), total: ids.length, rateLimited });
      for (const r of results) if (r.status === 'evaluated' && r.revisitRequested) revisitIds.add(r.tripwireId);
      if (rateLimited) break;
    }

    const revisits: SimulateResult['revisits'] = [];
    for (const tripwireId of revisitIds) {
      const ctx = await repo.getTripwireContext(tripwireId);
      const revisit = ctx ? await repo.findOpenRevisit(ctx.decision.id) : undefined;
      if (revisit) revisits.push({ tripwireId, issueKey: revisit.issueKey });
    }
    const complete = passes.length === 2 && !passes.some((p) => p.rateLimited);
    return { created, issueCount: count, indexed, passes, complete, revisits };
  });
}
