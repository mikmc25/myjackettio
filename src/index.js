import showdown from 'showdown';
import compression from 'compression';
import express from 'express';
import localtunnel from 'localtunnel';
import { rateLimit } from 'express-rate-limit';
import { readFileSync } from "fs";
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import config from './lib/config.js';
import cache, { vacuum as vacuumCache, clean as cleanCache } from './lib/cache.js';
import * as icon from './lib/icon.js';
import * as debrid from './lib/debrid.js';
import { getIndexers } from './lib/jackett.js';
import * as jackettio from './lib/jackettio.js';
import { cleanTorrentFolder, createTorrentFolder, getTorrentFile } from './lib/torrentInfos.js';
import redisClient from './redisClient.js'; // Import the Redis client

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const converter = new showdown.Converter();
const welcomeMessageHtml = config.welcomeMessage ? `${converter.makeHtml(config.welcomeMessage)}<div class="my-4 border-top border-secondary-subtle"></div>` : '';
const addon = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
const app = express();

const respond = (res, data) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/json');
  res.send(data);
};

const limiter = rateLimit({
  windowMs: config.rateLimitWindow * 1000,
  max: config.rateLimitRequest,
  legacyHeaders: false,
  standardHeaders: 'draft-7',
  keyGenerator: (req) => req.clientIp || req.ip,
  handler: (req, res, next, options) => {
    if (req.route.path == '/:userConfig/stream/:type/:id.json') {
      const resetInMs = new Date(req.rateLimit.resetTime) - new Date();
      return res.json({ streams: [{
        name: `${config.addonName}`,
        title: `🛑 Too many requests, please try in ${Math.ceil(resetInMs / 1000 / 60)} minute(s).`,
        url: '#'
      }] });
    } else {
      return res.status(options.statusCode).send(options.message);
    }
  }
});

app.set('trust proxy', config.trustProxy);

app.use((req, res, next) => {
  req.clientIp = req.ip;
  if (req.get('CF-Connecting-IP')) {
    req.clientIp = req.get('CF-Connecting-IP');
  }
  next();
});

app.use(compression());
app.use(express.static(path.join(__dirname, 'static'), { maxAge: 86400e3 }));

app.get('/', (req, res) => {
  res.redirect('/configure');
  res.end();
});

app.get('/icon', async (req, res) => {
  const filePath = await icon.getLocation();
  res.contentType(path.basename(filePath));
  res.setHeader('Cache-Control', `public, max-age=${3600}`);
  return res.sendFile(filePath);
});

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path.replace(/\/eyJ[\w\=]+/g, '/*******************')}`);
  next();
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
      name: config.addonName
    },
    userConfig: req.params.userConfig || '',
    defaultUserConfig: config.defaultUserConfig,
    qualities: config.qualities,
    languages: config.languages.map(l => ({ value: l.value, label: l.label })).filter(v => v.value != 'multi'),
    sorts: config.sorts,
    indexers,
    passkey: { enabled: false },
    immulatableUserConfigKeys: config.immulatableUserConfigKeys
  };
  if (config.replacePasskey) {
    templateConfig.passkey = {
      enabled: true,
      infoUrl: config.replacePasskeyInfoUrl,
      pattern: config.replacePasskeyPattern
    };
  }
  let template = readFileSync(path.join(__dirname, 'template', 'configure.html'), 'utf-8')
    .replace('/** import-config */', `const config = ${JSON.stringify(templateConfig, null, 2)}`)
    .replace('<!-- welcome-message -->', welcomeMessageHtml);
  return res.send(template);
});

app.get("/:userConfig?/manifest.json", async (req, res) => {
  const manifest = {
    id: config.addonId,
    version: addon.version,
    name: config.addonName,
    description: config.addonDescription,
    icon: `${req.hostname == 'localhost' ? 'http' : 'https'}://${req.hostname}/icon`,
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

const streamTemplate = (stream, type, hostname) => ({
  name: config.addonName,
  title: stream.title || (type === 'movie' ? 'HD Movie' : 'HD Series'),
  description: stream.description || `Stream from ${config.addonName}`,
  logo: stream.logo || `${hostname == 'localhost' ? 'http' : 'https'}://${hostname}/icon`,
  background: stream.background || `${hostname == 'localhost' ? 'http' : 'https'}://${hostname}/background.jpg`,
  type: stream.type || type,
  infoHash: stream.infoHash,
  fileIdx: stream.fileIdx,
  isFree: stream.isFree !== undefined ? stream.isFree : true,
  externalUrl: stream.externalUrl,
  subtitles: stream.subtitles || [],
  behaviorHints: {
    playerAutoLaunch: true,
    notWebReady: false,
    ...stream.behaviorHints
  }
});

app.get("/:userConfig/stream/:type/:id.json", limiter, async (req, res) => {
  try {
    const rawStreams = await jackettio.getStreams(
      Object.assign(JSON.parse(atob(req.params.userConfig)), { ip: req.clientIp }),
      req.params.type,
      req.params.id,
      `${req.hostname == 'localhost' ? 'http' : 'https'}://${req.hostname}`
    );

    // Example Redis usage: set and get a value
    await redisClient.set('last_stream', JSON.stringify({ type: req.params.type, id: req.params.id }));
    const lastStream = await redisClient.get('last_stream');
    console.log('Last stream:', lastStream);

    const streams = rawStreams.map(stream => streamTemplate(stream, req.params.type, req.hostname));

    return respond(res, { streams });
  } catch (err) {
    console.log(req.params.id, err);
    return respond(res, { streams: [] });
  }
});

app.get("/stream/:type/:id.json", async (req, res) => {
  return respond(res, { streams: [{
    name: config.addonName,
    title: `ℹ Kindly configure this addon to access streams.`,
    url: '#'
  }] });
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
    console.log(`${req.params.id} : Redirect: ${parsed.protocol}//${parsed.host}${cut(parsed.pathname)}${cut(parsed.search)}`);

    res.redirect(url);
    res.end();
  } catch (err) {
    console.log(req.params.id, err);

    switch (err.message) {
      case debrid.ERROR.NOT_READY:
        res.redirect(`/videos/not_ready.mp4`);
        res.end();
        break;
      case debrid.ERROR.EXPIRED_API_KEY:
        res.redirect(`/videos/expired_api_key.mp4`);
        res.end();
        break;
      default:
        res.redirect(`/videos/not_available.mp4`);
        res.end();
        break;
    }
  }
});

app.get('/videos/:name.mp4', async (req, res) => {
  return res.sendFile(path.join(__dirname, 'videos', `${req.params.name}.mp4`));
});

// regularly remove torrents to keep within the file number limit on the free plan
setInterval(() => {
  cleanTorrentFolder();
}, 3600e3 * 2).unref();

if (config.vacuumCacheInterval) {
  setInterval(vacuumCache, config.vacuumCacheInterval).unref();
}

// clean cache if 3 days old
setInterval(() => {
  cleanCache(3 * 24 * 60 * 60 * 1000);
}, 6 * 60e3).unref();

createTorrentFolder();

app.listen(config.port, async () => {
  console.log(`Addon active on port ${config.port}`);
  if (config.localtunnel) {
    const tunnel = await localtunnel({ port: config.port });
    console.log(`Add-on public url: ${tunnel.url}`);
    tunnel.on('close', () => {
      console.log('Tunnel closed');
    });
  }
});
