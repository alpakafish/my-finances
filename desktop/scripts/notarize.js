// electron-builder afterSign hook. Runs `xcrun notarytool` via @electron/notarize.
// No-ops locally when Apple credentials aren't set (see README "Apple Signing"),
// so `npm run dist` still produces an unsigned dev build without them.
const { notarize } = require('@electron/notarize');

module.exports = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] Apple credentials not set — skipping notarization (unsigned/dev build).');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  console.log(`[notarize] Submitting ${appName} for notarization...`);

  await notarize({
    appBundleId: 'com.alpakafish.myfinances',
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log('[notarize] Done — ticket stapled by electron-builder.');
};
