import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY } from '../../../../shared/identity';

// Force the data directory before the module loads so peers.json lands in our
// scratch dir. ensureDataDir reads this variable. #251
//
// Taken from identity rather than written out: renaming the variable (#459)
// does not fail a test that spells it — it stops redirecting it, and the test
// then writes peers.json into the real data directory and still passes.
const DATA_DIR_ENV = IDENTITY.dataDirEnv;

let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), `${IDENTITY.tmpPrefix}-peers-`));
  originalDataDir = process.env[DATA_DIR_ENV];
  process.env[DATA_DIR_ENV] = tempDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env[DATA_DIR_ENV];
  else process.env[DATA_DIR_ENV] = originalDataDir;
  await rm(tempDir, { recursive: true, force: true });
});

describe('peer-registry mutation lock', () => {
  test('concurrent recordPeer* calls do not overwrite each other', async () => {
    // Re-import after we set the data dir so the module picks up our temp.
    const peerRegistry = await import('../peer-registry');
    const { createPeer, recordPeerSuccess, recordPeerFailure, getPeer } = peerRegistry;

    const a = await createPeer({ nickname: 'a', url: 'https://a.example' });
    const b = await createPeer({ nickname: 'b', url: 'https://b.example' });

    // Issue interleaved success/failure updates on both peers. Without the
    // mutation lock the load→mutate→save races would silently drop one
    // peer's update on every overlap.
    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < 20; i++) {
      ops.push(recordPeerSuccess(a.id));
      ops.push(recordPeerFailure(b.id, `fail ${i}`));
    }
    await Promise.all(ops);

    const ra = await getPeer(a.id);
    const rb = await getPeer(b.id);
    expect(ra?.lastSeenAt).toBeDefined();
    expect(ra?.lastErrorMessage).toBeUndefined();
    expect(rb?.lastErrorAt).toBeDefined();
    expect(rb?.lastErrorMessage).toBe('fail 19');
  });

  test('save is atomic via temp+rename — no truncated file under contention', async () => {
    const { createPeer, recordPeerSuccess } = await import('../peer-registry');
    const a = await createPeer({ nickname: 'a', url: 'https://a.example' });
    await Promise.all(
      Array.from({ length: 50 }, () => recordPeerSuccess(a.id)),
    );
    const filePath = join(tempDir, 'peers.json');
    const text = await readFile(filePath, 'utf-8');
    // JSON.parse rejects truncated/partial writes; the lock + atomic rename
    // is what guarantees we never see a half-written file.
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed.peers)).toBe(true);
    expect(parsed.peers.some((p: { id: string }) => p.id === a.id)).toBe(true);
  });
});
