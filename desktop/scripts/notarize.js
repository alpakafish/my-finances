// electron-builder afterSign hook.
//
// Without any usable signing identity, electron-builder skips its own
// signing step entirely ("cannot find valid identity") and leaves whatever
// partial signature Electron's prebuilt binaries already carried — which
// does NOT cover the resources electron-builder just assembled (icon,
// extraResources, Info.plist edits, etc). `codesign --verify --deep
// --strict` on a build like that fails with "code has no resources but
// signature indicates they must be present", and a real user who downloads
// it (which sets the com.apple.quarantine xattr and triggers full Gatekeeper
// assessment) gets the non-bypassable "My Finances.app is damaged and can't
// be opened" dialog instead of the expected/documented bypassable
// "unidentified developer" one. A local unquarantined build never hits that
// full assessment, so this was invisible in dev.
//
// We always sign the fully assembled bundle ourselves here, in one of two
// ways:
//
// 1. SELFSIGNED_CSC_LINK set (base64 .p12): sign with our own self-signed
//    code-signing certificate (see CLAUDE.md "Apple signing/notarization").
//    This is NOT trusted by macOS (self-signed, not from Apple), so we
//    deliberately don't rely on electron-builder's own CSC_LINK-driven
//    signing path — electron-builder resolves identities via `security
//    find-identity -p codesigning`, which filters to *trusted* identities
//    only and silently skips ours (CSSMERR_TP_NOT_TRUSTED), even though
//    `codesign --sign <hash>` works fine with it directly. So we import the
//    cert into our own temp keychain and sign by the certificate's SHA-1
//    hash (computed straight from the cert via openssl — independent of any
//    keychain trust state) rather than asking `security`/electron-builder to
//    "find" it. Using the same certificate on every build gives a stable
//    designated requirement (`certificate root = H"<hash>"`), which is what
//    lets Squirrel.Mac (in-app auto-update) trust one build's signature
//    against another's without needing Apple's trust at all.
//
// 2. Nothing set: fall back to an ad-hoc signature, freshly consistent with
//    this build's contents but with no stable identity across builds (fine
//    for local dev builds; in-app auto-update won't validate against these,
//    but Gatekeeper's first-run bypass flow still works).
//
// Neither path passes `--options runtime` (hardened runtime): it enforces
// library validation (loaded frameworks must share the main executable's
// Team ID), but neither an ad-hoc signature nor our self-signed certificate
// carries a Team ID at all (that field only exists on Apple-issued Developer
// ID certs) — dyld then refuses to load Electron's own nested frameworks
// ("different Team IDs"), and the app launches to nothing. See
// build/entitlements.mac.plist's com.apple.security.cs.disable-library-validation,
// which covers this for whichever signing path is used.
const { notarize } = require('@electron/notarize');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const execFileAsync = promisify(execFile);

async function extractCertPem(p12Path, p12Password, workDir) {
  const certPemPath = path.join(workDir, 'cert.pem');
  try {
    await execFileAsync('openssl', [
      'pkcs12', '-in', p12Path, '-nokeys', '-clcerts', '-legacy',
      '-passin', `pass:${p12Password}`, '-out', certPemPath,
    ]);
  } catch {
    // -legacy isn't understood by every openssl build; retry without it.
    await execFileAsync('openssl', [
      'pkcs12', '-in', p12Path, '-nokeys', '-clcerts',
      '-passin', `pass:${p12Password}`, '-out', certPemPath,
    ]);
  }
  return certPemPath;
}

async function signWithSelfSignedCert(appPath, entitlements) {
  const p12Base64 = process.env.SELFSIGNED_CSC_LINK;
  const p12Password = process.env.SELFSIGNED_CSC_KEY_PASSWORD;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-selfsign-'));
  const p12Path = path.join(workDir, 'cert.p12');
  const keychainPath = path.join(workDir, 'signing.keychain-db');
  const keychainPassword = 'mf-temp-keychain';

  try {
    fs.writeFileSync(p12Path, Buffer.from(p12Base64, 'base64'));

    const certPemPath = await extractCertPem(p12Path, p12Password, workDir);
    const { stdout: fingerprintOut } = await execFileAsync('openssl', ['x509', '-in', certPemPath, '-noout', '-fingerprint', '-sha1']);
    const hash = fingerprintOut.trim().split('=')[1].replace(/:/g, '');

    await execFileAsync('security', ['create-keychain', '-p', keychainPassword, keychainPath]);
    await execFileAsync('security', ['set-keychain-settings', '-lut', '21600', keychainPath]);
    await execFileAsync('security', ['unlock-keychain', '-p', keychainPassword, keychainPath]);
    await execFileAsync('security', ['import', p12Path, '-k', keychainPath, '-P', p12Password, '-T', '/usr/bin/codesign', '-A']);
    await execFileAsync('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', keychainPassword, keychainPath]);

    // `codesign --keychain <path>` does NOT reliably restrict/perform identity
    // lookup by itself (fails "no identity found" even with a freshly-imported
    // cert) — codesign resolves identities via the keychain *search list*, not
    // an ad-hoc --keychain argument. Add our temp keychain to the search list
    // (keeping the existing ones so nothing else on the runner breaks), sign,
    // then restore the original list.
    const { stdout: originalListRaw } = await execFileAsync('security', ['list-keychains', '-d', 'user']);
    const originalList = originalListRaw.split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
    await execFileAsync('security', ['list-keychains', '-d', 'user', '-s', keychainPath, ...originalList]);

    try {
      console.log(`[sign] Signing ${path.basename(appPath)} with self-signed cert (${hash})...`);
      await execFileAsync('codesign', [
        '--deep', '--force', '--sign', hash,
        '--entitlements', entitlements,
        appPath,
      ]);
      console.log('[sign] Self-signed re-sign done.');
    } finally {
      await execFileAsync('security', ['list-keychains', '-d', 'user', '-s', ...originalList]).catch(() => {});
    }
  } finally {
    await execFileAsync('security', ['delete-keychain', keychainPath]).catch(() => {});
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function signAdHoc(appPath, entitlements) {
  console.log(`[sign] No signing certificate configured — re-signing ${path.basename(appPath)} ad-hoc so resources are sealed consistently.`);
  await execFileAsync('codesign', [
    '--deep', '--force', '--sign', '-',
    '--entitlements', entitlements,
    appPath,
  ]);
  console.log('[sign] Ad-hoc re-sign done.');
}

module.exports = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  const entitlements = path.join(__dirname, '..', 'build', 'entitlements.mac.plist');

  if (process.env.SELFSIGNED_CSC_LINK) {
    await signWithSelfSignedCert(appPath, entitlements);
  } else {
    await signAdHoc(appPath, entitlements);
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
