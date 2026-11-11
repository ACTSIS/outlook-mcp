/**
 * Tests for the encrypted crash-safe bridge persistence store
 * (task T17, S5, S10, S11). Every rule from the bounded unit has at
 * least one test:
 *
 * R1  encrypted disk roundtrip: a committed snapshot loads identically
 *     through a fresh store instance, and the generation advances
 * R2  no plaintext fixture secret appears anywhere on disk (raw, base64,
 *     or hex encodings) and no temp file survives
 * R3  tampered ciphertext fails closed with unchanged on-disk state and
 *     without leaking secret material in the error
 * R4  a wrong key fails closed with unchanged on-disk state
 * R5  a missing key alongside an existing store fails closed, never
 *     regenerates over the orphaned store, and never blanks it
 * R6  corrupt, truncated, and unexpected-version envelopes fail closed
 * R7  an unwritable target path fails closed and never leaves partial
 *     state (POSIX only: Windows does not enforce POSIX modes). An
 *     existing store directory is deliberately restored to 0700 by the
 *     store, so the exercisable failure boundary is directory creation
 *     under an unwritable parent.
 * R8  an interrupted persist (rename failure) preserves the last snapshot
 *     and leaves no temp file behind
 * R9  a stale concurrent writer is rejected and never silently clobbers
 *     the newer snapshot another instance committed
 * R10 a fresh store reports no snapshot before the first commit
 * R11 the deployment identifier is authenticated: the same key under a
 *     different deployment binding cannot load the store
 * R12 snapshot bounds: non-plain objects, unserializable values, payloads
 *     above the configured limit, and store files above the limit all fail
 *     closed before or without touching durable data
 * R13 key handling: explicit Buffer key, explicit external key file, and
 *     missing/invalid key material all fail closed; no option derives a
 *     key from a client secret
 * R14 restrictive file and directory modes (POSIX only)
 * R15 close() stops all further operations and is idempotent
 * R16 commit() requires a prior successful load()
 *
 * All state lives in synthetic temporary directories that every test
 * removes; no persistent or real user data is touched.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  createBridgeStore,
  BridgeStoreError,
  ERROR_CODES,
  DATA_FILE_NAME,
  KEY_FILE_NAME,
} = require('../../remote/bridge-store');

const FIXTURE_UPSTREAM_TOKEN = 'upstream-entra-access-token-value-9f2c';
const FIXTURE_REFRESH_TOKEN = 'upstream-entra-refresh-token-value-4a71';
const FIXTURE_MCP_TOKEN = 'mcp-bearer-token-value-77e0';

const posixOnly = process.platform === 'win32' ? test.skip : test;

let tempRoot;

function makeStoreDir(name) {
  const dir = path.join(tempRoot, name);
  fs.mkdirSync(dir);
  return dir;
}

function keyFor(seed) {
  return crypto.createHash('sha256').update(seed).digest();
}

function storeOptions(dir, overrides = {}) {
  return { directory: dir, key: keyFor('test-key'), ...overrides };
}

function dataPath(dir) {
  return path.join(dir, DATA_FILE_NAME);
}

function bytesOf(filePath) {
  return fs.readFileSync(filePath);
}

/**
 * Seeds an on-disk store with one commit of `snapshot` and returns a
 * fresh store instance opened against it plus the loaded state.
 */
function seedStore(dir, snapshot) {
  const writer = createBridgeStore(storeOptions(dir));
  writer.load();
  writer.commit(snapshot);
  writer.close();
  const reader = createBridgeStore(storeOptions(dir));
  const loaded = reader.load();
  return { reader, loaded };
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-store-test-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
});

describe('R1 encrypted disk roundtrip', () => {
  test('commits a snapshot and a fresh instance loads it identically', () => {
    const dir = makeStoreDir('roundtrip');
    const snapshot = {
      upstreamRefreshCredentials: {
        userId: 'user-1',
        refreshToken: FIXTURE_REFRESH_TOKEN,
        expiresAt: 1893456000,
      },
      identities: { 'user-1': { objectId: 'oid-1', tenantId: 'tid-1' } },
      mcpGrants: { 'client-a': [FIXTURE_MCP_TOKEN] },
    };
    const writer = createBridgeStore(storeOptions(dir));
    const initial = writer.load();
    expect(initial).toEqual({ exists: false, generation: 0 });
    const committed = writer.commit(snapshot);
    expect(committed).toEqual({ generation: 1 });
    writer.close();

    const reader = createBridgeStore(storeOptions(dir));
    const loaded = reader.load();
    expect(loaded.exists).toBe(true);
    expect(loaded.generation).toBe(1);
    expect(loaded.snapshot).toEqual(snapshot);
    expect(reader.commit({ ...snapshot, v: 2 })).toEqual({ generation: 2 });
    reader.close();

    const verifier = createBridgeStore(storeOptions(dir));
    expect(verifier.load()).toMatchObject({ generation: 2 });
    verifier.close();
  });
});

describe('R2 no plaintext secret on disk', () => {
  test('the data file contains no fixture secret in raw, base64, or hex form', () => {
    const dir = makeStoreDir('no-plaintext');
    const writer = createBridgeStore(storeOptions(dir));
    writer.load();
    writer.commit({
      upstream: { accessToken: FIXTURE_UPSTREAM_TOKEN, refreshToken: FIXTURE_REFRESH_TOKEN },
      mcp: { token: FIXTURE_MCP_TOKEN },
    });
    writer.close();

    const onDisk = bytesOf(dataPath(dir));
    const searchable = onDisk.toString('latin1');
    const encodings = new Set();
    for (const secret of [FIXTURE_UPSTREAM_TOKEN, FIXTURE_REFRESH_TOKEN, FIXTURE_MCP_TOKEN]) {
      encodings.add(secret);
      encodings.add(Buffer.from(secret, 'utf8').toString('base64'));
      encodings.add(Buffer.from(secret, 'utf8').toString('hex'));
    }
    for (const encoded of encodings) {
      expect(searchable).not.toContain(encoded);
    }

    // Only the encrypted data file exists; an explicit key is never put
    // on disk.
    expect(fs.readdirSync(dir)).toEqual([DATA_FILE_NAME]);
  });
});

describe('R3 tamper fails closed without blanking', () => {
  test('a flipped ciphertext byte is rejected and on-disk state is unchanged', () => {
    const dir = makeStoreDir('tamper');
    seedStore(dir, { keep: 'me' });
    const before = bytesOf(dataPath(dir));
    const tampered = Buffer.from(before);
    tampered[tampered.length - 1] ^= 0x01;
    fs.writeFileSync(dataPath(dir), tampered);

    const reader = createBridgeStore(storeOptions(dir));
    expect(() => reader.load()).toThrow(BridgeStoreError);
    try {
      reader.load();
    } catch (error) {
      expect(error.code).toBe(ERROR_CODES.UNAUTHORIZED);
      expect(String(error.message)).not.toContain('me');
      expect(String(error.message)).not.toContain(FIXTURE_UPSTREAM_TOKEN);
    }
    // The store must fail closed: nothing is written, nothing is blanked.
    expect(bytesOf(dataPath(dir))).toEqual(tampered);
    expect(() => reader.commit({ ok: true })).toThrow(ERROR_CODES.NOT_LOADED);
    expect(bytesOf(dataPath(dir))).toEqual(tampered);
  });
});

describe('R4 wrong key fails closed', () => {
  test('a different key is rejected and on-disk state is unchanged', () => {
    const dir = makeStoreDir('wrong-key');
    seedStore(dir, { keep: 'me' });
    const before = bytesOf(dataPath(dir));

    const reader = createBridgeStore(storeOptions(dir, { key: keyFor('other-key') }));
    expect(() => reader.load()).toThrow(ERROR_CODES.UNAUTHORIZED);
    expect(bytesOf(dataPath(dir))).toEqual(before);
  });
});

describe('R5 missing key alongside an existing store', () => {
  test('the auto-generated key being deleted fails closed without regeneration', () => {
    const dir = makeStoreDir('missing-key');
    const writer = createBridgeStore({ directory: dir });
    writer.load();
    writer.commit({ keep: 'me' });
    writer.close();
    const before = bytesOf(dataPath(dir));
    const keyBytes = bytesOf(path.join(dir, KEY_FILE_NAME));
    expect(keyBytes.length).toBe(32);
    fs.rmSync(path.join(dir, KEY_FILE_NAME));

    expect(() => createBridgeStore({ directory: dir })).toThrow(ERROR_CODES.KEY_MISSING);
    // No key was regenerated over the orphaned store and no data was touched.
    expect(fs.existsSync(path.join(dir, KEY_FILE_NAME))).toBe(false);
    expect(bytesOf(dataPath(dir))).toEqual(before);
    expect(fs.readdirSync(dir)).toEqual([DATA_FILE_NAME]);
  });
});

describe('R6 corrupt, truncated, and unexpected-version envelopes', () => {
  test('a truncated envelope fails closed with FORMAT', () => {
    const dir = makeStoreDir('truncated');
    seedStore(dir, { keep: 'me' });
    const before = bytesOf(dataPath(dir));
    fs.writeFileSync(dataPath(dir), before.subarray(0, 30));

    const reader = createBridgeStore(storeOptions(dir));
    expect(() => reader.load()).toThrow(ERROR_CODES.FORMAT);
    expect(bytesOf(dataPath(dir)).length).toBe(30);
  });

  test('an unexpected format version fails closed with VERSION', () => {
    const dir = makeStoreDir('wrong-version');
    seedStore(dir, { keep: 'me' });
    const before = bytesOf(dataPath(dir));
    const altered = Buffer.from(before);
    altered[7] = 9;
    fs.writeFileSync(dataPath(dir), altered);

    const reader = createBridgeStore(storeOptions(dir));
    expect(() => reader.load()).toThrow(ERROR_CODES.VERSION);
    expect(bytesOf(dataPath(dir))).toEqual(altered);
  });

  test('a corrupt header (bad magic) fails closed with FORMAT', () => {
    const dir = makeStoreDir('bad-magic');
    seedStore(dir, { keep: 'me' });
    const before = bytesOf(dataPath(dir));
    const altered = Buffer.from(before);
    altered[0] ^= 0xff;
    fs.writeFileSync(dataPath(dir), altered);

    const reader = createBridgeStore(storeOptions(dir));
    expect(() => reader.load()).toThrow(ERROR_CODES.FORMAT);
  });
});

describe('R7 unwritable path fails closed', () => {
  posixOnly('an unwritable parent rejects directory creation without leaving partial state', () => {
    const parent = path.join(tempRoot, 'locked-parent');
    fs.mkdirSync(parent);
    const dir = path.join(parent, 'store');
    fs.chmodSync(parent, 0o500);
    try {
      const writer = createBridgeStore(storeOptions(dir));
      expect(writer.load()).toEqual({ exists: false, generation: 0 });
      expect(() => writer.commit({ must: 'never-persist' })).toThrow(ERROR_CODES.IO);
      // No store directory, data file, or key file was created.
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      fs.chmodSync(parent, 0o700);
    }
  });
});

describe('R8 interrupted persist preserves the last snapshot', () => {
  test('a failing rename leaves the previous snapshot and cleans the temp file', () => {
    const dir = makeStoreDir('interrupted');
    const { reader, loaded } = seedStore(dir, { keep: 'me' });
    expect(loaded.generation).toBe(1);

    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EINTR simulated rename failure');
    });
    try {
      expect(() => reader.commit({ next: 'state' })).toThrow(ERROR_CODES.IO);
    } finally {
      renameSpy.mockRestore();
    }
    expect(fs.readdirSync(dir)).toEqual([DATA_FILE_NAME]);
    reader.close();

    const verifier = createBridgeStore(storeOptions(dir));
    expect(verifier.load()).toMatchObject({ generation: 1, snapshot: { keep: 'me' } });
    verifier.close();
  });
});

describe('R9 stale concurrent writer never silently clobbers', () => {
  test('a lagging instance is rejected while the newer snapshot stays durable', () => {
    const dir = makeStoreDir('stale-writer');
    const first = createBridgeStore(storeOptions(dir));
    first.load();
    first.commit({ holder: 'first' });

    const second = createBridgeStore(storeOptions(dir));
    second.load();

    const third = createBridgeStore(storeOptions(dir));
    third.load();
    third.commit({ holder: 'second-instance-won' });

    expect(() => second.commit({ staleState: true })).toThrow(ERROR_CODES.CONFLICT);
    // The stale instance must not have overwritten the newer snapshot.
    const verifier = createBridgeStore(storeOptions(dir));
    expect(verifier.load()).toMatchObject({
      generation: 2,
      snapshot: { holder: 'second-instance-won' },
    });
    verifier.close();
    first.close();
    second.close();
    third.close();
  });

  test('a store whose file disappears keeps failing closed instead of recreating state', () => {
    const dir = makeStoreDir('deleted-under-store');
    const writer = createBridgeStore(storeOptions(dir));
    expect(writer.load().exists).toBe(false);
    writer.commit({ first: true });
    fs.rmSync(dataPath(dir));
    expect(() => writer.commit({ second: true })).toThrow(ERROR_CODES.CONFLICT);
    expect(fs.existsSync(dataPath(dir))).toBe(false);
    writer.close();
    const verifier = createBridgeStore(storeOptions(dir));
    expect(verifier.load().exists).toBe(false);
    expect(verifier.commit({ fresh: true })).toEqual({ generation: 1 });
    verifier.close();
  });
});

describe('R10 fresh store', () => {
  test('reports no snapshot before the first commit', () => {
    const dir = makeStoreDir('fresh');
    const store = createBridgeStore(storeOptions(dir));
    expect(store.load()).toEqual({ exists: false, generation: 0 });
    expect(store.commit({ initial: true })).toEqual({ generation: 1 });
    store.close();
  });
});

describe('R11 deployment binding', () => {
  test('the same key under a different deployment identifier cannot load the store', () => {
    const dir = makeStoreDir('deployment-binding');
    const writer = createBridgeStore(storeOptions(dir, { deploymentId: 'deployment-a' }));
    writer.load();
    writer.commit({ who: 'a' });
    writer.close();

    const reader = createBridgeStore(
      storeOptions(dir, { key: keyFor('test-key'), deploymentId: 'deployment-b' })
    );
    expect(() => reader.load()).toThrow(ERROR_CODES.UNAUTHORIZED);
    writer.close();
  });
});

describe('R12 snapshot bounds', () => {
  test('rejects non-plain objects, unserializable values, and oversized payloads', () => {
    const dir = makeStoreDir('payload-bounds');
    const writer = createBridgeStore(storeOptions(dir));
    writer.load();
    writer.commit({ baseline: true });
    const before = bytesOf(dataPath(dir));
    expect(() => writer.commit(null)).toThrow(ERROR_CODES.PAYLOAD);
    expect(() => writer.commit([1, 2])).toThrow(ERROR_CODES.PAYLOAD);
    const circular = {};
    circular.self = circular;
    expect(() => writer.commit(circular)).toThrow(ERROR_CODES.PAYLOAD);
    expect(() => writer.commit('{"not":"an-object"}')).toThrow(ERROR_CODES.PAYLOAD);
    writer.close();
    // Every rejected payload left the store untouched.
    expect(bytesOf(dataPath(dir))).toEqual(before);
    const verifier = createBridgeStore(storeOptions(dir));
    expect(verifier.load().exists).toBe(true);
    verifier.commit({ ok: true });
    verifier.close();
  });

  test('rejects payloads above the configured limit and store files above the limit', () => {
    const dir = makeStoreDir('size-limit');
    const writer = createBridgeStore(storeOptions(dir));
    writer.load();
    writer.commit({ blob: 'x'.repeat(4000) });
    writer.close();

    const overLimit = createBridgeStore(storeOptions(dir, { maxSnapshotBytes: 2048 }));
    expect(() => overLimit.load()).toThrow(ERROR_CODES.SIZE);
    const atLimit = createBridgeStore(storeOptions(dir, { maxSnapshotBytes: 8192 }));
    expect(atLimit.load()).toMatchObject({ exists: true, generation: 1 });
    expect(() => atLimit.commit({ blob: 'x'.repeat(9000) })).toThrow(ERROR_CODES.PAYLOAD);
    // The oversized commit did not touch the durable snapshot; loading is
    // one-shot per instance, so a fresh instance verifies it.
    const verifier = createBridgeStore(storeOptions(dir));
    expect(verifier.load()).toMatchObject({ snapshot: { blob: 'x'.repeat(4000) } });
    verifier.close();
    atLimit.close();
    overLimit.close();
  });
});

describe('R13 key handling', () => {
  test('uses an explicitly provided external key file', () => {
    const dir = makeStoreDir('external-keyfile');
    const keyFile = path.join(tempRoot, 'external.key');
    fs.writeFileSync(keyFile, keyFor('external-secret-key'));

    const writer = createBridgeStore({ directory: dir, keyFile });
    writer.load();
    writer.commit({ via: 'keyfile' });
    writer.close();

    const reader = createBridgeStore(storeOptions(dir, { key: keyFor('external-secret-key') }));
    expect(reader.load()).toMatchObject({ snapshot: { via: 'keyfile' } });
    reader.close();
  });

  test('fails closed for missing, invalid, and ambiguous key configuration', () => {
    const dir = makeStoreDir('key-config');
    const missingKeyFile = path.join(tempRoot, 'absent.key');
    expect(() => createBridgeStore({ directory: dir, keyFile: missingKeyFile })).toThrow(
      ERROR_CODES.KEY_MISSING
    );

    const wrongSizeKeyFile = path.join(tempRoot, 'wrong-size.key');
    fs.writeFileSync(wrongSizeKeyFile, Buffer.alloc(16));
    expect(() => createBridgeStore({ directory: dir, keyFile: wrongSizeKeyFile })).toThrow(
      ERROR_CODES.KEY_INVALID
    );

    expect(() => createBridgeStore({ directory: dir, key: Buffer.alloc(16) })).toThrow(
      ERROR_CODES.KEY_INVALID
    );
    expect(() => createBridgeStore(storeOptions(dir, { key: 'not-a-buffer' }))).toThrow(
      ERROR_CODES.KEY_INVALID
    );
    // Both sources at once is ambiguous configuration, not a silent choice.
    expect(() =>
      createBridgeStore(storeOptions(dir, { key: keyFor('x'), keyFile: wrongSizeKeyFile }))
    ).toThrow(ERROR_CODES.CONFIG);
  });

  test('never accepts a client secret as key material or an option', () => {
    const dir = makeStoreDir('no-client-secret');
    expect(() =>
      createBridgeStore(storeOptions(dir, { clientSecret: 'entra-client-secret' }))
    ).toThrow(ERROR_CODES.CONFIG);
  });

  test('auto-generates the key only when a fresh store is created', () => {
    const dir = makeStoreDir('auto-key');
    const store = createBridgeStore({ directory: dir });
    expect(store.load().exists).toBe(false);
    expect(fs.existsSync(path.join(dir, KEY_FILE_NAME))).toBe(true);
    // A second instance against the same fresh directory reuses the key.
    const second = createBridgeStore({ directory: dir });
    expect(second.load()).toEqual({ exists: false, generation: 0 });
    expect(second.commit({ shared: true })).toEqual({ generation: 1 });
    second.close();
    store.close();
  });
});

describe('R14 restrictive modes', () => {
  posixOnly('data file, key file, and created directory use restrictive modes', () => {
    const dir = makeStoreDir('modes');
    const store = createBridgeStore({ directory: dir });
    store.load();
    store.commit({ mode: 'check' });
    store.close();
    expect(fs.statSync(path.join(dir, KEY_FILE_NAME)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dataPath(dir)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('R15 close()', () => {
  test('stops load, commit, and repeat close after closing', () => {
    const dir = makeStoreDir('close');
    const store = createBridgeStore(storeOptions(dir));
    store.load();
    store.close();
    expect(() => store.load()).toThrow(ERROR_CODES.CLOSED);
    expect(() => store.commit({ x: 1 })).toThrow(ERROR_CODES.CLOSED);
    store.close();
  });
});

describe('R16 commit requires a prior successful load', () => {
  test('committing before load fails closed without touching disk', () => {
    const dir = makeStoreDir('not-loaded');
    const store = createBridgeStore(storeOptions(dir));
    expect(() => store.commit({ too: 'early' })).toThrow(ERROR_CODES.NOT_LOADED);
    expect(fs.existsSync(dataPath(dir))).toBe(false);
    store.close();
  });
});

describe('error surface', () => {
  test('errors are BridgeStoreError instances with stable codes', () => {
    const dir = makeStoreDir('error-surface');
    const store = createBridgeStore(storeOptions(dir));
    store.load();
    store.close();
    let caught;
    try {
      store.load();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BridgeStoreError);
    expect(caught.code).toBe(ERROR_CODES.CLOSED);
    expect(Object.values(ERROR_CODES)).toContain(caught.code);
  });
});
