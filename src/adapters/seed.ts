import { summarise, type EvalOutcome } from '../core/evaluator';
import { quoteInText } from '../core/extraction';
import { storageToText } from '../core/pageText';
import { rememberedVersion, STAMP_LOCK_SECONDS } from '../core/pageVersion';
import { normaliseSettings, type Settings } from '../core/settings';
import { EVALUABLE_STATUSES } from '../core/state';
import { PERIOD_DAYS } from '../core/triggers/checkin';
import type { Assumption, CheckinSpec, DateSpec } from '../core/types';
import type { confluence as confluenceAdapter } from './confluence';
import type { AdfDoc, jira as jiraAdapter } from './jira';
import type { Repo, TripwireRow } from './repo';

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

/** Billing bugs behind the Lumora "Use Stripe for billing" decision (also in SUP). */
export const BILLING = { label: 'billing', baselineTickets: 2, busyMonthTickets: 6 } as const;
export const BILLING_JQL = `project = ${DEMO.projectKey} AND labels = ${BILLING.label}`;

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
/** App value that remembers the demo pages and whether the busy month tickets exist. */
export const DEMO_STATE_KEY = 'demo';

const DAY_MS = 86_400_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** `day` (YYYY-MM-DD) plus `n` days. */
export const addDays = (day: string, n: number): string => isoDay(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);

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

/** One Lumora decision page. `storage(today)` writes dates relative to `today` (YYYY-MM-DD). */
export interface DemoPage {
  slug: string;
  title: string;
  team: string;
  storage: (today: string) => string;
}

/** Slug of the "Defer CSV export" page (the main video story). */
export const MAIN_SLUG = 'csv-export';

interface PageText {
  decision: string;
  team: string;
  topics: string;
  context: string;
  assumptions: string[];
  revisit: string;
}

const lumoraPage = (t: PageText, today: string): string =>
  [
    '<h2>Decision</h2>',
    `<p>${t.decision}</p>`,
    `<p><strong>Status:</strong> Decided · <strong>Decided on:</strong> ${today} · <strong>Owner team:</strong> ${t.team}</p>`,
    `<p><strong>Topics:</strong> ${t.topics}</p>`,
    '<h2>Context</h2>',
    `<p>${t.context}</p>`,
    '<h2>Assumptions</h2>',
    `<ul>${t.assumptions.map((a) => `<li>${a}</li>`).join('')}</ul>`,
    '<h2>Revisit when</h2>',
    `<p>${t.revisit}</p>`,
  ].join('');

/**
 * The Lumora demo: 8 decisions from 7 teams. Three pairs contradict each other across teams and share topic
 * phrases on purpose (backend language, data retention, mobile release); together they cover every tripwire kind
 * the evaluator runs (jql_threshold, date, checkin, content_change).
 */
export const DEMO_PAGES: readonly DemoPage[] = [
  { slug: MAIN_SLUG, title: DEMO.pageTitle, team: 'Product', storage: () => DEMO_PAGE_STORAGE },
  {
    slug: 'stripe-billing',
    title: 'Use Stripe for billing',
    team: 'Platform',
    storage: (today) =>
      lumoraPage(
        {
          decision: 'Lumora bills every customer through <strong>Stripe Billing</strong>. We will not build or run our own invoicing engine.',
          team: 'Platform',
          topics: 'billing provider, payments',
          context: 'Our in-house invoicing scripts broke twice last year. Stripe handles invoices, taxes and retries for a fee we can afford at our size.',
          assumptions: [
            'Fewer than 5 billing bugs are reported per month (support tickets labelled billing in project SUP).',
          ],
          revisit: 'If 5 or more billing bugs are reported in a month, we reopen this decision.',
        },
        today,
      ),
  },
  {
    slug: 'go-services',
    title: 'All new backend services are written in Go',
    team: 'Platform',
    storage: (today) =>
      lumoraPage(
        {
          decision: '<strong>All new backend services at Lumora must be written in Go.</strong> Node.js, Python and Java are not approved for new services, including experiments.',
          team: 'Platform',
          topics: 'backend language, service runtime',
          context: 'One backend language keeps on-call, libraries and hiring simple. The Platform team maintains the Go service template and the shared libraries.',
          assumptions: [
            'The Go service template still covers what every team needs; the Platform guild confirms this with the other teams every quarter.',
          ],
          revisit: 'If a team cannot build what it needs with the Go template, we reopen this decision.',
        },
        today,
      ),
  },
  {
    slug: 'node-experiments',
    title: 'Experiment services are built with Node.js and TypeScript',
    team: 'Growth',
    storage: (today) =>
      lumoraPage(
        {
          decision: '<strong>All new Growth experiment services will be written in Node.js with TypeScript</strong>, not Go, starting with the pricing experiment backend.',
          team: 'Growth',
          topics: 'backend language, experiment services',
          context: 'Our engineers write TypeScript every day and experiments live for a few weeks. Moving fast matters more than one company-wide backend language.',
          assumptions: [
            'This page is the agreed experiment stack: it must not change without Growth lead approval, because any edit means the stack is being reopened.',
          ],
          revisit: 'If this page is edited, the Growth leads review the stack again.',
        },
        today,
      ),
  },
  {
    slug: 'event-retention',
    title: 'Delete event data after 90 days',
    team: 'Data',
    storage: (today) =>
      lumoraPage(
        {
          decision: '<strong>All event data in the warehouse, including payment and transaction events, is deleted automatically after 90 days.</strong>',
          team: 'Data',
          topics: 'data retention, event data',
          context: 'Storage costs doubled this year and most queries only look at the last month. Shorter data retention also reduces privacy risk.',
          assumptions: [`Legal sign-off on the 90-day data retention policy is valid until ${addDays(today, 3)}; the policy must be reviewed by that date.`],
          revisit: 'If the legal sign-off expires or a regulator asks for older events, we reopen this decision.',
        },
        today,
      ),
  },
  {
    slug: 'transaction-retention',
    title: 'Keep payment transaction events for 2 years',
    team: 'Compliance',
    storage: (today) =>
      lumoraPage(
        {
          decision: '<strong>Payment and transaction events must be kept for at least 2 years</strong> for the annual audit. No team may delete them earlier.',
          team: 'Compliance',
          topics: 'data retention, transaction events',
          context: 'Our payment partners and external auditors ask for two years of transaction history every audit.',
          assumptions: [
            'External auditors still require two years of transaction history; Compliance confirms this with the auditors every quarter.',
          ],
          revisit: 'If the auditors change the data retention period, we reopen this decision.',
        },
        today,
      ),
  },
  {
    slug: 'mobile-freeze',
    title: 'Freeze mobile releases over the holidays',
    team: 'Mobile',
    storage: (today) =>
      lumoraPage(
        {
          decision: `<strong>No mobile app release ships between ${addDays(today, 20)} and ${addDays(today, 40)}.</strong> Only crash fixes approved by the Mobile lead are allowed during the freeze.`,
          team: 'Mobile',
          topics: 'mobile release, release freeze',
          context: 'App store reviews slow down over the holidays and half of the Mobile team is away, so a broken release could stay live for days.',
          assumptions: [`The mobile release freeze starts on ${addDays(today, 20)}; the Mobile leads confirm the freeze window on that date.`],
          revisit: 'If the freeze window changes, we reopen this decision.',
        },
        today,
      ),
  },
  {
    slug: 'year-end-promo',
    title: 'Year-end promo ships in the mobile app',
    team: 'Marketing',
    storage: (today) =>
      lumoraPage(
        {
          decision: `<strong>The year-end promo ships as a new mobile app release on ${addDays(today, 25)}</strong>, with in-app banners and a new checkout screen.`,
          team: 'Marketing',
          topics: 'mobile release, year-end promo',
          context: 'Last year most holiday sales came from the mobile app. The promo needs a new app version because the checkout screen changes.',
          assumptions: [`The promo launch date of ${addDays(today, 25)} holds; partners and ad campaigns are booked for that date.`],
          revisit: 'If the mobile release cannot ship on the launch date, we reopen this decision.',
        },
        today,
      ),
  },
];

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

const BILLING_BASELINE_SUMMARIES = ['Invoice shows wrong VAT rate', 'Card payment retried twice'];

const BILLING_BUSY_SUMMARIES = [
  'Customer charged twice for annual plan',
  'Invoice PDF missing company address',
  'Proration wrong after plan downgrade',
  'Refund not shown on customer invoice',
  'Billing email sent in the wrong currency',
  'Coupon not applied at renewal',
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

const billingTicket = (summary: string, extraLabels: string[] = []) => ({
  summary,
  description: doc('Demo billing bug created by Tripwire demo data (Lumora).'),
  labels: [BILLING.label, ...extraLabels],
});

/** Extra label on "Simulate a busy month" tickets so "Reset demo" can tell them from the baseline tickets. */
export const SIM_LABEL = 'tripwire-demo-sim';
/** Labels the demo JQLs count; "Reset demo" removes them from simulated tickets. */
const COUNTED_LABELS = [DEMO.label, BILLING.label] as const;

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
    'findSpace' | 'createSpace' | 'findPageByTitle' | 'createPage' | 'getPageLabels' | 'addPageLabel' | 'canEditPage' | 'updatePage' | 'getPage'
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
    | 'setDecisionPageVersion'
    | 'replaceInAssumption'
    | 'listAssumptions'
  >;
  enqueueExtraction: (pageId: string, force: boolean, requestedBy?: string) => Promise<string>;
  /** Queues an evaluation of these tripwires (the `evaluate` queue). */
  enqueueEvaluation: (ids: readonly string[]) => Promise<void>;
  evaluate: (ids: readonly string[]) => Promise<{ results: EvalOutcome[]; rateLimited: boolean }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Limits for the demo queue consumer (up to 900 s); the defaults fit one 25 s resolver call. */
  limits?: SeedLimits;
  /** Progress of a background demo job: step `step` of `total`, with a one-line message. */
  progress?: (step: number, total: number, message: string) => Promise<void>;
}

export interface SeedLimits {
  /** Stop starting new work after this much time. */
  budgetMs: number;
  /** How long to wait for Jira search to see (or stop counting) the demo tickets. */
  indexWaitMs: number;
  /** How long the demo and page locks last (must cover the whole run). */
  lockSeconds: number;
}

const budgetOf = (deps: SeedDeps): number => deps.limits?.budgetMs ?? TIME_BUDGET_MS;
const indexWaitOf = (deps: SeedDeps): number => deps.limits?.indexWaitMs ?? INDEX_WAIT_MS;
const lockSecondsOf = (deps: SeedDeps): number => deps.limits?.lockSeconds ?? LOCK_SECONDS;
/** Poll Jira search less often during a long background wait. */
const indexPollOf = (deps: SeedDeps): number => (indexWaitOf(deps) > INDEX_WAIT_MS ? 3 * INDEX_POLL_MS : INDEX_POLL_MS);
const report = async (deps: SeedDeps, step: number, total: number, message: string): Promise<void> => {
  if (deps.progress) await deps.progress(step, total, message);
};

/** Progress steps per demo job. */
export const LOAD_STEPS = 2 + DEMO_PAGES.length;
export const SIMULATE_STEPS = 5;
export const RESET_STEPS = 3;

interface DemoState {
  /** The "Defer CSV export" page (states written before the Lumora pages only have this one). */
  pageId?: string;
  /** Page id per `DEMO_PAGES` slug. */
  pages?: Record<string, string>;
  /** Set once "Simulate a busy month" created its tickets; later clicks only evaluate. */
  simulatedTickets?: number;
  simulatedAt?: string;
  /** Keys of the busy month tickets, so "Reset demo" can relabel them without depending on Jira's search index. */
  simulatedKeys?: string[];
  /** Set when "Reset demo" already reset every decision but Jira search still counted the busy month tickets. */
  resetPending?: boolean;
  /** Pages whose decision an unfinished "Reset demo" already deleted (not deleted again on the next click). */
  resetPageIds?: string[];
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,9}-\d{1,9}$/;
const PAGE_ID = /^\d{1,20}$/;
const SLUGS = new Set(DEMO_PAGES.map((p) => p.slug));

async function readDemoState(repo: Pick<SeedDeps['repo'], 'getAppValue'>): Promise<DemoState> {
  const raw = await repo.getAppValue(DEMO_STATE_KEY);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const v = raw as Record<string, unknown>;
  const keys = Array.isArray(v.simulatedKeys) ? v.simulatedKeys.filter((k): k is string => typeof k === 'string' && ISSUE_KEY.test(k)) : [];
  const pages: Record<string, string> = {};
  if (v.pages && typeof v.pages === 'object' && !Array.isArray(v.pages)) {
    for (const [slug, id] of Object.entries(v.pages as Record<string, unknown>)) {
      if (SLUGS.has(slug) && typeof id === 'string' && PAGE_ID.test(id)) pages[slug] = id;
    }
  }
  const resetPageIds = Array.isArray(v.resetPageIds) ? v.resetPageIds.filter((id): id is string => typeof id === 'string' && PAGE_ID.test(id)) : [];
  return {
    ...(typeof v.pageId === 'string' && PAGE_ID.test(v.pageId) ? { pageId: v.pageId } : {}),
    ...(Object.keys(pages).length > 0 ? { pages } : {}),
    ...(typeof v.simulatedTickets === 'number' ? { simulatedTickets: v.simulatedTickets } : {}),
    ...(typeof v.simulatedAt === 'string' ? { simulatedAt: v.simulatedAt } : {}),
    ...(keys.length > 0 ? { simulatedKeys: keys } : {}),
    ...(v.resetPending === true ? { resetPending: true } : {}),
    ...(resetPageIds.length > 0 ? { resetPageIds } : {}),
  };
}

/** Remembered demo page ids, "Defer CSV export" first (empty before "Load demo data"). */
export async function listDemoPageIds(repo: Pick<SeedDeps['repo'], 'getAppValue'>): Promise<string[]> {
  return demoPageIds(await readDemoState(repo));
}

/** Demo page ids, the "Defer CSV export" page first; only that one for states written before the Lumora pages. */
function demoPageIds(state: DemoState): string[] {
  const ids = state.pageId ? [state.pageId] : [];
  for (const id of Object.values(state.pages ?? {})) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/** The `DEMO_PAGES` entry a page id belongs to. */
function demoPageOf(state: DemoState, pageId: string): DemoPage | undefined {
  if (pageId === state.pageId) return DEMO_PAGES[0];
  const slug = Object.entries(state.pages ?? {}).find(([, id]) => id === pageId)?.[0];
  return DEMO_PAGES.find((p) => p.slug === slug);
}

/** The state "Reset demo" leaves behind: only the demo pages. */
const baseState = (state: DemoState): DemoState => ({
  ...(state.pageId ? { pageId: state.pageId } : {}),
  ...(state.pages ? { pages: state.pages } : {}),
});

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

/**
 * Runs `body` under the named lock. Kept for the `LOCK_SECONDS` cooldown on success when `cooldown` (search lags
 * behind writes), also when a background job held it longer.
 */
async function withLock<T>(deps: SeedDeps, name: string, cooldown: boolean, body: () => Promise<T>): Promise<T> {
  const seconds = lockSecondsOf(deps);
  if (!(await deps.repo.acquireAppLock(name, new Date(deps.now()).toISOString(), seconds))) throw new SeedError(BUSY_MESSAGE);
  let ok = false;
  try {
    const result = await body();
    ok = true;
    return result;
  } finally {
    if (!ok || !cooldown || seconds !== LOCK_SECONDS) await deps.repo.releaseAppLock(name);
    if (ok && cooldown && seconds !== LOCK_SECONDS) await deps.repo.acquireAppLock(name, new Date(deps.now()).toISOString(), LOCK_SECONDS);
  }
}

export interface LoadDemoPage {
  slug: string;
  title: string;
  team: string;
  pageId: string;
  pageUrl?: string;
  created: boolean;
  extractionQueued: boolean;
}

export interface LoadDemoResult {
  projectKey: string;
  revisitProjectKey: string;
  issueCount: number;
  billingIssueCount: number;
  spaceKey: string;
  /** The "Defer CSV export" page. */
  pageId: string;
  pageUrl?: string;
  /** Every demo page handled by this click, "Defer CSV export" first. */
  pages: LoadDemoPage[];
  /** False when time ran out before every page was handled: click again after the cooldown. */
  complete: boolean;
  /** Whether the caller can edit the demo page (needed to accept its tripwire); null when it could not be checked. */
  canEdit: boolean | null;
  /** Extraction job of the "Defer CSV export" page. */
  extractionJobId?: string;
  extractionsQueued: number;
  created: { project: boolean; issues: number; billingIssues: number; space: boolean; page: boolean; label: boolean; pages: number };
}

/** Creates the missing baseline tickets for one demo JQL; returns [existing, created]. */
async function topUp(deps: SeedDeps, jql: string, want: number, summaries: readonly string[], make: (s: string) => ReturnType<typeof ticket>, fresh: boolean): Promise<[number, number]> {
  const existing = fresh ? 0 : await deps.jira.countIssues(jql);
  const missing = Math.max(0, want - existing);
  if (missing > 0) await deps.jira.bulkCreateIssues(DEMO.projectKey, summaries.slice(0, missing).map(make));
  return [existing, missing];
}

/**
 * Idempotent demo setup: creates what is missing (project SUP, 7 `export` and 2 `billing` tickets, space DEC, the
 * eight labelled Lumora decision pages with "Defer CSV export" first), adds SUP to the settings and queues
 * extraction of every page that is new, newly labelled or has no decision yet. The Radar scan follows on its own
 * (each finished extraction queues one). A 60 s lock covers double clicks and Jira's search lag.
 */
export async function loadDemoData(accountId: string, deps: SeedDeps): Promise<LoadDemoResult> {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(accountId)) throw new SeedError('Unknown user.');
  const { jira, confluence, repo } = deps;
  // Validate the merged settings before creating anything.
  const settings = demoSettings(await repo.getSettings());

  return withLock(deps, LOAD_LOCK, true, async () => {
    const deadline = deps.now() + budgetOf(deps);
    await report(deps, 1, LOAD_STEPS, 'Creating Jira project SUP and the baseline tickets');
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

    const [existing, missing] = await topUp(deps, DEMO_JQL, DEMO.baselineTickets, BASELINE_SUMMARIES, (s) => ticket(s), projectCreated);
    const [billingExisting, billingMissing] = await topUp(
      deps,
      BILLING_JQL,
      BILLING.baselineTickets,
      BILLING_BASELINE_SUMMARIES,
      (s) => billingTicket(s),
      projectCreated,
    );

    // Before the pages exist, so their extraction already allows JQL in SUP.
    await repo.saveSettings(settings);

    await report(deps, 2, LOAD_STEPS, 'Creating Confluence space DEC');
    let spaceCreated = false;
    let space = await confluence.findSpace(DEMO.spaceKey);
    if (!space) {
      space = await confluence.createSpace(DEMO.spaceKey, DEMO.spaceName, 'Product and engineering decisions. Demo data created by Tripwire.');
      spaceCreated = true;
    }

    const today = isoDay(deps.now());
    const state = await readDemoState(repo);
    const pageIds: Record<string, string> = { ...(state.pages ?? {}) };
    const pages: LoadDemoPage[] = [];
    let mainLabelAdded = false;
    let extractionJobId: string | undefined;
    let complete = true;
    for (const [index, demo] of DEMO_PAGES.entries()) {
      // Pages already handled are cheap to check again, so a click after a timeout simply continues.
      if (deps.now() >= deadline) {
        complete = false;
        break;
      }
      await report(deps, 3 + index, LOAD_STEPS, `Decision page ${index + 1} of ${DEMO_PAGES.length}: ${demo.title}`);
      let created = false;
      let page = await confluence.findPageByTitle(space.id, demo.title);
      if (!page) {
        page = await confluence.createPage(space.id, demo.title, demo.storage(today));
        created = true;
      }
      // The page must carry the label Tripwire watches, which the admin may have changed from `decision`.
      let labelAdded = false;
      if (!(await confluence.getPageLabels(page.id)).includes(settings.decisionLabel)) {
        await confluence.addPageLabel(page.id, settings.decisionLabel);
        labelAdded = true;
      }
      pageIds[demo.slug] = page.id;
      // Remember the page before queueing work for it, so "Reset demo" can always find it.
      await repo.setAppValue(DEMO_STATE_KEY, { ...state, pageId: pageIds[MAIN_SLUG] ?? state.pageId, pages: { ...pageIds } });

      // Adding a label fires no page event, so queue extraction ourselves; the caller becomes the decision owner.
      const queue = created || labelAdded || !(await repo.getDecisionByPage(page.id));
      const jobId = queue ? await deps.enqueueExtraction(page.id, false, accountId) : undefined;
      if (demo.slug === MAIN_SLUG) {
        mainLabelAdded = labelAdded;
        extractionJobId = jobId;
      }
      pages.push({
        slug: demo.slug,
        title: demo.title,
        team: demo.team,
        pageId: page.id,
        ...(page.webUrl ? { pageUrl: page.webUrl } : {}),
        created,
        extractionQueued: jobId !== undefined,
      });
    }
    const main = pages[0] as LoadDemoPage;

    // The space is created as the app and apps cannot grant space permissions, so check the caller can edit
    // the page instead of assuming the site's default space permissions apply.
    let canEdit: boolean | null;
    try {
      canEdit = await confluence.canEditPage(main.pageId);
    } catch (err) {
      console.warn('tripwire loadDemoData: could not check page access', { pageId: main.pageId, error: err instanceof Error ? err.message : String(err) });
      canEdit = null;
    }

    return {
      projectKey: DEMO.projectKey,
      revisitProjectKey: settings.revisitProjectKey ?? DEMO.projectKey,
      issueCount: existing + missing,
      billingIssueCount: billingExisting + billingMissing,
      spaceKey: space.key,
      pageId: main.pageId,
      ...(main.pageUrl ? { pageUrl: main.pageUrl } : {}),
      pages,
      complete,
      canEdit,
      ...(extractionJobId ? { extractionJobId } : {}),
      extractionsQueued: pages.filter((p) => p.extractionQueued).length,
      created: {
        project: projectCreated,
        issues: missing,
        billingIssues: billingMissing,
        space: spaceCreated,
        page: main.created,
        label: mainLabelAdded,
        pages: pages.filter((p) => p.created).length,
      },
    };
  });
}

export interface SimulateResult {
  /** Tickets created by this click (0 when an earlier click already created them). */
  created: number;
  issueCount: number;
  billingIssueCount: number;
  /** False when Jira search had not caught up with the new tickets; evaluation is skipped then. */
  indexed: boolean;
  passes: ({ total: number; rateLimited: boolean } & ReturnType<typeof summarise>)[];
  /** False when fewer than two passes ran (time budget, rate limit or search lag): click again to finish. */
  complete: boolean;
  revisits: { tripwireId: string; issueKey: string }[];
  /** Proposed tripwires of the other Lumora pages confirmed by this click (as the admin who clicked). */
  confirmed: number;
  /** Date/checkin/content_change tripwires of the other Lumora pages sent to the evaluate queue (Revisits follow within a minute). */
  queued: number;
}

/** Demo page body after "Simulate a busy month" edited it (same text plus a dated review note, so edits never pile up). */
export const simulatedPageStorage = (day: string, base: string = DEMO_PAGE_STORAGE): string =>
  `${base}<p><em>Reviewed ${day} (demo edit by Tripwire "Simulate a busy month").</em></p>`;

/** Version message of the edit that moves a date tripwire's date in the page text too. */
export const DATE_EDIT_MESSAGE = 'Demo date moved by Tripwire "Simulate a busy month"';

/** A page's date edit is only started while this long is left of the Simulate budget (lock, read, write, re-read). */
export const DATE_EDIT_PAGE_MS = 6_000;

const ISO_DAY_IN_TEXT = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g;
/** Every `day` (YYYY-MM-DD) in a text, not as part of a longer number. */
const dayPattern = (day: string): RegExp => new RegExp(String.raw`(?<!\d)${day}(?!\d)`, 'g');
const containsDay = (text: string, day: string): boolean => dayPattern(day).test(text);
/** Innermost paragraph-like elements of a storage body (a list item holding a paragraph is one block). */
const BLOCK = /<(p|li|td|th|h[1-6])\b[^>]*>[\s\S]*?<\/\1>/g;

interface DateMove {
  assumptionId: string;
  /** The assumption quote the date is moved in: only the page block holding this quote is edited. */
  quote: string;
  from: string;
  to: string;
}

/**
 * The date the text of a date tripwire's assumption still says, when it differs from the tripwire's date `to`:
 * the previous date of the tripwire when the quote has it, else the quote's only date. Read from the stored quote
 * (updated only after the page was written), so a page write that failed is made up on the next click.
 */
function dateMoveOf(assumption: Assumption, previous: string, to: string): DateMove | undefined {
  const days = [...new Set(assumption.quote.match(ISO_DAY_IN_TEXT) ?? [])];
  const from = days.includes(previous) ? previous : days.length === 1 ? days[0] : undefined;
  return from === undefined || from === to ? undefined : { assumptionId: assumption.id, quote: assumption.quote, from, to };
}

/** `body` with each move's date replaced only inside the block that holds the move's quote; the moves applied. */
function moveDatesInBlocks(body: string, moves: readonly DateMove[]): { body: string; applied: DateMove[] } {
  const applied = new Set<DateMove>();
  const updated = body.replace(BLOCK, (block) => {
    const text = storageToText(block, Number.MAX_SAFE_INTEGER);
    return moves.reduce((acc, m) => {
      if (!containsDay(acc, m.from) || !quoteInText(m.quote, text)) return acc;
      applied.add(m);
      return acc.replace(dayPattern(m.from), m.to);
    }, block);
  });
  return { body: updated, applied: moves.filter((m) => applied.has(m)) };
}

/** Version message of the edit that trips a content_change tripwire. */
export const CONTENT_EDIT_MESSAGE = 'Demo edit by Tripwire "Simulate a busy month"';
/** The review note of an earlier Simulate edit (also as Confluence re-serialises it), removed before a new one is added. */
const SIMULATED_NOTE = /<p>\s*<em>\s*Reviewed \d{4}-\d{2}-\d{2} \(demo edit by Tripwire (?:"|&quot;|&#34;)Simulate a busy month(?:"|&quot;|&#34;)\)\.\s*<\/em>\s*<\/p>/g;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The one Simulate write to a demo page (several writes in a row got 409 CONFLICT: a re-read right after a write may
 * still return the old version). It moves the dates in the assumption sentences (`moves`, other sentences keep
 * theirs) and, when `watched`, adds the dated review note that trips the page's content_change tripwires. The body
 * is the page as read now (an earlier review note removed), never the template, so a moved date is not written
 * back; `base` is only used when the page body is empty. The `extract` page lock is held as by the "Reviewed by"
 * stamp. A dates-only edit moves the extracted page version and the content_change baselines to the new version
 * first (`rememberedVersion`), so it neither re-extracts nor trips content_change. A page edited after it was read
 * is not overwritten. Never throws: a page that could not be written is logged, and the next click makes the dates
 * up (they are read from the stored quotes, updated only after a write). Returns whether the review note was written.
 */
async function editDemoPage(
  pageId: string,
  edit: { moves: readonly DateMove[]; watched: boolean; base: string; day: string },
  deadline: number,
  deps: SeedDeps,
): Promise<boolean> {
  const { repo } = deps;
  if (edit.moves.length === 0 && !edit.watched) return false;
  const lockedAt = deps.now();
  const heldUntil = new Date(lockedAt + STAMP_LOCK_SECONDS * 1000).toISOString();
  let locked = false;
  try {
    locked = await repo.acquirePageLock(pageId, 'extract', new Date(lockedAt).toISOString(), STAMP_LOCK_SECONDS);
    let moves = edit.moves;
    if (moves.length > 0 && !locked) {
      console.warn('tripwire simulateBusyMonth: page is being extracted, its text keeps the old date until the next click', { pageId });
      moves = [];
    }
    if (moves.length > 0 && deps.now() + DATE_EDIT_PAGE_MS > deadline) {
      console.warn('tripwire simulateBusyMonth: not enough time left to move the date in the page text, next click does it', { pageId });
      moves = [];
    }
    if (moves.length === 0 && !edit.watched) return false;

    const page = await deps.confluence.getPage(pageId, true);
    const read = page.body ?? '';
    const { body: dated, applied } = moveDatesInBlocks(read, moves);
    if (moves.length > 0 && applied.length === 0) {
      console.warn('tripwire simulateBusyMonth: old date not in the assumption text, dates left as is', { pageId, dates: moves.map((m) => m.from) });
    }
    if (applied.length === 0 && !edit.watched) return false;
    const body = edit.watched ? simulatedPageStorage(edit.day, read.trim() === '' ? edit.base : dated.replace(SIMULATED_NOTE, '')) : dated;

    // A content_change edit has to trip its tripwires: then nothing is moved.
    const remembered = edit.watched ? undefined : await rememberedVersion(pageId, page.version, deps);
    const next = page.version + 1;
    await remembered?.moveTo(next);
    let saved: number;
    try {
      saved = await deps.confluence.updatePage(pageId, body, edit.watched ? CONTENT_EDIT_MESSAGE : DATE_EDIT_MESSAGE, page.version);
    } catch (err) {
      // As the stamp: keep the new version only when the write went through anyway (e.g. a timeout).
      const again = await deps.confluence.getPage(pageId, true).catch(() => undefined);
      const text = storageToText(again?.body ?? '', Number.MAX_SAFE_INTEGER);
      const savedAnyway =
        again !== undefined &&
        again.version > page.version &&
        applied.every((m) => quoteInText(m.quote.split(m.from).join(m.to), text)) &&
        (!edit.watched || text.includes(`Reviewed ${edit.day}`));
      if (!savedAnyway) {
        await remembered?.moveTo(page.version);
        throw err;
      }
      saved = again.version;
    }
    // Confluence numbers the version itself; follow it when it differs from the one asked for (as the stamp does).
    if (saved !== next) await remembered?.moveTo(saved);
    for (const m of applied) await repo.replaceInAssumption(m.assumptionId, m.from, m.to);
    return edit.watched;
  } catch (err) {
    console.warn('tripwire simulateBusyMonth: demo page not edited, the next click tries again', { pageId, error: errorText(err) });
    return false;
  } finally {
    // An expired lock may belong to an extraction by now: leave it (and only free our own).
    if (locked && deps.now() < Date.parse(heldUntil)) {
      await repo.releasePageLock(pageId, 'extract', heldUntil).catch((err: unknown) => {
        console.warn('tripwire simulateBusyMonth: lock release failed', { pageId, error: errorText(err) });
      });
    }
  }
}

/**
 * Moves the demo's non-numeric tripwires a month on, so one evaluation trips them: a date tripwire's date becomes
 * yesterday (in its assumption sentence too), a check-in's last answer goes one period plus a day back, and a
 * watched page gets a new version. Only `active`/`near` tripwires are aged (by CAS); handled dates stay handled.
 * The page gets at most one write (`editDemoPage`), so a page with a date and a content_change tripwire is not
 * written twice; a failed write never fails Simulate. Returns how many were moved.
 */
async function ageDemoTripwires(pageId: string, base: string, tripwires: readonly TripwireRow[], deadline: number, deps: SeedDeps): Promise<number> {
  const { repo } = deps;
  const now = deps.now();
  let aged = 0;
  let watched = false;
  // Every date tripwire with the date its text should say (also ones aged by an earlier click, so a failed write is made up).
  const dated: { t: TripwireRow; previous: string; to: string }[] = [];
  for (const t of tripwires) {
    if (t.kind === 'date' && !(t.spec as DateSpec).resolved) {
      const spec = t.spec as DateSpec;
      const date = isoDay(now - DAY_MS);
      const moved = (t.status === 'active' || t.status === 'near') && (await repo.casTripwire(t.id, [t.status], { spec: { ...spec, date } }));
      if (moved) aged += 1;
      dated.push({ t, previous: spec.date, to: moved ? date : spec.date });
    }
    if (t.status !== 'active' && t.status !== 'near') continue;
    if (t.kind === 'checkin') {
      const days = PERIOD_DAYS[(t.spec as CheckinSpec).every] + 1;
      if (await repo.casTripwire(t.id, [t.status], { confirmedAt: new Date(now - days * DAY_MS).toISOString() })) aged += 1;
    } else if (t.kind === 'content_change') {
      watched = true;
    }
  }

  let moves: DateMove[] = [];
  if (dated.length > 0) {
    const decision = await repo.getDecisionByPage(pageId);
    const assumptions = new Map((decision ? await repo.listAssumptions(decision.id) : []).map((a) => [a.id, a]));
    moves = dated.flatMap(({ t, previous, to }) => {
      const assumption = assumptions.get(t.assumptionId);
      const move = assumption ? dateMoveOf(assumption, previous, to) : undefined;
      return move ? [move] : [];
    });
  }
  if (await editDemoPage(pageId, { moves, watched, base, day: isoDay(now) }, deadline, deps)) aged += 1;
  return aged;
}

/**
 * Confirms the proposed tripwires of the Lumora pages other than "Defer CSV export" as the admin who clicked, so
 * the video does not need seven Accept clicks. Only pages the admin can edit (the same check as Accept) are
 * touched. "Defer CSV export" is never confirmed here: its owner accepts it on camera.
 */
async function confirmOtherDemoTripwires(pageIds: readonly string[], accountId: string, deps: SeedDeps): Promise<number> {
  const { repo } = deps;
  // Pages in parallel: done one by one, the access checks alone used up most of Simulate's time budget.
  const perPage = await Promise.all(
    pageIds.map(async (pageId) => {
      const decision = await repo.getDecisionByPage(pageId);
      if (!decision) return 0;
      const proposed = (await repo.listTripwires(decision.id)).filter((t) => t.status === 'proposed');
      if (proposed.length === 0) return 0;
      let canEdit = false;
      try {
        canEdit = await deps.confluence.canEditPage(pageId);
      } catch (err) {
        console.warn('tripwire simulateBusyMonth: could not check page access', { pageId, error: err instanceof Error ? err.message : String(err) });
      }
      if (!canEdit) return 0;
      const confirmedAt = new Date(deps.now()).toISOString();
      let confirmed = 0;
      for (const t of proposed) {
        const patch = { status: 'active' as const, confirmedBy: accountId, confirmedAt, baselineVersion: t.kind === 'content_change' ? (decision.pageVersion ?? null) : null };
        if (await repo.casTripwire(t.id, ['proposed'], patch)) confirmed += 1;
      }
      return confirmed;
    }),
  );
  return perPage.reduce((sum, n) => sum + n, 0);
}

/** Waits until Jira's approximate counts see at least the target number of demo tickets (search is eventually consistent). */
async function waitForCounts(target: number, billingTarget: number, deps: SeedDeps): Promise<{ count: number; billing: number; indexed: boolean }> {
  const deadline = deps.now() + indexWaitOf(deps);
  for (;;) {
    const [count, billing] = await Promise.all([deps.jira.countIssues(DEMO_JQL), deps.jira.countIssues(BILLING_JQL)]);
    if (count >= target && billing >= billingTarget) return { count, billing, indexed: true };
    if (deps.now() >= deadline) return { count, billing, indexed: false };
    await deps.sleep(indexPollOf(deps));
  }
}

/**
 * "A busy month": adds 30 `export` and 6 `billing` tickets to SUP once, confirms the other Lumora pages' proposed
 * tripwires, moves the date/checkin/content_change tripwires a month on (`ageDemoTripwires`), then evaluates the
 * "Defer CSV export" tripwires and every Jira-count tripwire of the demo twice in a row so a crossed threshold gets
 * its two strikes, trips and opens a Revisit task (inline, no queue). The other demo tripwires trip on one
 * reading and go to the evaluate queue. The tickets are remembered in the `demo` app value: when time runs out,
 * clicking again only evaluates.
 */
export async function simulateBusyMonth(deps: SeedDeps, accountId: string): Promise<SimulateResult> {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(accountId)) throw new SeedError('Unknown user.');
  const { jira, repo } = deps;
  const deadline = deps.now() + budgetOf(deps);
  const state = await readDemoState(repo);
  if (!state.pageId || !(await jira.getProject(DEMO.projectKey))) throw new SeedError('Run "Load demo data" first.');
  if (state.resetPending || state.resetPageIds) throw new SeedError(`"Reset demo" has not finished: ${INDEX_LAG_MESSAGE} Click "Reset demo" again.`);
  const mainPageId = state.pageId;
  const mainDecision = await repo.getDecisionByPage(mainPageId);
  const mainIds = mainDecision ? (await repo.listTripwires(mainDecision.id)).filter((t) => EVALUABLE_STATUSES.includes(t.status)).map((t) => t.id) : [];
  if (mainIds.length === 0) {
    throw new SeedError(`No confirmed tripwires yet. Open "${DEMO.pageTitle}" in Confluence and accept its tripwire first.`);
  }
  const otherPageIds = demoPageIds(state).filter((id) => id !== mainPageId);

  return withLock(deps, SIMULATE_LOCK, false, async () => {
    const started = deps.now();
    await report(deps, 1, SIMULATE_STEPS, 'Creating the busy month tickets and confirming the other demo tripwires');
    let created = 0;
    let target = 0;
    let billingTarget = 0;
    // The seven supporting decisions need no Accept on camera. Runs alongside the ticket creation (the two touch
    // different data), so the first click still has time left for both evaluation passes.
    const confirming = otherPageIds.length > 0 ? confirmOtherDemoTripwires(otherPageIds, accountId, deps) : Promise.resolve(0);
    // Never left unobserved if the ticket creation below throws first.
    confirming.catch(() => undefined);
    if (state.simulatedTickets === undefined) {
      const [before, billingBefore] = await Promise.all([jira.countIssues(DEMO_JQL), jira.countIssues(BILLING_JQL)]);
      const keys = await jira.bulkCreateIssues(DEMO.projectKey, [
        ...Array.from({ length: DEMO.busyMonthTickets }, (_, i) => ticket(busySummary(i), [SIM_LABEL])),
        ...Array.from({ length: BILLING.busyMonthTickets }, (_, i) => billingTicket(BILLING_BUSY_SUMMARIES[i % BILLING_BUSY_SUMMARIES.length] as string, [SIM_LABEL])),
      ]);
      created = keys.length;
      target = before + Math.min(created, DEMO.busyMonthTickets);
      billingTarget = billingBefore + Math.max(0, created - DEMO.busyMonthTickets);
      await repo.setAppValue(DEMO_STATE_KEY, {
        ...state,
        simulatedTickets: created,
        simulatedKeys: keys,
        simulatedAt: new Date(deps.now()).toISOString(),
      });
    }

    const confirmed = await confirming;
    const prepared = deps.now();
    await report(deps, 2, SIMULATE_STEPS, 'Waiting for Jira search to count the new tickets');
    const { count, billing, indexed } = await waitForCounts(target, billingTarget, deps);

    // Every evaluable demo tripwire, per page (read after confirming).
    const inline = [...mainIds];
    const queued: string[] = [];
    const pageTripwires: { pageId: string; tripwires: TripwireRow[] }[] = [];
    for (const pageId of demoPageIds(state)) {
      const decision = pageId === mainPageId ? mainDecision : await repo.getDecisionByPage(pageId);
      if (!decision) continue;
      const tripwires = (await repo.listTripwires(decision.id)).filter((t) => EVALUABLE_STATUSES.includes(t.status));
      pageTripwires.push({ pageId, tripwires });
      if (pageId === mainPageId) continue;
      for (const t of tripwires) (t.kind === 'jql_threshold' ? inline : queued).push(t.id);
    }

    // A month passes for the date/checkin/content_change tripwires too, so the same evaluation trips them.
    // Pages in parallel (a content_change tripwire edits its page: two Confluence calls each).
    if (indexed) {
      await report(deps, 3, SIMULATE_STEPS, 'Moving dates, check-ins and pages a month on');
      const agedPerPage = await Promise.all(
        pageTripwires.map(({ pageId, tripwires }) => ageDemoTripwires(pageId, demoPageOf(state, pageId)?.storage(isoDay(deps.now())) ?? DEMO_PAGE_STORAGE, tripwires, deadline, deps)),
      );
      const aged = agedPerPage.reduce((sum, n) => sum + n, 0);
      if (aged > 0) console.info('tripwire simulateBusyMonth: non-numeric tripwires moved a month on', { aged });
    }
    const evaluateFrom = deps.now();

    const passes: SimulateResult['passes'] = [];
    const revisitIds = new Set<string>();
    // A reading taken before search sees the tickets would reset the strikes, so skip evaluating then.
    while (indexed && passes.length < 2 && deps.now() < deadline) {
      await report(deps, 4 + passes.length, SIMULATE_STEPS, `Evaluating the Jira-count tripwires (pass ${passes.length + 1} of 2)`);
      const { results, rateLimited } = await deps.evaluate(inline);
      passes.push({ ...summarise(results), total: inline.length, rateLimited });
      for (const r of results) if (r.status === 'evaluated' && r.revisitRequested) revisitIds.add(r.tripwireId);
      if (rateLimited) break;
    }
    // One reading trips these; the queue keeps their Revisit tasks out of this 25 s invocation.
    if (indexed && queued.length > 0) await deps.enqueueEvaluation(queued);

    // Only each tripwire's own Revisit: a tripwire waiting behind another one's open Revisit is not listed, and an
    // issue key is listed once.
    const revisits: SimulateResult['revisits'] = [];
    for (const tripwireId of revisitIds) {
      const ctx = await repo.getTripwireContext(tripwireId);
      const revisit = ctx ? await repo.findOpenRevisit(ctx.decision.id) : undefined;
      if (!revisit || (revisit.tripwireId !== undefined && revisit.tripwireId !== tripwireId)) continue;
      if (revisits.some((r) => r.issueKey === revisit.issueKey)) continue;
      revisits.push({ tripwireId, issueKey: revisit.issueKey });
    }
    const complete = passes.length === 2 && !passes.some((p) => p.rateLimited);
    // Where the time budget went (a first click that ran out of time used to evaluate nothing).
    console.info('tripwire simulateBusyMonth timing', {
      prepareMs: prepared - started,
      indexAndAgeMs: evaluateFrom - prepared,
      evaluateMs: deps.now() - evaluateFrom,
      passes: passes.length,
    });
    return { created, issueCount: count, billingIssueCount: billing, indexed, passes, complete, revisits, confirmed, queued: indexed ? queued.length : 0 };
  });
}

export interface ResetDemoResult {
  /** Busy month tickets that lost their counted label (`export`/`billing`) in this click. */
  relabelled: number;
  /** Demo tickets still counted by the demo JQL (the baseline). */
  remaining: number;
  /** Revisit issues of demo decisions that were closed. */
  revisitIssueKeys: string[];
  /** Rows removed in this click, summed over the demo decisions; null when no decision was reset. */
  deleted: { tripwires: number; assumptions: number; evaluations: number; revisits: number } | null;
  /** Demo decisions reset (deleted and queued for extraction) in this click. */
  decisionsReset: number;
  /** Extraction job of the "Defer CSV export" page, when it was reset in this click. */
  extractionJobId?: string;
  extractionsQueued: number;
  /** False while Jira search has not caught up (busy month tickets missing or still counted): click again later. */
  indexed: boolean;
  /** False when the reset has to be repeated (time ran out or Jira search lagged); the simulate marker is kept then. */
  complete: boolean;
  /** Shown as is in the setup page when the reset is not complete. */
  message?: string;
  warnings: string[];
}

/** Most demo tickets "Reset demo" looks at (baseline + a few busy months). */
const RESET_SCAN_MAX = 300;
const RESET_PARALLEL = 5;
export const INDEX_LAG_MESSAGE = 'Jira index still catching up, retry in a minute.';
export const PAGE_BUSY_MESSAGE = 'A demo decision is busy (extraction or Revisit in progress), try again in a minute.';
const TIME_UP_MESSAGE = 'Time ran out while resetting the demo; click "Reset demo" again to finish.';
/** Demo tickets in SUP, including busy month tickets that already lost their counted label. */
const RESET_JQL = `project = ${DEMO.projectKey} AND (labels = ${DEMO.label} OR labels = ${BILLING.label} OR labels = ${SIM_LABEL})`;
/** Page locks shared with `openRevisit` and the extraction pipeline. */
const RESET_PAGE_LOCKS = ['revisit', 'extract'] as const;
const ARCHIVABLE = ['proposed', 'active', 'near', 'tripped', 'revisiting'] as const;

const resetComment = (): AdfDoc => doc('Closed by Tripwire "Reset demo": the demo decision was reset to its freshly loaded state.');

/**
 * Puts the demo back to the state right after "Load demo data" so the story can be replayed: the busy month
 * tickets lose their `export`/`billing` label (they keep `SIM_LABEL`, nothing is deleted), each demo decision's
 * open Revisit issue is moved to Done, every demo decision and all its rows (Radar pairs included) are deleted,
 * the Lumora pages get today's dates again and every page is extracted again (tripwires come back as `proposed`),
 * and the "simulated" marker is cleared once Jira search agrees. Only issues in SUP that `isSimulatedTicket`
 * recognises and the decisions of the remembered demo pages are touched. Holds both demo app locks and every demo
 * page's revisit/extract locks, so no evaluation, Revisit or extraction of a demo page can write rows meanwhile.
 */
export async function resetDemo(accountId: string, deps: SeedDeps): Promise<ResetDemoResult> {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(accountId)) throw new SeedError('Unknown user.');
  const { repo } = deps;
  const state = await readDemoState(repo);
  if (!state.pageId) throw new SeedError('Nothing to reset: run "Load demo data" first.');
  const pageIds = demoPageIds(state);

  // Load and Simulate locks: a reset racing either would leave half-counted tickets behind.
  return withLock(deps, LOAD_LOCK, false, () =>
    withLock(deps, SIMULATE_LOCK, false, async () => {
      const held: [string, (typeof RESET_PAGE_LOCKS)[number]][] = [];
      const release = async (): Promise<void> => {
        for (const [pageId, lock] of held) {
          await repo.releasePageLock(pageId, lock).catch((err: unknown) => {
            console.warn('tripwire resetDemo: page lock release failed', { pageId, lock, error: err instanceof Error ? err.message : String(err) });
          });
        }
      };
      let outcome: { result: ResetDemoResult; resetPageIds: string[] };
      try {
        for (const pageId of pageIds) {
          for (const lock of RESET_PAGE_LOCKS) {
            if (!(await repo.acquirePageLock(pageId, lock, new Date(deps.now()).toISOString(), lockSecondsOf(deps)))) throw new SeedError(PAGE_BUSY_MESSAGE);
            held.push([pageId, lock]);
          }
        }
        outcome = await resetLocked(pageIds, state, deps);
      } finally {
        await release();
      }
      // After the locks are gone, or the extraction would find the page locked.
      const { result } = outcome;
      for (const pageId of outcome.resetPageIds) {
        const jobId = await deps.enqueueExtraction(pageId, true, accountId);
        result.extractionsQueued += 1;
        if (pageId === state.pageId) result.extractionJobId = jobId;
      }
      return result;
    }),
  );
}

async function resetLocked(pageIds: readonly string[], state: DemoState, deps: SeedDeps): Promise<{ result: ResetDemoResult; resetPageIds: string[] }> {
  const { jira, repo } = deps;
  const deadline = deps.now() + budgetOf(deps);
  const warnings: string[] = [];
  const revisitIssueKeys: string[] = [];
  const resetPageIds: string[] = [];
  let relabelled = 0;
  let remaining = 0;
  let remainingBilling = 0;
  const totals = { tripwires: 0, assumptions: 0, evaluations: 0, revisits: 0 };
  let deletedAny = false;
  const result = (indexed: boolean, complete: boolean, message?: string): { result: ResetDemoResult; resetPageIds: string[] } => ({
    result: {
      relabelled,
      remaining,
      revisitIssueKeys,
      deleted: deletedAny ? { ...totals } : null,
      decisionsReset: resetPageIds.length,
      extractionsQueued: 0,
      indexed,
      complete,
      ...(message ? { message } : {}),
      warnings,
    },
    resetPageIds,
  });

  if (await jira.getProject(DEMO.projectKey)) {
    await report(deps, 1, RESET_STEPS, 'Relabelling the busy month tickets');
    const tickets = await jira.searchIssues(RESET_JQL, RESET_SCAN_MAX);
    const keys = new Set(state.simulatedKeys ?? []);
    const simulated = tickets.filter((t) => keys.has(t.key) || isSimulatedTicket(t));
    const baseline = tickets.filter((t) => !simulated.includes(t));
    remaining = baseline.filter((t) => t.labels.includes(DEMO.label)).length;
    remainingBilling = baseline.filter((t) => t.labels.includes(BILLING.label)).length;
    // Keys from Simulate are relabelled whether or not search sees them yet; found tickets only while they are counted.
    const counted = (labels: readonly string[]): string[] => COUNTED_LABELS.filter((l) => labels.includes(l));
    const toRelabel = new Map<string, string[]>();
    for (const key of keys) toRelabel.set(key, [...COUNTED_LABELS]);
    for (const t of simulated) {
      const labels = counted(t.labels);
      if (labels.length > 0) toRelabel.set(t.key, labels);
      else if (keys.has(t.key)) toRelabel.delete(t.key);
    }
    const entries = [...toRelabel.entries()];
    for (let i = 0; i < entries.length; i += RESET_PARALLEL) {
      if (deps.now() >= deadline) return result(true, false, TIME_UP_MESSAGE);
      const batch = entries.slice(i, i + RESET_PARALLEL);
      await Promise.all(batch.map(([key, remove]) => jira.updateLabels(key, [SIM_LABEL], remove)));
      relabelled += batch.length;
    }
    // Without remembered keys, a busy month search cannot see yet would keep counting after the reset.
    if (keys.size === 0 && state.simulatedTickets !== undefined && simulated.length < state.simulatedTickets) {
      return result(false, false, INDEX_LAG_MESSAGE);
    }
  }

  // A previous click that ran out of time (or waited on Jira search) already reset these; their extraction may
  // have recreated the decision, which must not be deleted again.
  const done = new Set(state.resetPending ? pageIds : (state.resetPageIds ?? []));
  const today = isoDay(deps.now());
  await report(deps, 2, RESET_STEPS, 'Resetting the demo decisions');
  for (const pageId of pageIds) {
    if (done.has(pageId)) continue;
    if (deps.now() >= deadline) {
      await repo.setAppValue(DEMO_STATE_KEY, { ...state, resetPageIds: [...done] });
      return result(true, false, TIME_UP_MESSAGE);
    }
    const decision = await repo.getDecisionByPage(pageId);
    if (decision) {
      // Archive first: an evaluation that read the tripwire before the locks were taken then loses its CAS.
      for (const t of await repo.listTripwires(decision.id)) {
        await repo.casTripwire(t.id, ARCHIVABLE, { status: 'archived' });
      }
      const open = await repo.findOpenRevisit(decision.id);
      if (open) {
        revisitIssueKeys.push(open.issueKey);
        try {
          if (!(await jira.transitionToDone(open.issueKey))) warnings.push(`${open.issueKey} has no transition to Done; close it in Jira.`);
          await jira.addComment(open.issueKey, resetComment());
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn('tripwire resetDemo: could not close Revisit issue', { issueKey: open.issueKey, error: msg });
          warnings.push(`Could not close ${open.issueKey}: ${msg}`);
        }
      }
      const rows = await repo.deleteDecisionTree(decision.id);
      totals.tripwires += rows.tripwires;
      totals.assumptions += rows.assumptions;
      totals.evaluations += rows.evaluations;
      totals.revisits += rows.revisits;
      deletedAny = true;
    }
    // Lumora pages get today's dates back (and lose the Simulate edit); "Defer CSV export" has fixed dates.
    const demo = pageId === state.pageId ? undefined : demoPageOf(state, pageId);
    if (demo && deps.now() < deadline) {
      try {
        await deps.confluence.updatePage(pageId, demo.storage(today), 'Demo reset by Tripwire: dates moved to today');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('tripwire resetDemo: could not refresh demo page', { pageId, error: msg });
        warnings.push(`Could not refresh "${demo.title}": ${msg}`);
      }
    }
    done.add(pageId);
    resetPageIds.push(pageId);
  }

  let indexed = true;
  if (state.simulatedTickets !== undefined || relabelled > 0) {
    await report(deps, 3, RESET_STEPS, 'Waiting for Jira search to stop counting the busy month tickets');
    const waitUntil = deps.now() + indexWaitOf(deps);
    for (;;) {
      const [count, billing] = await Promise.all([jira.countIssues(DEMO_JQL), jira.countIssues(BILLING_JQL)]);
      if (count <= remaining && billing <= remainingBilling) break;
      if (deps.now() >= waitUntil) {
        indexed = false;
        break;
      }
      await deps.sleep(indexPollOf(deps));
    }
  }
  if (!indexed) {
    // Keep the marker: Simulate would otherwise start from a stale count. The decisions are already reset.
    const pending: DemoState = { ...state, resetPending: true };
    delete pending.resetPageIds;
    await repo.setAppValue(DEMO_STATE_KEY, pending);
    return result(false, false, INDEX_LAG_MESSAGE);
  }
  await repo.setAppValue(DEMO_STATE_KEY, baseState(state));
  return result(true, true);
}
