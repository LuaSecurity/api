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

const WEBHOOK_URL = '';
const API_KEY = process.env.API_KEY || '';

// Function to generate random log ID
function generateLogId() {
    return crypto.randomBytes(8).toString('hex');
}

// Middleware to check if request is from Roblox
function isFromRoblox(req) {
    const userAgent = req.headers['user-agent'] || '';
    return userAgent.includes('Roblox');
}

// Verify user endpoint
app.get('/verify/:username', async (req, res) => {
    if (!isFromRoblox(req)) {
        return res.status(403).json({
            status: 'error',
            message: 'Access denied: this endpoint is only available to Roblox clients'
        });
    }

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

// Script logs endpoint
app.post('/send/scriptlogs', (req, res) => {
    if (!isFromRoblox(req)) {
        return res.status(403).json({
            status: 'error',
            message: 'Access denied: this endpoint is only available to Roblox clients'
        });
    }

    const authKey = req.headers['authorization'];
    
    if (!authKey || authKey !== API_KEY) {
        return res.status(401).json({
            status: 'error',
            code: 'UNAUTHORIZED',
            message: 'You need a valid key to access this'
        });
    }

    if (!req.body || !req.body.embeds || !Array.isArray(req.body.embeds)) {
        return res.status(400).json({
            status: 'error',
            code: 'INVALID_PAYLOAD',
            message: 'Your data needs to include proper embed information'
        });
    }

    axios.post(WEBHOOK_URL, req.body, {
        headers: {
            'Content-Type': 'application/json'
        }
    })
    .then(() => {
        res.status(200).json({
            status: 'success',
            message: 'Your message was delivered to Discord',
            logId: generateLogId()
        });
    })
    .catch(error => {
        console.error('Failed to send:', error);
        res.status(500).json({
            status: 'error',
            code: 'WEBHOOK_FAILED',
            message: "We couldn't send your message through"
        });
    });
});
// Adicione esta rota após as outras rotas existentes
app.get('/scripts/LuaMenu', async (req, res) => {
    if (!isFromRoblox(req)) {
        return res.status(403).json({
            status: 'error',
            message: 'Access denied: this endpoint is only available to Roblox clients'
        });
    }

    try {
        // Verificar se a requisição parece vir de um exploit (loadstring)
        const referer = req.headers['referer'] || '';
        const isLikelyExploit = referer.includes('RobloxPlayer') || 
                              req.headers['user-agent'].includes('Roblox') ||
                              req.headers['origin'] === 'roblox-player';

        if (!isLikelyExploit) {
            return res.status(403).json({
                status: 'error',
                message: 'Direct script access is not allowed'
            });
        }

        // Buscar o conteúdo do script do GitHub
        const response = await axios.get('https://raw.githubusercontent.com/LuaSecurity/ergsergesrgegresrgsregredf/refs/heads/main/gbfddfgesge');
        
        // Definir headers para evitar cache e indicar conteúdo como texto puro
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        
        // Enviar o conteúdo do script
        res.send(response.data);
    } catch (error) {
        console.error('Failed to fetch script:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to load script content'
        });
    }
});
app.listen(PORT, () => {
    console.log(`Everything's ready on port ${PORT}`);
});
