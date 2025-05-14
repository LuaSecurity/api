const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());

// IP Whitelist
const ALLOWED_IP = '128.116.32.3';

// Block all requests not from whitelisted IP
app.use((req, res, next) => {
    const clientIP = req.ip || req.connection.remoteAddress;
    
    if (clientIP !== ALLOWED_IP) {
        console.warn(`Blocked request from unauthorized IP: ${clientIP}`);
        return res.status(403).json({
            status: 'error',
            code: 'IP_NOT_ALLOWED',
            message: 'Access forbidden'
        });
    }
    next();
});

// Block root URL access
app.get('/', (req, res) => {
    res.status(403).json({
        status: 'error',
        message: 'Access forbidden'
    });
});

// Configuration
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1358494144049184821/oGi8Wxiedvw3HLZRkvFeGnFb9LeCl6t1MnzwF2BteqIu_BV1yxtEJqaox-OKNwsoXPr9';
const API_KEY = process.env.API_KEY || 'LuaServerSideServices_ApiKey_60197239';

// Helper function
function generateLogId() {
    return crypto.randomBytes(8).toString('hex');
}

// Simplified username verification endpoint
app.get('/verify/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const githubUrl = 'https://raw.githubusercontent.com/RelaxxxX-Lab/Lua-things/main/Whitelist.json';
        
        const response = await axios.get(githubUrl);
        const users = response.data;
        
        const userData = users.find(user => 
            user.User.toLowerCase() === username.toLowerCase()
        );
        
        if (userData) {
            res.json({
                status: 'success',
                data: {
                    username: userData.User,
                    discordId: userData.Discord,
                    tier: userData.Whitelist
                }
            });
        } else {
            res.status(404).json({
                status: 'error',
                message: 'User not found in whitelist'
            });
        }
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({
            status: 'error',
            message: 'An error occurred while processing your request'
        });
    }
});

// Secure webhook endpoint that only accepts embeds
app.post('/send/scriptlogs', (req, res) => {
    const authHeader = req.headers['authorization'];
    
    // Verify authorization header
    if (!authHeader || authHeader !== API_KEY) {
        return res.status(401).json({
            status: 'error',
            code: 'UNAUTHORIZED',
            message: 'Invalid or missing API key'
        });
    }

    // Validate payload - must contain embeds array
    if (!req.body || !req.body.embeds || !Array.isArray(req.body.embeds)) {
        return res.status(400).json({
            status: 'error',
            code: 'INVALID_PAYLOAD',
            message: 'Payload must contain an "embeds" array'
        });
    }

    // Send to Discord webhook
    axios.post(WEBHOOK_URL, req.body, {
        headers: {
            'Content-Type': 'application/json'
        }
    })
    .then(webhookResponse => {
        res.status(200).json({
            status: 'success',
            message: 'Embed successfully sent to Discord webhook',
            logId: generateLogId()
        });
    })
    .catch(error => {
        console.error('Webhook error:', error);
        res.status(500).json({
            status: 'error',
            code: 'WEBHOOK_FAILED',
            message: 'Failed to send to webhook'
        });
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
