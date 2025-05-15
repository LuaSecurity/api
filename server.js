const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const app = express();
const PORT = process.env.PORT || 3000;

// Constants
const DISCORD_BOT_TOKEN = 'MTM3MDg1NjU5NTY2NzU1MDI0OA.GRG3k8._QYn6rg96GUyhwmp7BYWvGkpBl9i0QUcCKXa8k';
const LOG_CHANNEL_ID = '1331021897735081984';
const API_KEY = process.env.API_KEY || 'LuaServerSideServices_ApiKey_60197239';
const GITHUB_TOKEN = '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';
const GITHUB_REPO = 'RelaxxxX-Lab/Lua-things';
const GITHUB_BRANCH = 'main';

// Initialize GitHub client
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Initialize Discord client
const { Client, GatewayIntentBits } = require('discord.js');
const discordClient = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ] 
});

// Connect to Discord
discordClient.login(DISCORD_BOT_TOKEN);
discordClient.on('ready', () => console.log('Discord bot connected!'));

// Middleware
app.use(bodyParser.json({ limit: '10mb' }));

// Helper functions
function generateLogId() {
    return crypto.randomBytes(8).toString('hex');
}

function isFromRoblox(req) {
    const userAgent = req.headers['user-agent'] || '';
    return userAgent.includes('Roblox');
}

async function sendToDiscordChannel(embedData, scriptContent = null) {
    try {
        const channel = await discordClient.channels.fetch(LOG_CHANNEL_ID);
        if (!channel) throw new Error('Channel not found');

        // Create buttons
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('blacklist')
                    .setLabel('Blacklist')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('download')
                    .setLabel('Download')
                    .setStyle(ButtonStyle.Primary)
            );

        // If script is long, upload as file
        if (scriptContent && scriptContent.length > 100) {
            const buffer = Buffer.from(scriptContent, 'utf-8');
            await channel.send({
                embeds: [embedData],
                files: [{ attachment: buffer, name: 'script.lua' }],
                components: [row]
            });
        } else {
            await channel.send({
                embeds: [embedData],
                components: [row]
            });
        }
    } catch (error) {
        console.error('Failed to send to Discord:', error);
        throw error;
    }
}

async function handleRequireDownload(requireId, userId) {
    try {
        // Create a file with the require ID as name
        const fileName = `${requireId}.rbxm`;
        const content = `-- Roblox model reference: ${requireId}`;
        
        // Send as ephemeral message
        const user = await discordClient.users.fetch(userId);
        await user.send({
            content: `Here's your requested file for require ID ${requireId}`,
            files: [{ attachment: Buffer.from(content), name: fileName }]
        });
        
        return true;
    } catch (error) {
        console.error('Failed to handle require download:', error);
        return false;
    }
}

// Extract require IDs from script
function extractRequireIds(script) {
    const requirePattern = /require%(%s*(%d+)%s*%)/g;
    const matches = [];
    let match;
    while ((match = requirePattern.exec(script)) !== null) {
        matches.push(match[1]);
    }
    return matches;
}

// Routes
app.get('/', (req, res) => {
    res.status(403).json({
        status: 'error',
        message: 'Access denied'
    });
});

app.get('/verify/:username', async (req, res) => {
    if (!isFromRoblox(req)) {
        return res.status(403).json({
            status: 'error',
            message: 'Access denied: Roblox clients only'
        });
    }

    try {
        const { data } = await octokit.repos.getContent({
            owner: GITHUB_REPO.split('/')[0],
            repo: GITHUB_REPO.split('/')[1],
            path: 'Whitelist.json',
            ref: GITHUB_BRANCH
        });

        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        const users = JSON.parse(content);
        const username = req.params.username.toLowerCase();

        const foundUser = users.find(user => 
            user.User.toLowerCase() === username
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
                message: "User not found"
            });
        }
    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({
            status: 'error',
            message: "Internal server error"
        });
    }
});

app.post('/send/scriptlogs', async (req, res) => {
    if (!isFromRoblox(req)) {
        return res.status(403).json({
            status: 'error',
            message: 'Access denied: Roblox clients only'
        });
    }

    const authKey = req.headers['authorization'];
    if (!authKey || authKey !== API_KEY) {
        return res.status(401).json({
            status: 'error',
            code: 'UNAUTHORIZED',
            message: 'Invalid API key'
        });
    }

    if (!req.body || !req.body.embeds || !Array.isArray(req.body.embeds) || req.body.embeds.length === 0) {
        return res.status(400).json({
            status: 'error',
            code: 'INVALID_PAYLOAD',
            message: 'Invalid embed data'
        });
    }

    try {
        const embed = req.body.embeds[0];
        const scriptContent = embed.description.match(/```lua\n([\s\S]*?)\n```/)?.[1] || '';
        
        // Extract require IDs
        const requireIds = extractRequireIds(scriptContent);
        
        // Add require IDs to embed if found
        if (requireIds.length > 0) {
            embed.fields = embed.fields || [];
            embed.fields.push({
                name: 'Require IDs Found',
                value: requireIds.join(', '),
                inline: false
            });
        }

        await sendToDiscordChannel(embed, scriptContent);
        
        res.status(200).json({
            status: 'success',
            message: 'Log sent to Discord',
            logId: generateLogId(),
            requireIds
        });
    } catch (error) {
        console.error('Failed to process script log:', error);
        res.status(500).json({
            status: 'error',
            code: 'PROCESSING_ERROR',
            message: "Failed to process request"
        });
    }
});

app.get('/scripts/LuaMenu', async (req, res) => {
    if (!isFromRoblox(req)) {
        return res.status(403).json({
            status: 'error',
            message: 'Access denied: Roblox clients only'
        });
    }

    try {
        const response = await axios.get('https://raw.githubusercontent.com/LuaSecurity/ergsergesrgegresrgsregredf/main/gbfddfgesge');
        
        res.set({
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Content-Type-Options': 'nosniff'
        });
        
        res.send(response.data);
    } catch (error) {
        console.error('Failed to fetch script:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to load script'
        });
    }
});

// Discord button interactions
discordClient.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    try {
        if (interaction.customId === 'blacklist') {
            // Handle blacklist logic
            await interaction.reply({ 
                content: 'Blacklist functionality would be implemented here', 
                ephemeral: true 
            });
        } else if (interaction.customId === 'download') {
            // Find require IDs in the original message
            const requireIds = interaction.message.embeds[0]?.fields
                ?.find(f => f.name === 'Require IDs Found')?.value
                ?.split(', ') || [];
            
            if (requireIds.length > 0) {
                await interaction.deferReply({ ephemeral: true });
                const success = await handleRequireDownload(requireIds[0], interaction.user.id);
                
                if (success) {
                    await interaction.editReply({ 
                        content: `Download link sent for require ID ${requireIds[0]}!` 
                    });
                } else {
                    await interaction.editReply({ 
                        content: 'Failed to process download request' 
                    });
                }
            } else {
                await interaction.reply({ 
                    content: 'No require IDs found in this script', 
                    ephemeral: true 
                });
            }
        }
    } catch (error) {
        console.error('Button interaction error:', error);
        if (!interaction.replied) {
            await interaction.reply({ 
                content: 'An error occurred', 
                ephemeral: true 
            });
        }
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`API server running on port ${PORT}`);
});
