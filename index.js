const express = require('express');
const axios = require('axios');
const cors = require('cors');
const qs = require('qs');
const axiosRetry = require('axios-retry');

const app = express();
const PORT = process.env.PORT || 10000;

// Enable CORS (restrict origins in production)
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// --- Environment Variables ---
const SFD_BASE_URL = process.env.SFD_BASE_URL || 'https://sfd.co:6500';
const SFD_CLIENT_ID = process.env.SFD_CLIENT_ID || 'betterproducts';
const SFD_CLIENT_SECRET = process.env.SFD_CLIENT_SECRET || '574f1383-8d69-49b4-a6a5-e969cbc9a99a';
const INITIAL_REFRESH_TOKEN = process.env.INITIAL_REFRESH_TOKEN || 'bac407898e4a4320a0245c43a42bbe5fc8d0affb76084173847e30f3d4c810cc';

// --- Configure Axios Retry ---
axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => retryCount * 1000,
  retryCondition: (error) => axiosRetry.isNetworkOrIdempotentRequestError(error) || (error.response && error.response.status >= 500),
});

// --- In-Memory Token Store ---
let tokenStore = {
  accessToken: null,
  refreshToken: null,
  expiresAt: null,
};

// --- Token Acquisition/Refresh Logic ---
async function acquireOrRefreshToken(forceRefresh = false) {
  console.log('[AUTH] Attempting to acquire or refresh access token...');
  if (
    tokenStore.accessToken &&
    tokenStore.expiresAt &&
    Date.now() < tokenStore.expiresAt - 5 * 60 * 1000 &&
    !forceRefresh
  ) {
    console.log('[AUTH] Using valid access token from cache.');
    return true;
  }

  let grantTypeToUse = 'refresh_token';
  let refreshTokenValue = tokenStore.refreshToken || INITIAL_REFRESH_TOKEN;

  if (!refreshTokenValue || refreshTokenValue === 'YOUR_FRESH_REFRESH_TOKEN_HERE') {
    console.warn('[AUTH] No valid refresh token. Falling back to password grant.');
    grantTypeToUse = 'password';
  }

  try {
    const tokenUrl = `${SFD_BASE_URL}/oauth2/token`;
    let requestData = grantTypeToUse === 'password'
      ? {
          grant_type: 'password',
          client_id: SFD_CLIENT_ID,
          client_secret: SFD_CLIENT_SECRET,
          username: 'C5WH', // Replace with actual username
          password: 'jaVathee123!', // Replace with actual password
        }
      : {
          grant_type: 'refresh_token',
          client_id: SFD_CLIENT_ID,
          client_secret: SFD_CLIENT_SECRET,
          refresh_token: refreshTokenValue,
        };

    console.log(`[AUTH] Attempting ${grantTypeToUse} grant...`);
    console.time('[AUTH] Token Request');
    const tokenResponse = await axios.post(tokenUrl, qs.stringify(requestData), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      timeout: 10000,
    });
    console.timeEnd('[AUTH] Token Request');

    const tokenData = tokenResponse.data;

    if (tokenResponse.status === 200 && tokenData.access_token) {
      console.log('[AUTH] Validating new access token...');
      console.time('[AUTH] Token Validation');
      const testResponse = await axios.get(`${SFD_BASE_URL}/Practice`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
        timeout: 10000,
      });
      console.timeEnd('[AUTH] Token Validation');

      if (testResponse.status === 200) {
        tokenStore.accessToken = tokenData.access_token;
        tokenStore.expiresAt = Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000;
        if (tokenData.refresh_token) tokenStore.refreshToken = tokenData.refresh_token;
        console.log('[AUTH] Token acquisition successful.');
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

// --- Handle SFD API Response ---
function handleSfdResponse(sfdResponse, res, toolCallId) {
  if (sfdResponse.status >= 400 || (sfdResponse.data && sfdResponse.data.error)) {
    console.error('[SFD API] Error:', sfdResponse.status, sfdResponse.data);
    let errorMessage = `SFD API Error: Status ${sfdResponse.status}.`;
    if (sfdResponse.data?.error?.description) {
      errorMessage += ` ${sfdResponse.data.error.description}`;
      if (sfdResponse.data.error.description.includes('string right truncation')) {
        errorMessage += ' (One or more fields are too long: check first name, last name, address, or email length.)';
      }
    } else if (sfdResponse.data) {
      errorMessage += ` Response: ${JSON.stringify(sfdResponse.data).substring(0, 200)}`;
    }
    return res.status(200).json({
      results: [{ toolCallId, error: errorMessage.substring(0, 500) }],
    });
  }

  console.log('[SFD API] Success:', sfdResponse.status, sfdResponse.data);
  return res.status(200).json({
    results: [{ toolCallId, result: JSON.stringify(sfdResponse.data).substring(0, 500) }],
  });
}

// --- Handle Proxy Errors ---
function handleProxyError(error, res, toolCallId) {
  console.error('[PROXY] Error:', error.name, error.message);
  if (error.code === 'ECONNABORTED') {
    console.error('Timeout: SFD API did not respond within 10 seconds.');
  }
  if (axios.isAxiosError(error)) {
    console.error('Response:', error.response?.status, error.response?.data);
  }

  return res.status(200).json({
    results: [{
      toolCallId,
      error: `Proxy error: ${error.message || 'Unknown error'}. Check logs for details.`.substring(0, 500),
    }],
  });
}

// --- Date Formatting ---
function formatDateToYYYYMMDD(dateString) {
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  } catch (e) {
    console.error(`[formatDate] Error: ${dateString}`, e.message);
    return dateString;
  }
}

// --- Validation Helper ---
function validateFields(fields, data, maxLengths = {}) {
  const errors = [];
  for (const [field, label] of Object.entries(fields)) {
    if (!data[field] || data[field].trim() === '') {
      errors.push(`${label} is required.`);
    } else if (maxLengths[field] && data[field].trim().length > maxLengths[field]) {
      errors.push(`${label} is too long (max ${maxLengths[field]} characters).`);
    }
  }
  return errors;
}

// --- Middleware for Token Validation ---
app.use('/api/*', async (req, res, next) => {
  const tokenAcquired = await acquireOrRefreshToken();
  if (!tokenAcquired) {
    return res.status(200).json({
      results: [{
        toolCallId: req.body.toolCallId || 'default_tool_call_id',
        error: 'Failed to obtain valid token. Check INITIAL_REFRESH_TOKEN.',
      }],
    });
  }
  req.headers.authorization = `Bearer ${tokenStore.accessToken}`;
  next();
});

// --- API Endpoints ---
app.post('/api/createPatient', async (req, res) => {
  const toolCallId = req.body.toolCallId;
  const {
    forename, surname, dob, patient_email, patient_phone,
    address_street, address_city, address_postcode, patient_sex, patient_title,
  } = req.body;

  // Stricter length limits to prevent string truncation
  const maxLengths = {
    forename: 30,
    surname: 30,
    dob: 10,
    address_street: 50,
    address_city: 30,
    address_postcode: 10,
    patient_sex: 6,
    patient_email: 50,
    patient_phone: 15,
    patient_title: 10,
  };

  const errors = validateFields(
    { forename: 'First name', surname: 'Last name', dob: 'Date of birth' },
    req.body,
    maxLengths
  );

  // Validate optional fields
  if (patient_email && patient_email.trim().length > maxLengths.patient_email) {
    errors.push(`Email is too long (max ${maxLengths.patient_email} characters).`);
  }
  if (patient_phone && patient_phone.trim().length > maxLengths.patient_phone) {
    errors.push(`Phone number is too long (max ${maxLengths.patient_phone} characters).`);
  }
  if (patient_title && patient_title.trim().length > maxLengths.patient_title) {
    errors.push(`Title is too long (max ${maxLengths.patient_title} characters).`);
  }

  if (errors.length > 0) {
    console.log('[createPatient] Validation Errors:', errors);
    return res.status(200).json({
      results: [{ toolCallId, error: `Invalid input: ${errors.join(' ')}` }],
    });
  }

  const sfdGender = patient_sex
    ? patient_sex.toLowerCase().startsWith('f') ? 'F'
    : patient_sex.toLowerCase().startsWith('m') ? 'M' : 'O'
    : '';
  const sanitizedPhone = patient_phone ? String(patient_phone).replace(/\D/g, '') : '';
  const formattedDob = formatDateToYYYYMMDD(dob);

  try {
    const payload = {
      surname: surname.trim(),
      forename: forename.trim(),
      title: patient_title?.trim() || 'Mr.',
      gender: sfdGender,
      dob: formattedDob,
      address: {
        street: address_street?.trim() || '',
        city: address_city?.trim() || '',
        county: '',
        postcode: address_postcode?.trim() || '',
      },
      phone: { home: '', mobile: sanitizedPhone, work: '' },
      email: patient_email?.trim() || '',
    };

    console.log('[createPatient] Payload:', payload);
    console.time('[createPatient] SFD API');
    const sfdResponse = await axios.post(`${SFD_BASE_URL}/patient/register`, payload, {
      headers: { Authorization: req.headers.authorization },
      timeout: 10000,
    });
    console.timeEnd('[createPatient] SFD API');
    return handleSfdResponse(sfdResponse, res, toolCallId);
  } catch (error) {
    return handleProxyError(error, res, toolCallId);
  }
});

app.post('/api/searchPatient', async (req, res) => {
  const toolCallId = req.body.toolCallId;
  const { forename, surname, dob } = req.body;

  const maxLengths = { forename: 30, surname: 30, dob: 10 };
  const errors = validateFields(
    { forename: 'First name', surname: 'Last name', dob: 'Date of birth' },
    req.body,
    maxLengths
  );

  if (errors.length > 0) {
    return res.status(200).json({
      results: [{ toolCallId, error: `Invalid input: ${errors.join(' ')}` }],
    });
  }

  try {
    const params = { forename: forename.trim(), surname: surname.trim(), dob: formatDateToYYYYMMDD(dob) };
    console.log('[searchPatient] Params:', params);
    console.time('[searchPatient] SFD API');
    const sfdResponse = await axios.get(`${SFD_BASE_URL}/patient/search`, {
      params,
      headers: { Authorization: req.headers.authorization },
      timeout: 10000,
    });
    console.timeEnd('[searchPatient] SFD API');
    return handleSfdResponse(sfdResponse, res, toolCallId);
  } catch (error) {
    return handleProxyError(error, res, toolCallId);
  }
});

app.post('/api/getAvailableDates', async (req, res) => {
  const toolCallId = req.body.toolCallId;
  const { year, month, app_rsn_id } = req.body;

  const errors = validateFields(
    { year: 'Year', month: 'Month', app_rsn_id: 'Appointment reason ID' },
    req.body
  );
  if (year && isNaN(parseInt(year, 10))) errors.push('Year must be a valid number.');
  if (month && isNaN(parseInt(month, 10))) errors.push('Month must be a valid number.');

  if (errors.length > 0) {
    return res.status(200).json({
      results: [{ toolCallId, error: `Invalid input: ${errors.join(' ')}` }],
    });
  }

  try {
    const params = { year, month, app_rsn_id };
    console.log('[getAvailableDates] Params:', params);
    console.time('[getAvailableDates] SFD API');
    const sfdResponse = await axios.get(`${SFD_BASE_URL}/appointment/dates`, {
      params,
      headers: { Authorization: req.headers.authorization },
      timeout: 10000,
    });
    console.timeEnd('[getAvailableDates] SFD API');
    return handleSfdResponse(sfdResponse, res, toolCallId);
  } catch (error) {
    return handleProxyError(error, res, toolCallId);
  }
});

app.post('/api/getAvailableTimes', async (req, res) => {
  const toolCallId = req.body.toolCallId;
  const { date, app_rsn_id } = req.body;

  const errors = validateFields(
    { date: 'Date', app_rsn_id: 'Appointment reason ID' },
    req.body
  );

  if (errors.length > 0) {
    return res.status(200).json({
      results: [{ toolCallId, error: `Invalid input: ${errors.join(' ')}` }],
    });
  }

  try {
    const params = { date: formatDateToYYYYMMDD(date), app_rsn_id };
    console.log('[getAvailableTimes] Params:', params);
    console.time('[getAvailableTimes] SFD API');
    const sfdResponse = await axios.get(`${SFD_BASE_URL}/appointment/times`, {
      params,
      headers: { Authorization: req.headers.authorization },
      timeout: 10000,
    });
    console.timeEnd('[getAvailableTimes] SFD API');
    return handleSfdResponse(sfdResponse, res, toolCallId);
  } catch (error) {
    return handleProxyError(error, res, toolCallId);
  }
});

// New route to handle GET requests for all users
// This is a placeholder and returns mock data, but it solves the "Cannot GET /api/Users" error.
app.get('/api/Users', async (req, res) => {
  console.log('[getUsers] GET request received.');
  // In a real application, you would fetch this data from a database.
  // For now, we'll return a mock list of users.
  const mockUsers = [
    { id: 1, name: 'John Doe', email: 'john.doe@example.com' },
    { id: 2, name: 'Jane Smith', email: 'jane.smith@example.com' },
    { id: 3, name: 'Peter Jones', email: 'peter.jones@example.com' },
  ];

  try {
    // Simulate a successful response
    res.status(200).json(mockUsers);
  } catch (error) {
    // Handle any potential errors during the process
    console.error('Error fetching mock users:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/getAvailableBooks', async (req, res) => {
  const toolCallId = req.body.toolCallId;
  const { date, app_rsn_id } = req.body;

  const errors = validateFields(
    { date: 'Date', app_rsn_id: 'Appointment reason ID' },
    req.body
  );

  if (errors.length > 0) {
    return res.status(200).json({
      results: [{ toolCallId, error: `Invalid input: ${errors.join(' ')}` }],
    });
  }

  try {
    const params = { date: formatDateToYYYYMMDD(date), app_rsn_id };
    console.log('[getAvailableBooks] Params:', params);
    console.time('[getAvailableBooks] SFD API');
    const sfdResponse = await axios.get(`${SFD_BASE_URL}/appointment/books`, {
      params,
      headers: { Authorization: req.headers.authorization },
      timeout: 10000,
    });
    console.timeEnd('[getAvailableBooks] SFD API');
    return handleSfdResponse(sfdResponse, res, toolCallId);
  } catch (error) {
    return handleProxyError(error, res, toolCallId);
  }
});

app.post('/api/reserveSlot', async (req, res) => {
  const toolCallId = req.body.toolCallId;
  const { date, time, app_rsn_id, patient_id } = req.body;

  const errors = validateFields(
    { date: 'Date', time: 'Time', app_rsn_id: 'Appointment reason ID', patient_id: 'Patient ID' },
    req.body
  );

  if (errors.length > 0) {
    return res.status(200).json({
      results: [{ toolCallId, error: `Invalid input: ${errors.join(' ')}` }],
    });
  }

  try {
    const payload = { date: formatDateToYYYYMMDD(date), time, app_rsn_id, patient_id };
    console.log('[reserveSlot] Payload:', payload);
    console.time('[reserveSlot] SFD API');
    const sfdResponse = await axios.post(`${SFD_BASE_URL}/appointment/reserve`, payload, {
      headers: { Authorization: req.headers.authorization },
      timeout: 10000,
    });
    console.timeEnd('[reserveSlot] SFD API');
    return handleSfdResponse(sfdResponse, res, toolCallId);
  } catch (error) {
    return handleProxyError(error, res, toolCallId);
  }
});

app.post('/api/bookAppointment', async (req, res) => {
  const toolCallId = req.body.toolCallId;
  const { app_rec_id, patient_id } = req.body;

  const errors = validateFields(
    { app_rec_id: 'Appointment record ID', patient_id: 'Patient ID' },
    req.body
  );

  if (errors.length > 0) {
    return res.status(200).json({
      results: [{ toolCallId, error: `Invalid input: ${errors.join(' ')}` }],
    });
  }

  try {
    const payload = { app_rec_id, patient_id };
    console.log('[bookAppointment] Payload:', payload);
    console.time('[bookAppointment] SFD API');
    const sfdResponse = await axios.post(`${SFD_BASE_URL}/appointment/book`, payload, {
      headers: { Authorization: req.headers.authorization },
      timeout: 10000,
    });
    console.timeEnd('[bookAppointment] SFD API');
    return handleSfdResponse(sfdResponse, res, toolCallId);
  } catch (error) {
    return handleProxyError(error, res, toolCallId);
  }
});

app.post('/api/cancelAppointment', async (req, res) => {
  const toolCallId = req.body.toolCallId;
  const { app_rec_id, app_can_id, patient_id } = req.body;

  const errors = validateFields(
    { app_rec_id: 'Appointment record ID', app_can_id: 'Cancellation reason ID', patient_id: 'Patient ID' },
    req.body
  );

  if (errors.length > 0) {
    return res.status(200).json({
      results: [{ toolCallId, error: `Invalid input: ${errors.join(' ')}` }],
    });
  }

  try {
    const payload = { app_rec_id, app_can_id, patient_id };
    console.log('[cancelAppointment] Payload:', payload);
    console.time('[cancelAppointment] SFD API');
    const sfdResponse = await axios.post(`${SFD_BASE_URL}/appointment/cancel`, payload, {
      headers: { Authorization: req.headers.authorization },
      timeout: 10000,
    });
    console.timeEnd('[cancelAppointment] SFD API');
    return handleSfdResponse(sfdResponse, res, toolCallId);
  } catch (error) {
    return handleProxyError(error, res, toolCallId);
  }
});

app.post('/api/getPatientAppointments', async (req, res) => {
  const toolCallId = req.body.toolCallId;
  const { patient_id } = req.body;

  const errors = validateFields({ patient_id: 'Patient ID' }, req.body);

  if (errors.length > 0) {
    return res.status(200).json({
      results: [{ toolCallId, error: `Invalid input: ${errors.join(' ')}` }],
    });
  }

  try {
    const params = { patient_id };
    console.log('[getPatientAppointments] Params:', params);
    console.time('[getPatientAppointments] SFD API');
    const sfdResponse = await axios.get(`${SFD_BASE_URL}/patient/appointments/current`, {
      params,
      headers: { Authorization: req.headers.authorization },
      timeout: 10000,
    });
    console.timeEnd('[getPatientAppointments] SFD API');
    return handleSfdResponse(sfdResponse, res, toolCallId);
  } catch (error) {
    return handleProxyError(error, res, toolCallId);
  }
});

// --- Health Check Endpoint ---
app.get('/health', async (req, res) => {
  try {
    const tokenAcquired = await acquireOrRefreshToken();
    if (!tokenAcquired) {
      return res.status(500).json({ status: 'error', message: 'Failed to acquire token.' });
    }
    await axios.get(`${SFD_BASE_URL}/Practice`, {
      headers: { Authorization: `Bearer ${tokenStore.accessToken}` },
      timeout: 5000,
    });
    res.json({ status: 'ok', message: 'Proxy and SFD API are operational.' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: `Health check failed: ${error.message}` });
  }
});

app.get('/', (req, res) => {
  res.send('CORS Proxy is running.');
});

// --- Server Start ---
app.listen(PORT, async () => {
  console.log(`Proxy server listening on port ${PORT}`);
  const initialTokenAcquired = await acquireOrRefreshToken();
  if (!initialTokenAcquired) {
    console.error('[INIT] Initial token acquisition failed. Check INITIAL_REFRESH_TOKEN and SFD_BASE_URL.');
  }
});
