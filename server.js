require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const cors = require('cors');
const { Octokit } = require('@octokit/rest');
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AttachmentBuilder
} = require('discord.js');

const config = {
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_LUA_MENU_URL: process.env.GITHUB_LUA_MENU_URL,
  LOG_CHANNEL_ID: '1331021897735081984',
  GITHUB_REPO: 'RelaxxxX-Lab/Lua-things',
  GITHUB_BRANCH: 'main',
  WHITELIST_PATH: 'Whitelist.json',
  SCRIPT_PATH: 'Scripts.json',
  ROLES: {
    STANDARD: '1330552089759191064',
    PREMIUM: '1333286640248029264',
    ULTIMATE: '1337177751202828300'
  },
  BOT_CLIENT_ID: process.env.BOT_CLIENT_ID,
  BOT_CLIENT_SECRET: process.env.BOT_CLIENT_SECRET,
  REDIRECT_URI: process.env.REDIRECT_URI,
  SERVER_ID: process.env.SERVER_ID
};

const app = express();
const octokit = new Octokit({ auth: config.GITHUB_TOKEN, request: { timeout: 5000 } });
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

let userQueues = {}; // In-memory queue
app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));

const getWhitelistFromGitHub = async () => {
  const { data } = await octokit.rest.repos.getContent({
    owner: config.GITHUB_REPO.split('/')[0],
    repo: config.GITHUB_REPO.split('/')[1],
    path: config.WHITELIST_PATH,
    ref: config.GITHUB_BRANCH,
    headers: { Accept: 'application/vnd.github.v3.raw' }
  });
  if (typeof data === 'string') return JSON.parse(data);
  return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
};

const getScriptsFromGitHub = async () => {
  const { data } = await octokit.rest.repos.getContent({
    owner: config.GITHUB_REPO.split('/')[0],
    repo: config.GITHUB_REPO.split('/')[1],
    path: config.SCRIPT_PATH,
    ref: config.GITHUB_BRANCH,
    headers: { Accept: 'application/vnd.github.v3.raw' }
  });
  if (typeof data === 'string') return JSON.parse(data);
  return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
};

app.get('/executor', async (req, res) => {
  const oauthURL = `https://discord.com/api/oauth2/authorize?client_id=${config.BOT_CLIENT_ID}&redirect_uri=${encodeURIComponent(config.REDIRECT_URI)}&response_type=code&scope=identify`;
  const scripts = await getScriptsFromGitHub();
  const scriptButtons = scripts.map(script => `<option value="${script.Script}">${script.Name}</option>`).join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <title>Lua Executor</title>
      <style>
        body { font-family: 'Segoe UI', sans-serif; background: #0e1013; color: #eaeaea; margin: 0; padding: 0; }
        header { display: flex; justify-content: space-between; align-items: center; background: #1f2937; padding: 15px 30px; }
        header h1 { margin: 0; font-size: 24px; }
        header a { color: white; background: #5865F2; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-weight: bold; }
        main { padding: 40px 30px; max-width: 960px; margin: auto; }
        select, textarea, button { width: 100%; font-size: 16px; border-radius: 6px; border: none; margin-top: 10px; }
        textarea { height: 300px; background: #1e1e1e; color: #fff; padding: 12px; font-family: monospace; resize: vertical; }
        button { padding: 12px; background: #3b82f6; color: white; font-weight: bold; cursor: pointer; transition: background 0.2s; }
        button:hover { background: #2563eb; }
        #response { margin-top: 20px; font-size: 14px; color: limegreen; white-space: pre-wrap; }
      </style>
    </head>
    <body>
      <header>
        <h1>Lua Script Executor</h1>
        <a href="${oauthURL}">Login with Discord</a>
      </header>
      <main>
        <label for="scriptHub">Script Hub:</label>
        <select id="scriptHub" onchange="loadScript(this.value)">
          <option value="">-- Select a script --</option>
          ${scriptButtons}
        </select>
        <textarea id="script" placeholder="Write or select a script..."></textarea>
        <button onclick="sendScript()">Execute</button>
        <div id="response"></div>
      </main>
      <script>
        function loadScript(code) {
          if (code.includes('Username')) {
            fetch('/whitelist-username').then(r => r.text()).then(username => {
              document.getElementById('script').value = code.replace(/Username/g, username);
            });
          } else {
            document.getElementById('script').value = code;
          }
        }
        function sendScript() {
          const script = document.getElementById('script').value;
          if (!script) return alert("Script field is empty.");
          fetch('/queue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ script })
          })
          .then(res => res.json())
          .then(data => {
            document.getElementById('response').innerText = data.message || 'Script queued successfully';
          });
        }
      </script>
    </body>
    </html>
  `);
});

app.post('/queue', async (req, res) => {
  const script = req.body?.script;
  if (!script) return res.status(400).json({ status: 'error', message: 'No script provided' });
  const whitelist = await getWhitelistFromGitHub();
  const username = whitelist[0]?.User || 'Guest';
  if (!userQueues[username]) userQueues[username] = [];
  userQueues[username].push({ script });
  res.status(200).json({ status: 'success', message: 'Script added to queue for ' + username });
});

app.get('/queue', async (req, res) => {
  const whitelist = await getWhitelistFromGitHub();
  const username = whitelist[0]?.User;
  const queue = userQueues[username];
  if (!queue || queue.length === 0) return res.type('text/plain').send('');
  const nextScript = queue.shift();
  if (queue.length === 0) delete userQueues[username];
  res.type('text/plain').send(nextScript.script);
});

app.get('/whitelist-username', async (req, res) => {
  const whitelist = await getWhitelistFromGitHub();
  const username = whitelist[0]?.User;
  res.type('text/plain').send(username || 'Unknown');
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});

discordClient.login(config.DISCORD_BOT_TOKEN).catch(err => {
  console.error('Discord login failed:', err);
  process.exit(1);
});
