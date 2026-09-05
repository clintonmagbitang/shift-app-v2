const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
(async () => {
  const config = require('./v2-config')();
  const client = new Client({ connectionString: config.DATABASE_URL });
  try {
    await client.connect();
    for (const file of fs.readdirSync(path.join(__dirname, '../migrations')).filter(file => file.endsWith('.sql')).sort()) {
      await client.query(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
    }
    console.log('V2 Advances migration applied.');
  } finally { await client.end(); }
})().catch(() => { console.error('V2 migration failed. Check the separate branch configuration and database access.'); process.exitCode = 1; });
