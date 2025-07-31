// index.js - Render.com Proxy Server with Robust Webhook Handling

const express = require('express');
const axios = require('axios'); // Used for making HTTP requests
const cors = require('cors');
const qs = require('qs'); // Used for URL-encoded body for token requests

const app = express();
const PORT = process.env.PORT || 10000; // Use Render's assigned port or default to 10000

// Enable CORS for all origins (adjust for production if needed)
app.use(cors());
// Parse JSON request bodies - Vapi sends tool calls as JSON POST requests
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
const INITIAL_REFRESH_TOKEN = process.env.INITIAL_REFRESH_TOKEN || 'f4fb0e5db04545a1b598def874b38543aedc8a93408d4cccb1ff5a57576e5a9e'; // *** IMPORTANT: Replace with a real, fresh refresh token ***

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
                validateStatus: (status) => status >= 200 && status < 500,
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

// --- Tool-Specific API Call Functions ---

/**
 * Calls the SFD API to get available dentists.
 * @param {object} args - Arguments from Vapi tool call.
 * @param {string} args.date - Date in YYYY-MM-DD format.
 * @param {string} args.time - Time in HH:MM format.
 * @returns {Promise<object>} SFD API response data.
 */
async function getAvailableDentists(args) {
    const { date, time } = args;
    // NOTE: Postman has GET /Users, but no explicit date/time filter.
    // Assuming for now that /Users returns all and filtering happens client-side,
    // or this endpoint needs to be clarified with SFD support.
    // For now, we'll just call /Users.
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
 * Calls the SFD API to get available appointment books (via reserve).
 * @param {object} args - Arguments from Vapi tool call.
 * @param {string} args.date - Date in YYYY-MM-DD format.
 * @param {string} args.time - Time in HH:MM format.
 * @param {number} args.app_rsn_id - Appointment reason ID.
 * @returns {Promise<object>} SFD API response data.
 */
async function getAvailableBooks(args) {
    const { date, time, app_rsn_id } = args;
    // Using dummy patient_id=1 for reserve as per Postman example.
    // This patient_id MUST be valid in the SFD live system.
    const url = `${SFD_BASE_URL}/appointment/reserve?date=${date}&time=${time}&app_rsn_id=${app_rsn_id}&patient_id=1`;
    console.log(`[TOOL] Calling getAvailableBooks (via reserve): ${url}`);
    const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${tokenStore.accessToken}` },
        validateStatus: (status) => status >= 200 && status < 500,
        timeout: 15000
    });
    return response.data; // This should ideally return app_rec_id for booking
}

/**
 * Calls the SFD API to register a new patient.
 * @param {object} args - Arguments from Vapi tool call.
 * @param {string} args.forename - Patient's forename.
 * @param {string} args.surname - Patient's surname.
 * @param {string} args.dob - Patient's date of birth (YYYY-MM-DD).
 * @param {string} args.mobile - Patient's mobile number.
 * @param {string} args.email - Patient's email address.
 * @returns {Promise<object>} SFD API response data (should contain patient_id).
 */
async function registerNewUser(args) {
    const { forename, surname, dob, mobile, email } = args;

    // Construct the JSON body as per Postman collection
    const requestBody = {
        surname: surname,
        forename: forename,
        title: "Mr", // Dummy Data - Client needs to confirm if this is fixed or should be collected
        gender: "Male", // Dummy Data - Client needs to confirm if this is fixed or should be collected
        dob: dob,
        address: {
            street: "123 Dummy St", // Dummy Data - Client needs to confirm if this is fixed or should be collected
            city: "Dummy City", // Dummy Data
            county: "Dummy County", // Dummy Data
            postcode: "DU1 1MY" // Dummy Data
        },
        phone: {
            home: "00000000000", // Dummy Data
            mobile: mobile,
            work: "00000000000" // Dummy Data
        },
        email: email
    };

    const url = `${SFD_BASE_URL}/patient/register`;
    console.log(`[TOOL] Calling registerNewUser: ${url} with body:`, JSON.stringify(requestBody));

    const response = await axios.post(url, requestBody, {
        headers: {
            'Authorization': `Bearer ${tokenStore.accessToken}`,
            'Content-Type': 'application/json' // Ensure content type is JSON for raw body
        },
        validateStatus: (status) => status >= 200 && status < 500,
        timeout: 20000
    });
    return response.data; // Should return patient_id
}

/**
 * Calls the SFD API to book an appointment.
 * @param {object} args - Arguments from Vapi tool call.
 * @param {number} args.patient_id - ID of the patient.
 * @param {string} args.date - Date of the appointment (YYYY-MM-DD).
 * @param {string} args.time - Time of the appointment (HH:MM).
 * @param {number} args.app_rsn_id - Appointment reason ID.
 * @param {string} [args.app_rec_id] - Optional appointment record ID from reserve.
 * @returns {Promise<object>} SFD API response data.
 */
async function bookAppointment(args) {
    const { patient_id, date, time, app_rsn_id, app_rec_id } = args;

    let url;
    if (app_rec_id) {
        // Book from reservation if app_rec_id is provided
        url = `${SFD_BASE_URL}/appointment/book?app_rec_id=${app_rec_id}&patient_id=${patient_id}`;
    } else {
        // Direct booking if no app_rec_id
        url = `${SFD_BASE_URL}/appointment/book?patient_id=${patient_id}&date=${date}&time=${time}&app_rsn_id=${app_rsn_id}`;
    }

    console.log(`[TOOL] Calling bookAppointment: ${url}`);
    const response = await axios.post(url, null, { // POST with query params, body is null
        headers: { 'Authorization': `Bearer ${tokenStore.accessToken}` },
        validateStatus: (status) => status >= 200 && status < 500,
        timeout: 20000
    });
    return response.data;
}

/**
 * Calls the SFD API to cancel an appointment.
 * @param {object} args - Arguments from Vapi tool call.
 * @param {string} args.app_rec_id - Appointment record ID to cancel.
 * @param {number} args.patient_id - ID of the patient.
 * @param {number} [args.app_can_id=1] - Cancellation reason ID (defaults to 1).
 * @returns {Promise<object>} SFD API response data.
 */
async function cancelAppointment(args) {
    const { app_rec_id, patient_id, app_can_id = 1 } = args; // Default app_can_id to 1

    const url = `${SFD_BASE_URL}/appointment/cancel?app_rec_id=${app_rec_id}&app_can_id=${app_can_id}&patient_id=${patient_id}`;
    console.log(`[TOOL] Calling cancelAppointment: ${url}`);

    const response = await axios.post(url, null, { // POST with query params, body is null
        headers: { 'Authorization': `Bearer ${tokenStore.accessToken}` },
        validateStatus: (status) => status >= 200 && status < 500,
        timeout: 20000
    });
    return response.data;
}

// --- Main Proxy Route Handler ---
// This route handles all incoming requests to '/api/*' and dispatches them to the correct tool function.
app.post('/api/tool', async (req, res) => {
    // Log the full incoming request body for debugging
    console.log('[PROXY_DISPATCH] Received Vapi webhook. Full body:', JSON.stringify(req.body, null, 2));

    // Check if it's a 'tool-calls' webhook from Vapi
    if (req.body.message && req.body.message.type === 'tool-calls') {
        const { toolCallId, toolName, toolArguments } = req.body.message; // Extract from req.body.message

        // Ensure we have necessary Vapi webhook data for tool calls
        if (!toolCallId || !toolName || !toolArguments) {
            console.error('[PROXY_DISPATCH] Invalid Vapi tool call webhook format. Missing core fields (toolCallId, toolName, or toolArguments).');
            return res.status(400).json({ error: 'Invalid Vapi tool call webhook format. Missing toolCallId, toolName, or toolArguments.' });
        }

        // Ensure a valid token is available before attempting any tool call
        const tokenAcquired = await acquireOrRefreshToken();
        if (!tokenAcquired) {
            console.error('[PROXY_DISPATCH] Failed to obtain valid access token for tool call:', toolName);
            return res.status(200).json({
                results: [{
                    toolCallId: toolCallId,
                    error: 'Proxy Error: Failed to obtain valid authentication token for SFD API. Check proxy logs. Ensure INITIAL_REFRESH_TOKEN env var is valid.'
                }]
            });
        }

        let sfdResponseData;
        let sfdResponseStatus;

        try {
            switch (toolName) {
                case 'getAvailableDentists':
                    sfdResponseData = await getAvailableDentists(toolArguments);
                    sfdResponseStatus = 200; // Assuming success if data is returned
                    break;
                case 'getAvailableBooks':
                    sfdResponseData = await getAvailableBooks(toolArguments);
                    sfdResponseStatus = 200; // Assuming success if data is returned
                    break;
                case 'registerNewUser':
                    sfdResponseData = await registerNewUser(toolArguments);
                    sfdResponseStatus = 200; // Assuming success if data is returned
                    break;
                case 'bookAppointment':
                    sfdResponseData = await bookAppointment(toolArguments);
                    sfdResponseStatus = 200; // Assuming success if data is returned
                    break;
                case 'cancelAppointment':
                    sfdResponseData = await cancelAppointment(toolArguments);
                    sfdResponseStatus = 200; // Assuming success if data is returned
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
            // If the tool call itself didn't throw an error, format its data as a success result for Vapi
            return handleSfdResponse({ status: sfdResponseStatus, data: sfdResponseData }, res, toolCallId);

        } catch (error) {
            // Catch any errors from the tool functions (e.g., network errors, SFD API errors)
            console.error(`--- [PROXY] Error during tool execution (${toolName}) ---`);
            console.error(`Full Axios Error:`, error.message);
            if (error.response) {
                console.error(`Error Response Status:`, error.response.status);
                console.error(`Error Response Data:`, error.response.data);
                console.error(`Error Response Headers:`, error.response.headers);
                // Pass the actual SFD API error status and data to handleSfdResponse
                return handleSfdResponse({ status: error.response.status, data: error.response.data }, res, toolCallId);
            } else if (error.request) {
                console.error(`Error Request (no response):`, error.request);
            } else {
                console.error(`General Error message:`, error.message);
            }
            console.error(`Error Stack:`, error.stack);
            console.error(`--- End [PROXY] Error during tool execution ---`);

            // Format proxy internal errors for Vapi
            const vapiErrorResponse = {
                results: [{
                    toolCallId: toolCallId,
                    error: `Proxy internal error during ${toolName} call: ${error.message}. Check proxy logs for more details.`.replace(/[\r\n]+/g, ' ').substring(0, 500)
                }]
            };
            return res.status(200).json(vapiErrorResponse); // Always return 200 for Vapi webhooks
        }
    } else {
        // Handle other Vapi webhook types (e.g., 'call-status', 'conversation-update')
        // Log them and return a 200 OK, as we don't need to process them for tool calls.
        console.log(`[PROXY_DISPATCH] Received unhandled Vapi webhook type: ${req.body.message ? req.body.message.type : 'unknown'}. Body: ${JSON.stringify(req.body)}`);
        return res.status(200).send('Unhandled webhook type received.');
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
