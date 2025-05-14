const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());

// IP Whitelist
const ALLOWED_IP = '128.116.5.3';
const RICKROLL_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// Block all requests not from whitelisted IP
app.use((req, res, next) => {
    const clientIP = req.ip || req.connection.remoteAddress;
    
    if (clientIP !== ALLOWED_IP) {
        console.warn(`Blocked request from unauthorized IP: ${clientIP}`);
        return res.redirect(RICKROLL_URL);
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
const WHITELIST_URL = 'https://raw.githubusercontent.com/RelaxxxX-Lab/Lua-things/main/Whitelist.json';

// Cache for whitelist
let whitelistCache = null;
let lastCacheUpdate = 0;

async function getWhitelist() {
    // Cache for 5 minutes
    if (whitelistCache && Date.now() - lastCacheUpdate < 300000) {
        return whitelistCache;
    }
    
    try {
        const response = await axios.get(WHITELIST_URL);
        whitelistCache = response.data;
        lastCacheUpdate = Date.now();
        return whitelistCache;
    } catch (error) {
        console.error('Failed to fetch whitelist:', error);
        throw new Error('Could not fetch whitelist');
    }
}

async function isWhitelisted(username) {
    const whitelist = await getWhitelist();
    return whitelist.some(user => 
        user.User.toLowerCase() === username.toLowerCase()
    );
}

// Helper function
function generateLogId() {
    return crypto.randomBytes(8).toString('hex');
}

// Simplified username verification endpoint
app.get('/verify/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const whitelist = await getWhitelist();
        
        const userData = whitelist.find(user => 
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

// Secure webhook endpoint with whitelist verification
app.post('/send/scriptlogs', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        
        // Verify authorization header
        if (!authHeader || authHeader !== API_KEY) {
            return res.status(401).json({
                status: 'error',
                code: 'UNAUTHORIZED',
                message: 'Invalid or missing API key'
            });
        }

        // Validate payload
        if (!req.body || !req.body.embeds || !Array.isArray(req.body.embeds)) {
            return res.status(400).json({
                status: 'error',
                code: 'INVALID_PAYLOAD',
                message: 'Payload must contain an "embeds" array'
            });
        }

        // Extract username from embed description
        const embed = req.body.embeds[0];
        if (!embed || !embed.description) {
            return res.status(400).json({
                status: 'error',
                code: 'INVALID_EMBED',
                message: 'Embed must contain a description'
            });
        }

        // Parse username from description
        const usernameMatch = embed.description.match(/\*\*Username:\*\* (.+)\n/);
        if (!usernameMatch || !usernameMatch[1]) {
            return res.status(400).json({
                status: 'error',
                code: 'USERNAME_NOT_FOUND',
                message: 'Could not extract username from embed'
            });
        }

        const username = usernameMatch[1].trim();

        // Verify user is whitelisted
        const isAllowed = await isWhitelisted(username);
        if (!isAllowed) {
            return res.status(403).json({
                status: 'error',
                code: 'NOT_WHITELISTED',
                message: 'User is not whitelisted'
            });
        }

        // Send to Discord webhook
        const webhookResponse = await axios.post(WEBHOOK_URL, req.body, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        res.status(200).json({
            status: 'success',
            message: 'Embed successfully sent to Discord webhook',
            logId: generateLogId()
        });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({
            status: 'error',
            code: 'SERVER_ERROR',
            message: 'An error occurred while processing your request'
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
