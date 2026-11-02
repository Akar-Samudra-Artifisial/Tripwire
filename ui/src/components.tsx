import type { ReactNode } from 'react';
import { useRemote } from './bridge';

interface Status {
  app: string;
  moduleKey: string | null;
  watched: number;
  tripped: number;
}

export function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="shell">
      <h1 className="shell__title">{title}</h1>
      {children}
    </main>
  );
}

/** Placeholder body shared by every view until real data lands. */
export function Placeholder({ description }: { description: string }) {
  const status = useRemote<Status>('getStatus');
  return (
    <section>
      <p>{description}</p>
      {status.loading && <p className="muted">Loading…</p>}
      {status.error && (
        <p className="error" role="alert">
          {status.error}
        </p>
      )}
      {status.data && (
        <p className="muted">
          {status.data.watched} assumptions watched · {status.data.tripped} tripped
        </p>
      )}
    </section>
  );
}
