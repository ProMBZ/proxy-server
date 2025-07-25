const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https'); // Import the built-in https module
require('dotenv').config();

const app = express();
const port = process.env.PORT || 10000;

// --- IMPORTANT: Configure HTTPS Agent to bypass SSL validation (for testing only) ---
const httpsAgent = new https.Agent({
    rejectUnauthorized: false // WARNING: Do NOT use this in production with untrusted endpoints!
});
// --- END IMPORTANT ---

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
    const pathAfterApi = req.path.substring('/api'.length);
    const SFD_BASE_URL = 'https://sfd.co:6500';
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

    const paramsForSFD = { ...req.query };
    if (paramsForSFD.url) {
        delete paramsForSFD.url;
    }

    console.log(`--- Outgoing Request from Proxy to SFD API ---`);
    console.log(`Target URL: ${targetUrl}`);
    console.log(`Method: ${req.method}`);
    console.log(`Headers Sent to SFD:`, headersForSFD);
    console.log(`Query Params Sent to SFD:`, paramsForSFD);

    try {
        const axiosConfig = {
            method: req.method,
            url: targetUrl,
            headers: headersForSFD,
            params: paramsForSFD,
            timeout: 15000,
            // --- IMPORTANT: Add the HTTPS Agent here ---
            httpsAgent: httpsAgent,
            // --- END IMPORTANT ---
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
            // This is the specific error you were getting. Log the full error object for more detail.
            console.error('Full Axios Error:', error);
            res.status(500).json({ error: 'Proxy request failed (general error)', details: error.message });
        }
        console.log(`-------------------\n`);
    }
});

app.listen(port, () => {
    console.log(`SFD CORS Proxy listening at http://localhost:${port}`);
});