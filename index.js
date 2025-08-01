// index.js - Render.com Proxy Server with Final Robust Logging and Vapi Tool Call Handling

// --- 1. Library Imports ---
// Express is a minimalist web framework for Node.js.
const express = require('express');
// Axios is a promise-based HTTP client for the browser and node.js.
const axios = require('axios');
// Cors is a middleware for enabling Cross-Origin Resource Sharing.
const cors = require('cors');
// Qs is a library for parsing and stringifying URL query strings.
const qs = require('qs');

// --- 2. Server Setup ---
const app = express();
// Use the PORT provided by Render.com, or default to 10000 for local development.
const PORT = process.env.PORT || 10000;

// --- 3. Middleware for Request Handling ---
// Middleware to capture the raw request body. This is crucial for Vapi webhooks,
// as the body might be empty or in a format that regular parsers miss.
app.use(express.json({
    verify: (req, res, buf) => {
        // Only attempt to read buffer if it exists.
        if (buf && buf.length) {
            req.rawBody = buf.toString();
        } else {
            req.rawBody = '';
        }
    }
}));

// Enable CORS for all origins. This is necessary for local testing but should
// be restricted in a production environment for better security.
app.use(cors());
// Parse URL-encoded request bodies.
app.use(express.urlencoded({ extended: false }));

// --- 4. Environment Variables and Configuration ---
// These variables should be set on the Render.com dashboard for security.
// Hardcoded defaults are provided here for local development and demonstration purposes only.
const SFD_BASE_URL = process.env.SFD_BASE_URL || 'https://sfd.co:6500';
const SFD_CLIENT_ID = process.env.SFD_CLIENT_ID || 'betterproducts';
const SFD_CLIENT_SECRET = process.env.SFD_CLIENT_SECRET || '574f1383-8d69-49b4-a6a5-e969cbc9a99a';
// This initial refresh token is CRUCIAL for the proxy to bootstrap authentication
// without manual intervention. It must be set as an environment variable.
const INITIAL_REFRESH_TOKEN = process.env.INITIAL_REFRESH_TOKEN || 'f4fb0e5db04545a1b598def874b38543aedc8a93408d4cccb1ff5a57576e5a9e';

// --- 5. In-Memory Cache for Tokens ---
// We store the tokens in memory to avoid requesting a new token for every API call.
// This is a simple but effective caching mechanism for a single-instance proxy server.
let tokenStore = {
    accessToken: null,
    refreshToken: null,
    // expiresAt is a timestamp calculated to be a few minutes before the actual expiry,
    // allowing for proactive token refreshes.
    expiresAt: null,
};

// --- 6. Token Acquisition/Refresh Logic ---
/**
 * Asynchronously acquires a new access token using a refresh token or a password grant.
 * It also handles refreshing an existing token if it's close to expiring.
 * @param {boolean} forceRefresh - If true, ignores the cache and forces a new token request.
 * @returns {Promise<boolean>} True if a valid token is acquired, false otherwise.
 */
async function acquireOrRefreshToken(forceRefresh = false) {
    console.log('[AUTH] Attempting to acquire or refresh access token...');

    // Check if the current token is valid and not close to expiring (5 minutes buffer).
    if (tokenStore.accessToken && tokenStore.expiresAt && Date.now() < tokenStore.expiresAt - (5 * 60 * 1000) && !forceRefresh) {
        console.log('[AUTH] Using valid access token from cache.');
        return true;
    }

    let grantTypeToUse = 'refresh_token';
    let refreshTokenValue = tokenStore.refreshToken;

    // If no refresh token is in memory, try to use the one from the environment variable.
    if (!refreshTokenValue && INITIAL_REFRESH_TOKEN && INITIAL_REFRESH_TOKEN !== 'f4fb0e5db04545a1b598def874b38543aedc8a93408d4cccb1ff5a57576e5a9e') {
        refreshTokenValue = INITIAL_REFRESH_TOKEN;
        console.log('[AUTH] Using INITIAL_REFRESH_TOKEN from environment variable.');
    } else if (!refreshTokenValue) {
        // As a last resort, if no refresh token is found, fall back to the password grant.
        // This is not a recommended long-term strategy but provides a safety net.
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
                username: 'C5WH', // This username is specific to the example.
                password: 'jaVathee123!', // This password is specific to the example.
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

        // Make the POST request to the token endpoint.
        const tokenResponse = await axios.post(
            tokenUrl,
            qs.stringify(requestData),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                timeout: 15000 // Set a timeout to prevent hanging.
            }
        );

        const tokenData = tokenResponse.data;

        // Check if the token request was successful and contains an access token.
        if (tokenResponse.status === 200 && tokenData.access_token) {
            if (tokenData.error) {
                console.error('[AUTH] OAuth2 grant failed (API error in 200 response):', tokenData.error_description || tokenData.error);
                throw new Error(tokenData.error_description || tokenData.error || 'OAuth2 grant failed with API error.');
            }

            console.log('[AUTH] OAuth2 token acquisition successful. Validating new token...');
            // Validate the new token by making a quick API call to a harmless endpoint.
            const testResponse = await axios.get(`${SFD_BASE_URL}/Practice`, {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
                // We validate all statuses >= 200 and < 500 so we can inspect the response body for errors.
                validateStatus: (status) => status >= 200 && status < 500,
                timeout: 10000
            });

            if (testResponse.status === 200) {
                console.log('[AUTH] New access token successfully validated.');
                // Update the in-memory cache with the new tokens and expiry time.
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
        // Clear the token store on any failure to ensure a fresh attempt next time.
        tokenStore.accessToken = null;
        tokenStore.refreshToken = null;
        tokenStore.expiresAt = null;
        return false;
    }
}

// --- 7. Helper function to handle SFD responses and format for Vapi ---
/**
 * Takes an SFD API response and formats it into a Vapi-compatible JSON object.
 * @param {object} sfdResponse - The response object from an axios call to the SFD API.
 * @param {object} res - The Express response object.
 * @param {string} toolCallId - The ID of the tool call from Vapi.
 */
function handleSfdResponse(sfdResponse, res, toolCallId) {
    // If the SFD API returned an error status or an error in the body.
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

        // Format the error into a Vapi-compatible response.
        const vapiErrorResponse = {
            results: [{
                toolCallId: toolCallId,
                error: errorMessage.replace(/[\r\n]+/g, ' ').substring(0, 500)
            }]
        };
        // Always return 200 for Vapi webhooks, even on a functional error, to prevent retries.
        return res.status(200).json(vapiErrorResponse);
    }

    // On a successful response.
    console.log('--- [SFD API] Success Response ---');
    console.log('Status:', sfdResponse.status);
    console.log('Data:', sfdResponse.data);

    // Vapi's result field is a string, so we need to stringify the response data.
    const resultString = JSON.stringify(sfdResponse.data);

    // Format the successful result into a Vapi-compatible response.
    const vapiSuccessResponse = {
        results: [{
            toolCallId: toolCallId,
            result: resultString.replace(/[\r\n]+/g, ' ').substring(0, 500)
        }]
    };
    return res.status(200).json(vapiSuccessResponse);
}

// --- 8. Tool-Specific API Call Functions ---
// These functions encapsulate the logic for each specific API call.
// They are called by the main proxy handler based on the `toolName`.

/**
 * Calls the SFD API to get a list of available dentists.
 * @param {object} args - The arguments for the tool call (not used for this specific endpoint).
 */
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

/**
 * Calls the SFD API to get available appointment books (slots).
 * @param {object} args - The arguments from the Vapi tool call.
 */
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

/**
 * Registers a new patient with the SFD API.
 * This function has been updated to use the dynamic details provided by the user.
 * @param {object} args - The arguments from the Vapi tool call.
 */
async function registerNewUser(args) {
    // Correctly destructure all the fields provided by the AI from the user's conversation.
    const { forename, surname, dob, mobile, email, title, gender, street, city, county, postcode } = args;
    
    // Construct the request body using the dynamic data.
    const requestBody = {
        surname: surname,
        forename: forename,
        title: title, // Use the provided title
        gender: gender, // Use the provided gender
        dob: dob,
        address: {
            street: street, // Use the provided street
            city: city, // Use the provided city
            county: county, // Use the provided county
            postcode: postcode, // Use the provided postcode
        },
        phone: {
            home: mobile, // Use the mobile number for home phone as a fallback
            mobile: mobile,
            work: mobile // Use the mobile number for work phone as a fallback
        },
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

/**
 * Books an appointment with the SFD API.
 * @param {object} args - The arguments from the Vapi tool call.
 */
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

/**
 * Cancels an appointment with the SFD API.
 * @param {object} args - The arguments from the Vapi tool call.
 */
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

// --- 9. Main Proxy Route Handler ---
// This is the core endpoint that receives webhooks from Vapi.
app.post('/api/tool', async (req, res) => {
    console.log('[PROXY_DISPATCH] Received webhook.');

    // Check if body is empty, which can happen with certain webhook types.
    if (!req.rawBody) {
        console.error('[PROXY_DISPATCH] Error: Received webhook with empty body. Vapi is likely sending an empty request.');
        return res.status(200).send('Webhook body was empty.');
    }

    // Try to parse the raw body as JSON.
    let body;
    try {
        body = JSON.parse(req.rawBody);
    } catch (e) {
        console.error('[PROXY_DISPATCH] Failed to parse JSON body. Raw Body:', req.rawBody);
        return res.status(400).send('Invalid JSON in request body.');
    }

    // Check if the webhook is a "tool-calls" message.
    if (body.message && body.message.type === 'tool-calls') {
        const { toolCallId, toolName, toolArguments } = body.message;

        // Validate the incoming Vapi webhook structure.
        if (!toolCallId || !toolName || !toolArguments) {
            console.error('[PROXY_DISPATCH] Invalid Vapi tool call webhook format. Missing core fields. Body:', JSON.stringify(body));
            return res.status(400).json({ error: 'Invalid Vapi tool call webhook format.' });
        }

        // Ensure we have a valid access token before making any API calls.
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
            // Use a switch statement to dispatch the call to the appropriate tool function.
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
            // Format and send the response back to Vapi.
            return handleSfdResponse({ status: sfdResponseStatus, data: sfdResponseData }, res, toolCallId);
        } catch (error) {
            // Catch any errors that occur during the tool execution.
            console.error(`--- [PROXY] Error during tool execution (${toolName}) ---`);
            console.error(`Full Axios Error:`, error.message);
            // If the error has an Axios response, handle it as an SFD API error.
            if (error.response) {
                return handleSfdResponse({ status: error.response.status, data: error.response.data }, res, toolCallId);
            } else {
                // Otherwise, it's a proxy-internal error (e.g., network timeout, etc.).
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
        // Log and ignore any webhook types we don't handle.
        console.log(`[PROXY_DISPATCH] Received unhandled Vapi webhook type: ${body.message ? body.message.type : 'unknown'}. Body: ${req.rawBody}`);
        return res.status(200).send('Unhandled webhook type received.');
    }
});

// --- 10. Simple Test Endpoint for Proxy Status ---
// You can visit this URL directly in your browser to check if the proxy server is running.
app.get('/', (req, res) => {
    res.send('CORS Proxy is running and token management is active.');
});

// --- 11. Server Start and Initial Token Acquisition ---
// When the server starts, it immediately tries to get an initial access token.
// This ensures the proxy is ready to serve requests with a valid token from the beginning.
app.listen(PORT, async () => {
    console.log(`Proxy server listening on port ${PORT}`);
    console.log('[INIT] Attempting initial token acquisition...');
    // Attempt to acquire/refresh token. It will prioritize INITIAL_REFRESH_TOKEN if available.
    const initialTokenAcquired = await acquireOrRefreshToken();
    if (!initialTokenAcquired) {
        console.error('[INIT] Initial token acquisition failed. Proxy might not function correctly until a valid token is obtained.');
    }
});
