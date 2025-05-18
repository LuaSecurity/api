require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder, ActivityType } = require('discord.js');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

// Config from environment variables
const config = {
  // Your existing ENV VARS
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_LUA_MENU_URL: process.env.GITHUB_LUA_MENU_URL,

  // Mapped ENV VARS
  DISCORD_CLIENT_ID: process.env.BOT_CLIENT_ID,
  DISCORD_CLIENT_SECRET: process.env.BOT_CLIENT_SECRET,
  DISCORD_CALLBACK_URL: process.env.REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/auth/discord/callback`,
  TARGET_GUILD_ID: process.env.SERVER_ID,

  // Other configurations - SET THESE IN .env OR DIRECTLY IF NEEDED
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || 'YOUR_LOG_CHANNEL_ID', // Replace or set via ENV
  GITHUB_REPO_OWNER: process.env.GITHUB_REPO_OWNER || 'RelaxxxX-Lab',
  GITHUB_REPO_NAME: process.env.GITHUB_REPO_NAME || 'Lua-things',
  GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
  WHITELIST_PATH: process.env.WHITELIST_PATH || 'Whitelist.json',
  ROLES: { // Replace with your actual role IDs or set via ENV VARS like ROLE_STANDARD_ID etc.
    STANDARD: process.env.ROLE_STANDARD_ID || 'YOUR_STANDARD_ROLE_ID',
    PREMIUM: process.env.ROLE_PREMIUM_ID || 'YOUR_PREMIUM_ROLE_ID',
    ULTIMATE: process.env.ROLE_ULTIMATE_ID || 'YOUR_ULTIMATE_ROLE_ID'
  },
  PORT: process.env.PORT || 3000,
  SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT: 1000,
  SESSION_SECRET: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  ADD_USER_TO_GUILD_IF_MISSING: process.env.ADD_USER_TO_GUILD_IF_MISSING === 'true',
};

// Critical check for essential environment variables based on your provided names
if (!config.API_KEY || 
    !config.GITHUB_TOKEN || 
    !config.DISCORD_BOT_TOKEN || 
    !config.GITHUB_LUA_MENU_URL ||
    !config.DISCORD_CLIENT_ID ||  // Was BOT_CLIENT_ID
    !config.DISCORD_CLIENT_SECRET || // Was BOT_CLIENT_SECRET
    !config.TARGET_GUILD_ID) { // Was SERVER_ID
  console.error('FATAL ERROR: Missing essential environment variables. Please check your .env file for API_KEY, GITHUB_TOKEN, DISCORD_BOT_TOKEN, GITHUB_LUA_MENU_URL, BOT_CLIENT_ID, BOT_CLIENT_SECRET, SERVER_ID.');
  // Also ensure REDIRECT_URI is set if not using localhost default.
  if (!config.DISCORD_CALLBACK_URL.startsWith('http://localhost') && !process.env.REDIRECT_URI) {
    console.error('Warning: REDIRECT_URI is not set, and default callback is localhost. This might be an issue if deploying.');
  }
  process.exit(1);
}

// BOT_PUBLIC_KEY is not directly used by this script's current features,
// but if you add interaction signature verification manually, you would use it.
// Discord.js handles this for bot commands typically. For raw HTTP interactions, it's needed.

const app = express();
const octokit = new Octokit({ auth: config.GITHUB_TOKEN, request: { timeout: 15000 } });
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers
  ]
});

// --- In-memory queue for scripts ---
// For production, consider a more persistent store like Redis
const scriptQueue = new Map();

app.use(bodyParser.json({ limit: '500mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '500mb' }));

// --- Session and Passport Setup ---
app.use(session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // cookie: { secure: process.env.NODE_ENV === 'production' } // Use secure cookies in production (HTTPS)
}));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser(async (obj, done) => {
    // Optional: Fetch fresh user data or guild member data here if needed frequently
    // For now, just pass the stored object.
    done(null, obj);
});


passport.use(new DiscordStrategy({
  clientID: config.DISCORD_CLIENT_ID,
  clientSecret: config.DISCORD_CLIENT_SECRET,
  callbackURL: config.DISCORD_CALLBACK_URL,
  scope: ['identify', 'guilds', 'guilds.join'] // 'guilds.join' is needed to add user to server
}, async (accessToken, refreshToken, profile, done) => {
  try {
    // profile.guilds contains guilds the user is in (if 'guilds' scope granted)
    // We can store accessToken if we need to make API calls on behalf of the user later
    // For now, just storing profile basics is enough.
    const user = {
      id: profile.id,
      username: profile.username,
      discriminator: profile.discriminator,
      avatar: profile.avatar,
      guilds: profile.guilds,
      accessToken: accessToken // Store this if you need to add them to the guild
    };
    return done(null, user);
  } catch (err) {
    return done(err, null);
  }
}));

// --- Helper Functions (existing and new) ---
function generateLogId() { return crypto.randomBytes(8).toString('hex'); }
function isFromRoblox(req) { return (req.headers['user-agent'] || '').includes('Roblox'); }

async function sendActionLogToDiscord(title, description, interactionOrUser, color = 0x0099FF, additionalFields = []) {
    try {
        const logChannel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
        if (!logChannel) {
            console.error("Failed to fetch log channel for reporting. Channel ID:", config.LOG_CHANNEL_ID);
            return;
        }
        const logEmbed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description.substring(0, 4000)).setTimestamp();
        
        if (interactionOrUser) { // Can be an interaction or a user object from passport
            if (interactionOrUser.user) { // It's an interaction
                 logEmbed.addFields({ name: 'Action Initiated By', value: `${interactionOrUser.user.tag} (<@${interactionOrUser.user.id}>)`, inline: true });
                 if (interactionOrUser.guild) {
                     logEmbed.addFields({ name: 'Context', value: `Guild: ${interactionOrUser.guild.name}\nChannel: ${interactionOrUser.channel.name}`, inline: true });
                 }
            } else if (interactionOrUser.id && interactionOrUser.username) { // It's a user object (e.g., from req.user)
                 logEmbed.addFields({ name: 'Action By User', value: `${interactionOrUser.username}#${interactionOrUser.discriminator} (<@${interactionOrUser.id}>)`, inline: true });
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
  // ... (existing function, no changes needed for this part)
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
  // ... (existing function, no changes needed)
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
  // ... (existing function, no changes needed)
  try {
    const channel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
    if (!channel) throw new Error('Log channel not found for script log.');
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
      new ButtonBuilder().setCustomId('get_asset_script_from_log')
        .setLabel('Download Found Assets')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!fullScriptContent || fullScriptContent.trim().length === 0)
    ));
    return channel.send(messageOptions);
  } catch (error) { console.error('Discord sendToDiscordChannel (script log) error:', error); }
}

// --- Discord Button Handlers (existing) ---
async function handleBlacklist(interaction) { /* ... (existing function) ... */ }
async function handleGetAssetOrScript(interaction) { /* ... (existing function) ... */ }
// (For brevity, I'm not pasting the full existing handleBlacklist and handleGetAssetOrScript here, assume they are present and correct)

// --- OAuth Middleware: Check if user is authenticated and authorized ---
async function ensureAuthenticatedAndAuthorized(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.redirect('/auth/discord'); // Or an error page: res.status(401).send('Please log in.');
  }

  const user = req.user;
  let whitelist;
  try {
    whitelist = await getWhitelistFromGitHub();
  } catch (e) {
    console.error("Auth Middleware: Failed to get whitelist", e);
    await sendActionLogToDiscord("Authorization Error", "Failed to fetch whitelist for user authorization.", user, 0xFF0000, [{name: "Error", value: e.message}]);
    return res.status(500).send("Error checking whitelist status. Please try again later.");
  }

  const userWhitelistEntry = whitelist.find(entry => entry && entry.Discord === user.id);

  if (!userWhitelistEntry) {
    await sendActionLogToDiscord("Authorization Denied", "User not found in whitelist.", user, 0xFFA500);
    return res.status(403).send(`
      <h1>Access Denied</h1>
      <p>Your Discord account (${user.username}#${user.discriminator}) is not whitelisted for this service.</p>
      <p><a href="/logout">Logout</a></p>
    `);
  }

  const requiredRoleIds = Object.values(config.ROLES).filter(Boolean);
  if (requiredRoleIds.length === 0) {
    console.warn("No whitelist roles configured. Allowing access by default if user is in whitelist.json.");
    req.robloxUsername = userWhitelistEntry.User; // Attach Roblox username for later use
    return next();
  }
  
  let member;
  try {
    const guild = await discordClient.guilds.fetch(config.TARGET_GUILD_ID);
    if (!guild) {
        await sendActionLogToDiscord("Authorization Error", `Target guild ${config.TARGET_GUILD_ID} not found or bot not in it.`, user, 0xFF0000);
        return res.status(500).send("Configuration error: Target guild not accessible.");
    }
    member = await guild.members.fetch(user.id).catch(() => null);

    if (!member && config.ADD_USER_TO_GUILD_IF_MISSING && user.accessToken) {
        console.log(`User ${user.username} not in guild ${config.TARGET_GUILD_ID}. Attempting to add.`);
        try {
            await guild.members.add(user.id, { accessToken: user.accessToken, roles: [] }); // Add with no roles initially
            member = await guild.members.fetch(user.id); // Re-fetch member
            await sendActionLogToDiscord("User Auto-Joined Guild", `User ${user.username}#${user.discriminator} was automatically added to the guild.`, user, 0x00FF00);
        } catch (addError) {
            console.error(`Failed to add user ${user.id} to guild ${config.TARGET_GUILD_ID}:`, addError);
            await sendActionLogToDiscord("Guild Join Failed", `Attempted to add user ${user.username} to guild but failed.`, user, 0xFF0000, [{name: "Error", value: addError.message}]);
            // Proceed to check if they somehow got in, or fail if ADD_USER_TO_GUILD_IF_MISSING is false
            if (!member) { // Still not a member
                 return res.status(403).send(`
                    <h1>Access Denied</h1>
                    <p>You are not a member of the required Discord server. We attempted to add you but failed. Please join manually or contact support.</p>
                    <p><a href="/logout">Logout</a></p>
                `);
            }
        }
    } else if (!member) {
        await sendActionLogToDiscord("Authorization Denied", "User not in target guild.", user, 0xFFA500, [{name: "Guild ID", value: config.TARGET_GUILD_ID}]);
        return res.status(403).send(`
            <h1>Access Denied</h1>
            <p>You must be a member of our Discord server to use this service.</p>
            <p><a href="/logout">Logout</a></p>
        `);
    }

    const hasRequiredRole = member.roles.cache.some(role => requiredRoleIds.includes(role.id));
    if (!hasRequiredRole) {
        await sendActionLogToDiscord("Authorization Denied", "User does not have any required whitelist roles.", user, 0xFFA500, [{name: "Required Roles", value: requiredRoleIds.map(r => `<@&${r}>`).join(', ')}]);
        return res.status(403).send(`
            <h1>Access Denied</h1>
            <p>You do not have the necessary roles for this service.</p>
            <p><a href="/logout">Logout</a></p>
        `);
    }
    
    req.robloxUsername = userWhitelistEntry.User; // Attach Roblox username for later use
    next();

  } catch (err) {
    console.error("Error during role/guild check:", err);
    await sendActionLogToDiscord("Authorization Error", "An error occurred during guild/role check.", user, 0xFF0000, [{name: "Error", value: err.message}]);
    return res.status(500).send("Error verifying your permissions. Please try again later.");
  }
}


// --- Express Routes (existing and new) ---
app.get('/', (req, res) => {
    if (req.isAuthenticated()) {
        res.redirect('/executor');
    } else {
        // Simple landing page with login button
        res.send(`
            <h1>Welcome to Lua Executor</h1>
            <p>Please log in with Discord to continue.</p>
            <a href="/auth/discord" style="padding: 10px 20px; background-color: #7289DA; color: white; text-decoration: none; border-radius: 5px;">
                Login with Discord
            </a>
            <hr>
            <p><small>Roblox Verification Endpoint: /verify/:username</small></p>
            <p><small>Lua Menu Script Endpoint: /scripts/LuaMenu</small></p>
        `);
    }
});

app.get('/verify/:username', async (req, res) => {
  // ... (existing route, no changes needed)
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  const username = req.params.username;
  if (!username) return res.status(400).json({ status: 'error', message: 'Username required.' });
  let whitelist;
  try {
    whitelist = await getWhitelistFromGitHub();
    if (!Array.isArray(whitelist)) { 
        console.error(`Verify error for ${username}: Whitelist data from GitHub was not an array. Type: ${typeof whitelist}`);
        await sendActionLogToDiscord('Whitelist Verification Critical Error', `For /verify/${username}, whitelist data from GitHub was not an array. Type received: ${typeof whitelist}.`, null, 0xFF0000);
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

app.get('/download/:assetId', async (req, res) => {
  // ... (existing route, no changes needed)
  const assetId = req.params.assetId;
  if (!/^\d+$/.test(assetId)) return res.status(400).json({ status: 'error', message: 'Invalid asset ID.' });
  const placeholderRbxmContent = `-- Roblox Asset: ${assetId}\n-- This is a placeholder file. Use the ID on the Roblox website or in Studio.`;
  res.set({ 'Content-Type': 'application/rbxm', 'Content-Disposition': `attachment; filename="${assetId}.rbxm"` }).send(placeholderRbxmContent);
});

app.post('/send/scriptlogs', async (req, res) => {
  // ... (existing route, no changes needed)
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  if (req.headers['authorization'] !== config.API_KEY) return res.status(401).json({ status: 'error', message: 'Invalid API key.' });
  if (!req.body?.embeds?.length) return res.status(400).json({ status: 'error', message: 'Invalid embed data.' });
  try {
    const embedData = req.body.embeds[0];
    const scriptMatch = (embedData.description || '').match(/```lua\n([\s\S]*?)\n```/);
    await sendToDiscordChannel(embedData, scriptMatch ? scriptMatch[1] : null);
    res.status(200).json({ status: 'success', message: 'Log received.', logId: generateLogId() });
  } catch (error) { console.error('Error /send/scriptlogs:', error.message); res.status(500).json({ status: 'error', message: "Processing script log failed." }); }
});

app.get('/scripts/LuaMenu', async (req, res) => {
  // ... (existing route, no changes needed)
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  try {
    const response = await axios.get(config.GITHUB_LUA_MENU_URL, { timeout: 8000, headers: { 'User-Agent': 'LuaWhitelistServer/1.9' }}); // Updated User-Agent slightly
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).send(response.data);
  } catch (error) { console.error('Error /scripts/LuaMenu:', error.message); res.status(error.response?.status || 500).json({ status: 'error', message: 'Failed to load LuaMenu script.' }); }
});


// --- New OAuth Routes ---
app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/' }), // Redirect to / on auth failure
  async (req, res) => {
    // Successful authentication
    await sendActionLogToDiscord("User Login Success (OAuth)", `User successfully logged in via Discord.`, req.user, 0x5865F2);
    res.redirect('/executor'); // Redirect to the executor page
  }
);

app.get('/logout', (req, res, next) => {
  const user = req.user;
  req.logout(err => {
    if (err) { return next(err); }
    req.session.destroy(async (err) => {
      if (err) {
        console.error("Session destruction error:", err);
        if (user) await sendActionLogToDiscord("Logout Error", `Error destroying session for user.`, user, 0xFF0000, [{name: "Error", value: err.message}]);
        return res.status(500).send("Could not log out properly.");
      }
      if (user) await sendActionLogToDiscord("User Logout", `User logged out.`, user, 0xAAAAAA);
      res.clearCookie('connect.sid'); // Default session cookie name
      res.redirect('/');
    });
  });
});


// --- New Executor Page Route ---
app.get('/executor', ensureAuthenticatedAndAuthorized, (req, res) => {
  // User is authenticated and authorized at this point (has required role)
  // req.user contains Discord user info
  // req.robloxUsername contains their Roblox username from whitelist
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Lua Executor</title>
    <link rel="stylesheet" data-name="vs/editor/editor.main" href="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.34.1/min/vs/editor/editor.main.min.css">
    <style>
        body { font-family: sans-serif; margin: 0; background-color: #2c2f33; color: #ffffff; display: flex; flex-direction: column; height: 100vh; }
        .top-bar { background-color: #23272a; padding: 10px 20px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
        .top-bar h1 { margin: 0; font-size: 1.5em; }
        .top-bar .user-info { font-size: 0.9em; }
        .top-bar .user-info img { width: 30px; height: 30px; border-radius: 50%; vertical-align: middle; margin-right: 8px;}
        .top-bar a { color: #7289da; text-decoration: none; margin-left: 15px; }
        .main-content { display: flex; flex-direction: column; flex-grow: 1; padding: 15px; }
        #editor-container { flex-grow: 1; border: 1px solid #4f545c; border-radius: 4px; overflow: hidden; margin-bottom: 15px; }
        .controls { margin-bottom: 15px; display: flex; gap: 10px; }
        .controls button {
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
            transition: background-color 0.2s;
        }
        .execute-btn { background-color: #5865f2; color: white; }
        .execute-btn:hover { background-color: #4752c4; }
        .clear-btn { background-color: #747f8d; color: white; }
        .clear-btn:hover { background-color: #636c78; }
        #status { margin-top: 10px; padding: 10px; background-color: #23272a; border-radius: 4px; font-size: 0.9em; min-height: 20px; }
    </style>
</head>
<body>
    <div class="top-bar">
        <h1>Lua Executor</h1>
        <div class="user-info">
            ${req.user.avatar ? `<img src="https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png?size=64" alt="avatar">` : ''}
            Logged in as: <strong>${req.user.username}#${req.user.discriminator}</strong> (Roblox: ${req.robloxUsername || 'N/A'})
            <a href="/logout">Logout</a>
        </div>
    </div>

    <div class="main-content">
        <div class="controls">
            <button id="execute-btn" class="execute-btn">Execute Script (for ${req.robloxUsername || 'N/A'})</button>
            <button id="clear-btn" class="clear-btn">Clear Editor</button>
        </div>
        <div id="editor-container"></div>
        <div id="status">Ready. Enter your Lua script for Lua Serverside.</div>
    </div>

    <script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.34.1/min/vs/loader.min.js"></script>
    <script>
        let editor;
        require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.34.1/min/vs' }});
        require(['vs/editor/editor.main'], function() {
            editor = monaco.editor.create(document.getElementById('editor-container'), {
                value: '-- Lua Serverside Script Executor\\nprint("Hello from Lua Executor!")',
                language: 'lua',
                theme: 'vs-dark', // or 'vs' for light theme
                automaticLayout: true
            });
        });

        const statusDiv = document.getElementById('status');

        document.getElementById('execute-btn').addEventListener('click', async () => {
            const scriptContent = editor.getValue();
            if (!scriptContent.trim()) {
                statusDiv.textContent = 'Error: Script is empty.';
                statusDiv.style.color = '#ff6b6b';
                return;
            }
            statusDiv.textContent = 'Executing...';
            statusDiv.style.color = '#f1c40f';

            try {
                const response = await fetch('/api/execute-script', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ script: scriptContent })
                });
                const result = await response.json();
                if (response.ok) {
                    statusDiv.textContent = \`Success: \${result.message} (Log ID: \${result.logId})\`;
                    statusDiv.style.color = '#2ecc71';
                } else {
                    statusDiv.textContent = \`Error (\${response.status}): \${result.message || 'Failed to send script.'}\`;
                    statusDiv.style.color = '#ff6b6b';
                }
            } catch (error) {
                console.error('Execution error:', error);
                statusDiv.textContent = 'Network error or server unavailable.';
                statusDiv.style.color = '#ff6b6b';
            }
        });

        document.getElementById('clear-btn').addEventListener('click', () => {
            editor.setValue('');
            statusDiv.textContent = 'Editor cleared.';
            statusDiv.style.color = '#ffffff';
        });
    </script>
</body>
</html>
  `);
});

// --- New API Route for Executor to send script ---
app.post('/api/execute-script', ensureAuthenticatedAndAuthorized, async (req, res) => {
    const { script } = req.body;
    const user = req.user; // Discord user from session
    const robloxUsername = req.robloxUsername; // Roblox username from middleware

    if (!script || typeof script !== 'string' || script.trim() === '') {
        return res.status(400).json({ status: 'error', message: 'Script content is missing or empty.' });
    }
    if (!robloxUsername) { // Should be set by middleware, but double check
        await sendActionLogToDiscord("Execution Error", "Roblox username missing for authenticated user during script execution.", user, 0xFF0000);
        return res.status(500).json({ status: 'error', message: 'Internal error: Could not determine Roblox username.' });
    }

    // This is where the executor (webpage backend) posts to the /queue/:username
    // The actual Roblox game will GET from /queue/:username
    try {
        const queueUrl = `${req.protocol}://${req.get('host')}/queue/${encodeURIComponent(robloxUsername)}`;
        console.log(`Executor sending script for ${robloxUsername} to queue URL: ${queueUrl}`);
        
        // We are POSTing from this server to itself, so use internal call or localhost axios
        // For simplicity, just directly call the queue logic:
        scriptQueue.set(robloxUsername, script); // Add to queue

        const logId = generateLogId();
        await sendActionLogToDiscord(
            "Script Queued via Executor", 
            `Script queued for Roblox user **${robloxUsername}** by Discord user ${user.username}#${user.discriminator}.`,
            user,
            0x3498DB, // Blueish color
            [
                { name: "Roblox Username", value: robloxUsername, inline: true },
                { name: "Log ID", value: logId, inline: true },
                { name: "Script Preview (first 200 chars)", value: `\`\`\`lua\n${script.substring(0, 200)}${script.length > 200 ? '...' : ''}\n\`\`\`` }
            ]
        );
        console.log(`Script for ${robloxUsername} added to queue by ${user.username}. Length: ${script.length}`);
        res.status(200).json({ status: 'success', message: `Script queued for ${robloxUsername}.`, logId: logId });

    } catch (error) {
        console.error(`Error proxying script to queue for ${robloxUsername}:`, error);
        await sendActionLogToDiscord("Execution Error", `Failed to queue script for ${robloxUsername}.`, user, 0xFF0000, [{name: "Error", value: error.message}]);
        res.status(500).json({ status: 'error', message: 'Failed to send script to internal queue.' });
    }
});


// --- New Queue API Routes ---
// Game Serverside (Lua) will POST to this to inform that a user is ready for a script
// OR the executor backend (/api/execute-script) will post to this.
// For this implementation, /api/execute-script directly adds to the queue.
// This POST endpoint is for the "executor" (our web app's backend) to place a script in the queue.
// The Roblox game will use GET /queue/:username.
app.post('/queue/:username', async (req, res) => {
    // This endpoint is now effectively handled by /api/execute-script directly manipulating scriptQueue
    // However, if you want the Roblox game or another service to *also* be able to POST scripts to the queue:
    if (req.headers['authorization'] !== config.API_KEY) {
        return res.status(401).json({ status: 'error', message: 'Invalid API key.' });
    }
    const username = req.params.username;
    const scriptContent = req.body.script; // Assuming script is sent in body raw or as {script: "..."}

    if (!username) {
        return res.status(400).json({ status: 'error', message: 'Username parameter is required.' });
    }
    if (!scriptContent || typeof scriptContent !== 'string' || scriptContent.trim() === '') {
        return res.status(400).json({ status: 'error', message: 'Script content is missing or empty.' });
    }

    scriptQueue.set(username, scriptContent);
    const logId = generateLogId();
    console.log(`Script for ${username} added to queue via direct POST. Log ID: ${logId}`);
    await sendActionLogToDiscord(
        "Script Queued (Direct API)", 
        `Script queued for Roblox user **${username}** via direct API call.`,
        null, // No specific user context for direct API call unless you add one
        0x1ABC9C, // Teal color
        [
            { name: "Roblox Username", value: username, inline: true },
            { name: "Log ID", value: logId, inline: true },
            { name: "Source IP", value: req.ip, inline: true },
            { name: "Script Preview (first 200 chars)", value: `\`\`\`lua\n${scriptContent.substring(0, 200)}${scriptContent.length > 200 ? '...' : ''}\n\`\`\`` }
        ]
    );
    res.status(200).json({ status: 'success', message: 'Script queued.', logId: logId });
});

// Game Serverside (Lua) will GET from this to fetch a script
app.get('/queue/:username', async (req, res) => {
    // This should be authenticated if your Roblox game sends an API key
    if (req.headers['authorization'] !== config.API_KEY && !isFromRoblox(req)) { // Allow Roblox or API Key
         console.warn(`/queue GET: Unauthorized access attempt for ${req.params.username} from IP ${req.ip}`);
         return res.status(401).send('Unauthorized'); // Send plain text for Roblox
    }

    const username = req.params.username;
    if (!username) {
        return res.status(400).send('Username parameter is required.');
    }

    if (scriptQueue.has(username)) {
        const script = scriptQueue.get(username);
        scriptQueue.delete(username); // Remove script after fetching
        
        console.log(`Script retrieved from queue for ${username} by ${isFromRoblox(req) ? 'Roblox Game' : 'API Key User'}.`);
        await sendActionLogToDiscord(
            "Script Dequeued",
            `Script retrieved from queue for Roblox user **${username}**. Initiated by ${isFromRoblox(req) ? 'Roblox Game' : 'API User'}.`,
            null, 
            0x2ECC71, // Greenish color
            [
                { name: "Roblox Username", value: username, inline: true },
                { name: "Source IP", value: req.ip, inline: true },
                // Don't log full script here again, it was logged on queueing
            ]
        );
        res.set('Content-Type', 'text/plain; charset=utf-8').send(script);
    } else {
        // console.log(`No script in queue for ${username}.`); // Can be spammy
        res.status(404).send('-- No script in queue'); // Roblox often expects plain text
    }
});


// --- Discord Event Handlers ---
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
  discordClient.user.setActivity('Managing Whitelists & Scripts', { type: ActivityType.Watching }); // Updated activity
});

// --- Error Handlers & Startup ---
process.on('unhandledRejection', (r, p) => console.error('Unhandled Rejection:', r, p));
process.on('uncaughtException', e => console.error('Uncaught Exception:', e));

async function startServer() {
  try {
    await discordClient.login(config.DISCORD_BOT_TOKEN);
    app.listen(config.PORT, () => {
        console.log(`API on http://localhost:${config.PORT}, Bot connected.`);
        console.log(`Discord OAuth Redirect URI should be: ${config.DISCORD_CALLBACK_URL}`);
        console.log(`Executor available at: http://localhost:${config.PORT}/executor (after login)`);
    });
  } catch (error) { console.error('Startup failed:', error); process.exit(1); }
}

startServer();
