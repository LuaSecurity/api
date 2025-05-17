require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParserModule = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder, ActivityType } = require('discord.js');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

// --- CONFIGURATION ---
const config = {
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_LUA_MENU_URL: process.env.GITHUB_LUA_MENU_URL,
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || '1331021897735081984', // Defaulted if not in env
  GITHUB_REPO_OWNER: process.env.GITHUB_REPO_OWNER || 'RelaxxxX-Lab',
  GITHUB_REPO_NAME: process.env.GITHUB_REPO_NAME || 'Lua-things',
  GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
  WHITELIST_PATH: process.env.WHITELIST_PATH || 'Whitelist.json',
  SCRIPTS_JSON_PATH: process.env.SCRIPTS_JSON_PATH || 'Scripts.json',
  ROLES: { // Tier names as expected in Whitelist.json
    STANDARD: process.env.ROLES_STANDARD || 'Standard',
    PREMIUM: process.env.ROLES_PREMIUM || 'Premium',
    ULTIMATE: process.env.ROLES_ULTIMATE || 'Ultimate',
    STAFF: process.env.ROLES_STAFF || "Mod" // Changed "Staff" to "Mod" as per your example
  },
  PORT: process.env.PORT || 3000,
  SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT: 100,
  // Mapping your .env names to config names used in the script
  DISCORD_CLIENT_ID: process.env.BOT_CLIENT_ID,
  DISCORD_CLIENT_SECRET: process.env.BOT_CLIENT_SECRET,
  CALLBACK_URL: process.env.REDIRECT_URI,
  SESSION_SECRET: process.env.SESSION_SECRET, // MUST BE SET IN .ENV
  TARGET_GUILD_ID: process.env.SERVER_ID, // Using your .env name SERVER_ID
};

const requiredConfigKeys = ['API_KEY', 'GITHUB_TOKEN', 'DISCORD_BOT_TOKEN', 'GITHUB_LUA_MENU_URL', 'LOG_CHANNEL_ID', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'CALLBACK_URL', 'SESSION_SECRET', 'TARGET_GUILD_ID'];
for (const key of requiredConfigKeys) {
  if (!config[key]) {
    console.error(`FATAL ERROR: Missing essential environment variable: ${key}. Please check your .env file and config mapping.`);
    process.exit(1);
  }
}

// --- INITIALIZATIONS ---
const app = express();
const octokit = new Octokit({ auth: config.GITHUB_TOKEN, request: { timeout: 15000 } });
const discordClient = new Client({
  intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers ]
});

// --- MIDDLEWARE ---
app.use(bodyParserModule.json({ limit: '50mb' }));
app.use(bodyParserModule.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({ secret: config.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } }));
app.use(passport.initialize());
app.use(passport.session());

// --- PASSPORT SETUP ---
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));
const discordScopes = ['identify', 'email', 'guilds', 'guilds.join'];
passport.use(new DiscordStrategy({
  clientID: config.DISCORD_CLIENT_ID,
  clientSecret: config.DISCORD_CLIENT_SECRET,
  callbackURL: config.CALLBACK_URL,
  scope: discordScopes
}, async (accessToken, refreshToken, profile, done) => {
  profile.accessToken = accessToken;
  console.log(`User ${profile.username}#${profile.discriminator} (${profile.id}) attempted login. Email: ${profile.email}`);
  try {
    const targetGuild = await discordClient.guilds.fetch(config.TARGET_GUILD_ID).catch(() => null);
    if (targetGuild) {
      const isMember = await targetGuild.members.fetch(profile.id).catch(() => null);
      if (!isMember) {
        console.log(`Attempting to add user ${profile.id} (${profile.username}) to guild ${config.TARGET_GUILD_ID}`);
        try {
          await targetGuild.members.add(profile.id, { accessToken });
          console.log(`Successfully added ${profile.username} to guild ${targetGuild.name}.`);
          await sendActionLogToDiscord('User Auto-Joined Guild', `User ${profile.username}#${profile.discriminator} (<@${profile.id}>) was automatically added to guild ${targetGuild.name} after OAuth.`, {user: profile, guild: targetGuild}, 0x57F287);
        } catch (addError) {
          console.error(`Failed to add user ${profile.id} to guild ${config.TARGET_GUILD_ID}:`, addError.message);
          await sendActionLogToDiscord('Guild Auto-Join Failed', `Failed to add user ${profile.username}#${profile.discriminator} (<@${profile.id}>) to target guild ${targetGuild.name}.\nError: ${addError.message}`, {user:profile, guild: targetGuild}, 0xED4245, [{name: "Error Details", value: addError.stack ? addError.stack.substring(0,1000) : "N/A"}]);
        }
      } else { console.log(`User ${profile.username} is already in target guild ${targetGuild.name}.`); }
    } else { console.warn(`Target guild ${config.TARGET_GUILD_ID} not found by bot, or bot is not in it.`); }
  } catch (guildError) { console.error("Error during guild check/join in OAuth callback:", guildError); }
  return done(null, profile);
}));

// --- AUTHENTICATION MIDDLEWARE ---
async function isAuthenticatedAndHasRole(req, res, next) {
  if (req.isAuthenticated()) {
    const userDiscordId = req.user.id;
    console.log(`Authenticated user ${req.user.username} (${userDiscordId}) accessing ${req.originalUrl}. Checking whitelist...`);
    try {
      const whitelist = await getWhitelistFromGitHub(); // This function now handles its own detailed error logging to Discord
      if (!Array.isArray(whitelist)) {
        // This case should ideally be caught by getWhitelistFromGitHub, but as a failsafe:
        console.error("Auth Middleware: Whitelist data from GitHub was not an array. This is a critical issue.");
        await sendActionLogToDiscord("Auth Middleware Critical Error", `Whitelist data from GitHub was not an array when checking for ${req.user.username} accessing ${req.originalUrl}.`, req, 0xED4245);
        req.session.authMessage = { type: 'error', text: 'Critical server error: Whitelist data is malformed. Please contact support.' };
        return res.redirect('/');
      }
      const userEntry = whitelist.find(entry => entry && entry.Discord === userDiscordId);
      if (userEntry && userEntry.Whitelist) {
        req.user.robloxUsername = userEntry.User;
        req.user.whitelistTier = userEntry.Whitelist;
        console.log(`User ${req.user.username} is whitelisted with tier: ${userEntry.Whitelist}. Roblox: ${userEntry.User}. Access granted to ${req.originalUrl}.`);
        return next();
      } else {
        console.log(`User ${req.user.username} not found in whitelist or no tier assigned for ${req.originalUrl}.`);
        await sendActionLogToDiscord("Access Denied - Not Whitelisted", `User ${req.user.username}#${req.user.discriminator} (<@${userDiscordId}>) tried to access ${req.originalUrl} but is not whitelisted or tier is missing.`, req, 0xFEE75C);
        req.session.authMessage = { type: 'error', text: 'Access Denied: You are not whitelisted or your plan is not active.' };
        return res.redirect('/');
      }
    } catch (err) { // Catches errors from getWhitelistFromGitHub or other issues
      console.error(`Auth Middleware: Error for ${req.user.username} accessing ${req.originalUrl}: ${err.message}`);
      // getWhitelistFromGitHub already logs its specific errors. This is a general fallback.
      if (!err.message.toLowerCase().includes("whitelist")) { // Avoid double-logging if error is from getWhitelistFromGitHub
          await sendActionLogToDiscord("Auth Middleware Unhandled Error", `Error checking whitelist for ${req.user.username} (<@${userDiscordId}>) accessing ${req.originalUrl}.\nError: ${err.message}`, req, 0xED4245);
      }
      req.session.authMessage = { type: 'error', text: 'Server error checking whitelist status. Please try again later.' };
      return res.redirect('/');
    }
  }
  req.session.returnTo = req.originalUrl; // Store the originally requested page
  res.redirect('/auth/discord');
}

// --- HELPER FUNCTIONS ---
function generateLogId() { return crypto.randomBytes(8).toString('hex'); }
function isFromRoblox(req) { return (req.headers['user-agent'] || '').includes('Roblox'); }

async function sendActionLogToDiscord(title, description, interactionOrReq, color = 0x3498DB, additionalFields = []) {
    try {
        const logChannel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
        if (!logChannel) { console.error("Log channel not found:", config.LOG_CHANNEL_ID); return; }
        const logEmbed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description.substring(0, 4000)).setTimestamp();
        const user = interactionOrReq ? (interactionOrReq.user || (interactionOrReq.isAuthenticated && interactionOrReq.isAuthenticated() ? interactionOrReq.user : null)) : null;
        const guild = interactionOrReq?.guild;
        const channel = interactionOrReq?.channel;
        if (user) logEmbed.addFields({ name: 'User Involved', value: `${user.username || user.tag}#${user.discriminator || '0000'} (<@${user.id}>)`, inline: true });
        if (guild) logEmbed.addFields({ name: 'Origin Guild', value: `${guild.name} (${guild.id})`, inline: true });
        if (channel) logEmbed.addFields({ name: 'Origin Channel', value: `${channel.name} (${channel.id})`, inline: true });
        if (interactionOrReq && interactionOrReq.ip) logEmbed.addFields({ name: 'Request IP', value: interactionOrReq.ip, inline: true });
        for (const field of additionalFields) {
            if (logEmbed.data.fields && logEmbed.data.fields.length >= 23) { logEmbed.addFields({name: "Details Truncated", value: "Max embed fields reached."}); break; }
            logEmbed.addFields(field);
        }
        await logChannel.send({ embeds: [logEmbed] });
    } catch (e) { console.error("CRITICAL: Failed to send action log to Discord:", e); }
}

async function getGitHubJsonFile(filePath, logContext) {
  console.log(`Fetching ${logContext} from GitHub: ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}/${filePath}`);
  let rawDataContent;
  try {
    const response = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO_OWNER, repo: config.GITHUB_REPO_NAME,
      path: filePath, ref: config.GITHUB_BRANCH,
      headers: { 'Accept': 'application/vnd.github.v3.raw', 'Cache-Control': 'no-cache, no-store, must-revalidate' }
    });
    rawDataContent = response.data;
    if (response.status !== 200) throw new Error(`GitHub API request failed for ${filePath} with status ${response.status}`);
    console.log(`${logContext} content fetched. Type: ${typeof rawDataContent}. Length: ${typeof rawDataContent === 'string' ? rawDataContent.length : 'N/A'}`);
    if (typeof rawDataContent === 'string') {
      if (rawDataContent.trim() === "") { console.warn(`${logContext} file (${filePath}) is empty. Returning empty array.`); return []; }
      const parsedData = JSON.parse(rawDataContent);
      if (!Array.isArray(parsedData)) {
          console.warn(`Parsed ${logContext} data from ${filePath} is not an array. Type: ${typeof parsedData}. Preview: ${JSON.stringify(parsedData).substring(0,200)}`);
          throw new Error(`Parsed ${logContext} data from GitHub (${filePath}) is not an array.`);
      }
      console.log(`${logContext} (${filePath}) parsed. Found ${parsedData.length} entries.`);
      return parsedData;
    }
    console.error(`Unexpected ${logContext} response format for ${filePath}: not a string. Type: ${typeof rawDataContent}`);
    throw new Error(`Unexpected ${logContext} response format from ${filePath}: not a string.`);
  } catch (error) {
    console.error(`Error in getGitHubJsonFile for ${logContext} (${filePath}): ${error.message}`);
    const rawDataPreview = typeof rawDataContent === 'string' ? rawDataContent.substring(0,200) : (rawDataContent ? JSON.stringify(rawDataContent).substring(0, 200) : "N/A");
    await sendActionLogToDiscord( `GitHub ${logContext} Fetch/Parse Error`, `Failed to get/parse ${filePath}: ${error.message}\nPreview: \`\`\`${rawDataPreview}\`\`\``, null, 0xED4245);
    throw new Error(`Failed to fetch or parse ${logContext} from GitHub. Path: ${filePath}. Original error: ${error.message}`);
  }
}
async function getWhitelistFromGitHub() { return getGitHubJsonFile(config.WHITELIST_PATH, "Whitelist"); }
async function getScriptHubDataFromGitHub() { return getGitHubJsonFile(config.SCRIPTS_JSON_PATH, "Script Hub Data"); }

async function updateWhitelistOnGitHub(newWhitelist, actionMessage = 'Update whitelist') {
  console.log(`Updating whitelist on GitHub: ${actionMessage}`);
  try {
    const { data: fileData } = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO_OWNER, repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH, ref: config.GITHUB_BRANCH,
      headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
    });
    await octokit.rest.repos.createOrUpdateFileContents({
      owner: config.GITHUB_REPO_OWNER, repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH,
      message: `${actionMessage} - ${new Date().toISOString()}`,
      content: Buffer.from(JSON.stringify(newWhitelist, null, 2)).toString('base64'),
      sha: fileData.sha, branch: config.GITHUB_BRANCH
    });
    console.log("Whitelist updated successfully on GitHub.");
    return true;
  } catch (error) {
    console.error(`GitHub API Error (updateWhitelist): Status ${error.status}, Message: ${error.message}`);
    await sendActionLogToDiscord( 'GitHub Whitelist Update Error', `Failed to update whitelist for action "${actionMessage}": ${error.message}`, null, 0xED4245);
    throw new Error(`Failed to update whitelist on GitHub. Original: ${error.message}`);
  }
}

const SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT = '[Full script content attached as a .lua file due to length.]';
const SCRIPT_IN_ATTACHMENT_PLACEHOLDER = '```lua\n' + SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT + '\n```';

async function sendToDiscordChannel(embedData, fullScriptContent = null) {
  try {
    const channel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
    if (!channel) throw new Error('Log channel not found for script log.');
    const embed = new EmbedBuilder(embedData); // Already an object, can be passed directly or use .set fields
    const messageOptions = { embeds: [embed], components: [] };
    if (fullScriptContent && fullScriptContent.trim().length > 0) {
      if (fullScriptContent.length > config.SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT) {
        const currentDescription = embed.data.description || ''; // Access description from data if it's a plain object
        embed.setDescription(currentDescription.replace(/```lua\n[\s\S]*?\n```/, SCRIPT_IN_ATTACHMENT_PLACEHOLDER));
        messageOptions.files = [new AttachmentBuilder(Buffer.from(fullScriptContent, 'utf-8'), { name: `script_log_${generateLogId()}.lua` })];
      }
    }
    messageOptions.components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('blacklist_user_from_log').setLabel('Blacklist User').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('get_asset_script_from_log').setLabel('Download Found Assets').setStyle(ButtonStyle.Primary)
        .setDisabled(!fullScriptContent || fullScriptContent.trim().length === 0)
    ));
    return channel.send(messageOptions);
  } catch (error) { console.error('Discord sendToDiscordChannel (script log) error:', error); }
}

async function handleBlacklist(interaction) {
  let hasRepliedOrDeferred = false;
  const originalMessageURL = interaction.message.url;
  try {
    console.log(`handleBlacklist: Deferring reply for ${interaction.user.tag} on message ${originalMessageURL}`);
    await interaction.deferReply({ ephemeral: true });
    hasRepliedOrDeferred = true;
    console.log("handleBlacklist: Reply deferred.");
    const originalMessage = interaction.message;
    const embed = originalMessage.embeds[0];
    if (!embed || typeof embed.description !== 'string' || embed.description.trim() === '') {
      const errorMsg = "Blacklist Error: Embed description invalid.";
      console.error(errorMsg, "Embed data:", JSON.stringify(embed).substring(0,500));
      await sendActionLogToDiscord('Blacklist Pre-check Failed', errorMsg, interaction, 0xED4245, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
      return interaction.editReply({ content: 'Error: Log embed malformed.' });
    }
    const descriptionToSearch = embed.description.trim();
    const lines = descriptionToSearch.split('\n');
    let discordLine = lines.find(line => line.toLowerCase().includes("discord:"));
    let targetUserId = null;
    if (discordLine) {
      const lineMatch = discordLine.match(/<@!?(\d+)>/);
      if (lineMatch && lineMatch[1]) targetUserId = lineMatch[1];
    }
    const robloxUsernameMatch = descriptionToSearch.match(/\*\*Username:\*\* \*\*([^*]+)\*\*/);
    const robloxUsername = robloxUsernameMatch ? robloxUsernameMatch[1] : 'Unknown Roblox User';
    if (!targetUserId) {
      const errorMsg = `Failed to match Discord ID. Line found: ${discordLine ? JSON.stringify(discordLine) : 'None'}. Desc start: ${descriptionToSearch.substring(0,100)}`;
      console.error(errorMsg);
      await sendActionLogToDiscord('Blacklist Failed - ID Extraction', errorMsg, interaction, 0xED4245, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
      return interaction.editReply({ content: 'Error: Could not extract Discord ID. Admins notified.' });
    }
    console.log(`Extracted for blacklist: Discord ID=${targetUserId}, Roblox User=${robloxUsername}`);
    let whitelist;
    try { whitelist = await getWhitelistFromGitHub(); }
    catch (ghError) { return interaction.editReply({ content: `Error fetching whitelist: ${ghError.message}` }); } // getWhitelistFromGitHub already logs to Discord
    if (!Array.isArray(whitelist)) {
        await sendActionLogToDiscord('Blacklist Failed - Whitelist Malformed', 'Whitelist data from GitHub was not an array.', interaction, 0xED4245);
        return interaction.editReply({ content: 'Error: Whitelist data is malformed.' });
    }
    const targetEntryIndex = whitelist.findIndex(entry => entry && entry.Discord === targetUserId);
    if (targetEntryIndex === -1) {
      const errorMsg = `User <@${targetUserId}> (Roblox: ${robloxUsername}) not found in whitelist.`;
      await sendActionLogToDiscord('Blacklist Info - User Not Found', errorMsg, interaction, 0xFEE75C, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
      return interaction.editReply({ content: errorMsg });
    }
    const targetEntry = whitelist[targetEntryIndex];
    const newWhitelist = whitelist.filter(entry => entry && entry.Discord !== targetUserId);
    try { await updateWhitelistOnGitHub(newWhitelist, `Blacklist ${targetEntry.User} (${targetUserId}) by ${interaction.user.tag}`); }
    catch (ghError) { return interaction.editReply({ content: `Error updating whitelist: ${ghError.message}` }); } // updateWhitelistOnGitHub already logs
    let rolesRemovedMessage = "User not in this server or no relevant roles.";
    if (interaction.guild) {
      const member = await interaction.guild.members.fetch(targetUserId).catch(() => null);
      if (member) {
        const rolesToRemoveIds = Object.values(config.ROLES).filter(Boolean); // This will take values like "Standard", "Premium"
        // This part needs adjustment if config.ROLES stores actual role IDs not names from whitelist
        // Assuming Whitelist.json stores tier names that match config.ROLES keys for now.
        // Or if config.ROLES values ARE the role IDs:
        // const rolesToRemoveIds = Object.values(config.ROLES).filter(id => typeof id === 'string' && /^\d+$/.test(id));
        const removedRoleNames = [];
        const relevantGuildRoles = Object.values(config.ROLES).map(roleNameOrId => {
            // This logic is tricky: if config.ROLES values are names, you need to find role by name.
            // If they are IDs, you use them directly.
            // For now, let's assume your config.ROLES values ARE the actual Discord Role IDs.
            return interaction.guild.roles.cache.get(String(roleNameOrId)); // Ensure it's a string if it's a number
        }).filter(Boolean);

        for (const role of relevantGuildRoles) {
          if (member.roles.cache.has(role.id)) {
            try { await member.roles.remove(role.id, `Blacklisted by ${interaction.user.tag}`); removedRoleNames.push(role.name); }
            catch (e) { console.warn(`Failed to remove role ${role.name} (${role.id}) from ${targetUserId}:`, e); }
          }
        }
        if (removedRoleNames.length > 0) rolesRemovedMessage = `Removed roles: ${removedRoleNames.join(', ')}.`;
        else rolesRemovedMessage = "User had no relevant roles to remove.";
      }
    } else { console.warn("Interaction for blacklist is not in a guild. Cannot manage roles.") }
    try {
      const user = await discordClient.users.fetch(targetUserId);
      await user.send({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('🚨 You Have Been Blacklisted')
        .setDescription('You have been blacklisted from our services due to administrative action.')
        .addFields( { name: 'Roblox Username', value: targetEntry.User || 'N/A', inline: true }, { name: 'Previous Tier', value: targetEntry.Whitelist || 'N/A', inline: true }, { name: 'Action Taken By', value: interaction.user.tag, inline: false }).setTimestamp()]});
    } catch (e) { console.warn(`Failed to DM ${targetUserId} about blacklist:`, e.message); }
    await interaction.editReply({ content: `Blacklisted ${robloxUsername} (<@${targetUserId}>). ${rolesRemovedMessage}` });
    await sendActionLogToDiscord('🛡️ User Blacklist SUCCESS', `User ${robloxUsername} (<@${targetUserId}>) has been blacklisted.`, interaction, 0x57F287, [ { name: 'Target Discord ID', value: targetUserId, inline: true }, { name: 'Target Roblox User', value: targetEntry.User, inline: true }, { name: 'Previous Tier', value: targetEntry.Whitelist, inline: true }, { name: 'Role Status', value: rolesRemovedMessage, inline: false }, {name: "Original Log Message", value: `[Link](${originalMessageURL})`} ]);
  } catch (error) {
    console.error('Blacklist command main catch error:', error);
    await sendActionLogToDiscord('Blacklist Failed - Unexpected Error', `Error: ${error.message}\n\`\`\`${error.stack ? error.stack.substring(0,800) : "No stack"}\n\`\`\``, interaction, 0xED4245, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
    if (hasRepliedOrDeferred && !interaction.replied) await interaction.editReply({ content: 'An unexpected error occurred during blacklisting. Admins notified.', ephemeral: true }).catch(console.error);
    else if (!hasRepliedOrDeferred && !interaction.replied) await interaction.reply({ content: 'An error occurred, interaction state unclear. Admins notified.', ephemeral: true }).catch(console.error);
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
    const logAttachment = originalMessage.attachments.first();
    if (logAttachment?.name.endsWith('.lua')) {
      try { scriptContentToAnalyze = (await axios.get(logAttachment.url, { responseType: 'text' })).data; }
      catch (fetchError) { console.warn("Failed to fetch script from attachment URL for asset parsing:", fetchError.message); }
    }
    if (!scriptContentToAnalyze) {
      const embed = originalMessage.embeds[0];
      if (embed?.description) {
        const match = embed.description.match(/```lua\n([\s\S]*?)\n```/);
        if (match && match[1] !== SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT) scriptContentToAnalyze = match[1];
      }
    }
    if (!scriptContentToAnalyze) {
      await sendActionLogToDiscord('Asset Download Failed - No Script', 'Could not find script content in the log message to analyze.', interaction, 0xFEE75C, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
      return interaction.editReply({ content: 'No script content found to analyze for assets.' });
    }
    const assetIds = new Set();
    const regexes = [
      /require\s*\(\s*(\d+)\s*\)/g, /(?:GetObjects|InsertService:LoadAsset(?:Version)?)\s*\(\s*(?:["']rbxassetid:\/\/(\d+)["']|(\d+))\s*\)/gi,
      /Content\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi, /Image\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi,
      /Texture(?:Id)?\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi, /SoundId\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi,
      /MeshId\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi,
    ];
    for (const regex of regexes) { let match; while ((match = regex.exec(scriptContentToAnalyze)) !== null) assetIds.add(match[1] || match[2]); }
    const uniqueAssetIds = Array.from(assetIds).filter(id => id && /^\d+$/.test(id));
    let replyContent = "No downloadable asset IDs found in the script.";
    const assetFiles = [];
    if (uniqueAssetIds.length > 0) {
      const assetLinks = []; let assetsProcessed = 0;
      for (const assetId of uniqueAssetIds) {
        if (assetsProcessed >= 10) { console.warn("Reached attachment limit for asset download, truncating."); break; }
        const placeholderRbxmContent = `-- Roblox Asset: ${assetId}\n-- This is a placeholder file. Use the ID on the Roblox website or in Studio.\nprint("Asset ID: ${assetId}")`;
        assetFiles.push(new AttachmentBuilder(Buffer.from(placeholderRbxmContent, 'utf-8'), { name: `${assetId}.rbxm` }));
        assetLinks.push(`[${assetId}](https://www.roblox.com/library/${assetId})`);
        assetsProcessed++;
      }
      if (assetFiles.length > 0) {
        replyContent = `Found Asset ID(s) - Placeholder .rbxm files attached:\n${assetLinks.join('\n')}`;
        await sendActionLogToDiscord('Assets Found & Sent', `User requested assets. Found: ${assetLinks.join(', ')}. Sent ${assetFiles.length} placeholder rbxm files.`, interaction, 0x57F287, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
      } else {
        replyContent = "Found asset IDs, but issue preparing them for download."; // Should be rare
        await sendActionLogToDiscord('Asset Download Issue - Preparation', replyContent, interaction, 0xFEE75C, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
      }
    } else {
      await sendActionLogToDiscord('No Assets Found in Script', 'User requested assets, but no recognized IDs were found in the script.', interaction, 0x5865F2, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
    }
    await interaction.editReply({ content: replyContent, files: assetFiles, ephemeral: true });
  } catch (error) {
    console.error('Get Asset/Script error:', error);
    await sendActionLogToDiscord('Get Asset/Script Failed - Unexpected Error', `Error: ${error.message}\nStack: ${error.stack ? error.stack.substring(0,800) : "N/A"}`, interaction, 0xED4245, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
    if (hasRepliedOrDeferredAsset && !interaction.replied) await interaction.editReply({ content: 'Error processing asset download. Admins notified.' }).catch(console.error);
    else if (!hasRepliedOrDeferredAsset && !interaction.replied) await interaction.reply({ content: 'Error processing asset download. Admins notified.', ephemeral: true }).catch(console.error);
  }
}

// --- HTML PAGE GENERATION HELPER --- (already defined above)

// --- IN-MEMORY STORES --- (already defined above)

// --- API ENDPOINTS ---
app.post('/queue/:username', (req, res) => {
    const username = req.params.username.toLowerCase();
    const scriptText = req.body.script; 
    if (typeof scriptText !== 'string') {
        return res.status(400).json({ status: 'error', message: 'Script text must be a string.' });
    }
    scriptQueue[username] = scriptText;
    console.log(`Script queued for ${username}. Length: ${scriptText.length}`);
    res.status(200).json({ status: 'success', message: `Script queued for ${username}.` });
});
app.get('/queue/:username', (req, res) => {
    if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only for GET /queue.' });
    const username = req.params.username.toLowerCase();
    const scriptText = scriptQueue[username];
    if (scriptText) {
        delete scriptQueue[username]; 
        console.log(`Script fetched for ${username} by Roblox and removed from queue.`);
        res.set('Content-Type', 'text/plain').send(scriptText);
    } else {
        console.log(`No script in queue for ${username} when fetched by Roblox.`);
        res.status(200).send(''); // Send empty 200 for Roblox not to error, instead of 404
    }
});
// /api/gamelog (already defined above)
// /verify/:username (already defined above)
// /download/:assetId (already defined above)
// /send/scriptlogs (already defined above)
// /scripts/LuaMenu (already defined above)

// --- AUTH ROUTES --- (already defined above)

// --- WEB PAGE ROUTES ---
// / (already defined above)
// /dashboard (already defined above)
app.get('/executor', isAuthenticatedAndHasRole, (req, res) => {
    const user = req.user;
    const targetRobloxUsername = user.robloxUsername || ""; 

    const content = `
        <p>Execute scripts for Roblox user: <strong>${targetRobloxUsername || 'N/A (Link Account via Whitelist)'}</strong> (Tier: ${user.whitelistTier})</p>
        <textarea id="scriptInput" rows="15" placeholder="Enter Lua script here..."></textarea><br>
        <button class="button" onclick="executeScript()" ${!targetRobloxUsername ? 'disabled title="Link your Roblox account in the whitelist to use the executor."' : ''}>Queue Script</button>
        <div id="executorStatus" style="margin-top:1rem;"></div>
        <script>
            function executeScript() {
                const script = document.getElementById('scriptInput').value;
                const statusDiv = document.getElementById('executorStatus');
                const robloxUsername = "${targetRobloxUsername}";

                if (!robloxUsername) {
                    statusDiv.innerHTML = '<p class="error-msg">Roblox username not available. Please ensure your account is linked in the whitelist.</p>';
                    return;
                }
                statusDiv.innerHTML = 'Queuing script...';
                fetch('/queue/' + robloxUsername, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ script: script })
                })
                .then(response => response.json())
                .then(data => {
                    if (data.status === 'success') {
                        statusDiv.innerHTML = '<p class="success-msg">Script queued successfully for ' + robloxUsername + '! It will be executed by the game client shortly.</p>';
                    } else {
                        statusDiv.innerHTML = '<p class="error-msg">Error queuing script: ' + (data.message || 'Unknown error') + '</p>';
                    }
                })
                .catch(err => {
                    statusDiv.innerHTML = '<p class="error-msg">Fetch Error: ' + err + '</p>';
                });
            }
        </script>
    `;
    res.send(getPageHTML("Executor", content, req.user, req));
});

app.get('/scripthub', isAuthenticatedAndHasRole, async (req, res) => {
    const user = req.user;
    let scriptsToShow = [];
    let errorMessage = '';
    try {
        scriptsToShow = await getScriptHubDataFromGitHub();
        if (!Array.isArray(scriptsToShow)) {
            errorMessage = "Could not load scripts: Data is not in the correct format."; scriptsToShow = [];
        }
    } catch (error) {
        console.error("Error fetching scripts for Script Hub:", error); errorMessage = "Could not load scripts from source. Please try again later.";
    }
    const content = `
        <p>Browse scripts. Your Roblox Username: <strong>${user.robloxUsername || 'N/A (Link Account)'}</strong></p>
        ${errorMessage ? `<p class="error-msg">${errorMessage}</p>` : ''}
        <div class="card-grid">
            ${scriptsToShow.map(script => {
                let canRun = true; let reason = "";
                const scriptNameLower = script.Name.toLowerCase();
                const userTierLower = user.whitelistTier?.toLowerCase();

                if (scriptNameLower.includes("(premium+)") && !(userTierLower?.includes("premium") || userTierLower?.includes("ultimate") || userTierLower?.includes(config.ROLES.STAFF.toLowerCase()))) {
                    canRun = false; reason = "Requires Premium+ or higher.";
                }
                if (scriptNameLower.includes("(ultimate)") && !(userTierLower?.includes("ultimate") || userTierLower?.includes(config.ROLES.STAFF.toLowerCase()))) {
                    canRun = false; reason = "Requires Ultimate or higher.";
                }
                if (scriptNameLower.includes("(staff)") && !(userTierLower?.includes(config.ROLES.STAFF.toLowerCase()))) {
                    canRun = false; reason = "Requires Staff tier.";
                }
                return `
                <div class="card" style="${!canRun ? 'opacity:0.65; background-color: var(--surface2);' : ''}">
                    <h3>${script.Name}</h3>
                    ${script.Description ? `<p><small>${script.Description}</small></p>` : ''}
                    ${canRun && user.robloxUsername ? 
                        `<button class="button" onclick="runScriptHubScript('${script.Name.replace(/'/g, "\\'")}', \`${script.Script.replace(/`/g, "\\`")}\`)">Queue Script</button>` :
                        (!user.robloxUsername ? '<p><small style="color:var(--yellow);">Link Roblox account to run.</small></p>' : `<p><small style="color:var(--red);">${reason}</small></p>`)
                    }
                </div>`;}).join('')}
        </div>
        <div id="scripthubStatus" style="margin-top:1rem;"></div>
        <script>
            function runScriptHubScript(scriptName, scriptTemplate) {
                const robloxUsername = "${user.robloxUsername || ''}";
                if (!robloxUsername) {
                    document.getElementById('scripthubStatus').innerHTML = '<p class="error-msg">Roblox username not available. Please ensure your account is linked in the whitelist.</p>';
                    return;
                }
                const finalScript = scriptTemplate.replace(/%ROBLOX_USERNAME%/g, robloxUsername);
                const statusDiv = document.getElementById('scripthubStatus');
                statusDiv.innerHTML = 'Queuing script: ' + scriptName + '...';
                fetch('/queue/' + robloxUsername, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ script: finalScript })
                })
                .then(res => res.json()).then(data => {
                    statusDiv.innerHTML = data.status === 'success' ? '<p class="success-msg">Script "' + scriptName + '" queued for ' + robloxUsername + '!</p>' : '<p class="error-msg">Error: ' + (data.message || 'Unknown') + '</p>';
                }).catch(err => { statusDiv.innerHTML = '<p class="error-msg">Fetch Error: ' + err + '</p>'; });
            }
        </script>
    `;
    res.send(getPageHTML("Script Hub", content, req.user, req));
});

app.get('/gamelogs', isAuthenticatedAndHasRole, async (req, res) => {
    const displayLogs = gameLogs.slice(-50).reverse(); // Show last 50
    const content = `
        <p>Recent game activity reported to the server (shows last ${displayLogs.length} events).</p>
        ${displayLogs.length === 0 ? '<p>No game logs recorded yet.</p>' : `
            <table style="width:100%;"><thead><tr><th>Timestamp</th><th>Game Name</th><th>ServerSide</th><th>Event</th><th>Message</th></tr></thead><tbody>
            ${displayLogs.map(log => `<tr>
                <td>${new Date(log.timestamp || Date.now()).toLocaleString()}</td>
                <td>${log.gameInfo?.ROBLOX_GAME_NAME || log.gameInfo?.gameName || 'N/A'}</td>
                <td>${log.serverSideDetails?.VANGUARD_SERVERSIDE_NAME || log.serverSideDetails?.name || 'N/A'}</td>
                <td>${log.logEvent?.type || 'N/A'}</td>
                <td>${(log.logEvent?.message || 'N/A').substring(0,100)}</td>
            </tr>`).join('')}</tbody></table>`}
    `;
    res.send(getPageHTML("Game Logs", content, req.user, req));
});

// --- DISCORD BOT & SERVER START ---
discordClient.on('interactionCreate', async interaction => { /* Defined above */ });
discordClient.on('ready', () => { /* Defined above */ });
process.on('unhandledRejection', (r, p) => console.error('Unhandled Rejection at Promise:', p, 'reason:', r));
process.on('uncaughtException', e => { console.error('Uncaught Exception:', e); /* process.exit(1); // Consider if you want to exit on uncaught exceptions */ });
async function startServer() {
  try {
    await discordClient.login(config.DISCORD_BOT_TOKEN);
    app.listen(config.PORT, () => {
        console.log(`API server running on http://localhost:${config.PORT}`);
        console.log(`Discord Bot Client logged in. OAuth2 Callback URL: ${config.CALLBACK_URL}`);
    });
  } catch (error) { console.error('Startup failed:', error); process.exit(1); }
}

startServer();
