const authIndex = require('../../auth/index');
const TokenStorage = require('../../auth/token-storage');

describe('auth/index', () => {
  it('should export tokenStorage singleton that is a TokenStorage instance', () => {
    expect(authIndex.tokenStorage).toBeDefined();
    expect(authIndex.tokenStorage).toBeInstanceOf(TokenStorage);
  });

  it('isolates concurrent request credentials for Graph and Flow', async () => {
    const makeStore = (name) => ({
      getValidAccessToken: async () => `${name}-graph`,
      getValidFlowAccessToken: async () => `${name}-flow`,
    });
    const run = (name) =>
      authIndex.runWithTokenStorage(makeStore(name), async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return [
          await authIndex.ensureAuthenticated(),
          await authIndex.tokenStorage.getValidFlowAccessToken(),
        ];
      });

    await expect(Promise.all([run('alice'), run('bob')])).resolves.toEqual([
      ['alice-graph', 'alice-flow'],
      ['bob-graph', 'bob-flow'],
    ]);
  });

  it('does not fall back to local credentials when request credentials lack a method', async () => {
    await expect(
      authIndex.runWithTokenStorage({}, () => authIndex.ensureAuthenticated())
    ).rejects.toThrow();
  });
});

describe('request-scoped tokenStorage isolation rules', () => {
  const localSingletonKeys = Object.keys(authIndex.tokenStorage);

  it('hides singleton-only state and methods from request scope', () => {
    authIndex.runWithTokenStorage({}, () => {
      expect('config' in authIndex.tokenStorage).toBe(false);
      expect('tokens' in authIndex.tokenStorage).toBe(false);
      expect(authIndex.tokenStorage.config).toBeUndefined();
      expect(authIndex.tokenStorage.tokens).toBeUndefined();
      expect(authIndex.tokenStorage.getTokens).toBeUndefined();
    });
  });

  it('reports request introspection from the request store only', () => {
    const requestStore = { getValidAccessToken: async () => 'graph-token' };
    authIndex.runWithTokenStorage(requestStore, () => {
      expect(Object.keys(authIndex.tokenStorage)).toEqual(['getValidAccessToken']);
      expect(
        Object.getOwnPropertyDescriptor(authIndex.tokenStorage, 'getValidAccessToken').value
      ).toBe(requestStore.getValidAccessToken);
      expect(Object.getOwnPropertyDescriptor(authIndex.tokenStorage, 'config')).toBeUndefined();
      expect(Object.getPrototypeOf(authIndex.tokenStorage)).toBe(Object.prototype);
    });
  });

  it('writes through to the request store without touching the local singleton', () => {
    const singletonTokensBefore = authIndex.tokenStorage.tokens;
    authIndex.runWithTokenStorage({}, () => {
      authIndex.tokenStorage.tokens = { scoped: true };
      authIndex.tokenStorage.requestOnlyMethod = async () => 'request-token';
      expect(authIndex.tokenStorage.tokens).toEqual({ scoped: true });
      expect(typeof authIndex.tokenStorage.requestOnlyMethod).toBe('function');
      expect('tokens' in authIndex.tokenStorage).toBe(true);
      expect('requestOnlyMethod' in authIndex.tokenStorage).toBe(true);
      expect(Object.keys(authIndex.tokenStorage)).toEqual(['tokens', 'requestOnlyMethod']);
    });
    expect(authIndex.tokenStorage.tokens).toBe(singletonTokensBefore);
    expect(Object.keys(authIndex.tokenStorage)).toEqual(localSingletonKeys);
    expect('requestOnlyMethod' in authIndex.tokenStorage).toBe(false);
  });

  it('refuses singleton mutation attempts from request scope', () => {
    const tokensDescriptorBefore = Object.getOwnPropertyDescriptor(
      authIndex.tokenStorage,
      'tokens'
    );
    authIndex.runWithTokenStorage({}, () => {
      expect(() => {
        delete authIndex.tokenStorage.tokens;
      }).toThrow(TypeError);
      expect(() => {
        delete authIndex.tokenStorage.requestOnlyProperty;
      }).toThrow(TypeError);
      expect(() => {
        Object.defineProperty(authIndex.tokenStorage, 'tokens', { value: { singleton: true } });
      }).toThrow(TypeError);
      expect(() => {
        Object.setPrototypeOf(authIndex.tokenStorage, {});
      }).toThrow(TypeError);
    });
    const tokensDescriptorAfter = Object.getOwnPropertyDescriptor(authIndex.tokenStorage, 'tokens');
    expect(tokensDescriptorAfter).not.toBeUndefined();
    expect(tokensDescriptorAfter.value).toBe(tokensDescriptorBefore.value);
  });

  it('refuses legacy tokenManager access in request scope while keeping stdio access', () => {
    expect(typeof authIndex.tokenManager.getAccessToken).toBe('function');
    expect(typeof authIndex.tokenManager.createTestTokens).toBe('function');
    authIndex.runWithTokenStorage({}, () => {
      expect(() => authIndex.tokenManager.getAccessToken).toThrow(TypeError);
      expect(() => 'getAccessToken' in authIndex.tokenManager).toThrow(TypeError);
    });
  });

  it('validates runWithTokenStorage arguments before entering a request scope', () => {
    expect(() => authIndex.runWithTokenStorage()).toThrow(TypeError);
    expect(() => authIndex.runWithTokenStorage(null, () => {})).toThrow(TypeError);
    expect(() => authIndex.runWithTokenStorage('tokens', () => {})).toThrow(TypeError);
    expect(() => authIndex.runWithTokenStorage({}, null)).toThrow(TypeError);
    expect(() => authIndex.runWithTokenStorage({}, 'not-a-function')).toThrow(TypeError);
  });

  it('propagates request callback failures without touching the local singleton', async () => {
    const singletonTokensBefore = authIndex.tokenStorage.tokens;
    const failing = authIndex.runWithTokenStorage({}, async () => {
      await Promise.resolve();
      throw new Error('request failed');
    });
    const succeeding = authIndex.runWithTokenStorage(
      { getValidAccessToken: async () => 'ok', getValidFlowAccessToken: async () => 'flow' },
      async () => {
        await authIndex.ensureAuthenticated();
        return authIndex.tokenStorage.getValidFlowAccessToken();
      }
    );
    await expect(succeeding).resolves.toBe('flow');
    await expect(failing).rejects.toThrow('request failed');
    expect(authIndex.tokenStorage.tokens).toBe(singletonTokensBefore);
    expect(Object.keys(authIndex.tokenStorage)).toEqual(localSingletonKeys);
  });

  describe('stdio behavior preserved', () => {
    it('keeps unscoped read, write, and deletion on the singleton', () => {
      expect('config' in authIndex.tokenStorage).toBe(true);
      expect(typeof authIndex.tokenStorage.getValidAccessToken).toBe('function');
      expect(Object.keys(authIndex.tokenStorage)).toContain('tokens');
      authIndex.tokenStorage.probeProperty = 'probe';
      expect(authIndex.tokenStorage.probeProperty).toBe('probe');
      expect(delete authIndex.tokenStorage.probeProperty).toBe(true);
      expect('probeProperty' in authIndex.tokenStorage).toBe(false);
    });
  });
});

describe('request scope lifecycle', () => {
  const credentialsFor = (name) => ({
    getValidAccessToken: async () => `${name}-graph`,
    getValidFlowAccessToken: async () => `${name}-flow`,
  });

  it('restores the outer request scope after a nested request store completes', async () => {
    const outerStore = credentialsFor('outer');
    const innerStore = credentialsFor('inner');

    let innerPair = null;
    const outerPair = await authIndex.runWithTokenStorage(outerStore, async () => {
      await Promise.resolve();
      innerPair = await authIndex.runWithTokenStorage(innerStore, async () => {
        await Promise.resolve();
        return [
          await authIndex.ensureAuthenticated(),
          await authIndex.tokenStorage.getValidFlowAccessToken(),
        ];
      });
      await Promise.resolve();
      return [
        await authIndex.ensureAuthenticated(),
        await authIndex.tokenStorage.getValidFlowAccessToken(),
      ];
    });

    expect(innerPair).toEqual(['inner-graph', 'inner-flow']);
    expect(outerPair).toEqual(['outer-graph', 'outer-flow']);
    expect(authIndex.tokenStorage.getValidAccessToken).not.toBe(innerStore.getValidAccessToken);
    expect(authIndex.tokenStorage.getValidFlowAccessToken).not.toBe(
      innerStore.getValidFlowAccessToken
    );
    expect(authIndex.tokenStorage.getValidAccessToken).not.toBe(outerStore.getValidAccessToken);
  });

  it('keeps overlapping asynchronous users isolated across out-of-order completion', async () => {
    const slowStore = credentialsFor('slow-user');
    const fastStore = credentialsFor('fast-user');
    const run = (store, delay) =>
      authIndex.runWithTokenStorage(store, async () => {
        const graph = await authIndex.ensureAuthenticated();
        await new Promise((resolve) => setTimeout(resolve, delay));
        return [graph, await authIndex.tokenStorage.getValidFlowAccessToken()];
      });

    await expect(Promise.all([run(slowStore, 20), run(fastStore, 0)])).resolves.toEqual([
      ['slow-user-graph', 'slow-user-flow'],
      ['fast-user-graph', 'fast-user-flow'],
    ]);
    expect(authIndex.tokenStorage.getValidAccessToken).not.toBe(slowStore.getValidAccessToken);
    expect(authIndex.tokenStorage.getValidAccessToken).not.toBe(fastStore.getValidAccessToken);
  });
});
