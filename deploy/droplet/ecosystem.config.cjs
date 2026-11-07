// pm2 process for the Atelier API on the Droplet (see deploy/droplet/README.md).
// /srv/atelier/current points at the live release; backend/.env in each release
// links to /srv/atelier/shared/backend.env (index.mjs loads it with dotenv).
module.exports = {
  apps: [
    {
      name: 'atelier-api',
      cwd: '/srv/atelier/current/backend',
      script: 'index.mjs',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '600M',
      time: true,
    },
  ],
}
