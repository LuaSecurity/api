const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_IP = '128.116.5.3';
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1358494144049184821/oGi8Wxiedvw3HLZRkvFeGnFb9LeCl6t1MnzwF2BteqIu_BV1yxtEJqaox-OKNwsoXPr9';
const API_KEY = process.env.API_KEY || 'LuaServerSideServices_ApiKey_60197239';
const WHITELIST_URL = 'https://raw.githubusercontent.com/RelaxxxX-Lab/Lua-things/main/Whitelist.json';

let whitelistCache = null;
let lastCacheUpdate = 0;

// Middleware
app.use(bodyParser.json());

// Restrict access to whitelisted IPs only
app.use((req, res, next) => {
    const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
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

// Block root
app.get('/', (req, res) => {
    res.status(403).json({ status: 'error', message: 'Access forbidden' });
});

async function getWhitelist() {
    if (whitelistCache && Date.now() - lastCacheUpdate < 300000) return whitelistCache;

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
    return whitelist.some(user => user.User && user.User.toLowerCase() === username.toLowerCase());
}

function generateLogId() {
    return crypto.randomBytes(8).toString('hex');
}

app.get('/verify/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const whitelist = await getWhitelist();
        const userData = whitelist.find(user => user.User && user.User.toLowerCase() === username.toLowerCase());

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
            res.status(404).json({ status: 'error', message: 'User not found in whitelist' });
        }
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

app.post('/send/scriptlogs', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        if (!authHeader || authHeader !== API_KEY) {
            return res.status(401).json({
                status: 'error',
                code: 'UNAUTHORIZED',
                message: 'Invalid or missing API key'
            });
        }

        const embed = req.body?.embeds?.[0];
        if (!embed || !embed.description) {
            return res.status(400).json({
                status: 'error',
                code: 'INVALID_EMBED',
                message: 'Embed must contain a description'
            });
        }

        const usernameMatch = embed.description.match(/\*\*Username:\*\* (.+)\n/);
        const username = usernameMatch?.[1]?.trim();

        if (!username) {
            return res.status(400).json({
                status: 'error',
                code: 'USERNAME_NOT_FOUND',
                message: 'Could not extract username'
            });
        }

        const isAllowed = await isWhitelisted(username);
        if (!isAllowed) {
            return res.status(403).json({
                status: 'error',
                code: 'NOT_WHITELISTED',
                message: 'User is not whitelisted'
            });
        }

        await axios.post(WEBHOOK_URL, req.body, {
            headers: { 'Content-Type': 'application/json' }
        });

        res.status(200).json({
            status: 'success',
            message: 'Embed sent to Discord webhook',
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

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
