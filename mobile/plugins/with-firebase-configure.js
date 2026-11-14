// Makes Firebase work on iOS with Expo SDK 58.
//
// 1. Starts Firebase at launch. @react-native-firebase/app normally adds `FirebaseApp.configure()` to AppDelegate.swift, but the SDK 58
//    template no longer has the line it looks for (React Native is started by SceneDelegate), so it skips it with a warning and the app dies
//    with "No Firebase App '[DEFAULT]' has been created". This adds the call itself, and does nothing if it is already there.
// 2. Registers the URL scheme that phone sign-in's reCAPTCHA fallback needs. The plugin takes it from REVERSED_CLIENT_ID, which only exists
//    in GoogleService-Info.plist when Google Sign-In is enabled. Without it iOS kills the app as soon as an OTP is requested. Firebase also
//    accepts the "encoded app ID" scheme (app-1-<number>-ios-<hash>), which is always in the file (GOOGLE_APP_ID), so we use that.
const { withDangerousMod, withInfoPlist, IOSConfig } = require('@expo/config-plugins');
const fs = require('fs');
const nodePath = require('path');

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

// 3. Gives Firebase the reCAPTCHA return link. Under iOS's scene life cycle the link arrives in SceneDelegate, and Expo's SceneDelegate only
//    passes it to JavaScript, so Firebase never sees it and phone sign-in never finishes. Firebase's documented fix for scene-based apps is
//    to ask Auth.auth().canHandle(url) first; links Firebase takes are not passed on.
function addSceneUrlHandling(contents) {
  if (contents.includes('canHandle(')) return contents;
  const marker = '// Extension point for config plugins.';
  if (!contents.includes(marker) || !/class SceneDelegate\s*:\s*ExpoAppSceneDelegate/.test(contents)) {
    throw new Error('with-firebase-configure: SceneDelegate.swift has an unexpected layout; cannot add the Firebase URL handling');
  }
  let out = contents.replace(/^(internal import Expo|import Expo)\s*$/m, '$1\nimport UIKit\nimport FirebaseAuth');
  out = out.replace(
    marker,
    `${marker}
  override func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    // Firebase phone sign-in returns from its reCAPTCHA page through a link that only Firebase can handle.
    var rest = Set<UIOpenURLContext>()
    for context in URLContexts where !Auth.auth().canHandle(context.url) { rest.insert(context) }
    if !rest.isEmpty { super.scene(scene, openURLContexts: rest) }
  }`
  );
  return out;
}

/** "1:123456:ios:abcdef" -> "app-1-123456-ios-abcdef" */
function encodedAppIdScheme(plistText) {
  const m = /<key>GOOGLE_APP_ID<\/key>\s*<string>([^<]+)<\/string>/.exec(plistText);
  return m ? 'app-' + m[1].trim().replace(/:/g, '-') : null;
}

function addUrlScheme(infoPlist, scheme) {
  const types = (infoPlist.CFBundleURLTypes = infoPlist.CFBundleURLTypes ?? []);
  if (!types.some((t) => (t.CFBundleURLSchemes ?? []).includes(scheme))) types.push({ CFBundleURLSchemes: [scheme] });
  return infoPlist;
}

module.exports = (config) => {
  config = withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const { path } = IOSConfig.Paths.getAppDelegate(cfg.modRequest.projectRoot);
      fs.writeFileSync(path, addFirebaseConfigure(fs.readFileSync(path, 'utf8')));
      const scenePath = nodePath.join(nodePath.dirname(path), 'SceneDelegate.swift');
      fs.writeFileSync(scenePath, addSceneUrlHandling(fs.readFileSync(scenePath, 'utf8')));
      return cfg;
    },
  ]);
  return withInfoPlist(config, (cfg) => {
    const file = cfg.ios?.googleServicesFile;
    if (!file) return cfg;
    const scheme = encodedAppIdScheme(fs.readFileSync(nodePath.resolve(cfg.modRequest.projectRoot, file), 'utf8'));
    if (!scheme) throw new Error('with-firebase-configure: GOOGLE_APP_ID not found in GoogleService-Info.plist');
    addUrlScheme(cfg.modResults, scheme);
    return cfg;
  });
};
module.exports.addFirebaseConfigure = addFirebaseConfigure;
module.exports.addSceneUrlHandling = addSceneUrlHandling;
module.exports.encodedAppIdScheme = encodedAppIdScheme;
module.exports.addUrlScheme = addUrlScheme;
