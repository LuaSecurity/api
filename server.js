require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder, ActivityType } = require('discord.js');

// Config from environment variables
const config = {
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_LUA_MENU_URL: process.env.GITHUB_LUA_MENU_URL,
  LOG_CHANNEL_ID: '1331021897735081984',
  GITHUB_REPO_OWNER: process.env.GITHUB_REPO_OWNER || 'RelaxxxX-Lab',
  GITHUB_REPO_NAME: process.env.GITHUB_REPO_NAME || 'Lua-things',
  GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
  WHITELIST_PATH: process.env.WHITELIST_PATH || 'Whitelist.json',
  ROLES: {
    STANDARD: '1330552089759191064',
    PREMIUM: '1333286640248029264',
    ULTIMATE: '1337177751202828300'
  },
  PORT: process.env.PORT || 3000,
  SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT: 100
};

if (!config.API_KEY || !config.GITHUB_TOKEN || !config.DISCORD_BOT_TOKEN || !config.GITHUB_LUA_MENU_URL) {
  console.error('FATAL ERROR: Missing essential environment variables.');
  process.exit(1);
}

const app = express();
const octokit = new Octokit({ auth: config.GITHUB_TOKEN, request: { timeout: 10000 } });
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers
  ]
});

app.use(bodyParser.json({ limit: '10mb' }));

function generateLogId() { return crypto.randomBytes(8).toString('hex'); }
function isFromRoblox(req) { return (req.headers['user-agent'] || '').includes('Roblox'); }

async function getWhitelistFromGitHub() {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO_OWNER, repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH, ref: config.GITHUB_BRANCH,
      headers: { 'Accept': 'application/vnd.github.v3.raw' }
    });
    if (typeof data === 'string') return JSON.parse(data);
    if (data && data.content) return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    if (typeof data === 'object' && data !== null) return data;
    throw new Error('Unexpected GitHub response for getWhitelistFromGitHub.');
  } catch (error) {
    console.error(`GitHub API Error (getWhitelist):`, error.status, error.message);
    if (error.status === 404) throw new Error(`Whitelist file not found: ${config.WHITELIST_PATH}`);
    throw new Error('Failed to fetch whitelist from GitHub.');
  }
}

async function updateWhitelistOnGitHub(newWhitelist, actionMessage = 'Update whitelist') {
  try {
    const { data: fileData } = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO_OWNER, repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH, ref: config.GITHUB_BRANCH
    });
    await octokit.rest.repos.createOrUpdateFileContents({
      owner: config.GITHUB_REPO_OWNER, repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH,
      message: `${actionMessage} - ${new Date().toISOString()}`,
      content: Buffer.from(JSON.stringify(newWhitelist, null, 2)).toString('base64'),
      sha: fileData.sha, branch: config.GITHUB_BRANCH
    });
    return true;
  } catch (error) {
    console.error('GitHub API Error (updateWhitelist):', error.status, error.message);
    throw new Error('Failed to update whitelist on GitHub.');
  }
}

const SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT = '[Full script content attached as a .lua file due to length.]';
const SCRIPT_IN_ATTACHMENT_PLACEHOLDER = '```lua\n' + SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT + '\n```';

async function sendToDiscordChannel(embedData, fullScriptContent = null) {
  try {
    const channel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
    if (!channel) throw new Error('Log channel not found.');

    const embed = new EmbedBuilder(embedData);
    const messageOptions = { embeds: [embed], components: [] };

    if (fullScriptContent && fullScriptContent.trim().length > 0) {
      if (fullScriptContent.length > config.SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT) {
        embed.setDescription((embed.data.description || '').replace(/```lua\n[\s\S]*?\n```/, SCRIPT_IN_ATTACHMENT_PLACEHOLDER));
        messageOptions.files = [new AttachmentBuilder(Buffer.from(fullScriptContent, 'utf-8'), { name: `script_log_${generateLogId()}.lua` })];
      }
    }

    messageOptions.components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('blacklist_user_from_log').setLabel('Blacklist User').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('get_asset_script_from_log').setLabel('Get Asset/Script').setStyle(ButtonStyle.Primary)
        .setDisabled(!fullScriptContent || fullScriptContent.trim().length === 0)
    ));
    return channel.send(messageOptions);
  } catch (error) { console.error('Discord sendToDiscordChannel error:', error); }
}

async function handleBlacklist(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const originalMessage = interaction.message;
    const embed = originalMessage.embeds[0];

    if (!embed || !embed.description) {
      return interaction.editReply({ content: 'Error: Could not find user information in the original message embed.' });
    }

    const descriptionToSearch = embed.description;
    console.log("Attempting blacklist. Embed Description for regex debugging (raw):");
    console.log(JSON.stringify(descriptionToSearch)); // Shows all characters like \n

    // ENHANCED REGEX with case-insensitivity and flexible spacing
    const discordIdRegex = /discord:\s*<@!?(\d+)>/i;
    const discordIdMatch = descriptionToSearch.match(discordIdRegex);

    // Username regex remains the same as it seems to work
    const robloxUsernameRegex = /\*\*Username:\*\* \*\*([^*]+)\*\*/;
    const robloxUsernameMatch = descriptionToSearch.match(robloxUsernameRegex);

    if (!discordIdMatch || !discordIdMatch[1]) {
      console.error(`Failed to match Discord ID. Regex used: ${discordIdRegex.toString()}`);
      return interaction.editReply({ content: 'Error: Could not extract Discord ID from the embed. Please check the log format.' });
    }
    const targetUserId = discordIdMatch[1];
    const robloxUsername = robloxUsernameMatch ? robloxUsernameMatch[1] : 'Unknown Roblox User';
    console.log(`Extracted for blacklist: Discord ID=${targetUserId}, Roblox User=${robloxUsername}`);

    let whitelist = await getWhitelistFromGitHub();
    const targetEntryIndex = whitelist.findIndex(entry => entry.Discord === targetUserId);

    if (targetEntryIndex === -1) {
      return interaction.editReply({ content: `User <@${targetUserId}> (Roblox: ${robloxUsername}) not found in whitelist.` });
    }
    const targetEntry = whitelist[targetEntryIndex];
    const newWhitelist = whitelist.filter(entry => entry.Discord !== targetUserId);

    await updateWhitelistOnGitHub(newWhitelist, `Blacklist ${targetEntry.User} by ${interaction.user.tag}`);

    let rolesRemovedMessage = "User not in this server or no relevant roles.";
    if (interaction.guild) {
      const member = await interaction.guild.members.fetch(targetUserId).catch(() => null);
      if (member) {
        const rolesToRemoveIds = [config.ROLES.STANDARD, config.ROLES.PREMIUM, config.ROLES.ULTIMATE].filter(Boolean);
        const removedRoleNames = [];
        for (const roleId of rolesToRemoveIds) {
          if (member.roles.cache.has(roleId)) {
            try {
              await member.roles.remove(roleId, `Blacklisted by ${interaction.user.tag}`);
              removedRoleNames.push(interaction.guild.roles.cache.get(roleId)?.name || roleId);
            } catch (e) { console.warn(`Failed to remove role ${roleId} from ${targetUserId}:`, e); }
          }
        }
        if (removedRoleNames.length > 0) rolesRemovedMessage = `Removed roles: ${removedRoleNames.join(', ')}.`;
        else rolesRemovedMessage = "User had no relevant roles to remove.";
      }
    }

    try {
      const user = await discordClient.users.fetch(targetUserId);
      await user.send({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('🚨 You Have Been Blacklisted')
        .setDescription('You have been blacklisted from our services.')
        .addFields(
          { name: 'Roblox Username', value: targetEntry.User || 'N/A', inline: true },
          { name: 'Previous Tier', value: targetEntry.Whitelist || 'N/A', inline: true },
          { name: 'By Staff', value: interaction.user.tag, inline: false }
        ).setTimestamp()]});
    } catch (e) { console.warn(`Failed to DM ${targetUserId} about blacklist:`, e.message); }

    await interaction.editReply({ content: `Blacklisted ${robloxUsername} (<@${targetUserId}>). ${rolesRemovedMessage}` });

    const logChannel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID).catch(() => null);
    if (logChannel) {
      await logChannel.send({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('🛡️ User Blacklist Action')
        .addFields(
          { name: 'Target', value: `<@${targetUserId}> (${targetUserId})`, inline: true },
          { name: 'Roblox User', value: targetEntry.User, inline: true },
          { name: 'Previous Tier', value: targetEntry.Whitelist, inline: true },
          { name: 'Staff', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: false },
          { name: 'Role Status', value: rolesRemovedMessage, inline: false }
        ).setTimestamp()]});
    }
  } catch (error) {
    console.error('Blacklist command error:', error);
    await interaction.editReply({ content: 'An unexpected error occurred during blacklisting.' }).catch(console.error);
  }
}

async function handleGetAssetOrScript(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const originalMessage = interaction.message;
    let scriptContentToAnalyze = null;

    const logAttachment = originalMessage.attachments.first();
    if (logAttachment?.name.endsWith('.lua')) {
      scriptContentToAnalyze = (await axios.get(logAttachment.url, { responseType: 'text' })).data;
    } else {
      const embed = originalMessage.embeds[0];
      if (embed?.description) {
        const match = embed.description.match(/```lua\n([\s\S]*?)\n```/);
        if (match && match[1] !== SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT) {
          scriptContentToAnalyze = match[1];
        }
      }
    }

    if (!scriptContentToAnalyze) {
      return interaction.editReply({ content: 'No script content found to analyze.' });
    }

    const scriptFile = new AttachmentBuilder(Buffer.from(scriptContentToAnalyze, 'utf-8'), { name: `retrieved_script_${generateLogId()}.lua` });
    const assetIds = new Set();
    const regexes = [
      /require\s*\(\s*(\d+)\s*\)/g,
      /(?:GetObjects|InsertService:LoadAsset(?:Version)?)\s*\(\s*(?:["']rbxassetid:\/\/(\d+)["']|(\d+))\s*\)/gi,
      /Content\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi,
      /Image\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi,
      /Texture(?:Id)?\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi,
      /SoundId\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi,
      /MeshId\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi,
    ];

    for (const regex of regexes) {
      let match;
      while ((match = regex.exec(scriptContentToAnalyze)) !== null) {
        assetIds.add(match[1] || match[2]); // Handles multiple capture groups
      }
    }
    
    const uniqueAssetIds = Array.from(assetIds).filter(Boolean);
    let replyContent = "Script content attached.";
    if (uniqueAssetIds.length > 0) {
      const assetLinks = uniqueAssetIds.map(id => `[${id}](https://www.roblox.com/library/${id})`).join('\n');
      replyContent = `Found Asset ID(s):\n${assetLinks}\n\nFull script attached.`;
    }

    await interaction.editReply({ content: replyContent, files: [scriptFile], ephemeral: true });
  } catch (error) {
    console.error('Get Asset/Script error:', error);
    await interaction.editReply({ content: 'Error processing request.' }).catch(console.error);
  }
}

// --- Express Routes (Simplified for brevity, no changes here from previous correct version) ---
app.get('/', (req, res) => res.status(403).json({ status: 'error', message: 'Access Denied.' }));

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
    console.error(`Verify error for ${username}:`, error.message);
    res.status(500).json({ status: 'error', message: "Internal server error." });
  }
});

app.get('/download/:assetId', async (req, res) => { // Placeholder
  const assetId = req.params.assetId;
  if (!/^\d+$/.test(assetId)) return res.status(400).json({ status: 'error', message: 'Invalid asset ID.' });
  res.set({ 'Content-Type': 'text/plain', 'Content-Disposition': `attachment; filename="${assetId}.rbxm"` })
     .send(`-- Roblox model (AssetId: ${assetId}) - Placeholder`);
});

app.post('/send/scriptlogs', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  if (req.headers['authorization'] !== config.API_KEY) return res.status(401).json({ status: 'error', message: 'Invalid API key.' });
  if (!req.body?.embeds?.length) return res.status(400).json({ status: 'error', message: 'Invalid embed data.' });
  try {
    const embedData = req.body.embeds[0];
    const scriptMatch = (embedData.description || '').match(/```lua\n([\s\S]*?)\n```/);
    await sendToDiscordChannel(embedData, scriptMatch ? scriptMatch[1] : null);
    res.status(200).json({ status: 'success', message: 'Log received.', logId: generateLogId() });
  } catch (error) {
    console.error('Error /send/scriptlogs:', error.message);
    res.status(500).json({ status: 'error', message: "Processing script log failed." });
  }
});

app.get('/scripts/LuaMenu', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  try {
    const response = await axios.get(config.GITHUB_LUA_MENU_URL, { timeout: 8000, headers: { 'User-Agent': 'LuaWhitelistServer/1.5' }});
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).send(response.data);
  } catch (error) {
    console.error('Error /scripts/LuaMenu:', error.message);
    res.status(error.response?.status || 500).json({ status: 'error', message: 'Failed to load LuaMenu script.' });
  }
});

discordClient.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  try {
    if (interaction.customId === 'blacklist_user_from_log') await handleBlacklist(interaction);
    else if (interaction.customId === 'get_asset_script_from_log') await handleGetAssetOrScript(interaction);
  } catch (error) {
    console.error('Interaction error:', error);
    if (interaction.replied || interaction.deferred) await interaction.editReply({ content: 'Error processing.', ephemeral: true}).catch(console.error);
    else await interaction.reply({ content: 'Error processing.', ephemeral: true }).catch(console.error);
  }
});

discordClient.on('ready', () => {
  console.log(`Bot logged in as ${discordClient.user.tag} in ${discordClient.guilds.cache.size} guilds.`);
  discordClient.user.setStatus('dnd');
  discordClient.user.setActivity('Managing Whitelists', { type: ActivityType.Watching });
});

process.on('unhandledRejection', (r, p) => console.error('Unhandled Rejection:', r, p));
process.on('uncaughtException', e => console.error('Uncaught Exception:', e));

async function startServer() {
  try {
    await discordClient.login(config.DISCORD_BOT_TOKEN);
    app.listen(config.PORT, () => console.log(`API on http://localhost:${config.PORT}, Bot connected.`));
  } catch (error) { console.error('Startup failed:', error); process.exit(1); }
}

startServer();
