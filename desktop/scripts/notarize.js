// electron-builder afterSign hook.
//
// Without a real Developer ID cert (CSC_LINK unset), electron-builder skips
// its own signing step entirely ("cannot find valid identity") and leaves
// whatever partial signature Electron's prebuilt binaries already carried —
// which does NOT cover the resources electron-builder just assembled
// (icon, extraResources, Info.plist edits, etc). `codesign --verify --deep
// --strict` on a build like that fails with "code has no resources but
// signature indicates they must be present", and a real user who downloads
// it (which sets the com.apple.quarantine xattr and triggers full Gatekeeper
// assessment) gets the non-bypassable "My Finances.app is damaged and can't
// be opened" dialog instead of the expected/documented bypassable
// "unidentified developer" one. A local unquarantined build never hits that
// full assessment, so this was invisible in dev.
//
// Fix: explicitly re-sign the fully assembled bundle ourselves with a fresh,
// consistent ad-hoc signature (`codesign --deep --force --sign -`) whenever
// electron-builder didn't already do a real signature. Ad-hoc + unnotarized
// still shows a Gatekeeper warning on a quarantined download, but the
// bypassable one README documents (Control-click → Open) — not "damaged".
const { notarize } = require('@electron/notarize');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const execFileAsync = promisify(execFile);

module.exports = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  if (!process.env.CSC_LINK) {
    const entitlements = path.join(__dirname, '..', 'build', 'entitlements.mac.plist');
    console.log(`[sign] No CSC_LINK — re-signing ${appName}.app ad-hoc so resources are sealed consistently.`);
    // No --options runtime here: hardened runtime enforces library validation
    // (loaded frameworks must share the main executable's Team ID), but a
    // --deep ad-hoc sign gives every nested framework/helper its own
    // independent ad-hoc identity with no team at all — dyld then refuses to
    // load them ("different Team IDs"), the app launches to nothing. Hardened
    // runtime only matters for notarization (which needs a real cert anyway),
    // so skip it entirely for the unsigned/ad-hoc dev path.
    await execFileAsync('codesign', [
      '--deep',
      '--force',
      '--sign', '-',
      '--entitlements', entitlements,
      appPath,
    ]);
    console.log('[sign] Ad-hoc re-sign done.');
  }

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] Apple credentials not set — skipping notarization (unsigned/dev build).');
    return;
  }

  console.log(`[notarize] Submitting ${appName} for notarization...`);

  await notarize({
    appBundleId: 'com.alpakafish.myfinances',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log('[notarize] Done — ticket stapled by electron-builder.');
};
