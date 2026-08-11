const { createApp } = require('../server/createApp');

/**
 * Whistle 插件 UI Server
 * 页面入口：Plugins 列表点开，或 Tools → Mock
 * URL 形如：http://127.0.0.1:8899/whistle.mock-console/
 */
module.exports = (server /*, options */) => {
  const app = createApp({ mode: 'plugin' });
  server.on('request', app);
};
