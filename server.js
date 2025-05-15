require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

// Config from environment variables
const config = {
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_LUA_MENU_URL: process.env.GITHUB_LUA_MENU_URL,
  LOG_CHANNEL_ID: '1331021897735081984',
  GITHUB_REPO: 'RelaxxxX-Lab/Lua-things',
  GITHUB_BRANCH: 'main',
  WHITELIST_PATH: 'Whitelist.json'
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
          .setCustomId('download')
          .setLabel('Download')
          .setStyle(ButtonStyle.Primary)
      );

    const messageOptions = {
      embeds: [embedData],
      components: [row]
    };

    // If script is longer than 100 chars, send as file only
    if (scriptContent && scriptContent.length > 100) {
      messageOptions.files = [{ attachment: Buffer.from(scriptContent, 'utf-8'), name: 'script.lua' }];
      // Remove script content from embed
      embedData.description = embedData.description.replace(/```lua\n[\s\S]*?\n```/, '```lua\n[Script content too long - see attached file]\n```');
    }

    return channel.send(messageOptions);
  } catch (error) {
    console.error('Discord send error:', error);
    throw error;
  }
}

async function handleBlacklist(interaction, targetUserId) {
  try {
    await interaction.deferReply({ ephemeral: true });

    // Get whitelist from GitHub
    const whitelist = await getWhitelistFromGitHub();
    const targetEntry = whitelist.find(entry => entry.Discord === targetUserId);

    if (!targetEntry) {
      return interaction.editReply({ content: 'User not found in whitelist' });
    }

    // Remove from whitelist
    const newWhitelist = whitelist.filter(entry => entry.Discord !== targetUserId);
    await updateWhitelistOnGitHub(newWhitelist);

    // Remove roles from user
    const guild = interaction.guild;
    const member = await guild.members.fetch(targetUserId);
    
    const rolesToRemove = [
      guild.roles.cache.find(role => role.name === 'Standard'),
      guild.roles.cache.find(role => role.name === 'Premium'),
      guild.roles.cache.find(role => role.name === 'Ultimate')
    ].filter(role => role);

    if (member && rolesToRemove.length > 0) {
      await member.roles.remove(rolesToRemove);
    }

    // Send DM to blacklisted user
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

    await interaction.editReply({ content: `Successfully blacklisted user ${targetUserId}` });

    // Log the action
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
    await interaction.editReply({ content: 'Failed to blacklist user' });
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
    console.error('Verification error:', error);
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
      // Extract user ID from embed
      const targetUserId = interaction.message.embeds[0]?.description?.match(/Discord: <@(%d+)>/)?.[1];
      if (!targetUserId) {
        return interaction.reply({ content: 'Could not identify user to blacklist', ephemeral: true });
      }
      
      await handleBlacklist(interaction, targetUserId);
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
