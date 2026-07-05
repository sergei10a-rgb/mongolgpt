// @ts-nocheck
// Vendored GitLab auth plugin source (MIT). MongolGPT local adapter.
import { Global } from '@mongolgpt/core/global';
import fs from 'fs';
import path from 'path';
/**
 * GitLab OAuth constants
 */
// IMPORTANT: The bundled client ID below is from gitlab-vscode-extension and is registered
// with redirect URI: vscode://gitlab.gitlab-workflow/authentication
// This will NOT work with MongolGPT's local HTTP callback server.
// To fix: Set GITLAB_OAUTH_CLIENT_ID environment variable with your own client ID.
// See OAUTH_SETUP.md for instructions on registering a new OAuth application.
const BUNDLED_CLIENT_ID = process.env.GITLAB_OAUTH_CLIENT_ID ||
    '1d89f9fdb23ee96d4e603201f6861dab6e143c5c3c00469a018a2d94bdc03d4e';
const GITLAB_COM_URL = 'https://gitlab.com';
const OAUTH_SCOPES = ['api'];
function resolveInstanceUrl() {
    return process.env.GITLAB_INSTANCE_URL || GITLAB_COM_URL;
}
/**
 * Normalize an instance URL to `protocol//host`, falling back to the default
 * (GITLAB_INSTANCE_URL env or gitlab.com) when the value is empty/undefined.
 * Throws if a non-empty value is not a valid URL.
 */
export function normalizeOptionalInstanceUrl(value) {
    const raw = value && value.trim() ? value.trim() : resolveInstanceUrl();
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
}
/**
 * Validate an instance URL entered in an auth prompt. An empty value is allowed
 * (it defaults to gitlab.com / GITLAB_INSTANCE_URL); a non-empty value must be a
 * valid http(s) URL.
 */
export function validateInstanceUrl(value) {
    if (!value || !value.trim()) {
        return undefined;
    }
    try {
        const url = new URL(value.trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return 'Instance URL нь http эсвэл https ашиглах ёстой';
        }
        return undefined;
    }
    catch {
        return 'Зөв URL оруулна уу, жишээ нь https://gitlab.com';
    }
}
/**
 * Debug logging to file (doesn't break UI)
 */
function debugLog(message, data) {
    try {
        const logDir = Global.Path.log;
        // Ensure log directory exists
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        const logPath = path.join(logDir, 'gitlab-auth.log');
        const timestamp = new Date().toISOString();
        const logLine = data
            ? `[${timestamp}] ${message}: ${JSON.stringify(data)}\n`
            : `[${timestamp}] ${message}\n`;
        fs.appendFileSync(logPath, logLine);
    }
    catch {
        // Ignore logging errors
    }
}
/**
 * Get MongolGPT auth file path
 */
function getAuthPath() {
    return path.join(Global.Path.data, 'auth.json');
}
/**
 * Save OAuth auth data to MongolGPT's auth.json
 * Workaround for MongolGPT not saving the enterpriseUrl field
 */
async function saveOAuthData(access, refresh, expires, enterpriseUrl) {
    const authPath = getAuthPath();
    const authDir = path.dirname(authPath);
    // Ensure directory exists
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }
    // Read existing auth data
    let authData = {};
    if (fs.existsSync(authPath)) {
        const content = fs.readFileSync(authPath, 'utf-8');
        authData = JSON.parse(content);
    }
    // Update GitLab auth
    authData.gitlab = {
        type: 'oauth',
        access,
        refresh,
        expires,
        enterpriseUrl,
    };
    // Write back
    fs.writeFileSync(authPath, JSON.stringify(authData, null, 2));
    fs.chmodSync(authPath, 0o600);
}
/**
 * Save PAT auth data to MongolGPT's auth.json
 * Workaround for MongolGPT not saving the enterpriseUrl field for API keys
 */
async function savePATData(key, enterpriseUrl) {
    const authPath = getAuthPath();
    const authDir = path.dirname(authPath);
    // Ensure directory exists
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }
    // Read existing auth data
    let authData = {};
    if (fs.existsSync(authPath)) {
        const content = fs.readFileSync(authPath, 'utf-8');
        authData = JSON.parse(content);
    }
    // Update GitLab auth with PAT and enterpriseUrl
    authData.gitlab = {
        type: 'api',
        key,
        enterpriseUrl,
    };
    // Write back
    fs.writeFileSync(authPath, JSON.stringify(authData, null, 2));
    fs.chmodSync(authPath, 0o600);
}
/**
 * Persist a resolved instance URL into the stored PAT's metadata.
 *
 * The TUI collects the instance URL as a prompt and stores it under
 * `gitlab.metadata.instanceUrl` directly (bypassing this plugin's authorize),
 * so when the user accepts the default by submitting an empty field it is saved
 * as an empty string. This backfills the resolved default (e.g. gitlab.com) so
 * the stored value matches what is actually used.
 */
function persistPatInstanceUrl(instanceUrl) {
    try {
        const authPath = getAuthPath();
        if (!fs.existsSync(authPath)) {
            return;
        }
        const authData = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
        const gitlab = authData.gitlab;
        if (!gitlab || gitlab.type !== 'api') {
            return;
        }
        const metadata = { ...(gitlab.metadata ?? {}), instanceUrl };
        authData.gitlab = { ...gitlab, metadata };
        fs.writeFileSync(authPath, JSON.stringify(authData, null, 2));
        fs.chmodSync(authPath, 0o600);
    }
    catch {
        // Best-effort; the loader still returns the resolved instanceUrl regardless.
    }
}
/**
 * Mutex to prevent concurrent token refresh attempts
 */
let refreshInProgress = null;
/**
 * Refresh OAuth token if expired or expiring soon
 */
async function refreshTokenIfNeeded(authData, auth, fallbackUrl) {
    const now = Date.now();
    const expiryBuffer = 5 * 60 * 1000; // 5 minutes buffer
    const isExpired = authData.expires <= now + expiryBuffer;
    if (!isExpired) {
        debugLog('Token is still valid', {
            expiresAt: new Date(authData.expires).toISOString(),
            expiresIn: Math.round((authData.expires - now) / 1000 / 60) + ' minutes',
        });
        return {
            apiKey: authData.access,
            instanceUrl: authData.enterpriseUrl || fallbackUrl,
        };
    }
    // If refresh is already in progress, wait for it
    if (refreshInProgress) {
        debugLog('Token refresh already in progress, waiting...');
        await refreshInProgress;
        // Re-fetch auth data after refresh completes
        const refreshedAuthData = await auth();
        if (refreshedAuthData && refreshedAuthData.type === 'oauth') {
            return {
                apiKey: refreshedAuthData.access,
                instanceUrl: refreshedAuthData.enterpriseUrl || fallbackUrl,
            };
        }
        throw new Error('Failed to get refreshed auth data');
    }
    // Start refresh process
    debugLog('Token expired or expiring soon, refreshing...', {
        expiresAt: new Date(authData.expires).toISOString(),
        expired: authData.expires <= now,
    });
    refreshInProgress = (async () => {
        try {
            const instanceUrl = authData.enterpriseUrl || fallbackUrl;
            const { GitLabOAuthFlow } = await import('./oauth-flow');
            const flow = new GitLabOAuthFlow({
                instanceUrl,
                clientId: BUNDLED_CLIENT_ID,
                scopes: OAUTH_SCOPES,
                method: 'auto',
            });
            debugLog('Calling exchangeRefreshToken...');
            const newTokens = await flow.exchangeRefreshToken(authData.refresh);
            const newExpiry = Date.now() + newTokens.expires_in * 1000;
            debugLog('Token refresh successful', {
                newExpiresAt: new Date(newExpiry).toISOString(),
                expiresIn: Math.round(newTokens.expires_in / 60) + ' minutes',
            });
            // Save the new tokens
            await saveOAuthData(newTokens.access_token, newTokens.refresh_token, newExpiry, instanceUrl);
            debugLog('New tokens saved successfully');
        }
        catch (error) {
            debugLog('Token refresh failed', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
            // If refresh fails with 401/403, the refresh token is likely revoked
            if (error instanceof Error && error.message.includes('401')) {
                debugLog('Refresh token appears to be revoked (401), clearing auth data');
                // Clear the auth data to force re-authentication
                const authPath = getAuthPath();
                if (fs.existsSync(authPath)) {
                    const content = fs.readFileSync(authPath, 'utf-8');
                    const authDataFile = JSON.parse(content);
                    delete authDataFile.gitlab;
                    fs.writeFileSync(authPath, JSON.stringify(authDataFile, null, 2));
                }
            }
            throw error;
        }
    })();
    try {
        await refreshInProgress;
    }
    finally {
        refreshInProgress = null;
    }
    // Re-fetch auth data after refresh
    const refreshedAuthData = await auth();
    if (refreshedAuthData && refreshedAuthData.type === 'oauth') {
        return {
            apiKey: refreshedAuthData.access,
            instanceUrl: refreshedAuthData.enterpriseUrl || fallbackUrl,
        };
    }
    throw new Error('Failed to get refreshed auth data after token refresh');
}
/**
 * MongolGPT GitLab Auth Plugin
 */
export const gitlabAuthPlugin = async (_input) => {
    const authHook = {
        provider: 'gitlab',
        /**
         * Loader function to provide auth credentials to the GitLab AI SDK provider
         * Automatically refreshes OAuth tokens if expired or expiring soon
         */
        async loader(auth) {
            const authData = await auth();
            if (!authData) {
                return {};
            }
            // For OAuth, check token expiry and refresh if needed
            if (authData.type === 'oauth') {
                try {
                    const result = await refreshTokenIfNeeded(authData, auth, resolveInstanceUrl());
                    // Include clientId so the provider can use it for any subsequent token refresh
                    return {
                        ...result,
                        clientId: BUNDLED_CLIENT_ID,
                    };
                }
                catch (error) {
                    debugLog('Failed to refresh token in loader', {
                        error: error instanceof Error ? error.message : String(error),
                    });
                    // Fall back to returning the existing (possibly expired) token
                    // The API call will fail, but at least we tried
                    return {
                        apiKey: authData.access,
                        instanceUrl: authData.enterpriseUrl || resolveInstanceUrl(),
                        clientId: BUNDLED_CLIENT_ID,
                    };
                }
            }
            // For API key, return the key and instance URL.
            if (authData.type === 'api') {
                // Instance URL precedence:
                // 1. metadata.instanceUrl - written by MongolGPT when the PAT auth flow
                //    collects the instance URL prompt (MongolGPT's `api` auth schema only
                //    persists `key` + `metadata`, not a top-level enterpriseUrl).
                // 2. enterpriseUrl - written by this plugin's savePATData workaround.
                // 3. env var / gitlab.com default.
                const metadata = authData.metadata;
                const storedInstanceUrl = metadata?.instanceUrl || authData.enterpriseUrl;
                const instanceUrl = normalizeOptionalInstanceUrl(storedInstanceUrl);
                // If the stored instance URL was empty/missing (user accepted the default
                // by submitting an empty prompt), backfill the resolved value so auth.json
                // reflects what is actually used.
                if (!storedInstanceUrl || metadata?.instanceUrl !== instanceUrl) {
                    persistPatInstanceUrl(instanceUrl);
                }
                return {
                    apiKey: authData.key,
                    instanceUrl,
                };
            }
            return {};
        },
        methods: [
            {
                type: 'oauth',
                label: 'GitLab OAuth',
                prompts: [
                    {
                        type: 'text',
                        key: 'instanceUrl',
                        message: 'GitLab instance URL',
                        placeholder: resolveInstanceUrl(),
                        validate: (value) => validateInstanceUrl(value),
                    },
                ],
                async authorize(inputs) {
                    const instanceUrl = normalizeOptionalInstanceUrl(inputs?.instanceUrl);
                    // Normalize instance URL
                    let normalizedUrl;
                    try {
                        const url = new URL(instanceUrl);
                        normalizedUrl = `${url.protocol}//${url.host}`;
                    }
                    catch {
                        throw new Error(`GitLab instance URL буруу байна: ${instanceUrl}`);
                    }
                    // Generate PKCE parameters
                    const { generateSecret, generateCodeChallengeFromVerifier } = await import('./pkce');
                    const codeVerifier = generateSecret(43);
                    const codeChallenge = generateCodeChallengeFromVerifier(codeVerifier);
                    const state = generateSecret(32);
                    // Create callback server for automatic OAuth flow
                    const { CallbackServer } = await import('./callback-server');
                    const callbackServer = new CallbackServer({
                        port: 8080, // Fixed port matching OAuth app registration
                        host: '127.0.0.1',
                        timeout: 120000, // 2 minutes
                    });
                    // Start server and get callback URL
                    await callbackServer.start();
                    const redirectUri = callbackServer.getCallbackUrl();
                    const callbackPromise = callbackServer.waitForCallback();
                    // Build authorization URL
                    const params = new URLSearchParams({
                        client_id: BUNDLED_CLIENT_ID,
                        redirect_uri: redirectUri,
                        response_type: 'code',
                        state,
                        scope: OAUTH_SCOPES.join(' '),
                        code_challenge: codeChallenge,
                        code_challenge_method: 'S256',
                    });
                    const authUrl = `${normalizedUrl}/oauth/authorize?${params.toString()}`;
                    // Open browser automatically
                    const { exec } = await import('child_process');
                    const platform = process.platform;
                    const openCommand = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
                    exec(`${openCommand} "${authUrl}"`);
                    return {
                        method: 'auto',
                        url: authUrl,
                        instructions: 'Нэвтрэхийн тулд хөтөч автоматаар нээгдэнэ. Буцах холболтыг автоматаар боловсруулна.',
                        async callback() {
                            debugLog('callback() called');
                            try {
                                // Wait for the OAuth callback from our local server
                                debugLog('Waiting for callback...');
                                const result = await callbackPromise;
                                debugLog('Received callback', { hasCode: !!result.code, hasState: !!result.state });
                                // Verify state matches
                                if (result.state !== state) {
                                    debugLog('State mismatch', { expected: state, received: result.state });
                                    await callbackServer.close();
                                    return { type: 'failed' };
                                }
                                debugLog('State verified');
                                // Exchange code for tokens
                                debugLog('Exchanging code for tokens...');
                                const { GitLabOAuthFlow } = await import('./oauth-flow');
                                const flow = new GitLabOAuthFlow({
                                    instanceUrl: normalizedUrl,
                                    clientId: BUNDLED_CLIENT_ID,
                                    scopes: OAUTH_SCOPES,
                                    method: 'auto',
                                });
                                const tokens = await flow.exchangeAuthorizationCode(result.code, codeVerifier, redirectUri);
                                debugLog('Token exchange successful');
                                // Close the callback server
                                await callbackServer.close();
                                // Calculate expiry
                                const expiresAt = Date.now() + tokens.expires_in * 1000;
                                debugLog('Tokens received', { expiresAt: new Date(expiresAt).toISOString() });
                                // Save auth data (workaround for MongolGPT not saving enterpriseUrl)
                                debugLog('Saving auth data...');
                                await saveOAuthData(tokens.access_token, tokens.refresh_token, expiresAt, normalizedUrl);
                                debugLog('Auth data saved successfully');
                                return {
                                    type: 'success',
                                    provider: normalizedUrl,
                                    access: tokens.access_token,
                                    refresh: tokens.refresh_token,
                                    expires: expiresAt,
                                    // Persist the instance URL so the provider can target the
                                    // correct GitLab instance. MongolGPT's OAuth schema includes
                                    // enterpriseUrl, so this is written to auth.json.
                                    enterpriseUrl: normalizedUrl,
                                };
                            }
                            catch (error) {
                                debugLog('Error in callback', {
                                    error: error instanceof Error ? error.message : String(error),
                                    stack: error instanceof Error ? error.stack : undefined,
                                });
                                // Close the callback server
                                try {
                                    await callbackServer.close();
                                }
                                catch (closeError) {
                                    // Ignore close errors
                                }
                                return { type: 'failed' };
                            }
                        },
                    };
                },
            },
            {
                type: 'api',
                label: 'GitLab Personal Access Token',
                prompts: [
                    {
                        type: 'text',
                        key: 'instanceUrl',
                        message: 'GitLab instance URL',
                        placeholder: resolveInstanceUrl(),
                        validate: (value) => validateInstanceUrl(value),
                    },
                ],
                async authorize(inputs) {
                    const instanceUrl = normalizeOptionalInstanceUrl(inputs?.instanceUrl);
                    const token = inputs?.token;
                    if (!token) {
                        return { type: 'failed' };
                    }
                    // Normalize instance URL
                    let normalizedUrl;
                    try {
                        const url = new URL(instanceUrl);
                        normalizedUrl = `${url.protocol}//${url.host}`;
                    }
                    catch {
                        return { type: 'failed' };
                    }
                    // Validate token by making a test request
                    try {
                        const response = await fetch(`${normalizedUrl}/api/v4/user`, {
                            headers: {
                                Authorization: `Bearer ${token}`,
                            },
                        });
                        if (!response.ok) {
                            return { type: 'failed' };
                        }
                        // Save PAT auth data with enterpriseUrl (workaround for MongolGPT not saving it)
                        debugLog('Saving PAT auth data...');
                        await savePATData(token, normalizedUrl);
                        debugLog('PAT auth data saved successfully');
                        return {
                            type: 'success',
                            key: token,
                            provider: normalizedUrl,
                            // Persist the instance URL in metadata (MongolGPT's `api` auth
                            // schema stores only key + metadata, not a top-level field).
                            metadata: { instanceUrl: normalizedUrl },
                        };
                    }
                    catch {
                        return { type: 'failed' };
                    }
                },
            },
        ],
    };
    return {
        auth: authHook,
    };
};
export default gitlabAuthPlugin;
//# sourceMappingURL=index.js.map
