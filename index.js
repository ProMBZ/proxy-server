const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Use CORS middleware
app.use(cors());
app.use(express.json()); // To parse JSON request bodies

// Define the base URL for the SFD API (ensure it ends with a slash if paths don't start with one)
const SFD_BASE_URL = 'https://sfd.co:6500/'; // <<< ADDED TRAILING SLASH HERE

// Route to handle all incoming requests (GET, POST, etc.)
app.all('/api/*', async (req, res) => {
    // Extract the original path after /api/
    const targetPath = req.path.substring(5); // Removes '/api/' e.g., 'appointment/books'

    // Extract only the relevant query parameters for the SFD API
    // Vapi adds its own 'url' parameter, which we need to filter out.
    const queryParams = new URLSearchParams(req.originalUrl.split('?')[1]);
    let sfdApiQueryParams = new URLSearchParams();

    // Iterate through parameters and only keep those relevant to SFD API (e.g., date, time, app_rsn_id)
    // You might need to refine this if Vapi uses more complex query structures
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
    console.log(`Headers:`, headers);
    console.log(`Body:`, req.body);
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
    // --- END DEBUGGING LOGS AND CHECKS ---

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

        // If SFD API returned an error (e.g., 401, or custom error object), format it as Vapi error
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

// A simple test endpoint for the proxy itself
app.get('/', (req, res) => {
    res.send('CORS Proxy is running.');
});

app.listen(PORT, () => {
    console.log(`Proxy server listening on port ${PORT}`);
});