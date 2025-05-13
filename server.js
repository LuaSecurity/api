const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use((req, res, next) => {
    // Block root URL access
    if (req.path === '/' && req.method === 'GET') {
        return res.status(403).json({
            status: 'error',
            message: 'Access forbidden'
        });
    }
    next();
});

// Configuration
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1358494144049184821/oGi8Wxiedvw3HLZRkvFeGnFb9LeCl6t1MnzwF2BteqIu_BV1yxtEJqaox-OKNwsoXPr9';
const API_KEYS = {
    'MAIN': process.env.MAIN_API_KEY || 'LuaServerSideServices_ApiKey_60197239',
    'BACKUP': process.env.BACKUP_API_KEY || 'LuaServerSideServices_BackupApiKey_91273123'
};

// Enhanced username verification endpoint
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
                    user: {
                        username: userData.User,
                        roblox: `https://www.roblox.com/users/${userData.User}/profile`,
                        discord: {
                            id: userData.Discord,
                            mention: `<@${userData.Discord}>`
                        },
                        tier: userData.Whitelist,
                        badge: getTierBadge(userData.Whitelist)
                    },
                    verification: {
                        timestamp: new Date().toISOString(),
                        valid: true
                    }
                }
            });
        } else {
            res.status(404).json({
                status: 'error',
                code: 'USER_NOT_FOUND',
                message: 'User not found in whitelist',
                suggestion: 'Please check the username or contact support'
            });
        }
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({
            status: 'error',
            code: 'INTERNAL_ERROR',
            message: 'An error occurred while processing your request'
        });
    }
});

// Secure webhook redirection endpoint
app.post('/send/scriptlogs', async (req, res) => {
    // Security checks
    const authHeader = req.headers['authorization'];
    const clientIP = req.ip || req.connection.remoteAddress;
    
    // 1. Verify HTTP method
    if (req.method !== 'POST') {
        return res.status(405).json({
            status: 'error',
            code: 'METHOD_NOT_ALLOWED',
            message: 'Only POST requests are allowed'
        });
    }

    // 2. Verify authorization header
    if (!authHeader || !Object.values(API_KEYS).includes(authHeader)) {
        console.warn(`Unauthorized access attempt from ${clientIP}`);
        return res.status(401).json({
            status: 'error',
            code: 'UNAUTHORIZED',
            message: 'Invalid or missing API key'
        });
    }

    // 3. Validate payload
    if (!req.body || !req.body.script || !req.body.player) {
        return res.status(400).json({
            status: 'error',
            code: 'INVALID_PAYLOAD',
            message: 'Invalid payload. Required fields missing.'
        });
    }

    // 4. Process and redirect to webhook
    try {
        const { script, player, placeId, placeName, assetId } = req.body;
        
        // Create formatted embed
        const embed = createEmbed(script, player, placeId, placeName, assetId);
        
        // Send to Discord webhook
        const webhookResponse = await axios.post(WEBHOOK_URL, embed, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (webhookResponse.status >= 200 && webhookResponse.status < 300) {
            res.status(200).json({
                status: 'success',
                message: 'Log successfully processed and sent to webhook',
                logId: generateLogId(),
                discordStatus: webhookResponse.status
            });
        } else {
            throw new Error(`Discord API responded with status ${webhookResponse.status}`);
        }
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({
            status: 'error',
            code: 'WEBHOOK_FAILED',
            message: 'Failed to send to webhook',
            error: error.message
        });
    }
});

// Helper functions
function getTierBadge(tier) {
    const badges = {
        'Owner': '👑',
        'Ultimate': '💎',
        'Premium': '⭐',
        'Standard': '🔹'
    };
    return badges[tier] || '❔';
}

function createEmbed(script, player, placeId, placeName, assetId) {
    const description = `
👤 **User Info**
**Username:** ${player.username}
**Discord:** <@${player.discordId}>
**ID:** ${player.userId}
**Whitelist Tier:** ${player.tier}

🕹 **Game Info**
**Name:** ${placeName || 'Unknown'}
**Place ID:** ${placeId || 'N/A'}

📜 **Script Content**
\`\`\`lua
${script.substring(0, 1000)}${script.length > 1000 ? '... (truncated)' : ''}
\`\`\`
${assetId ? `📥 **Download Link:** [Click Here](https://assetdelivery.roblox.com/v1/asset/?id=${assetId})` : ''}
    `;

    return {
        embeds: [{
            title: '📄 Script Execution Log',
            description: description,
            color: 0x3498db,
            footer: { text: 'Lua Script Logging System' },
            timestamp: new Date().toISOString()
        }]
    };
}

function generateLogId() {
    return crypto.randomBytes(8).toString('hex');
}

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
