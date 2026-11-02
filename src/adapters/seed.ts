import { summarise, type EvalOutcome } from '../core/evaluator';
import { normaliseSettings, type Settings } from '../core/settings';
import { EVALUABLE_STATUSES } from '../core/state';
import { PERIOD_DAYS } from '../core/triggers/checkin';
import type { CheckinSpec, DateSpec } from '../core/types';
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

const ticket = (summary: string, extraLabels: string[] = []) => ({
  summary,
  description: doc('Demo support ticket created by Tripwire "Load demo data". The customer asks for a CSV export.'),
  labels: [DEMO.label, ...extraLabels],
});

/** Extra label on "Simulate a busy month" tickets so "Reset demo" can tell them from the 7 baseline tickets. */
export const SIM_LABEL = 'tripwire-demo-sim';

/** Summary of busy month ticket `i` (0-based): `<one of BUSY_SUMMARIES> (#n)`. */
const busySummary = (i: number): string => `${BUSY_SUMMARIES[i % BUSY_SUMMARIES.length]} (#${i + 1})`;

/**
 * Tickets made by "Simulate a busy month". Runs before `SIM_LABEL` existed left unlabelled tickets, so those are
 * recognised by their exact generated summary (`<busy summary> (#1..30)`), which no baseline ticket has.
 */
export function isSimulatedTicket(issue: { summary: string; labels: readonly string[] }): boolean {
  if (issue.labels.includes(SIM_LABEL)) return true;
  const m = /^(.*) \(#(\d{1,3})\)$/.exec(issue.summary);
  if (!m) return false;
  const n = Number(m[2]);
  return n >= 1 && n <= DEMO.busyMonthTickets && busySummary(n - 1) === issue.summary;
}

/** Raised for problems the admin can fix; the resolver shows the message as is. */
export class SeedError extends Error {}

export interface SeedDeps {
  jira: Pick<
    typeof jiraAdapter,
    'getProject' | 'createProject' | 'countIssues' | 'bulkCreateIssues' | 'searchIssues' | 'updateLabels' | 'transitionToDone' | 'addComment'
  >;
  confluence: Pick<
    typeof confluenceAdapter,
    'findSpace' | 'createSpace' | 'findPageByTitle' | 'createPage' | 'getPageLabels' | 'addPageLabel' | 'canEditPage' | 'updatePage'
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
    | 'deleteDecisionTree'
    | 'casTripwire'
    | 'acquirePageLock'
    | 'releasePageLock'
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
  /** Keys of the busy month tickets, so "Reset demo" can relabel them without depending on Jira's search index. */
  simulatedKeys?: string[];
  /** Set when "Reset demo" already reset the decision but Jira search still counted the busy month tickets. */
  resetPending?: boolean;
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,9}-\d{1,9}$/;

async function readDemoState(repo: SeedDeps['repo']): Promise<DemoState> {
  const raw = await repo.getAppValue(DEMO_STATE_KEY);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const v = raw as Record<string, unknown>;
  const keys = Array.isArray(v.simulatedKeys) ? v.simulatedKeys.filter((k): k is string => typeof k === 'string' && ISSUE_KEY.test(k)) : [];
  return {
    ...(typeof v.pageId === 'string' && /^\d{1,20}$/.test(v.pageId) ? { pageId: v.pageId } : {}),
    ...(typeof v.simulatedTickets === 'number' ? { simulatedTickets: v.simulatedTickets } : {}),
    ...(typeof v.simulatedAt === 'string' ? { simulatedAt: v.simulatedAt } : {}),
    ...(keys.length > 0 ? { simulatedKeys: keys } : {}),
    ...(v.resetPending === true ? { resetPending: true } : {}),
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
      await jira.bulkCreateIssues(DEMO.projectKey, BASELINE_SUMMARIES.slice(0, missing).map((s) => ticket(s)));
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

const DAY_MS = 86_400_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Demo page body after "Simulate a busy month" edited it (same text plus a dated review note, so edits never pile up). */
export const simulatedPageStorage = (day: string): string =>
  `${DEMO_PAGE_STORAGE}<p><em>Reviewed ${day} by the Reporting squad (demo edit by Tripwire "Simulate a busy month").</em></p>`;

/**
 * Moves the demo's non-numeric tripwires a month on, so one evaluation trips them: a date tripwire's date becomes
 * yesterday, a check-in's last answer goes one period plus a day back, and a watched page gets a new version.
 * Only `active`/`near` tripwires are touched (by CAS); handled dates stay handled. Returns how many were moved.
 */
async function ageDemoTripwires(pageId: string, decisionId: string, deps: SeedDeps): Promise<number> {
  const { repo } = deps;
  const now = deps.now();
  let aged = 0;
  let pageEdited = false;
  for (const t of await repo.listTripwires(decisionId)) {
    if (t.status !== 'active' && t.status !== 'near') continue;
    if (t.kind === 'date') {
      const spec = t.spec as DateSpec;
      if (spec.resolved) continue;
      if (await repo.casTripwire(t.id, [t.status], { spec: { ...spec, date: isoDay(now - DAY_MS) } })) aged += 1;
    } else if (t.kind === 'checkin') {
      const days = PERIOD_DAYS[(t.spec as CheckinSpec).every] + 1;
      if (await repo.casTripwire(t.id, [t.status], { confirmedAt: new Date(now - days * DAY_MS).toISOString() })) aged += 1;
    } else if (t.kind === 'content_change' && !pageEdited) {
      await deps.confluence.updatePage(pageId, simulatedPageStorage(isoDay(now)), 'Demo edit by Tripwire "Simulate a busy month"');
      pageEdited = true;
      aged += 1;
    }
  }
  return aged;
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
 * "A busy month": adds 30 `export` tickets to SUP once, moves the date/checkin/content_change tripwires a month on
 * (`ageDemoTripwires`), then evaluates the demo decision's confirmed tripwires twice in a row so a crossed
 * threshold gets its two strikes (the others trip on the first), trips and opens a Revisit task (inline, no queue).
 * The tickets are remembered in the `demo` app value: when time runs out, clicking again only evaluates.
 */
export async function simulateBusyMonth(deps: SeedDeps): Promise<SimulateResult> {
  const { jira, repo } = deps;
  const deadline = deps.now() + TIME_BUDGET_MS;
  const state = await readDemoState(repo);
  if (!state.pageId || !(await jira.getProject(DEMO.projectKey))) throw new SeedError('Run "Load demo data" first.');
  if (state.resetPending) throw new SeedError(`"Reset demo" has not finished: ${INDEX_LAG_MESSAGE} Click "Reset demo" again.`);
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
        Array.from({ length: DEMO.busyMonthTickets }, (_, i) => ticket(busySummary(i), [SIM_LABEL])),
      );
      created = keys.length;
      target = before + created;
      await repo.setAppValue(DEMO_STATE_KEY, {
        ...state,
        simulatedTickets: created,
        simulatedKeys: keys,
        simulatedAt: new Date(deps.now()).toISOString(),
      });
    }
    const { count, indexed } = await waitForCount(target, deps);

    // A month passes for the date/checkin/content_change tripwires too, so the same evaluation trips them.
    if (indexed && decision) {
      const aged = await ageDemoTripwires(state.pageId as string, decision.id, deps);
      if (aged > 0) console.info('tripwire simulateBusyMonth: non-numeric tripwires moved a month on', { aged });
    }

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

export interface ResetDemoResult {
  /** Busy month tickets that lost the `export` label in this click. */
  relabelled: number;
  /** Demo tickets still counted by the demo JQL (the baseline). */
  remaining: number;
  /** Revisit issue of the demo decision that was closed, if one was open. */
  revisitIssueKey?: string;
  deleted: { tripwires: number; assumptions: number; evaluations: number; revisits: number } | null;
  extractionJobId?: string;
  /** False while Jira search has not caught up (busy month tickets missing or still counted): click again later. */
  indexed: boolean;
  /** False when the reset has to be repeated (time ran out or Jira search lagged); the simulate marker is kept then. */
  complete: boolean;
  /** Shown as is in the setup page when the reset is not complete. */
  message?: string;
  warnings: string[];
}

/** Most demo tickets "Reset demo" looks at (7 baseline + a few busy months). */
const RESET_SCAN_MAX = 300;
const RESET_PARALLEL = 5;
export const INDEX_LAG_MESSAGE = 'Jira index still catching up, retry in a minute.';
export const PAGE_BUSY_MESSAGE = 'The demo decision is busy (extraction or Revisit in progress), try again in a minute.';
const TIME_UP_MESSAGE = 'Time ran out while relabelling tickets; click "Reset demo" again to finish.';
/** Demo tickets in SUP, including busy month tickets that already lost the `export` label. */
const RESET_JQL = `project = ${DEMO.projectKey} AND (labels = ${DEMO.label} OR labels = ${SIM_LABEL})`;
/** Page locks shared with `openRevisit` and the extraction pipeline. */
const RESET_PAGE_LOCKS = ['revisit', 'extract'] as const;
const ARCHIVABLE = ['proposed', 'active', 'near', 'tripped', 'revisiting'] as const;

const resetComment = (): AdfDoc => doc('Closed by Tripwire "Reset demo": the demo decision was reset to its freshly loaded state.');

/**
 * Puts the demo back to the state right after "Load demo data" so the story can be replayed: the busy month
 * tickets lose the `export` label (they get `SIM_LABEL` instead, nothing is deleted), the demo decision's open
 * Revisit issue is moved to Done, the demo decision and all its rows are deleted and the page is extracted
 * again (its tripwire comes back as `proposed`), and the "simulated" marker is cleared once Jira search agrees.
 * Only issues in SUP that `isSimulatedTicket` recognises and the decision of the remembered demo page are touched.
 * Holds both demo app locks and the page's revisit/extract locks, so no evaluation, Revisit or extraction of the
 * demo page can write rows while they are deleted.
 */
export async function resetDemo(accountId: string, deps: SeedDeps): Promise<ResetDemoResult> {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(accountId)) throw new SeedError('Unknown user.');
  const { repo } = deps;
  const state = await readDemoState(repo);
  if (!state.pageId) throw new SeedError('Nothing to reset: run "Load demo data" first.');
  const pageId = state.pageId;

  // Load and Simulate locks: a reset racing either would leave half-counted tickets behind.
  return withLock(deps, LOAD_LOCK, false, () =>
    withLock(deps, SIMULATE_LOCK, false, async () => {
      const held: (typeof RESET_PAGE_LOCKS)[number][] = [];
      const release = async (): Promise<void> => {
        for (const lock of held) {
          await repo.releasePageLock(pageId, lock).catch((err: unknown) => {
            console.warn('tripwire resetDemo: page lock release failed', { pageId, lock, error: err instanceof Error ? err.message : String(err) });
          });
        }
      };
      let result: ResetDemoResult;
      try {
        for (const lock of RESET_PAGE_LOCKS) {
          if (!(await repo.acquirePageLock(pageId, lock, new Date(deps.now()).toISOString(), LOCK_SECONDS))) throw new SeedError(PAGE_BUSY_MESSAGE);
          held.push(lock);
        }
        result = await resetLocked(pageId, state, deps);
      } finally {
        await release();
      }
      // After the locks are gone, or the extraction would find the page locked.
      if (result.deleted) result.extractionJobId = await deps.enqueueExtraction(pageId, true, accountId);
      return result;
    }),
  );
}

async function resetLocked(pageId: string, state: DemoState, deps: SeedDeps): Promise<ResetDemoResult> {
  const { jira, repo } = deps;
  const deadline = deps.now() + TIME_BUDGET_MS;
  const warnings: string[] = [];
  let relabelled = 0;
  let remaining = 0;
  const incomplete = (message: string, indexed: boolean): ResetDemoResult => ({ relabelled, remaining, deleted: null, indexed, complete: false, message, warnings });

  if (await jira.getProject(DEMO.projectKey)) {
    const tickets = await jira.searchIssues(RESET_JQL, RESET_SCAN_MAX);
    const keys = new Set(state.simulatedKeys ?? []);
    const simulated = tickets.filter((t) => keys.has(t.key) || isSimulatedTicket(t));
    remaining = tickets.filter((t) => !simulated.includes(t) && t.labels.includes(DEMO.label)).length;
    // Keys from Simulate are relabelled whether or not search sees them yet; found tickets only while they are counted.
    const toRelabel = [...new Set([...keys, ...simulated.filter((t) => t.labels.includes(DEMO.label)).map((t) => t.key)])];
    for (let i = 0; i < toRelabel.length; i += RESET_PARALLEL) {
      if (deps.now() >= deadline) return incomplete(TIME_UP_MESSAGE, true);
      const batch = toRelabel.slice(i, i + RESET_PARALLEL);
      await Promise.all(batch.map((key) => jira.updateLabels(key, [SIM_LABEL], [DEMO.label])));
      relabelled += batch.length;
    }
    // Without remembered keys, a busy month search cannot see yet would keep counting after the reset.
    if (keys.size === 0 && state.simulatedTickets !== undefined && simulated.length < state.simulatedTickets) {
      return incomplete(INDEX_LAG_MESSAGE, false);
    }
  }

  let revisitIssueKey: string | undefined;
  let deleted: ResetDemoResult['deleted'] = null;
  const decision = state.resetPending ? undefined : await repo.getDecisionByPage(pageId);
  if (decision) {
    // Archive first: an evaluation that read the tripwire before the locks were taken then loses its CAS.
    for (const t of await repo.listTripwires(decision.id)) {
      await repo.casTripwire(t.id, ARCHIVABLE, { status: 'archived' });
    }
    const open = await repo.findOpenRevisit(decision.id);
    if (open) {
      revisitIssueKey = open.issueKey;
      try {
        if (!(await jira.transitionToDone(open.issueKey))) warnings.push(`${open.issueKey} has no transition to Done; close it in Jira.`);
        await jira.addComment(open.issueKey, resetComment());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('tripwire resetDemo: could not close Revisit issue', { issueKey: open.issueKey, error: msg });
        warnings.push(`Could not close ${open.issueKey}: ${msg}`);
      }
    }
    deleted = await repo.deleteDecisionTree(decision.id);
  }

  let indexed = true;
  if (state.simulatedTickets !== undefined || relabelled > 0) {
    const waitUntil = deps.now() + INDEX_WAIT_MS;
    for (;;) {
      if ((await jira.countIssues(DEMO_JQL)) <= remaining) break;
      if (deps.now() >= waitUntil) {
        indexed = false;
        break;
      }
      await deps.sleep(INDEX_POLL_MS);
    }
  }
  const base = { relabelled, remaining, ...(revisitIssueKey ? { revisitIssueKey } : {}), deleted, warnings };
  if (!indexed) {
    // Keep the marker: Simulate would otherwise start from a stale count. The decision is already reset.
    await repo.setAppValue(DEMO_STATE_KEY, { ...state, resetPending: true });
    return { ...base, indexed: false, complete: false, message: INDEX_LAG_MESSAGE };
  }
  await repo.setAppValue(DEMO_STATE_KEY, { pageId });
  return { ...base, indexed: true, complete: true };
}
