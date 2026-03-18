// api/auth.js — Vercel serverless function
// Uses a rendered HTML bridge page to pass tokens — fixes iOS Safari fragment stripping

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  // ── PING ─────────────────────────────────────────────────────────────────
  if (action === 'ping') {
    return res.status(200).json({
      ok: true,
      has_client_id:     !!process.env.SPOTIFY_CLIENT_ID,
      has_client_secret: !!process.env.SPOTIFY_CLIENT_SECRET,
      has_redirect_uri:  !!process.env.REDIRECT_URI,
      redirect_uri:      process.env.REDIRECT_URI || 'NOT SET',
    });
  }

  // ── LOGIN ─────────────────────────────────────────────────────────────────
  if (action === 'login') {
    const CLIENT_ID    = process.env.SPOTIFY_CLIENT_ID;
    const REDIRECT_URI = process.env.REDIRECT_URI;

    if (!CLIENT_ID || !REDIRECT_URI) {
      return res.status(500).send('<html><body style="font-family:sans-serif;padding:40px;background:#07070f;color:#f0f0f8"><h2 style="color:#f87171">Missing env vars</h2><p>Add SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, REDIRECT_URI to Vercel env vars then redeploy.</p><p><a href="/api/auth?action=ping" style="color:#22d3ee">Check ping</a></p></body></html>');
    }

    const params = new URLSearchParams({
      client_id:     CLIENT_ID,
      response_type: 'code',
      redirect_uri:  REDIRECT_URI,
      scope:         'user-library-read playlist-read-private user-read-private user-read-email',
      show_dialog:   'false',
    });

    return res.redirect(302, 'https://accounts.spotify.com/authorize?' + params.toString());
  }

  // ── CALLBACK ──────────────────────────────────────────────────────────────
  if (action === 'callback') {
    const code  = req.query.code;
    const error = req.query.error;

    if (error || !code) {
      return res.status(200).send(bridge_error(error || 'no_code'));
    }

    const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
    const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
    const REDIRECT_URI  = process.env.REDIRECT_URI;

    try {
      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
        },
        body: new URLSearchParams({
          grant_type:   'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
        }).toString(),
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        console.error('Token exchange failed:', tokenRes.status, errBody);
        return res.status(200).send(bridge_error('token_error_' + tokenRes.status + ': ' + errBody.slice(0, 200)));
      }

      const tokens = await tokenRes.json();
      if (!tokens.access_token) {
        return res.status(200).send(bridge_error('no_access_token_returned'));
      }

      return res.status(200).send(bridge_success(tokens));

    } catch (e) {
      console.error('Callback error:', e);
      return res.status(200).send(bridge_error('server_error: ' + e.message));
    }
  }

  // ── REFRESH ───────────────────────────────────────────────────────────────
  if (action === 'refresh') {
    let refresh_token = (req.body && req.body.refresh_token) || req.query.refresh_token;

    if (!refresh_token) return res.status(400).json({ error: 'missing_refresh_token' });

    const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
    const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

    try {
      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token }).toString(),
      });

      if (!tokenRes.ok) throw new Error('refresh_failed_' + tokenRes.status);
      const data = await tokenRes.json();
      return res.status(200).json({ access_token: data.access_token, expires_in: data.expires_in });
    } catch (e) {
      return res.status(401).json({ error: e.message });
    }
  }

  return res.status(404).json({ error: 'unknown_action', action });
};

// ─────────────────────────────────────────────────────────────────────────────
// Bridge pages — instead of URL fragments (stripped by iOS Safari),
// we serve a small HTML page that writes tokens to storage then redirects.
// ─────────────────────────────────────────────────────────────────────────────

function bridge_success(tokens) {
  const expiry = Date.now() + ((tokens.expires_in || 3600) * 1000);
  const at  = JSON.stringify(tokens.access_token);
  const rt  = JSON.stringify(tokens.refresh_token || '');
  const exp = JSON.stringify(String(expiry));

  return `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connecting…</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07070f;font-family:-apple-system,sans-serif;color:#f0f0f8;text-align:center;}
  .ring{width:52px;height:52px;border-radius:50%;border:3px solid transparent;border-top-color:#ff3cac;border-right-color:#a78bfa;border-bottom-color:#22d3ee;border-left-color:#3b82f6;animation:spin 1s linear infinite;margin:0 auto 20px;}
  @keyframes spin{to{transform:rotate(360deg)}}
  p{color:rgba(240,240,248,.4);font-size:14px;}
</style>
</head><body>
<div><div class="ring"></div><p>Connected! Opening VibeSort…</p></div>
<script>
(function(){
  try {
    var at  = ${at};
    var rt  = ${rt};
    var exp = ${exp};
    // write to both storage types for maximum compatibility
    ['localStorage','sessionStorage'].forEach(function(s){
      try {
        window[s].setItem('vs_tok', at);
        window[s].setItem('vs_exp', exp);
        if (rt) window[s].setItem('vs_ref', rt);
      } catch(e) { console.warn(s, e); }
    });
    setTimeout(function(){ window.location.replace('/'); }, 400);
  } catch(e) {
    document.body.innerHTML = '<div style="padding:40px"><p style="color:#f87171;margin-bottom:16px">Storage error: ' + e.message + '</p><a href="/" style="color:#22d3ee">← Try again</a></div>';
  }
})();
</script>
</body></html>`;
}

function bridge_error(msg) {
  const safe = String(msg || 'unknown').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Error</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07070f;font-family:-apple-system,sans-serif;color:#f0f0f8;text-align:center;padding:32px;}</style>
</head><body>
<div>
  <div style="font-size:48px;margin-bottom:16px">⚠️</div>
  <h2 style="font-size:18px;margin-bottom:10px">Connection failed</h2>
  <p style="color:rgba(240,240,248,.4);font-size:13px;margin-bottom:28px;font-family:monospace">${safe}</p>
  <a href="/" style="display:inline-block;padding:14px 28px;background:#1DB954;color:#000;border-radius:12px;text-decoration:none;font-weight:600">← Back to VibeSort</a>
</div>
</body></html>`;
}
