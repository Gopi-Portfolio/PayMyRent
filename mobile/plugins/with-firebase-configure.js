// Starts Firebase when the iOS app launches.
// @react-native-firebase/app normally adds `FirebaseApp.configure()` to AppDelegate.swift, but the Expo SDK 58 template no longer has the
// line it looks for (React Native is started by SceneDelegate), so it skips it with a warning and the app dies with
// "No Firebase App '[DEFAULT]' has been created". This plugin adds the call itself, and does nothing if it is already there.
const { withDangerousMod, IOSConfig } = require('@expo/config-plugins');
const fs = require('fs');

function addFirebaseConfigure(contents) {
  if (contents.includes('FirebaseApp.configure()')) return contents;
  let out = contents;
  if (!out.includes('import FirebaseCore')) out = out.replace(/^(internal import Expo|import Expo)\s*$/m, '$1\nimport FirebaseCore');
  const anchor = /^(\s*)let delegate = ReactNativeDelegate\(\)/m;
  if (!anchor.test(out) || !out.includes('import FirebaseCore')) {
    throw new Error('with-firebase-configure: AppDelegate.swift has an unexpected layout; cannot add FirebaseApp.configure()');
  }
  return out.replace(anchor, '$1FirebaseApp.configure()\n$1let delegate = ReactNativeDelegate()');
}

module.exports = (config) =>
  withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const { path } = IOSConfig.Paths.getAppDelegate(cfg.modRequest.projectRoot);
      fs.writeFileSync(path, addFirebaseConfigure(fs.readFileSync(path, 'utf8')));
      return cfg;
    },
  ]);
module.exports.addFirebaseConfigure = addFirebaseConfigure;
