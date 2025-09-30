module.exports = {
  apps: [{
    name: 'marathon-backend',
    script: './server.js',
    instances: 2,
    exec_mode: 'cluster',
    env: {
      PORT: 3001,
      NODE_ENV: 'production'
    },
    max_memory_restart: '1G',
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    merge_logs: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s'
  }]
};

