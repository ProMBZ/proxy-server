const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https'); // Required for https.Agent
require('dotenv').config(); // Load environment variables from .env file

const app = express();
const port = process.env.PORT || 10000;

// --- IMPORTANT SECURITY NOTE ---
// The httpsAgent with rejectUnauthorized: false is used to bypass SSL certificate
// validation errors that might occur when connecting to the SFD API on a non-standard port
// or with a potentially untrusted certificate.
// While helpful for testing/debugging, using this in a production environment with
// untrusted endpoints is a SECURITY RISK as it makes your proxy vulnerable to man-in-the-middle attacks.
// Consider removing it or using a more secure method for production if possible.
const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});
// --- END IMPORTANT SECURITY NOTE ---

// Configure CORS for all origins, methods, and specific headers
app.use(cors({
    origin: '*', // Allows all origins. For production, restrict this to your Vapi dashboard domain.
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type,Authorization,Accept',
    credentials: true, // Allow cookies to be sent (if your SFD API uses them)
    optionsSuccessStatus: 204 // For pre-flight requests
}));

// Enable parsing of JSON request bodies
app.use(express.json());
// Enable parsing of URL-encoded request bodies
app.use(express.urlencoded({ extended: true }));

// Basic root endpoint to confirm proxy is running
app.get('/', (req, res) => {
    res.status(200).send('SFD CORS Proxy is running!');
});

// Universal proxy endpoint for all /api/* requests
app.use('/api', async (req, res) => {
    // Define the base URL of your target SFD API
    // Ensure it ends with a slash for robust concatenation
    const SFD_BASE_URL = 'https://sfd.co:6500/';

    // Extract the path after '/api', remove any leading/trailing slashes for clean concatenation
    let pathAfterApi = req.path.substring('/api'.length);
    if (pathAfterApi.startsWith('/')) {
        pathAfterApi = pathAfterApi.substring(1); // Remove leading slash
    }
    if (pathAfterApi.endsWith('/')) {
        pathAfterApi = pathAfterApi.slice(0, -1); // Remove trailing slash
    }

    // Construct the final target URL for the SFD API
    const targetUrl = `${SFD_BASE_URL}${pathAfterApi}`;

    // Log the constructed URL for debugging and verification
    console.log(`Debug: Constructed targetUrl: ${targetUrl}`);

    // Get the SFD Authorization Token from environment variables
    const SFD_AUTH_TOKEN = process.env.SFD_AUTH_TOKEN;

    // Check if the auth token is set
    if (!SFD_AUTH_TOKEN) {
        console.error("SFD_AUTH_TOKEN environment variable is not set!");
        return res.status(500).json({ error: "Server configuration error: SFD Authorization Token not found." });
    }

    // --- Incoming Request Logging ---
    console.log(`\n--- Incoming Request to Proxy ---`);
    console.log(`URL: ${req.originalUrl}`);
    console.log(`Method: ${req.method}`);
    console.log(`Incoming Headers:`, req.headers);
    console.log(`Incoming Body:`, req.body);

    // Prepare headers to send to the SFD API
    const headersForSFD = {
        'Authorization': SFD_AUTH_TOKEN // Use the bearer token from your environment
    };

    // Forward Accept and Content-Type headers if they exist in the incoming request
    if (req.headers.accept) headersForSFD['Accept'] = req.headers.accept;
    if (req.headers['content-type']) headersForSFD['Content-Type'] = req.headers['content-type'];

    // Filter out the 'url' query parameter that Vapi's test utility might add
    const paramsForSFD = { ...req.query };
    if (paramsForSFD.url) {
        delete paramsForSFD.url;
    }

    // --- Outgoing Request Logging ---
    console.log(`--- Outgoing Request from Proxy to SFD API ---`);
    console.log(`Target URL: ${targetUrl}`);
    console.log(`Method: ${req.method}`);
    console.log(`Headers Sent to SFD:`, headersForSFD);
    console.log(`Query Params Sent to SFD:`, paramsForSFD);

    try {
        // Configure the Axios request to the SFD API
        const axiosConfig = {
            method: req.method, // Use the incoming request's method (GET, POST, etc.)
            url: targetUrl,     // The correctly constructed target URL
            headers: headersForSFD, // Headers including Authorization
            params: paramsForSFD,   // Query parameters (excluding Vapi's 'url')
            timeout: 15000,     // Timeout after 15 seconds
            httpsAgent: httpsAgent, // Use the custom HTTPS agent for SSL bypass
            // Validate any status code between 200 and 499 as a success (to capture API errors)
            validateStatus: function (status) {
                return status >= 200 && status < 500;
            }
        };

        // If it's a POST, PUT, or PATCH request, include the request body
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            axiosConfig.data = req.body;
        }

        // Make the request to the SFD API
        const response = await axios(axiosConfig);

        // --- Response from SFD API Logging ---
        console.log(`--- Response Received from SFD API ---`);
        console.log(`Status from SFD: ${response.status}`);
        console.log(`Headers from SFD:`, response.headers);
        // Log a snippet of the response body to avoid excessively large logs
        console.log(`Body from SFD (snippet):`, JSON.stringify(response.data).substring(0, 500) + (JSON.stringify(response.data).length > 500 ? '...' : ''));

        // Forward relevant headers from the SFD API response back to the client
        for (const headerName in response.headers) {
            // Exclude headers that should not be forwarded or cause issues
            if (!['set-cookie', 'origin', 'host', 'connection', 'transfer-encoding', 'content-encoding'].includes(headerName.toLowerCase())) {
                res.setHeader(headerName, response.headers[headerName]);
            }
        }

        // Send the SFD API's status and data back to the client
        res.status(response.status).send(response.data);

    } catch (error) {
        // --- Proxy Error Handling and Logging ---
        console.log(`\n--- Proxy Error ---`);
        if (error.response) {
            // Error received from the remote SFD API
            console.error('Proxy request failed (remote API error):', error.response.status, error.response.data);
            res.status(error.response.status).json({
                error: 'Proxy request failed (remote API error)',
                details: error.message,
                remoteStatus: error.response.status,
                remoteData: error.response.data
            });
        } else if (error.request) {
            // Request was made but no response was received (e.g., timeout, network issue)
            console.error('Proxy request failed (axios error.request): No response received', error.message);
            res.status(504).json({ error: 'Gateway Timeout: SFD API did not respond.' });
        } else {
            // Something happened in setting up the request that triggered an Error (e.g., Invalid URL)
            console.error('Proxy request failed (axios general error):', error.message);
            console.error('Full Axios Error:', error); // Log the complete Axios error object for deeper debugging
            res.status(500).json({ error: 'Proxy request failed (general error)', details: error.message });
        }
        console.log(`-------------------\n`);
    }
});

// Start the proxy server
app.listen(port, () => {
    console.log(`SFD CORS Proxy listening at http://localhost:${port}`);
});