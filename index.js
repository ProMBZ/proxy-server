// index.js - Render.com Proxy Server with Final Robust Logging

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const qs = require('qs');

const app = express();
// Ensure we use the PORT provided by Render
const PORT = process.env.PORT || 10000;

// Middleware to capture the raw request body
app.use(express.json({
  verify: (req, res, buf) => {
    // Only attempt to read buffer if it exists
    if (buf && buf.length) {
      req.rawBody = buf.toString();
    } else {
      req.rawBody = '';
    }
  }
}));

// Enable CORS and other middleware
app.use(cors());
app.use(express.urlencoded({ extended: false }));

// --- Environment Variables ---
const SFD_BASE_URL = process.env.SFD_BASE_URL || 'https://sfd.co:6500';
const SFD_CLIENT_ID = process.env.SFD_CLIENT_ID || 'betterproducts';
const SFD_CLIENT_SECRET = process.env.SFD_CLIENT_SECRET || '574f1383-8d69-49b4-a6a5-e969cbc9a99a';
const INITIAL_REFRESH_TOKEN = process.env.INITIAL_REFRESH_TOKEN || 'f4fb0e5db04545a1b598def874b38543aedc8a93408d4cccb1ff5a57576e5a9e';

// --- In-Memory Cache for Tokens ---
let tokenStore = {
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
};

// --- Token Acquisition/Refresh Logic ---
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
                username: 'C5WH',
                password: 'jaVathee123!',
            };
            console.log('[AUTH] Attempting OAuth2 password grant...');
        } else {
            if (!refreshTokenValue) {
                console.error('[AUTH] Critical: No refresh token to use for refresh_token grant.');
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
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                timeout: 15000
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
                validateStatus: (status) => status >= 200 && status < 500,
                timeout: 10000
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

// --- Tool-Specific API Call Functions ---
async function getAvailableDentists(args) {
    const url = `${SFD_BASE_URL}/Users`;
    console.log(`[TOOL] Calling getAvailableDentists: ${url}`);
    const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${tokenStore.accessToken}` },
        validateStatus: (status) => status >= 200 && status < 500,
        timeout: 15000
    });
    return response.data;
}

async function getAvailableBooks(args) {
    const { date, time, app_rsn_id } = args;
    const url = `${SFD_BASE_URL}/appointment/reserve?date=${date}&time=${time}&app_rsn_id=${app_rsn_id}&patient_id=1`;
    console.log(`[TOOL] Calling getAvailableBooks (via reserve): ${url}`);
    const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${tokenStore.accessToken}` },
        validateStatus: (status) => status >= 200 && status < 500,
        timeout: 15000
    });
    return response.data;
}

async function registerNewUser(args) {
    const { forename, surname, dob, mobile, email } = args;
    const requestBody = {
        surname: surname, forename: forename, title: "Mr", gender: "Male", dob: dob,
        address: { street: "123 Dummy St", city: "Dummy City", county: "Dummy County", postcode: "DU1 1MY" },
        phone: { home: "00000000000", mobile: mobile, work: "00000000000" },
        email: email
    };
    const url = `${SFD_BASE_URL}/patient/register`;
    console.log(`[TOOL] Calling registerNewUser: ${url} with body:`, JSON.stringify(requestBody));
    const response = await axios.post(url, requestBody, {
        headers: {
            'Authorization': `Bearer ${tokenStore.accessToken}`,
            'Content-Type': 'application/json'
        },
        validateStatus: (status) => status >= 200 && status < 500,
        timeout: 20000
    });
    return response.data;
}

async function bookAppointment(args) {
    const { patient_id, date, time, app_rsn_id, app_rec_id } = args;
    let url;
    if (app_rec_id) {
        url = `${SFD_BASE_URL}/appointment/book?app_rec_id=${app_rec_id}&patient_id=${patient_id}`;
    } else {
        url = `${SFD_BASE_URL}/appointment/book?patient_id=${patient_id}&date=${date}&time=${time}&app_rsn_id=${app_rsn_id}`;
    }
    console.log(`[TOOL] Calling bookAppointment: ${url}`);
    const response = await axios.post(url, null, {
        headers: { 'Authorization': `Bearer ${tokenStore.accessToken}` },
        validateStatus: (status) => status >= 200 && status < 500,
        timeout: 20000
    });
    return response.data;
}

async function cancelAppointment(args) {
    const { app_rec_id, patient_id, app_can_id = 1 } = args;
    const url = `${SFD_BASE_URL}/appointment/cancel?app_rec_id=${app_rec_id}&app_can_id=${app_can_id}&patient_id=${patient_id}`;
    console.log(`[TOOL] Calling cancelAppointment: ${url}`);
    const response = await axios.post(url, null, {
        headers: { 'Authorization': `Bearer ${tokenStore.accessToken}` },
        validateStatus: (status) => status >= 200 && status < 500,
        timeout: 20000
    });
    return response.data;
}

// --- Main Proxy Route Handler ---
app.post('/api/tool', async (req, res) => {
    console.log('[PROXY_DISPATCH] Received webhook.');

    // Check if body is empty
    if (!req.rawBody) {
        console.error('[PROXY_DISPATCH] Error: Received webhook with empty body. Vapi is likely sending an empty request.');
        // Return 200 OK to prevent Vapi from retrying
        return res.status(200).send('Webhook body was empty.');
    }

    // Try to parse the raw body as JSON
    let body;
    try {
        body = JSON.parse(req.rawBody);
    } catch (e) {
        console.error('[PROXY_DISPATCH] Failed to parse JSON body. Raw Body:', req.rawBody);
        return res.status(400).send('Invalid JSON in request body.');
    }

    if (body.message && body.message.type === 'tool-calls') {
        const { toolCallId, toolName, toolArguments } = body.message;

        if (!toolCallId || !toolName || !toolArguments) {
            console.error('[PROXY_DISPATCH] Invalid Vapi tool call webhook format. Missing core fields. Body:', JSON.stringify(body));
            return res.status(400).json({ error: 'Invalid Vapi tool call webhook format.' });
        }

        const tokenAcquired = await acquireOrRefreshToken();
        if (!tokenAcquired) {
            console.error('[PROXY_DISPATCH] Failed to obtain valid access token for tool call:', toolName);
            return res.status(200).json({
                results: [{
                    toolCallId: toolCallId,
                    error: 'Proxy Error: Failed to obtain valid authentication token for SFD API.'
                }]
            });
        }

        let sfdResponseData;
        let sfdResponseStatus;

        try {
            switch (toolName) {
                case 'getAvailableDentists':
                    sfdResponseData = await getAvailableDentists(toolArguments);
                    sfdResponseStatus = 200;
                    break;
                case 'getAvailableBooks':
                    sfdResponseData = await getAvailableBooks(toolArguments);
                    sfdResponseStatus = 200;
                    break;
                case 'registerNewUser':
                    sfdResponseData = await registerNewUser(toolArguments);
                    sfdResponseStatus = 200;
                    break;
                case 'bookAppointment':
                    sfdResponseData = await bookAppointment(toolArguments);
                    sfdResponseStatus = 200;
                    break;
                case 'cancelAppointment':
                    sfdResponseData = await cancelAppointment(toolArguments);
                    sfdResponseStatus = 200;
                    break;
                default:
                    console.warn(`[PROXY_DISPATCH] Unknown tool name received: ${toolName}`);
                    return res.status(200).json({
                        results: [{
                            toolCallId: toolCallId,
                            error: `Unknown tool: ${toolName}`
                        }]
                    });
            }
            return handleSfdResponse({ status: sfdResponseStatus, data: sfdResponseData }, res, toolCallId);
        } catch (error) {
            console.error(`--- [PROXY] Error during tool execution (${toolName}) ---`);
            console.error(`Full Axios Error:`, error.message);
            if (error.response) {
                return handleSfdResponse({ status: error.response.status, data: error.response.data }, res, toolCallId);
            } else {
                const vapiErrorResponse = {
                    results: [{
                        toolCallId: toolCallId,
                        error: `Proxy internal error during ${toolName} call: ${error.message}.`
                    }]
                };
                return res.status(200).json(vapiErrorResponse);
            }
        }
    } else {
        console.log(`[PROXY_DISPATCH] Received unhandled Vapi webhook type: ${body.message ? body.message.type : 'unknown'}. Body: ${req.rawBody}`);
        return res.status(200).send('Unhandled webhook type received.');
    }
});

// --- Simple Test Endpoint for Proxy Status ---
app.get('/', (req, res) => {
    res.send('CORS Proxy is running and token management is active.');
});

// --- Server Start and Initial Token Acquisition ---
app.listen(PORT, async () => {
    console.log(`Proxy server listening on port ${PORT}`);
    console.log('[INIT] Attempting initial token acquisition...');
    const initialTokenAcquired = await acquireOrRefreshToken();
    if (!initialTokenAcquired) {
        console.error('[INIT] Initial token acquisition failed. Proxy might not function correctly until a valid token is obtained.');
    }
});
