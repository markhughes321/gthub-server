module.exports = {
  apps: [
    {
      name: "gthub-server",
      script: "node",
      args: "dist/index.js",
      cwd: "C:/Users/k-mark.hughes/Repos/gthub-server",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      min_uptime: "10s",
      env: {
        NODE_ENV: "production",
      },
      out_file: "logs/pm2-out.log",
      error_file: "logs/pm2-err.log",
      time: true,
    },
  ],
};
