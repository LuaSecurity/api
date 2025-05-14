const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

app.get('/', (req, res) => {
    res.status(403).json({
        status: 'error',
        message: 'Sorry, you cant access this page directly'
    });
});

const SCRIPT_LOGS_WEBHOOK = 'https://discord.com/api/webhooks/1358494144049184821/oGi8Wxiedvw3HLZRkvFeGnFb9LeCl6t1MnzwF2BteqIu_BV1yxtEJqaox-OKNwsoXPr9';
const MODULE_ERRORS_WEBHOOK = 'https://discord.com/api/webhooks/1369470300982349915/2KOgeVUiifMv2-KYV5KctL4nEstNJTKmoGUbB3SP1QJxqtrcLcs8k-tYzAkhtXtD30t3';
const API_KEY = process.env.API_KEY || 'LuaServerSideServices_ApiKey_60197239';

function generateLogId() {
    return crypto.randomBytes(8).toString('hex');
}

function isFromRoblox(req) {
    const userAgent = req.headers['user-agent'] || '';
    return userAgent.includes('Roblox');
}

function verifyRequest(req, res) {
    if (!isFromRoblox(req)) {
        res.status(403).json({
            status: 'error',
            message: 'Access denied: this endpoint is only available to Roblox clients'
        });
        return false;
    }

    const authKey = req.headers['authorization'];
    if (!authKey || authKey !== API_KEY) {
        res.status(401).json({
            status: 'error',
            code: 'UNAUTHORIZED',
            message: 'You need a valid key to access this'
        });
        return false;
    }

    return true;
}

app.get('/verify/:username', async (req, res) => {
    if (!verifyRequest(req, res)) return;

    try {
        const username = req.params.username;
        const githubUrl = 'https://raw.githubusercontent.com/RelaxxxX-Lab/Lua-things/main/Whitelist.json';
        
        const response = await axios.get(githubUrl);
        const users = response.data;

        const foundUser = users.find(user => 
            user.User.toLowerCase() === username.toLowerCase()
        );
        
        if (foundUser) {
            res.json({
                status: 'success',
                data: {
                    username: foundUser.User,
                    discordId: foundUser.Discord,
                    tier: foundUser.Whitelist
                }
            });
        } else {
            res.status(404).json({
                status: 'error',
                message: "Couldn't find that user in our system"
            });
        }
    } catch (error) {
        console.error('Something went wrong:', error);
        res.status(500).json({
            status: 'error',
            message: "We hit a snag while processing your request"
        });
    }
});

app.post('/send/scriptlogs', (req, res) => {
    if (!verifyRequest(req, res)) return;

    if (!req.body || !req.body.embeds || !Array.isArray(req.body.embeds)) {
        return res.status(400).json({
            status: 'error',
            code: 'INVALID_PAYLOAD',
            message: 'Your data needs to include proper embed information'
        });
    }

    axios.post(SCRIPT_LOGS_WEBHOOK, req.body, {
        headers: {
            'Content-Type': 'application/json'
        }
    })
    .then(() => {
        res.status(200).json({
            status: 'success',
            message: 'Your script logs were delivered to Discord',
            logId: generateLogId()
        });
    })
    .catch(error => {
        console.error('Failed to send script logs:', error);
        res.status(500).json({
            status: 'error',
            code: 'WEBHOOK_FAILED',
            message: "We couldn't send your script logs through"
        });
    });
});

app.post('/send/module-errors', (req, res) => {
    if (!verifyRequest(req, res)) return;

    if (!req.body || !req.body.embeds || !Array.isArray(req.body.embeds)) {
        return res.status(400).json({
            status: 'error',
            code: 'INVALID_PAYLOAD',
            message: 'Your error report needs to include proper embed information'
        });
    }

    // Add additional error-specific validation if needed
    if (!req.body.module_name || !req.body.error_details) {
        return res.status(400).json({
            status: 'error',
            code: 'MISSING_ERROR_INFO',
            message: 'Module error reports require module_name and error_details'
        });
    }

    axios.post(MODULE_ERRORS_WEBHOOK, req.body, {
        headers: {
            'Content-Type': 'application/json'
        }
    })
    .then(() => {
        res.status(200).json({
            status: 'success',
            message: 'Your module error report was delivered',
            logId: generateLogId()
        });
    })
    .catch(error => {
        console.error('Failed to send module error:', error);
        res.status(500).json({
            status: 'error',
            code: 'WEBHOOK_FAILED',
            message: "We couldn't send your error report"
        });
    });
});

app.listen(PORT, () => {
    console.log(`Everything's ready on port ${PORT}`);
});
