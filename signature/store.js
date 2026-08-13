const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { validateSignature } = require('./sanitizer');
const emptyState = () => ({ version: 1, defaultName: null, signatures: {} });
const clone = (value) => JSON.parse(JSON.stringify(value));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class SignatureStore {
  constructor(options = {}) {
    this.filePath = options.filePath || path.join(os.homedir(), '.outlook-mcp-signatures.json');
    this.fs = options.fs || fs.promises;
    this.lockPath = `${this.filePath}.lock`;
    this.lockTimeout = options.lockTimeout || 5000;
    this.queue = Promise.resolve();
    this.state = emptyState();
  }
  async load() {
    let raw;
    try {
      raw = await this.fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
    try {
      const state = JSON.parse(raw);
      if (state.version !== 1 || !state.signatures || Array.isArray(state.signatures))
        throw new Error();
      for (const [name, value] of Object.entries(state.signatures)) {
        if (name !== value.name) throw new Error();
        state.signatures[name] = validateSignature(value);
      }
      if (state.defaultName !== null && !state.signatures[state.defaultName]) throw new Error();
      this.state = state;
      return clone(state);
    } catch {
      throw new Error('Signature store is corrupt or invalid');
    }
  }
  mutate(operation) {
    const run = async () => {
      await this.acquireLock();
      try {
        const next = operation(clone(await this.load()));
        await this.persist(next);
        this.state = next;
        return clone(next);
      } finally {
        await this.fs.rm(this.lockPath, { recursive: true, force: true });
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }
  async acquireLock() {
    const deadline = Date.now() + this.lockTimeout;
    while (true) {
      try {
        await this.fs.mkdir(this.lockPath, { mode: 0o700 });
        await this.fs.writeFile(path.join(this.lockPath, 'owner'), String(process.pid));
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error('Signature store lock timed out');
        await delay(10);
      }
    }
  }
  async persist(state) {
    const temp = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await this.fs.open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(state, null, 2));
      await handle.sync();
      await handle.close();
      handle = null;
      await this.fs.rename(temp, this.filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await this.fs.unlink(temp).catch(() => {});
      throw error;
    }
  }
  async list() {
    const state = await this.load();
    return Object.keys(state.signatures)
      .sort()
      .map((name) => ({ name, isDefault: name === state.defaultName }));
  }
  async get(name) {
    const state = await this.load();
    return state.signatures[name] ? clone(state.signatures[name]) : null;
  }
  async getDefault() {
    const state = await this.load();
    return state.defaultName ? clone(state.signatures[state.defaultName]) : null;
  }
  create(candidate) {
    const value = validateSignature(candidate);
    return this.mutate((state) => {
      if (state.signatures[value.name]) throw new Error(`Signature already exists: ${value.name}`);
      if (Object.keys(state.signatures).length >= 50) throw new Error('Signature limit reached');
      state.signatures[value.name] = value;
      return state;
    });
  }
  update(name, candidate) {
    const value = validateSignature({ ...candidate, name });
    return this.mutate((state) => {
      if (!state.signatures[name]) throw new Error(`Signature not found: ${name}`);
      state.signatures[name] = value;
      return state;
    });
  }
  delete(name) {
    return this.mutate((state) => {
      if (!state.signatures[name]) throw new Error(`Signature not found: ${name}`);
      delete state.signatures[name];
      if (state.defaultName === name) state.defaultName = null;
      return state;
    });
  }
  setDefault(name = null) {
    return this.mutate((state) => {
      if (name !== null && !state.signatures[name]) throw new Error(`Signature not found: ${name}`);
      state.defaultName = name;
      return state;
    });
  }
}
module.exports = SignatureStore;
