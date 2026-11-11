/**
 * Tests for the per-request Entra on-behalf-of (OBO) token store
 * (task T2, S1-S3). Every rule from the bounded unit has exactly one test:
 *
 * R1 validated configuration, failing closed with no network
 * R2 tenant-specific Graph OBO exchange on the first use
 * R3 separate Flow OBO exchange with the Flow scope
 * R4 lazy per-resource caching local to the request
 * R5 re-exchange of an expired resource token
 * R6 per-resource concurrent deduplication
 * R7 cache isolation per store instance (one HTTP request per instance)
 * R8 the inbound token is forwarded nowhere except the Entra token endpoint
 * R9 no token or secret leakage in error paths
 * R10 a Flow exchange failure never damages the Graph cache
 * R11 no fallback to the local singleton token cache on failure
 *
 * All HTTP is mocked; no real credentials or network are used.
 */
const https = require('https');
const querystring = require('querystring');
const fs = require('fs').promises;

jest.mock('https');
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    unlink: jest.fn(),
  },
}));

const { createRequestOboTokenStore } = require('../../remote/obo-token-store');

const TEST_TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const TEST_TOKEN_ENDPOINT = `https://login.microsoftonline.com/${TEST_TENANT_ID}/oauth2/v2.0/token`;
const TEST_INBOUND_TOKEN = 'inbound-delegated-access-token';
const TEST_CLIENT_ID = 'confidential-client-id';
const TEST_CLIENT_SECRET = 'confidential-client-secret';
const GRAPH_SCOPES = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/User.Read',
];
const FLOW_SCOPE = 'https://service.flow.microsoft.com/.default offline_access';

const validConfig = () => ({
  token: TEST_INBOUND_TOKEN,
  tenantId: TEST_TENANT_ID,
  clientId: TEST_CLIENT_ID,
  clientSecret: TEST_CLIENT_SECRET,
  graphScopes: GRAPH_SCOPES,
  flowScope: FLOW_SCOPE,
});

let requestLog;

function enqueueTokenResponse({ status = 200, body, expiresIn, rawBody, emitErrorAfterData } = {}) {
  https.request.mockImplementationOnce((url, options, callback) => {
    const entry = { url: String(url), options, body: null, write: jest.fn(), end: jest.fn() };
    entry.end = jest.fn(() => {
      const responseData =
        rawBody !== undefined
          ? rawBody
          : body === undefined
            ? {
                // Named per answered request so expectations observe real identity.
                access_token: `obo_token_${requestLog.length}`,
                expires_in: expiresIn === undefined ? 3600 : expiresIn,
                token_type: 'Bearer',
              }
            : body;
      const res = {
        statusCode: status,
        on: (event, handler) => {
          if (event === 'data') {
            handler(
              Buffer.from(
                typeof responseData === 'string' ? responseData : JSON.stringify(responseData)
              )
            );
          }
          if (event === 'error' && emitErrorAfterData) {
            queueMicrotask(() => handler(new Error('socket reset mid-body')));
          }
          if (event === 'end' && !emitErrorAfterData) {
            handler();
          }
        },
      };
      queueMicrotask(() => callback(res));
    });
    entry.on = jest.fn().mockReturnThis();
    entry.setTimeout = jest.fn();
    entry.write.mockImplementation((chunk) => {
      entry.body = querystring.parse(chunk);
    });
    requestLog.push(entry);
    return entry;
  });
}

function enqueueSuccess({ expires_in: expiresIn } = {}) {
  return enqueueTokenResponse({ expiresIn });
}

function enqueueError({ status = 400, body } = {}) {
  return enqueueTokenResponse({
    status,
    body,
  });
}

function requestsToTokenEndpoint() {
  return requestLog.map((entry) => ({
    ...entry,
    parsedUrl: new URL(entry.url),
  }));
}

beforeEach(() => {
  jest.resetAllMocks();
  requestLog = [];
});

describe('createRequestOboTokenStore', () => {
  test('R1: rejects invalid configuration without any network or file access', () => {
    const invalidConfigs = {
      nonObject: 'not-an-object',
      missingToken: { ...validConfig(), token: undefined },
      emptyToken: { ...validConfig(), token: '' },
      missingClientId: { ...validConfig(), clientId: '' },
      missingClientSecret: { ...validConfig(), clientSecret: '' },
      invalidTenant: { ...validConfig(), tenantId: 'common' },
      unknownOption: { ...validConfig(), mystery: true },
      emptyGraphScopes: { ...validConfig(), graphScopes: [] },
      nonStringGraphScope: {
        ...validConfig(),
        graphScopes: ['https://graph.microsoft.com/Mail.Read', 7],
      },
      emptyFlowScope: { ...validConfig(), flowScope: '' },
      negativeBuffer: { ...validConfig(), expiryBufferMs: -1 },
      nonFiniteBuffer: { ...validConfig(), expiryBufferMs: Number.POSITIVE_INFINITY },
    };

    for (const [label, config] of Object.entries(invalidConfigs)) {
      try {
        createRequestOboTokenStore(config);
        throw new Error(`configuration case "${label}" was wrongly accepted`);
      } catch (error) {
        expect(error.code).toBe('MCP_OBO_CONFIG_INVALID');
      }
    }
    expect(https.request).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();

    // A valid configuration must be accepted and stay lazy until first use.
    expect(() => createRequestOboTokenStore(validConfig())).not.toThrow();
    expect(https.request).not.toHaveBeenCalled();
  });

  test('R2: exchanges the inbound token for a Graph token at the tenant Entra endpoint', async () => {
    enqueueSuccess();
    const store = createRequestOboTokenStore(validConfig());

    const accessToken = await store.getValidAccessToken();

    expect(accessToken).toBe('obo_token_1');
    expect(https.request).toHaveBeenCalledTimes(1);

    const request = requestsToTokenEndpoint()[0];
    expect(`${request.parsedUrl.origin}${request.parsedUrl.pathname}`).toBe(TEST_TOKEN_ENDPOINT);
    expect(request.options.method).toBe('POST');
    expect(request.options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(request.body.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(request.body.requested_token_use).toBe('on_behalf_of');
    expect(request.body.assertion).toBe(TEST_INBOUND_TOKEN);
    expect(request.body.client_id).toBe(TEST_CLIENT_ID);
    expect(request.body.client_secret).toBe(TEST_CLIENT_SECRET);
    expect(request.body.scope.split(' ')).toEqual(GRAPH_SCOPES);
  });

  test('R3: exchanges separately for a Flow token using the Flow scope', async () => {
    enqueueSuccess();
    enqueueSuccess();
    const store = createRequestOboTokenStore(validConfig());

    const flowToken = await store.getValidFlowAccessToken();
    const graphToken = await store.getValidAccessToken();

    expect(flowToken).toBe('obo_token_1');
    expect(graphToken).toBe('obo_token_2');
    expect(https.request).toHaveBeenCalledTimes(2);

    const [flowRequest, graphRequest] = requestsToTokenEndpoint();
    expect(flowRequest.body.scope).toBe(FLOW_SCOPE);
    expect(flowRequest.body.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(flowRequest.body.assertion).toBe(TEST_INBOUND_TOKEN);
    expect(graphRequest.body.scope).toBe(GRAPH_SCOPES.join(' '));
    expect(graphRequest.body.scope).not.toBe(flowRequest.body.scope);
  });

  test('R4: caches each resource lazily and locally to the request', async () => {
    enqueueSuccess();
    enqueueSuccess();
    const store = createRequestOboTokenStore(validConfig());

    const graphToken = await store.getValidAccessToken();
    const flowToken = await store.getValidFlowAccessToken();
    expect(https.request).toHaveBeenCalledTimes(2);
    expect(graphToken).toBe('obo_token_1');
    expect(flowToken).toBe('obo_token_2');

    // Repeated calls are served from the local request cache with no new HTTP.
    expect(await store.getValidAccessToken()).toBe(graphToken);
    expect(await store.getValidFlowAccessToken()).toBe(flowToken);
    expect(https.request).toHaveBeenCalledTimes(2);

    // A second store instance shares nothing: its first Graph use must exchange.
    enqueueSuccess();
    const otherRequestStore = createRequestOboTokenStore(validConfig());
    expect(await otherRequestStore.getValidAccessToken()).toBe('obo_token_3');
    expect(https.request).toHaveBeenCalledTimes(3);
  });

  test('R5: re-exchanges a resource token once it has expired', async () => {
    enqueueSuccess({ expires_in: 0 });
    enqueueSuccess();
    const store = createRequestOboTokenStore(validConfig());

    const firstToken = await store.getValidAccessToken();
    const secondToken = await store.getValidAccessToken();

    expect(https.request).toHaveBeenCalledTimes(2);
    expect(firstToken).toBe('obo_token_1');
    expect(secondToken).toBe('obo_token_2');
    expect(secondToken).not.toBe(firstToken);
  });

  test('R6: deduplicates concurrent exchanges per resource', async () => {
    enqueueSuccess();
    enqueueSuccess();
    const store = createRequestOboTokenStore(validConfig());

    const [graph1, graph2, flow1, flow2] = await Promise.all([
      store.getValidAccessToken(),
      store.getValidAccessToken(),
      store.getValidFlowAccessToken(),
      store.getValidFlowAccessToken(),
    ]);

    expect(https.request).toHaveBeenCalledTimes(2);
    expect(graph1).toBe(graph2);
    expect(flow1).toBe(flow2);
    expect(graph1).not.toBe(flow1);
  });

  test('R7: exposes no shared state between store instances', async () => {
    enqueueSuccess();
    enqueueSuccess();
    const storeA = createRequestOboTokenStore(validConfig());
    const storeB = createRequestOboTokenStore(validConfig());

    expect(await storeA.getValidAccessToken()).toBe('obo_token_1');
    expect(await storeB.getValidAccessToken()).toBe('obo_token_2');
    expect(https.request).toHaveBeenCalledTimes(2);

    // A remains self-contained after B cached a different Graph token.
    expect(await storeA.getValidAccessToken()).not.toBe(await storeB.getValidAccessToken());
    expect(https.request).toHaveBeenCalledTimes(2);
  });

  test('R8: forwards the inbound token only to the tenant Entra token endpoint', async () => {
    enqueueSuccess();
    enqueueSuccess();
    const store = createRequestOboTokenStore(validConfig());

    await store.getValidAccessToken();
    await store.getValidFlowAccessToken();

    expect(https.request).toHaveBeenCalledTimes(2);
    for (const request of requestsToTokenEndpoint()) {
      expect(`${request.parsedUrl.origin}${request.parsedUrl.pathname}`).toBe(TEST_TOKEN_ENDPOINT);
      expect(request.url).not.toContain(encodeURIComponent(TEST_INBOUND_TOKEN));
      expect(request.url).not.toContain(TEST_INBOUND_TOKEN);
      // No downstream Authorization header may be built with the inbound token.
      expect(request.options.headers.Authorization).toBeUndefined();
      // The inbound token only travels inside the OBO assertion field.
      expect(request.body.assertion).toBe(TEST_INBOUND_TOKEN);
      expect(request.body.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    }
  });

  test('R9: never leaks the inbound token or client secret in exchange errors', async () => {
    enqueueError({
      status: 400,
      body: {
        error: 'invalid_grant',
        error_description: `AADSTS50013 echoed ${TEST_CLIENT_SECRET} and ${TEST_INBOUND_TOKEN} back`,
      },
    });
    const store = createRequestOboTokenStore(validConfig());

    let capturedError;
    await store.getValidAccessToken().catch((error) => {
      capturedError = error;
    });

    expect(capturedError).toBeDefined();
    expect(https.request).toHaveBeenCalledTimes(1);
    expect(capturedError.message).not.toContain(TEST_INBOUND_TOKEN);
    expect(capturedError.message).not.toContain(TEST_CLIENT_SECRET);
    expect(capturedError.message).toMatch(/on-behalf-of token exchange/i);
    // The provider's typed OAuth rejection code is retained for callers,
    // matching the contextual-error contract used by token refresh.
    expect(capturedError.code).toBe('invalid_grant');
  });

  test('R10: a failed Flow exchange leaves the Graph cache intact', async () => {
    enqueueError({
      body: {
        error: 'invalid_grant',
        error_description: 'Flow on-behalf-of exchange is not supported for this tenant',
      },
    });
    enqueueSuccess();
    const store = createRequestOboTokenStore(validConfig());

    await expect(store.getValidFlowAccessToken()).rejects.toThrow(/obo|exchange|failed/i);
    const graphToken = await store.getValidAccessToken();
    expect(graphToken).toBe('obo_token_2');

    // The cached Graph token is reused without any further HTTP.
    expect(await store.getValidAccessToken()).toBe(graphToken);
    expect(https.request).toHaveBeenCalledTimes(2);
  });

  test('R11: fails closed instead of using the local singleton token cache', async () => {
    // No response is queued: the mocked transport yields no exchange result.
    const store = createRequestOboTokenStore(validConfig());

    await expect(store.getValidAccessToken()).rejects.toThrow();
    await expect(store.getValidFlowAccessToken()).rejects.toThrow();
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  // Independent-verifier corrections (one bounded batch, same task T2/T3 S1-S3):
  test('C1: rejects safely when the response errors mid-body and allows a later request', async () => {
    enqueueTokenResponse({ rawBody: '{"access_token":"partial_token",', emitErrorAfterData: true });
    enqueueSuccess();
    const store = createRequestOboTokenStore(validConfig());

    let firstError;
    await store.getValidAccessToken().catch((error) => {
      firstError = error;
    });

    expect(firstError).toBeDefined();
    expect(firstError.message).not.toContain(TEST_CLIENT_SECRET);
    expect(https.request).toHaveBeenCalledTimes(1);

    // The in-flight slot is cleared: a later request exchanges again instead of
    // hanging or leaking the half-parsed body.
    const secondToken = await store.getValidAccessToken();
    expect(secondToken).toBe('obo_token_2');
    expect(https.request).toHaveBeenCalledTimes(2);
  });

  test('C2: rejects a non-finite expires_in and never caches the rejected response', async () => {
    enqueueTokenResponse({ rawBody: '{"access_token":"raw_infinite_token","expires_in":1e999}' });
    enqueueSuccess();
    const store = createRequestOboTokenStore(validConfig());

    let firstError;
    await store.getValidAccessToken().catch((error) => {
      firstError = error;
    });

    expect(firstError).toBeDefined();
    expect(firstError).not.toBeNull();
    // The rejected response must not have been cached: a later call exchanges again.
    const secondToken = await store.getValidAccessToken();
    expect(secondToken).toBe('obo_token_2');
    expect(https.request).toHaveBeenCalledTimes(2);
  });

  test('C3: requires MS_AUTHORITY_HOST to be a valid HTTPS Entra origin and never sends secrets otherwise', async () => {
    const originalHost = process.env.MS_AUTHORITY_HOST;
    try {
      delete process.env.MS_AUTHORITY_HOST;
      // Expected HTTPS overrides stay functional.
      process.env.MS_AUTHORITY_HOST = 'https://login.contoso.internal';
      enqueueSuccess();
      const overrideStore = createRequestOboTokenStore(validConfig());
      expect(await overrideStore.getValidAccessToken()).toBe('obo_token_1');
      expect(requestLog[0].url).toBe(
        `https://login.contoso.internal/${TEST_TENANT_ID}/oauth2/v2.0/token`
      );
      expect(requestLog[0].body.client_secret).toBe(TEST_CLIENT_SECRET);

      https.request.mockClear();
      const invalidHosts = {
        httpScheme: 'http://not-secure.internal',
        malformed: 'not a url',
        withUserInfo: 'https://user:pass@internal.example',
        withPath: 'https://internal.example/token/extra',
        missingHost: 'https://',
      };
      for (const [label, host] of Object.entries(invalidHosts)) {
        process.env.MS_AUTHORITY_HOST = host;
        let thrown;
        try {
          createRequestOboTokenStore(validConfig());
        } catch (error) {
          thrown = error;
        }
        if (!thrown) {
          throw new Error(`authority host case "${label}" was wrongly accepted`);
        }
        expect(thrown.code).toBe('MCP_OBO_CONFIG_INVALID');
      }
      // Fail closed: no request (and no client secret) ever left for a
      // rejected authority host.
      expect(https.request).not.toHaveBeenCalled();
    } finally {
      if (originalHost === undefined) {
        delete process.env.MS_AUTHORITY_HOST;
      } else {
        process.env.MS_AUTHORITY_HOST = originalHost;
      }
    }
  });
});
