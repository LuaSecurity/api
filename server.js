require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder } = require('discord.js');

// Config from environment variables
const config = {
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_LUA_MENU_URL: process.env.GITHUB_LUA_MENU_URL,
  LOG_CHANNEL_ID: '1331021897735081984',
  GITHUB_REPO: 'RelaxxxX-Lab/Lua-things',
  GITHUB_BRANCH: 'main',
  WHITELIST_PATH: 'Whitelist.json',
  ROLES: {
    STANDARD: '1330552089759191064',
    PREMIUM: '1333286640248029264',
    ULTIMATE: '1337177751202828300'
  }
};

// Initialize services
const app = express();
const octokit = new Octokit({ 
  auth: config.GITHUB_TOKEN,
  request: { timeout: 5000 }
});
const discordClient = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ] 
});

// In-memory queue storage
const scriptQueues = new Map();

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

async function getWhitelistFromGitHub() {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO.split('/')[0],
      repo: config.GITHUB_REPO.split('/')[1],
      path: config.WHITELIST_PATH,
      ref: config.GITHUB_BRANCH,
      headers: {
        'Accept': 'application/vnd.github.v3.raw'
      }
    });

    if (typeof data === 'string') {
      return JSON.parse(data);
    }
    
    if (data.content) {
      return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    }

    throw new Error('Unexpected GitHub response format');
  } catch (error) {
    console.error('GitHub API Error:', error);
    throw error;
  }
}

async function updateWhitelistOnGitHub(newWhitelist) {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO.split('/')[0],
      repo: config.GITHUB_REPO.split('/')[1],
      path: config.WHITELIST_PATH,
      ref: config.GITHUB_BRANCH
    });

    const response = await octokit.rest.repos.createOrUpdateFileContents({
      owner: config.GITHUB_REPO.split('/')[0],
      repo: config.GITHUB_REPO.split('/')[1],
      path: config.WHITELIST_PATH,
      message: 'Update whitelist (blacklist action)',
      content: Buffer.from(JSON.stringify(newWhitelist, null, 2)).toString('base64'),
      sha: data.sha,
      branch: config.GITHUB_BRANCH
    });

    return response.status === 200;
  } catch (error) {
    console.error('GitHub update error:', error);
    throw error;
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
          .setCustomId('download_script')
          .setLabel('Download Script')
          .setStyle(ButtonStyle.Primary)
      );

    const messageOptions = {
      embeds: [embedData],
      components: [row]
    };

    if (scriptContent && scriptContent.trim().length > 0) {
      const buffer = Buffer.from(scriptContent, 'utf-8');
      const attachment = new AttachmentBuilder(buffer, { name: 'script.lua' });
      messageOptions.files = [attachment];
      
      if (scriptContent.length > 100) {
        embedData.description = embedData.description.replace(
          /```lua\n[\s\S]*?\n```/, 
          '```lua\n[Script content available in attached file]\n```'
        );
      }
    }

    return channel.send(messageOptions);
  } catch (error) {
    console.error('Discord send error:', error);
    throw error;
  }
}

async function handleBlacklist(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const embed = interaction.message.embeds[0];
    if (!embed || !embed.description) {
      return interaction.editReply({ content: 'Could not find user information in this message' });
    }

    const discordIdMatch = embed.description.match(/Discord: <@(\d+)>/);
    if (!discordIdMatch) {
      return interaction.editReply({ content: 'Could not identify user to blacklist' });
    }

    const targetUserId = discordIdMatch[1];
    const robloxUsernameMatch = embed.description.match(/Username: (.+?)\n/);
    const robloxUsername = robloxUsernameMatch ? robloxUsernameMatch[1] : 'Unknown';

    const whitelist = await getWhitelistFromGitHub();
    const targetEntry = whitelist.find(entry => entry.Discord === targetUserId);

    if (!targetEntry) {
      return interaction.editReply({ content: 'User not found in whitelist' });
    }

    const newWhitelist = whitelist.filter(entry => entry.Discord !== targetUserId);
    await updateWhitelistOnGitHub(newWhitelist);

    try {
      const guild = interaction.guild;
      const member = await guild.members.fetch(targetUserId);
      
      const rolesToRemove = [
        config.ROLES.STANDARD,
        config.ROLES.PREMIUM,
        config.ROLES.ULTIMATE
      ].filter(Boolean).map(roleId => guild.roles.cache.get(roleId)).filter(role => role);

      if (member && rolesToRemove.length > 0) {
        await member.roles.remove(rolesToRemove);
      }
    } catch (roleError) {
      console.error('Role removal error:', roleError);
    }

    try {
      const user = await discordClient.users.fetch(targetUserId);
      const blacklistEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('🚨 You have been blacklisted')
        .setDescription('You have been blacklisted from our services.')
        .addFields(
          { name: 'Roblox Username', value: targetEntry.User, inline: true },
          { name: 'Whitelist Rank', value: targetEntry.Whitelist, inline: true },
          { name: 'Staff Member', value: interaction.user.tag, inline: false }
        );

      await user.send({ embeds: [blacklistEmbed] });
    } catch (dmError) {
      console.error('Failed to send DM:', dmError);
    }

    await interaction.editReply({ content: `Successfully blacklisted user ${robloxUsername} (${targetUserId})` });

    const logEmbed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('User Blacklisted')
      .addFields(
        { name: 'Target User', value: `<@${targetUserId}>`, inline: true },
        { name: 'Roblox Username', value: targetEntry.User, inline: true },
        { name: 'Whitelist Rank', value: targetEntry.Whitelist, inline: true },
        { name: 'Staff Member', value: interaction.user.toString(), inline: false }
      )
      .setTimestamp();

    const logChannel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
    await logChannel.send({ embeds: [logEmbed] });

  } catch (error) {
    console.error('Blacklist error:', error);
    await interaction.editReply({ content: 'Failed to blacklist user. Please try again or contact support.' });
  }
}

async function handleScriptDownload(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    
    const attachment = interaction.message.attachments.first();
    if (!attachment) {
      return interaction.editReply({ content: 'No script file found in this message' });
    }

    try {
      await interaction.user.send({
        content: 'Here is the script you requested:',
        files: [attachment.url]
      });
      await interaction.editReply({ content: 'Script sent to your DMs!' });
    } catch (dmError) {
      console.error('Failed to send DM:', dmError);
      await interaction.editReply({ content: 'Failed to send script. Please ensure your DMs are open.' });
    }
  } catch (error) {
    console.error('Download error:', error);
    await interaction.editReply({ content: 'An error occurred while processing your request.' });
  }
}

// Queue Endpoints
app.post('/queue/:username', (req, res) => {
  const username = req.params.username.toLowerCase();
  const scriptData = req.body;

  if (!Array.isArray(scriptData)) {
    return res.status(400).json({ status: 'error', message: 'Expected an array of script objects' });
  }

  // Store the scripts in the queue
  scriptQueues.set(username, scriptData);
  
  res.status(200).json({ 
    status: 'success', 
    message: `Scripts queued for ${username}`,
    count: scriptData.length
  });
});

app.get('/queue/:username', (req, res) => {
  if (!isFromRoblox(req)) {
    return res.status(403).json({ status: 'error', message: 'Roblox access only' });
  }

  const username = req.params.username.toLowerCase();
  const scripts = scriptQueues.get(username);

  if (!scripts || scripts.length === 0) {
    return res.status(404).json({ status: 'error', message: 'No scripts found for this user' });
  }

  // Remove the scripts from queue after retrieval
  scriptQueues.delete(username);
  
  res.status(200).json(scripts);
});

// Existing Routes
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
    console.error('Verification error:', error);
    res.status(500).json({ 
      status: 'error', 
      message: error.message || "Internal server error" 
    });
  }
});

app.get('/download/:assetId', async (req, res) => {
  try {
    const assetId = req.params.assetId;
    if (!/^\d+$/.test(assetId)) {
      return res.status(400).json({ status: 'error', message: 'Invalid asset ID' });
    }

    const fileName = `${assetId}.rbxm`;
    const content = `-- Roblox model reference: ${assetId}`;
    
    res.set({
      'Content-Type': 'text/plain',
      'Content-Disposition': `attachment; filename="${fileName}"`
    }).send(content);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ 
      status: 'error', 
      message: 'Failed to generate download' 
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
    
    await sendToDiscordChannel(embed, scriptContent);
    
    res.status(200).json({
      status: 'success',
      message: 'Log sent to Discord',
      logId: generateLogId()
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
    console.error('Script fetch error:', error);
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
      await handleBlacklist(interaction);
    } else if (interaction.customId === 'download_script') {
      await handleScriptDownload(interaction);
    }
  } catch (error) {
    console.error('Interaction error:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ 
        content: 'An error occurred while processing your request' 
      });
    } else {
      await interaction.reply({ 
        content: 'An error occurred',
        ephemeral: false 
      });
    }
  }
});

// Discord ready event
discordClient.on('ready', () => {
  console.log(`Logged in as ${discordClient.user.tag}`);
  discordClient.user.setStatus('dnd');
  discordClient.user.setActivity('Whitelist Manager', { type: 'WATCHING' });
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
