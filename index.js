// index.js - The complete and robust Node.js Proxy Server for Vapi with SFD API Tools

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const qs = require('qs');

const app = express();
const PORT = process.env.PORT || 10000;

// Enable CORS for all origins (adjust for production)
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// --- Environment Variables (REQUIRED on Render.com) ---
const SFD_BASE_URL = process.env.SFD_BASE_URL || 'https://sfd.co:6500';
const SFD_CLIENT_ID = process.env.SFD_CLIENT_ID || 'betterproducts';
const SFD_CLIENT_SECRET = process.env.SFD_CLIENT_SECRET || '574f1383-8d69-49b4-a6a5-e969cbc9a99a';
const INITIAL_REFRESH_TOKEN = process.env.INITIAL_REFRESH_TOKEN || '0a8f1e79fedd4c7888b8422c559e04d8ab49c875414a4f3f83f3ac76e582dd83';

// In-memory cache for tokens
let tokenStore = {
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
};

// --- Utility Functions for Data Handling and Formatting ---

/**
 * Sanitizes and truncates a string to a specified max length.
 * @param {any} input The value to sanitize.
 * @param {number} maxLength The maximum allowed length.
 * @returns {string} The sanitized and truncated string.
 */
const sanitizeAndTruncate = (input, maxLength) => {
    if (input === null || input === undefined) {
        return '';
    }
    const sanitized = String(input).trim().replace(/[\r\n]+/g, ' ');
    return sanitized.substring(0, maxLength);
};

// --- Token Acquisition/Refresh Logic ---

/**
 * Acquires or refreshes an access token using a refresh token or a password grant as a fallback.
 * @param {boolean} forceRefresh If true, forces a token refresh regardless of cache.
 * @returns {Promise<boolean>} True if successful, false otherwise.
 */
async function acquireOrRefreshToken(forceRefresh = false) {
    console.log('[AUTH] Attempting to acquire or refresh access token...');

    if (tokenStore.accessToken && tokenStore.expiresAt && Date.now() < tokenStore.expiresAt - (5 * 60 * 1000) && !forceRefresh) {
        console.log('[AUTH] Using valid access token from cache.');
        return true;
    }

    let grantTypeToUse = 'refresh_token';
    let refreshTokenValue = tokenStore.refreshToken;

    if (!refreshTokenValue && INITIAL_REFRESH_TOKEN && INITIAL_REFRESH_TOKEN !== 'YOUR_FRESH_REFRESH_TOKEN_HERE') {
        refreshTokenValue = INITIAL_REFRESH_TOKEN;
        console.log('[AUTH] Using INITIAL_REFRESH_TOKEN from environment variable.');
    } else if (!refreshTokenValue) {
        grantTypeToUse = 'password';
        console.warn('[AUTH] No refresh token available. Falling back to password grant.');
    }

    try {
        let requestData;
        const tokenUrl = `${SFD_BASE_URL}/oauth2/token`;

        if (grantTypeToUse === 'password') {
            requestData = {
                grant_type: 'password',
                client_id: SFD_CLIENT_ID,
                client_secret: SFD_CLIENT_SECRET,
                username: 'C5WH',
                password: 'jaVathee123!',
            };
            console.log('[AUTH] Attempting OAuth2 password grant...');
        } else {
            if (!refreshTokenValue) {
                console.error('[AUTH] Critical: No refresh token to use.');
                return false;
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
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
                timeout: 90000
            }
        );

        const tokenData = tokenResponse.data;

        if (tokenResponse.status === 200 && tokenData.access_token) {
            tokenStore.accessToken = tokenData.access_token;
            tokenStore.expiresAt = Date.now() + (tokenData.expires_in * 1000) - (5 * 60 * 1000);
            if (tokenData.refresh_token) {
                tokenStore.refreshToken = tokenData.refresh_token;
            }
            console.log('[AUTH] Token acquisition successful.');
            return true;
        } else {
            console.error(`[AUTH] OAuth2 grant failed: ${tokenResponse.status} ${tokenResponse.statusText}`);
            console.error('[AUTH] Token response data:', tokenData);
            return false;
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

        let errorMessage = sfdResponse.data?.error?.description || sfdResponse.data?.error || sfdResponse.statusText || 'Unknown SFD API Error.';
        if (sfdResponse.data && typeof sfdResponse.data !== 'object') {
            errorMessage = sfdResponse.data;
        }

        const vapiErrorResponse = {
            results: [{
                toolCallId: toolCallId,
                error: `SFD API Error: ${errorMessage.replace(/[\r\n]+/g, ' ').substring(0, 500)}`
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

// --- Middleware for all /api/* routes to ensure token is ready ---
app.use('/api/*', async (req, res, next) => {
    const toolCallId = req.body.toolCallId || 'default_tool_call_id';
    try {
        const tokenAcquired = await acquireOrRefreshToken();
        if (!tokenAcquired) {
            console.error('[PROXY_MIDDLEWARE] Failed to obtain valid access token. Aborting request.');
            return res.status(200).json({
                results: [{
                    toolCallId: toolCallId,
                    error: 'Proxy Error: Failed to obtain valid authentication token. Check proxy logs.'
                }]
            });
        }
        req.headers.authorization = `Bearer ${tokenStore.accessToken}`;
        next();
    } catch (error) {
        console.error('[PROXY_MIDDLEWARE] Error during token setup:', error.message);
        return res.status(200).json({
            results: [{
                toolCallId: toolCallId,
                error: `Proxy Error during token setup: ${error.message}.`
            }]
        });
    }
});

// --- Specific API Endpoints for each Vapi Tool ---

app.post('/api/createPatient', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    console.log(`[createPatient] Received req.body:`, req.body);

    const final_dob = sanitizeAndTruncate(req.body.dob, 10);
    if (final_dob && !/^\d{4}-\d{2}-\d{2}$/.test(final_dob)) {
        console.error('[createPatient] Invalid DOB format received:', req.body.dob);
        return res.status(200).json({ results: [{ toolCallId: toolCallId, error: 'Invalid Date of Birth format. Expected YYYY-MM-DD.' }] });
    }

    try {
        const payload = {
            surname: sanitizeAndTruncate(req.body.surname, 50),
            forename: sanitizeAndTruncate(req.body.forename, 50),
            title: sanitizeAndTruncate(req.body.patient_title || req.body['patient_title\n'] || 'Mr.', 10),
            gender: sanitizeAndTruncate(req.body.patient_sex, 10),
            dob: final_dob,
            address: {
                street: sanitizeAndTruncate(req.body.address_street, 100),
                city: sanitizeAndTruncate(req.body.address_city, 50),
                county: sanitizeAndTruncate(req.body.address_county, 50),
                postcode: sanitizeAndTruncate(req.body.address_postcode, 20),
            },
            phone: {
                home: sanitizeAndTruncate(req.body.phone_home, 20),
                mobile: sanitizeAndTruncate(req.body.patient_phone, 20).replace(/\D/g, ''),
                work: sanitizeAndTruncate(req.body.phone_work, 20),
            },
            email: sanitizeAndTruncate(req.body.patient_email, 100)
        };

        console.log(`[createPatient] Final Payload to SFD API:`, JSON.stringify(payload));
        const sfdResponse = await axios.post(`${SFD_BASE_URL}/patient/register`, payload, {
            headers: { Authorization: req.headers.authorization },
            timeout: 90000
        });
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

app.post('/api/searchPatient', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const params = {
        forename: sanitizeAndTruncate(req.body.forename, 50),
        surname: sanitizeAndTruncate(req.body.surname, 50),
        dob: sanitizeAndTruncate(req.body.dob, 10),
    };
    try {
        console.log(`[searchPatient] Sending to SFD API with params:`, JSON.stringify(params));
        const sfdResponse = await axios.get(`${SFD_BASE_URL}/patient/search`, {
            params: params,
            headers: { Authorization: req.headers.authorization },
            timeout: 90000
        });
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

app.post('/api/getAvailableDates', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const params = {
        year: sanitizeAndTruncate(req.body.year, 4),
        month: sanitizeAndTruncate(req.body.month, 2),
        app_rsn_id: sanitizeAndTruncate(req.body.app_rsn_id, 20)
    };
    try {
        console.log(`[getAvailableDates] Sending to SFD API with params:`, JSON.stringify(params));
        const sfdResponse = await axios.get(`${SFD_BASE_URL}/appointment/dates`, {
            params: params,
            headers: { Authorization: req.headers.authorization },
            timeout: 90000
        });
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

app.post('/api/getAvailableTimes', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const params = {
        date: sanitizeAndTruncate(req.body.date, 10),
        app_rsn_id: sanitizeAndTruncate(req.body.app_rsn_id, 20)
    };
    try {
        console.log(`[getAvailableTimes] Sending to SFD API with params:`, JSON.stringify(params));
        const sfdResponse = await axios.get(`${SFD_BASE_URL}/appointment/times`, {
            params: params,
            headers: { Authorization: req.headers.authorization },
            timeout: 90000
        });
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

app.post('/api/reserveSlot', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const payload = {
        date: sanitizeAndTruncate(req.body.date, 10),
        time: sanitizeAndTruncate(req.body.time, 5),
        app_rsn_id: sanitizeAndTruncate(req.body.app_rsn_id, 20),
        patient_id: sanitizeAndTruncate(req.body.patient_id, 20),
    };
    try {
        console.log(`[reserveSlot] Sending to SFD API with payload:`, JSON.stringify(payload));
        const sfdResponse = await axios.post(`${SFD_BASE_URL}/appointment/reserve`, payload, {
            headers: { Authorization: req.headers.authorization },
            timeout: 90000
        });
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

app.post('/api/bookAppointment', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const payload = {
        app_rec_id: sanitizeAndTruncate(req.body.app_rec_id, 20),
        patient_id: sanitizeAndTruncate(req.body.patient_id, 20)
    };
    try {
        console.log(`[bookAppointment] Sending to SFD API with payload:`, JSON.stringify(payload));
        const sfdResponse = await axios.post(`${SFD_BASE_URL}/appointment/book`, payload, {
            headers: { Authorization: req.headers.authorization },
            timeout: 90000
        });
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

app.post('/api/cancelAppointment', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const payload = {
        app_rec_id: sanitizeAndTruncate(req.body.app_rec_id, 20),
        app_can_id: sanitizeAndTruncate(req.body.app_can_id, 20),
        patient_id: sanitizeAndTruncate(req.body.patient_id, 20)
    };
    try {
        console.log(`[cancelAppointment] Sending to SFD API with payload:`, JSON.stringify(payload));
        const sfdResponse = await axios.post(`${SFD_BASE_URL}/appointment/cancel`, payload, {
            headers: { Authorization: req.headers.authorization },
            timeout: 90000
        });
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

app.post('/api/getPatientAppointments', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const params = {
        patient_id: sanitizeAndTruncate(req.body.patient_id, 20)
    };
    try {
        console.log(`[getPatientAppointments] Sending to SFD API with params:`, JSON.stringify(params));
        const sfdResponse = await axios.get(`${SFD_BASE_URL}/patient/appointments/current`, {
            params: params,
            headers: { Authorization: req.headers.authorization },
            timeout: 90000
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
    console.error(`Error Type: ${error.name || 'Unknown'}`);
    console.error(`Error Message:`, error.message);
    if (axios.isAxiosError(error)) {
        if (error.response) {
            console.error(`Error Response Status:`, error.response.status);
            console.error(`Error Response Data:`, error.response.data);
        } else if (error.request) {
            console.error('Error Request: The request was made but no response was received.');
        }
    } else {
        console.error('Non-Axios Error:', error);
    }
    const vapiErrorResponse = {
        results: [{
            toolCallId: toolCallId,
            error: `Proxy internal error: ${error.message}. Check proxy logs for more details.`
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
        console.error('[INIT] Initial token acquisition failed. Please ensure INITIAL_REFRESH_TOKEN env var is valid.');
    }
});