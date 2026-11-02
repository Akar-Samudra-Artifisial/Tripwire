import Resolver from '@forge/resolver';

const resolver = new Resolver();

type ResolverContext = {
  accountId?: string;
  moduleKey?: string;
};

/** Placeholder status shown by every Custom UI view until the real queries land. */
resolver.define('getStatus', ({ context }: { context: ResolverContext }) => ({
  app: 'Tripwire',
  moduleKey: context.moduleKey ?? null,
  watched: 0,
  tripped: 0,
}));

export const handler = resolver.getDefinitions();
