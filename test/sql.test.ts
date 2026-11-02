import { describe, expect, it, vi } from 'vitest';

vi.mock('@forge/sql', () => ({ migrationRunner: {}, sql: {} }));

const { schemaGuard } = await import('../src/adapters/sql');

describe('schemaGuard (R1)', () => {
  it('re-runs migrations once when the first run fails (e.g. racing another invocation)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const migrate = vi.fn<() => Promise<string[]>>().mockRejectedValueOnce(new Error('Duplicate column name')).mockResolvedValue(['v001']);
    const ensure = schemaGuard(migrate);
    await ensure();
    await ensure();
    expect(migrate).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry fails and tries again on the next call', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const migrate = vi.fn<() => Promise<string[]>>().mockRejectedValueOnce(new Error('a')).mockRejectedValueOnce(new Error('b')).mockResolvedValue([]);
    const ensure = schemaGuard(migrate);
    await expect(ensure()).rejects.toThrow('b');
    await ensure();
    expect(migrate).toHaveBeenCalledTimes(3);
  });
});
