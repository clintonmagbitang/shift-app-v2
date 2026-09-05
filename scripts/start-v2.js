try {
  Object.assign(process.env, require('./v2-config')());
  require('../index');
} catch { console.error('Cannot start V2. Check the V2 DATABASE_URL and JWT_SECRET configuration. Hosted deployments also require a matching V2_DATABASE_HOST.'); process.exitCode = 1; }
