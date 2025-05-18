require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder, ActivityType } = require('discord.js');
const { RobloxXMLParser, RobloxBinaryParser, Instance } = require('rbx-roblox-asset-parser'); // Added parser

// Config from environment variables
const config = {
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_LUA_MENU_URL: process.env.GITHUB_LUA_MENU_URL,
  LOG_CHANNEL_ID: '1331021897735081984', // Ensure this is correct
  GITHUB_REPO_OWNER: process.env.GITHUB_REPO_OWNER || 'RelaxxxX-Lab',
  GITHUB_REPO_NAME: process.env.GITHUB_REPO_NAME || 'Lua-things',
  GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
  WHITELIST_PATH: process.env.WHITELIST_PATH || 'Whitelist.json',
  ROLES: {
    STANDARD: '1330552089759191064', // Ensure this is correct
    PREMIUM: '1333286640248029264', // Ensure this is correct
    ULTIMATE: '1337177751202828300' // Ensure this is correct
  },
  PORT: process.env.PORT || 3000,
  SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT: 100, // Characters
  OBFUSCATION_LINE_LENGTH_THRESHOLD: 250, // Characters for a single line to be considered suspicious
  OBFUSCATION_NON_ALPHANUM_RATIO: 0.35, // Ratio of non-alphanumeric (excluding spaces, typical Lua chars)
};

// Security & Analysis Constants
const MALICIOUS_KEYWORDS_NAMES = [
    'loadstring', 'fione', 'yueliang', 'executor', 'execute'
];
const MALICIOUS_KEYWORDS_SCRIPTS = [
    'getfenv', 'setfenv', 'debug', 'moonsec v3',
    'http://', 'https://', 'require', 'pcall', 'xpcall',
    'webhook', 'discord.com/api/webhooks', 'pastebin.com', 'controlc.com'
];
const SUSPICIOUS_URL_PATTERNS = [
    /discord\.com\/api\/webhooks\//i,
    /pastebin\.com\/(raw\/)?[a-zA-Z0-9]{8}/i,
    /controlc\.com\/[a-zA-Z0-9]+/i,
    /cdn\.discordapp\.com\/attachments\//i, // Can be legitimate, but also abused
    // --- Added URLs ---
    /[a-zA-Z0-9-]+\.vercel\.app/i,        // Vercel: e.g., my-project.vercel.app
    /[a-zA-Z0-9-]+\.onrender\.com/i,     // OnRender: e.g., my-service.onrender.com
    /[a-zA-Z0-9-]+\.pythonanywhere\.com/i // PythonAnywhere: e.g., myusername.pythonanywhere.com
    // ------------------
    // Add more known malicious or suspicious domains/patterns
];
const KNOWN_LEGIT_URL_DOMAINS = [
    'roblox.com', 'github.com', 'gitlab.com', 'google.com', // Add your own legit script sources if any
];


if (!config.API_KEY || !config.GITHUB_TOKEN || !config.DISCORD_BOT_TOKEN || !config.GITHUB_LUA_MENU_URL) {
  console.error('FATAL ERROR: Missing essential environment variables.');
  process.exit(1);
}

const app = express();
const octokit = new Octokit({ auth: config.GITHUB_TOKEN, request: { timeout: 15000 } });
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers
  ]
});

app.use(bodyParser.json({ limit: '500mb' }));

function generateLogId() { return crypto.randomBytes(8).toString('hex'); }
function isFromRoblox(req) { return (req.headers['user-agent'] || '').includes('Roblox'); }

// --- Obfuscation Detection Helper ---
function isScriptObfuscated(scriptContent) {
    if (!scriptContent || typeof scriptContent !== 'string') return { isObfuscated: false, reasons: [] };

    const reasons = [];
    const lines = scriptContent.split('\n');

    // 1. Very long lines
    if (lines.some(line => line.length > config.OBFUSCATION_LINE_LENGTH_THRESHOLD)) {
        reasons.push(`Line(s) longer than ${config.OBFUSCATION_LINE_LENGTH_THRESHOLD} chars`);
    }

    // 2. High ratio of non-alphanumeric characters (simplified)
    const anChars = scriptContent.replace(/[^a-z0-9\s\(\)\{\}\[\]\.=",;:_\+\-\*\/%\<\>\!\#]/gi, '');
    const nonAnRatio = 1 - (anChars.length / scriptContent.length);
    if (nonAnRatio > config.OBFUSCATION_NON_ALPHANUM_RATIO && scriptContent.length > 50) { // Avoid short strings triggering this
        reasons.push(`High non-alphanumeric ratio (${(nonAnRatio * 100).toFixed(1)}%)`);
    }

    // 3. Presence of \x hex escapes or many string.char calls
    if (scriptContent.includes('\\x') || (scriptContent.match(/string\.char/g) || []).length > 10) {
        reasons.push("Hex escapes ('\\x') or many 'string.char' calls");
    }

    // 4. Common obfuscator keywords/patterns
    if (/\b_G\b/.test(scriptContent) && !scriptContent.includes("game:GetService")) { // _G is common, but standalone _G might be suspicious
         reasons.push("Global table access ('_G')");
    }
    if (/\bgetfenv\b\(0\)/.test(scriptContent)) { // getfenv(0) is a strong indicator
        reasons.push("Found 'getfenv(0)'");
    }

    return { isObfuscated: reasons.length > 0, reasons: reasons };
}


// Helper function to send logs to the Discord log channel
async function sendActionLogToDiscord(title, description, interaction, color = 0x0099FF, additionalFields = []) {
    try {
        const logChannel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
        if (!logChannel) {
            console.error("Failed to fetch log channel for reporting. Channel ID:", config.LOG_CHANNEL_ID);
            return;
        }
        const logEmbed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description.substring(0, 4000)).setTimestamp();
        if (interaction) { // interaction can be null if called from non-interaction context
            logEmbed.addFields({ name: 'Action Initiated By', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true });
            if (interaction.guild) {
                 logEmbed.addFields({ name: 'Context', value: `Guild: ${interaction.guild.name}\nChannel: ${interaction.channel.name}`, inline: true });
            }
        }
        for (const field of additionalFields) {
            if (logEmbed.data.fields && logEmbed.data.fields.length >= 23 && additionalFields.length > 0) {
                logEmbed.addFields({name: "Details Truncated", value: "Too many fields for one embed."}); break;
            }
            logEmbed.addFields(field);
        }
        await logChannel.send({ embeds: [logEmbed] });
    } catch (logSendError) { console.error("CRITICAL: Failed to send action log to Discord:", logSendError); }
}


async function getWhitelistFromGitHub() {
  // ... (no changes from your provided code, assuming it's working)
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
    } else if (typeof rawDataContent === 'object' && rawDataContent !== null && Array.isArray(rawDataContent)) {
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
  // ... (no changes from your provided code, assuming it's working)
  console.log("Updating whitelist on GitHub...");
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
    if (!channel) throw new Error('Log channel not found for script log.');

    const embed = new EmbedBuilder(embedData);
    const messageOptions = { embeds: [embed], components: [] };

    if (fullScriptContent && fullScriptContent.trim().length > 0) {
      // Check for obfuscation in the main script log
      const obfuscationCheck = isScriptObfuscated(fullScriptContent);
      if (obfuscationCheck.isObfuscated) {
          embed.addFields({ name: '⚠️ Obfuscation Detected', value: obfuscationCheck.reasons.join(', ') || 'Generic obfuscation patterns found.' });
          embed.setColor(0xFFA500); // Orange for warning
      }

      if (fullScriptContent.length > config.SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT) {
        embed.setDescription((embed.data.description || '').replace(/```lua\n[\s\S]*?\n```/, SCRIPT_IN_ATTACHMENT_PLACEHOLDER));
        messageOptions.files = [new AttachmentBuilder(Buffer.from(fullScriptContent, 'utf-8'), { name: `script_log_${generateLogId()}.lua` })];
      }
    }

    messageOptions.components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('blacklist_user_from_log').setLabel('Blacklist User').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('get_asset_script_from_log')
        .setLabel('Download & Analyze Assets') // Updated Label
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!fullScriptContent || fullScriptContent.trim().length === 0)
    ));
    return channel.send(messageOptions);
  } catch (error) { console.error('Discord sendToDiscordChannel (script log) error:', error); }
}

async function handleBlacklist(interaction) {
  // ... (no changes from your provided code for blacklist logic)
  let hasRepliedOrDeferred = false;
  const originalMessageURL = interaction.message.url;
  try {
    console.log("handleBlacklist: Deferring reply...");
    await interaction.deferReply({ ephemeral: true });
    hasRepliedOrDeferred = true;
    console.log("handleBlacklist: Reply deferred.");
    const originalMessage = interaction.message;
    const embed = originalMessage.embeds[0];
    if (!embed || typeof embed.description !== 'string' || embed.description.trim() === '') {
      const errorMsg = "Blacklist Error: Embed description is missing, not a string, or empty.";
      console.error(errorMsg);
      const embedContentForDebug = embed ? JSON.stringify(embed).substring(0,1000) : "Embed object is null/undefined";
      await sendActionLogToDiscord('Blacklist Pre-check Failed', errorMsg, interaction, 0xFF0000, [{name: "Original Message", value: `[Link](${originalMessageURL})`}, {name: "Faulty Embed (Partial)", value: `\`\`\`json\n${embedContentForDebug}\n\`\`\``}]);
      return interaction.editReply({ content: 'Error: Critical information missing from log embed (description).' });
    }
    const rawDescription = embed.description;
    const descriptionToSearch = rawDescription.trim();
    const lines = descriptionToSearch.split('\n');
    let discordLine = null;
    for (const line of lines) { if (line.toLowerCase().includes("discord:")) { discordLine = line; break; } }
    let targetUserId = null;
    if (discordLine) {
      const idPatternOnLine = /<@!?(\d+)>/;
      const lineMatch = discordLine.match(idPatternOnLine);
      if (lineMatch && lineMatch[1]) { targetUserId = lineMatch[1]; }
    }
    const robloxUsernameRegex = /\*\*Username:\*\* \*\*([^*]+)\*\*/;
    const robloxUsernameMatch = descriptionToSearch.match(robloxUsernameRegex);
    const robloxUsername = robloxUsernameMatch ? robloxUsernameMatch[1] : 'Unknown Roblox User';
    if (!targetUserId) {
      const errorMsg = `Failed to match Discord ID. Last discordLine found: ${discordLine ? JSON.stringify(discordLine) : 'null'}. Raw Description (start): ${descriptionToSearch.substring(0,200)}...`;
      console.error(errorMsg);
      await sendActionLogToDiscord('Blacklist Failed - ID Extraction', errorMsg, interaction, 0xFF0000, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
      return interaction.editReply({ content: 'Error: Could not extract Discord ID from the embed (debug attempt failed). Admins notified.' });
    }
    console.log(`Extracted for blacklist: Discord ID=${targetUserId}, Roblox User=${robloxUsername}`);
    let whitelist;
    try { whitelist = await getWhitelistFromGitHub(); }
    catch (ghError) {
      return interaction.editReply({ content: `Error fetching whitelist: ${ghError.message}` });
    }
    if (!Array.isArray(whitelist)) {
        await sendActionLogToDiscord('Blacklist Failed - Whitelist Data Malformed', 'Received non-array whitelist data after GitHub fetch.', interaction, 0xFF0000, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
        return interaction.editReply({ content: 'Error: Whitelist data is malformed.' });
    }
    const targetEntryIndex = whitelist.findIndex(entry => entry && entry.Discord === targetUserId);
    if (targetEntryIndex === -1) {
      const errorMsg = `User <@${targetUserId}> (Roblox: ${robloxUsername}) not found in whitelist.`;
      console.log(errorMsg);
      await sendActionLogToDiscord('Blacklist Warning - User Not Found', errorMsg, interaction, 0xFFA500, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
      return interaction.editReply({ content: errorMsg });
    }
    const targetEntry = whitelist[targetEntryIndex];
    const newWhitelist = whitelist.filter(entry => entry && entry.Discord !== targetUserId);
    try { await updateWhitelistOnGitHub(newWhitelist, `Blacklist ${targetEntry.User} by ${interaction.user.tag}`); }
    catch (ghError) {
      return interaction.editReply({ content: `Error updating whitelist: ${ghError.message}` });
    }
    let rolesRemovedMessage = "User not in this server or no relevant roles.";
    if (interaction.guild) {
      const member = await interaction.guild.members.fetch(targetUserId).catch(() => null);
      if (member) {
        const rolesToRemoveIds = [config.ROLES.STANDARD, config.ROLES.PREMIUM, config.ROLES.ULTIMATE].filter(Boolean);
        const removedRoleNames = [];
        for (const roleId of rolesToRemoveIds) {
          if (member.roles.cache.has(roleId)) {
            try { await member.roles.remove(roleId, `Blacklisted by ${interaction.user.tag}`); removedRoleNames.push(interaction.guild.roles.cache.get(roleId)?.name || roleId); }
            catch (e) { console.warn(`Failed to remove role ${roleId} from ${targetUserId}:`, e); }
          }
        }
        if (removedRoleNames.length > 0) rolesRemovedMessage = `Removed roles: ${removedRoleNames.join(', ')}.`;
        else rolesRemovedMessage = "User had no relevant roles to remove.";
      }
    } else { console.warn("Interaction for blacklist is not in a guild context. Cannot manage roles.") }
    try {
      const user = await discordClient.users.fetch(targetUserId);
      await user.send({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('🚨 You Have Been Blacklisted')
        .setDescription('You have been blacklisted from our services.')
        .addFields( { name: 'Roblox Username', value: targetEntry.User || 'N/A', inline: true }, { name: 'Previous Tier', value: targetEntry.Whitelist || 'N/A', inline: true }, { name: 'By Staff', value: interaction.user.tag, inline: false }).setTimestamp()]});
    } catch (e) { console.warn(`Failed to DM ${targetUserId} about blacklist:`, e.message); }
    await interaction.editReply({ content: `Blacklisted ${robloxUsername} (<@${targetUserId}>). ${rolesRemovedMessage}` });
    await sendActionLogToDiscord('🛡️ User Blacklist Action SUCCESS', `User ${robloxUsername} (<@${targetUserId}>) has been blacklisted.`, interaction, 0x00FF00, [ { name: 'Target User', value: `<@${targetUserId}> (${targetUserId})`, inline: true }, { name: 'Roblox Username', value: targetEntry.User, inline: true }, { name: 'Previous Tier', value: targetEntry.Whitelist, inline: true }, { name: 'Role Status', value: rolesRemovedMessage, inline: false }, {name: "Original Log Message", value: `[Link](${originalMessageURL})`} ]);
  } catch (error) {
    console.error('Blacklist command main catch error:', error);
    await sendActionLogToDiscord('Blacklist Failed - Unexpected Error', `An unexpected error occurred: ${error.message}\n\`\`\`${error.stack ? error.stack.substring(0,1000) : "No stack"}\n\`\`\``, interaction, 0xFF0000, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
    if (hasRepliedOrDeferred && !interaction.replied) { await interaction.editReply({ content: 'An unexpected error occurred during blacklisting. Admins notified.', ephemeral: true }).catch(err => console.error("Error sending final error reply:", err));
    } else if (!hasRepliedOrDeferred && !interaction.replied) { await interaction.reply({ content: 'An error occurred, and the interaction was not properly deferred. Admins notified.', ephemeral: true }).catch(err => console.error("Error sending emergency reply:", err)); }
  }
}

// --- Asset Analysis Helper ---
async function analyzeAssetContent(assetId, assetBuffer, contentType) {
    const findings = {
        assetId: assetId,
        maliciousNames: [],
        suspiciousScripts: [], // { path: string, issues: string[] }
        obfuscatedScripts: [], // { path: string, reasons: string[] }
        urlsFound: [], // { path: string, url: string, suspicious: boolean }
        requires: [], // { path: string, target: string }
        errors: []
    };

    let rootInstance;
    try {
        if (contentType.includes('rbxmx') || contentType.includes('xml')) {
            rootInstance = RobloxXMLParser.parse(assetBuffer.toString());
        } else if (contentType.includes('rbxm') || contentType.includes('octet-stream')) { // octet-stream is common for binary rbxm
            rootInstance = RobloxBinaryParser.parse(assetBuffer);
        } else if (contentType.includes('lua') || contentType.includes('plain')) { // Direct Lua script
             const scriptContent = assetBuffer.toString();
             const path = `${assetId}.lua (Direct)`;
             const obfuscation = isScriptObfuscated(scriptContent);
             if (obfuscation.isObfuscated) {
                 findings.obfuscatedScripts.push({ path, reasons: obfuscation.reasons });
             }
             MALICIOUS_KEYWORDS_SCRIPTS.forEach(keyword => {
                 if (new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(scriptContent)) { // Escape regex special chars in keyword
                    findings.suspiciousScripts.push({ path, issues: [`Contains keyword: ${keyword}`] });
                 }
             });
             // URL check for direct Lua
             SUSPICIOUS_URL_PATTERNS.forEach(pattern => {
                let match;
                const regex = new RegExp(pattern.source, pattern.flags + 'g'); // Ensure global flag for multiple matches
                while ((match = regex.exec(scriptContent)) !== null) {
                    const url = match[0];
                    const isLegit = KNOWN_LEGIT_URL_DOMAINS.some(domain => url.includes(domain));
                    findings.urlsFound.push({ path, url, suspicious: !isLegit });
                }
            });
            // require check
            let reqMatch;
            const requireRegex = /require\s*\(\s*([^)]+)\s*\)/g;
            while((reqMatch = requireRegex.exec(scriptContent)) !== null) {
                findings.requires.push({ path, target: reqMatch[1].trim() });
            }

            return findings; // Early return for direct Lua script
        } else {
            findings.errors.push(`Unsupported content type for parsing: ${contentType}`);
            return findings;
        }
    } catch (parseError) {
        console.error(`Error parsing asset ${assetId}:`, parseError);
        findings.errors.push(`Parsing error: ${parseError.message}`);
        return findings;
    }

    function traverse(instance, currentPath = '') {
        if (!(instance instanceof Instance)) return;

        const path = currentPath ? `${currentPath}/${instance.name}` : instance.name;

        // 1. Check instance name
        MALICIOUS_KEYWORDS_NAMES.forEach(keyword => {
            if (instance.name && instance.name.toLowerCase().includes(keyword.toLowerCase())) {
                findings.maliciousNames.push({ path, name: instance.name, keyword });
            }
        });

        // 2. If it's a script, analyze its source
        if (instance.className === 'Script' || instance.className === 'LocalScript' || instance.className === 'ModuleScript') {
            const scriptContent = instance.getProperty('Source')?.value;
            if (scriptContent && typeof scriptContent === 'string') {
                const scriptIssues = [];
                const obfuscation = isScriptObfuscated(scriptContent);
                if (obfuscation.isObfuscated) {
                    findings.obfuscatedScripts.push({ path, reasons: obfuscation.reasons });
                }

                MALICIOUS_KEYWORDS_SCRIPTS.forEach(keyword => {
                    if (new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(scriptContent)) {
                        scriptIssues.push(`Contains keyword: ${keyword}`);
                    }
                });

                SUSPICIOUS_URL_PATTERNS.forEach(pattern => {
                    let match;
                    const regex = new RegExp(pattern.source, pattern.flags + 'g');
                    while ((match = regex.exec(scriptContent)) !== null) {
                        const url = match[0];
                        const isLegit = KNOWN_LEGIT_URL_DOMAINS.some(domain => url.includes(domain));
                        findings.urlsFound.push({ path, url, suspicious: !isLegit });
                        if (!isLegit) scriptIssues.push(`Suspicious URL: ${url.substring(0,50)}...`);
                    }
                });
                
                let reqMatch;
                const requireRegex = /require\s*\(\s*([^)]+)\s*\)/g;
                while((reqMatch = requireRegex.exec(scriptContent)) !== null) {
                    const target = reqMatch[1].trim();
                    findings.requires.push({ path, target });
                    // Check if require target is a raw asset ID number
                    if (/^\d+$/.test(target.replace(/["']/g, ''))) {
                         scriptIssues.push(`Requires asset by ID: ${target}`);
                    }
                }


                if (scriptIssues.length > 0) {
                    findings.suspiciousScripts.push({ path, issues: scriptIssues });
                }
            }
        }

        instance.children.forEach(child => traverse(child, path));
    }

    if (rootInstance) {
      rootInstance.children.forEach(child => traverse(child, 'AssetRoot')); // Start traversal from children of the implicit root
    }


    return findings;
}


async function handleGetAssetOrScript(interaction) {
  let hasRepliedOrDeferredAsset = false;
  const originalMessageURL = interaction.message.url;
  try {
    await interaction.deferReply({ ephemeral: true });
    hasRepliedOrDeferredAsset = true;
    const originalMessage = interaction.message;
    let scriptContentToAnalyze = null; // The script from the log message itself

    // Try to get script from attachment first
    const logAttachment = originalMessage.attachments.find(att => att.name.endsWith('.lua'));
    if (logAttachment) {
      try { scriptContentToAnalyze = (await axios.get(logAttachment.url, { responseType: 'text' })).data; }
      catch (fetchError) { console.warn("Failed to fetch script from log attachment URL for asset parsing:", fetchError.message); }
    }
    // If not in attachment, try to get from embed
    if (!scriptContentToAnalyze) {
      const embed = originalMessage.embeds[0];
      if (embed?.description) {
        const match = embed.description.match(/```lua\n([\s\S]*?)\n```/);
        if (match && match[1] !== SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT) scriptContentToAnalyze = match[1];
      }
    }

    if (!scriptContentToAnalyze) {
      await sendActionLogToDiscord('Asset Download Failed - No Script in Log', 'Could not find script content in the log message to analyze for Asset IDs.', interaction, 0xFFA500, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
      return interaction.editReply({ content: 'No script content found in the original log to extract asset IDs from.' });
    }

    const assetIds = new Set();
    const regexes = [
      /require\s*\(\s*(\d+)\s*\)/g,
      /(?:GetObjects|InsertService:LoadAsset(?:Version)?|game:GetObjects|game\.InsertService:LoadAsset(?:Version)?)\s*\(\s*(?:["']rbxassetid:\/\/(\d+)["']|(\d+))\s*\)/gi,
      /Content\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi, /Image\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi,
      /Texture(?:Id)?\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi, /SoundId\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi,
      /MeshId\s*=\s*["']rbxassetid:\/\/(\d+)["']/gi,
      /game:GetService\("MarketplaceService"\):GetProductInfo\(\s*(\d+)\s*\)/gi, // Added MarketplaceService
      /game\.MarketplaceService:GetProductInfo\(\s*(\d+)\s*\)/gi
    ];
    for (const regex of regexes) {
        let match;
        while ((match = regex.exec(scriptContentToAnalyze)) !== null) {
            assetIds.add(match[1] || match[2] || match[3]); // Adjusted for multiple capture groups
        }
    }
    const uniqueAssetIds = Array.from(assetIds).filter(id => id && /^\d+$/.test(id));

    if (uniqueAssetIds.length === 0) {
      await sendActionLogToDiscord('No Asset IDs Found in Script', 'User requested assets, but no numeric Asset IDs were found in the script.', interaction, 0xADD8E6, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
      return interaction.editReply({ content: 'No downloadable asset IDs found in the script.' });
    }

    await interaction.editReply({ content: `Found ${uniqueAssetIds.length} asset ID(s). Downloading and analyzing... This may take a moment.`});

    const downloadedAssets = [];
    const analysisResults = [];
    let overallSeverity = 0; // 0: Clean, 1: Suspicious/Obfuscated, 2: Malicious

    for (const assetId of uniqueAssetIds.slice(0, 5)) { // Limit to 5 assets to prevent abuse/rate limits
        try {
            const assetUrl = `https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`;
            const response = await axios.get(assetUrl, {
                responseType: 'arraybuffer', // Important for binary data
                timeout: 15000,
                headers: {'User-Agent': 'RelaxxxLab-AssetScanner/1.0'}
            });

            const assetBuffer = Buffer.from(response.data);
            const contentType = response.headers['content-type'] || 'application/octet-stream';
            
            // Determine file extension
            let extension = 'rbxm'; // Default
            if (contentType.includes('xml')) extension = 'rbxmx';
            else if (contentType.includes('lua')) extension = 'lua';
            else if (contentType.includes('plain')) extension = 'txt'; // Could be Lua

            downloadedAssets.push(new AttachmentBuilder(assetBuffer, { name: `${assetId}.${extension}` }));

            // Analyze only if it's a model or script
            if (contentType.includes('rbxm') || contentType.includes('rbxmx') || contentType.includes('xml') || contentType.includes('lua') || contentType.includes('plain')) {
                const analysis = await analyzeAssetContent(assetId, assetBuffer, contentType);
                analysisResults.push(analysis);
                if (analysis.maliciousNames.length > 0 || analysis.suspiciousScripts.some(s => s.issues.length > 0)) overallSeverity = Math.max(overallSeverity, 2);
                else if (analysis.obfuscatedScripts.length > 0 || analysis.urlsFound.some(u => u.suspicious)) overallSeverity = Math.max(overallSeverity, 1);
            } else {
                 analysisResults.push({ assetId, errors: [`Skipped analysis: Content type ${contentType} is not a model or script.`] });
            }

        } catch (error) {
            console.error(`Failed to download or analyze asset ${assetId}:`, error.message);
            analysisResults.push({ assetId, errors: [`Failed to download/process: ${error.message}`] });
            overallSeverity = Math.max(overallSeverity, 1); // Mark as suspicious due to error
        }
    }

    const analysisEmbed = new EmbedBuilder()
        .setTitle('📦 Asset Download & Analysis Report')
        .setTimestamp()
        .setFooter({text: `Analyzed ${analysisResults.length} of ${uniqueAssetIds.length} found IDs.`});

    if (overallSeverity === 2) analysisEmbed.setColor(0xFF0000); // Red for malicious
    else if (overallSeverity === 1) analysisEmbed.setColor(0xFFA500); // Orange for suspicious/obfuscated
    else analysisEmbed.setColor(0x00FF00); // Green for clean

    if (analysisResults.length === 0 && uniqueAssetIds.length > 0) {
        analysisEmbed.setDescription("No assets could be processed or analyzed (e.g. all were images/sounds, or errors occurred).");
    } else if (analysisResults.length === 0) {
         analysisEmbed.setDescription("No asset IDs were extracted or processed."); // Should be caught earlier but safeguard
    }

    let description = `Downloaded ${downloadedAssets.length} asset(s).\n`;
    analysisResults.forEach(res => {
        description += `\n**Asset ID: ${res.assetId}**\n`;
        if (res.errors && res.errors.length > 0) {
            description += `  🔴 Errors: ${res.errors.join(', ')}\n`;
        }
        if (res.maliciousNames && res.maliciousNames.length > 0) {
            description += `  📛 Malicious Names: ${res.maliciousNames.map(n => `\`${n.name}\` (at ${n.path})`).join(', ')}\n`;
        }
        if (res.obfuscatedScripts && res.obfuscatedScripts.length > 0) {
            description += `  🟡 Obfuscated Scripts: ${res.obfuscatedScripts.map(s => `\`${s.path}\` (${s.reasons.join(', ')})`).join('; ')}\n`;
        }
        if (res.suspiciousScripts && res.suspiciousScripts.length > 0) {
            description += `  🟡 Suspicious Scripts: ${res.suspiciousScripts.map(s => `\`${s.path}\` (Issues: ${s.issues.slice(0,2).join(', ')}${s.issues.length > 2 ? '...' : ''})`).join('; ')}\n`;
        }
        const suspiciousUrls = res.urlsFound ? res.urlsFound.filter(u => u.suspicious) : [];
        if (suspiciousUrls.length > 0) {
            description += `  🟡 Suspicious URLs: ${suspiciousUrls.map(u => `\`${u.url.substring(0, 30)}...\` (in ${u.path})`).join(', ')}\n`;
        }
        if (res.requires && res.requires.length > 0) {
             description += `  🔵 Requires: ${res.requires.map(r => `\`${r.target}\` (in ${r.path})`).slice(0,3).join(', ')}${res.requires.length > 3 ? '...' : ''}\n`;
        }
        if (!res.errors?.length && !res.maliciousNames?.length && !res.obfuscatedScripts?.length && !res.suspiciousScripts?.length && !suspiciousUrls.length) {
            description += "  ✅ No immediate threats detected in this asset.\n";
        }
    });
    
    if (description.length > 4096) {
        description = description.substring(0, 4090) + "\n... (output truncated)";
    }
    analysisEmbed.setDescription(description);
    
    await interaction.editReply({
        content: `Analysis complete. See embed for details. ${downloadedAssets.length > 0 ? 'Files are attached.' : 'No files could be attached.'}`,
        embeds: [analysisEmbed],
        files: downloadedAssets.slice(0, 10) // Discord attachment limit
    });

    await sendActionLogToDiscord(
        'Asset Analysis Performed',
        `User requested asset analysis. ${uniqueAssetIds.length} IDs found. Processed ${analysisResults.length}. Overall severity: ${overallSeverity}.`,
        interaction,
        overallSeverity === 2 ? 0xFF0000 : (overallSeverity === 1 ? 0xFFA500 : 0x00FF00),
        [{name: "Original Log Message", value: `[Link](${originalMessageURL})`}]
    );

  } catch (error) {
    console.error('Get Asset/Script error:', error);
    await sendActionLogToDiscord('Get Asset/Script Failed - Unexpected Error', `Error: ${error.message}\nStack: ${error.stack ? error.stack.substring(0,1000) : "N/A"}`, interaction, 0xFF0000, [{name: "Original Message", value: `[Link](${originalMessageURL})`}]);
    if (hasRepliedOrDeferredAsset && !interaction.replied) await interaction.editReply({ content: 'Error processing asset download request. Admins notified.' }).catch(console.error);
    else if (!hasRepliedOrDeferredAsset && !interaction.replied) await interaction.reply({ content: 'Error processing asset download request. Admins notified.', ephemeral: true }).catch(console.error);
  }
}


// --- Express Routes ---
app.get('/', (req, res) => res.status(403).json({ status: 'error', message: 'Access Denied.' }));

app.get('/verify/:username', async (req, res) => {
  // ... (no changes from your provided code)
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  const username = req.params.username;
  if (!username) return res.status(400).json({ status: 'error', message: 'Username required.' });
  let whitelist;
  try {
    whitelist = await getWhitelistFromGitHub();
    if (!Array.isArray(whitelist)) {
        console.error(`Verify error for ${username}: Whitelist data from GitHub was not an array. Type: ${typeof whitelist}`);
        await sendActionLogToDiscord('Whitelist Verification Critical Error', `For /verify/${username}, whitelist data from GitHub was not an array. Type received: ${typeof whitelist}. This indicates a problem with getWhitelistFromGitHub or the Whitelist.json file structure.`, null, 0xFF0000);
        return res.status(500).json({ status: 'error', message: "Internal server error: Whitelist data malformed." });
    }
    const foundUser = whitelist.find(user => user && typeof user.User === 'string' && user.User.toLowerCase() === username.toLowerCase());
    if (!foundUser) {
      console.log(`/verify/${username}: User not found in whitelist.`);
      return res.status(404).json({ status: 'error', message: "User not found in whitelist." });
    }
    console.log(`/verify/${username}: User found.`);
    res.json({ status: 'success', data: { username: foundUser.User, discordId: foundUser.Discord, tier: foundUser.Whitelist }});
  } catch (error) {
    console.error(`Verify error for ${username} (caught in route): ${error.message}`);
    if (!(error.message.includes("Failed to fetch or parse whitelist from GitHub"))) {
        await sendActionLogToDiscord('Whitelist Verification Route Error', `Unexpected error during /verify/${username}: ${error.message}`, null, 0xFF0000);
    }
    res.status(500).json({ status: 'error', message: "Internal server error during verification." });
  }
});

app.get('/download/:assetId', async (req, res) => { // Modified for real download
  const assetId = req.params.assetId;
  if (!/^\d+$/.test(assetId)) return res.status(400).json({ status: 'error', message: 'Invalid asset ID.' });
  try {
    const assetUrl = `https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`;
    const response = await axios.get(assetUrl, {
        responseType: 'stream', // Stream for efficiency
        timeout: 10000,
        headers: {'User-Agent': 'RelaxxxLab-AssetDownloader/1.0'}
    });
    // Try to guess a reasonable extension, default to .rbxm for models
    const contentType = response.headers['content-type'] || 'application/octet-stream';
    let extension = 'dat'; // generic data
    if (contentType.includes('rbxm') || contentType.includes('octet-stream')) extension = 'rbxm';
    else if (contentType.includes('rbxmx') || contentType.includes('xml')) extension = 'rbxmx';
    else if (contentType.includes('lua') || (contentType.includes('plain') && !contentType.includes('html'))) extension = 'lua';
    else if (contentType.includes('png')) extension = 'png';
    else if (contentType.includes('jpeg') || contentType.includes('jpg')) extension = 'jpg';
    else if (contentType.includes('ogg')) extension = 'ogg';
    
    res.setHeader('Content-Disposition', `attachment; filename="${assetId}.${extension}"`);
    res.setHeader('Content-Type', contentType);
    response.data.pipe(res);
  } catch (error) {
    console.error(`Error downloading asset ${assetId} via /download route:`, error.message);
    const statusCode = error.response?.status || 500;
    let message = 'Failed to download asset.';
    if (statusCode === 404 || (error.response?.data && typeof error.response.data === 'string' && error.response.data.includes('asset is not trusted'))) {
        message = 'Asset not found or not available.';
    } else if (statusCode === 403) {
        message = 'Access to asset denied (possibly offsale or private).';
    }
    res.status(statusCode).json({ status: 'error', message });
  }
});

app.post('/send/scriptlogs', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  if (req.headers['authorization'] !== config.API_KEY) return res.status(401).json({ status: 'error', message: 'Invalid API key.' });
  if (!req.body?.embeds?.length) return res.status(400).json({ status: 'error', message: 'Invalid embed data.' });
  try {
    const embedData = req.body.embeds[0];
    const scriptMatch = (embedData.description || '').match(/```lua\n([\s\S]*?)\n```/);
    const fullScriptContent = scriptMatch ? scriptMatch[1] : null;

    // Add obfuscation check directly to the received embed data if script exists
    if (fullScriptContent) {
        const obfuscationCheck = isScriptObfuscated(fullScriptContent);
        if (obfuscationCheck.isObfuscated) {
            if (!embedData.fields) embedData.fields = [];
            embedData.fields.push({ name: '⚠️ Obfuscation Detected in Log', value: obfuscationCheck.reasons.join(', ') || 'Generic obfuscation patterns found.', inline: false });
            if (!embedData.color) embedData.color = 0xFFA500; // Orange
        }
    }
    await sendToDiscordChannel(embedData, fullScriptContent); // sendToDiscordChannel already handles its own obfuscation check and attachment logic
    res.status(200).json({ status: 'success', message: 'Log received.', logId: generateLogId() });
  } catch (error) { console.error('Error /send/scriptlogs:', error.message); res.status(500).json({ status: 'error', message: "Processing script log failed." }); }
});

app.get('/scripts/LuaMenu', async (req, res) => {
  // ... (no changes from your provided code)
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  try {
    const response = await axios.get(config.GITHUB_LUA_MENU_URL, { timeout: 8000, headers: { 'User-Agent': 'LuaWhitelistServer/1.9' }});
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).send(response.data);
  } catch (error) { console.error('Error /scripts/LuaMenu:', error.message); res.status(error.response?.status || 500).json({ status: 'error', message: 'Failed to load LuaMenu script.' }); }
});

discordClient.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  try {
    if (interaction.customId === 'blacklist_user_from_log') await handleBlacklist(interaction);
    else if (interaction.customId === 'get_asset_script_from_log') await handleGetAssetOrScript(interaction);
  } catch (error) {
    console.error('Main Interaction error catcher:', error);
    await sendActionLogToDiscord( 'Main Interaction Catcher Error', `Error: ${error.message}\n\`\`\`${error.stack ? error.stack.substring(0,1000) : "No stack"}\n\`\`\``, interaction, 0xFF0000);
    if (interaction.isRepliable()) {
        if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'An unhandled error occurred. Admins notified.', ephemeral: true }).catch(e => console.error("Error sending fallback reply:", e));
        else if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: 'An unhandled error occurred. Admins notified.', ephemeral: true }).catch(e => console.error("Error sending fallback editReply:", e));
    }
  }
});

discordClient.on('ready', () => {
  console.log(`Bot logged in as ${discordClient.user.tag} in ${discordClient.guilds.cache.size} guilds.`);
  discordClient.user.setStatus('dnd');
  discordClient.user.setActivity('Scanning Assets & Logs', { type: ActivityType.Watching }); // Updated activity
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
