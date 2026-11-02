/** App-wide settings, edited on the Jira admin page and stored in the SQL `settings` table. */
export interface Settings {
  /** Jira project that receives Revisit tasks. */
  revisitProjectKey?: string;
  /** Confluence label that marks a page as a decision. */
  decisionLabel: string;
  /** Confluence space keys to watch; empty means every space. */
  watchedSpaceKeys: string[];
  /** Jira projects that JQL tripwires may count in (counts run as the app). Empty means no JQL tripwires. */
  allowedProjectKeys: string[];
}

export const DEFAULT_SETTINGS: Settings = { decisionLabel: 'decision', watchedSpaceKeys: [], allowedProjectKeys: [] };

export const MAX_WATCHED_SPACES = 20;
export const MAX_ALLOWED_PROJECTS = 20;

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;
const SPACE_KEY = /^~?[A-Za-z0-9_-]{1,255}$/;
const LABEL = /^[^\s]{1,255}$/;

export class SettingsError extends Error {}

function asString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new SettingsError(`${field} must be a string.`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Validates and canonicalises raw input (browser payload or stored JSON). Throws `SettingsError` on bad input. */
export function normaliseSettings(input: unknown): Settings {
  if (input === undefined || input === null) return { ...DEFAULT_SETTINGS, watchedSpaceKeys: [], allowedProjectKeys: [] };
  if (typeof input !== 'object' || Array.isArray(input)) throw new SettingsError('Settings must be an object.');
  const raw = input as Record<string, unknown>;

  const projectKey = asString(raw.revisitProjectKey, 'revisitProjectKey')?.toUpperCase();
  if (projectKey !== undefined && !PROJECT_KEY.test(projectKey)) {
    throw new SettingsError(`"${projectKey}" is not a valid Jira project key.`);
  }

  const label = (asString(raw.decisionLabel, 'decisionLabel') ?? DEFAULT_SETTINGS.decisionLabel).toLowerCase();
  if (!LABEL.test(label)) throw new SettingsError('The decision label cannot contain spaces.');

  const rawSpaces = raw.watchedSpaceKeys ?? [];
  if (!Array.isArray(rawSpaces)) throw new SettingsError('watchedSpaceKeys must be a list.');
  const spaces = [...new Set(rawSpaces.map((s) => asString(s, 'watchedSpaceKeys')).filter((s): s is string => s !== undefined))];
  if (spaces.length > MAX_WATCHED_SPACES) throw new SettingsError(`Watch at most ${MAX_WATCHED_SPACES} spaces.`);
  const invalid = spaces.find((s) => !SPACE_KEY.test(s));
  if (invalid !== undefined) throw new SettingsError(`"${invalid}" is not a valid Confluence space key.`);

  // Settings saved before this field existed default to the Revisit project; an explicit [] stays empty.
  const rawProjects = raw.allowedProjectKeys ?? (projectKey !== undefined ? [projectKey] : []);
  if (!Array.isArray(rawProjects)) throw new SettingsError('allowedProjectKeys must be a list.');
  const projects = [
    ...new Set(
      rawProjects.map((p) => asString(p, 'allowedProjectKeys')?.toUpperCase()).filter((p): p is string => p !== undefined),
    ),
  ];
  if (projects.length > MAX_ALLOWED_PROJECTS) throw new SettingsError(`Allow at most ${MAX_ALLOWED_PROJECTS} Jira projects.`);
  const invalidProject = projects.find((p) => !PROJECT_KEY.test(p));
  if (invalidProject !== undefined) throw new SettingsError(`"${invalidProject}" is not a valid Jira project key.`);

  return {
    ...(projectKey !== undefined ? { revisitProjectKey: projectKey } : {}),
    decisionLabel: label,
    watchedSpaceKeys: spaces,
    allowedProjectKeys: projects,
  };
}
