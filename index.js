const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // This is how node-fetch is typically imported for older Node.js versions
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

    // Prepare request body for methods that typically send one (POST, PUT, PATCH)
    let requestBody = undefined;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        requestBody = JSON.stringify(req.body);
    }

    try {
        // Make the actual request to the SFD API
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: headers,
            body: requestBody,
            redirect: 'follow', // Important: follow redirects if the SFD API sends them
            timeout: 15000 // Increased timeout for potentially slow responses (15 seconds)
        });

        console.log(`Received response status from SFD: ${response.status}`);
        // console.log(`Received response headers from SFD: `, response.headers.raw()); 

        // Copy all headers from the SFD API response back to the client (Vapi or Postman)
        response.headers.forEach((value, name) => {
            // Prevent issues by not setting forbidden or irrelevant headers
            if (!['set-cookie', 'origin', 'host', 'connection'].includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });

        // Set the HTTP status code from the SFD API's response
        res.status(response.status);

        // Stream the SFD API's response body back to the client
        response.body.pipe(res);

    } catch (error) {
        // Log and send a 500 error if the proxy request fails
        console.error('Proxy request failed:', error);
        res.status(500).json({ error: 'Proxy request failed', details: error.message });
    }
});

// Start the Express server
app.listen(port, () => {
    console.log(`SFD CORS Proxy listening at http://localhost:${port}`);
});