// Log directory - use LOGS_DIR env var or default to /data/logs for EC2
const logsDir = process.env.LOGS_DIR || '/data/logs';

module.exports = {
    apps: [{
        name: "sova-delta-neutral-solver",
        script: "./dist/src/app.js", // Points to the built file
        env: {
            NODE_ENV: "production",
            LOGS_DIR: logsDir,  // Pass to app for trades.jsonl and positions.jsonl
        },
        // Reliability features
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '1G',
        exp_backoff_restart_delay: 100,
        // Logging - persist to /data/logs so they survive restarts
        log_date_format: "YYYY-MM-DD HH:mm:ss Z",
        error_file: `${logsDir}/pm2-error.log`,
        out_file: `${logsDir}/pm2-output.log`,
        combine_logs: true,  // Combine logs from all instances
        merge_logs: true,
    }]
};

// To enable log rotation, install pm2-logrotate:
//   pm2 install pm2-logrotate
//   pm2 set pm2-logrotate:max_size 50M
//   pm2 set pm2-logrotate:retain 5
//   pm2 set pm2-logrotate:compress true
