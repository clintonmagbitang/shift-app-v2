const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
module.exports = function loadV2() {
  const root = path.join(__dirname, '..');
  const file = path.join(root, '.env.v2');
  const hosted = process.env.NODE_ENV === 'production';
  if (!hosted && !fs.existsSync(file)) throw new Error('Create .env.v2 with the separate development branch DATABASE_URL and JWT_SECRET first.');
  const config = hosted ? {
    DATABASE_URL: process.env.DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET,
    PORT: process.env.PORT,
    V2_DATABASE_HOST: process.env.V2_DATABASE_HOST
  } : dotenv.parse(fs.readFileSync(file));
  if (!config.DATABASE_URL || !config.JWT_SECRET) throw new Error('.env.v2 needs DATABASE_URL and JWT_SECRET.');
  const original = fs.existsSync(path.join(root, '.env')) ? dotenv.parse(fs.readFileSync(path.join(root, '.env'))) : {};
  const target = new URL(config.DATABASE_URL);
  if (hosted && (!config.V2_DATABASE_HOST || target.hostname !== config.V2_DATABASE_HOST)) {
    throw new Error('Hosted V2 database endpoint must match V2_DATABASE_HOST.');
  }
  if (original.DATABASE_URL) {
    const source = new URL(original.DATABASE_URL);
    const host = url => url.hostname.replace('-pooler.', '.');
    if (host(source) === host(target)) throw new Error('V2 must use a separate database endpoint from .env.');
  }
  return { ...config, PORT: config.PORT || '4001', V2_ADVANCES_ENABLED: 'true' };
};
