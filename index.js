// index.js - Render.com Proxy Server with File-Based Token Storage (No Scope in Refresh)

const express = require('express');
const axios = require('axios'); // Used for making HTTP requests
const cors = require('cors');
const qs = require('qs'); // Used for URL-encoded body for token requests
const fs = require('fs').promises; // Node.js File System promises API

const app = express();
const PORT = process.env.PORT || 10000; // Use Render's assigned port or default to 10000
const TOKEN_FILE_PATH = './tokens.json'; // Path to the file where tokens will be stored

// --- Environment Variables (REQUIRED on Render.com) ---
// These should be set in your Render.com service settings for security.
// If not set, the hardcoded defaults will be used (less secure for production).
const SFD_BASE_URL = process.env.SFD_BASE_URL || 'https://sfd.co:6500';
const SFD_CLIENT_ID = process.env.SFD_CLIENT_ID || 'betterproducts';
const SFD_CLIENT_SECRET = process.env.SFD_CLIENT_SECRET || '574f1383-8d69-49b4-a6a5-e969cbc9a99a';
// This initial refresh token is CRUCIAL for the first startup or after a restart
// where tokens.json might be lost. Ensure it's a valid, long-lived refresh token.
const INITIAL_REFRESH_TOKEN = process.env.INITIAL_REFRESH_TOKEN || '119d088b118c4873a13c996748a3c611d269591f307c4147a4f988002faf4436'; // *** IMPORTANT: Replace with a real, fresh refresh token ***

// --- In-Memory Cache for Tokens (updated from file, written to file) ---
// This cache helps avoid constant file I/O for every request.
let tokenCache = {
    accessToken: null,
    refreshToken: null,
    expiresAt: null, // Unix timestamp in milliseconds
};

// --- File Storage Helper Functions ---

/**
 * Reads token data from the tokens.json file.
 * @returns {Promise<object|null>} The token data or null if file not found/error.
 */
async function readTokenFile() {
    try {
        const data = await fs.readFile(TOKEN_FILE_PATH, 'utf8');
        console.log('[FILE_STORAGE] Tokens read from file.');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('[FILE_STORAGE] tokens.json not found. Will create on first successful token acquisition.');
        } else {
            console.error('[FILE_STORAGE] Error reading tokens.json:', error.message);
        }
        return null;
    }
}

/**
 * Writes token data to the tokens.json file.
 * @param {object} tokens The token data to write.
 * @returns {Promise<void>}
 */
async function writeTokenFile(tokens) {
    try {
        await fs.writeFile(TOKEN_FILE_PATH, JSON.stringify(tokens, null, 2), 'utf8');
        console.log('[FILE_STORAGE] Tokens written to file successfully.');
    } catch (error) {
        console.error('[FILE_STORAGE] Error writing tokens.json:', error.message);
    }
}

// --- Token Acquisition/Refresh Logic ---

/**
 * Attempts to acquire or refresh an access token using the refresh_token grant.
 * Prioritizes:
 * 1. Valid token in memory cache.
 * 2. Refresh token from memory cache.
 * 3. Refresh token from file.
 * 4. Fallback to INITIAL_REFRESH_TOKEN from environment variable.
 * Updates the in-memory cache and persists to file on success.
 * @param {boolean} forceRefresh If true, forces a refresh token grant even if current token is valid.
 * @returns {Promise<string|null>} The valid access token or null if acquisition fails.
 */
async function getValidatedAccessToken(forceRefresh = false) {
    console.log('[AUTH] Attempting to get/validate access token...');

    // 1. Check if current access token in cache is valid and not near expiry
    if (tokenCache.accessToken && tokenCache.expiresAt && Date.now() < tokenCache.expiresAt - (5 * 60 * 1000) && !forceRefresh) {
        console.log('[AUTH] Using valid access token from cache.');
        return tokenCache.accessToken;
    }

    // 2. Determine which refresh token to use
    let refreshTokenToUse = tokenCache.refreshToken;

    // If no refresh token in cache, try reading from file
    if (!refreshTokenToUse) {
        const fileTokens = await readTokenFile();
        if (fileTokens && fileTokens.refreshToken) {
            refreshTokenToUse = fileTokens.refreshToken;
            tokenCache.refreshToken = refreshTokenToUse; // Update cache
            console.log('[AUTH] Loaded refresh token from file.');
        }
    }

    // Fallback to initial refresh token from environment variable if still no refresh token
    if (!refreshTokenToUse && INITIAL_REFRESH_TOKEN && INITIAL_REFRESH_TOKEN !== 'YOUR_FRESH_REFRESH_TOKEN_HERE') {
        refreshTokenToUse = INITIAL_REFRESH_TOKEN;
        tokenCache.refreshToken = refreshTokenToUse; // Update cache
        console.log('[AUTH] Using INITIAL_REFRESH_TOKEN from environment variable.');
    }

    if (!refreshTokenToUse) {
        console.error('[AUTH] No refresh token available. Cannot acquire access token. Manual intervention required.');
        return null; // Cannot proceed without a refresh token
    }

    // 3. Attempt OAuth2 refresh_token grant
    console.log('[AUTH] Attempting OAuth2 refresh_token grant...');
    try {
        const requestData = {
            grant_type: 'refresh_token',
            client_id: SFD_CLIENT_ID,
            client_secret: SFD_CLIENT_SECRET,
            refresh_token: refreshTokenToUse,
            // REMOVED: scope: 'API' - The API seems to reject this during refresh if it doesn't match previous or expects no scope.
        };

        const tokenResponse = await axios.post(
            `${SFD_BASE_URL}/oauth2/token`,
            qs.stringify(requestData),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                timeout: 15000 // 15 seconds timeout
            }
        );

        const tokenData = tokenResponse.data;

        if (tokenResponse.status === 200 && tokenData.access_token) {
             // Check if OAuth2 returned an error object despite 200 OK
            if (tokenData.error) {
                console.error('[AUTH] OAuth2 refresh failed (API error in 200 response):', tokenData.error_description || tokenData.error);
                throw new Error(tokenData.error_description || tokenData.error || 'OAuth2 refresh failed with API error.');
            }

            console.log('[AUTH] OAuth2 token refresh successful. Validating new token...');
            
            // Test the new token against /Practice endpoint
            const testResponse = await axios.get(`${SFD_BASE_URL}/Practice`, {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
                timeout: 10000 // 10 seconds timeout for validation
            });

            if (testResponse.status === 200) {
                console.log('[AUTH] New access token successfully validated.');
                tokenCache.accessToken = tokenData.access_token;
                tokenCache.expiresAt = Date.now() + (tokenData.expires_in * 1000) - (5 * 60 * 1000); // 5 min buffer
                if (tokenData.refresh_token) {
                    tokenCache.refreshToken = tokenData.refresh_token; // Update refresh token if provided
                }
                await writeTokenFile(tokenCache); // Persist to file
                return tokenCache.accessToken;
            } else {
                console.error(`[AUTH] New access token validation failed: ${testResponse.status} ${testResponse.statusText}`);
                throw new Error('New access token lacks account association or is invalid after refresh.');
            }
        } else {
            console.error(`[AUTH] OAuth2 refresh failed: ${tokenResponse.status} ${tokenResponse.statusText}`);
            console.error('[AUTH] Token response data:', tokenData);
            throw new Error(tokenData.error_description || tokenData.error || 'OAuth2 refresh failed.');
        }
    } catch (error) {
        console.error('[AUTH] Error during refresh_token grant:', error.message);
        // If refresh token fails, clear it to force new attempt and report
        tokenCache.accessToken = null;
        tokenCache.refreshToken = null; // Clear refresh token if it failed
        tokenCache.expiresAt = null;
        await writeTokenFile(tokenCache); // Persist cleared refresh token
        return null;
    }
}

// --- Helper function to handle SFD responses and format for Vapi ---
// This centralizes the logic for converting SFD API responses (success or error)
// into the specific JSON format Vapi expects for tool results.
function handleSfdResponse(sfdResponse, res, toolCallId) {
    // Check for SFD API errors (status >= 400 or a custom error object in data)
    if (sfdResponse.status >= 400 || (sfdResponse.data && sfdResponse.data.error)) {
        console.error('--- [SFD API] Error Response ---');
        console.error('Status:', sfdResponse.status);
        console.error('Data:', sfdResponse.data);

        let errorMessage = `SFD API Error: Status ${sfdResponse.status}.`;
        if (sfdResponse.data && typeof sfdResponse.data === 'object' && sfdResponse.data.error && sfdResponse.data.error.description) {
            errorMessage += ` Description: ${sfdResponse.data.error.description}`;
        } else if (sfdResponse.data) {
            errorMessage += ` Raw response: ${JSON.stringify(sfdResponse.data)}`;
        } else if (sfdResponse.statusText) {
            errorMessage += ` Status Text: ${sfdResponse.statusText}`;
        }

        // Vapi expects a 200 OK even for tool errors, with the error details in the 'results' array
        const vapiErrorResponse = {
            results: [{
                toolCallId: toolCallId,
                // Truncate error message to fit Vapi's likely limits and prevent excessively long logs
                error: errorMessage.replace(/[\r\n]+/g, ' ').substring(0, 500)
            }]
        };
        return res.status(200).json(vapiErrorResponse);
    }

    // If SFD API returned success (status < 400), format it as Vapi result
    console.log('--- [SFD API] Success Response ---');
    console.log('Status:', sfdResponse.status);
    console.log('Data:', sfdResponse.data);

    // Stringify the SFD response data to put it into Vapi's 'result' field
    const resultString = JSON.stringify(sfdResponse.data);

    const vapiSuccessResponse = {
        results: [{
            toolCallId: toolCallId,
            // Truncate result string to fit Vapi's likely limits
            result: resultString.replace(/[\r\n]+/g, ' ').substring(0, 500)
        }]
    };
    return res.status(200).json(vapiSuccessResponse);
}

// --- Middleware for all /api/* routes ---
// This middleware runs before the main proxy logic. Its primary role is to:
// 1. Ensure a valid access token is available (acquires/refreshes if needed).
// 2. Add the Authorization header to the request going to the SFD API.
app.use('/api/*', async (req, res, next) => {
    try {
        const accessToken = await getValidatedAccessToken(); // Get or refresh token
        if (!accessToken) {
            console.error('[PROXY_MIDDLEWARE] Failed to obtain valid access token. Aborting request.');
            const toolCallId = req.body.toolCallId || 'default_tool_call_id';
            return res.status(200).json({
                results: [{
                    toolCallId: toolCallId,
                    error: 'Proxy Error: Failed to obtain valid authentication token for SFD API. Check proxy logs. Manual refresh token update may be needed.'
                }]
            });
        }
        // Add the Authorization header to the request that will be forwarded to the SFD API
        req.headers.authorization = `Bearer ${accessToken}`;
        next(); // Proceed to the main proxy route handler
    } catch (error) {
        console.error('[PROXY_MIDDLEWARE] Error during token acquisition in middleware:', error.message);
        const toolCallId = req.body.toolCallId || 'default_tool_call_id';
        return res.status(200).json({
            results: [{
                toolCallId: toolCallId,
                error: `Proxy Error during token setup: ${error.message}. Check proxy logs.`
            }]
        });
    }
});

// --- Main Proxy Route Handler ---
// This route handles all incoming requests to '/api/*' and forwards them to the SFD API.
app.all('/api/*', async (req, res) => {
    // Extract the target path from the incoming request URL (e.g., '/appointment/books' from '/api/appointment/books')
    const targetPath = req.path.substring(5); // Removes '/api/'

    // Extract relevant query parameters from the original URL.
    // Vapi sometimes adds its own 'url' parameter which should be filtered out.
    const queryParams = new URLSearchParams(req.originalUrl.split('?')[1]);
    let sfdApiQueryParams = new URLSearchParams();
    for (const [key, value] of queryParams.entries()) {
        if (key !== 'url') { // Exclude Vapi's 'url' parameter
            sfdApiQueryParams.append(key, value);
        }
    }

    const method = req.method;
    // Copy incoming headers, then clean up headers that might cause issues with the target server
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['if-none-match']; // Prevents caching issues
    delete headers['accept-encoding']; // Prevents compression issues
    // For GET/HEAD requests, content-length and content-type headers are not applicable
    if (method === 'GET' || method === 'HEAD') {
        delete headers['content-length'];
        delete headers['content-type'];
    }

    // Construct the full target URL for the SFD API
    let fullTargetUrl = `${SFD_BASE_URL}/${targetPath}`;
    if (sfdApiQueryParams.toString()) {
        fullTargetUrl += `?${sfdApiQueryParams.toString()}`;
    }

    // --- Debugging Logs for Proxy Request ---
    console.log(`--- [PROXY] Outgoing Request Details ---`);
    console.log(`Method: ${method}`);
    console.log(`Original Path: ${req.path}`);
    console.log(`Target URL: ${fullTargetUrl}`);
    console.log(`Headers (to SFD):`, headers);
    console.log(`Body (to SFD):`, req.body); // Body will be empty for GET requests
    console.log(`--- End [PROXY] Outgoing Request Details ---`);

    try {
        const axiosConfig = {
            method: method,
            url: fullTargetUrl,
            headers: headers,
            // Do not throw errors for 4xx responses; handle them explicitly in code
            validateStatus: function (status) {
                return status >= 200 && status < 500; // Handle 2xx, 3xx, and 4xx status codes
            },
            timeout: 20000 // 20 seconds timeout for API calls
        };

        // Attach request body for non-GET/HEAD methods
        if (method !== 'GET' && method !== 'HEAD') {
            axiosConfig.data = req.body;
        }

        const sfdResponse = await axios(axiosConfig);

        // Extract toolCallId from Vapi's request body for consistent error/success reporting
        // Vapi sends toolCallId in the body for POST, but not always for GET.
        // We'll use a default if not found.
        const toolCallId = req.body.toolCallId || 'default_tool_call_id';

        // --- Handle 401 Unauthorized: Attempt token refresh and retry ---
        // If the SFD API returns 401, it means our token is invalid/expired.
        // We attempt a refresh and then retry the original request.
        if (sfdResponse.status === 401) {
            console.warn('[PROXY] SFD API returned 401 Unauthorized. Attempting token refresh and retry...');
            const refreshSuccess = await getValidatedAccessToken(true); // Force refresh
            if (refreshSuccess) {
                // If refresh was successful, update the Authorization header with the new token
                // and retry the original request.
                axiosConfig.headers.authorization = `Bearer ${tokenCache.accessToken}`;
                console.log('[PROXY] Token refreshed, retrying original request with new token...');
                const retrySfdResponse = await axios(axiosConfig); // Retry with updated token
                return handleSfdResponse(retrySfdResponse, res, toolCallId); // Process retry response
            } else {
                // If refresh failed, report the 401 error to Vapi
                console.error('[PROXY] Token refresh failed after 401. Cannot retry request.');
                const errorMessage = `SFD API Error: Status 401. Token refresh failed. Manual intervention may be required.`;
                return res.status(200).json({
                    results: [{
                        toolCallId: toolCallId,
                        error: errorMessage.replace(/[\r\n]+/g, ' ').substring(0, 500)
                    }]
                });
            }
        }

        // For all other responses (2xx, 3xx, or other 4xx/5xx not handled by 401),
        // process and format them for Vapi.
        return handleSfdResponse(sfdResponse, res, toolCallId);

    } catch (error) {
        // Catch any network errors or errors from axios itself (e.g., DNS lookup failed, connection refused, timeout)
        console.error(`--- [PROXY] Internal Error Catch Block ---`);
        console.error(`Full Axios Error:`, error.message);
        if (error.response) {
            console.error(`Error Response Status:`, error.response.status);
            console.error(`Error Response Data:`, error.response.data);
            console.error(`Error Response Headers:`, error.response.headers);
        } else if (error.request) {
            console.error(`Error Request (no response):`, error.request);
        } else {
            console.error(`General Error message:`, error.message);
        }
        console.error(`Error Stack:`, error.stack);
        console.error(`--- End [PROXY] Internal Error Catch Block ---`);

        // Format proxy internal errors for Vapi
        const toolCallId = req.body.toolCallId || 'default_tool_call_id';
        const vapiErrorResponse = {
            results: [{
                toolCallId: toolCallId,
                error: `Proxy internal error: ${error.message}. Check proxy logs for more details.`.replace(/[\r\n]+/g, ' ').substring(0, 500)
            }]
        };
        return res.status(200).json(vapiErrorResponse); // Always return 200 for Vapi webhooks
    }
});

// --- Simple Test Endpoint for Proxy Status ---
// You can visit this URL directly in your browser to check if the proxy server is running.
app.get('/', (req, res) => {
    res.send('CORS Proxy is running and token management is active.');
});

// --- Server Start and Initial Token Acquisition ---
// When the server starts, it immediately tries to get an initial access token.
// This ensures the proxy is ready to serve requests with a valid token from the beginning.
app.listen(PORT, async () => {
    console.log(`Proxy server listening on port ${PORT}`);
    console.log('[INIT] Attempting initial token acquisition...');
    // Attempt to load from file first
    const fileTokens = await readTokenFile();
    if (fileTokens) {
        tokenCache = fileTokens;
        console.log('[INIT] Tokens loaded from file into cache.');
    } else {
        console.log('[INIT] No tokens in file or file not found. Will rely on INITIAL_REFRESH_TOKEN env var.');
    }

    // Try to get a valid token (either from cache/file or via INITIAL_REFRESH_TOKEN env var)
    const initialAccessToken = await getValidatedAccessToken();
    if (!initialAccessToken) {
        console.error('[INIT] Initial token acquisition failed. Proxy might not function correctly until a valid token is obtained. Please ensure INITIAL_REFRESH_TOKEN env var is valid.');
    }
});
