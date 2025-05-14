const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());

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
let ALLOWED_IPS = []; // Será preenchido com os IPs do Roblox

// Helper functions
function generateLogId() {
    return crypto.randomBytes(8).toString('hex');
}

async function updateRobloxIPs() {
    try {
        const response = await axios.get('http://ip-api.com/json/roblox.com');
        if (response.data && response.data.query) {
            ALLOWED_IPS = [response.data.query];
            console.log('Updated allowed IPs:', ALLOWED_IPS);
        }
    } catch (error) {
        console.error('Failed to update Roblox IPs:', error);
    }
}

// Atualiza os IPs do Roblox no startup e a cada hora
updateRobloxIPs();
setInterval(updateRobloxIPs, 3600000); // Atualiza a cada hora

// Middleware para verificar IP do Roblox
app.use((req, res, next) => {
    const clientIP = req.ip || req.connection.remoteAddress;
    const cleanedIP = clientIP.replace('::ffff:', '');
    
    // Permite requisições GET e rotas de verificação
    if (req.path.startsWith('/verify/') || req.method === 'GET') {
        return next();
    }
    
    // Verifica se é um IP do Roblox
    if (ALLOWED_IPS.includes(cleanedIP)) {
        return next();
    }
    
    // Bloqueia requisições não autorizadas
    res.status(403).json({
        status: 'error',
        message: 'Access forbidden - IP not authorized'
    });
});

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
