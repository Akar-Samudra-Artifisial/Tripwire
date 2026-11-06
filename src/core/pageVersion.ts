import type { Repo, TripwireRow } from '../adapters/repo';
import type { ContentChangeSpec, TripwireStatus } from './types';

/**
 * Held while Tripwire edits a demo page itself (the "Reviewed by" stamp, the dates moved by "Simulate a busy
 * month"): the `extract` page lock, so no extraction reads or writes the page meanwhile.
 */
export const STAMP_LOCK_SECONDS = 120;

const ALL_STATUSES: readonly TripwireStatus[] = ['proposed', 'active', 'near', 'tripped', 'revisiting', 'archived'];

/**
 * What Tripwire remembers about the page version: the extracted version (so the page event's extraction is skipped
 * as `same_version`, no LLM call) and the baseline of content_change tripwires that matched the read version (so
 * Tripwire's own edit does not trip them). `moveTo` moves both from where they are now to another version, each by
 * CAS on the value this edit wrote, so anything changed meanwhile by someone else is left alone.
 */
export async function rememberedVersion(
  pageId: string,
  version: number,
  deps: { repo: Pick<Repo, 'getDecisionByPage' | 'listTripwires' | 'casTripwire' | 'setDecisionPageVersion'> },
): Promise<{ moveTo: (to: number) => Promise<void> }> {
  const { repo } = deps;
  const decision = await repo.getDecisionByPage(pageId);
  let ownsVersion = decision?.pageVersion === version;
  const tripwires: TripwireRow[] = decision
    ? (await repo.listTripwires(decision.id)).filter(
        (t) => t.kind === 'content_change' && t.baselineVersion === version && (t.spec as ContentChangeSpec).pageId === pageId,
      )
    : [];
  let owned = tripwires.map((t) => t.id);
  let current = version;
  return {
    moveTo: async (to) => {
      if (to === current) return;
      if (ownsVersion) ownsVersion = await repo.setDecisionPageVersion(pageId, current, to);
      const kept: string[] = [];
      for (const id of owned) {
        if (await repo.casTripwire(id, ALL_STATUSES, { baselineVersion: to }, { baselineVersion: current })) kept.push(id);
      }
      owned = kept;
      current = to;
    },
  };
}
