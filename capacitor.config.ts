import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'chat.quad.messenger',
  appName: 'Terminal',
  webDir: 'dist',
  backgroundColor: '#0a0d10',
  server: {
    androidScheme: 'https',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#0a0d10',
  },
  ios: {
    contentInset: 'never',
    backgroundColor: '#0a0d10',
  },
  plugins: {
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0a0d10',
      overlaysWebView: false,
    },
  },
};

export default config;
