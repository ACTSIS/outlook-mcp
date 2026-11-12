/**
 * Docker Compose deployment checks (task T5, spec S4).
 *
 * These are deterministic, daemon-free checks of the deployment contract for
 * the intranet MCP HTTP service (`node bin/m365-mcp.js http` run inside a
 * container):
 *   - the image/runtime is a maintained Node >= 22.22.1 running as non-root;
 *   - the container runs a direct TLS listener on all container interfaces
 *     (a separate reverse proxy cannot reach a container's own loopback);
 *   - the host publishing defaults to the host loopback address only;
 *   - credentials, tokens, keys, and .env files never enter the build
 *     context, and the example configuration contains only dummy values.
 *
 * The rendered configuration is additionally validated through `docker
 * compose config` when the Docker CLI is available; the live deployment
 * itself is exercised manually against the available Docker daemon, not in
 * Jest.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('yaml');

const repoRoot = path.join(__dirname, '..', '..');
const COMPOSE_PATH = path.join(repoRoot, 'compose.yaml');
const DOCKERFILE_PATH = path.join(repoRoot, 'Dockerfile');
const DOCKERIGNORE_PATH = path.join(repoRoot, '.dockerignore');
const ENV_EXAMPLE_PATH = path.join(repoRoot, 'docker-env.example');
const README_PATH = path.join(repoRoot, 'README.md');

const REQUIRED_REMOTE_ENV_KEYS = ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET'];

/** Keys the Compose deployment itself requires on top of the remote keys. */
const REQUIRED_COMPOSE_ENV_KEYS = ['MCP_HTTP_EXTERNAL_BASE_URL'];

/**
 * Reads a required deployment file. A missing file is a hard failure — the
 * deployment contract ships together, so the suite must never silently skip
 * the checks for an absent file.
 */
function readRequiredDeploymentFile(file, description) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`Required deployment file is missing (${description}): ${file}`);
    }
    throw error;
  }
}

describe('MCP HTTP docker-compose deployment', () => {
  const composeFile = readRequiredDeploymentFile(
    COMPOSE_PATH,
    'the Compose deployment contract must ship with the tests'
  );

  describe('compose.yaml', () => {
    test('parses as YAML and defines exactly one HTTP MCP service running the http entry point', () => {
      const compose = parse(composeFile);
      const services = Object.entries(compose.services || {});
      expect(services).toHaveLength(1);
      const [serviceName, service] = services[0];
      expect(typeof serviceName).toBe('string');
      expect(service.command).toEqual(['node', 'bin/m365-mcp.js', 'http']);
      expect(service.build).toBeDefined();
    });

    test('publishes the listener to the host loopback by default with a configurable host and port', () => {
      const compose = parse(composeFile);
      const [service] = Object.values(compose.services);
      const ports = service.ports || [];
      expect(ports).toHaveLength(1);
      const mapping = typeof ports[0] === 'string' ? ports[0] : JSON.stringify(ports[0]);
      expect(mapping).toContain('${MCP_HTTP_PUBLISHED_HOST:-127.0.0.1}');
      expect(mapping).toContain('${MCP_HTTP_PUBLISHED_PORT:-8443}');
    });

    test('runs a direct TLS listener on all container interfaces with a read-only certificate mount', () => {
      const compose = parse(composeFile);
      const [service] = Object.values(compose.services);
      const environment = service.environment || {};
      expect(environment.MCP_HTTP_HOST).toBe('0.0.0.0');
      expect(environment.MCP_HTTP_TLS_CERT).toContain('/run/tls/');
      expect(environment.MCP_HTTP_TLS_KEY).toContain('/run/tls/');
      const volumes = (service.volumes || []).map((volume) =>
        typeof volume === 'string' ? volume : JSON.stringify(volume)
      );
      const tlsMount = volumes.find((volume) => volume.includes('/run/tls'));
      expect(tlsMount).toBeDefined();
      expect(tlsMount.replace(/"/g, '')).toMatch(/:ro'?$/);
    });

    test('injects no credentials itself; runtime configuration comes from an optional .env.docker file', () => {
      expect(composeFile).not.toMatch(/^\s*(ENTRA_|.*SECRET|.*TOKEN).*:\s*[^$]/im);
      const compose = parse(composeFile);
      const [service] = Object.values(compose.services);
      const envFile = service.env_file || [];
      const entries = Array.isArray(envFile) ? envFile : [envFile];
      const dockerEnv = entries.find((entry) =>
        typeof entry === 'string' ? entry === '.env.docker' : entry.path === '.env.docker'
      );
      expect(dockerEnv).toBeDefined();
      if (typeof dockerEnv === 'object') {
        expect(dockerEnv.required).toBe(false);
      }
    });

    test('does not use host networking, privileged mode, or a separate proxy container', () => {
      const compose = parse(composeFile);
      const [service] = Object.values(compose.services);
      expect(service.network_mode).toBeUndefined();
      expect(service.privileged).toBeFalsy();
      expect(Object.values(compose.services || {})).toHaveLength(1);
    });

    /**
     * T28 (S12, S15): the service image stays the locally built
     * outlook-mcp-http:local tag by default (the offline release-archive
     * flow) and becomes overridable only through an explicit
     * MCP_HTTP_IMAGE Compose interpolation variable pointing at the
     * published GHCR image.
     */
    test('defaults the service image to the local tag and allows only an explicit MCP_HTTP_IMAGE override (T28)', () => {
      const compose = parse(composeFile);
      const [service] = Object.values(compose.services);
      expect(service.image).toBe('${MCP_HTTP_IMAGE:-outlook-mcp-http:local}');
      expect(service.build).toBeDefined();
      expect(composeFile).toMatch(/MCP_HTTP_IMAGE/);
    });
  });

  /**
   * T9 (S4-S6): the explicitly opted-in LOCAL development Compose config.
   * It runs without TLS for the browser-facing loopback flow, pins the
   * published host port exactly to 127.0.0.1, and overrides the user's
   * production HTTPS base URL/redirect to their http://localhost:8443
   * equivalents so no user environment edit is needed.
   */
  describe('compose.local.yaml (local development, explicitly opted-in HTTP)', () => {
    const LOCAL_COMPOSE_PATH = path.join(repoRoot, 'compose.local.yaml');
    const localComposeFile = readRequiredDeploymentFile(
      LOCAL_COMPOSE_PATH,
      'the local development Compose contract must ship with the tests'
    );

    test('parses as YAML and defines exactly one service running the http entry point', () => {
      const compose = parse(localComposeFile);
      const services = Object.entries(compose.services || {});
      expect(services).toHaveLength(1);
      const [, service] = services[0];
      expect(service.command).toEqual(['node', 'bin/m365-mcp.js', 'http']);
      expect(service.build).toBeDefined();
    });

    // T28 (S12, S15): the build/dev default stays pinned to the local
    // image; no MCP_HTTP_IMAGE interpolation exists in the local config.
    test('keeps the local build/dev image hard-pinned with no MCP_HTTP_IMAGE override (T28)', () => {
      const compose = parse(localComposeFile);
      const [service] = Object.values(compose.services);
      expect(service.image).toBe('outlook-mcp-http:local');
      expect(localComposeFile).not.toMatch(/MCP_HTTP_IMAGE/);
    });

    test('pins the published host port exactly to 127.0.0.1 with no wildcard or configurable host', () => {
      const compose = parse(localComposeFile);
      const [service] = Object.values(compose.services);
      const ports = service.ports || [];
      expect(ports).toHaveLength(1);
      const mapping = typeof ports[0] === 'string' ? ports[0] : JSON.stringify(ports[0]);
      expect(mapping).toContain('127.0.0.1:');
      // The host side must never be interpolatable to a public or intranet
      // interface: no published-host variable at all in the local config.
      expect(mapping).not.toContain('${MCP_HTTP_PUBLISHED_HOST');
      expect(mapping).not.toContain('0.0.0.0');
    });

    test('opts into the local HTTP mode and overrides the base URL and Entra callback to plain loopback HTTP', () => {
      const compose = parse(localComposeFile);
      const [service] = Object.values(compose.services);
      const environment = service.environment || {};
      expect(environment.MCP_HTTP_ALLOW_LOCAL_HTTP).toBe('true');
      expect(environment.MCP_HTTP_EXTERNAL_BASE_URL).toBe('http://localhost:8443');
      expect(environment.MCP_HTTP_LOGIN_REDIRECT_URI).toBe('http://localhost:8443/login/callback');
    });

    test('runs a container wildcard HTTP listener without any TLS certificate env or TLS mount', () => {
      const compose = parse(localComposeFile);
      const [service] = Object.values(compose.services);
      const environment = service.environment || {};
      expect(environment.MCP_HTTP_HOST).toBe('0.0.0.0');
      expect(String(environment.MCP_HTTP_PORT)).toBe('8443');
      expect(Object.keys(environment)).toEqual(
        expect.not.arrayContaining([expect.stringMatching(/TLS/i)])
      );
      // Never create an empty TLS mount in the local development config.
      const volumes = (service.volumes || []).map((volume) =>
        typeof volume === 'string' ? volume : JSON.stringify(volume)
      );
      expect(volumes.find((volume) => volume.includes('/run/tls'))).toBeUndefined();
    });

    test('keeps runtime configuration in the optional .env.docker env_file and stays hard-coded to dev mode only via compose environment', () => {
      const compose = parse(localComposeFile);
      const [service] = Object.values(compose.services);
      const envFile = service.env_file || [];
      const entries = Array.isArray(envFile) ? envFile : [envFile];
      const dockerEnv = entries.find((entry) =>
        typeof entry === 'string' ? entry === '.env.docker' : entry.path === '.env.docker'
      );
      expect(dockerEnv).toBeDefined();
      if (typeof dockerEnv === 'object') {
        expect(dockerEnv.required).toBe(false);
      }
      // No Entra identifiers or secrets are baked into the local config
      // itself; only the mode-switching values live here.
      const environment = service.environment || {};
      expect(Object.keys(environment).filter((key) => /ENTRA_|SECRET|TOKEN/i.test(key))).toEqual(
        []
      );
    });

    test('discloses the unencrypted container-network plaintext risk and its local-only scope', () => {
      expect(localComposeFile).toMatch(/unencrypted/i);
      expect(localComposeFile).toMatch(/local development/i);
    });
  });

  describe('docker-env.example', () => {
    const envExample = readRequiredDeploymentFile(
      ENV_EXAMPLE_PATH,
      'the Docker runtime configuration template must ship with the tests'
    );

    describe('placeholder configuration', () => {
      test('provides a placeholder for every required remote configuration key', () => {
        for (const key of REQUIRED_REMOTE_ENV_KEYS) {
          const line = envExample.split('\n').find((text) => text.startsWith(`${key}=`));
          expect(line).toEqual(expect.any(String));
        }
      });

      test('carries no separate MCP mutation-group configuration (S3)', () => {
        expect(envExample).not.toMatch(/^#?ENTRA_MUTATION_GROUP_ID=/m);
      });

      test('actively requires the externally reachable base URL for the wildcard container bind', () => {
        for (const key of REQUIRED_COMPOSE_ENV_KEYS) {
          const active = envExample.split('\n').filter((text) => text.startsWith(`${key}=`));
          expect(active).toHaveLength(1);
          expect(active[0].split('=')[1].trim()).toMatch(/^https:\/\//);
        }
      });

      test('contains only dummy, non-working placeholder values and no real secret', () => {
        const activeLines = envExample.split('\n').filter((text) => /^[A-Z0-9_]+=/.test(text));
        expect(activeLines.length).toBeGreaterThan(0);
        for (const line of activeLines) {
          const key = line.split('=')[0];
          const value = line.slice(key.length + 1);
          expect(value.trim()).not.toBe('');
          if (key.includes('SECRET')) {
            expect(value.toLowerCase()).toContain('replace');
          }
          if (key === 'ENTRA_TENANT_ID') {
            expect(value).toBe('00000000-0000-0000-0000-000000000000');
          }
          if (key === 'ENTRA_CLIENT_ID') {
            expect(value).toMatch(
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            );
          }
        }
      });

      /**
       * T16 (S5,S10) updated by T20 (S11): the user rejected the
       * separate per-agent direct-Entra setup, so the sample presents the
       * persistent bridge as the chosen flow and keeps direct Entra mode
       * as the documented optional alternative.
       */
      test('documents the explicit MCP_HTTP_AUTH_MODE selector with the chosen persistent bridge and direct as optional', () => {
        const documented = envExample
          .split('\n')
          .filter((text) => /^#?MCP_HTTP_AUTH_MODE=/.test(text));
        expect(documented).toHaveLength(1);
        expect(documented[0]).toBe('#MCP_HTTP_AUTH_MODE=bridge');
        expect(envExample).toMatch(/direct/i);
        expect(envExample).toMatch(/chosen/i);
        expect(envExample).toMatch(/optional/i);
      });

      test('never enables test mode', () => {
        const activeLines = envExample.split('\n').filter((text) => /^[A-Z0-9_]+=/.test(text));
        for (const line of activeLines) {
          expect(line.startsWith('USE_TEST_MODE=')).toBe(false);
        }
        expect(envExample).toContain('USE_TEST_MODE');
      });

      test('is documented as git-ignored and docker-ignored runtime-only configuration', () => {
        expect(envExample).toMatch(/git-ignored|never be committed/i);
        expect(envExample).toMatch(/docker-ignored/i);
      });

      /**
       * T28 (S15): the sample documents the optional MCP_HTTP_IMAGE override
       * for the published GHCR image, and is explicit that Compose resolves
       * that interpolation from the shell environment, the Compose project
       * .env, or --env-file — never from the service env_file.
       */
      test('documents the MCP_HTTP_IMAGE image override as a Compose substitution outside the service env_file (T28)', () => {
        expect(envExample).toMatch(/^#MCP_HTTP_IMAGE=/m);
        expect(envExample).not.toMatch(/^MCP_HTTP_IMAGE=/m);
        expect(envExample).toMatch(/--env-file/);
        expect(envExample).toMatch(/does NOT participate/i);
        expect(envExample).toMatch(/ghcr\.io\//);
      });

      // T8 correction, updated by T12: v2 access tokens carry the API app's
      // client ID GUID in `aud` and short scope names in `scp`, while the
      // Entra authorization request needs the resource-qualified api://
      // scope. The minimal setup no longer configures any of the three:
      // audience, required scope, and upstream scope derive from
      // ENTRA_CLIENT_ID (GUID aud, mcp.access scp default, api://<client
      // id>/<scope> upstream default), so the sample keeps them as clearly
      // commented optional GUID/short/api:// overrides and never as an
      // API-qualified REQUIRED_SCOPES value.
      test('keeps the GUID audience, short scp, and api:// upstream as documented optional overrides of the derived v2 defaults', () => {
        const audience = envExample
          .split('\n')
          .filter((text) => /^#?MCP_HTTP_AUDIENCE=/.test(text));
        expect(audience).toHaveLength(1);
        expect(audience[0]).toMatch(
          /^#MCP_HTTP_AUDIENCE=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
        const requiredScopes = envExample
          .split('\n')
          .filter((text) => /^#?MCP_HTTP_REQUIRED_SCOPES=/.test(text));
        expect(requiredScopes).toHaveLength(1);
        expect(requiredScopes[0]).toBe('#MCP_HTTP_REQUIRED_SCOPES=mcp.access');
        expect(envExample).toMatch(/^#MCP_HTTP_UPSTREAM_SCOPES=api:\/\//m);
        // The minimal setup itself relies on the derived defaults and says
        // so instead of configuring audience or scopes at all.
        expect(envExample).toMatch(/derive/);
      });
    });
  });

  describe('.dockerignore', () => {
    const contextFile = readRequiredDeploymentFile(
      DOCKERIGNORE_PATH,
      'build-context hygiene must ship with the tests'
    );

    describe('build-context hygiene', () => {
      test('excludes node_modules, .git, env files, PEM keys/certs, and token files', () => {
        const patterns = contextFile.split('\n').map((text) => text.trim());
        const has = (pattern) => patterns.includes(pattern);
        expect(has('node_modules/')).toBe(true);
        expect(has('.git/')).toBe(true);
        expect(has('.env')).toBe(true);
        expect(has('.env.*')).toBe(true);
        expect(has('*.pem')).toBe(true);
        expect(has('*.key')).toBe(true);
        expect(has('*.token.json')).toBe(true);
        expect(has('vault-token.json')).toBe(true);
      });

      test('never re-includes excluded secrets, env files, or key material', () => {
        const reIncludes = contextFile
          .split('\n')
          .filter((text) => text.trim().startsWith('!'))
          .map((text) => text.trim().slice(1));
        for (const included of reIncludes) {
          expect(included).not.toMatch(/\.env|\.pem|\.key|token|secret/i);
        }
      });
    });
  });
});

describe('Dockerfile', () => {
  const dockerfile = readRequiredDeploymentFile(
    DOCKERFILE_PATH,
    'the container image contract must ship with the tests'
  );

  describe('image contract', () => {
    test('builds on a pinned maintained Node image at or above 22.22.1', () => {
      const fromLine = dockerfile.split('\n').find((text) => text.startsWith('FROM node:'));
      expect(fromLine).toEqual(expect.any(String));
      const match = fromLine.match(/FROM node:(\d{1,3})\.(\d{1,3})\.(\d{1,3})-[\w.-]+$/);
      expect(match).toEqual(expect.any(Array));
      const [, major, minor, patch] = match;
      const compare =
        Number(major) !== 22
          ? Number(major) - 22
          : Number(minor) !== 22
            ? Number(minor) - 22
            : Number(patch) - 1;
      expect(compare).toBeGreaterThanOrEqual(0);
    });

    test('installs only locked production dependencies without lifecycle scripts', () => {
      expect(dockerfile).toMatch(/npm ci --omit=dev --ignore-scripts/);
      expect(dockerfile).not.toMatch(/^\s*RUN npm (install|ci)(?! --omit=dev --ignore-scripts)/m);
    });

    test('runs as a non-root user for the final runtime stage', () => {
      const userLines = dockerfile
        .split('\n')
        .map((text) => text.trim())
        .filter((text) => text.startsWith('USER '));
      expect(userLines).toEqual(expect.any(Array));
      const lastUser = userLines[userLines.length - 1];
      expect(lastUser).not.toMatch(/root|0/);
      const cmdIndex = dockerfile.indexOf('CMD [');
      const lastUserIndex = dockerfile.lastIndexOf(lastUser);
      expect(lastUserIndex).toBeLessThan(cmdIndex);
    });

    test('copies only the runtime module graph and never env, token, key, or credential files', () => {
      const copyArgs = dockerfile
        .split('\n')
        .filter((text) => text.startsWith('COPY'))
        .map((text) => text.replace('COPY', ' ').split(/\s+/))
        .flat();
      for (const argument of copyArgs) {
        expect(argument).not.toMatch(/\.env|\.pem|\.key|token|secret|\.git/i);
      }
      expect(dockerfile).toMatch(/CMD \["node", "bin\/m365-mcp\.js", "http"\]/);
    });
  });
});

describe('deployment documentation', () => {
  test('README documents the Compose deployment and the Docker configuration file', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    expect(readme).toMatch(/docker compose/i);
    expect(readme).toMatch(/\.env\.docker/);
  });

  test('README records that live Entra behavior for the HTTP mode is unverified', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    expect(readme).toMatch(/not yet validated against a real Entra tenant/i);
  });
});

/**
 * T20 (S4-S6, S11): durable encrypted bridge persistence in the deployment
 * contract. One test per rule: the dedicated /app/data/oauth named volume,
 * its Compose environment wiring, the Dockerfile directory preparation
 * (ownership and mode, with no key generation at build time), the local
 * explicit bridge mode override, the single-replica boundary, and honest
 * deployment documentation.
 */
describe('T20 bridge persistence deployment (S4-S6, S11)', () => {
  const composeText = readRequiredDeploymentFile(
    COMPOSE_PATH,
    'the production Compose config must ship with the tests'
  );
  const compose = parse(composeText);
  const LOCAL_COMPOSE_PATH = path.join(repoRoot, 'compose.local.yaml');
  const localText = readRequiredDeploymentFile(
    LOCAL_COMPOSE_PATH,
    'the local development Compose config must ship with the tests'
  );
  const localCompose = parse(localText);
  const dockerfile = readRequiredDeploymentFile(
    DOCKERFILE_PATH,
    'the container image contract must ship with the tests'
  );

  describe('durable store volume and wiring', () => {
    test('compose.yaml mounts a project-scoped named volume at /app/data/oauth and never an external or fixed-name shared volume', () => {
      const [service] = Object.values(compose.services || {});
      const volumes = (service.volumes || []).map((volume) =>
        typeof volume === 'string' ? volume : JSON.stringify(volume)
      );
      const mount = volumes.find((volume) => volume.split(':')[1] === '/app/data/oauth');
      expect(mount).toBeDefined();
      const [source] = mount.split(':');
      const declared = (compose.volumes || {})[source];
      // Project-scoped: no fixed name that would conflate separate projects,
      // and never an external generic volume. The declared volume must exist
      // in the Compose `volumes` map; an empty YAML mapping parses as null,
      // which Compose treats exactly like `{}` — the default
      // project-scoped named volume.
      expect(source in (compose.volumes || {})).toBe(true);

      expect(declared === null || typeof declared === 'object').toBe(true);
      expect((declared && (declared.name || declared.external)) || null).toBeNull();
    });

    test('compose.local.yaml mounts its own project-scoped named volume at /app/data/oauth', () => {
      const [service] = Object.values(localCompose.services || {});
      const volumes = (service.volumes || []).map((volume) =>
        typeof volume === 'string' ? volume : JSON.stringify(volume)
      );
      const mount = volumes.find((volume) => volume.split(':')[1] === '/app/data/oauth');
      expect(mount).toBeDefined();
      const [source] = mount.split(':');
      const declared = (localCompose.volumes || {})[source];
      expect(source in (localCompose.volumes || {})).toBe(true);
      expect(declared === null || typeof declared === 'object').toBe(true);
      expect((declared && (declared.name || declared.external)) || null).toBeNull();
      // Distinct from the production volume key, so the same Compose
      // directory cannot silently share one store between both configs.
      const localSources = volumes.map((volume) => volume.split(':')[0]);
      const productionSources = (
        compose.services[Object.keys(compose.services)[0]].volumes || []
      ).map(
        (volume) => (typeof volume === 'string' ? volume : JSON.stringify(volume)).split(':')[0]
      );
      expect(localSources.every((source) => !productionSources.includes(source))).toBe(true);
    });

    test('both Compose files point MCP_HTTP_BRIDGE_STORE_DIR exactly at the mounted /app/data/oauth path', () => {
      const [productionService] = Object.values(compose.services || {});
      const [localService] = Object.values(localCompose.services || {});
      expect(productionService.environment.MCP_HTTP_BRIDGE_STORE_DIR).toBe('/app/data/oauth');
      expect(localService.environment.MCP_HTTP_BRIDGE_STORE_DIR).toBe('/app/data/oauth');
    });

    test('compose.local.yaml forces the persistent bridge mode explicitly, independent of the user .env.docker mode', () => {
      const [service] = Object.values(localCompose.services || {});
      expect(service.environment.MCP_HTTP_AUTH_MODE).toBe('bridge');
    });

    test('production compose never silently overrides the explicit user auth mode', () => {
      const [service] = Object.values(compose.services || {});
      expect(service.environment.MCP_HTTP_AUTH_MODE).toBeUndefined();
      expect(
        Object.keys(service.environment || {}).filter((key) => key === 'MCP_HTTP_AUTH_MODE')
      ).toEqual([]);
    });

    test('pins exactly one replica and documents the single-node store with no distributed lock', () => {
      for (const document of [compose, localCompose]) {
        const [service] = Object.values(document.services || {});
        expect(service.deploy.replicas).toBe(1);
      }
      expect(composeText + localText).toMatch(/not a distributed lock|no distributed lock/i);
    });
  });

  describe('Dockerfile directory preparation', () => {
    test('prepares /app/data/oauth owned by uid 1000 with mode 0700 before switching to the runtime user, baking in no key material', () => {
      const runLine = dockerfile
        .split('\n')
        .find((text) => text.includes('mkdir -p /app/data/oauth'));
      expect(runLine).toEqual(expect.any(String));
      const runBlock = dockerfile
        .slice(
          dockerfile.indexOf('mkdir -p /app/data/oauth'),
          dockerfile.indexOf('mkdir -p /app/data/oauth') + 400
        )
        .split('\n')
        .filter((text) => text.trim().startsWith('&&') || text.includes('mkdir -p /app/data/oauth'))
        .join('\n');
      expect(runBlock).toMatch(/chown 1000:1000|chown node:node/);
      expect(runBlock).toMatch(/chmod 0700/);
      // Order: the preparation happens before the runtime user switch.
      const lines = dockerfile.split('\n');
      const runIndex = lines.findIndex((text) => text.includes('mkdir -p /app/data/oauth'));
      const firstUserIndex = lines.findIndex((text) => text.trim().startsWith('USER '));
      expect(runIndex).toBeLessThan(firstUserIndex);
      // No credentials or keys are generated during the build.
      const preparation = dockerfile.slice(runIndex, runIndex + 400);
      expect(preparation).not.toMatch(/openssl|generateKey|node -[er]|\.key/);
    });
  });

  describe('hardened posture retained', () => {
    test('both files keep the read-only root, /tmp tmpfs, dropped capabilities, and no-new-privileges', () => {
      for (const document of [compose, localCompose]) {
        const [service] = Object.values(document.services || {});
        expect(service.read_only).toBe(true);
        expect(service.tmpfs).toContain('/tmp');
        expect(service.cap_drop).toContain('ALL');
        expect(service.security_opt).toContain('no-new-privileges:true');
      }
    });
  });

  /**
   * T21 (S4, S11): the single-replica note must be honest about what the
   * generation counter actually gives: it detects stale snapshots (a writer
   * that started before another writer committed), but it is not atomic
   * exclusion and simultaneous writers are not guaranteed to fail closed.
   * Only a single replica is safe, and the old text claiming writers
   * "conflict and fail closed" overstated the guarantee.
   */
  describe('single-replica boundary is stated honestly (T21)', () => {
    test('both Compose files explain stale-snapshot detection, no atomic exclusion, and no fail-closed guarantee for simultaneous writers', () => {
      expect(composeText).toMatch(/stale snapshots/i);
      expect(localText).toMatch(/stale snapshots/i);
      expect(composeText + localText).toMatch(/not a distributed lock|no distributed lock/i);
      expect(composeText + localText).toMatch(/not.*atomic exclusion|no atomic exclusion/i);
      expect(composeText + localText).toMatch(/not ( )?guaranteed to fail closed/i);
      // The old overstated wording must be gone: no claim that two live
      // writers simply conflict and fail closed.
      expect(composeText + localText).not.toMatch(/conflict and fail closed/i);
    });

    test('compose.yaml no longer claims mutation-group configuration (S3 removal)', () => {
      expect(composeText).not.toMatch(/mutation group/i);
    });
  });

  describe('deployment documentation (T20)', () => {
    test('README documents the durable volume, the no-data-loss rules, and the single-replica boundary honestly', () => {
      const readme = fs.readFileSync(README_PATH, 'utf8');
      expect(readme).toMatch(/\/app\/data\/oauth/);
      expect(readme).toMatch(/down -v/);
      expect(readme).toMatch(/together/i);
      expect(readme).toMatch(/no distributed lock/i);
      expect(readme).toMatch(/replicas: 1/);
      // Sessions survive container recreation but a lost volume or key is
      // unrecoverable, and the login is not perpetual.
      expect(readme).toMatch(/must sign in again|sign in again/i);
      expect(readme).toMatch(/not an eternal login|not perpetual|perpetual/i);
    });

    test('README documents the reverted MCP client configuration: pi-local loopback callback on 8765 with scope mcp and no per-agent Entra app', () => {
      const readme = fs.readFileSync(README_PATH, 'utf8');
      expect(readme).toMatch(/8765/);
      expect(readme).toMatch(/scope `mcp`|"mcp"/);
      expect(readme).toMatch(
        /no separate per-agent Entra application|no per-agent Entra application/i
      );
    });

    test('persistence documentation covers the container deployment, the fresh initial offline_access login, and un-recoverability', () => {
      const persistenceDoc = fs.readFileSync(
        path.join(repoRoot, 'docs', 'oauth-persistence.md'),
        'utf8'
      );
      expect(persistenceDoc).toMatch(/\/app\/data\/oauth/);
      expect(persistenceDoc).toMatch(/down -v/);
      expect(persistenceDoc).toMatch(/offline_access/);
      expect(persistenceDoc).toMatch(/no distributed lock/i);
      expect(persistenceDoc).toMatch(/deploy\.replicas/i);
      expect(persistenceDoc).toMatch(/replicas: 1/);
    });
  });

  describe('build context hygiene (T20)', () => {
    test('.dockerignore re-includes only runtime modules and never store data or key artifacts', () => {
      const patterns = fs
        .readFileSync(DOCKERIGNORE_PATH, 'utf8')
        .split('\n')
        .map((text) => text.trim())
        .filter((text) => text && !text.startsWith('#'));
      const reIncludes = patterns
        .filter((pattern) => pattern.startsWith('!'))
        .map((pattern) => pattern.slice(1));
      for (const included of reIncludes) {
        expect(included).not.toMatch(/bridge-store|\.bin$|\.key$|bridge_store/i);
      }
      expect(patterns).toContain('*.key');
    });
  });
});

describe('docker compose configuration rendering', () => {
  function dockerComposeAvailable() {
    try {
      execFileSync('docker', ['compose', 'version'], { stdio: 'ignore', timeout: 15000 });
      return true;
    } catch {
      return false;
    }
  }

  const maybe = dockerComposeAvailable() ? test : test.skip;
  maybe('renders a valid effective configuration through the Docker CLI', () => {
    const rendered = parse(
      execFileSync('docker', ['compose', '-f', 'compose.yaml', 'config', '--format', 'json'], {
        cwd: repoRoot,
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf8',
      })
    );
    const [service] = Object.values(rendered.services);
    const published = service.ports || [];
    expect(published).toHaveLength(1);
    // Default interpolation: host loopback only, configurable through shell
    // environment; the container side always targets the TLS listener.
    expect(published[0].host_ip).toBe('127.0.0.1');
    expect(String(published[0].target)).toBe('8443');
  });
});
