/**
 * PM2 ecosystem config for theorchestra production supervision.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 status
 *   pm2 logs <app-name>
 *   pm2 save                   # persist across reboot
 *   pm2 startup                # generate OS init-script (follow the output)
 *
 * The telegram-streamer, omni-watcher, and dashboard-server can each run
 * under PM2 independently. The OmniClaude orchestrator pane itself runs in
 * WezTerm under `scripts/omniclaude-forever.sh`, NOT under PM2 — its lifecycle
 * is owned by the human via the WezTerm GUI. PM2 only manages the headless
 * side processes.
 *
 * All three processes restart on crash with exponential backoff. Log files
 * live in `~/.pm2/logs/<name>-{out|error}.log` by default.
 */
module.exports = {
  apps: [
    {
      name: 'theorchestra-streamer',
      script: 'src/telegram-streamer.cjs',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 3000,
      max_restarts: 20,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'theorchestra-dashboard',
      script: 'src/dashboard-server.cjs',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 3000,
      max_restarts: 20,
      env: {
        NODE_ENV: 'production',
        DASHBOARD_PORT: '4200',
      },
    },
    // Note: omni-watcher is typically owned by OmniClaude's Monitor tool,
    // NOT by PM2. Uncomment this block if you want a headless watcher
    // independent of any Claude Code session (e.g. for dashboard-only use).
    //
    // {
    //   name: 'theorchestra-watcher',
    //   script: 'src/omni-watcher.cjs',
    //   autorestart: true,
    //   watch: false,
    //   max_memory_restart: '256M',
    //   restart_delay: 5000,
    //   max_restarts: 20,
    // },
  ],
};
