// api/auth.js — VibeSort backend (CommonJS, Vercel serverless)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;
  const CID = process.env.SPOTIFY_CLIENT_ID;
  const SEC = process.env.SPOTIFY_CLIENT_SECRET;
  const RDR = process.env.REDIRECT_URI;

  // ── PING — verify env vars are set ──────────────────────────────────────
  if (action === 'ping') {
    return res.json({
      ok: !!(CID && SEC && RDR),
      has_client_id: !!CID,
      has_client_secret: !!SEC,
      has_redirect_uri: !!RDR,
      redirect_uri: RDR || 'NOT SET',
    });
  }

  // ── LOGIN — send user to Spotify ─────────────────────────────────────────
  if (action === 'login') {
    if (!CID || !RDR) return res.status(500).send(errPage('Missing env vars. Check Vercel → Settings → Environment Variables.'));
    const url = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      client_id: CID,
      response_type: 'code',
      redirect_uri: RDR,
      scope: 'user-read-private user-read-email user-library-read playlist-read-private',
      show_dialog: 'false',
    });
    return res.redirect(302, url);
  }

  // ── CALLBACK — exchange code for tokens ──────────────────────────────────
  if (action === 'callback') {
    if (req.query.error) return res.status(200).send(bridgePage(null, req.query.error));
    if (!req.query.code) return res.status(200).send(bridgePage(null, 'no_code'));

    try {
      const r = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(CID + ':' + SEC).toString('base64'),
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: req.query.code,
          redirect_uri: RDR,
        }),
      });
      if (!r.ok) {
        const txt = await r.text();
        return res.status(200).send(bridgePage(null, `spotify_${r.status}: ${txt.slice(0,100)}`));
      }
      const t = await r.json();
      if (!t.access_token) return res.status(200).send(bridgePage(null, 'no_token_returned'));
      return res.status(200).send(bridgePage(t, null));
    } catch (e) {
      return res.status(200).send(bridgePage(null, e.message));
    }
  }

  // ── REFRESH — get a new access token ─────────────────────────────────────
  if (action === 'refresh') {
    const rt = (req.body && req.body.refresh_token) || req.query.refresh_token;
    if (!rt) return res.status(400).json({ error: 'missing_refresh_token' });
    try {
      const r = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(CID + ':' + SEC).toString('base64'),
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt }),
      });
      if (!r.ok) throw new Error('refresh_failed_' + r.status);
      const d = await r.json();
      return res.json({ access_token: d.access_token, expires_in: d.expires_in });
    } catch (e) {
      return res.status(401).json({ error: e.message });
    }
  }

  return res.status(404).json({ error: 'unknown_action' });
};

// Bridge page — writes tokens to localStorage then redirects home
// Avoids iOS Safari bug where it strips URL fragments on redirect
function bridgePage(tokens, error) {
  if (error) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07070f;font-family:-apple-system,sans-serif;color:#f0f0f8;text-align:center;padding:32px}</style></head>
<body><div>
  <div style="font-size:52px;margin-bottom:20px">⚠️</div>
  <h2 style="font-size:20px;margin-bottom:10px;font-weight:700">Connection failed</h2>
  <p style="color:rgba(240,240,248,.4);font-size:13px;margin-bottom:28px;font-family:monospace;background:rgba(255,255,255,.05);padding:10px 16px;border-radius:8px">${String(error).replace(/</g,'&lt;')}</p>
  <a href="/" style="display:inline-block;padding:14px 32px;background:#1DB954;color:#000;border-radius:14px;text-decoration:none;font-weight:700;font-size:15px">← Back</a>
</div></body></html>`;
  }
  const expiry = Date.now() + ((tokens.expires_in || 3600) * 1000);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07070f;font-family:-apple-system,sans-serif;color:rgba(240,240,248,.5);font-size:14px;text-align:center}.ring{width:48px;height:48px;border-radius:50%;border:3px solid transparent;border-top-color:#ff3cac;border-right-color:#a78bfa;border-bottom-color:#22d3ee;border-left-color:#3b82f6;animation:s 1s linear infinite;margin:0 auto 20px}@keyframes s{to{transform:rotate(360deg)}}</style>
</head><body><div><div class="ring"></div><p>Connecting…</p></div>
<script>
!function(){
  var at=${JSON.stringify(tokens.access_token)};
  var rt=${JSON.stringify(tokens.refresh_token||'')};
  var ex=${JSON.stringify(String(expiry))};
  try{localStorage.setItem('vs_tok',at);localStorage.setItem('vs_exp',ex);if(rt)localStorage.setItem('vs_ref',rt);}catch(e){}
  try{sessionStorage.setItem('vs_tok',at);sessionStorage.setItem('vs_exp',ex);if(rt)sessionStorage.setItem('vs_ref',rt);}catch(e){}
  setTimeout(function(){window.location.replace('/');},350);
}();
</script></body></html>`;
}

function errPage(msg) {
  return `<html><body style="font-family:sans-serif;padding:40px;background:#07070f;color:#f0f0f8"><h2 style="color:#f87171">⚠️ ${msg}</h2></body></html>`;
}
