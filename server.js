require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits } = require('discord.js');

const config = {
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
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
const octokit = new Octokit({ auth: config.GITHUB_TOKEN });
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

const userQueues = {};
app.use(cors());
app.use(cookieParser());
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

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');
  try {
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: config.BOT_CLIENT_ID,
        client_secret: config.BOT_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.REDIRECT_URI,
        scope: 'identify email guilds guilds.members.read'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const accessToken = tokenRes.data.access_token;
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const memberRes = await axios.get(`https://discord.com/api/users/@me/guilds/${config.SERVER_ID}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const hasAccess = memberRes.data.roles.some(role => Object.values(config.ROLES).includes(role));
    if (!hasAccess) return res.status(403).send('Access denied: You do not have the required role in the server.');

    res.cookie('discord_id', userRes.data.id, { httpOnly: true, maxAge: 86400000 });
    res.redirect('/executor');
  } catch (e) {
    console.error(e);
    res.status(500).send('OAuth2 authentication failed');
  }
});

app.get('/executor', async (req, res) => {
  const discordId = req.cookies.discord_id;
  if (!discordId) return res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${config.BOT_CLIENT_ID}&redirect_uri=${encodeURIComponent(config.REDIRECT_URI)}&response_type=code&scope=identify%20email%20guilds%20guilds.members.read`);

  const whitelist = await getWhitelistFromGitHub();
  const entry = whitelist.find(u => u.Discord === discordId);
  if (!entry) return res.status(403).send('You are not whitelisted');

  const username = entry.User;
  const scripts = await getScriptsFromGitHub();
  const scriptOptions = scripts.map(s => `<option value="${s.Script.replace(/Username/g, username)}">${s.Name}</option>`).join('');

res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Lua Control Panel</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet"/>
  <style>
    * { box-sizing: border-box; padding: 0; margin: 0; }
    body, html { font-family: 'Inter', sans-serif; background: #0e0e0e; color: white; height: 100%; }
    .container { display: flex; height: 100vh; }

    .sidebar {
      width: 240px;
      background: linear-gradient(180deg, #1a1a1a, #101010);
      padding: 30px 20px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      border-right: 1px solid #333;
    }

    .sidebar h1 {
      font-size: 24px;
      color: white;
      margin-bottom: 20px;
      font-weight: 700;
    }

    .nav-link {
      color: #888;
      font-size: 15px;
      text-decoration: none;
      transition: all 0.3s ease;
      font-weight: 600;
    }

    .nav-link:hover, .nav-link.active {
      color: #fff;
      background: linear-gradient(90deg, #8e2de2, #4a00e0);
      padding: 8px 12px;
      border-radius: 8px;
    }

    .content {
      flex: 1;
      padding: 40px;
      overflow-y: auto;
    }

    .tabs { display: none; }
    .tabs.active { display: block; }

    h2 { margin-bottom: 20px; font-size: 28px; }

    .script-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 20px;
      margin-top: 20px;
    }

    .script-card {
      background: #1b1b1b;
      border: 1px solid #2d2d2d;
      border-radius: 12px;
      padding: 20px;
      transition: all 0.3s ease;
      cursor: pointer;
    }

    .script-card:hover {
      background: #272727;
      transform: scale(1.03);
      border-color: #8e2de2;
    }

    .script-card h3 {
      font-size: 18px;
      margin-bottom: 10px;
      color: #ddd;
    }

    .button {
      padding: 12px 20px;
      background: linear-gradient(90deg, #8e2de2, #4a00e0);
      color: white;
      font-weight: bold;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      margin-top: 20px;
      transition: background 0.3s ease;
    }

    .button:hover {
      background: linear-gradient(90deg, #4a00e0, #8e2de2);
    }

    #editor {
      height: 400px;
      border: 1px solid #333;
      border-radius: 12px;
      overflow: hidden;
      margin-top: 20px;
    }

    #response {
      color: #00ff88;
      margin-top: 15px;
      font-size: 14px;
      white-space: pre-wrap;
    }
  </style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.34.1/min/vs/loader.min.js"></script>
</head>
<body>
  <div class="container">
    <div class="sidebar">
      <h1>Lua Panel</h1>
      <a class="nav-link active" href="#" onclick="showTab('dashboard', this)">Dashboard</a>
      <a class="nav-link" href="#" onclick="showTab('executor', this)">Executor</a>
      <a class="nav-link" href="#" onclick="showTab('scripthub', this)">Script Hub</a>
      <a class="nav-link" href="#" onclick="showTab('pricing', this)">Pricing</a>
    </div>
    <div class="content">
      <div id="dashboard" class="tabs active">
        <h2>Welcome, ${username}</h2>
        <p>Explore scripts, execute Lua code, and manage your experience.</p>
      </div>

      <div id="executor" class="tabs">
        <h2>Script Executor</h2>
        <div id="editor">// Write or load a Lua script here</div>
        <button class="button" onclick="executeScript()">Execute</button>
        <div id="response"></div>
      </div>

      <div id="scripthub" class="tabs">
        <h2>Script Hub</h2>
        <div class="script-grid">
          ${scripts.map(script => `
            <div class="script-card" onclick="loadScript(\`${script.Script.replace(/Username/g, username)}\`)">
              <h3>${script.Name}</h3>
              <p>Click to load into executor</p>
            </div>
          `).join('')}
        </div>
      </div>

      <div id="pricing" class="tabs">
        <h2>Pricing Tiers</h2>
        <p><strong>Standard:</strong> Basic access to community features.</p>
        <p><strong>Premium:</strong> Unlock premium hubs and exclusive scripts.</p>
        <p><strong>Ultimate:</strong> Full access, all scripts, priority support.</p>
      </div>
    </div>
  </div>

  <script>
    let editor;
    require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.34.1/min/vs' }});
    require(["vs/editor/editor.main"], function () {
      editor = monaco.editor.create(document.getElementById("editor"), {
        value: "-- Lua executor ready",
        language: "lua",
        theme: "vs-dark",
        fontSize: 16,
        automaticLayout: true
      });
    });

    function loadScript(code) {
      if (editor) editor.setValue(code);
    }

    function executeScript() {
      const script = editor.getValue();
      fetch('/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script })
      })
      .then(r => r.json())
      .then(d => document.getElementById('response').innerText = d.message);
    }

    function showTab(id, el) {
      document.querySelectorAll('.tabs').forEach(tab => tab.classList.remove('active'));
      document.getElementById(id).classList.add('active');
      document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));
      el.classList.add('active');
    }
  </script>
</body>
</html>
`);
});

app.post('/queue', async (req, res) => {
  const discordId = req.cookies.discord_id;
  if (!discordId) return res.status(401).json({ message: 'Not authenticated' });
  const whitelist = await getWhitelistFromGitHub();
  const entry = whitelist.find(u => u.Discord === discordId);
  if (!entry) return res.status(403).json({ message: 'You are not whitelisted' });

  const script = req.body?.script;
  if (!script) return res.status(400).json({ message: 'No script provided' });
  const username = entry.User;
  if (!userQueues[username]) userQueues[username] = [];
  userQueues[username].push({ script });
  res.status(200).json({ message: 'Script queued for ' + username });
});

app.get('/queue', async (req, res) => {
  const discordId = req.cookies.discord_id;
  if (!discordId) return res.status(401).type('text/plain').send('');
  const whitelist = await getWhitelistFromGitHub();
  const entry = whitelist.find(u => u.Discord === discordId);
  if (!entry) return res.status(403).type('text/plain').send('');
  const username = entry.User;
  const queue = userQueues[username];
  if (!queue || queue.length === 0) return res.type('text/plain').send('');
  const nextScript = queue.shift();
  if (queue.length === 0) delete userQueues[username];
  res.type('text/plain').send(nextScript.script);
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});

discordClient.login(config.DISCORD_BOT_TOKEN).catch(err => {
  console.error('Discord login failed:', err);
  process.exit(1);
});
