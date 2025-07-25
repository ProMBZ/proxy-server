const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 10000;

app.use(cors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type,Authorization,Accept',
    credentials: true,
    optionsSuccessStatus: 204
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.status(200).send('SFD CORS Proxy is running!');
});

app.use('/api', async (req, res) => {
    const pathAfterApi = req.originalUrl.substring('/api'.length);
    const SFD_BASE_URL = 'https://sfd.co:6500'; // Make sure this is correctly defined
    const targetUrl = `${SFD_BASE_URL}${pathAfterApi}`;

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

    const headersForSFD = {
        'Authorization': SFD_AUTH_TOKEN
    };

    if (req.headers.accept) headersForSFD['Accept'] = req.headers.accept;
    if (req.headers['content-type']) headersForSFD['Content-Type'] = req.headers['content-type'];

    // --- CRITICAL FIX: Filter out Vapi's internal 'url' query parameter ---
    const paramsForSFD = { ...req.query };
    if (paramsForSFD.url) {
        delete paramsForSFD.url;
    }
    // --- END CRITICAL FIX ---

    console.log(`--- Outgoing Request from Proxy to SFD API ---`);
    console.log(`Target URL: ${targetUrl}`);
    console.log(`Method: ${req.method}`);
    console.log(`Headers Sent to SFD:`, headersForSFD);
    console.log(`Query Params Sent to SFD:`, paramsForSFD); // Log the filtered params

    try {
        const axiosConfig = {
            method: req.method,
            url: targetUrl,
            headers: headersForSFD,
            params: paramsForSFD, // Use the filtered parameters
            timeout: 15000,
            validateStatus: function (status) {
                return status >= 200 && status < 500;
            }
        };

        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            axiosConfig.data = req.body;
        }

        const response = await axios(axiosConfig);

        console.log(`--- Response Received from SFD API ---`);
        console.log(`Status from SFD: ${response.status}`);
        console.log(`Headers from SFD:`, response.headers);
        console.log(`Body from SFD (snippet):`, JSON.stringify(response.data).substring(0, 500) + (JSON.stringify(response.data).length > 500 ? '...' : ''));

        for (const headerName in response.headers) {
            if (!['set-cookie', 'origin', 'host', 'connection', 'transfer-encoding', 'content-encoding'].includes(headerName.toLowerCase())) {
                res.setHeader(headerName, response.headers[headerName]);
            }
        }

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

app.listen(port, () => {
    console.log(`SFD CORS Proxy listening at http://localhost:${port}`);
});