'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');
const express = require('express');
const cds = require('@sap/cds');

// This deliverable intentionally uses named, public local-demo identities.
// Production deployment needs real identity, authorization and ERP bindings.
if (process.env.NODE_ENV === 'production') {
  throw new Error('This local portfolio edition cannot run in production with demo authentication.');
}

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  // A worker action must not join an OData atomicity group containing earlier
  // database writes. This local edition therefore supports individual requests.
  let requestPath = req.path;
  try {
    for (let depth = 0; depth < 4 && requestPath.includes('%'); depth++) {
      const decoded = decodeURIComponent(requestPath);
      if (decoded === requestPath) break;
      requestPath = decoded;
    }
  } catch (_) {
    return res.status(400).json({ error: { message: 'Invalid request path encoding.' } });
  }
  if (/(^|\/)\$batch(?:\/|$)/i.test(requestPath)) {
    return res.status(501).json({ error: { message: 'OData batch requests are unsupported. Send individual operations.' } });
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin && origin !== `http://${req.get('host')}`) {
      return res.status(403).json({ error: { message: 'Cross-origin writes are not accepted.' } });
    }
  }
  next();
});
const builtUI = path.join(__dirname, 'app', 'workbench', 'dist');
app.get('/', (_req, res) => res.redirect('/workbench/'));
app.use('/workbench', express.static(builtUI, { dotfiles: 'deny' }));
app.get('/workbench/', (_req, res) => res.status(503).type('text').send(
  'The UI has not been built yet. Run npm run build:ui, then refresh this page.'
));
const listen = app.listen.bind(app);
app.listen = port => listen(port, '127.0.0.1');

async function start() {
  const memory = cds.env.requires.db.credentials.url === ':memory:';
  if (!memory) fs.mkdirSync(path.join(__dirname, 'runtime'), { recursive: true });
  const server = await cds.server({
    app, port: Number(process.env.PORT ?? 4004),
    in_memory: memory, static: false, cors: false, index: false
  });
  if (!server.listening) await once(server, 'listening');
  console.log(`WORKBENCH_READY http://127.0.0.1:${server.address().port}/workbench/`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close(async () => {
      await cds.disconnect();
      process.exit(0);
    }));
  }
  return server;
}

module.exports = start().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
