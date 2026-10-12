'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

async function startCAP({ buyerCanApprove = false, secondBuyer = false, failAuditAction, failExportJob = false } = {}) {
  const preload = `
    const cds = require('@sap/cds');
    if (${JSON.stringify(buyerCanApprove)}) cds.env.requires.auth.users.buyer.roles.push('Approver');
    if (${JSON.stringify(secondBuyer)}) cds.env.requires.auth.users.secondbuyer = {password:'demo',roles:['Buyer']};
    if (${JSON.stringify(failAuditAction || null)}) cds.on('served', () => {
      cds.db.before('CREATE', 'procurement.AuditEvents', req => {
        const entries = req.query?.INSERT?.entries || [req.data];
        if (entries.some(entry => entry?.action === ${JSON.stringify(failAuditAction || null)})) {
          const error = new Error('Injected audit storage failure'); error.statusCode = 500; throw error;
        }
      });
    });
    if (${JSON.stringify(failExportJob)}) cds.on('served', () => {
      cds.db.before('CREATE', 'procurement.ExportJobs', () => {
        const error = new Error('Injected outbox storage failure'); error.statusCode = 500; throw error;
      });
    });
    require('./server');
  `;
  const child = spawn(process.execPath, ['-e', preload], { cwd: root, windowsHide: true,
    env: { ...process.env, PORT: '0', NODE_ENV: 'test', CDS_ENV: 'test',
      CDS_REQUIRES_DB_CREDENTIALS_URL: ':memory:', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('CAP startup timeout:\n' + output)); }, 25000);
    const receive = data => {
      output += data.toString();
      const match = /WORKBENCH_READY (http:\/\/127\.0\.0\.1:\d+)\/workbench\//.exec(output);
      if (match) { clearTimeout(timeout); resolve(match[1] + '/odata/v4/procurement'); }
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`CAP exited ${code}:\n${output}`)); });
  });

  return {
    url,
    logs: () => output,
    async request(endpoint, { user = 'buyer', method = 'GET', body, headers = {} } = {}) {
      const response = await fetch(url + endpoint, { method,
        headers: { ...(user ? { Authorization: 'Basic ' + Buffer.from(user + ':demo').toString('base64') } : {}),
          Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
      return { status: response.status, data };
    },
    async close() {
      if (child.exitCode !== null) return;
      await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    }
  };
}

module.exports = { startCAP };
