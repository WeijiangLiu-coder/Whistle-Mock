const { loadConfig } = require('./config');
const { createApp } = require('./createApp');

const config = loadConfig();
const app = createApp({ mode: 'standalone' });

app.listen(config.port, () => {
  console.log(`Whistle Mock 独立模式: http://127.0.0.1:${config.port}`);
  console.log(`mockRoot: ${config.mockRoot}`);
  console.log(`ruleGroup: ${config.ruleGroup}`);
  console.log('提示：推荐用插件模式，执行 npm run plugin:link 后在 Whistle → Plugins / Tools → Mock 打开');
});
