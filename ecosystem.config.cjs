module.exports = {
  apps: [{
    name: "yolow",
    cwd: __dirname,
    script: "src/main.ts",
    interpreter: "node",
    node_args: "--env-file=.env --experimental-transform-types",
    autorestart: true,
    restart_delay: 5000,
    max_restarts: 10,
    time: true,
  }],
};
