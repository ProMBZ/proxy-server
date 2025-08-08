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
// !!! IMPORTANT: VERIFY AND UPDATE THIS CLIENT SECRET !!!
// This value MUST match the current Client Secret provided by SFD for your Client ID.
// Ideally, set this as an environment variable on Render.com.
const SFD_CLIENT_SECRET = process.env.SFD_CLIENT_SECRET || '574f1383-8d69-49b4-a6a5-e969cbc9a99a'; 
// This initial refresh token is CRUCIAL for the first startup or after a restart
// where in-memory tokens are lost. Ensure it's a valid, long-lived refresh token.
const INITIAL_REFRESH_TOKEN = process.env.INITIAL_REFRESH_TOKEN || 'bac407898e4a4320a0245c43a42bbe5fc8d0affb76084173847e30f3d4c810cc'; // *** IMPORTANT: Replace with a real, fresh refresh token ***

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
                username: 'C5WH', // Placeholder: Replace with actual username if using password grant
                password: 'jaVathee123!', // Placeholder: Replace with actual password if using password grant
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

        console.time('[AUTH] Token Request Duration');
        const tokenResponse = await axios.post(
            tokenUrl,
            qs.stringify(requestData),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                timeout: 1800000 // Increased timeout to 30 minutes (1,800,000 milliseconds)
            }
        );
        console.timeEnd('[AUTH] Token Request Duration');

        const tokenData = tokenResponse.data;

        if (tokenResponse.status === 200 && tokenData.access_token) {
            if (tokenData.error) {
                console.error('[AUTH] OAuth2 grant failed (API error in 200 response):', tokenData.error_description || tokenData.error);
                throw new Error(tokenData.error_description || tokenData.error || 'OAuth2 grant failed with API error.');
            }

            console.log('[AUTH] OAuth2 token acquisition successful. Validating new token...');

            console.time('[AUTH] Token Validation Request Duration');
            const testResponse = await axios.get(`${SFD_BASE_URL}/Practice`, {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
                validateStatus: (status) => status >= 200 && status < 500, // Handle non-2xx status
                timeout: 1800000 // Increased timeout to 30 minutes (1,800,000 milliseconds)
            });
            console.timeEnd('[AUTH] Token Validation Request Duration');

            if (testResponse.status === 200) {
                console.log('[AUTH] New access token successfully validated.');
                tokenStore.accessToken = tokenData.access_token;
                // Set expiry time 5 minutes before actual expiry for proactive refresh
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
        // Clear tokens on failure to force re-acquisition next time
        tokenStore.accessToken = null;
        tokenStore.refreshToken = null;
        tokenStore.expiresAt = null;
        return false;
    }
}

// --- Helper function to handle SFD responses and format for Vapi ---
function handleSfdResponse(sfdResponse, res, toolCallId) {
    // Check for HTTP errors (4xx, 5xx) or explicit API errors in the response data
    if (sfdResponse.status >= 400 || (sfdResponse.data && sfdResponse.data.error)) {
        console.error('--- [SFD API] Error Response ---');
        console.error('Status:', sfdResponse.status);
        console.error('Data:', sfdResponse.data);

        let errorMessage = `SFD API Error: Status ${sfdResponse.status}.`;
        if (sfdResponse.data && typeof sfdResponse.data === 'object' && sfdResponse.data.error && sfdResponse.data.error.description) {
            errorMessage += ` Description: ${sfdResponse.data.error.description}`;
        } else if (sfdResponse.data) {
            // If data is present but not a structured error, stringify it
            errorMessage += ` Raw response: ${JSON.stringify(sfdResponse.data)}`;
        } else if (sfdResponse.statusText) {
            errorMessage += ` Status Text: ${sfdResponse.statusText}`;
        }

        // Format the error for Vapi's expected response structure
        const vapiErrorResponse = {
            results: [{
                toolCallId: toolCallId,
                error: errorMessage.replace(/[\r\n]+/g, ' ').substring(0, 500) // Sanitize and truncate error message
            }]
        };
        return res.status(200).json(vapiErrorResponse); // Always return 200 for Vapi webhooks, error is in 'error' field
    }

    console.log('--- [SFD API] Success Response ---');
    console.log('Status:', sfdResponse.status);
    console.log('Data:', sfdResponse.data);

    // Stringify the successful response data for Vapi
    const resultString = JSON.stringify(sfdResponse.data);

    // Format the success for Vapi's expected response structure
    const vapiSuccessResponse = {
        results: [{
            toolCallId: toolCallId,
            result: resultString.replace(/[\r\n]+/g, ' ').substring(0, 500) // Sanitize and truncate result
        }]
    };
    return res.status(200).json(vapiSuccessResponse);
}

// --- Middleware for all /api/* routes ---
// This middleware ensures a valid token is available before any tool endpoint is hit.
app.use('/api/*', async (req, res, next) => {
    try {
        const tokenAcquired = await acquireOrRefreshToken();
        if (!tokenAcquired) {
            console.error('[PROXY_MIDDLEWARE] Failed to obtain valid access token. Aborting request.');
            const toolCallId = req.body.toolCallId || 'default_tool_call_id'; // Fallback toolCallId
            return res.status(200).json({
                results: [{
                    toolCallId: toolCallId,
                    error: 'Proxy Error: Failed to obtain valid authentication token for SFD API. Check proxy logs. Ensure INITIAL_REFRESH_TOKEN env var is valid.'
                }]
            });
        }
        // Attach the Authorization header for the upcoming API call
        req.headers.authorization = `Bearer ${tokenStore.accessToken}`;
        next(); // Proceed to the specific tool route handler
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

// Helper function to format date to YYYY-MM-DD
function formatDateToYYYYMMDD(dateString) {
    try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) {
            console.warn(`[formatDateToYYYYMMDD] Invalid date string provided: ${dateString}. Returning original.`);
            return dateString; // Return original if invalid
        }
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    } catch (e) {
        console.error(`[formatDateToYYYYMMDD] Error formatting date "${dateString}": ${e.message}`);
        return dateString; // Fallback to original
    }
}

// --- Specific API Endpoints for each Vapi Tool ---
// Each tool has its own dedicated route to handle its specific request format.

// POST: /api/createPatient
app.post('/api/createPatient', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    console.log(`[createPatient] Received req.body:`, req.body);

    const { 
        forename, 
        surname, 
        dob, 
        patient_email, 
        patient_phone, 
        address_street, 
        address_city, 
        address_postcode, 
        patient_sex, 
    } = req.body;

    const validationErrors = [];
    if (!forename || forename.trim() === '') {
        validationErrors.push('The patient\'s first name is missing. Could you please provide it?');
    } else if (forename.length > 50) {
        validationErrors.push('The patient\'s first name is too long. Could you please provide a shorter one?');
    }
    if (!surname || surname.trim() === '') {
        validationErrors.push('The patient\'s last name is missing. Could you please provide it?');
    } else if (surname.length > 50) {
        validationErrors.push('The patient\'s last name is too long. Could you please provide a shorter one?');
    }
    if (!dob || dob.trim() === '') {
        validationErrors.push('The patient\'s date of birth is missing. Could you please provide it?');
    } else if (dob.length > 100) { 
        validationErrors.push('The patient\'s date of birth seems too long. Can you please provide it again?');
    }
    if (address_street && address_street.length > 100) {
        validationErrors.push('The street address is too long. Could you please provide a shorter one?');
    }
    if (address_city && address_city.length > 50) {
        validationErrors.push('The city name is too long. Could you please provide a shorter one?');
    }
    if (address_postcode && address_postcode.length > 10) { 
        validationErrors.push('The postcode is too long. Could you please provide a shorter one?');
    }

    if (validationErrors.length > 0) {
        console.error(`[createPatient] Data Validation Failed. Errors:`, validationErrors);
        const errorMessage = `I'm having trouble with some of the patient information. ` + validationErrors.join(' ');
        return res.status(200).json({
            results: [{
                toolCallId: toolCallId,
                error: errorMessage
            }]
        });
    }

    let patient_title_raw = req.body.patient_title || req.body['patient_title\n'];
    let patient_title = (typeof patient_title_raw === 'string' ? patient_title_raw.trim() : '');
    if (patient_title === '') {
        patient_title = 'Mr.'; 
    }

    const sanitized_patient_phone = patient_phone ? String(patient_phone).replace(/\D/g, '') : '';
    const formatted_dob = formatDateToYYYYMMDD(dob);

    try {
        const payload = {
            surname: surname || '', 
            forename: forename || '', 
            title: patient_title, 
            gender: patient_sex || '', 
            dob: formatted_dob, 
            address: { 
                street: address_street || '', 
                city: address_city || '', 
                county: '', 
                postcode: address_postcode || '' 
            },
            phone: { 
                home: '', 
                mobile: sanitized_patient_phone, 
                work: '' 
            },
            email: patient_email || '' 
        };

        console.log(`[createPatient] Final Payload to SFD API:`, JSON.stringify(payload));
        console.time('[createPatient] SFD API Call Duration');
        const sfdResponse = await axios.post(`${SFD_BASE_URL}/patient/register`, 
            payload,
            { 
                headers: { Authorization: req.headers.authorization },
                timeout: 1800000 
            }
        );
        console.timeEnd('[createPatient] SFD API Call Duration');
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        console.error('[createPatient] Caught an error in the try block.');
        return handleProxyError(error, res, toolCallId);
    }
});

// POST: /api/searchPatient
app.post('/api/searchPatient', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const { forename, surname, dob } = req.body;
    
    // --- New: Added validation for this endpoint ---
    const validationErrors = [];
    if (!forename || forename.trim() === '') {
        validationErrors.push('The patient\'s first name is missing.');
    }
    if (!surname || surname.trim() === '') {
        validationErrors.push('The patient\'s last name is missing.');
    }
    if (!dob || dob.trim() === '') {
        validationErrors.push('The patient\'s date of birth is missing.');
    }

    if (validationErrors.length > 0) {
        console.error(`[searchPatient] Data Validation Failed. Errors:`, validationErrors);
        const errorMessage = `I'm missing some required information to search for the patient. ` + validationErrors.join(' ');
        return res.status(200).json({
            results: [{
                toolCallId: toolCallId,
                error: errorMessage
            }]
        });
    }

    try {
        const params = { 
            forename: forename || '', 
            surname: surname || '', 
            dob: formatDateToYYYYMMDD(dob) 
        };
        console.log(`[searchPatient] Sending to SFD API (${SFD_BASE_URL}/patient/search) with params:`, JSON.stringify(params));
        console.time('[searchPatient] SFD API Call Duration');
        const sfdResponse = await axios.get(`${SFD_BASE_URL}/patient/search`, {
            params: params, 
            headers: { Authorization: req.headers.authorization },
            timeout: 1800000 
        });
        console.timeEnd('[searchPatient] SFD API Call Duration');
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// POST: /api/getAvailableDates
app.post('/api/getAvailableDates', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const { year, month, app_rsn_id } = req.body;
    
    // --- New: Added validation for this endpoint ---
    const validationErrors = [];
    if (!year || isNaN(parseInt(year, 10))) {
        validationErrors.push('The year is missing or not a valid number.');
    }
    if (!month || isNaN(parseInt(month, 10))) {
        validationErrors.push('The month is missing or not a valid number.');
    }
    if (!app_rsn_id) {
        validationErrors.push('The appointment reason ID is missing.');
    }

    if (validationErrors.length > 0) {
        console.error(`[getAvailableDates] Data Validation Failed. Errors:`, validationErrors);
        const errorMessage = `I'm missing some required information to find available dates. ` + validationErrors.join(' ');
        return res.status(200).json({
            results: [{
                toolCallId: toolCallId,
                error: errorMessage
            }]
        });
    }

    try {
        const params = { 
            year: year || '', 
            month: month || '', 
            app_rsn_id: app_rsn_id || '' 
        };
        console.log(`[getAvailableDates] Sending to SFD API (${SFD_BASE_URL}/appointment/dates) with params:`, JSON.stringify(params));
        console.time('[getAvailableDates] SFD API Call Duration');
        const sfdResponse = await axios.get(`${SFD_BASE_URL}/appointment/dates`, {
            params: params,
            headers: { Authorization: req.headers.authorization },
            timeout: 1800000 
        });
        console.timeEnd('[getAvailableDates] SFD API Call Duration');
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// POST: /api/getAvailableTimes
app.post('/api/getAvailableTimes', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const { date, app_rsn_id } = req.body;
    
    // --- New: Added validation for this endpoint ---
    const validationErrors = [];
    if (!date || date.trim() === '') {
        validationErrors.push('The appointment date is missing.');
    }
    if (!app_rsn_id) {
        validationErrors.push('The appointment reason ID is missing.');
    }

    if (validationErrors.length > 0) {
        console.error(`[getAvailableTimes] Data Validation Failed. Errors:`, validationErrors);
        const errorMessage = `I'm missing some required information to find available times. ` + validationErrors.join(' ');
        return res.status(200).json({
            results: [{
                toolCallId: toolCallId,
                error: errorMessage
            }]
        });
    }

    try {
        const params = { 
            date: formatDateToYYYYMMDD(date), 
            app_rsn_id: app_rsn_id || '' 
        };
        console.log(`[getAvailableTimes] Sending to SFD API (${SFD_BASE_URL}/appointment/times) with params:`, JSON.stringify(params));
        console.time('[getAvailableTimes] SFD API Call Duration');
        const sfdResponse = await axios.get(`${SFD_BASE_URL}/appointment/times`, {
            params: params,
            headers: { Authorization: req.headers.authorization },
            timeout: 1800000 
        });
        console.timeEnd('[getAvailableTimes] SFD API Call Duration');
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// POST: /api/reserveSlot
app.post('/api/reserveSlot', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const { date, time, app_rsn_id, patient_id } = req.body;

    // --- New: Added validation for this endpoint ---
    const validationErrors = [];
    if (!date || date.trim() === '') {
        validationErrors.push('The appointment date is missing.');
    }
    if (!time || time.trim() === '') {
        validationErrors.push('The appointment time is missing.');
    }
    if (!app_rsn_id) {
        validationErrors.push('The appointment reason ID is missing.');
    }
    if (!patient_id) {
        validationErrors.push('The patient ID is missing.');
    }
    
    if (validationErrors.length > 0) {
        console.error(`[reserveSlot] Data Validation Failed. Errors:`, validationErrors);
        const errorMessage = `I'm missing some required information to reserve the slot. ` + validationErrors.join(' ');
        return res.status(200).json({
            results: [{
                toolCallId: toolCallId,
                error: errorMessage
            }]
        });
    }

    try {
        const payload = { 
            date: formatDateToYYYYMMDD(date), 
            time: time || '', 
            app_rsn_id: app_rsn_id || '', 
            patient_id: patient_id || '' 
        };
        console.log(`[reserveSlot] Sending to SFD API (${SFD_BASE_URL}/appointment/reserve) with payload:`, JSON.stringify(payload));
        console.time('[reserveSlot] SFD API Call Duration');
        const sfdResponse = await axios.post(`${SFD_BASE_URL}/appointment/reserve`, 
            payload,
            { 
                headers: { Authorization: req.headers.authorization },
                timeout: 1800000 
            }
        );
        console.timeEnd('[reserveSlot] SFD API Call Duration');
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// POST: /api/bookAppointment
app.post('/api/bookAppointment', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const { app_rec_id, patient_id } = req.body;

    // --- New: Added validation for this endpoint ---
    const validationErrors = [];
    if (!app_rec_id) {
        validationErrors.push('The appointment record ID is missing.');
    }
    if (!patient_id) {
        validationErrors.push('The patient ID is missing.');
    }

    if (validationErrors.length > 0) {
        console.error(`[bookAppointment] Data Validation Failed. Errors:`, validationErrors);
        const errorMessage = `I'm missing some required information to book the appointment. ` + validationErrors.join(' ');
        return res.status(200).json({
            results: [{
                toolCallId: toolCallId,
                error: errorMessage
            }]
        });
    }

    try {
        const payload = { 
            app_rec_id: app_rec_id || '', 
            patient_id: patient_id || '' 
        };
        console.log(`[bookAppointment] Sending to SFD API (${SFD_BASE_URL}/appointment/book) with payload:`, JSON.stringify(payload));
        console.time('[bookAppointment] SFD API Call Duration');
        const sfdResponse = await axios.post(`${SFD_BASE_URL}/appointment/book`, 
            payload,
            { 
                headers: { Authorization: req.headers.authorization },
                timeout: 1800000 
            }
        );
        console.timeEnd('[bookAppointment] SFD API Call Duration');
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// POST: /api/cancelAppointment
app.post('/api/cancelAppointment', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const { app_rec_id, app_can_id, patient_id } = req.body;
    
    // --- New: Added validation for this endpoint ---
    const validationErrors = [];
    if (!app_rec_id) {
        validationErrors.push('The appointment record ID is missing.');
    }
    if (!app_can_id) {
        validationErrors.push('The cancellation reason ID is missing.');
    }
    if (!patient_id) {
        validationErrors.push('The patient ID is missing.');
    }

    if (validationErrors.length > 0) {
        console.error(`[cancelAppointment] Data Validation Failed. Errors:`, validationErrors);
        const errorMessage = `I'm missing some required information to cancel the appointment. ` + validationErrors.join(' ');
        return res.status(200).json({
            results: [{
                toolCallId: toolCallId,
                error: errorMessage
            }]
        });
    }

    try {
        const payload = { 
            app_rec_id: app_rec_id || '', 
            app_can_id: app_can_id || '', 
            patient_id: patient_id || '' 
        };
        console.log(`[cancelAppointment] Sending to SFD API (${SFD_BASE_URL}/appointment/cancel) with payload:`, JSON.stringify(payload));
        console.time('[cancelAppointment] SFD API Call Duration');
        const sfdResponse = await axios.post(`${SFD_BASE_URL}/appointment/cancel`, 
            payload,
            { 
                headers: { Authorization: req.headers.authorization },
                timeout: 1800000 
            }
        );
        console.timeEnd('[cancelAppointment] SFD API Call Duration');
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// POST: /api/getPatientAppointments
app.post('/api/getPatientAppointments', async (req, res) => {
    const toolCallId = req.body.toolCallId;
    const { patient_id } = req.body;
    
    // --- New: Added validation for this endpoint ---
    if (!patient_id) {
        console.error(`[getPatientAppointments] Data Validation Failed: patient_id is missing.`);
        const errorMessage = 'I need the patient ID to look up their appointments. Could you please provide it?';
        return res.status(200).json({
            results: [{
                toolCallId: toolCallId,
                error: errorMessage
            }]
        });
    }

    try {
        const params = { patient_id: patient_id || '' };
        console.log(`[getPatientAppointments] Sending to SFD API (${SFD_BASE_URL}/patient/appointments/current) with params:`, JSON.stringify(params));
        console.time('[getPatientAppointments] SFD API Call Duration');
        const sfdResponse = await axios.get(`${SFD_BASE_URL}/patient/appointments/current`, {
            params: params,
            headers: { Authorization: req.headers.authorization },
            timeout: 1800000 
        });
        console.timeEnd('[getPatientAppointments] SFD API Call Duration');
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// --- Simple Test Endpoint for Proxy Status ---
// You can visit this URL directly in your browser to check if the proxy server is running.
app.get('/', (req, res) => {
    res.send('CORS Proxy is running and token management is active.');
});

// --- Helper function for cleaner error handling in routes ---
function handleProxyError(error, res, toolCallId) {
    console.error(`--- [PROXY] Internal Error Catch Block ---`);
    console.error(`Error Type: ${error.name || 'Unknown'}`);
    console.error(`Error Message:`, error.message);
    if (error.code === 'ECONNABORTED') {
        console.error('This was a timeout error. The request took too long to complete.');
    }
    if (axios.isAxiosError(error)) {
        if (error.response) {
            console.error(`Error Response Status:`, error.response.status);
            console.error(`Error Response Data:`, error.response.data);
            console.error(`Error Response Headers:`, error.response.headers);
        } else if (error.request) {
            console.error('Error Request: The request was made but no response was received.');
            console.error('Request details:', error.request);
        } else {
            console.error('Error Config:', error.config);
        }
    } else {
        console.error('Non-Axios Error:', error);
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
