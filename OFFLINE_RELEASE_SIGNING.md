# Offline Ed25519 release signing

Publisher public-key fingerprint (SHA-256 of SPKI DER):

`7579b1ba72cb31cd893040deba3301e03de7c7e27bf2df763ab75c8bfece7ea7`

## Complete the offline-key migration

1. Copy `release-keys/cardano-sparrow-release-private.pem` to two encrypted removable-media backups.
2. On each backup, set permissions to `600` and derive the public-key fingerprint. It must equal the value above.
3. Store the public fingerprint or a trusted copy of `CardanoReleaseVerifier` on a separate device.
4. Only after both backups are verified, remove the workstation private-key file. APFS/SSD deletion is not guaranteed secure erasure; assume any prior workstation backup may retain it.
5. Keep the signing Mac offline. Move only the completed `MANIFEST-*.sha256` onto it, run the signing command, and return only the 64-byte `.sig` file.

Signing command from this source tree:

```bash
node scripts/sign-release.mjs /Volumes/OFFLINE/cardano-sparrow-release-private.pem /path/to/MANIFEST-0.3.26.sha256
```

The script refuses a non-Ed25519 key, a key with group/other permissions, symbolic links and any key whose public fingerprint differs from the pinned publisher identity. Never place the private PEM in a DMG, ZIP, Git repository, cloud folder or release directory.

## Verification trust boundary

The one-click verifier authenticates signed manifests and every listed file. A malicious replacement verifier could lie, so retain one trusted verifier binary or the fingerprint separately. Apple Developer ID notarization remains the system-integrated option for Gatekeeper identity; this publisher signature is an independent personal trust root.
