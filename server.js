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
  GITHUB_REPO_OWNER: 'RelaxxxX-Lab',
  GITHUB_REPO_NAME: 'Lua-things',
  GITHUB_BRANCH: 'main',
  WHITELIST_PATH: 'Whitelist.json',
  ROLES: {
    STANDARD: '1330552089759191064',
    PREMIUM: '1333286640248029264',
    ULTIMATE: '1337177751202828300'
  },
  PORT: process.env.PORT || 3000,
  SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT: 100 // New config for character limit
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
  request: { timeout: 10000 }
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

async function getWhitelistFromGitHub() {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO_OWNER,
      repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH,
      ref: config.GITHUB_BRANCH,
      headers: { 'Accept': 'application/vnd.github.v3.raw' }
    });
    if (typeof data === 'string') return JSON.parse(data);
    if (data && data.content) return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    if (typeof data === 'object' && data !== null) return data;
    throw new Error('Unexpected GitHub response format while fetching whitelist.');
  } catch (error) {
    console.error(`GitHub API Error (getWhitelistFromGitHub) for ${config.WHITELIST_PATH}:`, error.status, error.message);
    if (error.status === 404) throw new Error(`Whitelist file not found at ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}/${config.WHITELIST_PATH}`);
    throw new Error('Failed to fetch whitelist from GitHub.');
  }
}

async function updateWhitelistOnGitHub(newWhitelist) {
  try {
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
      sha: fileData.sha,
      branch: config.GITHUB_BRANCH
    });
    return response.status === 200 || response.status === 201;
  } catch (error) {
    console.error('GitHub API Error (updateWhitelistOnGitHub):', error.status, error.message);
    throw new Error('Failed to update whitelist on GitHub.');
  }
}

const SCRIPT_IN_ATTACHMENT_PLACEHOLDER = '```lua\n[Full script content attached as a .lua file due to length.]\n```';

async function sendToDiscordChannel(embedData, fullScriptContent = null) {
  try {
    const channel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
    if (!channel) {
      console.error(`Discord channel with ID ${config.LOG_CHANNEL_ID} not found.`);
      throw new Error('Log channel not found.');
    }

    const embed = new EmbedBuilder(embedData); // Convert plain object to EmbedBuilder instance
    const messageOptions = { embeds: [embed], components: [] };
    let scriptFileAttachment = null;

    // Decide whether to attach script as file or keep in embed
    if (fullScriptContent && fullScriptContent.trim().length > 0) {
      if (fullScriptContent.length > config.SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT) {
        // Script is long, attach as file and modify embed description
        const currentDescription = embed.data.description || '';
        embed.setDescription(
          currentDescription.replace(
            /```lua\n[\s\S]*?\n```/, // Regex to find the script block
            SCRIPT_IN_ATTACHMENT_PLACEHOLDER
          )
        );
        const buffer = Buffer.from(fullScriptContent, 'utf-8');
        scriptFileAttachment = new AttachmentBuilder(buffer, { name: `script_log_${generateLogId()}.lua` });
        messageOptions.files = [scriptFileAttachment];
      } else {
        // Script is short, it's already in embed.data.description from the payload
        // No change needed to embed description for script content itself
      }
    }

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('blacklist_user_from_log')
          .setLabel('Blacklist User')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('download_script_from_log')
          .setLabel('Download Script')
          .setStyle(ButtonStyle.Primary)
          // Disable if there's truly no script content (e.g. if Lua somehow sent empty script)
          .setDisabled(!fullScriptContent || fullScriptContent.trim().length === 0)
      );
    messageOptions.components.push(row);

    return channel.send(messageOptions);
  } catch (error) {
    console.error('Discord sendToDiscordChannel error:', error);
    // Don't re-throw, log and allow caller to proceed if non-critical
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
    // Regex updated to match bolded username from Lua script
    const discordIdMatch = embed.description.match(/Discord: <@!?(\d+)>/);
    const robloxUsernameMatch = embed.description.match(/\*\*Username:\*\* \*\*([^*]+)\*\*/);


    if (!discordIdMatch || !discordIdMatch[1]) {
      return interaction.editReply({ content: 'Error: Could not extract Discord ID from the embed.' });
    }
    const targetUserId = discordIdMatch[1];
    const robloxUsername = robloxUsernameMatch ? robloxUsernameMatch[1] : 'Unknown Roblox User';

    let whitelist;
    try { whitelist = await getWhitelistFromGitHub(); }
    catch (ghError) { return interaction.editReply({ content: `Error fetching whitelist: ${ghError.message}` }); }

    const targetEntry = whitelist.find(entry => entry.Discord === targetUserId);
    if (!targetEntry) return interaction.editReply({ content: `User <@${targetUserId}> (Roblox: ${robloxUsername}) not found in the whitelist.` });

    const newWhitelist = whitelist.filter(entry => entry.Discord !== targetUserId);
    try { await updateWhitelistOnGitHub(newWhitelist); }
    catch (ghError) { return interaction.editReply({ content: `Error updating whitelist on GitHub: ${ghError.message}` }); }

    try {
      const guild = interaction.guild;
      if (guild) {
        const member = await guild.members.fetch(targetUserId).catch(() => null);
        if (member) {
          const rolesToRemoveIds = [config.ROLES.STANDARD, config.ROLES.PREMIUM, config.ROLES.ULTIMATE].filter(Boolean);
          const rolesToRemove = rolesToRemoveIds.map(roleId => guild.roles.cache.get(roleId)).filter(role => role && member.roles.cache.has(role.id));
          if (rolesToRemove.length > 0) await member.roles.remove(rolesToRemove, `Blacklisted by ${interaction.user.tag}`);
        }
      }
    } catch (roleError) { console.error(`Role removal error for ${targetUserId}:`, roleError); }

    try {
      const user = await discordClient.users.fetch(targetUserId);
      const blacklistDmEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('🚨 You Have Been Blacklisted')
        .setDescription('You have been blacklisted from our services.')
        .addFields(
          { name: 'Roblox Username Affected', value: targetEntry.User || 'N/A', inline: true },
          { name: 'Previous Whitelist Tier', value: targetEntry.Whitelist || 'N/A', inline: true },
          { name: 'Action Taken By', value: interaction.user.tag, inline: false }
        ).setTimestamp();
      await user.send({ embeds: [blacklistDmEmbed] });
    } catch (dmError) { console.warn(`Failed to send blacklist DM to ${targetUserId}:`, dmError.message); }

    await interaction.editReply({ content: `Successfully blacklisted user ${robloxUsername} (<@${targetUserId}>).` });

    const logChannel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID).catch(() => null);
    if (logChannel) {
      const logEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('🛡️ User Blacklist Action')
        .addFields(
          { name: 'Target User', value: `<@${targetUserId}> (${targetUserId})`, inline: true },
          { name: 'Roblox Username', value: targetEntry.User, inline: true },
          { name: 'Previous Tier', value: targetEntry.Whitelist, inline: true },
          { name: 'Staff Member', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: false }
        ).setTimestamp();
      await logChannel.send({ embeds: [logEmbed] });
    }
  } catch (error) {
    console.error('Blacklist command error:', error);
    const errReply = { content: 'An unexpected error occurred while blacklisting.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.editReply(errReply).catch(console.error);
    else await interaction.reply(errReply).catch(console.error);
  }
}

async function handleScriptDownload(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const originalMessage = interaction.message;
    let scriptToDmContent = null;
    let scriptFileName = `downloaded_script_${generateLogId()}.lua`;

    const attachment = originalMessage.attachments.first();
    if (attachment) {
      // If there's an attachment, it's the definitive script source
      try {
        await interaction.user.send({
          content: 'Here is the script file you requested from the log:',
          files: [attachment] // Send the existing attachment object
        });
        return interaction.editReply({ content: 'Script file sent to your DMs!' });
      } catch (dmError) {
        console.warn('Failed to send script (from attachment) DM:', dmError);
        return interaction.editReply({ content: 'Failed to send the script to your DMs. Please ensure DMs are open from server members.' });
      }
    }

    // No direct attachment, try to extract from embed (for short scripts)
    const embed = originalMessage.embeds[0];
    if (embed && embed.description) {
      const scriptContentMatch = embed.description.match(/```lua\n([\s\S]*?)\n```/);
      const extractedScript = scriptContentMatch ? scriptContentMatch[1] : null;

      // Check if the extracted content is the placeholder
      if (extractedScript && extractedScript.trim() !== SCRIPT_IN_ATTACHMENT_PLACEHOLDER.match(/```lua\n([\s\S]*?)\n```/)[1].trim()) {
        scriptToDmContent = extractedScript;
      }
    }

    if (scriptToDmContent) {
      const buffer = Buffer.from(scriptToDmContent, 'utf-8');
      const newAttachment = new AttachmentBuilder(buffer, { name: scriptFileName });
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

    return interaction.editReply({ content: 'No downloadable script content found in this log entry (it might have been too long and the original attachment is missing, or the log is malformed).' });

  } catch (error) {
    console.error('Download script command error:', error);
    const errReply = { content: 'An unexpected error occurred while processing your download request.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.editReply(errReply).catch(console.error);
    else await interaction.reply(errReply).catch(console.error);
  }
}

// --- Express Routes ---
app.get('/', (req, res) => {
  res.status(403).json({ status: 'error', message: 'Access Denied.' });
});

app.get('/verify/:username', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  const username = req.params.username;
  if (!username) return res.status(400).json({ status: 'error', message: 'Username required.' });
  try {
    const whitelist = await getWhitelistFromGitHub();
    const foundUser = whitelist.find(user => user.User && user.User.toLowerCase() === username.toLowerCase());
    if (!foundUser) return res.status(404).json({ status: 'error', message: "User not found." });
    res.json({ status: 'success', data: { username: foundUser.User, discordId: foundUser.Discord, tier: foundUser.Whitelist } });
  } catch (error) {
    console.error(`Verification error for ${username}:`, error);
    res.status(500).json({ status: 'error', message: error.message || "Internal server error." });
  }
});

app.get('/download/:assetId', async (req, res) => {
  try {
    const assetId = req.params.assetId;
    if (!/^\d+$/.test(assetId)) return res.status(400).json({ status: 'error', message: 'Invalid asset ID.' });
    const fileName = `${assetId}.rbxm`;
    const content = `-- Roblox model reference (AssetId: ${assetId})`;
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${fileName}"` }).send(content);
  } catch (error) {
    console.error(`Download error for asset ${req.params.assetId}:`, error);
    res.status(500).json({ status: 'error', message: 'Failed to generate download.' });
  }
});

app.post('/send/scriptlogs', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  const authKey = req.headers['authorization'];
  if (!authKey || authKey !== config.API_KEY) return res.status(401).json({ status: 'error', message: 'Invalid API key.' });
  if (!req.body?.embeds?.length) return res.status(400).json({ status: 'error', message: 'Invalid embed data.' });

  try {
    const embedDataFromPayload = req.body.embeds[0];
    const description = embedDataFromPayload.description || '';
    // Extract the full script content from the incoming payload's description
    const scriptContentMatch = description.match(/```lua\n([\s\S]*?)\n```/);
    const fullScriptContent = scriptContentMatch ? scriptContentMatch[1] : null;

    // Pass the original embedData and the extracted fullScriptContent
    await sendToDiscordChannel(embedDataFromPayload, fullScriptContent);

    res.status(200).json({ status: 'success', message: 'Log received.', logId: generateLogId() });
  } catch (error) {
    console.error('Error processing /send/scriptlogs:', error);
    res.status(500).json({ status: 'error', message: error.message || "Processing script log failed." });
  }
});

app.get('/scripts/LuaMenu', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  try {
    const response = await axios.get(config.GITHUB_LUA_MENU_URL, {
      timeout: 8000,
      headers: { 'User-Agent': 'LuaWhitelistServer/1.2' }
    });
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache', 'Expires': '0', 'Surrogate-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }).send(response.data);
  } catch (error) {
    console.error('Error fetching LuaMenu script:', error.isAxiosError ? error.message : error);
    res.status(error.response?.status || 500).json({ status: 'error', message: error.message || 'Failed to load LuaMenu script.' });
  }
});

// --- Discord Event Handlers ---
discordClient.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  try {
    if (interaction.customId === 'blacklist_user_from_log') await handleBlacklist(interaction);
    else if (interaction.customId === 'download_script_from_log') await handleScriptDownload(interaction);
  } catch (error) {
    console.error('Unhandled error in interactionCreate:', error);
    const replyOptions = { content: 'An error occurred.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.editReply(replyOptions).catch(console.error);
    else await interaction.reply(replyOptions).catch(console.error);
  }
});

discordClient.on('ready', () => {
  console.log(`Discord Bot logged in as ${discordClient.user.tag}`);
  discordClient.user.setStatus('dnd');
  discordClient.user.setActivity('Managing Whitelists', { type: 3 }); // 3 = Watching
  console.log(`Bot is in ${discordClient.guilds.cache.size} guilds.`);
});

process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', reason, promise));
process.on('uncaughtException', (error) => console.error('Uncaught Exception:', error));

async function startServer() {
  try {
    await discordClient.login(config.DISCORD_BOT_TOKEN);
    console.log('Discord bot successfully connected.');
    app.listen(config.PORT, () => {
      console.log(`API server running on http://localhost:${config.PORT}`);
    });
  } catch (error) {
    console.error('Failed to start services:', error);
    process.exit(1);
  }
}

startServer();
