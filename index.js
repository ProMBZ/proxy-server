const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config(); // Make sure you have a .env file with PORT and SFD_AUTH_TOKEN

const app = express();
// Use process.env.PORT, and set a default if not found (Render will set it)
const port = process.env.PORT || 10000; // Render typically uses port 10000 for Node.js apps

// Explicit CORS configuration
app.use(cors({
    origin: '*', // Allow all origins (for Vapi.ai and local testing)
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type,Authorization,Accept',
    credentials: true,
    optionsSuccessStatus: 204
}));

// Middleware to parse JSON and URL-encoded bodies from incoming requests
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// A simple health check endpoint for your proxy
app.get('/', (req, res) => {
    res.status(200).send('SFD CORS Proxy is running!');
});

// Main proxy endpoint: This will catch all requests starting with /api
app.use('/api', async (req, res) => {
    const pathAfterApi = req.originalUrl.substring('/api'.length);
    const targetUrl = `https://sfd.co:6500${pathAfterApi}`;

    // Retrieve the SFD_AUTH_TOKEN from environment variables
    const SFD_AUTH_TOKEN = process.env.SFD_AUTH_TOKEN;

    if (!SFD_AUTH_TOKEN) {
        console.error("SFD_AUTH_TOKEN environment variable is not set!");
        return res.status(500).json({ error: "Server configuration error: SFD Authorization Token not found." });
    }

    console.log(`\n--- Incoming Request to Proxy ---`);
    console.log(`URL: ${req.originalUrl}`);
    console.log(`Method: ${req.method}`);
    console.log(`Incoming Headers:`, req.headers);
    console.log(`Incoming Body:`, req.body);

    // Prepare headers to be sent to the target SFD API
    const headersForSFD = {
        // !!! IMPORTANT: Add the Authorization header directly here using the token from environment variables !!!
        'Authorization': SFD_AUTH_TOKEN
    };

    // Forward other relevant headers from the client to the SFD API
    // Ensure you are not overriding the Authorization header we just set
    if (req.headers.accept) headersForSFD['Accept'] = req.headers.accept;
    if (req.headers['content-type']) headersForSFD['Content-Type'] = req.headers['content-type'];

    console.log(`--- Outgoing Request from Proxy to SFD API ---`);
    console.log(`Target URL: ${targetUrl}`);
    console.log(`Method: ${req.method}`);
    console.log(`Headers Sent to SFD:`, headersForSFD);

    try {
        const axiosConfig = {
            method: req.method,
            url: targetUrl,
            headers: headersForSFD,
            timeout: 15000,
            validateStatus: function (status) {
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
        console.log(`Headers from SFD:`, response.headers);
        console.log(`Body from SFD (snippet):`, JSON.stringify(response.data).substring(0, 500) + (JSON.stringify(response.data).length > 500 ? '...' : ''));

        // Copy all headers from the SFD API response back to the client (Vapi)
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
        if (error.response) {
            console.error('Proxy request failed (remote API error):', error.response.status, error.response.data);
            res.status(error.response.status).json({
                error: 'Proxy request failed (remote API error)',
                details: error.message,
                remoteStatus: error.response.status,
                remoteData: error.response.data
            });
        } else if (error.request) {
            console.error('Proxy request failed (axios error.request): No response received', error.message);
            res.status(504).json({ error: 'Gateway Timeout: SFD API did not respond.' });
        } else {
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