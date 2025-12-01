const express = require('express');
const axios = require('axios');
const cors = require('cors');

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '481884a49f8a49c6be371515f1f4fbfc';
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || 'b20ec550b9f540c89a49dfda4d8923e1';
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3000/callback';
const FRONTEND_REDIRECT = process.env.FRONTEND_REDIRECT || 'https://soundtrackgen-2025.web.app/#/spotify-connect';

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const userTokens = new Map(); // key: state (session id), value: { access_token, refresh_token, expires_at }

const scopes = [
  'user-read-email',
  'user-read-private',
  'playlist-modify-private',
  'playlist-modify-public'
];

function encodeBasicAuth(id, secret) {
  return Buffer.from(`${id}:${secret}`).toString('base64');
}

async function exchangeToken({ code, refresh_token }) {
  const params = new URLSearchParams();
  if (code) {
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', REDIRECT_URI);
  } else if (refresh_token) {
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', refresh_token);
  }

  const response = await axios.post('https://accounts.spotify.com/api/token', params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${encodeBasicAuth(CLIENT_ID, CLIENT_SECRET)}`
    }
  });

  return response.data;
}

function storeTokens(state, data) {
  userTokens.set(state, {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000
  });
}

function getValidToken(state) {
  const entry = userTokens.get(state);
  if (!entry) return null;
  if (Date.now() < entry.expires_at - 5000) return entry;
  return null;
}

app.get('/login', (req, res) => {
  const clientState = req.query.state;
  const state = clientState || Math.random().toString(36).substring(2);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: scopes.join(' '),
    state,
    show_dialog: 'true'
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.redirect(`${FRONTEND_REDIRECT}?error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return res.redirect(`${FRONTEND_REDIRECT}?error=missing_code`);
  }
  try {
    const tokenData = await exchangeToken({ code });
    storeTokens(state || 'default', tokenData);
    const params = new URLSearchParams({
      state: state || 'default',
      hasTokens: 'true'
    });
    res.redirect(`${FRONTEND_REDIRECT}?${params.toString()}`);
  } catch (err) {
    console.error('Callback error:', err.response?.data || err.message);
    res.redirect(`${FRONTEND_REDIRECT}?error=token_exchange_failed`);
  }
});

app.post('/api/spotify/token', async (req, res) => {
  const { state } = req.body || {};
  if (!state) {
    return res.status(400).json({ error: 'Missing state' });
  }
  let tokenEntry = getValidToken(state);
  if (!tokenEntry) {
    const stored = userTokens.get(state);
    if (!stored || !stored.refresh_token) {
      return res.status(401).json({ error: 'Not authenticated with Spotify' });
    }
    try {
      const refreshed = await exchangeToken({ refresh_token: stored.refresh_token });
      storeTokens(state, { ...refreshed, refresh_token: refreshed.refresh_token || stored.refresh_token });
      tokenEntry = userTokens.get(state);
    } catch (err) {
      console.error('Refresh error:', err.response?.data || err.message);
      return res.status(401).json({ error: 'Spotify refresh failed' });
    }
  }
  res.json({
    access_token: tokenEntry.access_token,
    expires_at: tokenEntry.expires_at
  });
});

app.post('/api/spotify/recommendations', async (req, res) => {
  const { state, mood, timeOfDay, market } = req.body || {};
  const tokenEntry = getValidToken(state);
  if (!tokenEntry) {
    return res.status(401).json({ error: 'Spotify not connected' });
  }
  if (!mood) {
    return res.status(400).json({ error: 'Missing mood parameter' });
  }
  const params = buildRecommendationParams(mood, timeOfDay);
  try {
    if (market) {
      params.market = market;
    }
    const query = new URLSearchParams();
    Object.keys(params).forEach(key => {
      if (params[key] !== undefined && params[key] !== null) {
        query.append(key, params[key]);
      }
    });

    const response = await axios.get('https://api.spotify.com/v1/recommendations', {
      params: query,
      headers: { Authorization: `Bearer ${tokenEntry.access_token}` }
    });

    const tracks = (response.data.tracks || []).map(track => ({
      id: track.id,
      name: track.name,
      artist: (track.artists || []).map(a => a.name).join(', '),
      album: track.album?.name,
      duration_ms: track.duration_ms,
      image: track.album?.images?.[0]?.url,
      uri: track.uri
    }));

    res.json({ tracks });
  } catch (err) {
    console.error('Recommendations error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Unable to fetch recommendations' });
  }
});

function buildRecommendationParams(mood, timeOfDay) {
  var config = {
    seed_genres: 'pop',
    limit: 20,
    target_valence: 0.6,
    target_energy: 0.6,
    min_tempo: 90,
    max_tempo: 130
  };

  switch ((mood || '').toLowerCase()) {
    case 'happy':
      config.seed_genres = 'pop,indie-pop';
      config.target_valence = 0.85;
      config.target_energy = 0.7;
      config.min_tempo = 100;
      config.max_tempo = 135;
      break;
    case 'chill':
      config.seed_genres = 'chill,ambient,lo-fi';
      config.target_valence = 0.4;
      config.target_energy = 0.3;
      config.min_tempo = 60;
      config.max_tempo = 95;
      break;
    case 'focus':
      config.seed_genres = 'focus,jazz,classical';
      config.target_valence = 0.5;
      config.target_energy = 0.45;
      config.min_tempo = 60;
      config.max_tempo = 110;
      break;
    case 'energetic':
      config.seed_genres = 'dance,edm,rock';
      config.target_valence = 0.75;
      config.target_energy = 0.9;
      config.min_tempo = 120;
      config.max_tempo = 150;
      break;
    case 'nostalgic':
      config.seed_genres = 'rock,classic-rock,soul';
      config.target_valence = 0.5;
      config.target_energy = 0.5;
      config.min_tempo = 70;
      config.max_tempo = 115;
      break;
    case 'neutral':
    default:
      config.seed_genres = 'pop,rock';
      config.target_valence = 0.6;
      config.target_energy = 0.6;
      config.min_tempo = 80;
      config.max_tempo = 130;
      break;
  }

  switch ((timeOfDay || '').toLowerCase()) {
    case 'morning':
      config.target_energy = Math.max(0, config.target_energy - 0.05);
      config.min_tempo = Math.max(40, config.min_tempo - 5);
      break;
    case 'evening':
      config.target_energy = Math.max(0, config.target_energy - 0.1);
      config.max_tempo = Math.max(config.min_tempo + 5, config.max_tempo - 10);
      break;
    case 'night':
      config.target_energy = Math.max(0, config.target_energy - 0.2);
      config.target_valence = Math.max(0, config.target_valence - 0.1);
      config.max_tempo = Math.max(config.min_tempo + 5, config.max_tempo - 20);
      break;
    case 'afternoon':
    default:
      break;
  }

  return config;
}

app.post('/api/spotify/create-playlist', async (req, res) => {
  const { state, playlistName, description, trackUris } = req.body || {};
  const tokenEntry = getValidToken(state);
  if (!tokenEntry) {
    return res.status(401).json({ error: 'Spotify not connected' });
  }
  if (!playlistName || !Array.isArray(trackUris)) {
    return res.status(400).json({ error: 'Missing playlist data' });
  }

  try {
    const profile = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${tokenEntry.access_token}` }
    });
    const userId = profile.data.id;

    const createResponse = await axios.post(
      `https://api.spotify.com/v1/users/${userId}/playlists`,
      { name: playlistName, description: description || '', public: false },
      { headers: { Authorization: `Bearer ${tokenEntry.access_token}` } }
    );

    const playlistId = createResponse.data.id;
    if (trackUris.length) {
      await axios.post(
        `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
        { uris: trackUris },
        { headers: { Authorization: `Bearer ${tokenEntry.access_token}` } }
      );
    }

    res.json({
      playlistId,
      playlistUrl: createResponse.data.external_urls?.spotify
    });
  } catch (err) {
    console.error('Create playlist error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Unable to create playlist' });
  }
});

app.post('/api/spotify/logout', (req, res) => {
  const { state } = req.body || {};
  if (state && userTokens.has(state)) {
    userTokens.delete(state);
  }
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Spotify backend listening on', PORT));

module.exports = app;


