const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Explicit CORS configuration
// Allow all origins, methods, and headers for simplicity, especially during debugging.
// In production, you might want to restrict 'origin' to Vapi.ai's domains.
app.use(cors({
    origin: '*', // Allow all origins
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS', // Explicitly allow all methods
    allowedHeaders: 'Content-Type,Authorization,Accept', // Explicitly allow common headers
    credentials: true, // Allow cookies/authorization headers to be sent
    optionsSuccessStatus: 204 // For OPTIONS preflight requests, send 204 No Content success
}));

// Middleware to parse JSON and URL-encoded bodies from incoming requests
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// A simple health check endpoint for your proxy
app.get('/', (req, res) => {
    res.status(200).send('SFD CORS Proxy is running!');
});

// Main proxy endpoint: This will catch all requests starting with /api
// and forward them to the SFD API.
app.use('/api', async (req, res) => {
    const pathAfterApi = req.originalUrl.substring('/api'.length);
    const targetUrl = `https://sfd.co:6500${pathAfterApi}`;

    console.log(`\n--- Incoming Request to Proxy ---`);
    console.log(`URL: ${req.originalUrl}`);
    console.log(`Method: ${req.method}`);
    console.log(`Incoming Headers:`, req.headers); // Log ALL incoming headers
    console.log(`Incoming Body:`, req.body); // Log incoming body

    // Prepare headers to be sent to the target SFD API
    const headersForSFD = {};

    // Forward relevant headers from the client to the SFD API
    if (req.headers.authorization) headersForSFD['Authorization'] = req.headers.authorization;
    if (req.headers.accept) headersForSFD['Accept'] = req.headers.accept;
    if (req.headers['content-type']) headersForSFD['Content-Type'] = req.headers['content-type'];

    // You might need to add other headers if SFD API requires them, e.g., User-Agent, X-Requested-With
    // headersForSFD['User-Agent'] = 'Custom-Vapi-Proxy/1.0'; 
    // headersForSFD['X-Requested-With'] = 'XMLHttpRequest'; // Sometimes required by APIs

    console.log(`--- Outgoing Request from Proxy to SFD API ---`);
    console.log(`Target URL: ${targetUrl}`);
    console.log(`Method: ${req.method}`);
    console.log(`Headers Sent to SFD:`, headersForSFD); // Log headers sent to SFD

    try {
        const axiosConfig = {
            method: req.method,
            url: targetUrl,
            headers: headersForSFD, // Use the prepared headers
            timeout: 15000, // 15 seconds timeout
            validateStatus: function (status) {
                // Return true for status codes that should not trigger an error (e.g., 2xx, 3xx, even 4xx if you want to handle them as non-errors)
                // This prevents Axios from throwing an error for 4xx responses, allowing us to pass them through.
                return status >= 200 && status < 500; 
            }
        };

        // For POST, PUT, PATCH, attach the request body
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            axiosConfig.data = req.body;
        }

        const response = await axios(axiosConfig);

        console.log(`--- Response Received from SFD API ---`);
        console.log(`Status from SFD: ${response.status}`);
        console.log(`Headers from SFD:`, response.headers); // Log all headers received from SFD
        console.log(`Body from SFD (snippet):`, JSON.stringify(response.data).substring(0, 500)); // Log part of the response body

        // Copy all headers from the SFD API response back to the client
        for (const headerName in response.headers) {
            // Avoid setting forbidden or irrelevant headers that Render might handle or cause issues
            if (!['set-cookie', 'origin', 'host', 'connection', 'transfer-encoding', 'content-encoding'].includes(headerName.toLowerCase())) {
                res.setHeader(headerName, response.headers[headerName]);
            }
        }

        // Set the HTTP status code from the SFD API's response and send the data
        res.status(response.status).send(response.data);

    } catch (error) {
        console.log(`\n--- Proxy Error ---`);
        // Axios errors have a structured response if it's an HTTP error
        if (error.response) {
            console.error('Proxy request failed (remote API error):', error.response.status, error.response.data);
            res.status(error.response.status).json({
                error: 'Proxy request failed (remote API error)',
                details: error.message,
                remoteStatus: error.response.status,
                remoteData: error.response.data
            });
        } else if (error.request) {
            // The request was made but no response was received (e.g., network error, timeout)
            console.error('Proxy request failed (axios error.request): No response received', error.message);
            res.status(500).json({ error: 'Proxy request failed (no response from remote API)', details: error.message });
        } else {
            // Something else happened in setting up the request that triggered an Error
            console.error('Proxy request failed (axios general error):', error.message);
            res.status(500).json({ error: 'Proxy request failed (general error)', details: error.message });
        }
        console.log(`-------------------\n`);
    }
});

// Start the Express server
app.listen(port, () => {
    console.log(`SFD CORS Proxy listening at http://localhost:${port}`);
});