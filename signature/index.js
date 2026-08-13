const SignatureStore = require('./store');
// prettier-ignore
const imageSchema = { type: 'object', properties: { contentId: { type: 'string' }, fileName: { type: 'string' }, contentType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/gif'] }, contentBytes: { type: 'string' } }, required: ['contentId', 'fileName', 'contentType', 'contentBytes'] };
const signatureProperties = {
  name: { type: 'string', description: 'Unique signature name' },
  html: { type: 'string', description: 'Sanitized HTML signature body' },
  images: { type: 'array', items: imageSchema, default: [] },
};
const schema = (properties, required = []) => ({ type: 'object', properties, required });
const response = (value, isError = false) => ({
  ...(isError && { isError }),
  content: [{ type: 'text', text: isError ? value.message : JSON.stringify(value) }],
});
const definition = (name, description, inputSchema, handler) => ({
  name,
  description,
  inputSchema,
  handler,
});
function createSignatureTools(store) {
  const run = (operation) => async (args) => {
    try {
      return response(await operation(args || {}));
    } catch (error) {
      return response(error, true);
    }
  };
  const mutation = (method, result) =>
    run(async (args) => {
      await store[method](...(method === 'update' ? [args.name, args] : [args.name ?? null]));
      return result(args);
    });
  const create = run(async (args) => {
    await store.create(args);
    return { name: args.name, created: true };
  });
  const get = run(async ({ name }) => {
    const value = await store.get(name);
    if (!value) throw new Error(`Signature not found: ${name}`);
    return value;
  });
  // One declarative row per MCP tool keeps the registry reviewable.
  // prettier-ignore
  return [
    definition('create-email-signature', 'Create a managed HTML email signature', schema(signatureProperties, ['name', 'html']), create),
    definition('list-email-signatures', 'List managed email signatures', schema({}), run(() => store.list())),
    definition('get-email-signature', 'Get a managed email signature', schema({ name: signatureProperties.name }, ['name']), get),
    definition('update-email-signature', 'Replace a managed email signature', schema(signatureProperties, ['name', 'html']), mutation('update', ({ name }) => ({ name, updated: true }))),
    definition('delete-email-signature', 'Delete a managed email signature', schema({ name: signatureProperties.name }, ['name']), mutation('delete', ({ name }) => ({ name, deleted: true }))),
    definition('set-default-email-signature', 'Set or clear the shared default email signature', schema({ name: signatureProperties.name }), mutation('setDefault', ({ name }) => ({ defaultName: name ?? null }))),
  ];
}
const signatureStore = new SignatureStore();
const signatureTools = createSignatureTools(signatureStore);
module.exports = { createSignatureTools, signatureStore, signatureTools };
