'use strict';

const path = require('node:path');
const fs = require('node:fs');
const cds = require('@sap/cds');
const target = path.join(__dirname, '..', 'runtime', 'procurement.sqlite');

async function main() {
  if (fs.existsSync(target)) {
    throw new Error('The demo database already exists. Initialization refused to preserve your saved work.');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await cds.deploy('*').to(`sqlite:${target}`);
  await cds.disconnect();
  console.log('Initialized the fictional procurement data. Run npm start.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
