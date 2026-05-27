// Friday — Express + WebSocket server on port 3000
// ---------------------------------------------------------------------------
// Serves the React PWA dashboard from ./public and exposes the API + WS
// channels the dashboard speaks (extracted from the production bundle):
//
//   GET  /api/pending              -> Array<{pendingId,contact,message,isGroup,timestamp,...}>
//   GET  /api/history              -> Array<historyEntry>
//   GET  /api/contacts             -> Array<{contactId,name,trusted}>
//   GET  /api/groups               -> Array<{groupId,name,allowed}>
//   POST /api/approve              <- {pendingId, engagement, voice}
//   POST /api/deny                 <- {pendingId}
//   POST /api/kill                 (toggles)
//   POST /api/command              <- {command} -> {response}
//   POST /api/contacts             <- {contactId, name, trusted}     (upsert)
//   DEL  /api/contacts/:id
//   POST /api/groups/toggle        <- {groupId, name, allowed}
//
//   ws://<host>:3000               broadcasts {type, payload} where type ∈
//                                  pending | sent | log | alert | status | connected
// ---------------------------------------------------------------------------

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const bot = require('./bot');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

// ---------------------------------------------------------------------------
// Request logger — every API call is visible in Termux console.
// ---------------------------------------------------------------------------
app.use((req, _res, next) => {
  if (req.url.startsWith('/api/')) {
    const body = req.method === 'GET' ? '' : ` body=${safeStringify(req.body)}`;
    console.log(`[api] ${req.method} ${req.url}${body}`);
  }
  next();
});

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return '[unserialisable]'; }
}

// Wrap every async handler so thrown errors hit the logger and return JSON.
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    const detail = err && err.stack ? err.stack : String(err && err.message || err);
    console.error(`[api] ${req.method} ${req.url} ERROR: ${detail}`);
    if (!res.headersSent) {
      res.status(500).json({ error: err && err.message ? err.message : String(err) });
    }
  });

// ===========================================================================
// API: pending
// ===========================================================================
app.get('/api/pending', wrap(async (_req, res) => {
  const arr = Array.from(bot.pending.values()).map(e => ({
    pendingId: e.pendingId,
    contactId: e.contactId,
    contact: e.contact,
    message: e.message,
    isGroup: !!e.isGroup,
    timestamp: e.timestamp,
  }));
  res.json(arr);
}));

// ===========================================================================
// API: approve / deny  (the core flow)
// ===========================================================================
app.post('/api/approve', wrap(async (req, res) => {
  const { pendingId, engagement, voice } = req.body || {};
  console.log(`[api] approve pendingId=${pendingId} engagement=${engagement} voice=${voice}`);
  if (!pendingId)  return res.status(400).json({ error: 'pendingId required' });
  if (!engagement) return res.status(400).json({ error: 'engagement required (chat_along | just_one)' });
  if (!voice)      return res.status(400).json({ error: 'voice required (as_me | on_behalf)' });

  const result = await bot.approveMessage(pendingId, engagement, voice);
  res.json(result);
}));

app.post('/api/deny', wrap(async (req, res) => {
  const { pendingId } = req.body || {};
  console.log(`[api] deny pendingId=${pendingId}`);
  if (!pendingId) return res.status(400).json({ error: 'pendingId required' });

  const result = bot.denyMessage(pendingId);
  res.json(result);
}));

// ===========================================================================
// API: history
// ===========================================================================
app.get('/api/history', wrap(async (_req, res) => {
  res.json(bot.history);
}));

// ===========================================================================
// API: contacts
// ===========================================================================
app.get('/api/contacts', wrap(async (_req, res) => {
  res.json(bot.contacts);
}));

// upsert (used by both add and toggle in the dashboard)
app.post('/api/contacts', wrap(async (req, res) => {
  const { contactId, name, trusted } = req.body || {};
  if (!contactId) return res.status(400).json({ error: 'contactId required' });

  const idx = bot.contacts.findIndex(c => c.contactId === contactId);
  if (idx >= 0) {
    bot.contacts[idx] = {
      ...bot.contacts[idx],
      name: name ?? bot.contacts[idx].name,
      trusted: !!trusted,
    };
  } else {
    bot.contacts.push({ contactId, name: name || contactId, trusted: !!trusted });
  }
  bot.saveData();
  res.json({ ok: true, contact: bot.contacts.find(c => c.contactId === contactId) });
}));

app.delete('/api/contacts/:id', wrap(async (req, res) => {
  const id = req.params.id;
  const before = bot.contacts.length;
  const next = bot.contacts.filter(c => c.contactId !== id);
  bot.contacts.length = 0;
  bot.contacts.push(...next);
  bot.saveData();
  console.log(`[api] removed contact ${id} (${before} -> ${bot.contacts.length})`);
  res.json({ ok: true, removed: before - bot.contacts.length });
}));

// ===========================================================================
// API: groups
// ===========================================================================
app.get('/api/groups', wrap(async (_req, res) => {
  res.json(bot.groups);
}));

app.post('/api/groups/toggle', wrap(async (req, res) => {
  const { groupId, name, allowed } = req.body || {};
  if (!groupId) return res.status(400).json({ error: 'groupId required' });

  const idx = bot.groups.findIndex(g => g.groupId === groupId);
  if (idx >= 0) {
    bot.groups[idx] = {
      ...bot.groups[idx],
      name: name ?? bot.groups[idx].name,
      allowed: !!allowed,
    };
  } else {
    bot.groups.push({ groupId, name: name || groupId, allowed: !!allowed });
  }
  bot.saveData();
  res.json({ ok: true, group: bot.groups.find(g => g.groupId === groupId) });
}));

// ===========================================================================
// API: kill / command
// ===========================================================================
app.post('/api/kill', wrap(async (req, res) => {
  // The dashboard sends this as a "shutdown all" intent.
  // We accept an optional `enabled` flag so the dashboard or /api/command
  // can explicitly set the state rather than toggling blindly.
  const { enabled } = req.body || {};
  let next;
  if (typeof enabled === 'boolean') {
    next = bot.killSwitch(enabled);
  } else {
    // Legacy toggle behaviour (dashboard sends empty body).
    next = bot.killSwitch(!bot.killSwitch());
  }
  console.log(`[api] killSwitch now: ${next}`);
  res.json({ ok: true, killSwitch: next });
}));

// GET /api/status — used by the dashboard on load to sync kill state.
app.get('/api/status', wrap(async (_req, res) => {
  const status = bot.getStatus();
  res.json({
    connected: status.ready,
    killSwitch: status.killSwitch,
    pending: bot.pending.size,
    contacts: bot.contacts.length,
    groups: bot.groups.length,
    history: bot.history.length,
  });
}));

app.post('/api/command', wrap(async (req, res) => {
  const { command } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command required' });

  const result = bot.handleCommand(command);
  res.json(result);
}));

// ===========================================================================
// QR helpers — let the user scan from a laptop browser instead of fighting
// Android's app switcher on the phone running Termux.
// ===========================================================================
app.get('/api/qr', wrap(async (_req, res) => {
  const raw = bot.getCurrentQR();
  const status = bot.getStatus();
  if (!raw) return res.json({ qr: null, ready: !!status.ready });
  const dataUrl = await QRCode.toDataURL(raw, { scale: 8, margin: 2 });
  res.json({ qr: dataUrl, ready: false });
}));

app.get('/qr', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Friday — Link WhatsApp</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; min-height: 100vh; background: #0d1117; color: #e6edf3;
           font-family: system-ui, sans-serif; display: flex; flex-direction: column;
           align-items: center; justify-content: center; padding: 24px; gap: 18px; }
    h1 { margin: 0; font-size: 1.15rem; font-weight: 600; }
    p  { margin: 0; opacity: 0.75; font-size: 0.9rem; text-align: center; max-width: 360px; }
    #card { background: #fff; border-radius: 16px; padding: 14px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
    #qr { display: block; width: min(72vw, 320px); height: auto; }
    #empty { width: min(72vw, 320px); aspect-ratio: 1; background: #161b22;
             border: 1px dashed #30363d; border-radius: 16px; display: flex;
             align-items: center; justify-content: center; color: #7d8590; font-size: 0.9rem; }
    #status { font-size: 0.85rem; opacity: 0.65; }
    #status.ok { color: #3fb950; opacity: 1; }
    .pulse { animation: pulse 2s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.4; } }
  </style>
</head>
<body>
  <h1>Link Friday to WhatsApp</h1>
  <p>On your phone, open <b>WhatsApp → Settings → Linked Devices → Link a Device</b> and scan this code.</p>
  <div id="card"><img id="qr" alt="QR" hidden></div>
  <div id="empty" class="pulse">waiting for QR…</div>
  <p id="status">connecting…</p>
  <script>
    const img = document.getElementById('qr');
    const empty = document.getElementById('empty');
    const status = document.getElementById('status');
    async function tick() {
      try {
        const r = await fetch('/api/qr', { cache: 'no-store' });
        const data = await r.json();
        if (data.ready) {
          img.hidden = true;
          empty.style.display = 'none';
          status.textContent = '✓ Friday is linked and ready';
          status.classList.add('ok');
        } else if (data.qr) {
          img.src = data.qr;
          img.hidden = false;
          empty.style.display = 'none';
          status.textContent = 'QR refreshes automatically — scan within ~20 seconds';
          status.classList.remove('ok');
        } else {
          img.hidden = true;
          empty.style.display = 'flex';
          status.textContent = 'waiting for WhatsApp Web…';
        }
      } catch (e) {
        status.textContent = 'lost connection to Friday — retrying…';
      }
    }
    tick();
    setInterval(tick, 2000);
  </script>
</body>
</html>`);
});

// ===========================================================================
// 404 for unknown /api/*
// ===========================================================================
app.use('/api', (req, res) => {
  console.warn(`[api] 404 ${req.method} ${req.url}`);
  res.status(404).json({ error: 'unknown endpoint' });
});

// SPA fallback — let the PWA handle client-side routes.
app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ===========================================================================
// HTTP + WebSocket
// ===========================================================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Set();

wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`[ws] connected from ${req.socket.remoteAddress} (${clients.size} total)`);

  // Hydrate the new client with current state so the dashboard never starts blank.
  try {
    const status = bot.getStatus();
    // If kill switch is active, the dashboard needs to know immediately.
    // The 'status' WS event carries { connected, killSwitch } — the dashboard
    // handles this via SET_CONNECTED. But the dashboard also checks `killed`
    // state which is only set by the /api/kill call itself. We send a status
    // frame so the dashboard at least shows the connection dot correctly.
    ws.send(JSON.stringify({ type: 'connected', payload: { connected: true } }));
    ws.send(JSON.stringify({
      type: 'status',
      payload: { connected: status.ready, killSwitch: status.killSwitch },
    }));
    for (const e of bot.pending.values()) {
      ws.send(JSON.stringify({
        type: 'pending',
        payload: {
          pendingId: e.pendingId,
          contactId: e.contactId,
          contact: e.contact,
          message: e.message,
          isGroup: !!e.isGroup,
          timestamp: e.timestamp,
        },
      }));
    }
  } catch (err) {
    console.error('[ws] hydration send failed:', err.message);
  }

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[ws] disconnected (${clients.size} total)`);
  });
  ws.on('error', (err) => console.error('[ws] socket error:', err.message));
});

function broadcast(payload) {
  let json;
  try {
    json = JSON.stringify(payload);
  } catch (e) {
    console.error('[ws] broadcast stringify failed:', e.message);
    return;
  }

  let sent = 0, dead = 0;
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(json); sent++; }
      catch (e) { dead++; console.error('[ws] send failed:', e.message); }
    }
  }
  // Suppress noise for the very chatty `log` events.
  if (payload && payload.type !== 'log') {
    console.log(`[ws] broadcast type=${payload.type} -> ${sent} client(s)${dead ? ` (${dead} failed)` : ''}`);
  }
}

// Wire the bot's broadcaster BEFORE WhatsApp can fire any events at the dashboard.
bot.setBroadcast(broadcast);

server.listen(PORT, () => {
  console.log(`[server] Friday dashboard listening on http://localhost:${PORT}`);
  console.log(`[server] static dir: ${PUBLIC_DIR}`);
});

// ===========================================================================
// Process-level safety nets — never let an unhandled error crash the bot
// silently in Termux.
// ===========================================================================
process.on('uncaughtException', (e) => {
  console.error('[server] uncaughtException:', e.stack || e.message || e);
});
process.on('unhandledRejection', (e) => {
  console.error('[server] unhandledRejection:', e && e.stack || e);
});
process.on('SIGINT', () => {
  console.log('\n[server] SIGINT — saving data and exiting');
  try { bot.saveData(); } catch (e) { console.error('[server] save failed:', e.message); }
  process.exit(0);
});
