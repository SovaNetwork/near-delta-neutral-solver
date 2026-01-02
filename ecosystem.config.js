module.exports = {
    apps: [{
        name: "near-delta-neutral-solver",
        script: "./dist/src/app.js", // Points to the built file
        env: {
            NODE_ENV: "production",
        },
        // Reliability features
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '1G',
        exp_backoff_restart_delay: 100,
        // Logging
        log_date_format: "YYYY-MM-DD HH:mm:ss Z",
        error_file: "./logs/error.log",
        out_file: "./logs/output.log",
        merge_logs: true,
    }]
};
