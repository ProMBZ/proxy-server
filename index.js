const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Use CORS middleware
app.use(cors());
app.use(express.json()); // To parse JSON request bodies

// Route to handle all incoming requests (GET, POST, etc.)
app.all('/api/*', async (req, res) => {
    // Extract the original path after /api/
    const targetPath = req.path.substring(5); // Removes '/api/'
    const originalUrl = req.originalUrl; // Includes query parameters
    const method = req.method;
    const headers = { ...req.headers };

    // Remove host header to prevent issues with target server
    delete headers.host;
    // Remove if-none-match header to ensure fresh content
    delete headers['if-none-match'];
    // Remove accept-encoding header to prevent compression issues
    delete headers['accept-encoding']; // Or allow if your client handles it

    // IMPORTANT: Ensure the Authorization header is passed correctly
    // If your client sends it as 'Authorization', it should be fine.

    // Define the base URL for the SFD API
    const SFD_BASE_URL = 'https://sfd.co:6500'; // Make sure this is correct

    // Construct the full target URL
    const fullTargetUrl = `${SFD_BASE_URL}${targetPath}${originalUrl.includes('?') ? originalUrl.substring(originalUrl.indexOf('?')) : ''}`;

    // Log the incoming request and the target URL for debugging
    console.log(`--- Proxy Request ---`);
    console.log(`Method: ${method}`);
    console.log(`Original URL: ${req.originalUrl}`);
    console.log(`Target Path: ${targetPath}`);
    console.log(`Full Target URL: ${fullTargetUrl}`);
    console.log(`Headers:`, headers);
    console.log(`Body:`, req.body);
    console.log(`--- End Proxy Request ---`);

    try {
        const axiosConfig = {
            method: method,
            url: fullTargetUrl,
            headers: headers,
            validateStatus: function (status) {
                return status >= 200 && status < 500; // Do not throw for 4xx errors, handle them in catch block
            }
        };

        // For GET requests, parameters are in the URL, no need for body
        if (method !== 'GET' && method !== 'HEAD') {
            axiosConfig.data = req.body;
        }

        const sfdResponse = await axios(axiosConfig);

        // **THIS IS THE CRITICAL CHANGE FOR VAPI FORMATTING**
        const toolCallId = req.body.toolCallId || 'default_tool_call_id'; // Get the toolCallId from Vapi's request body

        // If SFD API returned an error (e.g., 401, or custom error object), format it as Vapi error
        if (sfdResponse.status >= 400 || sfdResponse.data.error) {
            console.error('--- SFD API Error Response ---');
            console.error('Status:', sfdResponse.status);
            console.error('Data:', sfdResponse.data);

            let errorMessage = `SFD API Error: Status ${sfdResponse.status}.`;
            if (sfdResponse.data && typeof sfdResponse.data === 'object' && sfdResponse.data.error && sfdResponse.data.error.description) {
                errorMessage += ` Description: ${sfdResponse.data.error.description}`;
            } else if (sfdResponse.data) {
                // If it's not the specific error format, stringify the whole response data
                errorMessage += ` Raw response: ${JSON.stringify(sfdResponse.data)}`;
            } else if (sfdResponse.statusText) {
                errorMessage += ` Status Text: ${sfdResponse.statusText}`;
            }

            // Vapi expects error as a single-line string
            const vapiErrorResponse = {
                results: [{
                    toolCallId: toolCallId,
                    error: errorMessage.replace(/[\r\n]+/g, ' ').substring(0, 500) // Ensure single line and limit length
                }]
            };
            return res.status(200).json(vapiErrorResponse); // Always return 200 for Vapi webhooks
        }

        // If SFD API returned success, format it as Vapi result
        console.log('--- SFD API Success Response ---');
        console.log('Status:', sfdResponse.status);
        console.log('Data:', sfdResponse.data);

        // Convert the SFD API data into a single-line string.
        // For complex objects, you might want to stringify specific fields or just the whole object.
        // For now, let's stringify the entire data.
        const resultString = JSON.stringify(sfdResponse.data);

        const vapiSuccessResponse = {
            results: [{
                toolCallId: toolCallId,
                result: resultString.replace(/[\r\n]+/g, ' ').substring(0, 500) // Ensure single line and limit length
            }]
        };
        return res.status(200).json(vapiSuccessResponse); // Always return 200 for Vapi webhooks

    } catch (error) {
        console.error(`--- Proxy Error ---`);
        console.error(`Full Axios Error:`, error.message);
        console.error(`Error config:`, error.config);
        if (error.response) {
            console.error(`Error Response Status:`, error.response.status);
            console.error(`Error Response Data:`, error.response.data);
            console.error(`Error Response Headers:`, error.response.headers);
        } else if (error.request) {
            console.error(`Error Request:`, error.request);
        } else {
            console.error(`Error message:`, error.message);
        }

        // Format proxy internal errors for Vapi
        const toolCallId = req.body.toolCallId || 'default_tool_call_id';
        const vapiErrorResponse = {
            results: [{
                toolCallId: toolCallId,
                error: `Proxy internal error: ${error.message}. Please check proxy logs.`.replace(/[\r\n]+/g, ' ').substring(0, 500)
            }]
        };
        return res.status(200).json(vapiErrorResponse); // Always return 200 for Vapi webhooks
    }
});

// Start the proxy server
app.listen(PORT, () => {
    console.log(`Proxy server listening on port ${PORT}`);
});