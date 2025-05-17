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
  LOG_CHANNEL_ID: '1331021897735081984', // Your specific channel ID
  GITHUB_REPO_OWNER: process.env.GITHUB_REPO_OWNER || 'RelaxxxX-Lab', // Example: 'YourGitHubUsername'
  GITHUB_REPO_NAME: process.env.GITHUB_REPO_NAME || 'Lua-things',   // Example: 'YourRepoName'
  GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
  WHITELIST_PATH: process.env.WHITELIST_PATH || 'Whitelist.json', // Path in your repo
  ROLES: {
    STANDARD: '1330552089759191064',
    PREMIUM: '1333286640248029264',
    ULTIMATE: '1337177751202828300'
  },
  PORT: process.env.PORT || 3000
};

// Validate essential config
if (!config.API_KEY || !config.GITHUB_TOKEN || !config.DISCORD_BOT_TOKEN || !config.GITHUB_LUA_MENU_URL) {
  console.error('FATAL ERROR: Missing essential environment variables. Please check your .env file.');
  process.exit(1);
}

// Initialize services
const app = express();
const octokit = new Octokit({
  auth: config.GITHUB_TOKEN,
  request: { timeout: 10000 } // Increased timeout for GitHub API
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
app.use(bodyParser.json({ limit: '10mb' })); // For script log payloads

// Helper functions
function generateLogId() {
  return crypto.randomBytes(8).toString('hex');
}

function isFromRoblox(req) {
  const userAgent = req.headers['user-agent'] || '';
  return userAgent.includes('Roblox'); // Roblox/WinInet is common for HttpService
}

async function getWhitelistFromGitHub() {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO_OWNER,
      repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH,
      ref: config.GITHUB_BRANCH,
      // GitHub API prefers to get raw content directly if possible
      // For JSON, this header ensures we get the JSON string directly
      headers: {
        'Accept': 'application/vnd.github.v3.raw'
      }
    });

    // If 'Accept' header worked as expected, data should be the raw string
    if (typeof data === 'string') {
      return JSON.parse(data);
    }
    // Fallback for older behavior or if data is an object with 'content'
    if (data && data.content) {
      return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    }
    // If response is already an object (parsed by Octokit somehow)
    if (typeof data === 'object' && data !== null) {
        return data;
    }

    console.warn('Unexpected GitHub response format for getWhitelistFromGitHub:', data);
    throw new Error('Unexpected GitHub response format while fetching whitelist.');
  } catch (error) {
    console.error(`GitHub API Error (getWhitelistFromGitHub) for ${config.WHITELIST_PATH}:`, error.status, error.message);
    if (error.status === 404) {
        throw new Error(`Whitelist file not found at ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}/${config.WHITELIST_PATH}`);
    }
    throw new Error('Failed to fetch whitelist from GitHub.');
  }
}

async function updateWhitelistOnGitHub(newWhitelist) {
  try {
    // First, get the current SHA of the file
    const { data: fileData } = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO_OWNER,
      repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH,
      ref: config.GITHUB_BRANCH
    });

    const response = await octokit.rest.repos.createOrUpdateFileContents({
      owner: config.GITHUB_REPO_OWNER,
      repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH,
      message: `Update whitelist via API (action: blacklist) - ${new Date().toISOString()}`,
      content: Buffer.from(JSON.stringify(newWhitelist, null, 2)).toString('base64'),
      sha: fileData.sha, // Must provide the current SHA
      branch: config.GITHUB_BRANCH
    });

    return response.status === 200 || response.status === 201; // 200 for update, 201 for create
  } catch (error) {
    console.error('GitHub API Error (updateWhitelistOnGitHub):', error.status, error.message);
    throw new Error('Failed to update whitelist on GitHub.');
  }
}

async function sendToDiscordChannel(embedData, scriptContent = null) {
  try {
    const channel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
    if (!channel) {
      console.error(`Discord channel with ID ${config.LOG_CHANNEL_ID} not found.`);
      throw new Error('Log channel not found.');
    }

    const embed = new EmbedBuilder(embedData); // Convert plain object to EmbedBuilder instance

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('blacklist_user_from_log') // More specific custom ID
          .setLabel('Blacklist User')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('download_script_from_log') // More specific custom ID
          .setLabel('Download Script')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!scriptContent || scriptContent.trim().length === 0) // Disable if no script
      );

    const messageOptions = {
      embeds: [embed],
      components: [row]
    };

    if (scriptContent && scriptContent.trim().length > 0) {
      // If script content is too large for an embed field, it's better as an attachment.
      // Discord embed field value limit is 1024 characters.
      // The Lua script already truncates to 1000 chars for the embed.
      // This attachment will contain that (up to) 1000 char script.
      if (scriptContent.length > 200) { // Arbitrary length to decide if it's "long" for an embed
         embed.setDescription(
            (embed.data.description || '').replace(
              /```lua\n[\s\S]*?\n```/,
              '```lua\n[Script content too long for embed, see attached file]\n```'
            )
          );
      }
      const buffer = Buffer.from(scriptContent, 'utf-8');
      const attachment = new AttachmentBuilder(buffer, { name: `script_log_${generateLogId()}.lua` });
      messageOptions.files = [attachment];
    }
    return channel.send(messageOptions);
  } catch (error) {
    console.error('Discord sendToDiscordChannel error:', error);
    // Don't re-throw if it's just a Discord sending issue, log it and move on.
  }
}

async function handleBlacklist(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const originalMessage = interaction.message;
    const embed = originalMessage.embeds[0];

    if (!embed || !embed.description) {
      return interaction.editReply({ content: 'Error: Could not find user information in the original message embed.' });
    }

    const discordIdMatch = embed.description.match(/Discord: <@!?(\d+)>/); // Allow for nicknames <@!id>
    const robloxUsernameMatch = embed.description.match(/Username: \*\*([^*]+)\*\*/); // Assuming username is bolded: **Username**
    
    if (!discordIdMatch || !discordIdMatch[1]) {
      return interaction.editReply({ content: 'Error: Could not extract Discord ID from the embed.' });
    }
    const targetUserId = discordIdMatch[1];
    const robloxUsername = robloxUsernameMatch ? robloxUsernameMatch[1] : 'Unknown Roblox User';

    let whitelist;
    try {
      whitelist = await getWhitelistFromGitHub();
    } catch (ghError) {
      return interaction.editReply({ content: `Error fetching whitelist: ${ghError.message}` });
    }
    
    const targetEntry = whitelist.find(entry => entry.Discord === targetUserId);

    if (!targetEntry) {
      return interaction.editReply({ content: `User <@${targetUserId}> (Roblox: ${robloxUsername}) not found in the whitelist. They might have already been removed.` });
    }

    const newWhitelist = whitelist.filter(entry => entry.Discord !== targetUserId);
    
    try {
      await updateWhitelistOnGitHub(newWhitelist);
    } catch (ghError) {
      return interaction.editReply({ content: `Error updating whitelist on GitHub: ${ghError.message}` });
    }

    // Attempt to remove roles in Discord
    try {
      const guild = interaction.guild;
      if (!guild) {
          console.warn("Blacklist interaction occurred outside of a guild context.");
      } else {
        const member = await guild.members.fetch(targetUserId).catch(() => null); // Fetch fresh member object
        if (member) {
          const rolesToRemoveIds = [config.ROLES.STANDARD, config.ROLES.PREMIUM, config.ROLES.ULTIMATE].filter(Boolean);
          const rolesToRemove = rolesToRemoveIds.map(roleId => guild.roles.cache.get(roleId)).filter(role => role && member.roles.cache.has(role.id));

          if (rolesToRemove.length > 0) {
            await member.roles.remove(rolesToRemove, `Blacklisted by ${interaction.user.tag}`);
            console.log(`Removed roles from ${targetUserId} due to blacklisting.`);
          }
        } else {
          console.warn(`User ${targetUserId} not found in guild ${guild.id} during blacklist role removal.`);
        }
      }
    } catch (roleError) {
      console.error(`Role removal error for ${targetUserId}:`, roleError);
      // Non-fatal, continue with blacklisting
    }

    // Attempt to DM the user
    try {
      const user = await discordClient.users.fetch(targetUserId);
      const blacklistEmbed = new EmbedBuilder()
        .setColor(0xFF0000) // Red
        .setTitle('🚨 You Have Been Blacklisted')
        .setDescription('You have been blacklisted from our services due to a violation or administrative action.')
        .addFields(
          { name: 'Roblox Username Affected', value: targetEntry.User || 'N/A', inline: true },
          { name: 'Previous Whitelist Tier', value: targetEntry.Whitelist || 'N/A', inline: true },
          { name: 'Action Taken By', value: interaction.user.tag, inline: false }
        )
        .setTimestamp()
        .setFooter({ text: 'Contact support if you believe this is an error.' });
      await user.send({ embeds: [blacklistEmbed] });
    } catch (dmError) {
      console.warn(`Failed to send blacklist DM to ${targetUserId}:`, dmError.message);
    }

    await interaction.editReply({ content: `Successfully blacklisted user ${robloxUsername} (<@${targetUserId}>). Whitelist updated and roles (if any) removed.` });

    // Log the blacklist action to the log channel
    const logChannel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID).catch(() => null);
    if (logChannel) {
      const logEmbed = new EmbedBuilder()
        .setColor(0xFF0000) // Red
        .setTitle('🛡️ User Blacklist Action')
        .addFields(
          { name: 'Target User', value: `<@${targetUserId}> (${targetUserId})`, inline: true },
          { name: 'Roblox Username', value: targetEntry.User, inline: true },
          { name: 'Previous Tier', value: targetEntry.Whitelist, inline: true },
          { name: 'Staff Member', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: false }
        )
        .setTimestamp()
        .setFooter({ text: 'Blacklist System Log' });
      await logChannel.send({ embeds: [logEmbed] });
    }

  } catch (error) {
    console.error('Blacklist command error:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'An unexpected error occurred while trying to blacklist the user.', ephemeral: true });
    } else {
      await interaction.editReply({ content: 'An unexpected error occurred. Please check logs or contact support.' });
    }
  }
}

async function handleScriptDownload(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const originalMessage = interaction.message;
    const attachment = originalMessage.attachments.first(); // Get the first attachment from the log message

    if (!attachment) {
      const embed = originalMessage.embeds[0];
      const scriptContentMatch = embed?.description?.match(/```lua\n([\s\S]*?)\n```/);
      const scriptContent = scriptContentMatch?.[1];

      if (scriptContent && scriptContent.trim().length > 0 && scriptContent.trim() !== '[Script content too long for embed, see attached file]' && scriptContent.trim() !== '[Script content available in attached file]') {
        // If script was in embed and not attached, send it now
        const buffer = Buffer.from(scriptContent, 'utf-8');
        const newAttachment = new AttachmentBuilder(buffer, { name: `retrieved_script_${generateLogId()}.lua` });
        try {
            await interaction.user.send({
                content: 'Here is the script content from the log:',
                files: [newAttachment]
            });
            return interaction.editReply({ content: 'Script content sent to your DMs!' });
        } catch (dmError) {
            console.warn('Failed to send script (from embed) DM:', dmError);
            return interaction.editReply({ content: 'Failed to send script to your DMs. Please ensure DMs are open from server members.' });
        }
      }
      return interaction.editReply({ content: 'No script attachment found in the original message, and no script content in embed.' });
    }

    // If attachment exists, send it
    try {
      await interaction.user.send({
        content: 'Here is the script file you requested from the log:',
        files: [attachment] // Send the existing attachment object
      });
      await interaction.editReply({ content: 'Script file sent to your DMs!' });
    } catch (dmError) {
      console.warn('Failed to send script (from attachment) DM:', dmError);
      await interaction.editReply({ content: 'Failed to send the script to your DMs. Please ensure DMs are open from server members.' });
    }
  } catch (error) {
    console.error('Download script command error:', error);
     if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'An unexpected error occurred while trying to send the script.', ephemeral: true });
    } else {
      await interaction.editReply({ content: 'An unexpected error occurred while processing your download request.' });
    }
  }
}

// --- Express Routes ---
app.get('/', (req, res) => {
  res.status(403).json({ status: 'error', message: 'Access Denied. This is a private API.' });
});

app.get('/verify/:username', async (req, res) => {
  if (!isFromRoblox(req)) {
    return res.status(403).json({ status: 'error', message: 'Access restricted to Roblox game clients.' });
  }

  const username = req.params.username;
  if (!username || typeof username !== 'string' || username.trim() === '') {
    return res.status(400).json({ status: 'error', message: 'Username parameter is required.' });
  }

  try {
    const whitelist = await getWhitelistFromGitHub();
    const foundUser = whitelist.find(user => user.User && user.User.toLowerCase() === username.toLowerCase());

    if (!foundUser) {
      return res.status(404).json({ status: 'error', message: "User not found in whitelist." });
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
    console.error(`Verification error for ${username}:`, error);
    res.status(500).json({
      status: 'error',
      message: error.message || "Internal server error during verification."
    });
  }
});

// This endpoint seems to generate a dummy rbxm file.
// If it's for actual asset delivery, it needs a source for the asset content.
app.get('/download/:assetId', async (req, res) => {
  // Consider if this needs Roblox User-Agent check too
  // if (!isFromRoblox(req)) {
  //   return res.status(403).json({ status: 'error', message: 'Access restricted to Roblox game clients.' });
  // }
  try {
    const assetId = req.params.assetId;
    if (!/^\d+$/.test(assetId)) {
      return res.status(400).json({ status: 'error', message: 'Invalid asset ID format. Must be numeric.' });
    }

    // This is placeholder content. Replace with actual asset fetching if needed.
    const fileName = `${assetId}.rbxm`; // Or .rbxmx for XML format
    const content = `-- Roblox model reference (AssetId: ${assetId})\n-- This is a placeholder file. Implement actual asset fetching if required.`;

    res.set({
      'Content-Type': 'application/octet-stream', // More appropriate for rbxm
      'Content-Disposition': `attachment; filename="${fileName}"`
    }).send(content);
  } catch (error) {
    console.error(`Download error for asset ${req.params.assetId}:`, error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate download.'
    });
  }
});

app.post('/send/scriptlogs', async (req, res) => {
  // Enforce Roblox User-Agent for this specific endpoint as requested
  if (!isFromRoblox(req)) {
    return res.status(403).json({ status: 'error', message: 'Access restricted: Only Roblox clients can send script logs.' });
  }

  const authKey = req.headers['authorization'];
  if (!authKey || authKey !== config.API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid or missing API key.' });
  }

  if (!req.body || typeof req.body.embeds !== 'object' || !Array.isArray(req.body.embeds) || req.body.embeds.length === 0) {
    return res.status(400).json({ status: 'error', message: 'Bad Request: Invalid or missing embed data in request body.' });
  }

  try {
    const embedData = req.body.embeds[0]; // Assuming the first embed is the main one
    
    // Extract script content from the description, if present
    // The Lua script puts the (potentially truncated) script here
    const description = embedData.description || '';
    const scriptContentMatch = description.match(/```lua\n([\s\S]*?)\n```/);
    const scriptContent = scriptContentMatch ? scriptContentMatch[1] : null;

    await sendToDiscordChannel(embedData, scriptContent);

    res.status(200).json({
      status: 'success',
      message: 'Log received and forwarded to Discord.',
      logId: generateLogId() // Generate a new ID for this server-side log receipt
    });
  } catch (error) {
    console.error('Error processing /send/scriptlogs:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || "Internal server error while processing script log."
    });
  }
});

app.get('/scripts/LuaMenu', async (req, res) => {
  if (!isFromRoblox(req)) {
    return res.status(403).json({ status: 'error', message: 'Access restricted to Roblox game clients.' });
  }

  try {
    const response = await axios.get(config.GITHUB_LUA_MENU_URL, {
      timeout: 8000, // Slightly increased timeout for external HTTP request
      headers: {
        'User-Agent': 'LuaWhitelistServer/1.1' // Custom User-Agent for this request
      }
    });

    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' // Security header
    }).send(response.data);
  } catch (error) {
    console.error('Error fetching LuaMenu script:', error.isAxiosError ? error.message : error);
    const statusCode = error.response ? error.response.status : 500;
    res.status(statusCode).json({
      status: 'error',
      message: error.message || 'Failed to load LuaMenu script from source.'
    });
  }
});

// --- Discord Event Handlers ---
discordClient.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  try {
    if (interaction.customId === 'blacklist_user_from_log') {
      await handleBlacklist(interaction);
    } else if (interaction.customId === 'download_script_from_log') {
      await handleScriptDownload(interaction);
    }
    // Add other button handlers here if needed
  } catch (error) {
    console.error('Unhandled error in interactionCreate:', error);
    const replyOptions = { content: 'An unexpected error occurred while processing your action. Please try again later.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(replyOptions).catch(console.error);
    } else {
      await interaction.reply(replyOptions).catch(console.error);
    }
  }
});

discordClient.on('ready', () => {
  console.log(`Discord Bot logged in as ${discordClient.user.tag}`);
  discordClient.user.setStatus('dnd'); // Do Not Disturb
  discordClient.user.setActivity('Managing Whitelists', { type: 'WATCHING' }); // Using ActivityType.Watching
  console.log(`Bot is in ${discordClient.guilds.cache.size} guilds.`);
});

// --- Global Error Handlers ---
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Optionally, add more sophisticated error reporting here (e.g., to Sentry)
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // It's often recommended to gracefully shut down after an uncaught exception
  // process.exit(1); // Uncomment if you want to exit on uncaught exceptions
});

// --- Start Services ---
async function startServer() {
  try {
    await discordClient.login(config.DISCORD_BOT_TOKEN);
    console.log('Discord bot successfully connected.');

    app.listen(config.PORT, () => {
      console.log(`API server running on http://localhost:${config.PORT}`);
      console.log(`GitHub Repo: ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}, Branch: ${config.GITHUB_BRANCH}, Whitelist Path: ${config.WHITELIST_PATH}`);
    });
  } catch (error) {
    console.error('Failed to start services:', error);
    process.exit(1);
  }
}

startServer();
