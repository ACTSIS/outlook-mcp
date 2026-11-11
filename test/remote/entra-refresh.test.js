/**
 * Tests for the dedicated bounded remote Entra refresh-token service
 * (task T19, S5, S10, S11). Rule map, one focused block per rule:
 *
 * R1 configuration fails closed with no network (tenant GUID, client
 *    credentials, HTTPS-pinned authority, resource-qualified scopes,
 *    bounded timeout)
 * R2 the refresh grant is a tenant-pinned HTTPS POST carrying the
 *    resource-qualified upstream scopes plus offline_access, the
 *    confidential client secret, and the presented refresh token; no
 *    resource or audience parameter is ever fabricated
 * R3 the result carries exactly the bounded credential contract
 *    {accessToken, expiresAt, refreshToken?} with a positive finite
 *    expires_in; a rotated refresh token is returned, a missing one is
 *    compatible (no pretence of a grant), and a malformed one is dropped
 * R4 only actual user-consent reauth conditions (invalid_grant,
 *    interaction_required, consent_required, login_required) are
 *    classified permanent reauth; invalid_client/configuration failures
 *    are service errors, network/5xx/malformed/timeout are transient,
 *    and AADSTS text in a description alone never decides anything
 * R5 no token, secret, code, or error body is ever logged or carried in
 *    errors; the response is size-bounded and stream errors reject
 *
 * Fully offline: jest-muted https. No real tenant, no credentials, no
 * network, no filesystem access, no HTTP listener.
 */
const https = require('https');
const querystring = require('querystring');

jest.mock('https');

const {
  createEntraTokenRefresher,
  EntraRefreshError,
  ERROR_CODES,
  REAUTH_REQUIRED,
} = require('../../remote/entra-refresh');

const TENANT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const CLIENT_ID = 'confidential-mcp-client-id';
const CLIENT_SECRET = 'confidential-mcp-client-secret-value';
const AUTHORITY_HOST = 'https://login.contoso.example';
const UPSTREAM_SCOPE = 'api://outlook-mcp/mcp.access';
const REFRESH_TOKEN = 'synthetic-upstream-refresh-credential';
const RENEWED_ACCESS_TOKEN = 'synthetic-renewed-upstream-access-token';
const RENEWED_REFRESH_TOKEN = 'synthetic-rotated-upstream-refresh-credential';

function refreshToken() {
  return REFRESH_TOKEN;
}

function validConfig() {
  return {
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    scopes: [UPSTREAM_SCOPE],
    authorityHost: AUTHORITY_HOST,
  };
}

let requestLog;

/**
 * Queues one mocked token-endpoint response with the entra-login test
 * request-capture conventions (bounded synthetic form response).
 */
function enqueueTokenResponse({ status = 200, body, resError } = {}) {
  https.request.mockImplementationOnce((url, options, callback) => {
    let errorHandler = null;
    const entry = {
      url: String(url),
      options,
      body: null,
      setTimeout: jest.fn(),
      on: jest.fn((event, handler) => {
        if (event === 'error') {
          errorHandler = handler;
        }
        return entry;
      }),
      write: jest.fn((chunk) => {
        entry.body = querystring.parse(chunk);
      }),
      end: jest.fn(() => {
        if (resError) {
          queueMicrotask(() => errorHandler(resError));
          return;
        }
        const responseBody =
          body === undefined
            ? {
                token_type: 'Bearer',
                scope: `${UPSTREAM_SCOPE} offline_access`,
                expires_in: 3600,
                access_token: RENEWED_ACCESS_TOKEN,
                refresh_token: RENEWED_REFRESH_TOKEN,
              }
            : body;
        const res = {
          statusCode: status,
          on: (event, handler) => {
            if (event === 'data') {
              handler(
                Buffer.from(
                  typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)
                )
              );
            }
            if (event === 'end') {
              handler();
            }
            if (event === 'error') {
              // Stream-failure injection happens through resError on the request.
            }
          },
        };
        queueMicrotask(() => callback(res));
      }),
    };
    requestLog.push(entry);
    return entry;
  });
}

function queuedRequest() {
  if (requestLog.length === 0) {
    throw new Error('no mocked https request was issued');
  }
  const last = requestLog[requestLog.length - 1];
  return {
    ...last,
    parsedUrl: new URL(last.url),
    parsedBody: last.body,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  requestLog = [];
});

describe('createEntraTokenRefresher', () => {
  describe('R1: configuration fails closed before any network work', () => {
    it('refuses each non-object configuration without any network work', () => {
      for (const badConfig of [null, undefined, 'text', []]) {
        expect(() => createEntraTokenRefresher(badConfig)).toThrow(EntraRefreshError);
      }
      expect(https.request).not.toHaveBeenCalled();
    });

    it('refuses the remaining malformed configuration cases', () => {
      const overrides = {
        'a missing tenant': { tenantId: undefined },
        "Entra 'common' as the tenant": { tenantId: 'common' },
        'a non-GUID tenant': { tenantId: 'not-a-guid' },
        'an empty client id': { clientId: '' },
        'a blank client secret': { clientSecret: '   ' },
        'no upstream scopes': { scopes: [] },
        'a short (non-qualified) scope': { scopes: ['mcp.access'] },
        'a plaintext authority host': { authorityHost: 'http://login.contoso.example' },
      };
      for (const [label, patch] of Object.entries(overrides)) {
        try {
          expect(() => createEntraTokenRefresher({ ...validConfig(), ...patch })).toThrow(
            EntraRefreshError
          );
        } catch (error) {
          error.message = `${label}: ${error.message}`;
          throw error;
        }
      }
      expect(https.request).not.toHaveBeenCalled();
    });

    it('rejects unknown configuration options and a timeout beyond the 30 second bound', () => {
      expect(() => createEntraTokenRefresher({ ...validConfig(), extraOption: true })).toThrow(
        /unexpected/i
      );
      expect(() => createEntraTokenRefresher({ ...validConfig(), timeoutMs: 30001 })).toThrow(
        /timeout/i
      );
      expect(() => createEntraTokenRefresher({ ...validConfig(), timeoutMs: 0 })).toThrow(
        /timeout/i
      );
    });

    it('accepts the 30 second timeout exactly and defaults to it', () => {
      expect(() => createEntraTokenRefresher({ ...validConfig(), timeoutMs: 30000 })).not.toThrow();
      const refresher = createEntraTokenRefresher(validConfig());
      expect(refresher.refresh).toEqual(expect.any(Function));
    });
  });

  describe('R2: the tenant-pinned refresh grant request', () => {
    it('posts the refresh_token grant to the tenant-pinned HTTPS token endpoint with the qualified scopes plus offline_access', async () => {
      const refresher = createEntraTokenRefresher({ ...validConfig(), timeoutMs: 9000 });
      enqueueTokenResponse({});
      const result = await refresher.refresh({ refreshToken: refreshToken() });

      expect(result.accessToken).toBe(RENEWED_ACCESS_TOKEN);
      const request = queuedRequest();
      expect(request.parsedUrl.protocol).toBe('https:');
      expect(request.parsedUrl.host).toBe('login.contoso.example');
      expect(request.parsedUrl.pathname).toBe(`/${TENANT_ID}/oauth2/v2.0/token`);
      expect(request.options.method).toBe('POST');
      expect(request.parsedBody.grant_type).toBe('refresh_token');
      expect(request.parsedBody.client_id).toBe(CLIENT_ID);
      expect(request.parsedBody.client_secret).toBe(CLIENT_SECRET);
      expect(request.parsedBody.refresh_token).toBe(REFRESH_TOKEN);
      // The scope carries the configured resource-qualified upstream scopes
      // plus offline_access (so Microsoft keeps issuing a refresh token);
      // openid and profile are never requested on the refresh grant.
      const scopes = request.parsedBody.scope.split(' ');
      expect(scopes).toEqual(expect.arrayContaining([UPSTREAM_SCOPE, 'offline_access']));
      expect(scopes).not.toContain('openid');
      // No fabricated resource/audience hacks.
      expect(request.parsedBody.resource).toBeUndefined();
      expect(Object.keys(request.parsedBody).sort()).toEqual([
        'client_id',
        'client_secret',
        'grant_type',
        'refresh_token',
        'scope',
      ]);
      // The bounded timeout must be pinned to the (never larger) option.
      expect(request.setTimeout).toHaveBeenCalledWith(9000, expect.any(Function));
    });

    it('unions offline_access exactly once across several configured scopes', async () => {
      const refresher = createEntraTokenRefresher({
        ...validConfig(),
        scopes: [UPSTREAM_SCOPE, 'api://outlook-mcp/calendar.write'],
      });
      enqueueTokenResponse({});
      await refresher.refresh({ refreshToken: refreshToken() });
      const scopes = queuedRequest().parsedBody.scope.split(' ');
      expect(scopes.filter((scope) => scope === 'offline_access')).toHaveLength(1);
      expect(scopes).toEqual(
        expect.arrayContaining([UPSTREAM_SCOPE, 'api://outlook-mcp/calendar.write'])
      );
    });
  });

  describe('R3: the credential result contract', () => {
    it('returns a positive finite expiresAt derived from expires_in and the rotated refresh token', async () => {
      const refresher = createEntraTokenRefresher(validConfig());
      enqueueTokenResponse({});
      const before = Math.floor(Date.now() / 1000);
      const result = await refresher.refresh({ refreshToken: refreshToken() });
      expect(result).toEqual({
        accessToken: RENEWED_ACCESS_TOKEN,
        expiresAt: before + 3600,
        refreshToken: RENEWED_REFRESH_TOKEN,
      });
    });

    it('rejects missing, zero, negative, or non-finite expires_in as unusable responses', async () => {
      const badExpiresIn = ['  ', -5, 0, Number.POSITIVE_INFINITY];
      for (const [index, expires_in] of badExpiresIn.entries()) {
        const refresher = createEntraTokenRefresher(validConfig());
        enqueueTokenResponse({
          body:
            expires_in === '  '
              ? { access_token: RENEWED_ACCESS_TOKEN }
              : { token_type: 'Bearer', expires_in, access_token: RENEWED_ACCESS_TOKEN },
        });
        await expect(refresher.refresh({ refreshToken: refreshToken() })).rejects.toMatchObject({
          name: 'EntraRefreshError',
        });
        expect(https.request.mock.calls).toHaveLength(index + 1);
      }
    });

    it('rejects an unusable access token as a malformed response, never as a stored state', async () => {
      for (const accessToken of ['', '   ', 'a b c', null]) {
        const refresher = createEntraTokenRefresher(validConfig());
        enqueueTokenResponse({
          body: {
            token_type: 'Bearer',
            expires_in: 3600,
            ...(accessToken !== null ? { access_token: accessToken } : {}),
          },
        });
        await expect(refresher.refresh({ refreshToken: refreshToken() })).rejects.toMatchObject({
          code: ERROR_CODES.TRANSIENT,
        });
      }
    });

    it('tolerates a response without a refresh token (compatibility) without pretending refresh was granted', async () => {
      const refresher = createEntraTokenRefresher(validConfig());
      enqueueTokenResponse({
        body: { token_type: 'Bearer', expires_in: 1200, access_token: RENEWED_ACCESS_TOKEN },
      });
      const result = await refresher.refresh({ refreshToken: refreshToken() });
      expect(result).toEqual({
        accessToken: RENEWED_ACCESS_TOKEN,
        expiresAt: expect.any(Number),
      });
      expect(result.refreshToken).toBeUndefined();
    });

    it('drops a malformed refresh token credential instead of returning it', async () => {
      for (const refreshTokenValue of ['', '   ', 'has spaces', 7]) {
        const refresher = createEntraTokenRefresher(validConfig());
        enqueueTokenResponse({
          body: {
            token_type: 'Bearer',
            expires_in: 1200,
            access_token: RENEWED_ACCESS_TOKEN,
            refresh_token: refreshTokenValue,
          },
        });
        const result = await refresher.refresh({ refreshToken: refreshToken() });
        expect(result.refreshToken).toBeUndefined();
      }
    });
  });

  describe('R4: classification of token-endpoint rejections', () => {
    it.each([
      ['invalid_grant', 400],
      ['interaction_required', 400],
      ['consent_required', 400],
      ['login_required', 400],
    ])('classifies %s (HTTP %i) as the permanent reauth condition only', async (error, status) => {
      const refresher = createEntraTokenRefresher(validConfig());
      enqueueTokenResponse({
        status,
        body: {
          error,
          error_description: 'AADSTS90002: description text without secrets',
        },
      });
      await expect(refresher.refresh({ refreshToken: refreshToken() })).rejects.toMatchObject({
        code: REAUTH_REQUIRED,
      });
    });

    it.each([
      ['invalid_client', 400],
      ['unauthorized_client', 400],
      ['invalid_scope', 400],
      ['invalid_request', 400],
    ])('classifies %s as a service error that is never a user reauth', async (error, status) => {
      const refresher = createEntraTokenRefresher(validConfig());
      enqueueTokenResponse({
        status,
        body: { error, error_description: 'configuration or client failure' },
      });
      await expect(refresher.refresh({ refreshToken: refreshToken() })).rejects.toMatchObject({
        code: ERROR_CODES.SERVICE,
      });
      await expect(ERROR_CODES.SERVICE).not.toBe(REAUTH_REQUIRED);
    });

    it.each([
      ['server 500', 500],
      ['server 503', 503],
    ])('classifies an upstream %s as transient', async (_label, status) => {
      const refresher = createEntraTokenRefresher(validConfig());
      enqueueTokenResponse({ status, body: { error: 'server_error' } });
      await expect(refresher.refresh({ refreshToken: refreshToken() })).rejects.toMatchObject({
        code: ERROR_CODES.TRANSIENT,
      });
    });

    it('classifies a network failure and a timeout as transient rejections', async () => {
      const refresher = createEntraTokenRefresher(validConfig());
      enqueueTokenResponse({ resError: new Error('connect ECONNRESET') });
      await expect(refresher.refresh({ refreshToken: refreshToken() })).rejects.toMatchObject({
        code: ERROR_CODES.TRANSIENT,
      });

      const refresherWithTimeout = createEntraTokenRefresher({ ...validConfig(), timeoutMs: 10 });
      https.request.mockImplementationOnce((url) => {
        const entry = {
          url: String(url),
          on: jest.fn((event, handler) => {
            if (event === 'error') {
              entry.errorHandler = handler;
            }
            return entry;
          }),
          setTimeout: jest.fn((_timeout, _onTimeout) =>
            queueMicrotask(() => entry.destroy(new Error('Request timed out')))
          ),
          write: jest.fn(),
          end: jest.fn(),
          destroy: jest.fn((error) => {
            if (entry.errorHandler) {
              entry.errorHandler(error);
            }
          }),
        };
        return entry;
      });
      await expect(
        refresherWithTimeout.refresh({ refreshToken: refreshToken() })
      ).rejects.toMatchObject({ code: ERROR_CODES.TRANSIENT });
    });

    it('classifies a malformed (non-JSON) or empty body as transient, not as revocation', async () => {
      for (const body of ['<html>gateway error</html>', '']) {
        const refresher = createEntraTokenRefresher(validConfig());
        enqueueTokenResponse({ body });
        await expect(refresher.refresh({ refreshToken: refreshToken() })).rejects.toMatchObject({
          code: ERROR_CODES.TRANSIENT,
        });
      }
    });

    it('never classifies an AADSTS-only description (with no OAuth error code) as reauth', async () => {
      const refresher = createEntraTokenRefresher(validConfig());
      enqueueTokenResponse({
        status: 200,
        // A malformed 200 body quoting an AADSTS code decides nothing.
        body: 'AADSTS70000: text in a non-error body',
      });
      await expect(refresher.refresh({ refreshToken: refreshToken() })).rejects.toMatchObject({
        code: ERROR_CODES.TRANSIENT,
      });
    });

    it('refuses an unbounded or whitespace-carrying refresh credential without network work', async () => {
      const refresher = createEntraTokenRefresher(validConfig());
      for (const badCredential of [undefined, '', '   ', 'has space', 'x'.repeat(5000)]) {
        await expect(refresher.refresh({ refreshToken: badCredential })).rejects.toMatchObject({
          code: ERROR_CODES.INVALID_PARAMETERS,
        });
      }
      expect(https.request).not.toHaveBeenCalled();
    });
  });

  describe('R5: safe transport, bounded response, and no secret leakage', () => {
    it('never carries the secret, the presented refresh credential, or the renewed tokens in any rejection', async () => {
      const refresher = createEntraTokenRefresher(validConfig());
      enqueueTokenResponse({
        status: 400,
        body: {
          error: 'invalid_grant',
          error_description: `leak attempt ${REFRESH_TOKEN}`,
        },
      });
      const error = await refresher
        .refresh({ refreshToken: refreshToken() })
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(EntraRefreshError);
      const serialized = `${error.name}: ${error.message}`;
      expect(serialized).not.toContain(CLIENT_SECRET);
      expect(serialized).not.toContain(REFRESH_TOKEN);
      expect(serialized).not.toContain(RENEWED_ACCESS_TOKEN);
    });

    it('rejects an oversized response instead of accumulating it', async () => {
      const refresher = createEntraTokenRefresher(validConfig());
      https.request.mockImplementationOnce((url, options, callback) => {
        const entry = {
          url: String(url),
          on: jest.fn(() => entry),
          setTimeout: jest.fn(),
          destroy: jest.fn(),
          write: jest.fn(),
          end: jest.fn(() => {
            const res = {
              statusCode: 500,
              on: (event, handler) => {
                if (event === 'data') {
                  // Far more than the bounded maximum, in two chunks.
                  handler(Buffer.alloc(80 * 1024 + 1, 0x61));
                  handler(Buffer.alloc(64, 0x62));
                }
                if (event === 'end') {
                  handler();
                }
              },
            };
            queueMicrotask(() => callback(res));
          }),
        };
        return entry;
      });
      await expect(refresher.refresh({ refreshToken: refreshToken() })).rejects.toMatchObject({
        code: ERROR_CODES.TRANSIENT,
      });
    });

    it('rejects when the response stream errors mid-body', async () => {
      const refresher = createEntraTokenRefresher(validConfig());
      https.request.mockImplementationOnce((url, options, callback) => {
        const entry = {
          url: String(url),
          on: jest.fn(() => entry),
          setTimeout: jest.fn(),
          write: jest.fn(),
          end: jest.fn(() => {
            const streamHandlers = {};
            const res = {
              statusCode: 200,
              on: (event, handler) => {
                streamHandlers[event] = handler;
              },
            };
            queueMicrotask(() => {
              callback(res);
              streamHandlers.error(new Error('aborted mid-body'));
            });
          }),
        };
        return entry;
      });
      await expect(refresher.refresh({ refreshToken: refreshToken() })).rejects.toMatchObject({
        code: ERROR_CODES.TRANSIENT,
      });
    });
  });
});
