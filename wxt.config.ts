import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'YouTube 双语字幕',
    description: '实时抓取 YouTube 字幕轨并翻译，中英双语叠加显示，支持直播与回放。',
    version: '0.1.0',
    permissions: [
      'storage',
      'tabCapture',
      'offscreen',
      'cookies',
      'nativeMessaging',
      'activeTab',
      'scripting',
      'notifications',
    ],
    // 固定扩展 ID（否则每次加载路径不同，Native Messaging 的 allowed_origins 对不上）
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx40X3Hyj/IhL1+RuFJ3+7vCnS99uNEy+IV+9dfDx9NW+Sl93jr7nmg/CPK65aNT0x+iUiz2+0jX02yXBSX7Ov/2Y0c4pD28krMxg9e6v9PKNJ4RXulprKwRziWyOpB+gTyCs8Q9UvaMPfZnTqdYPQBJdoWFqOWZALs8zQX7CaRWxDz8y3COvV7eRT4HRfFvQ4tkPIO5gNvcQsdXNxDcNBvOl7wl7syqtOvYgHZef9/jyu3cbh7dp5VexM+5fGiJpIXva+r6ZDA4COocT+2I/I6rQYtgfBMeBj7LLh1RFK8+qQIyQ0euZPIgRsghxIvKPOa6jcZnDcIXy4IH7CiwylQIDAQAB',
    // 字幕抓取在页面内完成，翻译请求由 background 发出。
    // 自定义 LLM 端点需要任意 https 权限，个人使用故直接放开。
    // 含 http://*/* ：本地模型（Ollama / LM Studio 等）走的是 http，缺了会直接 fetch 失败
    host_permissions: ['https://www.youtube.com/*', 'https://*/*', 'http://*/*'],
    icons: {
      '16': 'icon/16.png',
      '48': 'icon/48.png',
      '128': 'icon/128.png',
    },
  },

  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
