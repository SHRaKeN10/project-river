// Expo app config. The API/socket host is resolved here so every build and OTA
// update points at the deployed server by default - a tester's phone must never
// fall back to `localhost` (which would be the phone itself).
//
//   - shipped default:      https://project-river-nick.fly.dev
//   - eas build/update:     EXPO_PUBLIC_API_URL from eas.json / shell wins
//   - local device testing: put EXPO_PUBLIC_API_URL=http://<your-lan-ip>:3000
//                           in apps/mobile/.env

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://project-river-nick.fly.dev';
const SOCKET_URL = process.env.EXPO_PUBLIC_SOCKET_URL ?? API_URL;

module.exports = {
  expo: {
    name: 'Project River',
    slug: 'project-river',
    scheme: 'river',
    version: '0.1.0',
    orientation: 'portrait',
    userInterfaceStyle: 'dark',
    newArchEnabled: true,
    assetBundlePatterns: ['**/*'],
    ios: { supportsTablet: false, bundleIdentifier: 'com.projectriver.app' },
    android: { package: 'com.projectriver.app' },
    extra: {
      apiBaseUrl: API_URL,
      socketUrl: SOCKET_URL,
    },
  },
};
