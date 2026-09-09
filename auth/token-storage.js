const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const querystring = require('querystring');
const appConfig = require('../config');
const vaultClient = require('../runtime/vault-client');
const { createEntraOAuthError, isPermanentEntraOAuthFailure } = require('./entra-error');
const { createContextualError } = require('../utils/network-error');

function createTokenRequestError(operation, endpoint, error, secrets, fallbackCode) {
  return createContextualError(operation, endpoint, error, {
    fallbackCode,
    secrets,
  });
}

class TokenStorage {
  constructor(config) {
    const configOverrides = config || {};
    const tenantId = process.env.MS_TENANT_ID || 'common';
    const authorityHost = (
      process.env.MS_AUTHORITY_HOST || 'https://login.microsoftonline.com'
    ).replace(/\/+$/, '');

    // Match config.js precedence so token exchange uses the same credentials
    // that the MCP tool and callback server advertise.
    const clientId = process.env.OUTLOOK_CLIENT_ID || process.env.MS_CLIENT_ID;
    const clientSecret = process.env.OUTLOOK_CLIENT_SECRET || process.env.MS_CLIENT_SECRET;

    this.config = {
      tokenStorePath: path.join(
        process.env.HOME || process.env.USERPROFILE,
        '.outlook-mcp-tokens.json'
      ),
      clientId,
      clientSecret,
      redirectUri: process.env.MS_REDIRECT_URI || 'http://localhost:3333/auth/callback',
      scopes: (process.env.MS_SCOPES || appConfig.AUTH_CONFIG.scopes.join(' ')).split(' '),
      flowScope: appConfig.FLOW_SCOPE,
      tenantId,
      tokenEndpoint:
        process.env.MS_TOKEN_ENDPOINT || `${authorityHost}/${tenantId}/oauth2/v2.0/token`,
      refreshTokenBuffer: 5 * 60 * 1000, // 5 minutes buffer for token refresh
      ...configOverrides, // Allow overriding default config
    };
    this._runtimeConfigOverrides = new Set(Object.keys(configOverrides));
    this.tokens = null;
    this._loadPromise = null;
    this._refreshPromise = null;
    this._flowRefreshPromise = null;

    if (!this.config.clientId || !this.config.clientSecret) {
      console.warn(
        'TokenStorage: MS_CLIENT_ID/MS_CLIENT_SECRET (or OUTLOOK_CLIENT_ID/OUTLOOK_CLIENT_SECRET) is not configured. Token operations might fail.'
      );
    }

    if (process.env.MS_SCOPES && !this.config.scopes.includes('offline_access')) {
      console.warn(
        'MS_SCOPES override is missing offline_access — refresh tokens will not be issued.'
      );
    }
  }

  /**
   * Refresh environment-derived authentication settings after an explicit
   * Vault setup updates process.env. Constructor overrides remain testable and
   * continue to win over runtime values.
   * @returns {object} The refreshed TokenStorage configuration
   */
  refreshRuntimeConfiguration() {
    const authConfig = appConfig.refreshAuthConfig
      ? appConfig.refreshAuthConfig()
      : appConfig.AUTH_CONFIG;
    const authorityHost = (
      process.env.MS_AUTHORITY_HOST || 'https://login.microsoftonline.com'
    ).replace(/\/+$/, '');
    const tenantId = process.env.MS_TENANT_ID || 'common';
    const runtimeValues = {
      clientId: process.env.OUTLOOK_CLIENT_ID || process.env.MS_CLIENT_ID || '',
      clientSecret: process.env.OUTLOOK_CLIENT_SECRET || process.env.MS_CLIENT_SECRET || '',
      redirectUri: process.env.MS_REDIRECT_URI || authConfig.redirectUri,
      scopes: process.env.MS_SCOPES
        ? process.env.MS_SCOPES.split(/\s+/).filter(Boolean)
        : authConfig.scopes,
      tenantId,
      tokenEndpoint:
        process.env.MS_TOKEN_ENDPOINT || `${authorityHost}/${tenantId}/oauth2/v2.0/token`,
      flowScope: appConfig.FLOW_SCOPE,
    };

    for (const [key, value] of Object.entries(runtimeValues)) {
      if (!this._runtimeConfigOverrides.has(key)) this.config[key] = value;
    }

    return this.config;
  }

  async _invalidateVaultCacheOnPermanentEntraFailure(error) {
    if (!isPermanentEntraOAuthFailure(error)) return;

    try {
      await vaultClient.invalidateVaultTokenCache(vaultClient.getVaultConfig());
    } catch {
      // Cache invalidation must never mask the original authentication error.
    }
  }

  async _loadTokensFromFile() {
    try {
      const tokenData = await fs.readFile(this.config.tokenStorePath, 'utf8');
      this.tokens = JSON.parse(tokenData);
      console.log('Tokens loaded from file.');
      return this.tokens;
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('Token file not found. No tokens loaded.');
      } else {
        console.error('Error loading token cache:', error);
      }
      this.tokens = null;
      return null;
    }
  }

  async _saveTokensToFile() {
    if (!this.tokens) {
      console.warn('No tokens to save.');
      return false;
    }
    try {
      await fs.writeFile(this.config.tokenStorePath, JSON.stringify(this.tokens, null, 2), {
        mode: 0o600,
      });
      console.log('Tokens saved successfully.');
    } catch (error) {
      console.error('Error saving token cache:', error);
      throw error;
    }
  }

  async getTokens() {
    if (this.tokens) {
      return this.tokens;
    }
    if (!this._loadPromise) {
      this._loadPromise = this._loadTokensFromFile().finally(() => {
        this._loadPromise = null; // Reset promise once completed
      });
    }
    return this._loadPromise;
  }

  getExpiryTime() {
    return this.tokens && this.tokens.expires_at ? this.tokens.expires_at : 0;
  }

  isTokenExpired() {
    if (!this.tokens || !this.tokens.expires_at) {
      return true; // No token or no expiry means it's effectively expired or invalid
    }
    // Check if current time is past expiry time, considering a buffer
    return Date.now() >= this.tokens.expires_at - this.config.refreshTokenBuffer;
  }

  getFlowExpiryTime() {
    return this.tokens && this.tokens.flow_expires_at ? this.tokens.flow_expires_at : 0;
  }

  isFlowTokenExpired() {
    if (!this.tokens || !this.tokens.flow_expires_at) {
      return true; // No flow token or no expiry means it's effectively expired or invalid
    }
    return Date.now() >= this.tokens.flow_expires_at - this.config.refreshTokenBuffer;
  }

  async getFlowAccessToken() {
    if (!this.tokens) {
      await this.getTokens();
    }

    if (!this.tokens || !this.tokens.flow_access_token || this.isFlowTokenExpired()) {
      return null;
    }

    return this.tokens.flow_access_token;
  }

  async saveFlowTokens(flowTokens) {
    await this.getTokens(); // Ensure existing tokens are loaded

    this.tokens = {
      ...this.tokens,
      flow_access_token: flowTokens.access_token,
      flow_expires_at: flowTokens.expires_at || Date.now() + (flowTokens.expires_in || 3600) * 1000,
    };

    if (flowTokens.refresh_token) {
      this.tokens.flow_refresh_token = flowTokens.refresh_token;
    }

    await this._saveTokensToFile();
  }

  async getValidFlowAccessToken() {
    await this.getTokens(); // Ensure tokens are loaded

    if (!this.tokens || !this.tokens.flow_access_token) {
      console.log('No flow access token available.');
      return null;
    }

    if (this.isFlowTokenExpired()) {
      console.log('Flow access token expired or nearing expiration. Attempting refresh.');
      if (this.tokens.flow_refresh_token) {
        try {
          return await this.refreshFlowAccessToken();
        } catch (refreshError) {
          console.error('Failed to refresh flow access token:', refreshError);
          // Only invalidate flow tokens for permanent failures, not transient
          if (
            refreshError.message.includes('invalid_grant') ||
            refreshError.message.includes('No flow refresh token')
          ) {
            this.tokens.flow_access_token = null;
            this.tokens.flow_refresh_token = null;
            await this._saveTokensToFile(); // Persist invalidation
          }
          return null;
        }
      } else {
        console.warn('No flow refresh token available. Cannot refresh flow access token.');
        return null;
      }
    }

    return this.tokens.flow_access_token;
  }

  async getValidAccessToken() {
    await this.getTokens(); // Ensure tokens are loaded

    if (!this.tokens || !this.tokens.access_token) {
      console.log('No access token available.');
      return null;
    }

    if (this.isTokenExpired()) {
      console.log('Access token expired or nearing expiration. Attempting refresh.');
      if (this.tokens.refresh_token) {
        try {
          return await this.refreshAccessToken();
        } catch (refreshError) {
          console.error('Failed to refresh access token:', refreshError);
          this.tokens = null; // Invalidate tokens on refresh failure
          await this._saveTokensToFile(); // Persist invalidation
          return null;
        }
      } else {
        console.warn('No refresh token available. Cannot refresh access token.');
        this.tokens = null; // Invalidate tokens as they are expired and cannot be refreshed
        await this._saveTokensToFile(); // Persist invalidation
        return null;
      }
    }
    return this.tokens.access_token;
  }

  async refreshAccessToken() {
    if (!this.tokens || !this.tokens.refresh_token) {
      throw new Error('No refresh token available to refresh the access token.');
    }

    // Prevent multiple concurrent refresh attempts
    if (this._refreshPromise) {
      console.log('Refresh already in progress, returning existing promise.');
      return this._refreshPromise.then((tokens) => tokens.access_token);
    }

    console.log('Attempting to refresh access token...');
    const postData = querystring.stringify({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refresh_token,
      scope: this.config.scopes.join(' '),
    });

    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const refreshOperation = 'Microsoft Graph token refresh';
    const refreshErrorSecrets = [
      this.config.clientSecret,
      this.tokens && this.tokens.refresh_token,
    ];
    this._refreshPromise = new Promise((resolve, reject) => {
      const req = https.request(this.config.tokenEndpoint, requestOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', async () => {
          try {
            const responseBody = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              this.tokens.access_token = responseBody.access_token;
              // Microsoft Graph API refresh tokens may or may not return a new refresh_token
              if (responseBody.refresh_token) {
                this.tokens.refresh_token = responseBody.refresh_token;
              }
              this.tokens.expires_in = responseBody.expires_in;
              this.tokens.expires_at = Date.now() + responseBody.expires_in * 1000;
              try {
                await this._saveTokensToFile();
                console.log('Access token refreshed and saved successfully.');
                resolve(this.tokens);
              } catch (saveError) {
                console.error('Failed to save refreshed tokens:', saveError);
                // The in-memory token is updated, but the refresh is not durable.
                reject(
                  new Error(`Access token refreshed but failed to save: ${saveError.message}`)
                );
              }
            } else {
              const oauthError = createEntraOAuthError(
                responseBody,
                res.statusCode,
                'Token refresh'
              );
              await this._invalidateVaultCacheOnPermanentEntraFailure(oauthError);
              const contextualError = createTokenRequestError(
                refreshOperation,
                this.config.tokenEndpoint,
                oauthError,
                refreshErrorSecrets,
                'MICROSOFT_GRAPH_TOKEN_REFRESH_FAILED'
              );
              console.error('Microsoft token refresh rejected:', contextualError.code);
              reject(contextualError);
            }
          } catch (e) {
            // Catch any error during parsing or saving
            const contextualError = createTokenRequestError(
              refreshOperation,
              this.config.tokenEndpoint,
              e,
              refreshErrorSecrets,
              'MICROSOFT_GRAPH_TOKEN_REFRESH_FAILED'
            );
            console.error(
              'Error processing refresh token response or saving tokens:',
              contextualError.message
            );
            reject(contextualError);
          } finally {
            this._refreshPromise = null; // Clear promise after completion
          }
        });
      });
      req.setTimeout(30000, () => {
        req.destroy(new Error('Request timed out after 30 seconds'));
      });
      req.on('error', (error) => {
        const contextualError = createTokenRequestError(
          refreshOperation,
          this.config.tokenEndpoint,
          error,
          refreshErrorSecrets,
          'MICROSOFT_GRAPH_TOKEN_REFRESH_FAILED'
        );
        console.error('HTTP error during token refresh:', contextualError.message);
        reject(contextualError);
        this._refreshPromise = null; // Clear promise on error
      });
      req.write(postData);
      req.end();
    });

    return this._refreshPromise.then((tokens) => tokens.access_token);
  }

  async refreshFlowAccessToken() {
    if (!this.tokens || !this.tokens.flow_refresh_token) {
      throw new Error('No flow refresh token available to refresh the flow access token.');
    }

    // Prevent multiple concurrent flow refresh attempts
    if (this._flowRefreshPromise) {
      console.log('Flow refresh already in progress, returning existing promise.');
      return this._flowRefreshPromise.then((tokens) => tokens.flow_access_token);
    }

    console.log('Attempting to refresh flow access token...');
    const postData = querystring.stringify({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: this.tokens.flow_refresh_token,
      scope: this.config.flowScope,
    });

    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const refreshOperation = 'Power Automate token refresh';
    const refreshErrorSecrets = [
      this.config.clientSecret,
      this.tokens && this.tokens.flow_refresh_token,
    ];
    this._flowRefreshPromise = new Promise((resolve, reject) => {
      const req = https.request(this.config.tokenEndpoint, requestOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', async () => {
          try {
            const responseBody = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              this.tokens.flow_access_token = responseBody.access_token;
              // Microsoft Flow API refresh tokens may or may not return a new refresh_token
              if (responseBody.refresh_token) {
                this.tokens.flow_refresh_token = responseBody.refresh_token;
              }
              this.tokens.flow_expires_at = Date.now() + responseBody.expires_in * 1000;
              try {
                await this._saveTokensToFile();
                console.log('Flow access token refreshed and saved successfully.');
                resolve(this.tokens);
              } catch (saveError) {
                console.error('Failed to save refreshed flow tokens:', saveError);
                reject(
                  new Error(`Flow access token refreshed but failed to save: ${saveError.message}`)
                );
              }
            } else {
              const oauthError = createEntraOAuthError(
                responseBody,
                res.statusCode,
                'Flow token refresh'
              );
              const isPermanentFailure = isPermanentEntraOAuthFailure(oauthError);
              if (isPermanentFailure) {
                this.tokens.flow_access_token = null;
                this.tokens.flow_refresh_token = null;
                try {
                  await this._saveTokensToFile();
                } catch (saveError) {
                  console.error('Failed to save invalidated flow tokens:', saveError);
                }
              }
              const contextualError = createTokenRequestError(
                refreshOperation,
                this.config.tokenEndpoint,
                oauthError,
                refreshErrorSecrets,
                'POWER_AUTOMATE_TOKEN_REFRESH_FAILED'
              );
              console.error('Microsoft Flow token refresh rejected:', contextualError.code);
              reject(contextualError);
            }
          } catch (e) {
            const contextualError = createTokenRequestError(
              refreshOperation,
              this.config.tokenEndpoint,
              e,
              refreshErrorSecrets,
              'POWER_AUTOMATE_TOKEN_REFRESH_FAILED'
            );
            console.error(
              'Error processing flow refresh token response or saving tokens:',
              contextualError.message
            );
            reject(contextualError);
          } finally {
            this._flowRefreshPromise = null; // Clear promise after completion
          }
        });
      });
      req.setTimeout(30000, () => {
        req.destroy(new Error('Request timed out after 30 seconds'));
      });
      req.on('error', (error) => {
        const contextualError = createTokenRequestError(
          refreshOperation,
          this.config.tokenEndpoint,
          error,
          refreshErrorSecrets,
          'POWER_AUTOMATE_TOKEN_REFRESH_FAILED'
        );
        console.error('HTTP error during flow token refresh:', contextualError.message);
        // Do not invalidate flow tokens on transient network errors
        reject(contextualError);
        this._flowRefreshPromise = null; // Clear promise on error
      });
      req.write(postData);
      req.end();
    });

    return this._flowRefreshPromise.then((tokens) => tokens.flow_access_token);
  }

  async exchangeCodeForTokens(authCode) {
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new Error(
        'Client ID or Client Secret is not configured. Cannot exchange code for tokens.'
      );
    }
    console.log('Exchanging authorization code for tokens...');
    const postData = querystring.stringify({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes.join(' '),
    });

    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const exchangeOperation = 'Microsoft Graph token exchange';
    const exchangeErrorSecrets = [this.config.clientSecret, authCode];
    return new Promise((resolve, reject) => {
      const req = https.request(this.config.tokenEndpoint, requestOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', async () => {
          try {
            const responseBody = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              this.tokens = {
                access_token: responseBody.access_token,
                refresh_token: responseBody.refresh_token,
                expires_in: responseBody.expires_in,
                expires_at: Date.now() + responseBody.expires_in * 1000,
                scope: responseBody.scope,
                token_type: responseBody.token_type,
              };
              try {
                await this._saveTokensToFile();
                console.log('Tokens exchanged and saved successfully.');
                resolve(this.tokens);
              } catch (saveError) {
                console.error('Failed to save exchanged tokens:', saveError);
                // Similar to refresh, tokens are in memory but not persisted.
                // Rejecting to indicate the operation wasn't fully successful.
                reject(new Error(`Tokens exchanged but failed to save: ${saveError.message}`));
              }
            } else {
              const oauthError = createEntraOAuthError(
                responseBody,
                res.statusCode,
                'Token exchange'
              );
              await this._invalidateVaultCacheOnPermanentEntraFailure(oauthError);
              const contextualError = createTokenRequestError(
                exchangeOperation,
                this.config.tokenEndpoint,
                oauthError,
                exchangeErrorSecrets,
                'MICROSOFT_GRAPH_TOKEN_EXCHANGE_FAILED'
              );
              console.error('Microsoft token exchange rejected:', contextualError.code);
              reject(contextualError);
            }
          } catch (e) {
            const contextualError = createTokenRequestError(
              exchangeOperation,
              this.config.tokenEndpoint,
              e,
              exchangeErrorSecrets,
              'MICROSOFT_GRAPH_TOKEN_EXCHANGE_FAILED'
            );
            // Catch any error during parsing or saving
            console.error(
              'Error processing token exchange response or saving tokens:',
              contextualError.message
            );
            reject(contextualError);
          }
        });
      });
      req.setTimeout(30000, () => {
        req.destroy(new Error('Request timed out after 30 seconds'));
      });
      req.on('error', (error) => {
        const contextualError = createTokenRequestError(
          exchangeOperation,
          this.config.tokenEndpoint,
          error,
          exchangeErrorSecrets,
          'MICROSOFT_GRAPH_TOKEN_EXCHANGE_FAILED'
        );
        console.error('HTTP error during code exchange:', contextualError.message);
        reject(contextualError);
      });
      req.write(postData);
      req.end();
    });
  }

  // Graph and Flow credentials share one cache, so clearing it removes both token families.
  async clearTokens() {
    this.tokens = null;
    try {
      await fs.unlink(this.config.tokenStorePath);
      console.log('Token file deleted successfully.');
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('Token file not found, nothing to delete.');
      } else {
        console.error('Error deleting token file:', error);
      }
    }
  }
}

module.exports = TokenStorage;
