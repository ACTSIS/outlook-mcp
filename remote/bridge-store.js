/**
 * Encrypted crash-safe persistence store for the MCP HTTP bridge
 * (task T17, S5, S10, S11). This unit adds only the store: the provider
 * integration that feeds it snapshots is a later unit (T18/T19), and this
 * module is deliberately not wired anywhere yet.
 *
 * Bounded unit: one store instance owns one directory and persists whole
 * logical snapshots for the service-owned OAuth bridge. The interface is
 * small and fully synchronous so a provider can load once at startup and
 * serve its existing synchronous verify/resolve methods from memory:
 *
 *   const store = createBridgeStore({ directory, key | keyFile,
 *                                     deploymentId, maxSnapshotBytes });
 *   const { exists, generation, snapshot } = store.load();
 *   const { generation } = store.commit(nextSnapshot); // whole snapshot
 *   store.close();
 *
 * What is encrypted at rest (AES-256-GCM, one fresh 96-bit nonce per
 * commit, authenticated with non-secret AAD binding the format version,
 * the committed generation, and the deployment identifier): the entire
 * snapshot, including upstream Entra refresh credentials and delegated
 * identities. MCP client grants and bearer-token hashes are the
 * provider's responsibility to shape; whatever it puts in the snapshot
 * is covered by the same encryption. The key is an explicit 32-byte
 * Buffer, an existing external key file, or an auto-generated key file
 * stored separately from the ciphertext file. The key is never derived
 * from any client secret, and this module accepts no client secret at
 * all.
 *
 * Safety rules enforced here:
 *   - Whole-snapshot transactions: `commit` serializes the full logical
 *     snapshot, refuses non-plain objects and payloads above the
 *     configured maximum before touching disk, and replaces the on-disk
 *     envelope atomically (temp file in the same directory, fsync of the
 *     file, rename, fsync of the directory where the platform supports
 *     it). A failure at any point before the rename preserves the
 *     previous on-disk snapshot, and the temp file is removed.
 *   - Generation and conflict detection: the on-disk envelope carries a
 *     monotonic generation that is authenticated as part of the AAD.
 *     Before every commit the store re-reads the on-disk header and fails
 *     closed when another writer has advanced it, or when the store file
 *     disappeared after a successful load. A stale instance can never
 *     silently clobber a newer snapshot.
 *   - Fail closed on every damaged state: tampered ciphertext, a wrong
 *     key, a wrong deployment binding, truncation, corruption, an
 *     unexpected format version, an oversized store file, or a missing
 *     key file alongside an existing store all reject the load with the
 *     on-disk state left untouched and commit disabled until a fresh
 *     load succeeds. Nothing is ever blanked to recover.
 *   - Restrictive modes: the data file and key file are written 0600 and
 *     the store directory is enforced 0700 on POSIX; key material never
 *     shares a file with ciphertext.
 *   - No sensitive data in errors: messages carry operation names and
 *     operating-system error codes only, never token material, snapshot
 *     content, or paths.
 *
 * Honest concurrency boundary (documented, not hidden): this module does
 * not claim cross-container exclusion. There is no lock file and no
 * time-based lock stealing; unclean restarts always succeed. Transactions
 * are serialized by the synchronous interface inside one process, and the
 * generation check fails closed against a concurrent writer, but two
 * concurrently running writers on the same directory can still race
 * between the header read and the rename. The deployment must run
 * exactly one store replica; enforcing that is a deployment concern, not
 * something this single-node store can prove.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE_NAME = 'bridge-store.bin';
const KEY_FILE_NAME = 'bridge-store.key';
/** Non-secret file magic: "MCPBRDG". */
const MAGIC = Buffer.from([0x4d, 0x43, 0x50, 0x42, 0x52, 0x44, 0x47]);
const FORMAT_VERSION = 1;
// 7 magic + 1 version + 8 generation + 12 nonce + 16 GCM tag.
const HEADER_LENGTH = 44;
const GENERATION_OFFSET = 8;
const NONCE_OFFSET = 16;
const TAG_OFFSET = 28;
const KEY_BYTES = 32;
const DEFAULT_MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MIN_MAX_SNAPSHOT_BYTES = 1024;
const DEFAULT_DEPLOYMENT_ID = 'outlook-mcp-bridge';
const MAX_DEPLOYMENT_ID_LENGTH = 256;

const ALLOWED_OPTION_KEYS = ['directory', 'key', 'keyFile', 'deploymentId', 'maxSnapshotBytes'];

const ERROR_CODES = Object.freeze({
  CONFIG: 'BRIDGE_STORE_CONFIG_INVALID',
  KEY_MISSING: 'BRIDGE_STORE_KEY_MISSING',
  KEY_INVALID: 'BRIDGE_STORE_KEY_INVALID',
  NOT_LOADED: 'BRIDGE_STORE_NOT_LOADED',
  CLOSED: 'BRIDGE_STORE_CLOSED',
  ALREADY_LOADED: 'BRIDGE_STORE_ALREADY_LOADED',
  FORMAT: 'BRIDGE_STORE_FORMAT_INVALID',
  VERSION: 'BRIDGE_STORE_VERSION_UNSUPPORTED',
  SIZE: 'BRIDGE_STORE_STORE_TOO_LARGE',
  PAYLOAD: 'BRIDGE_STORE_SNAPSHOT_INVALID',
  IO: 'BRIDGE_STORE_IO',
  UNAUTHORIZED: 'BRIDGE_STORE_UNAUTHORIZED',
  CONFLICT: 'BRIDGE_STORE_CONCURRENT_WRITE',
});

class BridgeStoreError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'BridgeStoreError';
    this.code = code;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function storeError(code, message) {
  return new BridgeStoreError(code, message);
}

function ioError(operation, cause) {
  const causeCode = cause && cause.code ? cause.code : 'UNKNOWN';
  return new BridgeStoreError(ERROR_CODES.IO, `${ERROR_CODES.IO}: ${operation} (${causeCode})`);
}

/**
 * Reads an existing key file and fails closed unless it holds exactly 32
 * key bytes. Missing files are the caller's to fix; nothing is ever
 * regenerated over an existing store.
 */
function readKeyFile(filePath) {
  let keyBytes;
  try {
    keyBytes = fs.readFileSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw storeError(
        ERROR_CODES.KEY_MISSING,
        `${ERROR_CODES.KEY_MISSING}: the key file is missing`
      );
    }
    throw ioError('reading the key file', err);
  }
  if (keyBytes.length !== KEY_BYTES) {
    throw storeError(
      ERROR_CODES.KEY_INVALID,
      `${ERROR_CODES.KEY_INVALID}: the key file must hold exactly ${KEY_BYTES} bytes`
    );
  }
  return keyBytes;
}

/**
 * Builds the store. Validates all configuration eagerly and fails closed
 * before any key or store exists on disk. When neither an explicit key
 * nor a key file is configured, a 32-byte key is auto-generated in the
 * store directory, but only for a directory without an existing store
 * file — an existing store without its key always fails closed instead
 * of being silently orphaned or blanked.
 */
function createBridgeStore(options) {
  if (!isPlainObject(options)) {
    throw storeError(
      ERROR_CODES.CONFIG,
      `${ERROR_CODES.CONFIG}: a configuration object is required`
    );
  }
  const unknownKeys = Object.keys(options).filter((key) => !ALLOWED_OPTION_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw storeError(
      ERROR_CODES.CONFIG,
      `${ERROR_CODES.CONFIG}: unexpected bridge store options: ${unknownKeys.join(', ')}`
    );
  }
  if (!isNonEmptyString(typeof options.directory === 'string' ? options.directory : '')) {
    throw storeError(ERROR_CODES.CONFIG, `${ERROR_CODES.CONFIG}: directory is required`);
  }

  const directory = path.resolve(options.directory);
  const dataFilePath = path.join(directory, DATA_FILE_NAME);
  const autoKeyFilePath = path.join(directory, KEY_FILE_NAME);

  let deploymentId = options.deploymentId;
  if (deploymentId === undefined) {
    deploymentId = DEFAULT_DEPLOYMENT_ID;
  }
  if (
    !isNonEmptyString(typeof deploymentId === 'string' ? deploymentId : '') ||
    deploymentId.length > MAX_DEPLOYMENT_ID_LENGTH ||
    deploymentId.includes('\u0000')
  ) {
    throw storeError(
      ERROR_CODES.CONFIG,
      `${ERROR_CODES.CONFIG}: deploymentId must be a non-empty bounded string`
    );
  }

  let maxSnapshotBytes = options.maxSnapshotBytes;
  if (maxSnapshotBytes === undefined) {
    maxSnapshotBytes = DEFAULT_MAX_SNAPSHOT_BYTES;
  }
  if (!isFiniteInteger(maxSnapshotBytes, MIN_MAX_SNAPSHOT_BYTES, Number.MAX_SAFE_INTEGER)) {
    throw storeError(
      ERROR_CODES.CONFIG,
      `${ERROR_CODES.CONFIG}: maxSnapshotBytes must be an integer of at least ${MIN_MAX_SNAPSHOT_BYTES}`
    );
  }

  const hasExplicitKey = options.key !== undefined;
  const hasExplicitKeyFile = options.keyFile !== undefined;
  if (hasExplicitKey && hasExplicitKeyFile) {
    throw storeError(
      ERROR_CODES.CONFIG,
      `${ERROR_CODES.CONFIG}: provide either a key buffer or a keyFile, never both`
    );
  }

  let key;
  if (hasExplicitKey) {
    // Both sources at once was already rejected above, so an explicit key
    // here never coexists with an explicit key file.
    if (!Buffer.isBuffer(options.key) || options.key.length !== KEY_BYTES) {
      throw storeError(
        ERROR_CODES.KEY_INVALID,
        `${ERROR_CODES.KEY_INVALID}: key must be a ${KEY_BYTES}-byte Buffer`
      );
    }
    key = options.key;
  } else if (hasExplicitKeyFile) {
    if (!isNonEmptyString(typeof options.keyFile === 'string' ? options.keyFile : '')) {
      throw storeError(ERROR_CODES.CONFIG, `${ERROR_CODES.CONFIG}: keyFile must be a path string`);
    }
    // An external key file is an existing secret owned by the operator;
    // the store never creates or rewrites it.
    key = readKeyFile(options.keyFile);
  } else {
    const storeExists = fs.existsSync(dataFilePath);
    const autoKeyExists = fs.existsSync(autoKeyFilePath);
    if (storeExists && !autoKeyExists) {
      throw storeError(
        ERROR_CODES.KEY_MISSING,
        `${ERROR_CODES.KEY_MISSING}: the key file is missing alongside an existing store`
      );
    }
    if (!storeExists && !autoKeyExists) {
      ensureDirectory(directory);
      const generated = crypto.randomBytes(KEY_BYTES);
      try {
        fs.writeFileSync(autoKeyFilePath, generated, { mode: 0o600 });
        if (process.platform !== 'win32') {
          fs.chmodSync(autoKeyFilePath, 0o600);
        }
      } catch (err) {
        throw ioError('writing the auto-generated key file', err);
      }
    }
    key = readKeyFile(autoKeyFilePath);
  }

  let closed = false;
  let loaded = false;
  /** Generation of the on-disk state this instance currently mirrors. */
  let observedGeneration = 0;

  function ensureDirectory(targetDirectory) {
    try {
      if (!fs.existsSync(targetDirectory)) {
        fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
      }
      if (process.platform !== 'win32') {
        // The store directory is dedicated to the store, so the 0700
        // invariant is enforced even when the directory pre-existed.
        fs.chmodSync(targetDirectory, 0o700);
      }
    } catch (err) {
      throw ioError('preparing the store directory', err);
    }
  }

  /**
   * Reads the raw on-disk envelope, or null when the store file does not
   * exist yet. Size is bounded before any header parsing.
   */
  function readEnvelope() {
    let envelope;
    try {
      envelope = fs.readFileSync(dataFilePath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return null;
      }
      throw ioError('reading the store file', err);
    }
    if (envelope.length > maxSnapshotBytes) {
      throw storeError(
        ERROR_CODES.SIZE,
        `${ERROR_CODES.SIZE}: the store file exceeds the configured maximum`
      );
    }
    return envelope;
  }

  function deploymentAAD(headerPrefix) {
    return Buffer.concat([headerPrefix, Buffer.from(deploymentId, 'utf8')]);
  }

  /** Parses and decrypts one envelope, failing closed on anything off. */
  function decryptEnvelope(envelope) {
    if (envelope.length < HEADER_LENGTH) {
      throw storeError(
        ERROR_CODES.FORMAT,
        `${ERROR_CODES.FORMAT}: the store file is truncated or corrupt`
      );
    }
    if (!envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw storeError(ERROR_CODES.FORMAT, `${ERROR_CODES.FORMAT}: unrecognized store file header`);
    }
    const version = envelope[7];
    if (version !== FORMAT_VERSION) {
      throw storeError(
        ERROR_CODES.VERSION,
        `${ERROR_CODES.VERSION}: the store file version ${version} is not supported`
      );
    }
    const generation = Number(envelope.readBigUInt64BE(GENERATION_OFFSET));
    if (!isFiniteInteger(generation, 1, Number.MAX_SAFE_INTEGER)) {
      throw storeError(ERROR_CODES.FORMAT, `${ERROR_CODES.FORMAT}: the generation is corrupt`);
    }

    const nonce = envelope.subarray(NONCE_OFFSET, TAG_OFFSET);
    const tag = envelope.subarray(TAG_OFFSET, HEADER_LENGTH);
    const ciphertext = envelope.subarray(HEADER_LENGTH);
    let decipher;
    let plaintext;
    try {
      decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(deploymentAAD(envelope.subarray(0, 16)));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw storeError(
        ERROR_CODES.UNAUTHORIZED,
        `${ERROR_CODES.UNAUTHORIZED}: the store failed authentication (wrong key or modified file)`
      );
    }

    let snapshot;
    try {
      snapshot = JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw storeError(ERROR_CODES.FORMAT, `${ERROR_CODES.FORMAT}: the stored snapshot is invalid`);
    }
    if (!isPlainObject(snapshot)) {
      throw storeError(ERROR_CODES.FORMAT, `${ERROR_CODES.FORMAT}: the stored snapshot is invalid`);
    }
    return { generation, snapshot };
  }

  /**
   * Reads the on-disk header for the pre-commit conflict check. A header
   * that cannot even be parsed counts as a concurrent or foreign writer,
   * so it fails closed with the conflict code instead of exposing the
   * load-time damage codes.
   */
  function readOnDiskGeneration() {
    const envelope = readEnvelope();
    if (envelope === null) {
      return null;
    }
    if (
      envelope.length < HEADER_LENGTH ||
      !envelope.subarray(0, MAGIC.length).equals(MAGIC) ||
      envelope[7] !== FORMAT_VERSION
    ) {
      throw storeError(
        ERROR_CODES.CONFLICT,
        `${ERROR_CODES.CONFLICT}: the store file on disk cannot be identified`
      );
    }
    const generation = Number(envelope.readBigUInt64BE(GENERATION_OFFSET));
    if (!isFiniteInteger(generation, 1, Number.MAX_SAFE_INTEGER)) {
      throw storeError(
        ERROR_CODES.CONFLICT,
        `${ERROR_CODES.CONFLICT}: the store file on disk is corrupt`
      );
    }
    return generation;
  }

  function syncDirectory() {
    try {
      const dirFd = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Directory fsync is not supported on every platform; the file
      // itself is already flushed and renamed at this point.
    }
  }

  return {
    /**
     * Loads the on-disk snapshot once. Returns
     * `{ exists: false, generation: 0 }` for a store that has never been
     * committed, or `{ exists: true, generation, snapshot }` with the
     * decrypted whole snapshot. Every check fails closed and leaves the
     * on-disk state untouched when anything is off.
     */
    load() {
      if (closed) {
        throw storeError(ERROR_CODES.CLOSED, `${ERROR_CODES.CLOSED}: the store is closed`);
      }
      if (loaded) {
        throw storeError(
          ERROR_CODES.ALREADY_LOADED,
          `${ERROR_CODES.ALREADY_LOADED}: the store has already been loaded once`
        );
      }
      const envelope = readEnvelope();
      let result;
      if (envelope === null) {
        result = { exists: false, generation: 0 };
        observedGeneration = 0;
      } else {
        const decrypted = decryptEnvelope(envelope);
        result = {
          exists: true,
          generation: decrypted.generation,
          snapshot: decrypted.snapshot,
        };
        observedGeneration = decrypted.generation;
      }
      loaded = true;
      return result;
    },

    /**
     * Persists the whole logical snapshot as the next generation. Fails
     * closed before writing anything for an invalid payload, a stale
     * view of the store, or a closed store, and preserves the previous
     * on-disk snapshot when any write step fails before the rename.
     */
    commit(snapshot) {
      if (closed) {
        throw storeError(ERROR_CODES.CLOSED, `${ERROR_CODES.CLOSED}: the store is closed`);
      }
      if (!loaded) {
        throw storeError(
          ERROR_CODES.NOT_LOADED,
          `${ERROR_CODES.NOT_LOADED}: commit requires a prior successful load`
        );
      }
      if (!isPlainObject(snapshot)) {
        throw storeError(
          ERROR_CODES.PAYLOAD,
          `${ERROR_CODES.PAYLOAD}: the snapshot must be a plain object`
        );
      }
      let plaintextBuffer;
      try {
        plaintextBuffer = Buffer.from(JSON.stringify(snapshot), 'utf8');
      } catch {
        throw storeError(
          ERROR_CODES.PAYLOAD,
          `${ERROR_CODES.PAYLOAD}: the snapshot could not be serialized`
        );
      }
      if (plaintextBuffer.length > maxSnapshotBytes - HEADER_LENGTH) {
        throw storeError(
          ERROR_CODES.PAYLOAD,
          `${ERROR_CODES.PAYLOAD}: the serialized snapshot exceeds the configured maximum`
        );
      }

      // Conflict gate: a concurrent writer may have replaced or removed
      // the store file since this instance's last view of it.
      const onDiskGeneration = readOnDiskGeneration();
      if (
        onDiskGeneration !== null
          ? onDiskGeneration !== observedGeneration
          : observedGeneration !== 0
      ) {
        throw storeError(
          ERROR_CODES.CONFLICT,
          `${ERROR_CODES.CONFLICT}: the store advanced or disappeared since the last view`
        );
      }
      if (observedGeneration >= Number.MAX_SAFE_INTEGER - 1) {
        throw storeError(ERROR_CODES.IO, `${ERROR_CODES.IO}: the generation counter is exhausted`);
      }
      const nextGeneration = observedGeneration + 1;

      ensureDirectory(directory);

      const nonce = crypto.randomBytes(12);
      const header = Buffer.alloc(HEADER_LENGTH);
      MAGIC.copy(header, 0);
      header[7] = FORMAT_VERSION;
      header.writeBigUInt64BE(BigInt(nextGeneration), GENERATION_OFFSET);
      nonce.copy(header, NONCE_OFFSET);

      let ciphertext;
      try {
        const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(deploymentAAD(header.subarray(0, 16)));
        ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
        cipher.getAuthTag().copy(header, TAG_OFFSET);
      } catch (err) {
        throw ioError('encrypting the snapshot', err);
      }

      const tempPath = path.join(
        directory,
        `.${DATA_FILE_NAME}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
      );
      let fd;
      try {
        fd = fs.openSync(tempPath, 'wx', 0o600);
        if (process.platform !== 'win32') {
          fs.chmodSync(tempPath, 0o600);
        }
        const envelope = Buffer.concat([header, ciphertext]);
        let written = 0;
        while (written < envelope.length) {
          written += fs.writeSync(fd, envelope, written);
        }
        fs.fsyncSync(fd);
      } catch (err) {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            // Best-effort cleanup only.
          }
        }
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {
          // Best-effort cleanup only; the previous store file is intact.
        }
        throw ioError('writing the store file', err);
      }
      try {
        fs.closeSync(fd);
        fd = undefined;
      } catch (err) {
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {
          // Best-effort cleanup only.
        }
        throw ioError('closing the store file', err);
      }

      try {
        fs.renameSync(tempPath, dataFilePath);
      } catch (err) {
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {
          // Best-effort cleanup only; the previous store file is intact.
        }
        throw ioError('replacing the store file', err);
      }

      syncDirectory();
      observedGeneration = nextGeneration;
      return { generation: nextGeneration };
    },

    /**
     * Closes the store. Load, commit, and repeated calls after this fail
     * closed; close itself is idempotent.
     */
    close() {
      closed = true;
    },
  };
}

module.exports = {
  createBridgeStore,
  BridgeStoreError,
  ERROR_CODES,
  DATA_FILE_NAME,
  KEY_FILE_NAME,
};
