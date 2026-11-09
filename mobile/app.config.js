// Local demo (EXPO_PUBLIC_AUTH_MODE=dev) runs in Expo Go, which can't load React Native Firebase.
// Drop the Firebase plugins/config in that mode; production builds (firebase mode) keep them.
//
// The Firebase files (GoogleService-Info.plist, google-services.json) are git-ignored, and EAS Build only uploads files
// that git tracks. So on EAS they come in as "file" environment variables (see docs/BUILD.md):
//   eas env:create --name GOOGLE_SERVICES_PLIST --type file --visibility secret --value ./GoogleService-Info.plist
//   eas env:create --name GOOGLE_SERVICES_JSON  --type file --visibility secret --value ./google-services.json
// When those are not set (a build on your own machine), the local files named in app.json are used.
module.exports = ({ config }) => {
  const mode = process.env.EXPO_PUBLIC_AUTH_MODE ?? 'dev';
  if (mode === 'dev') {
    config.plugins = (config.plugins ?? []).filter((p) => {
      const name = Array.isArray(p) ? p[0] : p;
      return !String(name).startsWith('@react-native-firebase');
    });
    if (config.ios) delete config.ios.googleServicesFile;
    if (config.android) delete config.android.googleServicesFile;
  } else {
    if (config.ios && process.env.GOOGLE_SERVICES_PLIST) config.ios.googleServicesFile = process.env.GOOGLE_SERVICES_PLIST;
    if (config.android && process.env.GOOGLE_SERVICES_JSON) config.android.googleServicesFile = process.env.GOOGLE_SERVICES_JSON;
  }
  return config;
};
