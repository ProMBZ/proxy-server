// index.js - Node.js Proxy Server for Vapi with SFD API Integration

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const qs = require('qs');

const app = express();
const PORT = process.env.PORT || 10000;

// Enable CORS for all origins (restrict in production if needed)
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Environment Variables ---
const SFD_BASE_URL = process.env.SFD_BASE_URL || 'https://sfd.co:6500';
const SFD_CLIENT_ID = process.env.SFD_CLIENT_ID || 'betterproducts';
const SFD_CLIENT_SECRET = process.env.SFD_CLIENT_SECRET || '574f1383-8d69-49b4-a6a5-e969cbc9a99a';
const INITIAL_REFRESH_TOKEN = process.env.INITIAL_REFRESH_TOKEN || '0a8f1e79fedd4c7888b8422c559e04d8ab49c875414a4f3f83f3ac76e582dd83';

// Validate environment variables
if (!SFD_CLIENT_SECRET || !INITIAL_REFRESH_TOKEN || INITIAL_REFRESH_TOKEN === 'YOUR_FRESH_REFRESH_TOKEN_HERE') {
    console.error('[INIT] Critical: Missing or invalid SFD_CLIENT_SECRET or INITIAL_REFRESH_TOKEN. Set these in Render environment variables.');
}

// --- In-Memory Token Store ---
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

    let grantType = 'refresh_token';
    let refreshTokenValue = tokenStore.refreshToken || INITIAL_REFRESH_TOKEN;

    if (!refreshTokenValue || refreshTokenValue === 'YOUR_FRESH_REFRESH_TOKEN_HERE') {
        grantType = 'password';
        console.warn('[AUTH] No valid refresh token. Falling back to password grant.');
    }

    try {
        const tokenUrl = `${SFD_BASE_URL}/oauth2/token`;
        let requestData = grantType === 'password'
            ? {
                grant_type: 'password',
                client_id: SFD_CLIENT_ID,
                client_secret: SFD_CLIENT_SECRET,
                username: 'C5WH',
                password: 'jaVathee123!',
            }
            : {
                grant_type: 'refresh_token',
                client_id: SFD_CLIENT_ID,
                client_secret: SFD_CLIENT_SECRET,
                refresh_token: refreshTokenValue,
            };

        console.log(`[AUTH] Attempting OAuth2 ${grantType} grant...`);
        console.time('[AUTH] Token Request Duration');
        const tokenResponse = await axios.post(
            tokenUrl,
            qs.stringify(requestData),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                },
                timeout: 90000,
            }
        );
        console.timeEnd('[AUTH] Token Request Duration');

        const tokenData = tokenResponse.data;
        if (tokenResponse.status === 200 && tokenData.access_token) {
            console.log('[AUTH] Token acquired. Validating...');
            console.time('[AUTH] Token Validation Duration');
            const testResponse = await axios.get(`${SFD_BASE_URL}/Practice`, {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
                validateStatus: (status) => status >= 200 && status < 500,
                timeout: 90000,
            });
            console.timeEnd('[AUTH] Token Validation Duration');

            if (testResponse.status === 200) {
                console.log('[AUTH] Token validated successfully.');
                tokenStore.accessToken = tokenData.access_token;
                tokenStore.expiresAt = Date.now() + (tokenData.expires_in * 1000) - (5 * 60 * 1000);
                if (tokenData.refresh_token) {
                    tokenStore.refreshToken = tokenData.refresh_token;
                }
                return true;
            } else {
                throw new Error(`Token validation failed: ${testResponse.status} ${testResponse.statusText}`);
            }
        } else {
            throw new Error(tokenData.error_description || 'OAuth2 grant failed.');
        }
    } catch (error) {
        console.error('[AUTH] Token acquisition failed:', error.message);
        tokenStore.accessToken = null;
        tokenStore.refreshToken = null;
        tokenStore.expiresAt = null;
        return false;
    }
}

// --- Helper: Sanitize and Truncate Strings ---
const TRUNCATION_LENGTHS = {
    surname: 10, // Conservative; adjust after testing
    forename: 10,
    title: 5,
    gender: 1, // Likely 'M' or 'F'
    address_street: 20,
    address_city: 15,
    address_county: 15,
    address_postcode: 10,
    phone_mobile: 12,
    phone_home: 12,
    phone_work: 12,
    email: 50,
};

function sanitizeAndTruncate(value, fieldName) {
    if (!value) return '';
    const maxLength = TRUNCATION_LENGTHS[fieldName] || 10;
    const str = String(value).trim().replace(/[\r\n]+/g, '');
    const truncated = str.substring(0, maxLength);
    console.log(`[SANITIZE] ${fieldName}: "${str}" -> "${truncated}" (max ${maxLength})`);
    return truncated;
}

// --- Helper: Validate DOB ---
function validateDob(dob) {
    const dobRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dob || !dobRegex.test(dob)) {
        return false;
    }
    const date = new Date(dob);
    return date instanceof Date && !isNaN(date);
}

// --- Helper: Handle SFD API Response ---
function handleSfdResponse(sfdResponse, res, toolCallId) {
    if (sfdResponse.status >= 400 || (sfdResponse.data && sfdResponse.data.error)) {
        console.error('--- [SFD API] Error Response ---');
        console.error('Status:', sfdResponse.status);
        console.error('Data:', JSON.stringify(sfdResponse.data, null, 2));
        let errorMessage = `SFD API Error: Status ${sfdResponse.status}.`;
        if (sfdResponse.data?.error?.description) {
            errorMessage += ` Description: ${sfdResponse.data.error.description}`;
        }
        return res.status(200).json({
            results: [{ toolCallId, error: errorMessage.replace(/[\r\n]+/g, ' ').substring(0, 500) }],
        });
    }

    console.log('--- [SFD API] Success Response ---');
    console.log('Status:', sfdResponse.status);
    console.log('Data:', JSON.stringify(sfdResponse.data, null, 2));
    return res.status(200).json({
        results: [{ toolCallId, result: JSON.stringify(sfdResponse.data).replace(/[\r\n]+/g, ' ').substring(0, 500) }],
    });
}

// --- Helper: Handle Proxy Errors ---
function handleProxyError(error, res, toolCallId) {
    console.error('--- [PROXY] Internal Error ---');
    console.error(`Type: ${error.name || 'Unknown'}`);
    console.error(`Message: ${error.message}`);
    if (axios.isAxiosError(error)) {
        if (error.response) {
            console.error('Response Status:', error.response.status);
            console.error('Response Data:', JSON.stringify(error.response.data, null, 2));
        } else if (error.request) {
            console.error('No response received.');
        } else {
            console.error('Request Config:', error.config);
        }
    }
    return res.status(200).json({
        results: [{
            toolCallId,
            error: `Proxy error: ${error.message}.`.replace(/[\r\n]+/g, ' ').substring(0, 500),
        }],
    });
}

// --- Middleware: Ensure Valid Token ---
app.use('/api/*', async (req, res, next) => {
    const tokenAcquired = await acquireOrRefreshToken();
    if (!tokenAcquired) {
        console.error('[MIDDLEWARE] Failed to obtain valid token.');
        return res.status(200).json({
            results: [{
                toolCallId: req.body.toolCallId || 'default_tool_call_id',
                error: 'Proxy Error: Failed to obtain valid authentication token.',
            }],
        });
    }
    req.headers.authorization = `Bearer ${tokenStore.accessToken}`;
    next();
});

// --- POST: /api/createPatient ---
app.post('/api/createPatient', async (req, res) => {
    const toolCallId = req.body.toolCallId || 'default_tool_call_id';
    console.log(`[createPatient] Received:`, JSON.stringify(req.body, null, 2));

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
        patient_title: patient_title_raw,
    } = req.body;

    // Validate required fields
    if (!surname || !forename || !dob) {
        console.error('[createPatient] Missing required fields: surname, forename, or dob');
        return res.status(200).json({
            results: [{ toolCallId, error: 'Missing required fields: surname, forename, or dob.' }],
        });
    }

    // Validate DOB
    if (!validateDob(dob)) {
        console.error('[createPatient] Invalid DOB:', dob);
        return res.status(200).json({
            results: [{ toolCallId, error: 'Invalid DOB format. Expected YYYY-MM-DD.' }],
        });
    }

    // Handle patient_title
    const patient_title = (typeof patient_title_raw === 'string' ? patient_title_raw.trim() : '') || 'Mr.';
    const sanitized_phone = patient_phone ? String(patient_phone).replace(/\D/g, '') : '';

    // Construct payload with sanitized and truncated fields
    const payload = {
        surname: sanitizeAndTruncate(surname, 'surname'),
        forename: sanitizeAndTruncate(forename, 'forename'),
        title: sanitizeAndTruncate(patient_title, 'title'),
        gender: sanitizeAndTruncate(patient_sex || '', 'gender'),
        dob,
        address: {
            street: sanitizeAndTruncate(address_street || '', 'address_street'),
            city: sanitizeAndTruncate(address_city || '', 'address_city'),
            county: sanitizeAndTruncate('', 'address_county'),
            postcode: sanitizeAndTruncate(address_postcode || '', 'address_postcode'),
        },
        phone: {
            home: sanitizeAndTruncate('', 'phone_home'),
            mobile: sanitizeAndTruncate(sanitized_phone, 'phone_mobile'),
            work: sanitizeAndTruncate('', 'phone_work'),
        },
        email: sanitizeAndTruncate(patient_email || '', 'email'),
    };

    console.log('[createPatient] Payload:', JSON.stringify(payload, null, 2));

    try {
        console.time('[createPatient] SFD API Call');
        const sfdResponse = await axios.post(
            `${SFD_BASE_URL}/patient/register`,
            payload,
            {
                headers: { Authorization: req.headers.authorization },
                timeout: 90000,
            }
        );
        console.timeEnd('[createPatient] SFD API Call');
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// --- POST: /api/searchPatient ---
app.post('/api/searchPatient', async (req, res) => {
    const toolCallId = req.body.toolCallId || 'default_tool_call_id';
    const { forename, surname, dob } = req.body;

    if (!surname || !forename || !dob || !validateDob(dob)) {
        console.error('[searchPatient] Invalid or missing parameters');
        return res.status(200).json({
            results: [{ toolCallId, error: 'Missing or invalid parameters: surname, forename, or dob.' }],
        });
    }

    try {
        const params = {
            forename: sanitizeAndTruncate(forename, 'forename'),
            surname: sanitizeAndTruncate(surname, 'surname'),
            dob,
        };
        console.log('[searchPatient] Params:', JSON.stringify(params));
        console.time('[searchPatient] SFD API Call');
        const sfdResponse = await axios.get(`${SFD_BASE_URL}/patient/search`, {
            params,
            headers: { Authorization: req.headers.authorization },
            timeout: 90000,
        });
        console.timeEnd('[searchPatient] SFD API Call');
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// --- POST: /api/getAvailableDates ---
app.post('/api/getAvailableDates', async (req, res) => {
    const toolCallId = req.body.toolCallId || 'default_tool_call_id';
    const { year, month, app_rsn_id } = req.body;

    if (!year || !month || !app_rsn_id) {
        console.error('[getAvailableDates] Missing required parameters');
        return res.status(200).json({
            results: [{ toolCallId, error: 'Missing required parameters: year, month, or app_rsn_id.' }],
        });
    }

    try {
        const params = { year, month, app_rsn_id };
        console.log('[getAvailableDates] Params:', JSON.stringify(params));
        console.time('[getAvailableDates] SFD API Call');
        const sfdResponse = await axios.get(`${SFD_BASE_URL}/appointment/dates`, {
            params,
            headers: { Authorization: req.headers.authorization },
            timeout: 90000,
        });
        console.timeEnd('[getAvailableDates] SFD API Call');
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// --- POST: /api/getAvailableTimes ---
app.post('/api/getAvailableTimes', async (req, res) => {
    const toolCallId = req.body.toolCallId || 'default_tool_call_id';
    const { date, app_rsn_id } = req.body;

    if (!date || !app_rsn_id || !validateDob(date)) {
        console.error('[getAvailableTimes] Invalid or missing parameters');
        return res.status(200).json({
            results: [{ toolCallId, error: 'Missing or invalid parameters: date or app_rsn_id.' }],
        });
    }

    try {
        const params = { date, app_rsn_id };
        console.log('[getAvailableTimes] Params:', JSON.stringify(params));
        console.time('[getAvailableTimes] SFD API Call');
        const sfdResponse = await axios.get(`${SFD_BASE_URL}/appointment/times`, {
            params,
            headers: { Authorization: req.headers.authorization },
            timeout: 90000,
        });
        console.timeEnd('[getAvailableTimes] SFD API Call');
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// --- POST: /api/reserveSlot ---
app.post('/api/reserveSlot', async (req, res) => {
    const toolCallId = req.body.toolCallId || 'default_tool_call_id';
    const { date, time, app_rsn_id, patient_id } = req.body;

    if (!date || !time || !app_rsn_id || !patient_id || !validateDob(date)) {
        console.error('[reserveSlot] Invalid or missing parameters');
        return res.status(200).json({
            results: [{ toolCallId, error: 'Missing or invalid parameters: date, time, app_rsn_id, or patient_id.' }],
        });
    }

    try {
        const payload = { date, time, app_rsn_id, patient_id };
        console.log('[reserveSlot] Payload:', JSON.stringify(payload));
        console.time('[reserveSlot] SFD API Call');
        const sfdResponse = await axios.post(
            `${SFD_BASE_URL}/appointment/reserve`,
            payload,
            {
                headers: { Authorization: req.headers.authorization },
                timeout: 90000,
            }
        );
        console.timeEnd('[reserveSlot] SFD API Call');
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// --- POST: /api/bookAppointment ---
app.post('/api/bookAppointment', async (req, res) => {
    const toolCallId = req.body.toolCallId || 'default_tool_call_id';
    const { app_rec_id, patient_id } = req.body;

    if (!app_rec_id || !patient_id) {
        console.error('[bookAppointment] Missing required parameters');
        return res.status(200).json({
            results: [{ toolCallId, error: 'Missing required parameters: app_rec_id or patient_id.' }],
        });
    }

    try {
        const payload = { app_rec_id, patient_id };
        console.log('[bookAppointment] Payload:', JSON.stringify(payload));
        console.time('[bookAppointment] SFD API Call');
        const sfdResponse = await axios.post(
            `${SFD_BASE_URL}/appointment/book`,
            payload,
            {
                headers: { Authorization: req.headers.authorization },
                timeout: 90000,
            }
        );
        console.timeEnd('[bookAppointment] SFD API Call');
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// --- POST: /api/cancelAppointment ---
app.post('/api/cancelAppointment', async (req, res) => {
    const toolCallId = req.body.toolCallId || 'default_tool_call_id';
    const { app_rec_id, app_can_id, patient_id } = req.body;

    if (!app_rec_id || !app_can_id || !patient_id) {
        console.error('[cancelAppointment] Missing required parameters');
        return res.status(200).json({
            results: [{ toolCallId, error: 'Missing required parameters: app_rec_id, app_can_id, or patient_id.' }],
        });
    }

    try {
        const payload = { app_rec_id, app_can_id, patient_id };
        console.log('[cancelAppointment] Payload:', JSON.stringify(payload));
        console.time('[cancelAppointment] SFD API Call');
        const sfdResponse = await axios.post(
            `${SFD_BASE_URL}/appointment/cancel`,
            payload,
            {
                headers: { Authorization: req.headers.authorization },
                timeout: 90000,
            }
        );
        console.timeEnd('[cancelAppointment] SFD API Call');
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// --- POST: /api/getPatientAppointments ---
app.post('/api/getPatientAppointments', async (req, res) => {
    const toolCallId = req.body.toolCallId || 'default_tool_call_id';
    const { patient_id } = req.body;

    if (!patient_id) {
        console.error('[getPatientAppointments] Missing patient_id');
        return res.status(200).json({
            results: [{ toolCallId, error: 'Missing required parameter: patient_id.' }],
        });
    }

    try {
        const params = { patient_id };
        console.log('[getPatientAppointments] Params:', JSON.stringify(params));
        console.time('[getPatientAppointments] SFD API Call');
        const sfdResponse = await axios.get(`${SFD_BASE_URL}/patient/appointments/current`, {
            params,
            headers: { Authorization: req.headers.authorization },
            timeout: 90000,
        });
        console.timeEnd('[getPatientAppointments] SFD API Call');
        return handleSfdResponse(sfdResponse, res, toolCallId);
    } catch (error) {
        return handleProxyError(error, res, toolCallId);
    }
});

// --- Test Endpoint ---
app.get('/', (req, res) => {
    res.send('CORS Proxy is running and token management is active.');
});

// --- Server Start ---
app.listen(PORT, async () => {
    console.log(`Proxy server listening on port ${PORT}`);
    console.log('[INIT] Attempting initial token acquisition...');
    const initialTokenAcquired = await acquireOrRefreshToken();
    if (!initialTokenAcquired) {
        console.error('[INIT] Initial token acquisition failed. Check SFD_CLIENT_SECRET and INITIAL_REFRESH_TOKEN.');
    }
});