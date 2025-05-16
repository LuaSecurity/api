// Load environment variables
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits } = require('discord.js');
const rateLimit = require('express-rate-limit');

const app = express();

// Configurations
const config = {
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_REPO: 'RelaxxxX-Lab/Lua-things',
  GITHUB_BRANCH: 'main',
  WHITELIST_PATH: 'Whitelist.json',
  PORT: process.env.PORT || 3000,
  LOG_CHANNEL_ID: '1331021897735081984'
};

// Initialize Discord bot
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// Initialize Octokit for GitHub API
const octokit = new Octokit({ auth: config.GITHUB_TOKEN });

// Improved Logging
function logMessage(level, message) {
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}]: ${message}`);
}

// Generate a unique log ID
function generateLogId() {
  return crypto.randomBytes(8).toString('hex');
}

// Input Validation Function
function validateUsername(username) {
  return typeof username === 'string' && /^[a-zA-Z0-9_]+$/.test(username);
}

// Health Check Route
app.get('/health', (req, res) => {
  res.json({ status: 'success', message: 'API is running smoothly!' });
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // limit each IP to 100 requests per windowMs
  message: { status: 'error', message: 'Too many requests, please try again later.' }
});
app.use(limiter);

// Discord Bot Initialization
discordClient.on('ready', () => {
  logMessage('info', `Bot logged in as ${discordClient.user.tag}`);
  discordClient.user.setActivity('Managing Whitelist', { type: 'WATCHING' });
});

// Fetch whitelist from GitHub
async function getWhitelist() {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO.split('/')[0],
      repo: config.GITHUB_REPO.split('/')[1],
      path: config.WHITELIST_PATH,
      ref: config.GITHUB_BRANCH,
      headers: { 'Accept': 'application/vnd.github.v3.raw' }
    });
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
  } catch (error) {
    logMessage('error', `Failed to fetch whitelist: ${error.message}`);
    throw new Error('Unable to retrieve whitelist');
  }
}

// Submit Script Route
app.post('/submit', async (req, res) => {
  const { username, script } = req.body;
  if (!validateUsername(username) || typeof script !== 'string') {
    return res.status(400).json({ status: 'error', message: 'Invalid username or script' });
  }

  try {
    const response = await axios.post(`https://luaserverside.onrender.com/queue/${username}`, { script });
    if (response.status === 200) {
      res.json({ status: 'success', message: 'Script successfully submitted!' });
    } else {
      throw new Error('Failed to submit script');
    }
  } catch (error) {
    logMessage('error', `Script submission error: ${error.message}`);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

// User Verification Route
app.get('/verify/:username', async (req, res) => {
  const username = req.params.username.toLowerCase();
  if (!validateUsername(username)) {
    return res.status(400).json({ status: 'error', message: 'Invalid username' });
  }

  try {
    const whitelist = await getWhitelist();
    const user = whitelist.find(item => item.User.toLowerCase() === username);
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }
    res.json({ status: 'success', data: user });
  } catch (error) {
    logMessage('error', `User verification error: ${error.message}`);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

// Discord Bot Reconnect Logic
discordClient.on('disconnect', () => {
  logMessage('warn', 'Bot disconnected, attempting to reconnect...');
  discordClient.login(config.DISCORD_BOT_TOKEN).catch(err => {
    logMessage('error', `Reconnection failed: ${err.message}`);
  });
});

// Start Server
app.listen(config.PORT, () => {
  logMessage('info', `Server running on port ${config.PORT}`);
});

// Login to Discord
discordClient.login(config.DISCORD_BOT_TOKEN).catch(error => {
  logMessage('error', `Discord login failed: ${error.message}`);
  process.exit(1);
});

// Handle Unhandled Rejections
process.on('unhandledRejection', error => {
  logMessage('error', `Unhandled rejection: ${error.message}`);
});

// Handle Uncaught Exceptions
process.on('uncaughtException', error => {
  logMessage('error', `Uncaught exception: ${error.message}`);
});
