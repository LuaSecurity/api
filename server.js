// Load environment variables
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const app = express();

// Configurations
const config = {
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_REPO: 'RelaxxxX-Lab/Lua-things',
  GITHUB_BRANCH: 'main',
  WHITELIST_PATH: 'Whitelist.json',
  BLACKLIST_PATH: 'Blacklist.json',
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

// Logging function
function logMessage(level, message) {
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}]: ${message}`);
}

// Generate unique log ID
function generateLogId() {
  return crypto.randomBytes(8).toString('hex');
}

// Input validation function
function validateUsername(username) {
  return typeof username === 'string' && /^[a-zA-Z0-9_]+$/.test(username);
}

// Send Discord embed log
async function sendEmbedLog(title, description, color = 0x0099ff) {
  try {
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(color)
      .setTimestamp();

    const channel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
    if (channel) await channel.send({ embeds: [embed] });
  } catch (error) {
    logMessage('error', `Failed to send embed log: ${error.message}`);
  }
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health Check Route
app.get('/health', (req, res) => {
  res.json({ status: 'success', message: 'API is running smoothly!' });
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

// Fetch blacklist from GitHub
async function getBlacklist() {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO.split('/')[0],
      repo: config.GITHUB_REPO.split('/')[1],
      path: config.BLACKLIST_PATH,
      ref: config.GITHUB_BRANCH,
      headers: { 'Accept': 'application/vnd.github.v3.raw' }
    });
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
  } catch (error) {
    logMessage('error', `Failed to fetch blacklist: ${error.message}`);
    return [];
  }
}

// Submit Script Route
app.post('/submit', async (req, res) => {
  const { username, script } = req.body;
  if (!validateUsername(username) || typeof script !== 'string') {
    return res.status(400).json({ status: 'error', message: 'Invalid username or script' });
  }

  try {
    const blacklist = await getBlacklist();
    if (blacklist.includes(username)) {
      await sendEmbedLog('Blacklisted User Attempt', `User: **${username}** tried to submit a script`, 0xff0000);
      return res.status(403).json({ status: 'error', message: 'User is blacklisted' });
    }

    const response = await axios.post(`https://luaserverside.onrender.com/queue/${username}`, { script });
    if (response.status === 200) {
      await sendEmbedLog('Script Submission', `User: **${username}** submitted a script successfully.`);
      res.json({ status: 'success', message: 'Script successfully submitted!' });
    } else {
      throw new Error('Failed to submit script');
    }
  } catch (error) {
    logMessage('error', `Script submission error: ${error.message}`);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

// Discord Bot Event: Ready
discordClient.on('ready', () => {
  logMessage('info', `Bot logged in as ${discordClient.user.tag}`);
  discordClient.user.setActivity('Managing Whitelist', { type: 'WATCHING' });
});

// Handle Discord Bot Disconnection
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

// Error Handlers
process.on('unhandledRejection', error => {
  logMessage('error', `Unhandled rejection: ${error.message}`);
});

process.on('uncaughtException', error => {
  logMessage('error', `Uncaught exception: ${error.message}`);
});
