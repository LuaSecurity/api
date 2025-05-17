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
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 20px;
      margin-top: 20px;
    }

    .script-card {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 20px;
      position: relative;
      backdrop-filter: blur(12px);
      box-shadow: 0 0 20px rgba(0,0,0,0.4);
      transition: all 0.3s ease;
    }

    .script-card:hover {
      border-color: #8e2de2;
      transform: translateY(-4px);
    }

    .script-card h3 {
      font-size: 18px;
      margin-bottom: 10px;
      color: #eee;
    }

    .run-btn {
      background: linear-gradient(90deg, #8e2de2, #4a00e0);
      border: none;
      border-radius: 8px;
      padding: 10px 16px;
      color: white;
      font-weight: bold;
      cursor: pointer;
      position: absolute;
      bottom: 20px;
      right: 20px;
      transition: 0.3s;
    }

    .run-btn:hover {
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

    .card-desc {
      font-size: 13px;
      color: #aaa;
      margin-top: 8px;
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
      <a class="nav-link" href="/pricing">Pricing</a>
    </div>
    <div class="content">
      <div id="dashboard" class="tabs active">
        <h2>Welcome, ${username}</h2>
        <p>Explore scripts, execute Lua code, and manage your experience.</p>
      </div>

      <div id="executor" class="tabs">
        <h2>Script Executor</h2>
        <div id="editor">// Write or load a Lua script here</div>
        <button class="run-btn" onclick="executeScript()">Execute</button>
        <div id="response"></div>

        <h2 style="margin-top: 40px;">Script Hub</h2>
        <div class="script-grid">
          ${scripts.map(script => `
            <div class="script-card">
              <h3>${script.Name}</h3>
              <div class="card-desc">Click Run to queue instantly</div>
              <button class="run-btn" onclick="queueScript(\`${script.Script.replace(/Username/g, username)}\`)">Run</button>
            </div>
          `).join('')}
        </div>
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

    function queueScript(code) {
      fetch('/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: code })
      })
      .then(r => r.json())
      .then(d => alert(d.message || 'Script queued!'));
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

app.get('/pricing', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Pricing</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    body { margin: 0; font-family: 'Inter', sans-serif; background: #0b0b0c; color: #fff; }
    .header { padding: 40px 20px; text-align: center; }
    .header h1 { font-size: 42px; margin-bottom: 10px; }
    .plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 30px; max-width: 1200px; margin: 0 auto; padding: 40px 20px; }
    .plan { background: #161616; border: 1px solid #2c2c2c; border-radius: 12px; padding: 30px 20px; transition: 0.3s; }
    .plan:hover { border-color: #8e2de2; transform: scale(1.03); }
    .plan h2 { font-size: 24px; margin-bottom: 10px; }
    .plan p { font-size: 14px; color: #aaa; margin: 10px 0; }
    .price { font-size: 28px; font-weight: bold; margin: 20px 0; }
    .button { background: linear-gradient(90deg, #8e2de2, #4a00e0); padding: 12px 20px; border: none; border-radius: 8px; color: white; font-weight: bold; cursor: pointer; text-decoration: none; display: inline-block; }
    .button:hover { background: linear-gradient(90deg, #4a00e0, #8e2de2); }
  </style>
</head>
<body>
  <div class="header">
    <h1>Choose Your Plan</h1>
    <p>Upgrade your experience with premium access and exclusive scripts.</p>
  </div>
  <div class="plans">
    <div class="plan">
      <h2>Standard</h2>
      <div class="price">Free</div>
      <p>✅ Community access</p>
      <p>✅ Basic scripts</p>
      <p>🚫 No exclusive features</p>
      <a class="button" href="/">Get Started</a>
    </div>
    <div class="plan">
      <h2>Premium</h2>
      <div class="price">$9.99/mo</div>
      <p>✅ Premium scripts</p>
      <p>✅ Role-based features</p>
      <p>✅ Faster queue</p>
      <a class="button" href="/">Upgrade Now</a>
    </div>
    <div class="plan">
      <h2>Ultimate</h2>
      <div class="price">$19.99/mo</div>
      <p>✅ All scripts unlocked</p>
      <p>✅ Top-tier support</p>
      <p>✅ Custom script requests</p>
      <a class="button" href="/">Go Ultimate</a>
    </div>
  </div>
</body>
</html>`);
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Lua Panel</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
  <style>
    body { margin: 0; font-family: 'Inter', sans-serif; background: #0c0c0c; color: white; }
    header { text-align: center; padding: 80px 20px; background: linear-gradient(90deg, #8e2de2, #4a00e0); }
    header h1 { font-size: 42px; margin-bottom: 10px; }
    header p { font-size: 18px; color: #eee; }
    .cta { margin-top: 30px; }
    .cta a { text-decoration: none; background: white; color: #4a00e0; padding: 14px 24px; font-weight: bold; border-radius: 8px; display: inline-block; transition: 0.3s ease; }
    .cta a:hover { background: #ddd; }
    .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 30px; padding: 60px 40px; max-width: 1100px; margin: auto; }
    .feature { background: #161616; padding: 30px; border-radius: 12px; border: 1px solid #2d2d2d; transition: 0.3s ease; }
    .feature:hover { border-color: #8e2de2; }
    footer { text-align: center; padding: 30px; font-size: 14px; color: #aaa; background: #111; }
    footer a { color: #aaa; text-decoration: none; }
    footer a:hover { color: white; }
  </style>
</head>
<body>
  <header>
    <h1>Lua Panel</h1>
    <p>Run scripts. Control your access. All via Discord.</p>
    <div class="cta">
      <a href="/executor">Enter Control Panel</a>
    </div>
  </header>

  <section class="features">
    <div class="feature">
      <h3>Premium Scripts</h3>
      <p>Access a variety of exclusive and optimized scripts with Discord-based control.</p>
    </div>
    <div class="feature">
      <h3>Advanced Control</h3>
      <p>Execute scripts safely and directly through your personal panel.</p>
    </div>
    <div class="feature">
      <h3>Access Upgrades</h3>
      <p>Upgrade to Premium or Ultimate plans to unlock full potential.</p>
    </div>
  </section>

  <footer>
    &copy; ${new Date().getFullYear()} Lua Panel · <a href="/pricing">Pricing</a> · <a href="/tos">Terms</a>
  </footer>
</body>
</html>`);
});

app.get('/tos', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>Terms of Service | Lua Panel</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
    <style>
      :root {
        --gradient: linear-gradient(90deg, #8e2de2, #4a00e0);
      }

      body {
        margin: 0;
        padding: 0;
        font-family: 'Inter', sans-serif;
        background: #0c0c0c;
        color: #f5f5f5;
        line-height: 1.7;
        padding-bottom: 80px;
      }

      .hero {
        text-align: center;
        padding: 80px 20px 40px;
        background: #0f0f11;
        border-bottom: 1px solid #1f1f1f;
      }

      .hero h1 {
        font-size: 42px;
        background: var(--gradient);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        font-weight: 800;
        margin-bottom: 12px;
      }

      .hero p {
        color: #bbb;
        font-size: 18px;
      }

      .content {
        max-width: 900px;
        margin: 40px auto;
        padding: 0 20px;
      }

      .section {
        margin-bottom: 50px;
      }

      .section h2 {
        font-size: 26px;
        color: #ffffff;
        margin-bottom: 10px;
        border-left: 4px solid #8e2de2;
        padding-left: 12px;
      }

      .section p {
        color: #ccc;
        font-size: 16px;
        margin-top: 10px;
      }

      .section p a {
        color: #9b5de5;
        text-decoration: underline;
      }

      footer {
        text-align: center;
        color: #666;
        padding: 30px 10px;
        border-top: 1px solid #1a1a1a;
        font-size: 14px;
      }

      @media (max-width: 600px) {
        .hero h1 {
          font-size: 32px;
        }

        .section h2 {
          font-size: 22px;
        }
      }
    </style>
  </head>
  <body>
    <section class="hero">
      <h1>Terms of Service</h1>
      <p>Updated May 2025 • Your agreement with Lua Panel</p>
    </section>

    <main class="content">
      <div class="section">
        <h2>1. Platform Usage</h2>
        <p>By using Lua Panel, you agree to our policies, limitations, and access rules. This platform is integrated with Discord authentication and only whitelisted users are allowed.</p>
      </div>

      <div class="section">
        <h2>2. Scripts & Content</h2>
        <p>All scripts and files provided are for educational and demonstrational use. Redistribution or commercial use without permission is strictly prohibited.</p>
      </div>

      <div class="section">
        <h2>3. Subscription Plans</h2>
        <p>Premium and Ultimate tiers unlock exclusive access. Subscriptions are recurring and non-refundable unless explicitly stated otherwise.</p>
      </div>

      <div class="section">
        <h2>4. Data & Security</h2>
        <p>All accounts are tied to your Discord ID. Lua Panel does not store passwords or personal data outside what's required for functionality (cookies, IDs, and roles).</p>
      </div>

      <div class="section">
        <h2>5. Modifications</h2>
        <p>We reserve the right to update these terms at any time. Changes will be posted on this page. Continued usage of the panel constitutes acceptance of the updated terms.</p>
      </div>

      <div class="section">
        <h2>6. Contact & Support</h2>
        <p>If you have any questions about these terms, please contact our team via <a href="https://discord.gg/YOURSERVER" target="_blank">Discord</a>.</p>
      </div>
    </main>

    <footer>
      &copy; ${new Date().getFullYear()} Lua Panel. All rights reserved.
    </footer>
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
