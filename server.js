require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder, ActivityType } = require('discord.js'); // Added ActivityType

// Config from environment variables
const config = {
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_LUA_MENU_URL: process.env.GITHUB_LUA_MENU_URL,
  LOG_CHANNEL_ID: '1331021897735081984',
  GITHUB_REPO_OWNER: process.env.GITHUB_REPO_OWNER || 'RelaxxxX-Lab', // Defaulting to your values
  GITHUB_REPO_NAME: process.env.GITHUB_REPO_NAME || 'Lua-things',   // Defaulting to your values
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

// Validate essential config
if (!config.API_KEY || !config.GITHUB_TOKEN || !config.DISCORD_BOT_TOKEN || !config.GITHUB_LUA_MENU_URL) {
  console.error('FATAL ERROR: Missing essential environment variables. Please check your .env file or set them directly if not using .env for GITHUB_REPO_OWNER etc.');
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
    if (typeof data === 'object' && data !== null) return data; // Should already be parsed by Octokit if raw isn't available
    console.warn('Unexpected GitHub response format for getWhitelistFromGitHub:', data);
    throw new Error('Unexpected GitHub response format while fetching whitelist.');
  } catch (error) {
    console.error(`GitHub API Error (getWhitelistFromGitHub) for ${config.WHITELIST_PATH}:`, error.status, error.message);
    if (error.status === 404) throw new Error(`Whitelist file not found at ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}/${config.WHITELIST_PATH}`);
    throw new Error('Failed to fetch whitelist from GitHub.');
  }
}

async function updateWhitelistOnGitHub(newWhitelist, actionMessage = 'Update whitelist') {
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
      message: `${actionMessage} - ${new Date().toISOString()}`,
      content: Buffer.from(JSON.stringify(newWhitelist, null, 2)).toString('base64'),
      sha: fileData.sha,
      branch: config.GITHUB_BRANCH
    });
    return response.status === 200 || response.status === 201; // 200 for update, 201 for create (though unlikely here)
  } catch (error) {
    console.error('GitHub API Error (updateWhitelistOnGitHub):', error.status, error.message);
    throw new Error('Failed to update whitelist on GitHub.');
  }
}

const SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT = '[Full script content attached as a .lua file due to length.]';
const SCRIPT_IN_ATTACHMENT_PLACEHOLDER = '```lua\n' + SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT + '\n```';


async function sendToDiscordChannel(embedData, fullScriptContent = null) {
  try {
    const channel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
    if (!channel) {
      console.error(`Discord channel with ID ${config.LOG_CHANNEL_ID} not found.`);
      throw new Error('Log channel not found.');
    }

    const embed = new EmbedBuilder(embedData);
    const messageOptions = { embeds: [embed], components: [] }; // Initialize components array

    if (fullScriptContent && fullScriptContent.trim().length > 0) {
      if (fullScriptContent.length > config.SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT) {
        const currentDescription = embed.data.description || '';
        embed.setDescription(
          currentDescription.replace(/```lua\n[\s\S]*?\n```/, SCRIPT_IN_ATTACHMENT_PLACEHOLDER)
        );
        const buffer = Buffer.from(fullScriptContent, 'utf-8');
        const scriptFileAttachment = new AttachmentBuilder(buffer, { name: `script_log_${generateLogId()}.lua` });
        messageOptions.files = [scriptFileAttachment];
      }
      // If script is short, it's already in embed.data.description, no changes needed here
    }

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('blacklist_user_from_log')
          .setLabel('Blacklist User')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('get_asset_script_from_log') // New ID and Label
          .setLabel('Get Asset/Script')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!fullScriptContent || fullScriptContent.trim().length === 0) // Disable if no script at all
      );
    messageOptions.components.push(row); // Add the ActionRow with buttons

    return channel.send(messageOptions);
  } catch (error) {
    console.error('Discord sendToDiscordChannel error:', error);
    // Log and continue, don't let this break the primary request
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

    const discordIdMatch = embed.description.match(/Discord: <@!?(\d+)>/);
    const robloxUsernameMatch = embed.description.match(/\*\*Username:\*\* \*\*([^*]+)\*\*/); // Matches bolded username

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

    const targetEntryIndex = whitelist.findIndex(entry => entry.Discord === targetUserId);
    if (targetEntryIndex === -1) {
      return interaction.editReply({ content: `User <@${targetUserId}> (Roblox: ${robloxUsername}) not found in the whitelist. They might have already been removed or were never added.` });
    }
    const targetEntry = whitelist[targetEntryIndex]; // Get the entry before removing

    const newWhitelist = whitelist.filter(entry => entry.Discord !== targetUserId); // Create new array without the user

    try {
      await updateWhitelistOnGitHub(newWhitelist, `Blacklist user ${targetEntry.User} (${targetUserId}) by ${interaction.user.tag}`);
    } catch (ghError) {
      return interaction.editReply({ content: `Error updating whitelist on GitHub: ${ghError.message}. Please try again or check GitHub manually.` });
    }

    // Attempt to remove roles in Discord
    let rolesRemovedMessage = "No roles to remove or user not in guild.";
    try {
      const guild = interaction.guild; // The guild where the interaction happened
      if (guild) {
        const member = await guild.members.fetch(targetUserId).catch(() => null); // Fetch fresh member object
        if (member) {
          const rolesToRemoveConfig = [config.ROLES.STANDARD, config.ROLES.PREMIUM, config.ROLES.ULTIMATE].filter(Boolean);
          const rolesActuallyRemoved = [];

          for (const roleId of rolesToRemoveConfig) {
            if (member.roles.cache.has(roleId)) {
              try {
                await member.roles.remove(roleId, `Blacklisted by ${interaction.user.tag}`);
                const role = guild.roles.cache.get(roleId);
                rolesActuallyRemoved.push(role ? role.name : roleId);
              } catch (roleRemoveError) {
                console.warn(`Failed to remove role ${roleId} from ${targetUserId}:`, roleRemoveError);
              }
            }
          }
          if (rolesActuallyRemoved.length > 0) {
            rolesRemovedMessage = `Removed roles: ${rolesActuallyRemoved.join(', ')}.`;
          } else {
            rolesRemovedMessage = "User had no relevant roles to remove.";
          }
        } else {
          rolesRemovedMessage = `User <@${targetUserId}> not found in this server. Roles not modified.`;
          console.warn(`User ${targetUserId} not found in guild ${guild.id} during blacklist role removal.`);
        }
      } else {
        console.warn("Blacklist interaction occurred outside of a guild context. Cannot remove roles.");
        rolesRemovedMessage = "Could not determine server to remove roles from.";
      }
    } catch (roleError) {
      console.error(`Generic role removal error for ${targetUserId}:`, roleError);
      rolesRemovedMessage = "An error occurred while trying to remove roles.";
    }

    // Attempt to DM the user
    try {
      const user = await discordClient.users.fetch(targetUserId);
      const blacklistDmEmbed = new EmbedBuilder()
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
      await user.send({ embeds: [blacklistDmEmbed] });
    } catch (dmError) {
      console.warn(`Failed to send blacklist DM to ${targetUserId}:`, dmError.message);
      // Non-fatal, user is still blacklisted
    }

    await interaction.editReply({ content: `Successfully blacklisted user ${robloxUsername} (<@${targetUserId}>). Whitelist updated. ${rolesRemovedMessage}` });

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
          { name: 'Staff Member', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: false },
          { name: 'Role Status', value: rolesRemovedMessage, inline: false}
        )
        .setTimestamp()
        .setFooter({ text: 'Blacklist System Log' });
      await logChannel.send({ embeds: [logEmbed] });
    }

  } catch (error) {
    console.error('Blacklist command error:', error);
    const errReply = { content: 'An unexpected error occurred while trying to blacklist the user. Please check logs.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.editReply(errReply).catch(console.error);
    else await interaction.reply(errReply).catch(console.error);
  }
}


async function handleGetAssetOrScript(interaction) {
  try {
    // Ephemeral reply in the same channel
    await interaction.deferReply({ ephemeral: true });

    const originalMessage = interaction.message;
    let scriptContentToAnalyze = null;
    let scriptFileAttachment = null; // For attaching the script itself

    // 1. Retrieve the full script content
    const logAttachment = originalMessage.attachments.first(); // Check if the log message itself has the script as attachment
    if (logAttachment && logAttachment.name.startsWith('script_log_') && logAttachment.name.endsWith('.lua')) {
      try {
        const response = await axios.get(logAttachment.url, { responseType: 'text' });
        scriptContentToAnalyze = response.data;
      } catch (fetchError) {
        console.error("Failed to fetch script from attachment URL:", fetchError);
        return interaction.editReply({ content: 'Could not retrieve script from attachment for analysis.' });
      }
    } else {
      // If no attachment, try to get from embed (for short scripts)
      const embed = originalMessage.embeds[0];
      if (embed && embed.description) {
        const scriptContentMatch = embed.description.match(/```lua\n([\s\S]*?)\n```/);
        const extractedScript = scriptContentMatch ? scriptContentMatch[1] : null;
        if (extractedScript && extractedScript !== SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT) {
          scriptContentToAnalyze = extractedScript;
        }
      }
    }

    if (!scriptContentToAnalyze) {
      return interaction.editReply({ content: 'Could not find script content in the log message to analyze or download.' });
    }

    // 2. Prepare script attachment for the reply
    const scriptBuffer = Buffer.from(scriptContentToAnalyze, 'utf-8');
    scriptFileAttachment = new AttachmentBuilder(scriptBuffer, { name: `retrieved_script_${generateLogId()}.lua` });

    // 3. Parse for asset IDs
    const assetIds = new Set(); // Use a Set to store unique IDs
    const requireRegex = /require\s*\(\s*(\d+)\s*\)/g;
    const getObjectsRegex = /(?:GetObjects|InsertService:LoadAsset)\s*\(\s*["']rbxassetid:\/\/(\d+)["']\s*\)/g; // Simpler GetObjects
    const contentRegex = /Content\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi;


    let match;
    while ((match = requireRegex.exec(scriptContentToAnalyze)) !== null) {
      assetIds.add(match[1]);
    }
    while ((match = getObjectsRegex.exec(scriptContentToAnalyze)) !== null) {
      assetIds.add(match[1]);
    }
    while ((match = contentRegex.exec(scriptContentToAnalyze)) !== null) {
      assetIds.add(match[1]);
    }


    // 4. Construct the ephemeral reply message
    let replyContent = "Script content is attached.";
    const attachmentsForReply = [scriptFileAttachment];

    if (assetIds.size > 0) {
      const uniqueAssetIds = Array.from(assetIds);
      const assetLinks = uniqueAssetIds.map(id => `[${id}](https://www.roblox.com/library/${id})`).join(', ');
      replyContent = `Found Asset ID(s) in script: ${assetLinks}\n\nThe full script is also attached.`;
    }

    await interaction.editReply({
      content: replyContent,
      files: attachmentsForReply, // Send the script as an attachment
      ephemeral: true
    });

  } catch (error) {
    console.error('Get Asset/Script command error:', error);
    const errReply = { content: 'An unexpected error occurred while processing your request.', ephemeral: true };
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
    // This still returns the dummy text file.
    // For actual asset download, you'd need a much more complex system.
    const fileName = `${assetId}.rbxm`;
    const content = `-- Roblox model reference (AssetId: ${assetId})\n-- This is a placeholder. To get the actual asset, use the ID on the Roblox website or in Studio.`;
    res.set({ 'Content-Type': 'text/plain', 'Content-Disposition': `attachment; filename="${fileName}"` }).send(content);
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
    const scriptContentMatch = description.match(/```lua\n([\s\S]*?)\n```/);
    const fullScriptContent = scriptContentMatch ? scriptContentMatch[1] : null;

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
      headers: { 'User-Agent': 'LuaWhitelistServer/1.3' } // Increment User-Agent version
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
    if (interaction.customId === 'blacklist_user_from_log') {
      await handleBlacklist(interaction);
    } else if (interaction.customId === 'get_asset_script_from_log') { // Updated ID
      await handleGetAssetOrScript(interaction);
    }
  } catch (error) {
    console.error('Unhandled error in interactionCreate:', error);
    const replyOptions = { content: 'An error occurred while processing your request.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(replyOptions).catch(e => console.error("Error editing reply in interaction error handler:", e));
    } else {
      await interaction.reply(replyOptions).catch(e => console.error("Error replying in interaction error handler:", e));
    }
  }
});

discordClient.on('ready', () => {
  console.log(`Discord Bot logged in as ${discordClient.user.tag}`);
  discordClient.user.setStatus('dnd');
  discordClient.user.setActivity('Managing Whitelists', { type: ActivityType.Watching }); // Correct use of ActivityType
  console.log(`Bot is in ${discordClient.guilds.cache.size} guilds.`);
  console.log(`Watching GitHub Repo: ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}, Branch: ${config.GITHUB_BRANCH}, Whitelist: ${config.WHITELIST_PATH}`);
});

process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection at:', promise, 'reason:', reason));
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // process.exit(1); // Consider exiting on uncaught exceptions for stability in some cases
});

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
