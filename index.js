const express = require('express');
const axios = require('axios');
const cors = require('cors');
const qs = require('qs'); // Required for URL-encoded body for token requests

const app = express();
const PORT = process.env.PORT || 3000; // Use Render's PORT environment variable

// Enable CORS for all origins (adjust for production if needed)
app.use(cors());
// Parse JSON request bodies
app.use(express.json());
// Parse URL-encoded request bodies (for forms, if any, though not directly used for Vapi webhooks)
app.use(express.urlencoded({ extended: false }));

// --- Centralized Token Storage ---
// This in-memory object will hold the current access token, refresh token,
// and when the access token is expected to expire.
const tokenStore = {
  accessToken: null,
  refreshToken: null,
  expiresAt: null, // Unix timestamp in milliseconds when the access token expires
};

// --- OAuth Configuration ---
// These are your credentials for the SFD API's OAuth2 server.
// client_id and client_secret are for your application.
// initial_username and initial_password are for the initial password grant flow.
const OAUTH_CONFIG = {
  client_id: 'betterproducts',
  // IMPORTANT: Ensure this client_secret is exactly correct as provided by SFD.
  client_secret: '574f1383-8d69-49b4-a6a5-e969cbc9a99a', // Confirmed from previous interactions
  access_token_url: 'https://sfd.co:6500/oauth2/token',
  initial_username: 'C5WH', // Username for initial token acquisition
  initial_password: 'jaVathee123!', // Password for initial token acquisition
};

// Define the base URL for the SFD API. All proxy requests will target this base.
const SFD_BASE_URL = 'https://sfd.co:6500/';

// --- Token Refresh Function ---
// This asynchronous function handles both initial token acquisition (password grant)
// and subsequent token refreshes (refresh_token grant).
// It updates the global `tokenStore` with the new token information.
async function refreshToken(grantType = 'password') {
  console.log(`[AUTH] Attempting to get/refresh token using grant type: ${grantType}`);
  try {
    let requestData;
    if (grantType === 'password') {
      // Data payload for the initial password grant request
      requestData = {
        grant_type: 'password',
        client_id: OAUTH_CONFIG.client_id,
        client_secret: OAUTH_CONFIG.client_secret,
        username: OAUTH_CONFIG.initial_username,
        password: OAUTH_CONFIG.initial_password,
      };
    } else {
      // Data payload for the refresh token grant request
      if (!tokenStore.refreshToken) {
        console.error('[AUTH] No refresh token available for refreshing. Must acquire a new token via password grant.');
        // Fallback to password grant if refresh token is somehow lost
        return await refreshToken('password');
      }
      requestData = {
        grant_type: 'refresh_token',
        client_id: OAUTH_CONFIG.client_id,
        client_secret: OAUTH_CONFIG.client_secret,
        refresh_token: tokenStore.refreshToken,
      };
    }

    console.log(`[AUTH] Sending token request to: ${OAUTH_CONFIG.access_token_url}`);
    // Log a partial payload for debugging, hiding sensitive credentials
    console.log('[AUTH] Request payload (partial):', {
      ...requestData,
      client_secret: '***hidden***',
      password: '***hidden***',
      refresh_token: requestData.refresh_token ? '***hidden***' : undefined
    });

    // Make the POST request to the OAuth2 token endpoint
    const response = await axios.post(
      OAUTH_CONFIG.access_token_url,
      qs.stringify(requestData), // qs.stringify converts object to application/x-www-form-urlencoded
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json' // Request JSON response
        },
      }
    );

    const { access_token, refresh_token, expires_in, token_type, scope } = response.data;

    if (access_token) {
      tokenStore.accessToken = access_token;
      // Calculate expiration time: current time + expires_in seconds * 1000 ms/s
      // Subtract a 5-minute buffer to trigger refresh proactively before actual expiry
      tokenStore.expiresAt = Date.now() + (expires_in * 1000) - (5 * 60 * 1000);
      
      // Update refresh token if a new one is provided (some OAuth servers rotate them)
      if (refresh_token) {
        tokenStore.refreshToken = refresh_token;
      }
      console.log('[AUTH] Token successfully obtained/refreshed.');
      console.log(`[AUTH] New Access Token (first 10 chars): ${tokenStore.accessToken.substring(0, 10)}...`);
      console.log(`[AUTH] Token will expire at (approx): ${new Date(tokenStore.expiresAt).toLocaleString()}`);
      return true; // Token acquisition successful
    } else {
      console.error('[AUTH] Token response missing access_token:', response.data);
      return false;
    }
  } catch (error) {
    console.error('--- [AUTH] Error in refreshToken ---');
    if (error.response) {
      // The request was made and the server responded with a status code
      console.error('[AUTH] Error Response Status:', error.response.status);
      console.error('[AUTH] Error Response Data:', error.response.data);
      console.error('[AUTH] Error Response Headers:', error.response.headers);
    } else if (error.request) {
      // The request was made but no response was received (e.g., network error, timeout)
      console.error('[AUTH] Error Request (no response received):', error.request);
      console.error('[AUTH] Error Message:', error.message); // e.g., 'Network Error', 'ETIMEDOUT'
    } else {
      // Something else happened in setting up the request that triggered an Error
      console.error('[AUTH] Error Message:', error.message);
      console.error('[AUTH] Error Code:', error.code); // e.g., 'ENOTFOUND'
    }
    console.error('[AUTH] Error Stack:', error.stack);
    console.error('--- [AUTH] End Error in refreshToken ---');

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
// 1. Ensure a valid access token is available.
// 2. Add the Authorization header to the request going to the SFD API.
app.use('/api/*', async (req, res, next) => {
  // Check if access token is missing or has expired (or is about to expire)
  if (!tokenStore.accessToken || Date.now() >= tokenStore.expiresAt) {
    console.log('[AUTH] Token missing or expired. Attempting to refresh/acquire new token...');
    // Try to refresh using refresh token if available, otherwise use password grant
    const success = await refreshToken(tokenStore.refreshToken ? 'refresh_token' : 'password');
    if (!success) {
      console.error('[AUTH] Failed to obtain/refresh token. Rejecting proxy request.');
      const toolCallId = req.body.toolCallId || 'default_tool_call_id';
      return res.status(200).json({
        results: [{
          toolCallId: toolCallId,
          error: 'Proxy Error: Failed to obtain valid authentication token for SFD API. Check proxy logs.'
        }]
      });
    }
  }

  // Add the Authorization header to the request that will be forwarded to the SFD API
  req.headers.authorization = `Bearer ${tokenStore.accessToken}`;
  next(); // Proceed to the main proxy route handler
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
  let fullTargetUrl = `${SFD_BASE_URL}${targetPath}`;
  if (sfdApiQueryParams.toString()) {
    fullTargetUrl += `?${sfdApiQueryParams.toString()}`;
  }

  // --- Debugging Logs for Proxy Request ---
  console.log(`--- [PROXY] Outgoing Request Details ---`);
  console.log(`Method: ${method}`);
  console.log(`Original Path: ${req.path}`);
  console.log(`Target URL: ${fullTargetUrl}`);
  console.log(`Headers (to SFD):`, headers);
  console.log(`Body (to SFD):`, req.body);
  console.log(`--- End [PROXY] Outgoing Request Details ---`);

  // Basic validation to ensure the constructed URL is valid
  if (!fullTargetUrl || !fullTargetUrl.startsWith('http')) {
    const toolCallId = req.body.toolCallId || 'default_tool_call_id';
    const errorMessage = `Proxy URL construction error: Invalid fullTargetUrl "${fullTargetUrl}".`;
    console.error(`[PROXY] ${errorMessage}`);
    return res.status(200).json({
      results: [{
        toolCallId: toolCallId,
        error: errorMessage.replace(/[\r\n]+/g, ' ').substring(0, 500)
      }]
    });
  }

  try {
    const axiosConfig = {
      method: method,
      url: fullTargetUrl,
      headers: headers,
      // Do not throw errors for 4xx responses; handle them explicitly in code
      validateStatus: function (status) {
        return status >= 200 && status < 500;
      }
    };

    // Attach request body for non-GET/HEAD methods
    if (method !== 'GET' && method !== 'HEAD') {
      axiosConfig.data = req.body;
    }

    const sfdResponse = await axios(axiosConfig);

    // Extract toolCallId from Vapi's request body for consistent error/success reporting
    const toolCallId = req.body.toolCallId || 'default_tool_call_id';

    // --- Handle 401 Unauthorized: Attempt token refresh and retry ---
    // If the SFD API returns 401, it means our token is invalid/expired.
    // We attempt a refresh and then retry the original request.
    if (sfdResponse.status === 401) {
      console.warn('[PROXY] SFD API returned 401 Unauthorized. Attempting token refresh and retry...');
      const refreshSuccess = await refreshToken('refresh_token'); // Try refreshing the token
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
        const errorMessage = `SFD API Error: Status 401. Token refresh failed.`;
        return res.status(200).json({
          results: [{
            toolCallId: toolCallId,
            error: errorMessage.replace(/[\r\n]+/g, ' ').substring(0, 500)
          }]
        });
      }
    }
    // --- End 401 Handling ---

    // For all other responses (2xx, 3xx, or other 4xx/5xx not handled by 401),
    // process and format them for Vapi.
    return handleSfdResponse(sfdResponse, res, toolCallId);

  } catch (error) {
    // Catch any network errors or errors from axios itself (e.g., DNS lookup failed, connection refused)
    console.error(`--- [PROXY] Internal Error Catch Block ---`);
    console.error(`Full Axios Error:`, error.message);
    console.error(`Error config (if available):`, error.config);
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
  const success = await refreshToken('password'); // Use 'password' grant for initial token
  if (!success) {
    console.error('[INIT] Initial token acquisition failed. Proxy might not function correctly.');
  }
});
