'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  const providersPath = path.join(dir, 'providers.json');
  let config = readJson(configPath);
  let providers = readJson(providersPath) || [];

  return {
    getConfig: () => config,
    setConfig(value) {
      config = value;
      writeAtomic(configPath, value);
    },
    clearConfig() {
      config = null;
      fs.rmSync(configPath, { force: true });
    },
    getProviders: () => providers,
    setProviders(value) {
      providers = value;
      writeAtomic(providersPath, value);
    },
  };
}

module.exports = { createStore };
