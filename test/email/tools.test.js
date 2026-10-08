const { emailTools } = require('../../email');

describe('forward-draft tool registration', () => {
  test('registers the forward-draft tool in the email tool set', () => {
    const forwardTool = emailTools.find(({ name }) => name === 'forward-draft');

    expect(forwardTool).toBeDefined();
    expect(forwardTool.description).toContain('forward');
    expect(forwardTool.description).toContain('empty recipients');
  });

  test('declares emailId as the only required forward-draft input', () => {
    const forwardTool = emailTools.find(({ name }) => name === 'forward-draft');

    expect(forwardTool.inputSchema.required).toEqual(['emailId']);
    expect(forwardTool.inputSchema.properties.emailId).toEqual({
      type: 'string',
      description: expect.stringContaining('ID of the message to forward'),
    });
  });

  test('declares the optional forward-draft composition inputs', () => {
    const properties = emailTools.find(({ name }) => name === 'forward-draft').inputSchema
      .properties;

    expect(properties.isHtml).toEqual({
      type: 'boolean',
      description:
        'Set to true to compose as HTML, false for plain text. If not specified, auto-detects based on <html> tag presence.',
    });
    expect(properties.importance).toEqual({
      type: 'string',
      description: 'Email importance (normal, high, low)',
      enum: ['normal', 'high', 'low'],
    });
    expect(properties.attachments).toEqual({
      type: 'array',
      items: { type: 'string' },
      description: expect.stringContaining('file paths'),
    });
    expect(properties.signatureName).toEqual({
      type: 'string',
      description: 'Managed signature name; overrides the shared default',
    });
    expect(properties.includeSignature).toEqual({
      type: 'boolean',
      description: 'Set to false to omit managed signatures for this operation',
    });
    expect(properties.body).toEqual({
      type: 'string',
      description: 'Optional caller text prepended above the quoted original thread',
    });
    expect(properties.subject).toEqual({
      type: 'string',
      description: expect.stringContaining('subject override'),
    });
  });
});
