const { createSignatureTools } = require('../../signature');

const candidate = { name: 'work', html: '<p>Regards</p>', images: [] };

describe('email signature MCP tools', () => {
  let tools;
  let store;
  beforeEach(() => {
    store = {
      create: jest.fn(async (value) => ({ signatures: { [value.name]: value } })),
      list: jest.fn(async () => [{ name: 'work', isDefault: false }]),
      get: jest.fn(async (name) => (name === 'work' ? candidate : null)),
      update: jest.fn(async () => ({})),
      delete: jest.fn(async () => ({})),
      setDefault: jest.fn(async () => ({})),
    };
    tools = createSignatureTools(store);
  });

  it('exposes six schemas with required lifecycle inputs', () => {
    // prettier-ignore
    expect(tools.map((tool) => tool.name)).toEqual(['create-email-signature', 'list-email-signatures', 'get-email-signature', 'update-email-signature', 'delete-email-signature', 'set-default-email-signature']);
    expect(
      tools.find((tool) => tool.name === 'create-email-signature').inputSchema.required
    ).toEqual(['name', 'html']);
    expect(
      tools.find((tool) => tool.name === 'set-default-email-signature').inputSchema.required
    ).toEqual([]);
  });

  it('runs create, list, update, delete, and clear-default lifecycle', async () => {
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.handler]));
    await byName['create-email-signature'](candidate);
    expect(JSON.parse((await byName['list-email-signatures']({})).content[0].text)).toEqual([
      { name: 'work', isDefault: false },
    ]);
    await byName['update-email-signature']({ ...candidate, html: '<p>Updated</p>' });
    await byName['delete-email-signature']({ name: 'work' });
    await byName['set-default-email-signature']({});
    expect(store.create).toHaveBeenCalledWith(candidate);
    expect(store.update).toHaveBeenCalledWith('work', { ...candidate, html: '<p>Updated</p>' });
    expect(store.delete).toHaveBeenCalledWith('work');
    expect(store.setDefault).toHaveBeenCalledWith(null);
  });

  it('returns an MCP error for missing targets', async () => {
    const get = tools.find((tool) => tool.name === 'get-email-signature').handler;
    expect(await get({ name: 'missing' })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Signature not found: missing' }],
    });
  });
});
