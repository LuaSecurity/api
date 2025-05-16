require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits } = require('discord.js');

// Validate required environment variables
['API_KEY', 'GITHUB_TOKEN', 'DISCORD_BOT_TOKEN', 'GITHUB_LUA_MENU_URL'].forEach(key => {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
});

// Configuration
const config = {
  apiKey: process.env.API_KEY,
  githubToken: process.env.GITHUB_TOKEN,
  discordToken: process.env.DISCORD_BOT_TOKEN,
  githubLuaMenuUrl: process.env.GITHUB_LUA_MENU_URL,
  logChannelId: '1331021897735081984',
  githubRepo: 'RelaxxxX-Lab/Lua-things',
  githubBranch: 'main',
  whitelistPath: 'Whitelist.json',
  roles: {
    standard: '1330552089759191064',
    premium: '1333286640248029264',
    ultimate: '1337177751202828300'
  }
};

// Initialize services
const app = express();
const octokit = new Octokit({ auth: config.githubToken });
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// Utility: Log ID generator
function generateLogId() {
  return crypto.randomBytes(8).toString('hex');
}

// Utility: Roblox request check
function isFromRoblox(req) {
  return (req.headers['user-agent'] || '').includes('Roblox');
}

// Utility: Fetch whitelist from GitHub
async function fetchWhitelist() {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.githubRepo.split('/')[0],
      repo: config.githubRepo.split('/')[1],
      path: config.whitelistPath,
      ref: config.githubBranch,
      headers: { 'Accept': 'application/vnd.github.v3.raw' }
    });

    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error('[GitHub] Error fetching whitelist:', error.message);
    throw new Error('Failed to fetch whitelist');
  }
}

// POST /submit — Submit script to executor
app.post('/submit', async (req, res) => {
  const { username, script } = req.body;

  if (!username || !script) {
    return res.status(400).json({ status: 'error', message: 'Missing username or script' });
  }

  try {
    const response = await axios.post(`https://luaserverside.onrender.com/queue/${username}`, { script });

    if (response.status === 200) {
      return res.json({ status: 'success', message: 'Script successfully submitted!' });
    }

    throw new Error(`Unexpected response status: ${response.status}`);
  } catch (error) {
    console.error('[Script Submit] Error:', error.message);
    return res.status(500).json({ status: 'error', message: 'Failed to submit script' });
  }
});

// GET /verify/:username — Check if user is in whitelist
app.get('/verify/:username', async (req, res) => {
  const username = req.params.username.toLowerCase();

  try {
    const whitelist = await fetchWhitelist();
    const user = whitelist.find(entry => entry.User.toLowerCase() === username);

    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found in whitelist' });
    }

    return res.json({ status: 'success', data: user });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: 'Verification failed' });
  }
});

// GET /download/:assetId — Download placeholder file
app.get('/download/:assetId', (req, res) => {
  const assetId = req.params.assetId;

  if (!/^\d+$/.test(assetId)) {
    return res.status(400).json({ status: 'error', message: 'Invalid asset ID' });
  }

  const filename = `${assetId}.rbxm`;
  const content = `-- Roblox model reference: ${assetId}`;

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(content);
});

// Root route
app.get('/', (req, res) => {
  return res.json({ status: 'success', message: 'Lua Executor API is online' });
});

// Discord bot events
discordClient.once('ready', () => {
  console.log(`[Discord] Bot logged in as ${discordClient.user.tag}`);
  discordClient.user.setActivity('Whitelist Manager', { type: 'WATCHING' });
});

// Error handling
process.on('unhandledRejection', err => {
  console.error('[Unhandled Rejection]', err);
});

process.on('uncaughtException', err => {
  console.error('[Uncaught Exception]', err);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});

// Discord login
discordClient.login(config.discordToken).catch(error => {
  console.error('[Discord] Failed to login:', error.message);
  process.exit(1);
});
