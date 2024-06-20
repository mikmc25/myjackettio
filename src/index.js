import fs from 'fs';
import dotenv from 'dotenv';
import showdown from 'showdown';
import express from 'express';
import localtunnel from 'localtunnel';
import { fileURLToPath } from 'url';
import path from 'path';
import config from './lib/config.js';
import cache from './lib/cache.js';
import * as debrid from './lib/debrid.js';
import { getIndexers } from './lib/jackett.js';
import * as jackettio from './lib/jackettio.js';
import { cleanTorrentFolder, createTorrentFolder } from './lib/torrentInfos.js';

// Load environment variables from .env file
dotenv.config();

// Get the current file URL and derive the directory path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const converter = new showdown.Converter();
const welcomeMessageHtml = config.welcomeMessage ? `${converter.makeHtml(config.welcomeMessage)}<div class="my-4 border-top border-secondary-subtle"></div>` : '';

// Corrected the path to the package.json file
const addon = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
// Use the ADDON_NAME environment variable, defaulting to the original name if not set
addon.name = process.env.ADDON_NAME || 'HYJackettio';

// Corrected the path to the configure.html file in the /src/template/ directory
const configure = fs.readFileSync(path.join(__dirname, 'template', 'configure.html'), 'utf-8');

const app = express();

const respond = (res, data) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/json');
  res.send(data);
};

app.set('trust proxy', config.trustProxy);

app.use((req, res, next) => {
  req.clientIp = req.ip;
  if (req.get('CF-Connecting-IP')) {
    req.clientIp = req.get('CF-Connecting-IP');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'static')));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path.replace(/\/eyJ[\w\=]+/g, '/*******************')}`);
  next();
});

app.get('/', (req, res) => {
  res.redirect('/configure');
  res.end();
});

app.get('/:userConfig?/configure', async (req, res) => {
  let indexers = (await getIndexers().catch(() => []))
    .map(indexer => ({
      value: indexer.id,
      label: indexer.title,
      types: ['movie', 'series'].filter(type => indexer.searching[type].available)
    }));
  const templateConfig = {
    debrids: await debrid.list(),
    addon: {
      version: addon.version,
      name: addon.name.charAt(0).toUpperCase() + addon.name.slice(1)
    },
    userConfig: req.params.userConfig || '',
    defaultUserConfig: config.defaultUserConfig,
    qualities: config.qualities,
    languages: config.languages.map(l => ({ value: l.value, label: l.label })).filter(v => v.value != 'multi'),
    sorts: config.sorts,
    indexers,
    passkey: { required: false },
    immulatableUserConfigKeys: config.immulatableUserConfigKeys
  };
  if (config.replacePasskey) {
    templateConfig.passkey = {
      required: true,
      infoUrl: config.replacePasskeyInfoUrl,
      pattern: config.replacePasskeyPattern
    }
  }
  let template = configure.toString()
    .replace('/** import-config */', `const config = ${JSON.stringify(templateConfig, null, 2)}`)
    .replace('<!-- welcome-message -->', welcomeMessageHtml);
  return res.send(template);
});

// https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/advanced.md#using-user-data-in-addons
app.get("/:userConfig?/manifest.json", async (req, res) => {
  const manifest = {
    id: config.addonId,
    version: addon.version,
    name: addon.name,
    description: addon.description,
    icon: "https://avatars.githubusercontent.com/u/15383019?s=48&v=4",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: { configurable: true }
  };
  if (req.params.userConfig) {
    const userConfig = JSON.parse(atob(req.params.userConfig));
    const debridInstance = debrid.instance(userConfig);
    manifest.name += ` ${debridInstance.shortName}`;
  }
  respond(res, manifest);
});

app.get("/:userConfig/stream/:type/:id.json", async (req, res) => {
  try {
    const streams = await jackettio.getStreams(
      Object.assign(JSON.parse(atob(req.params.userConfig)), { ip: req.clientIp }),
      req.params.type,
      req.params.id,
      `${req.hostname == 'localhost' ? 'http' : 'https'}://${req.hostname}`
    );

    // Enhancing aesthetics of the stream data
    const enhancedStreams = streams.map(stream => ({
      ...stream,
      name: `${stream.name} - ${formatSize(stream.size)} 💾`,
      title: `
        <div>
          <strong>${stream.title}</strong>
          <div>💾 Size: ${formatSize(stream.size)}</div>
          <div>👤 Seeders: ${stream.seeders}</div>
          <div>🌐 Language: ${stream.language}</div>
        </div>
      `,
      tag: `<div style="color: green;">${stream.tag}</div>`
    }));

    return respond(res, { streams: enhancedStreams });
  } catch (err) {
    console.log(err);
    return respond(res, { streams: [] });
  }
});

app.get('/:userConfig/download/:type/:id/:torrentId', async (req, res) => {
  try {
    const url = await jackettio.getDownload(
      Object.assign(JSON.parse(atob(req.params.userConfig)), { ip: req.clientIp }),
      req.params.type,
      req.params.id,
      req.params.torrentId
    );

    const parsed = new URL(url);
    const cut = (value) => value ? `${value.substr(0, 5)}******${value.substr(-5)}` : '';
    console.log(`Redirect: ${parsed.protocol}//${parsed.host}${cut(parsed.pathname)}${cut(parsed.search)}`);

    res.redirect(url);
    res.end();
  } catch (err) {
    console.log(err);

    switch (err.message) {
      case debrid.ERROR.NOT_READY:
        res.redirect(`/videos/not_ready.mp4`);
        res.end();
        break;
      case debrid.ERROR.EXPIRED_API_KEY:
        res.redirect(`/videos/expired_api_key.mp4`);
        res.end();
        break;
      case debrid.ERROR.NOT_PREMIUM:
        res.redirect(`/videos/not_premium.mp4`);
        res.end();
        break;
      default:
        res.redirect(`/videos/error.mp4`);
        res.end();
    }
  }
});

// Ensure /tmp/torrents directory exists
const ensureTorrentFolderExists = () => {
  const torrentFolderPath = '/tmp/torrents';
  if (!fs.existsSync(torrentFolderPath)) {
    fs.mkdirSync(torrentFolderPath, { recursive: true });
    console.log(`Created directory: ${torrentFolderPath}`);
  }
};

ensureTorrentFolderExists();

// Error handling middleware for 404 (Not Found) and 500 (Internal Server Error)
app.use((req, res) => {
  if (req.xhr) {
    res.status(404).send({ error: 'Page not found!' });
  } else {
    res.status(404).send('Page not found!');
  }
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  if (req.xhr) {
    res.status(500).send({ error: 'Something broke!' });
  } else {
    res.status(500).send('Something broke!');
  }
});

const server = app.listen(config.port, async () => {
  console.log('───────────────────────────────────────');
  console.log(`Started addon ${addon.name} v${addon.version}`);
  console.log(`Server listen at: http://localhost:${config.port}`);
  console.log('───────────────────────────────────────');

  let tunnel;
  if (config.localtunnel) {
    let subdomain = await cache.get('localtunnel:subdomain');
    tunnel = await localtunnel({ port: config.port, subdomain });
    await cache.set('localtunnel:subdomain', tunnel.clientId, { ttl: 86400 * 365 });
    console.log(`Your addon is available on the following address: ${tunnel.url}/configure`);
    tunnel.on('close', () => console.log("Tunnels are closed"));
  }

  createTorrentFolder();
  let cleanTorrentFolderInterval = setInterval(cleanTorrentFolder, 3600e3);

  function closeGracefully(signal) {
    console.log(`Received signal to terminate: ${signal}`);
    if (tunnel) tunnel.close();
    clearInterval(cleanTorrentFolderInterval);
    server.close(() => {
      console.log('Server closed');
      process.kill(process.pid, signal);
    });
  }
  process.once('SIGINT', closeGracefully);
  process.once('SIGTERM', closeGracefully);
});

function formatSize(bytes) {
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  if (bytes == 0) return '0 Byte';
  const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
  return Math.round(bytes / Math.pow(1024, i), 2) + ' ' + sizes[i];
}
