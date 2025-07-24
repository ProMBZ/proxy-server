const express = require('express');
const cors = require('cors');
const axios = require('axios'); // Changed from node-fetch to axios
require('dotenv').config();

const app = express();
// Render will provide the PORT as an environment variable, otherwise use 3000 for local development
const port = process.env.PORT || 3000; 

// Configure CORS for your proxy to allow requests from any origin (or specific origins like Vapi.ai)
app.use(cors());

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
    // req.originalUrl will be something like "/api/appointment/books?date=..."
    // We want to extract "appointment/books?date=..." to append to the target API base URL.
    const pathAfterApi = req.originalUrl.substring('/api'.length);
    const targetUrl = `https://sfd.co:6500${pathAfterApi}`; 

    console.log(`Proxying request to: ${targetUrl}`);
    console.log(`Original Method: ${req.method}`);
    // For debugging, you can uncomment these to see headers/body
    // console.log(`Original Headers: `, req.headers); 
    // console.log(`Original Body: `, req.body); 

    // Prepare headers to be sent to the target SFD API
    const headers = {};
    if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;
    if (req.headers.accept) headers['Accept'] = req.headers.accept;
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    // You can add other headers if you notice them missing in SFD API's logs or requirements
    // For example, some APIs might expect a specific User-Agent
    // headers['User-Agent'] = 'Custom-Vapi-Proxy/1.0'; 

    try {
        // Axios handles different methods and data automatically
        const axiosConfig = {
            method: req.method,
            url: targetUrl,
            headers: headers,
            timeout: 15000, // 15 seconds timeout
            validateStatus: function (status) {
                return status >= 200 && status < 500; // Do not throw error for 4xx responses, let the error handling logic below catch it if needed.
            }
        };

        // For POST, PUT, PATCH, attach the request body
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            axiosConfig.data = req.body; // Axios will JSON.stringify this automatically if content-type is application/json
        }

        const response = await axios(axiosConfig);

        console.log(`Received response status from SFD: ${response.status}`);

        // Copy all headers from the target API response back to the client
        // Axios response.headers is an object, not a forEachable map
        for (const headerName in response.headers) {
            // Avoid setting forbidden or irrelevant headers
            // Render automatically adds some headers, no need to forward those from the target.
            if (!['set-cookie', 'origin', 'host', 'connection', 'transfer-encoding', 'content-encoding'].includes(headerName.toLowerCase())) {
                res.setHeader(headerName, response.headers[headerName]);
            }
        }

        // Set the HTTP status code from the SFD API's response
        res.status(response.status).send(response.data); // Send the data directly

    } catch (error) {
        // Axios errors have a structured response if it's an HTTP error
        if (error.response) {
            console.error('Proxy request failed (axios error.response):', error.response.status, error.response.data);
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
    }
});

// Start the Express server
app.listen(port, () => {
    console.log(`SFD CORS Proxy listening at http://localhost:${port}`);
});