// index.js - Render.com Proxy Server with Robust Token Refresh using INITIAL_REFRESH_TOKEN

const express = require('express');
const axios = require('axios'); // Used for making HTTP requests
const cors = require('cors');
const qs = require('qs'); // Used for URL-encoded body for token requests

const app = express();
const PORT = process.env.PORT || 10000; // Use Render's assigned port or default to 10000

// Enable CORS for all origins (adjust for production if needed)
app.use(cors());
// Parse JSON request bodies
app.use(express.json());
// Parse URL-encoded request bodies (for forms, if any, though not directly used for Vapi webhooks)
app.use(express.urlencoded({ extended: false }));

// --- Environment Variables (REQUIRED on Render.com) ---
// These should be set in your Render.com service settings for security.
// If not set, the hardcoded defaults will be used (less secure for production).
const SFD_BASE_URL = process.env.SFD_BASE_URL || 'https://sfd.co:6500';
const SFD_CLIENT_ID = process.env.SFD_CLIENT_ID || 'betterproducts';
const SFD_CLIENT_SECRET = process.env.SFD_CLIENT_SECRET || '574f1383-8d69-49b4-a6a5-e969cbc9a99a';
// This initial refresh token is CRUCIAL for the first startup or after a restart
// where in-memory tokens are lost. Ensure it's a valid, long-lived refresh token.
const INITIAL_REFRESH_TOKEN = process.env.INITIAL_REFRESH_TOKEN || 'a5a5535240cb4a67a316bf43b00db20408370be935504820a69a6ecd885c320a'; // *** IMPORTANT: Replace with a real, fresh refresh token ***

// --- In-Memory Cache for Tokens ---
// This cache helps avoid constant token acquisition. It will be reset on service restarts.
let tokenStore = {
    accessToken: null,
    refreshToken: null,
    expiresAt: null, // Unix timestamp in milliseconds
};

// --- Token Acquisition/Refresh Logic ---

/**
 * Attempts to acquire or refresh an access token.
 * Prioritizes:
 * 1. Valid token in memory cache.
 * 2. Refresh token from memory cache.
 * 3. Fallback to INITIAL_REFRESH_TOKEN from environment variable.
 * If all else fails, it will attempt a password grant (less preferred for restarts).
 * Updates the in-memory `tokenStore` on success.
 * @param {boolean} forceRefresh If true, forces a refresh token grant even if current token is valid.
 * @returns {Promise<boolean>} True if token acquisition/refresh was successful, false otherwise.
 */
async function acquireOrRefreshToken(forceRefresh = false) {
    console.log('[AUTH] Attempting to acquire or refresh access token...');

    // 1. Check if current access token in cache is valid and not near expiry
    if (tokenStore.accessToken && tokenStore.expiresAt && Date.now() < tokenStore.expiresAt - (5 * 60 * 1000) && !forceRefresh) {
        console.log('[AUTH] Using valid access token from cache.');
        return true;
    }

    let grantTypeToUse = 'refresh_token';
    let refreshTokenValue = tokenStore.refreshToken;

    // If no refresh token in memory, try the INITIAL_REFRESH_TOKEN from environment
    if (!refreshTokenValue && INITIAL_REFRESH_TOKEN && INITIAL_REFRESH_TOKEN !== 'YOUR_FRESH_REFRESH_TOKEN_HERE') {
        refreshTokenValue = INITIAL_REFRESH_TOKEN;
        console.log('[AUTH] Using INITIAL_REFRESH_TOKEN from environment variable.');
    } else if (!refreshTokenValue) {
        // Fallback to password grant if no refresh token is available at all
        // This should ideally only happen on the very first run if INITIAL_REFRESH_TOKEN isn't set
        // or if the initial password grant is the only way to get a first token.
        // For Render.com, INITIAL_REFRESH_TOKEN is preferred for restarts.
        grantTypeToUse = 'password';
        console.warn('[AUTH] No refresh token available in memory or env. Falling back to password grant.');
    }

    try {
        let requestData;
        const tokenUrl = `${SFD_BASE_URL}/oauth2/token`;

        if (grantTypeToUse === 'password') {
            // NOTE: Hardcoding username/password here. For production, consider other secure methods
            // if INITIAL_REFRESH_TOKEN cannot be used as primary.
            requestData = {
                grant_type: 'password',
                client_id: SFD_CLIENT_ID,
                client_secret: SFD_CLIENT_SECRET,
                username: 'C5WH', // Placeholder: Replace with actual username if needed for password grant
                password: 'jaVathee123!', // Placeholder: Replace with actual password if needed for password grant
            };
            console.log('[AUTH] Attempting OAuth2 password grant...');
        } else { // grantTypeToUse === 'refresh_token'
            if (!refreshTokenValue) {
                console.error('[AUTH] Critical: No refresh token to use for refresh_token grant.');
                return false; // Cannot proceed without a refresh token
            }
            requestData = {
                grant_type: 'refresh_token',
                client_id: SFD_CLIENT_ID,
                client_secret: SFD_CLIENT_SECRET,
                refresh_token: refreshTokenValue,
                // REMOVED: scope: 'API' - As per previous debugging, the API seems to reject this during refresh if it doesn't match previous or expects no scope.
            };
            console.log('[AUTH] Attempting OAuth2 refresh_token grant...');
        }

        const tokenResponse = await axios.post(
            tokenUrl,
            qs.stringify(requestData),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                timeout: 15000 // 15 seconds timeout for token request
            }
        );

        const tokenData = tokenResponse.data;

        if (tokenResponse.status === 200 && tokenData.access_token) {
            // Check if OAuth2 returned an error object despite 200 OK (some APIs do this)
            if (tokenData.error) {
                console.error('[AUTH] OAuth2 grant failed (API error in 200 response):', tokenData.error_description || tokenData.error);
                throw new Error(tokenData.error_description || tokenData.error || 'OAuth2 grant failed with API error.');
            }

            console.log('[AUTH] OAuth2 token acquisition successful. Validating new token...');

            // Test the new token against /Practice endpoint to ensure it's truly valid
            const testResponse = await axios.get(`${SFD_BASE_URL}/Practice`, {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
                timeout: 10000 // 10 seconds timeout for validation
            });

            if (testResponse.status === 200) {
                console.log('[AUTH] New access token successfully validated.');
                tokenStore.accessToken = tokenData.access_token;
                // Set expiry with a 5-minute buffer
                tokenStore.expiresAt = Date.now() + (tokenData.expires_in * 1000) - (5 * 60 * 1000);
                if (tokenData.refresh_token) {
                    tokenStore.refreshToken = tokenData.refresh_token; // Always update refresh token if provided
                }
                return true; // Token acquisition successful
            } else {
                console.error(`[AUTH] New access token validation failed: ${testResponse.status} ${testResponse.statusText}`);
                throw new Error('New access token lacks account association or is invalid after acquisition.');
            }
        } else {
            console.error(`[AUTH] OAuth2 grant failed: ${tokenResponse.status} ${tokenResponse.statusText}`);
            console.error('[AUTH] Token response data:', tokenData);
            throw new Error(tokenData.error_description || tokenData.error || 'OAuth2 grant failed.');
        }
    } catch (error) {
        console.error('[AUTH] Error during token acquisition/refresh:', error.message);
        // Invalidate current tokens on error to force a new attempt later
        tokenStore.accessToken = null;
        tokenStore.refreshToken = null; // Clear refresh token if it failed
        tokenStore.expiresAt = null;
        return false; // Token acquisition failed
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
        // Ensure a valid token is available. Force refresh if near expiry or invalid.
        const tokenAcquired = await acquireOrRefreshToken();
        if (!tokenAcquired) {
            console.error('[PROXY_MIDDLEWARE] Failed to obtain valid access token. Aborting request.');
            const toolCallId = req.body.toolCallId || 'default_tool_call_id';
            return res.status(200).json({
                results: [{
                    toolCallId: toolCallId,
                    error: 'Proxy Error: Failed to obtain valid authentication token for SFD API. Check proxy logs. Ensure INITIAL_REFRESH_TOKEN env var is valid.'
                }]
            });
        }
        // Add the Authorization header to the request that will be forwarded to the SFD API
        req.headers.authorization = `Bearer ${tokenStore.accessToken}`;
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

    // Construct the full target URL for the SFD API
    // Ensure there's a '/' between the base URL and the target path
    let fullTargetUrl = `${SFD_BASE_URL}/${targetPath}`;

    // Extract relevant query parameters from the original URL.
    // Vapi sometimes adds its own 'url' parameter which should be filtered out.
    const queryParams = new URLSearchParams(req.originalUrl.split('?')[1]);
    let sfdApiQueryParams = new URLSearchParams();
    for (const [key, value] of queryParams.entries()) {
        if (key !== 'url') { // Exclude Vapi's 'url' parameter
            sfdApiQueryParams.append(key, value);
        }
    }

    if (sfdApiQueryParams.toString()) {
        fullTargetUrl += `?${sfdApiQueryParams.toString()}`;
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
            const refreshSuccess = await acquireOrRefreshToken(true); // Force refresh
            if (refreshSuccess) {
                // If refresh was successful, update the Authorization header with the new token
                // and retry the original request.
                axiosConfig.headers.authorization = `Bearer ${tokenStore.accessToken}`;
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
    // Attempt to acquire/refresh token. It will prioritize INITIAL_REFRESH_TOKEN if available.
    const initialTokenAcquired = await acquireOrRefreshToken();
    if (!initialTokenAcquired) {
        console.error('[INIT] Initial token acquisition failed. Proxy might not function correctly until a valid token is obtained. Please ensure INITIAL_REFRESH_TOKEN env var is valid.');
    }
});
