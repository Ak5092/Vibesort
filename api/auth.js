// api/auth.js — Vercel serverless function (CommonJS)
// Your Spotify secrets live here — users never see them

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  // ─── GET /api/auth?action=login ────────────────────────────────────────────
  // User clicks "Connect Spotify" → we redirect them to Spotify's login page
  if (action === 'login') {
    const CLIENT_ID    = process.env.SPOTIFY_CLIENT_ID;
    const REDIRECT_URI = process.env.REDIRECT_URI;

    if (!CLIENT_ID || !REDIRECT_URI) {
      return res.status(500).send(
        '<h2 style="font-family:sans-serif;color:red">⚠️ Missing env vars</h2>' +
        '<p style="font-family:sans-serif">Add SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and REDIRECT_URI to Vercel Environment Variables then redeploy.</p>'
      );
    }

    const scope = [
      'user-library-read',
      'playlist-read-private',
      'playlist-read-collaborative',
      'playlist-modify-private',
      'playlist-modify-public',
      'user-read-private',
      'user-read-email',
    ].join(' ');

    const params = new URLSearchParams({
      client_id:     CLIENT_ID,
      response_type: 'code',
      redirect_uri:  REDIRECT_URI,
      scope,
      show_dialog:   'false',
    });

    return res.redirect(302, 'https://accounts.spotify.com/authorize?' + params.toString());
  }

  // ─── GET /api/auth?action=callback ─────────────────────────────────────────
  // Spotify sends the user back here with a code — we swap it for tokens
  if (action === 'callback') {
    const code  = req.query.code;
    const error = req.query.error;

    if (error || !code) {
      return res.redirect(302, '/?error=' + encodeURIComponent(error || 'no_code'));
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
          code:          code,
          redirect_uri:  REDIRECT_URI,
        }).toString(),
      });

      if (!tokenRes.ok) {
        const txt = await tokenRes.text();
        console.error('Token error:', txt);
        throw new Error('token_exchange_failed');
      }

      const tokens = await tokenRes.json();

      // Pass tokens to the frontend via URL hash — never logged by any server
      const fragment = new URLSearchParams({
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token || '',
        expires_in:    String(tokens.expires_in || 3600),
      });

      return res.redirect(302, '/#' + fragment.toString());

    } catch (e) {
      console.error(e);
      return res.redirect(302, '/?error=auth_failed');
    }
  }

  // ─── POST /api/auth?action=refresh ─────────────────────────────────────────
  // Silently refreshes an expired access token using the refresh token
  if (action === 'refresh' && req.method === 'POST') {
    let body = '';
    if (req.body) {
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    let refresh_token;
    try {
      refresh_token = req.body?.refresh_token || JSON.parse(body)?.refresh_token;
    } catch {
      return res.status(400).json({ error: 'bad_request' });
    }

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
        body: new URLSearchParams({
          grant_type:    'refresh_token',
          refresh_token: refresh_token,
        }).toString(),
      });

      if (!tokenRes.ok) throw new Error();
      const data = await tokenRes.json();
      return res.status(200).json({
        access_token: data.access_token,
        expires_in:   data.expires_in,
      });
    } catch {
      return res.status(401).json({ error: 'refresh_failed' });
    }
  }

  // ─── GET /api/auth?action=ping ─────────────────────────────────────────────
  // Health check — visit this URL to confirm the function is deployed
  if (action === 'ping') {
    return res.status(200).json({
      ok: true,
      has_client_id:     !!process.env.SPOTIFY_CLIENT_ID,
      has_client_secret: !!process.env.SPOTIFY_CLIENT_SECRET,
      has_redirect_uri:  !!process.env.REDIRECT_URI,
      redirect_uri:      process.env.REDIRECT_URI || 'NOT SET',
    });
  }

  return res.status(404).json({ error: 'unknown_action', action });
};
