const userQueues = {}; // In-memory queue

// Queue POST: Add script to user's queue
app.post('/queue/:username', (req, res) => {
  const username = req.params.username;
  const script = req.body?.script;

  if (!script || typeof script !== 'string') {
    return res.status(400).json({ status: 'error', message: 'Script is required and must be a string' });
  }

  if (!userQueues[username]) userQueues[username] = [];
  userQueues[username].push({ script });

  res.json({ status: 'success', message: 'Script queued' });
});

// Queue GET: Get and remove the first script for a user
app.get('/queue/:username', (req, res) => {
  const username = req.params.username;
  const queue = userQueues[username];
  
  if (!queue || queue.length === 0) {
    return res.json({ status: 'success', script: null });
  }

  const next = queue.shift();
  if (queue.length === 0) delete userQueues[username];

  res.json({ status: 'success', script: next.script });
});

// Simple HTML UI to send script to queue
app.get('/queue.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Queue Script</title>
      <style>
        body { font-family: sans-serif; padding: 20px; }
        input, textarea { width: 100%; margin-top: 10px; padding: 8px; }
        button { margin-top: 10px; padding: 10px 20px; }
      </style>
    </head>
    <body>
      <h2>Send Script to User Queue</h2>
      <input id="username" placeholder="Username">
      <textarea id="script" rows="10" placeholder="Enter Lua script..."></textarea>
      <button onclick="send()">Send</button>
      <pre id="output"></pre>
      <script>
        async function send() {
          const username = document.getElementById('username').value;
          const script = document.getElementById('script').value;
          const res = await fetch('/queue/' + username, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ script })
          });
          const result = await res.json();
          document.getElementById('output').textContent = JSON.stringify(result, null, 2);
        }
      </script>
    </body>
    </html>
  `);
});

// Lua script endpoint for clients
app.get('/queue/lua/:username', (req, res) => {
  const username = req.params.username;
  res.setHeader('Content-Type', 'text/plain');
  res.send(`
local HttpService = game:GetService("HttpService")
local username = "${username}"
local url = "http://${req.headers.host}/queue/" .. username

while true do
  local success, response = pcall(function()
    return HttpService:GetAsync(url)
  end)
  if success then
    local data = HttpService:JSONDecode(response)
    if data.script then
      local func, err = loadstring(data.script)
      if func then
        pcall(func)
      else
        warn("Failed to compile script:", err)
      end
    end
  else
    warn("Request failed")
  end
  wait(1)
end
  `);
});
