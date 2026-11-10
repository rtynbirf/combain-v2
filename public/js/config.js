// public/js/config.js
// COMBAIN v2 — frontend configuration

const CONFIG = {
  BASE_URL: location.protocol === 'file:'
    ? 'http://localhost:3000'
    : location.origin,

  WS_URL: '',

  RECONNECT_DELAY: 3000,
  RECONNECT_MAX: 30000,

  TYPING_DEBOUNCE: 2000,
  TYPING_STOP_DELAY: 3000,

  MESSAGE_LOAD_COUNT: 50,

  MAX_FILE_SIZE: 52428800, // 50 MB
};

CONFIG.WS_URL = CONFIG.BASE_URL.replace(/^http/, 'ws') + '/ws';
