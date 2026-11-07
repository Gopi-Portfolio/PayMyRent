// Local demo (EXPO_PUBLIC_AUTH_MODE=dev) runs in Expo Go, which can't load React Native Firebase.
// Drop the Firebase plugins/config in that mode; production builds (firebase mode) keep them.
module.exports = ({ config }) => {
  const mode = process.env.EXPO_PUBLIC_AUTH_MODE ?? 'dev';
  if (mode === 'dev') {
    config.plugins = (config.plugins ?? []).filter((p) => {
      const name = Array.isArray(p) ? p[0] : p;
      return !String(name).startsWith('@react-native-firebase');
    });
    if (config.ios) delete config.ios.googleServicesFile;
    if (config.android) delete config.android.googleServicesFile;
  }
  return config;
};
