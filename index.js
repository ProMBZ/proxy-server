// index.js - Updated Node.js Proxy Server for Vapi with SFD API Tools

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
        grantTypeToUse = 'password';
        console.warn('[AUTH] No refresh token available in memory or env. Falling back to password grant.');
    }

    try {
        let requestData;
        const tokenUrl = `${SFD_BASE_URL}/oauth2/token`;

        if (grantTypeToUse === 'password') {
            requestData = {
                grant_type: 'password',
                client_id: SFD_CLIENT_ID,
                client_secret: SFD_CLIENT_SECRET,
                username: 'C5WH', // Placeholder
                password: 'jaVathee123!', // Placeholder
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
            if (tokenData.error) {
                console.error('[AUTH] OAuth2 grant failed (API error in 200 response):', tokenData.error_description || tokenData.error);
                throw new Error(tokenData.error_description || tokenData.error || 'OAuth2 grant failed with API error.');
            }

            console.log('[AUTH] OAuth2 token acquisition successful. Validating new token...');

            const testResponse = await axios.get(`${SFD_BASE_URL}/Practice`, {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
                validateStatus: (status) => status >= 200 && status < 500, // Handle non-2xx status
                timeout: 10000 // 10 seconds timeout for validation
            });

            if (testResponse.status === 200) {
                console.log('[AUTH] New access token successfully validated.');
                tokenStore.accessToken = tokenData.access_token;
                tokenStore.expiresAt = Date.now() + (tokenData.expires_in * 1000) - (5 * 60 * 1000);
                if (tokenData.refresh_token) {
                    tokenStore.refreshToken = tokenData.refresh_token;
                }
                return true;
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
        tokenStore.accessToken = null;
        tokenStore.refreshToken = null;
        tokenStore.expiresAt = null;
        return false;
    }
}

// --- Helper function to handle SFD responses and format for Vapi ---
function handleSfdResponse(sfdResponse, res, toolCallId) {
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

        const vapiErrorResponse = {
            results: [{
                toolCallId: toolCallId,
                error: errorMessage.replace(/[\r\n]+/g, ' ').substring(0, 500)
            }]
        };
        return res.status(200).json(vapiErrorResponse);
    }

    console.log('--- [SFD API] Success Response ---');
    console.log('Status:', sfdResponse.status);
    console.log('Data:', sfdResponse.data);

    const resultString = JSON.stringify(sfdResponse.data);

    const vapiSuccessResponse = {
        results: [{
            toolCallId: toolCallId,
            result: resultString.replace(/[\r\n]+/g, ' ').substring(0, 500)
        }]
    };
    return res.status(200).json(vapiSuccessResponse);
}

// --- Middleware for all /api/* routes ---
app.use('/api/*', async (req, res, next) => {
    try {
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
        req.headers.authorization = `Bearer ${tokenStore.accessToken}`;
        next();
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

// --- Specific API Endpoints for each Vapi Tool ---
// Each tool has its own dedicated route to handle its specific request format.

// POST: /api/createPatient
app.post('/api/createPatient', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const { forename, surname, dob, patient_email, patient_phone, address_street, address_city, address_postcode, patient_sex, patient_title } = req.body.toolArgs;

    try {
        const sfdResponse = await axios.post(`${SFD_BASE_URL}/patient/register`, {
            forename,
            surname,
            dob,
            patient_email,
            patient_phone,
            'address.street': address_street,
            'address.city': address_city,
            'address.postcode': address_postcode,
            patient_sex,
            patient_title
        }, { headers: { Authorization: req.headers.authorization } });
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// POST: /api/searchPatient
app.post('/api/searchPatient', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const { forename, surname, dob } = req.body.toolArgs;
    
    try {
        const sfdResponse = await axios.get(`${SFD_BASE_URL}/patient/search`, {
            params: { forename, surname, dob },
            headers: { Authorization: req.headers.authorization }
        });
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// POST: /api/getAvailableDates
app.post('/api/getAvailableDates', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const { year, month, app_rsn_id } = req.body.toolArgs;

    try {
        const sfdResponse = await axios.get(`${SFD_BASE_URL}/appointment/dates`, {
            params: { year, month, app_rsn_id },
            headers: { Authorization: req.headers.authorization }
        });
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// POST: /api/getAvailableTimes
app.post('/api/getAvailableTimes', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const { date, app_rsn_id } = req.body.toolArgs;

    try {
        const sfdResponse = await axios.get(`${SFD_BASE_URL}/appointment/times`, {
            params: { date, app_rsn_id },
            headers: { Authorization: req.headers.authorization }
        });
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// POST: /api/reserveSlot
app.post('/api/reserveSlot', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const { date, time, app_rsn_id, patient_id } = req.body.toolArgs;

    try {
        const sfdResponse = await axios.post(`${SFD_BASE_URL}/appointment/reserve`, {
            date,
            time,
            app_rsn_id,
            patient_id
        }, { headers: { Authorization: req.headers.authorization } });
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// POST: /api/bookAppointment
app.post('/api/bookAppointment', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const { app_rec_id, patient_id } = req.body.toolArgs;

    try {
        const sfdResponse = await axios.post(`${SFD_BASE_URL}/appointment/book`, {
            app_rec_id,
            patient_id
        }, { headers: { Authorization: req.headers.authorization } });
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// POST: /api/cancelAppointment
app.post('/api/cancelAppointment', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const { app_rec_id, app_can_id, patient_id } = req.body.toolArgs;

    try {
        const sfdResponse = await axios.post(`${SFD_BASE_URL}/appointment/cancel`, {
            app_rec_id,
            app_can_id,
            patient_id
        }, { headers: { Authorization: req.headers.authorization } });
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// POST: /api/getPatientAppointments
app.post('/api/getPatientAppointments', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const { patient_id } = req.body.toolArgs;

    try {
        const sfdResponse = await axios.get(`${SFD_BASE_URL}/patient/appointments/current`, {
            params: { patient_id },
            headers: { Authorization: req.headers.authorization }
        });
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// --- Simple Test Endpoint for Proxy Status ---
app.get('/', (req, res) => {
    res.send('CORS Proxy is running and token management is active.');
});

// --- Helper function for cleaner error handling in routes ---
function handleProxyError(error, res, toolCallId) {
    console.error(`--- [PROXY] Internal Error Catch Block ---`);
    console.error(`Full Axios Error:`, error.message);
    if (error.response) {
        console.error(`Error Response Status:`, error.response.status);
        console.error(`Error Response Data:`, error.response.data);
    }
    console.error(`--- End [PROXY] Internal Error Catch Block ---`);

    const vapiErrorResponse = {
        results: [{
            toolCallId: toolCallId,
            error: `Proxy internal error: ${error.message}. Check proxy logs for more details.`.replace(/[\r\n]+/g, ' ').substring(0, 500)
        }]
    };
    return res.status(200).json(vapiErrorResponse);
}

// --- Server Start and Initial Token Acquisition ---
app.listen(PORT, async () => {
    console.log(`Proxy server listening on port ${PORT}`);
    console.log('[INIT] Attempting initial token acquisition...');
    const initialTokenAcquired = await acquireOrRefreshToken();
    if (!initialTokenAcquired) {
        console.error('[INIT] Initial token acquisition failed. Proxy might not function correctly until a valid token is obtained. Please ensure INITIAL_REFRESH_TOKEN env var is valid.');
    }
});
