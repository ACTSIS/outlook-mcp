const fs = require('fs');
const os = require('os');
const path = require('path');
const SignatureStore = require('../../signature/store');

const signature = (name, html = `<p>${name}</p>`) => ({ name, html, images: [] });

describe('SignatureStore', () => {
  let dir;
  let filePath;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signatures-'));
    filePath = path.join(dir, 'store.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('supports CRUD and shared-default lifecycle with a private file', async () => {
    const store = new SignatureStore({ filePath });
    await store.create(signature('work'));
    await store.update('work', signature('work', '<strong>Updated</strong>'));
    await store.setDefault('work');
    expect(await store.list()).toEqual([{ name: 'work', isDefault: true }]);
    expect((await store.get('work')).html).toBe('<strong>Updated</strong>');
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    await store.delete('work');
    expect(await store.getDefault()).toBeNull();
  });

  it('rejects duplicates, missing targets, and corrupt state without changing valid state', async () => {
    const store = new SignatureStore({ filePath });
    await store.create(signature('work'));
    await expect(store.create(signature('work'))).rejects.toThrow(/exists/i);
    await expect(store.update('missing', signature('missing'))).rejects.toThrow(/not found/i);
    await expect(store.setDefault('missing')).rejects.toThrow(/not found/i);
    expect((await store.list()).map((item) => item.name)).toEqual(['work']);
    fs.writeFileSync(filePath, '{broken');
    await expect(store.list()).rejects.toThrow(/corrupt/i);
  });

  it('serializes overlapping mutations without losing updates', async () => {
    const store = new SignatureStore({ filePath });
    await Promise.all([store.create(signature('alpha')), store.create(signature('beta'))]);
    expect((await store.list()).map((item) => item.name)).toEqual(['alpha', 'beta']);
  });

  it('preserves prior durable state when atomic rename fails', async () => {
    const store = new SignatureStore({ filePath });
    await store.create(signature('work'));
    const failingFs = {
      ...fs.promises,
      rename: jest.fn().mockRejectedValue(new Error('disk failure')),
    };
    const failing = new SignatureStore({ filePath, fs: failingFs });
    await expect(failing.create(signature('other'))).rejects.toThrow('disk failure');
    expect((await store.list()).map((item) => item.name)).toEqual(['work']);
  });
});
