require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// Config from environment variables
const config = {
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_LUA_MENU_URL: process.env.GITHUB_LUA_MENU_URL,
  LOG_CHANNEL_ID: '1331021897735081984',
  GITHUB_REPO: 'RelaxxxX-Lab/Lua-things',
  GITHUB_BRANCH: 'main'
};

// Initialize services
const app = express();
const octokit = new Octokit({ 
  auth: config.GITHUB_TOKEN,
  request: { timeout: 5000 } // 5 second timeout
});
const discordClient = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ] 
});

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

function extractRequireIds(script) {
  const requirePattern = /require%(%s*(%d+)%s*%)/g;
  const matches = [];
  let match;
  while ((match = requirePattern.exec(script)) !== null) {
    matches.push(match[1]);
  }
  return matches;
}

async function getWhitelistFromGitHub() {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO.split('/')[0],
      repo: config.GITHUB_REPO.split('/')[1],
      path: 'Whitelist.json',
      ref: config.GITHUB_BRANCH,
      headers: {
        'Accept': 'application/vnd.github.v3.raw',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    // If we get the raw content directly
    if (typeof data === 'string') {
      return JSON.parse(data);
    }
    
    // If we get the encoded content
    if (data.content) {
      return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    }

    throw new Error('Unexpected GitHub response format');
  } catch (error) {
    console.error('GitHub API Error:', error.message);
    if (error.status === 404) {
      throw new Error('Whitelist file not found in repository');
    }
    if (error.status === 403) {
      throw new Error('GitHub API rate limit exceeded');
    }
    throw new Error('Failed to fetch whitelist from GitHub');
  }
}

async function sendToDiscordChannel(embedData, scriptContent = null) {
  try {
    const channel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
    if (!channel) throw new Error('Channel not found');

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

    const messageOptions = {
      embeds: [embedData],
      components: [row]
    };

    if (scriptContent && scriptContent.length > 100) {
      messageOptions.files = [{ attachment: Buffer.from(scriptContent, 'utf-8'), name: 'script.lua' }];
    }

    return channel.send(messageOptions);
  } catch (error) {
    console.error('Discord send error:', error);
    throw error;
  }
}

async function handleRequireDownload(requireId, userId) {
  try {
    const fileName = `${requireId}.rbxm`;
    const content = `-- Roblox model reference: ${requireId}`;
    const user = await discordClient.users.fetch(userId);
    
    await user.send({
      content: `Here's your requested file for require ID ${requireId}`,
      files: [{ attachment: Buffer.from(content), name: fileName }]
    });
    
    return true;
  } catch (error) {
    console.error('Download error:', error);
    return false;
  }
}

// Routes
app.get('/', (req, res) => {
  res.status(403).json({ status: 'error', message: 'Access denied' });
});

app.get('/verify/:username', async (req, res) => {
  if (!isFromRoblox(req)) {
    return res.status(403).json({ status: 'error', message: 'Roblox access only' });
  }

  try {
    const whitelist = await getWhitelistFromGitHub();
    const username = req.params.username.toLowerCase();
    const foundUser = whitelist.find(user => user.User.toLowerCase() === username);

    if (!foundUser) {
      return res.status(404).json({ status: 'error', message: "User not found" });
    }

    res.json({
      status: 'success',
      data: {
        username: foundUser.User,
        discordId: foundUser.Discord,
        tier: foundUser.Whitelist
      }
    });
  } catch (error) {
    console.error('Verification error:', error.message);
    res.status(500).json({ 
      status: 'error', 
      message: error.message || "Internal server error" 
    });
  }
});

app.post('/send/scriptlogs', async (req, res) => {
  if (!isFromRoblox(req)) {
    return res.status(403).json({ status: 'error', message: 'Roblox access only' });
  }

  const authKey = req.headers['authorization'];
  if (!authKey || authKey !== config.API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Invalid API key' });
  }

  if (!req.body?.embeds?.length) {
    return res.status(400).json({ status: 'error', message: 'Invalid embed data' });
  }

  try {
    const embed = req.body.embeds[0];
    const scriptContent = embed.description?.match(/```lua\n([\s\S]*?)\n```/)?.[1] || '';
    const requireIds = extractRequireIds(scriptContent);

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
    console.error('Script log error:', error);
    res.status(500).json({ 
      status: 'error', 
      message: error.message || "Processing failed" 
    });
  }
});

app.get('/scripts/LuaMenu', async (req, res) => {
  if (!isFromRoblox(req)) {
    return res.status(403).json({ status: 'error', message: 'Roblox access only' });
  }

  try {
    const response = await axios.get(config.GITHUB_LUA_MENU_URL, {
      timeout: 5000,
      headers: {
        'User-Agent': 'LuaWhitelistServer/1.0'
      }
    });
    
    res.set({
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Content-Type-Options': 'nosniff'
    }).send(response.data);
  } catch (error) {
    console.error('Script fetch error:', error.message);
    res.status(500).json({ 
      status: 'error', 
      message: error.message || 'Failed to load script' 
    });
  }
});

// Discord interactions
discordClient.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  try {
    if (interaction.customId === 'blacklist') {
      await interaction.reply({ 
        content: 'Blacklist functionality would be implemented here', 
        ephemeral: true 
      });
    } else if (interaction.customId === 'download') {
      await interaction.deferReply({ ephemeral: true });
      
      const requireIds = interaction.message.embeds[0]?.fields
        ?.find(f => f.name === 'Require IDs Found')?.value
        ?.split(', ') || [];
      
      if (requireIds.length > 0) {
        const success = await handleRequireDownload(requireIds[0], interaction.user.id);
        await interaction.editReply({ 
          content: success 
            ? `Download sent for require ID ${requireIds[0]}!` 
            : 'Download failed' 
        });
      } else {
        await interaction.editReply({ 
          content: 'No require IDs found' 
        });
      }
    }
  } catch (error) {
    console.error('Interaction error:', error);
    if (!interaction.replied) {
      await interaction.reply({ 
        content: 'An error occurred', 
        ephemeral: true 
      });
    }
  }
});

// Error handling
process.on('unhandledRejection', error => {
  console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
});

// Start services
discordClient.login(config.DISCORD_BOT_TOKEN)
  .then(() => {
    console.log('Discord bot connected successfully');
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
      console.log(`API server running on port ${port}`);
    });
  })
  .catch(error => {
    console.error('Discord login failed:', error);
    process.exit(1);
  });
