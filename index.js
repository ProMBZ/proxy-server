const express = require('express');
const axios = require('axios');
const cors = require('cors');
const qs = require('qs'); // Import qs for URL-encoded body for token requests

const app = express();
const PORT = process.env.PORT || 3000;

// Use CORS middleware
app.use(cors());
app.use(express.json()); // To parse JSON request bodies

// --- Centralized Token Storage ---
const tokenStore = {
  accessToken: null,
  refreshToken: null,
  expiresAt: null, // Unix timestamp in milliseconds when the token expires
};

// --- OAuth Configuration ---
const OAUTH_CONFIG = {
  client_id: 'betterproducts',
  client_secret: '574f1383-8d69-49b4-a6a5-e969cbc4177060acee42eb87bb0ecdbb6788a1', // Ensure this is the correct client secret
  access_token_url: 'https://sfd.co:6500/oauth2/token',
  // Initial username and password for first token acquisition
  initial_username: 'C5WH',
  initial_password: 'jaVathee123!',
};

// Define the base URL for the SFD API
const SFD_BASE_URL = 'https://sfd.co:6500/';

// --- Token Refresh Function ---
async function refreshToken(grantType = 'password') {
  console.log(`Attempting to get/refresh token using grant type: ${grantType}`);
  try {
    let requestData;
    if (grantType === 'password') {
      // For initial token acquisition (password grant)
      requestData = {
        grant_type: 'password',
        client_id: OAUTH_CONFIG.client_id,
        client_secret: OAUTH_CONFIG.client_secret,
        username: OAUTH_CONFIG.initial_username,
        password: OAUTH_CONFIG.initial_password,
      };
    } else {
      // For refreshing an existing token (refresh_token grant)
      if (!tokenStore.refreshToken) {
        throw new Error('No refresh token available for refreshing.');
      }
      requestData = {
        grant_type: 'refresh_token',
        client_id: OAUTH_CONFIG.client_id,
        client_secret: OAUTH_CONFIG.client_secret,
        refresh_token: tokenStore.refreshToken,
      };
    }

    const response = await axios.post(
      OAUTH_CONFIG.access_token_url,
      qs.stringify(requestData), // Use qs to send data as application/x-www-form-urlencoded
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const { access_token, refresh_token, expires_in } = response.data;

    if (access_token) {
      tokenStore.accessToken = access_token;
      // Calculate expiration time (current time + expires_in seconds * 1000 ms/s - buffer)
      // We subtract a buffer (e.g., 5 minutes) to refresh before actual expiration
      tokenStore.expiresAt = Date.now() + (expires_in * 1000) - (5 * 60 * 1000); // Refresh 5 mins before expiry
      if (refresh_token) {
        tokenStore.refreshToken = refresh_token; // Refresh token might also be updated
      }
      console.log('Token successfully obtained/refreshed.');
      console.log('New Access Token (first 10 chars):', tokenStore.accessToken.substring(0, 10) + '...');
      console.log('Token will expire at (approx):', new Date(tokenStore.expiresAt).toLocaleString());
      return true; // Token acquisition successful
    } else {
      console.error('Token response missing access_token:', response.data);
      return false;
    }
  } catch (error) {
    console.error('Error refreshing token:', error.response ? error.response.data : error.message);
    tokenStore.accessToken = null; // Invalidate token on error
    tokenStore.expiresAt = null;
    return false; // Token acquisition failed
  }
}

// --- Middleware to check and refresh token before each request to SFD ---
app.use('/api/*', async (req, res, next) => {
  // Check if token exists and is valid (not expired or close to expiring)
  if (!tokenStore.accessToken || Date.now() >= tokenStore.expiresAt) {
    console.log('Token missing or expired. Attempting to refresh...');
    const success = await refreshToken(tokenStore.refreshToken ? 'refresh_token' : 'password');
    if (!success) {
      console.error('Failed to obtain/refresh token. Rejecting proxy request.');
      const toolCallId = req.body.toolCallId || 'default_tool_call_id';
      return res.status(200).json({
        results: [{
          toolCallId: toolCallId,
          error: 'Proxy Error: Failed to obtain valid authentication token for SFD API.'
        }]
      });
    }
  }

  // Add the Authorization header for the SFD API request
  req.headers.authorization = `Bearer ${tokenStore.accessToken}`;
  next(); // Proceed to the proxy route handler
});

// Route to handle all incoming requests (GET, POST, etc.) to SFD API
app.all('/api/*', async (req, res) => {
    // Extract the original path after /api/
    const targetPath = req.path.substring(5); // Removes '/api/' e.g., 'appointment/books'

    // Extract only the relevant query parameters for the SFD API
    // Vapi adds its own 'url' parameter, which we need to filter out.
    const queryParams = new URLSearchParams(req.originalUrl.split('?')[1]);
    let sfdApiQueryParams = new URLSearchParams();

    // Iterate through parameters and only keep those relevant to SFD API (e.g., date, time, app_rsn_id)
    for (const [key, value] of queryParams.entries()) {
        if (key !== 'url') { // Exclude Vapi's 'url' parameter
            sfdApiQueryParams.append(key, value);
        }
    }

    const method = req.method;
    const headers = { ...req.headers };

    // Clean up headers that might cause issues with the target server
    delete headers.host;
    delete headers['if-none-match'];
    delete headers['accept-encoding'];
    // Content-Length header needs to be re-evaluated by axios if body changes or is removed for GET requests
    if (method === 'GET' || method === 'HEAD') {
      delete headers['content-length'];
      delete headers['content-type']; // No content-type for GET
    }

    // Construct the full target URL
    let fullTargetUrl = `${SFD_BASE_URL}${targetPath}`;
    if (sfdApiQueryParams.toString()) {
        fullTargetUrl += `?${sfdApiQueryParams.toString()}`;
    }

    // --- DEBUGGING LOGS AND CHECKS ---
    console.log(`--- Proxy Request Details ---`);
    console.log(`Method: ${method}`);
    console.log(`req.path: ${req.path}`);
    console.log(`req.originalUrl: ${req.originalUrl}`);
    console.log(`Calculated targetPath: ${targetPath}`);
    console.log(`SFD API Query Params: ${sfdApiQueryParams.toString()}`);
    console.log(`Constructed fullTargetUrl: ${fullTargetUrl}`);
    console.log(`Headers (to SFD):`, headers);
    console.log(`Body (to SFD):`, req.body);
    console.log(`--- End Proxy Request Details ---`);

    // Basic validation before calling Axios
    if (!fullTargetUrl || !fullTargetUrl.startsWith('http')) {
        const toolCallId = req.body.toolCallId || 'default_tool_call_id';
        const errorMessage = `Proxy URL construction error: Invalid fullTargetUrl "${fullTargetUrl}". Check source path and base URL.`;
        console.error(errorMessage);
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
            url: fullTargetUrl, // Use the carefully constructed URL
            headers: headers,
            validateStatus: function (status) {
                return status >= 200 && status < 500; // Do not throw for 4xx errors, handle them below
            }
        };

        // For GET requests, parameters are in the URL, no need for data/body
        if (method !== 'GET' && method !== 'HEAD') {
            axiosConfig.data = req.body;
        }

        const sfdResponse = await axios(axiosConfig);

        // Extract toolCallId from Vapi's request body
        const toolCallId = req.body.toolCallId || 'default_tool_call_id';

        // --- Handle 401 Unauthorized: Attempt token refresh and retry ---
        if (sfdResponse.status === 401) {
            console.warn('SFD API returned 401 Unauthorized. Attempting token refresh and retry...');
            const refreshSuccess = await refreshToken('refresh_token');
            if (refreshSuccess) {
                // Retry the original request with the new token
                console.log('Token refreshed, retrying original request...');
                req.headers.authorization = `Bearer ${tokenStore.accessToken}`; // Update header with new token
                const retrySfdResponse = await axios(axiosConfig); // Re-use original config
                return handleSfdResponse(retrySfdResponse, res, toolCallId);
            } else {
                console.error('Token refresh failed after 401. Cannot retry request.');
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

        // Handle other SFD API responses
        return handleSfdResponse(sfdResponse, res, toolCallId);

    } catch (error) {
        console.error(`--- Proxy Internal Error Catch Block ---`);
        console.error(`Full Axios Error:`, error.message);
        console.error(`Error config (if available):`, error.config);
        if (error.response) {
            console.error(`Error Response Status:`, error.response.status);
            console.error(`Error Response Data:`, error.response.data);
            console.error(`Error Response Headers:`, error.response.headers);
        } else if (error.request) {
            console.error(`Error Request:`, error.request);
        } else {
            console.error(`General Error message:`, error.message);
        }

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

// Helper function to handle SFD responses and format for Vapi
function handleSfdResponse(sfdResponse, res, toolCallId) {
    if (sfdResponse.status >= 400 || (sfdResponse.data && sfdResponse.data.error)) {
        console.error('--- SFD API Error Response ---');
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
        return res.status(200).json(vapiErrorResponse); // Always return 200 for Vapi webhooks
    }

    // If SFD API returned success, format it as Vapi result
    console.log('--- SFD API Success Response ---');
    console.log('Status:', sfdResponse.status);
    console.log('Data:', sfdResponse.data);

    const resultString = JSON.stringify(sfdResponse.data);

    const vapiSuccessResponse = {
        results: [{
            toolCallId: toolCallId,
            result: resultString.replace(/[\r\n]+/g, ' ').substring(0, 500)
        }]
    };
    return res.status(200).json(vapiSuccessResponse); // Always return 200 for Vapi webhooks
}


// A simple test endpoint for the proxy itself
app.get('/', (req, res) => {
    res.send('CORS Proxy is running.');
});

// --- Server Start and Initial Token Acquisition ---
app.listen(PORT, async () => {
    console.log(`Proxy server listening on port ${PORT}`);
    console.log('Attempting initial token acquisition...');
    const success = await refreshToken('password'); // Use 'password' grant for initial token
    if (!success) {
      console.error('Initial token acquisition failed. Proxy might not function correctly.');
    }
});