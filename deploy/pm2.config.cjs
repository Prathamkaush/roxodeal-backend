module.exports = {
  apps: [{
    name: "mandisetu-api",
    cwd: require("node:path").resolve(__dirname, ".."),
    script: "dist/main.js",
    env: { NODE_ENV: "production", PORT: 4000 },
  }],
};
