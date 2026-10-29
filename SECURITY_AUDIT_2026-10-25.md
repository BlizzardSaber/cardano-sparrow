# Desktop security review — 2026-10-25 (0.3.15 baseline, 0.3.22 addenda)

Scope: current desktop source and macOS release path. This is a source review, dependency scan, automated test run, and build verification, **not** an independent security audit or a proof that large holdings are safe. Publicly documented practices from Daedalus, Lace, Yoroi, Mesh Multisig, Ledger, and Electron were used as comparison points; no claim is made that every Cardano wallet was inspected. Mesh's server/database design has a different threat surface from this local app.

## 0.3.22 Blockfrost addition

Adds an independent hosted indexer for optional transaction cross-checks and outage fallback. Koios-shaped data is normalized from Blockfrost and still passes the existing parsers. Only transport outages (including 429/413/5xx) trigger automatic fallback; malformed data and cancellation do not. Every strict check independently queries both sources, compares selected UTXO ADA/assets with the local draft, compares four protocol values and tips (180-slot tolerance), and checks v3 stake state against both sources and local context. It checks TTL against the fresh tips. Missing/deviating results stop signing/finalization/broadcast. Cross-checks activate only with a current-network key and the enabled option; UI explicitly indicates when absent. This does not provide a chain proof or protect a compromised renderer/OS.

New proxy permits fixed Mainnet/Preprod hosts and enumerated read paths plus the single CBOR submit path. It rejects redirects, credentials in URLs, unknown query fields, header-injection keys and oversize bodies/responses. Keys stay in localStorage and are never included in descriptor backups. Broadcast is submitted once via the current provider; no cross-provider automatic resubmission occurs after ambiguous errors. Querying a second source exposes relevant addresses to another service.

Verification: 111 automated tests plus origin, retry and new proxy allowlist/size checks passed. Fixtures cover fallback, strict failure, input/value disagreement, protocol/tip disagreement, staking reward disagreement, pagination, duplicate units, and single-submit behavior. Production build, two-build web reproducibility, a clean-profile browser startup and live local-proxy rejection checks passed. No real Project ID was supplied, so live authenticated Blockfrost and Ledger acceptance still require user testing. Official schema: [Blockfrost OpenAPI](https://github.com/blockfrost/openapi).

## 0.3.21 comprehensive source review

Scope: desktop source, renderer state, descriptor/CBOR parsers, payment and staking builders, Ledger integration, witness verification, Koios parsers and proxies, local password lock, and macOS packaging. The iOS app and separate address verifier were not changed in this review. No real wallet secrets were read and no transaction was signed or broadcast.

Confirmed issues fixed:

1. **High priority — staking certificate ownership.** Imported v3 certificates were not explicitly compared with the current wallet's stake script hash. All certificates now bind to that exact credential; foreign-credential regression cases are rejected.
2. **Medium — transaction lifetime.** Imported transactions could omit TTL. TTL is now mandatory; the application checks it against the synchronized slot and rejects expired transactions or a lifetime beyond 3,600 slots. Broadcast fetches the chain context again before this check. Chain context still comes from Koios and is not independently validated.
3. **Medium — ambiguous CBOR input.** CSL can parse a transaction while ignoring trailing bytes. Unsigned, signed, merged, inspected and broadcast-ID transactions now require an exact canonical encoding round trip. External witness CBOR receives the same check.
4. **Medium — amount and asynchronous state.** Duplicate requests for one CNT could produce a non-conserving draft; zero/negative requests were silently discarded. They are rejected. Metadata changing the selected token's decimals clears the entered quantity. Building, Max and broadcasting capture the wallet and input state before awaiting network responses and reject stale results. Final broadcast confirmation is checked again; locking clears that confirmation and the entered payment password.
5. **Medium — unknown staking state.** Malformed account rows previously became unregistered/zero-reward defaults. Invalid status, reward or deposit fields now block staking, and unavailable stake state is not passed as a fabricated unregistered account to imported-package validation.
6. **Low — privacy-lock failure.** Corrupt password records or storage read errors previously could be treated as no password. They now fail closed; verifier format and work factor are bounded, and setting a password requires persistent storage. This remains a removable local privacy lock, not wallet encryption or protection against local malware.
7. **Low — error handling and origin checks.** The final Koios 429/5xx response was consumed twice, hiding its real error. Retry now preserves the final body and handles transient failures/Retry-After. Custom-protocol requests and external links reject credentials and unexpected ports.
8. **Operational documentation.** Corrected stale enterprise-address, role-1, address-list and staking restrictions in README. Imported unsigned packages explicitly state that they have no cosigner signature proving their origin; this follows the provenance concern in CIP-1854 without blocking the first signer.

Verification: 100 Vitest tests, custom-protocol checks and Koios retry checks passed. Production TypeScript/Vite build, two-build web-payload reproducibility, packaged ASAR inspection and strict ad-hoc macOS signature verification passed. Live npm audit reported 0 known vulnerabilities across 164 dependencies; this does not audit embedded Node/Chromium or establish absence of unknown vulnerabilities. These checks cover known failure modes, not all possible defects. Ledger hardware, camera hardware and real-chain acceptance were not exercised in this review.

Remaining material risks:

- The host, descriptor display and receive QR can still be changed by malware. Hardware signing protects keys but requires checking every output and action on the device; receiving needs an independently checked descriptor/address.
- Koios remains the chain-data trust source. HTTPS and schema checks do not prove chain correctness or completeness against a malicious indexer.
- The macOS bundle remains ad-hoc signed and lacks Apple notarization. Version 0.3.24 adds a pinned Ed25519 publisher signature and native one-click verifier; the signing key still needs migration from the workstation to offline removable storage. Electron production fuses (RunAsNode, NODE_OPTIONS/inspector and ASAR integrity restrictions) are not yet hardened.
- Electron 44.9.3 embeds Node 24.22.0. Node 24.22.1 fixes publicly disclosed October 21 vulnerabilities, but no compatible stable Electron containing that update was confirmed on October 25. Current runtime code uses Electron net.fetch and dns.lookup, not Node TLS/HTTP clients, dns.resolve*, Brotli or startup snapshots, so the documented primary trigger paths are not presently used. This is a residual runtime dependency risk, not a claim of immunity.
- CNT decimals are remote metadata used to convert user input into raw units; wrong metadata can change the apparent human amount. Review the raw quantity and asset identity in the signing summary, especially for arbitrary tokens.
- The Ledger model/firmware matrix and long-running adversarial tests remain incomplete. This source review cannot certify large-value storage or prove absence of unknown bugs.

References: [CIP-1854](https://github.com/cardano-foundation/CIPs/blob/master/CIP-1854/README.md), [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security/), [Electron 44.9.3 runtime versions](https://releases.electronjs.org/release/v44.9.3), [Node October security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), [Ledger secure transaction review](https://developers.ledger.com/docs/device-app/integration/design-guidelines/transactions).

## 0.3.17 addendum — camera QR input

The camera is a new permission surface. The packaged app declares `NSCameraUsageDescription`; its Permissions Policy permits camera only for the application origin, and Electron grants only video requests from the main app frame. Microphone access remains denied. The renderer starts capture only when the user clicks Scan QR, decodes frames locally with `jsqr`, and stops tracks when the scan finishes, the dialog closes, the app locks, the page changes, or the app becomes hidden. Scanned text must be a canonical Cardano Bech32 payment address with the current network ID. A valid address is **not** evidence that it belongs to the intended recipient; the full address still needs human and Ledger review. This addendum is a focused code/packaging review, not a fresh full audit or a real-camera hardware test. Tests now total 83 passing; `npm audit` reports zero known vulnerabilities; the 0.3.17 app was packaged and its ad-hoc signature and DMG checksum verified.

## 0.3.18 camera authorization correction

The 0.3.17 renderer relied on `getUserMedia` to cause the macOS consent prompt, but the user's installed app returned a denial without appearing in the macOS Camera list. Version 0.3.18 adds an explicit main-process `askForMediaAccess("camera")` request, reachable only through a minimal preload bridge from the local app's main frame. The Electron video grant is time-limited to starting a scan and microphone access is still blocked. This corrects the authorization path; a hardware test after the user approves the actual macOS prompt remains necessary.

## 0.3.19 custom-protocol permission fix

The user confirmed macOS camera authorization, but 0.3.18 still returned an in-app denial. The Electron permission handler used `new URL(details.requestingUrl).origin` to compare the custom app scheme with `cardano-sparrow://app`; for this scheme JavaScript returns `"null"`, so the check always failed. Version 0.3.19 validates protocol, hostname, port, and credentials directly and accepts the requesting document URL when Electron's reported origin is opaque. This also fixes the HID device selection check used by Ledger. A focused regression test covers the opaque origin and malicious lookalikes. A successful real-camera scan still requires user confirmation.

## 0.3.20 CNT Max input correction

CNT Max used a human display formatter that inserted thousands separators, which HTML numeric inputs reject. The toast falsely reported success while the input remained empty. The input formatter now omits grouping, and the handler parses the actual field content back to the exact on-chain integer before reporting success. This affects amount entry and UI validation only; the transaction builder already rejects an empty or malformed amount. Round-trip tests cover decimals and large balances.

## Findings fixed in 0.3.15

1. **High — vulnerable Electron runtime.** 0.3.14 packaged Electron 44.9.0, affected by the compromised eMudhra intermediate-certificate mitigation advisory GHSA-jr5w-w6x2-84p9. This app makes network requests, so the advisory's affected scenario applies. Upgrade to 44.9.3. The packager now reads the exact runtime version from package.json.
2. **Medium — Koios proxy followed redirects.** Fixed-route requests could still follow an upstream redirect, potentially forwarding an optional bearer token to another host and accepting data outside the intended endpoint. Both packaged and development proxies now reject redirects. Price, quote, and icon requests already did so.
3. **Medium — unbounded proxy buffering.** Packaged and development proxies previously read some entire upstream responses before applying byte limits. They now stop reading when the configured limit is crossed, including error responses during retry; the packaged proxy also bounds request-body reads.
4. **Low — unauthenticated broadcast receipt.** A successful HTTP response with an arbitrary string was shown as the submitted TXID. The result now must be a 64-hex hash equal to the locally computed transaction ID. A mismatch leaves broadcast status uncertain; check the expected ID on chain before attempting another submission.
5. **Documentation — old security policy was inaccurate.** Updated the passcode iteration count and removed an incorrect claim that current releases include an independent Ed25519 publisher signature.

## Boundaries checked

| Area | Current control | Residual risk |
| --- | --- | --- |
| Private keys | Production renderer has no software mnemonic signer; Ledger signs on device. | A malicious/compromised host can mislead the user or request signatures; verify device display. Ledger firmware and app are separate trust dependencies. |
| Descriptor and receive address | CIP-1854 account xpub validation, fixed role-0 payment and role-2 stake template, local script/address derivation. | All three xpubs, order, threshold, network, and stake template must be backed up and independently compared; the computer alone is not an independent trust anchor. |
| Transaction construction | Strict output/network checks, local CSL serialization, bounded fee and output count, asset conservation, native-script witness set. | Complex token and staking paths are not independently formally verified; indexer may supply false or stale UTXOs/protocol values. |
| Import and signing | Package summary checked against CBOR, current descriptor, live UTXOs and scripts; Ledger body hash, path, public key and signature checked; merged witnesses verified against M-of-N scripts. | Device screen may not clearly present every multisig change, token, or stake action on every firmware/model. Do not treat computer UI as a substitute for clear signing. |
| Network/UI | Custom local protocol, no HTTP listener in packaged app; sandbox, context isolation, no Node integration, CSP, fixed proxy routes and external-link allowlist. | Electron/Chromium, image decoders, libraries, local OS, and build machine remain trusted. The current logo proxy allows remotely supplied raster image bytes. |
| Release provenance | Reproducible web payload check, ad-hoc macOS code signature, signed SHA-256 manifest, pinned Ed25519 native verifier. | The private key must still be migrated offline; there is no Apple notarization or signed update channel. A trusted verifier copy or public-key fingerprint must be retained separately. |
| Chain state | Koios UTXO pagination requires complete ranges; duplicates and malformed data are rejected. | Koios remains a single indexer and broadcast provider. This is weaker than local full-node validation. |
| Local storage | Password gates UI and broadcast; watch-only descriptor stored locally. | Password is a privacy lock, not encryption. Malware or another process with the user's filesystem access can read or change descriptor, xpubs, and app state. |

## Distance from mature wallets, by priority

1. **Independent chain data and address verification.** Daedalus validates with a local full node; this app relies on Koios. For high-value receive flows, compare the derived address against a second independently built verifier and the full descriptor recorded offline. A second indexer can detect discrepancies but is not the same as a full node.
2. **Authentic release channel.** Complete offline migration of the existing publisher key, retain the verifier/fingerprint on another trusted device, and later add Developer ID signing/notarization plus a signed update channel. Version 0.3.24 now signs release metadata and provides a user-visible verification workflow.
3. **Hardware acceptance matrix.** Record real-device tests across supported Ledger models, Cardano app versions, 1/2/3-of-3, ADA/token send, change, delegation, reward withdrawal, and deregistration; compare every device screen field with decoded CBOR. Re-run on firmware and SDK changes.
4. **Independent code review and fuzzing.** Existing 81 tests and focused fuzz tests cover known invariants, but not the breadth of professional review, protocol differential testing, parser fuzzing, or adversarial transaction corpus. Review the release artifact, not just source.
5. **Operational isolation.** Use a dedicated, updated computer for large-value actions, separate device backups, and independent address checks. No application can guarantee integrity after the host OS is compromised.

## Verification performed

- `npm audit`: 0 reported vulnerabilities after Electron upgrade.
- `npm test`: 81 passing, including a broadcast receipt mismatch regression test.
- `npm run build`: passes. Packaging and macOS code-sign verification must be rerun for each release.

Primary references: [Electron advisory](https://github.com/advisories/GHSA-jr5w-w6x2-84p9), [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security/), [Cardano wallet comparison](https://docs.cardano.org/about-cardano/new-to-cardano/types-of-wallets), [Lace source and provenance](https://github.com/input-output-hk/lace), [Yoroi source](https://github.com/Emurgo/yoroi), [Mesh Multisig source](https://github.com/MeshJS/multisig), [Ledger clear signing](https://developers.ledger.com/docs/device-app/integration/design-guidelines/transactions), [Ledger device audit criteria](https://developers.ledger.com/docs/device-app/submission-process/deliverables/security-audit).
