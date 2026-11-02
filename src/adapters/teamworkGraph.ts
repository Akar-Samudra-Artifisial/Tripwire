/**
 * Teamwork Graph reads (Preview, read-only). Queries go through `asUser().requestTeamworkGraph()`;
 * a missing `read:graph:*` scope returns empty data instead of an error, so callers must not treat
 * an empty result as "no relations" without a scope health check.
 *
 * Stub: the GraphQL queries are written once the Preview schema is explored on the developer site.
 */
export class GraphNotImplementedError extends Error {
  constructor(what: string) {
    super(`Teamwork Graph ${what} is not implemented yet`);
    this.name = 'GraphNotImplementedError';
  }
}

export const teamworkGraph = {
  async countRelated(anchor: string, relation: string): Promise<number> {
    throw new GraphNotImplementedError(`countRelated(${relation}) for ${anchor}`);
  },
};
