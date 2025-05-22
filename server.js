require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder, ActivityType, ChannelType } = require('discord.js');

// Config from environment variables
const config = {
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_LUA_MENU_URL: process.env.GITHUB_LUA_MENU_URL,
  LOG_CHANNEL_ID: '1373755001234657320', // <<< VERIFIQUE ESTE ID
  GITHUB_REPO_OWNER: process.env.GITHUB_REPO_OWNER || 'RelaxxxX-Lab',
  GITHUB_REPO_NAME: process.env.GITHUB_REPO_NAME || 'Lua-things',
  GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
  WHITELIST_PATH: process.env.WHITELIST_PATH || 'Whitelist.json',
  ROLES: { // <<< VERIFIQUE ESTES IDs
    STANDARD: '1330552089759191064',
    PREMIUM: '1333286640248029264',
    ULTIMATE: '1337177751202828300'
  },
  PORT: process.env.PORT || 3000,
  SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT: 100
};

if (!config.API_KEY || !config.GITHUB_TOKEN || !config.DISCORD_BOT_TOKEN || !config.GITHUB_LUA_MENU_URL) {
  console.error('FATAL ERROR: Missing essential environment variables. Check your .env file.');
  process.exit(1);
}

// --- BEGIN Game Counter Constants ---
const GAME_COUNTER_VOICE_CHANNEL_ID = '1375150160962781204'; // <<< VERIFIQUE ESTE ID
const PLAYER_COUNTER_VOICE_CHANNEL_ID = '1375161884591783936'; // <<< VERIFIQUE ESTE ID
const GAME_ID_TRACKING_DURATION_MS = 30 * 60 * 1000; 
const GAME_COUNTER_UPDATE_INTERVAL_MS = 1 * 60 * 1000; 
const TARGET_EMBED_CHANNEL_IDS = ['1354602804140048461', '1354602826864791612', '1354602856619184339', '1354602879473684521']; // <<< VERIFIQUE ESTES IDs
// --- END Game Counter Constants ---

const app = express();
const octokit = new Octokit({ auth: config.GITHUB_TOKEN, request: { timeout: 15000 } });
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers
  ]
});

app.use(bodyParser.json({ limit: '500mb' }));

// --- BEGIN Game Counter Data Structure ---
let trackedGameIds = new Map(); // Stores <gameId: string, { expiryTimestamp: number, players: number }>
// --- END Game Counter Data Structure ---

function generateLogId() { return crypto.randomBytes(8).toString('hex'); }
function isFromRoblox(req) { return (req.headers['user-agent'] || '').includes('Roblox'); }

async function sendActionLogToDiscord(title, description, interaction, color = 0x0099FF, additionalFields = []) {
    try {
        const logChannel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
        if (!logChannel) {
            console.error("[ERROR] Failed to fetch log channel for reporting. Channel ID:", config.LOG_CHANNEL_ID);
            return;
        }
        const logEmbed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description.substring(0, 4000)).setTimestamp();
        if (interaction) { 
            logEmbed.addFields({ name: 'Action Initiated By', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true });
            if (interaction.guild) {
                 logEmbed.addFields({ name: 'Context', value: `Guild: ${interaction.guild.name}\nChannel: ${interaction.channel.name}`, inline: true });
            }
        }
        for (const field of additionalFields) {
            if (logEmbed.data.fields && logEmbed.data.fields.length >= 23 && additionalFields.length > 0) { // Discord field limit is 25, leaving some buffer
                logEmbed.addFields({name: "Details Truncated", value: "Too many fields for one embed."}); break;
            }
            logEmbed.addFields(field);
        }
        await logChannel.send({ embeds: [logEmbed] });
    } catch (logSendError) { console.error("[ERROR] CRITICAL: Failed to send action log to Discord:", logSendError); }
}

async function getWhitelistFromGitHub() {
  console.log(`Fetching whitelist: ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}/${config.WHITELIST_PATH}`);
  let rawDataContent; 
  try {
    const response = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO_OWNER, repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH, ref: config.GITHUB_BRANCH,
      headers: { 'Accept': 'application/vnd.github.v3.raw', 'Cache-Control': 'no-cache, no-store, must-revalidate' }
    });
    rawDataContent = response.data; 
    if (response.status !== 200) {
        console.warn(`GitHub API returned status ${response.status} for getWhitelistFromGitHub.`);
        throw new Error(`GitHub API request failed with status ${response.status}`);
    }
    console.log("Whitelist content fetched successfully from GitHub. Type of data:", typeof rawDataContent);
    let parsedWhitelist;
    if (typeof rawDataContent === 'string') {
      if (rawDataContent.trim() === "") { 
          console.warn("getWhitelistFromGitHub: Whitelist file is empty. Returning empty array.");
          return [];
      }
      parsedWhitelist = JSON.parse(rawDataContent);
    } else if (rawDataContent && typeof rawDataContent.content === 'string') { 
      console.warn("getWhitelistFromGitHub: Received object with 'content' field, expected raw string. Attempting base64 decode.");
      const decodedContent = Buffer.from(rawDataContent.content, 'base64').toString('utf-8');
      if (decodedContent.trim() === "") {
          console.warn("getWhitelistFromGitHub: Decoded whitelist file content is empty. Returning empty array.");
          return [];
      }
      parsedWhitelist = JSON.parse(decodedContent);
    } else if (typeof rawDataContent === 'object' && rawDataContent !== null && Array.isArray(rawDataContent)) { // If GitHub already returns parsed JSON array (less common for 'raw' accept header)
      parsedWhitelist = rawDataContent;
    } else {
      console.warn("getWhitelistFromGitHub: Received data was not a string, an object with 'content', or an array. Data (partial):", JSON.stringify(rawDataContent).substring(0, 500));
      throw new Error('Unexpected GitHub response format for whitelist content.');
    }
    if (!Array.isArray(parsedWhitelist)) {
        console.warn("getWhitelistFromGitHub: Parsed whitelist is not an array. Type:", typeof parsedWhitelist, "Content (partial):", JSON.stringify(parsedWhitelist).substring(0,500));
        throw new Error('Parsed whitelist data from GitHub is not an array.');
    }
    console.log(`Whitelist parsed. Found ${parsedWhitelist.length} entries.`);
    return parsedWhitelist;
  } catch (error) {
    console.error(`Error in getWhitelistFromGitHub: ${error.message}`);
    const rawDataPreview = typeof rawDataContent === 'string' ? rawDataContent.substring(0,500) : (rawDataContent ? JSON.stringify(rawDataContent).substring(0, 500) : "N/A");
    console.error(`Raw data preview on error (if any): ${rawDataPreview}`);
    await sendActionLogToDiscord(
        'GitHub Whitelist Fetch/Parse Error',
        `Failed to get/parse whitelist from ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}/${config.WHITELIST_PATH}:\n**Error:** ${error.message}\n**Raw Data Preview:** \`\`\`${rawDataPreview}\`\`\``,
        null, 0xFF0000
    );
    const newError = new Error(`Failed to fetch or parse whitelist from GitHub. Path: ${config.WHITELIST_PATH}. Original: ${error.message}`);
    newError.cause = error; 
    throw newError;
  }
}

async function updateWhitelistOnGitHub(newWhitelist, actionMessage = 'Update whitelist') {
  console.log("Updating whitelist on GitHub...");
  try {
    const { data: fileData } = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO_OWNER, repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH, ref: config.GITHUB_BRANCH,
      headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } // Ensure we get the latest SHA
    });
    await octokit.rest.repos.createOrUpdateFileContents({
      owner: config.GITHUB_REPO_OWNER, repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH,
      message: `${actionMessage} - ${new Date().toISOString()}`,
      content: Buffer.from(JSON.stringify(newWhitelist, null, 2)).toString('base64'),
      sha: fileData.sha, // Must provide the SHA of the file being updated
      branch: config.GITHUB_BRANCH
    });
    console.log("Whitelist updated successfully on GitHub.");
    return true;
  } catch (error) {
    console.error(`GitHub API Error (updateWhitelist): Status ${error.status || 'N/A'}, Message: ${error.message}`);
    await sendActionLogToDiscord( 'GitHub Whitelist Update Error', `Failed to update whitelist: ${error.message}`, null, 0xFF0000);
    const newError = new Error(`Failed to update whitelist on GitHub. Original: ${error.message}`);
    newError.cause = error;
    throw newError;
  }
}

const SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT = '[Full script content attached as a .lua file due to length.]';
const SCRIPT_IN_ATTACHMENT_PLACEHOLDER = '```lua\n' + SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT + '\n```';

async function sendToDiscordChannel(embedData, fullScriptContent = null) {
  try {
    const channel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
    if (!channel) throw new Error(`Log channel not found for script log. ID: ${config.LOG_CHANNEL_ID}`);

    const embed = new EmbedBuilder(embedData); // Assume embedData is a valid EmbedBuilder-compatible object
    const messageOptions = { embeds: [embed], components: [] };

    if (fullScriptContent && fullScriptContent.trim().length > 0) {
      if (fullScriptContent.length > config.SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT) { // Compare length
        // Modify description to show placeholder
        embed.setDescription((embed.data.description || '').replace(/```lua\n([\s\S]*?)\n```/, SCRIPT_IN_ATTACHMENT_PLACEHOLDER));
        messageOptions.files = [new AttachmentBuilder(Buffer.from(fullScriptContent, 'utf-8'), { name: `script_log_${generateLogId()}.lua` })];
      }
      // If not over threshold, the original script in description (if present) is kept.
    }

    messageOptions.components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('blacklist_user_from_log').setLabel('Blacklist User').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('get_asset_script_from_log')
        .setLabel('Download Found Assets')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!fullScriptContent || fullScriptContent.trim().length === 0) 
    ));
    return channel.send(messageOptions);
  } catch (error) { 
      console.error('[ERROR] Discord sendToDiscordChannel (script log) error:', error); 
      // Potentially log this error to another failsafe log if LOG_CHANNEL_ID itself is the issue
  }
}

async function handleBlacklist(interaction) {
  let hasRepliedOrDeferred = false;
  const originalMessageURL = interaction.message.url; // For logging context
  try {
    console.log("[DEBUG] handleBlacklist: Deferring reply...");
    await interaction.deferReply({ ephemeral: true });
    hasRepliedOrDeferred = true;
    console.log("[DEBUG] handleBlacklist: Reply deferred.");

    const originalMessage = interaction.message;
    const embed = originalMessage.embeds[0];

    if (!embed || typeof embed.description !== 'string' || embed.description.trim() === '') {
      const errorMsg = "Blacklist Error: Embed description is missing, not a string, or empty.";
      console.error(`[ERROR] ${errorMsg}`);
      const embedContentForDebug = embed ? JSON.stringify(embed).substring(0,1000) : "Embed object is null/undefined";
      await sendActionLogToDiscord('Blacklist Pre-check Failed', errorMsg, interaction, 0xFF0000, [{name: "Original Message", value: `[Link](${originalMessageURL})`}, {name: "Faulty Embed (Partial)", value: `\`\`\`json\n${embedContentForDebug}\n\`\`\``}]);
      return interaction.editReply({ content: 'Error: Critical information missing from log embed (description).' });
    }

    const rawDescription = embed.description;
    const descriptionToSearch = rawDescription.trim();
    
    console.log("[DEBUG] --- REGEX DEBUG START (Blacklist) ---");
    console.log("[DEBUG] Trimmed Embed Description (for JSON):", JSON.stringify(descriptionToSearch).substring(0,500) + "...");
    const lines = descriptionToSearch.split('\n');
    let discordLine = null;
    for (const line of lines) { if (line.toLowerCase().includes("discord:")) { discordLine = line; break; } }
    console.log("[DEBUG] Identified potential Discord line:", discordLine);
    
    let targetUserId = null;
    if (discordLine) {
      const idPatternOnLine = /<@!?(\d+)>/; // Matches <@USER_ID> or <@!USER_ID>
      const lineMatch = discordLine.match(idPatternOnLine);
      if (lineMatch && lineMatch[1]) { 
          targetUserId = lineMatch[1]; 
          console.log("[DEBUG] SUCCESSFULLY extracted ID from isolated line:", targetUserId);
      } else { 
          console.log("[DEBUG] FAILED to extract ID from isolated line. Line was:", JSON.stringify(discordLine)); 
      }
    } else { 
        console.log("[DEBUG] Could not isolate a line containing 'discord:'.");
    }
    console.log("[DEBUG] --- REGEX DEBUG END (Blacklist) ---");

    const robloxUsernameRegex = /\*\*Username:\*\* \*\*([^*]+)\*\*/; // Extracts from **Username:** **USER**
    const robloxUsernameMatch = descriptionToSearch.match(robloxUsernameRegex);
    const robloxUsername = robloxUsernameMatch ? robloxUsernameMatch[1] : 'Unknown Roblox User';

    if (!targetUserId) {
      const errorMsg = `Failed to match Discord ID. Last discordLine found: ${discordLine ? JSON.stringify(discordLine) : 'null'}. Raw Description (start): ${descriptionToSearch.substring(0,200)}...`;
      console.error(`[ERROR] ${errorMsg}`);
      await sendActionLogToDiscord('Blacklist Failed - ID Extraction', errorMsg, interaction, 0xFF0000, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
      return interaction.editReply({ content: 'Error: Could not extract Discord ID from the embed. Admins notified.' });
    }
    console.log(`[INFO] Extracted for blacklist: Discord ID=${targetUserId}, Roblox User=${robloxUsername}`);

    let whitelist;
    try { 
        whitelist = await getWhitelistFromGitHub(); 
    } catch (ghError) {
      return interaction.editReply({ content: `Error fetching whitelist: ${ghError.message}` });
    }

    if (!Array.isArray(whitelist)) { 
        await sendActionLogToDiscord('Blacklist Failed - Whitelist Data Malformed', 'Received non-array whitelist data after GitHub fetch.', interaction, 0xFF0000, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
        return interaction.editReply({ content: 'Error: Whitelist data from GitHub is malformed.' });
    }

    const targetEntryIndex = whitelist.findIndex(entry => entry && entry.Discord === targetUserId);
    if (targetEntryIndex === -1) {
      const errorMsg = `User <@${targetUserId}> (Roblox: ${robloxUsername}) not found in whitelist.`;
      console.log(`[INFO] ${errorMsg}`);
      await sendActionLogToDiscord('Blacklist Warning - User Not Found', errorMsg, interaction, 0xFFA500, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]); // Orange for warning
      return interaction.editReply({ content: errorMsg });
    }

    const targetEntry = whitelist[targetEntryIndex];
    const newWhitelist = whitelist.filter(entry => entry && entry.Discord !== targetUserId); // Remove the user

    try { 
        await updateWhitelistOnGitHub(newWhitelist, `Blacklist ${targetEntry.User || targetUserId} by ${interaction.user.tag}`); 
    } catch (ghError) {
      return interaction.editReply({ content: `Error updating whitelist on GitHub: ${ghError.message}` });
    }

    let rolesRemovedMessage = "User not found in this server or had no relevant roles.";
    if (interaction.guild) { // Ensure command is used in a guild
      const member = await interaction.guild.members.fetch(targetUserId).catch(() => null); // Fetch member, null if not found
      if (member) {
        const rolesToRemoveIds = [config.ROLES.STANDARD, config.ROLES.PREMIUM, config.ROLES.ULTIMATE].filter(Boolean); // Filter out any undefined role IDs
        const removedRoleNames = [];
        for (const roleId of rolesToRemoveIds) {
          if (member.roles.cache.has(roleId)) {
            try { 
                await member.roles.remove(roleId, `Blacklisted by ${interaction.user.tag}`); 
                removedRoleNames.push(interaction.guild.roles.cache.get(roleId)?.name || roleId); 
            } catch (e) { 
                console.warn(`[WARN] Failed to remove role ${roleId} from ${targetUserId}:`, e); 
            }
          }
        }
        if (removedRoleNames.length > 0) rolesRemovedMessage = `Removed roles: ${removedRoleNames.join(', ')}.`;
        else rolesRemovedMessage = "User was in server but had no relevant roles to remove.";
      }
    } else { 
        console.warn("[WARN] Interaction for blacklist is not in a guild context. Cannot manage roles.");
        rolesRemovedMessage = "Cannot manage roles: not a guild context.";
    }

    try {
      const user = await discordClient.users.fetch(targetUserId); // Fetch user for DM
      await user.send({ 
          embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('🚨 You Have Been Blacklisted')
            .setDescription('You have been blacklisted from our services.')
            .addFields( 
                { name: 'Roblox Username', value: targetEntry.User || 'N/A', inline: true }, 
                { name: 'Previous Tier', value: targetEntry.Whitelist || 'N/A', inline: true }, // Assuming 'Whitelist' field stores tier name
                { name: 'By Staff', value: interaction.user.tag, inline: false }
            ).setTimestamp()]
      });
    } catch (e) { 
        console.warn(`[WARN] Failed to DM ${targetUserId} about blacklist:`, e.message); 
    }

    await interaction.editReply({ content: `Successfully blacklisted ${robloxUsername} (<@${targetUserId}>). ${rolesRemovedMessage}` });
    await sendActionLogToDiscord('🛡️ User Blacklist Action SUCCESS', `User ${robloxUsername} (<@${targetUserId}>) has been blacklisted.`, interaction, 0x00FF00, 
      [ { name: 'Target User', value: `<@${targetUserId}> (${targetUserId})`, inline: true }, 
        { name: 'Roblox Username', value: targetEntry.User, inline: true }, 
        { name: 'Previous Tier', value: targetEntry.Whitelist, inline: true }, 
        { name: 'Role Status', value: rolesRemovedMessage, inline: false },
        { name: "Original Log Message", value: `[Link](${originalMessageURL})`} 
      ]);

  } catch (error) {
    console.error('[ERROR] Blacklist command main catch error:', error);
    await sendActionLogToDiscord('Blacklist Failed - Unexpected Error', `An unexpected error occurred: ${error.message}\n\`\`\`${error.stack ? error.stack.substring(0,1000) : "No stack"}\n\`\`\``, interaction, 0xFF0000, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
    if (hasRepliedOrDeferred && !interaction.replied) { 
        await interaction.editReply({ content: 'An unexpected error occurred during blacklisting. Admins notified.', ephemeral: true }).catch(err => console.error("[ERROR] Error sending final error reply for blacklist:", err));
    } else if (!hasRepliedOrDeferred && !interaction.replied) { // Should not happen if deferReply is first
        await interaction.reply({ content: 'An error occurred, and the interaction was not properly deferred. Admins notified.', ephemeral: true }).catch(err => console.error("[ERROR] Error sending emergency reply for blacklist:", err));
    }
  }
}

async function handleGetAssetOrScript(interaction) {
  let hasRepliedOrDeferredAsset = false;
  const originalMessageURL = interaction.message.url;
  try {
    await interaction.deferReply({ ephemeral: true });
    hasRepliedOrDeferredAsset = true;
    const originalMessage = interaction.message;
    let scriptContentToAnalyze = null;

    // Check attachment first
    const logAttachment = originalMessage.attachments.first();
    if (logAttachment?.name.endsWith('.lua')) {
      try { 
          scriptContentToAnalyze = (await axios.get(logAttachment.url, { responseType: 'text' })).data; 
      } catch (fetchError) { 
          console.warn("[WARN] Failed to fetch script from attachment URL for asset parsing:", fetchError.message); 
      }
    }

    // If not in attachment, try to find in embed description
    if (!scriptContentToAnalyze) {
      const embed = originalMessage.embeds[0];
      if (embed?.description) {
        const match = embed.description.match(/```lua\n([\s\S]*?)\n```/);
        if (match && match[1] && match[1].trim() !== SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT) {
          scriptContentToAnalyze = match[1];
        }
      }
    }

    if (!scriptContentToAnalyze) {
      await sendActionLogToDiscord('Asset Download Failed - No Script', 'Could not find script content in the log message to analyze for assets.', interaction, 0xFFA500, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
      return interaction.editReply({ content: 'No script content found to analyze for assets.' });
    }

    const assetIds = new Set();
    // Common Roblox asset ID patterns
    const regexes = [
      /require\s*\(\s*(\d+)\s*\)/g, // require(12345)
      /(?:GetObjects|InsertService:LoadAsset(?:Version)?)\s*\(\s*(?:["']rbxassetid:\/\/(\d+)["']|(\d+))\s*\)/gi, // InsertService:LoadAsset("rbxassetid://123") or IS:LoadAsset(123)
      /Content\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi, // Content = "rbxassetid://123"
      /Image\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi,   // Image = "rbxassetid://123"
      /Texture(?:Id)?\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi, // Texture = "rbxassetid://123" or TextureId
      /SoundId\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi, // SoundId = "rbxassetid://123"
      /MeshId\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi,   // MeshId = "rbxassetid://123"
      // Add more specific patterns if needed
    ];

    for (const regex of regexes) {
      let match;
      while ((match = regex.exec(scriptContentToAnalyze)) !== null) {
        // Add whichever capture group matched (some regexes have multiple for rbxassetid vs raw id)
        if (match[1]) assetIds.add(match[1]);
        if (match[2]) assetIds.add(match[2]); // For regexes with a second ID capture group like LoadAsset
      }
    }
    
    const uniqueAssetIds = Array.from(assetIds).filter(id => id && /^\d+$/.test(id)); // Filter valid numeric IDs
    let replyContent = "No downloadable asset IDs found in the script.";
    const assetFiles = [];

    if (uniqueAssetIds.length > 0) {
      const assetLinks = [];
      let assetsProcessed = 0;
      for (const assetId of uniqueAssetIds) {
        if (assetsProcessed >= 10) { // Discord attachment limit
            console.warn("[WARN] Reached attachment limit for asset download, truncating."); 
            break; 
        }
        // Create placeholder .rbxm file content
        const placeholderRbxmContent = `-- Roblox Asset ID: ${assetId}\n-- This is a placeholder .rbxm file.\n-- You can use this ID on the Roblox website (roblox.com/library/${assetId}) or in Roblox Studio.\nprint("Asset ID: ${assetId}")`;
        assetFiles.push(new AttachmentBuilder(Buffer.from(placeholderRbxmContent, 'utf-8'), { name: `${assetId}.rbxm` }));
        assetLinks.push(`[${assetId}](https://www.roblox.com/library/${assetId})`);
        assetsProcessed++;
      }

      if (assetFiles.length > 0) {
        replyContent = `Found Asset ID(s) - Placeholder .rbxm files attached:\n${assetLinks.join('\n')}`;
        if (assetLinks.length > 5) { // If too many links for inline reply, just say how many
            replyContent = `Found ${assetLinks.length} Asset ID(s). Placeholder .rbxm files attached.`;
        }
        await sendActionLogToDiscord('Assets Found & Sent', `User requested assets. Found: ${assetLinks.join(', ')}. Sent ${assetFiles.length} placeholder rbxm files.`, interaction, 0x00FF00, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
      } else { // Should not happen if uniqueAssetIds.length > 0 unless all are filtered out
        replyContent = "Found asset IDs, but encountered an issue preparing them for download.";
        await sendActionLogToDiscord('Asset Download Issue - Preparation', replyContent, interaction, 0xFFA500, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
      }
    } else {
      await sendActionLogToDiscord('No Assets Found in Script', 'User requested assets, but no recognized IDs were found in the script content.', interaction, 0xADD8E6, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
    }

    await interaction.editReply({ content: replyContent, files: assetFiles, ephemeral: true });

  } catch (error) {
    console.error('[ERROR] Get Asset/Script error:', error);
    await sendActionLogToDiscord('Get Asset/Script Failed - Unexpected Error', `Error: ${error.message}\nStack: ${error.stack ? error.stack.substring(0,1000) : "N/A"}`, interaction, 0xFF0000, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
    if (hasRepliedOrDeferredAsset && !interaction.replied) {
        await interaction.editReply({ content: 'Error processing asset download request. Admins notified.' }).catch(console.error);
    } else if (!hasRepliedOrDeferredAsset && !interaction.replied) { // Fallback
        await interaction.reply({ content: 'Error processing asset download request. Admins notified.', ephemeral: true }).catch(console.error);
    }
  }
}

// --- Game/Player Counter Update Function ---
async function updateCounterChannels() {
    if (!discordClient || !discordClient.isReady()) {
        console.log("[DEBUG] updateCounterChannels: Bot not ready, skipping update.");
        return;
    }
    console.log("[DEBUG] updateCounterChannels: Running update cycle.");
    const now = Date.now();
    let activeGameCount = 0;
    let totalPlayerCount = 0;
    const idsToRemove = [];

    console.log("[DEBUG] Current trackedGameIds before cleanup:", new Map(trackedGameIds));

    for (const [gameId, data] of trackedGameIds.entries()) {
        if (data.expiryTimestamp < now) {
            idsToRemove.push(gameId);
            console.log(`[DEBUG] Game ID ${gameId} marked for expiration (Expired at: ${new Date(data.expiryTimestamp).toLocaleTimeString()}, Players: ${data.players}).`);
        } else {
            activeGameCount++;
            totalPlayerCount += (data.players || 0);
            console.log(`[DEBUG] Game ID ${gameId} is active. Players: ${data.players || 0}. Added to counts.`);
        }
    }

    if (idsToRemove.length > 0) {
        console.log(`[DEBUG] Removing ${idsToRemove.length} expired game IDs: ${idsToRemove.join(', ')}`);
        for (const id of idsToRemove) {
            trackedGameIds.delete(id);
        }
        console.log("[DEBUG] trackedGameIds after cleanup:", new Map(trackedGameIds));
    }

    console.log(`[DEBUG] Calculated counts - Active Games: ${activeGameCount}, Total Players: ${totalPlayerCount}`);

    // Update "Total Games" Voice Channel Name
    try {
        console.log(`[DEBUG] Fetching game counter channel: ${GAME_COUNTER_VOICE_CHANNEL_ID}`);
        const gameChannel = await discordClient.channels.fetch(GAME_COUNTER_VOICE_CHANNEL_ID);
        if (gameChannel && gameChannel.type === ChannelType.GuildVoice) {
            const newGameChannelName = `Total Games: ${activeGameCount}`;
            console.log(`[DEBUG] Game Channel current name: "${gameChannel.name}", New target name: "${newGameChannelName}"`);
            if (gameChannel.name !== newGameChannelName) {
                console.log(`[DEBUG] Attempting to set Game Channel (${gameChannel.id}) name to: "${newGameChannelName}"`);
                await gameChannel.setName(newGameChannelName);
                console.log(`[SUCCESS] Updated game counter voice channel name to: "${newGameChannelName}"`);
            } else {
                console.log(`[DEBUG] Game Channel name is already up-to-date: "${newGameChannelName}"`);
            }
        } else if (gameChannel) {
            console.warn(`[WARN] Target channel ${GAME_COUNTER_VOICE_CHANNEL_ID} for games found, but it is not a GuildVoice channel. Actual Type: ${ChannelType[gameChannel.type]}`);
        } else {
             console.warn(`[WARN] Game counter voice channel ${GAME_COUNTER_VOICE_CHANNEL_ID} not found (fetch probably returned null).`);
        }
    } catch (error) {
        if (error.code === 10003) { // Unknown Channel
             console.warn(`[WARN] Game counter voice channel ${GAME_COUNTER_VOICE_CHANNEL_ID} does not exist or could not be fetched (Error 10003).`);
        } else if (error.name === 'DiscordAPIError' && error.status === 403) { // Missing permissions
             console.error(`[ERROR] Missing permissions to update game counter voice channel ${GAME_COUNTER_VOICE_CHANNEL_ID}. Details: ${error.message}`);
        } else {
             console.error(`[ERROR] Error updating game counter voice channel name for ${GAME_COUNTER_VOICE_CHANNEL_ID}:`, error);
        }
    }

    // Update "Total Players" Voice Channel Name
    try {
        console.log(`[DEBUG] Fetching player counter channel: ${PLAYER_COUNTER_VOICE_CHANNEL_ID}`);
        const playerChannel = await discordClient.channels.fetch(PLAYER_COUNTER_VOICE_CHANNEL_ID);
        if (playerChannel && playerChannel.type === ChannelType.GuildVoice) {
            const newPlayerChannelName = `Total Players: ${totalPlayerCount}`;
            console.log(`[DEBUG] Player Channel current name: "${playerChannel.name}", New target name: "${newPlayerChannelName}"`);
            if (playerChannel.name !== newPlayerChannelName) {
                console.log(`[DEBUG] Attempting to set Player Channel (${playerChannel.id}) name to: "${newPlayerChannelName}"`);
                await playerChannel.setName(newPlayerChannelName);
                console.log(`[SUCCESS] Updated player counter voice channel name to: "${newPlayerChannelName}"`);
            } else {
                console.log(`[DEBUG] Player Channel name is already up-to-date: "${newPlayerChannelName}"`);
            }
        } else if (playerChannel) {
            console.warn(`[WARN] Target channel ${PLAYER_COUNTER_VOICE_CHANNEL_ID} for players found, but it is not a GuildVoice channel. Actual Type: ${ChannelType[playerChannel.type]}`);
        } else {
            console.warn(`[WARN] Player counter voice channel ${PLAYER_COUNTER_VOICE_CHANNEL_ID} not found (fetch probably returned null).`);
        }
    } catch (error) {
        if (error.code === 10003) { // Unknown Channel
            console.warn(`[WARN] Player counter voice channel ${PLAYER_COUNTER_VOICE_CHANNEL_ID} does not exist or could not be fetched (Error 10003).`);
        } else if (error.name === 'DiscordAPIError' && error.status === 403) { // Missing permissions
            console.error(`[ERROR] Missing permissions to update player counter voice channel ${PLAYER_COUNTER_VOICE_CHANNEL_ID}. Details: ${error.message}`);
        } else {
            console.error(`[ERROR] Error updating player counter voice channel name for ${PLAYER_COUNTER_VOICE_CHANNEL_ID}:`, error);
        }
    }
}

// --- Express Routes ---
app.get('/', (req, res) => res.status(403).json({ status: 'error', message: 'Access Denied.' }));

app.get('/verify/:username', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  const username = req.params.username;
  if (!username) return res.status(400).json({ status: 'error', message: 'Username required.' });
  let whitelist;
  try {
    whitelist = await getWhitelistFromGitHub();
    if (!Array.isArray(whitelist)) { 
        console.error(`[ERROR] Verify error for ${username}: Whitelist data from GitHub was not an array. Type: ${typeof whitelist}`);
        await sendActionLogToDiscord('Whitelist Verification Critical Error', `For /verify/${username}, whitelist data from GitHub was not an array. Type received: ${typeof whitelist}.`, null, 0xFF0000);
        return res.status(500).json({ status: 'error', message: "Internal server error: Whitelist data malformed." });
    }
    const foundUser = whitelist.find(user => user && typeof user.User === 'string' && user.User.toLowerCase() === username.toLowerCase());
    if (!foundUser) {
      console.log(`[INFO] /verify/${username}: User not found in whitelist.`);
      return res.status(404).json({ status: 'error', message: "User not found in whitelist." });
    }
    console.log(`[INFO] /verify/${username}: User found.`);
    res.json({ status: 'success', data: { username: foundUser.User, discordId: foundUser.Discord, tier: foundUser.Whitelist }});
  } catch (error) {
    console.error(`[ERROR] Verify error for ${username} (caught in route): ${error.message}`);
    if (!(error.message.includes("Failed to fetch or parse whitelist from GitHub"))) { // Don't double-log GitHub fetch errors handled in getWhitelistFromGitHub
        await sendActionLogToDiscord('Whitelist Verification Route Error', `Unexpected error during /verify/${username}: ${error.message}`, null, 0xFF0000);
    }
    res.status(500).json({ status: 'error', message: "Internal server error during verification." });
  }
});

app.get('/download/:assetId', async (req, res) => {
  const assetId = req.params.assetId;
  if (!/^\d+$/.test(assetId)) return res.status(400).json({ status: 'error', message: 'Invalid asset ID.' });
  const placeholderRbxmContent = `-- Roblox Asset: ${assetId}\n-- This is a placeholder file. Use the ID on the Roblox website or in Studio.\nprint("Asset ID: ${assetId}")`;
  res.set({ 'Content-Type': 'application/rbxm', 'Content-Disposition': `attachment; filename="${assetId}.rbxm"` }).send(placeholderRbxmContent);
});

app.post('/send/scriptlogs', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  if (req.headers['authorization'] !== config.API_KEY) return res.status(401).json({ status: 'error', message: 'Invalid API key.' });
  if (!req.body?.embeds?.length || !req.body.embeds[0]) return res.status(400).json({ status: 'error', message: 'Invalid or missing embed data.' });
  try {
    const embedData = req.body.embeds[0]; // Take the first embed
    const scriptMatch = (embedData.description || '').match(/```lua\n([\s\S]*?)\n```/);
    const fullScript = scriptMatch && scriptMatch[1] ? scriptMatch[1] : null;
    await sendToDiscordChannel(embedData, fullScript);
    res.status(200).json({ status: 'success', message: 'Log received.', logId: generateLogId() });
  } catch (error) { 
      console.error('[ERROR] Error in /send/scriptlogs:', error.message); 
      res.status(500).json({ status: 'error', message: "Processing script log failed on server." }); 
  }
});

app.get('/scripts/LuaMenu', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  try {
    const response = await axios.get(config.GITHUB_LUA_MENU_URL, { 
        timeout: 8000, 
        headers: { 'User-Agent': 'LuaWhitelistServer/1.9.1' } // Updated UA slightly
    });
    res.set({ 
        'Content-Type': 'text/plain; charset=utf-8', 
        'Cache-Control': 'no-store', // No caching by proxies or client
        'X-Content-Type-Options': 'nosniff' // Prevents MIME-sniffing
    }).send(response.data);
  } catch (error) { 
      console.error('[ERROR] Error /scripts/LuaMenu:', error.message); 
      res.status(error.response?.status || 500).json({ status: 'error', message: 'Failed to load LuaMenu script.' }); 
  }
});

app.get('/module/id', async (req, res) => {
  if (!isFromRoblox(req)) {
    return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  }
  try {
    const rawText = '119529617692199'; // Example ID
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }).send(rawText);
  } catch (error) {
    console.error('[ERROR] Error /module/id:', error.message);
    res.status(500).json({ status: 'error', message: 'Failed to load data.' });
  }
});

// --- Discord Event Handlers ---
discordClient.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  console.log(`[DEBUG] Button interaction received: ${interaction.customId} by ${interaction.user.tag}`);
  try {
    if (interaction.customId === 'blacklist_user_from_log') await handleBlacklist(interaction);
    else if (interaction.customId === 'get_asset_script_from_log') await handleGetAssetOrScript(interaction);
    // Add other button handlers here if needed
  } catch (error) {
    console.error('[ERROR] Main Interaction error catcher:', error);
    await sendActionLogToDiscord( 'Main Interaction Catcher Error', `Error: ${error.message}\n\`\`\`${error.stack ? error.stack.substring(0,1000) : "No stack"}\n\`\`\``, interaction, 0xFF0000);
    if (interaction.isRepliable()) { // Check if it's possible to reply
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'An unhandled error occurred while processing your request. Admins have been notified.', ephemeral: true }).catch(e => console.error("[ERROR] Error sending fallback reply for interaction:", e));
        } else if (interaction.deferred && !interaction.replied) {
            await interaction.editReply({ content: 'An unhandled error occurred while processing your request. Admins have been notified.' }).catch(e => console.error("[ERROR] Error sending fallback editReply for interaction:", e));
        }
    }
  }
});

discordClient.on('messageCreate', async message => {
    console.log(`[DEBUG] Message received in channel ID: ${message.channel.id} (Name: ${message.channel.name || 'N/A (DM?)'}) from user: ${message.author.tag}`);

    if (!TARGET_EMBED_CHANNEL_IDS.includes(message.channel.id)) {
        if (discordClient.user && message.author.id !== discordClient.user.id) { // Avoid logging self-ignore if client not fully ready
            console.log(`[DEBUG] Message ignored: Not a target channel. Channel ID: ${message.channel.id}`);
        }
        return;
    }
    
    console.log(`[DEBUG] Message IS in a target channel: ${message.channel.id}`);

    // Consider ignoring messages from ALL bots if that's desired behavior
    // if (message.author.bot) { 
    //     console.log(`[DEBUG] Message ignored: From a bot (${message.author.tag}).`);
    //     return; 
    // }

    if (!message.embeds || message.embeds.length === 0) {
        console.log("[DEBUG] Message has no embeds. Ignoring for counter purposes.");
        return;
    }
    console.log(`[DEBUG] Message has ${message.embeds.length} embed(s).`);

    let dataChangedThisMessage = false; 
    const now = Date.now();
    const gameIdRegex = /Roblox\.GameLauncher\.joinGameInstance\(\s*(\d+)\s*,\s*"[^"]+"\s*\)/; 
    const activePlayersRegex = /Active Players:\s*(\d+)/i;

    for (const embed of message.embeds) {
        console.log("[DEBUG] Processing embed. Description (first 300 chars):", embed.description ? embed.description.substring(0, 300) : "No description");
        if (!embed.description) {
            console.log("[DEBUG] Embed has no description. Skipping this embed.");
            continue;
        }

        const gameIdMatch = embed.description.match(gameIdRegex);
        const playersMatch = embed.description.match(activePlayersRegex);

        console.log("[DEBUG] Game ID Match result (gameIdMatch ? gameIdMatch[1] : 'No match'):", gameIdMatch ? gameIdMatch[1] : "No match");
        console.log("[DEBUG] Players Match result (playersMatch ? playersMatch[1] : 'No match'):", playersMatch ? playersMatch[1] : "No match");

        if (gameIdMatch && gameIdMatch[1]) { 
            const gameId = gameIdMatch[1];
            const parsedPlayers = playersMatch && playersMatch[1] ? parseInt(playersMatch[1], 10) : NaN;
            const activePlayers = !isNaN(parsedPlayers) ? parsedPlayers : 0;

            console.log(`[DEBUG] For gameId ${gameId}: Parsed players string: "${playersMatch ? playersMatch[1] : 'N/A'}", Parsed int: ${parsedPlayers}, Final activePlayers: ${activePlayers}`);

            const currentGameData = trackedGameIds.get(gameId);
            const newExpiry = now + GAME_ID_TRACKING_DURATION_MS;

            console.log(`[DEBUG] For gameId ${gameId}: Current tracked data:`, currentGameData ? JSON.stringify(currentGameData) : "Not tracked yet");

            let gameIsNew = !currentGameData;
            let gameWasExpired = currentGameData && currentGameData.expiryTimestamp < now;
            let playerCountChangedForActiveGame = currentGameData && currentGameData.expiryTimestamp >= now && currentGameData.players !== activePlayers;
            
            if (gameIsNew) { console.log(`[DEBUG] Condition met: Game ${gameId} is NEW.`); }
            if (gameWasExpired) { console.log(`[DEBUG] Condition met: Game ${gameId} WAS EXPIRED. (Expiry: ${new Date(currentGameData.expiryTimestamp).toLocaleTimeString()}, Now: ${new Date(now).toLocaleTimeString()})`); }
            if (playerCountChangedForActiveGame) { console.log(`[DEBUG] Condition met: Game ${gameId} PLAYER COUNT CHANGED. (Tracked: ${currentGameData.players}, Current: ${activePlayers})`); }

            if (gameIsNew || gameWasExpired || playerCountChangedForActiveGame) {
                dataChangedThisMessage = true;
                console.log(`[DEBUG] Change detected for game ${gameId}. Setting dataChangedThisMessage = true.`);
            }
            
            trackedGameIds.set(gameId, { expiryTimestamp: newExpiry, players: activePlayers });
            console.log(`[DEBUG] Updated/Set trackedGameIds for ${gameId}: players=${activePlayers}, expiry=${new Date(newExpiry).toLocaleTimeString()}`);
        } else {
            console.log("[DEBUG] No gameId found in this embed's description using the regex, or regex itself is flawed. Skipping this embed for counter purposes.");
        }
    }

    if (dataChangedThisMessage) {
        console.log("[DEBUG] dataChangedThisMessage is TRUE. Calling updateCounterChannels() due to changes in this message.");
        await updateCounterChannels(); 
    } else {
        console.log("[DEBUG] dataChangedThisMessage is FALSE. No immediate channel update triggered by this specific message.");
    }
});

discordClient.on('ready', async () => { 
  console.log(`[INFO] Bot logged in as ${discordClient.user.tag} in ${discordClient.guilds.cache.size} guilds.`);
  discordClient.user.setStatus('dnd'); 
  discordClient.user.setActivity('Managing Whitelists', { type: ActivityType.Watching });

  console.log('[INFO] Bot ready, performing initial counter updates for games and players.');
  try {
      await updateCounterChannels(); 
      setInterval(updateCounterChannels, GAME_COUNTER_UPDATE_INTERVAL_MS); 
      console.log(`[INFO] Game and Player counters initialized. Monitoring target embed channels: ${TARGET_EMBED_CHANNEL_IDS.join(', ')}. Updating 'Total Games' VC: ${GAME_COUNTER_VOICE_CHANNEL_ID}, 'Total Players' VC: ${PLAYER_COUNTER_VOICE_CHANNEL_ID}.`);
  } catch (initError) {
      console.error("[ERROR] Error during counter initialization in 'ready' event:", initError);
  }
});

// --- Global Error Handlers & Server Start ---
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
  // Potentially log more details or send a critical alert
});
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error);
  // Consider whether to exit: process.exit(1); It can be disruptive but prevents unknown states.
});

async function startServer() {
  try {
    await discordClient.login(config.DISCORD_BOT_TOKEN);
    app.listen(config.PORT, () => console.log(`[INFO] API server listening on http://localhost:${config.PORT}. Discord Bot connected.`));
  } catch (error) {
    console.error('[FATAL] Startup failed:', error);
    process.exit(1); // Essential services failed to start
  }
}

startServer();
