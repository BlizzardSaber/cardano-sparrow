# Desktop release and verification

## 0.3.26

The default unsigned-transaction export is now the standard Cardano `Tx ConwayEra` text-envelope accepted by Eternl (`type`, `description`, `cborHex`). Transaction CBOR and TXID are unchanged. Import Transaction accepts the new Eternl envelope, legacy Cardano Sparrow signing packages, and raw transaction CBOR. For an Eternl/raw import, the app does not trust missing JSON metadata: it reconstructs input addresses, derivation indexes, signing paths, threshold, outputs, certificates and withdrawals from the active descriptor, freshly synchronized UTXOs and decoded CBOR, then runs the existing wallet/UTXO/change/TTL/script/balance checks. Import Signed CBOR also accepts a signed `cborHex` text-envelope while retaining plain CBOR and legacy `signedTxHex` support. Adds round-trip and hostile-envelope regression tests. Transaction construction, derivation, Ledger signing and witness rules are unchanged.

## 0.3.25

Corrects staking reward presentation across Koios and Blockfrost. The staking page now distinguishes currently withdrawable rewards, lifetime rewards and lifetime withdrawn rewards; missing lifetime fields are shown as unavailable instead of fabricated as zero. Blockfrost continues to use `withdrawable_amount` for transaction construction. No address derivation, transaction construction, signing or witness rules changed.

## 0.3.24

Adds an independently anchored Ed25519 publisher signature and a one-click native macOS verifier. The verifier embeds the pinned public key, authenticates every versioned manifest before hashing files, rejects symlinks, unsafe paths, duplicates and unlisted DMG/ZIP artifacts, and verifies itself through the signed manifest. The same trust chain also covers the independent Cardano Address Verifier executable, launcher, source, lockfile and test vector. The private key is excluded from the app, source archive and release directory. Publisher public-key fingerprint: `7579b1ba72cb31cd893040deba3301e03de7c7e27bf2df763ab75c8bfece7ea7`. The key is not fully offline until the existing private PEM is moved to removable storage and the workstation copy is removed after backup verification.

## 0.3.23

Fixes missing USDCx valuation after DEX Screener stopped returning Cardano pools for the asset. The exact pinned USDCx asset now uses Minswap's public asset-metrics endpoint first, with DEX Screener retained as fallback. Responses are accepted only when policy ID and asset name match exactly, Minswap marks the asset verified, decimals equal 6, and the existing liquidity/volume thresholds pass. Valid quotes are cached for five minutes; empty failures are not cached. The Electron and development proxies expose only a fixed USDCx route with no caller-controlled upstream URL. Pricing remains display-only and cannot affect transaction construction, signing, or broadcasting.

## 0.3.22

Adds Blockfrost as a configurable Mainnet/Preprod backup with automatic outage fallback and explicit provider selection. Reuses the existing wallet parsers through a validated response adapter, including exact UTXO pagination and the latest 100 transactions. Optional strict Koios + Blockfrost checks run before Ledger signing, finalization and broadcast; mismatched/missing selected inputs, protocol parameters, chain tips or staking state stop the action. The toggle defaults on, and activates when a Project ID exists for the current network. Stake rewards use withdrawable_amount and registration state uses registered; the actual deposit comes from the registration record. Keys remain local and are excluded from descriptors. Proxy paths/hosts are fixed, redirects rejected, requests/responses bounded, and broadcast never automatically retries through another provider. No derivation, descriptor or signing-policy change.

## 0.3.21

Security review and correctness fixes: binds imported staking certificates to the current wallet, requires a bounded TTL, rejects trailing/noncanonical transaction and witness CBOR, rejects duplicate/nonpositive CNT requests, blocks malformed or unavailable stake state, protects amount entry and transaction actions from asynchronous state changes, and makes corrupt password records fail closed. Fixes Koios retry response handling and tightens protocol/external-link validation. Imported unsigned packages show an origin warning. Descriptor, address derivation and M-of-N policies are unchanged. Existing exported signatures remain usable only within their original chain TTL; cancelled local drafts do not revoke them. See SECURITY_AUDIT_2026-10-25.md for findings and residual risks.

## 0.3.20

Fixes Send → Max for CNT balances of 1,000 units or more. The display formatter added thousands separators, but the HTML number input rejects commas; the app previously showed a success toast even though the field remained empty. Max now uses an ungrouped exact decimal string and verifies that parsing the actual field value returns the original on-chain integer quantity before confirming success. The number input's minimum and step follow the asset's declared decimals. Adds round-trip tests for integer, unknown-decimal, and six-decimal assets. Transaction construction and signing logic are unchanged.

## 0.3.19

Fixes the actual cause of camera denial after macOS permission was granted. JavaScript `new URL("cardano-sparrow://app/").origin` is the opaque string `"null"`, so 0.3.17/0.3.18 rejected the app's own permission request in Electron. The permission handler now validates the custom scheme, host, and credentials directly, including the requesting URL when Electron reports an opaque origin. The same fix restores the intended origin check for Ledger HID permission requests. Adds a regression test for the custom-scheme origin and malicious lookalikes. The macOS camera consent workflow and transaction logic are otherwise unchanged.

## 0.3.18

Fixes the macOS camera authorization flow for Send → Scan QR. The packaged app now uses a narrow sandboxed preload bridge to ask the main process to call Electron's `systemPreferences.askForMediaAccess("camera")` when macOS has not yet decided. Only the app's main frame can invoke this request. After approval, the Electron video permission is open for 30 seconds to start `getUserMedia`; audio remains denied. The scanner distinguishes an OS denial from a later in-app camera block. Previously denied macOS permissions cannot be prompted again until reset or changed in System Settings, followed by an app restart. No transaction, derivation, or signing logic changed.

## 0.3.17

Adds a **Scan QR** button beside the Send recipient field. It uses the MacBook camera only after a click and fills the field only when the QR content is a valid Cardano payment address on the wallet's selected network. The camera stream stops on success, cancel, page change, lock, or app hide. QR decoding stays local; the app never uploads video. The packaged app declares macOS camera usage, and its Electron permission policy allows only video requests from the application origin while microphone access remains denied. A scanned address still requires full visual review before transaction construction and Ledger signing. Adds parser tests for wrong network, stake addresses, malformed QR data, and payment URIs. No address derivation, transaction construction, or signing semantics changed.

## 0.3.16

Adds **Export Signed CBOR** to each verified signature slot. Ledger signing still inserts its signed transaction CBOR into the next free slot automatically; the new button writes that slot's hex CBOR as a UTF-8 `.cbor.txt` file, which the existing **Import Signed CBOR** action accepts. The export button stays disabled for empty, malformed, or mismatched slots and validates the signed transaction against the current unsigned body again before downloading. Importing a second signed CBOR fills the next empty slot; a signer already represented in existing slots does not consume another slot unless the incoming CBOR also adds a new signer. Reimporting the *same unsigned transaction* preserves signatures; importing a *different unsigned transaction* requires confirmation before clearing signatures and any merged transaction. This is useful when moving a partial signature between separate app instances. When all Ledger devices are connected to one computer in turn, they can sign into successive slots without export/import. A partial signed file contains transaction details and a public-key signature, never a Ledger private key. Exported signatures cannot be revoked by cancelling the local draft. No transaction construction, address derivation, or Ledger signing protocol changed.

## 0.3.15

Security maintenance review: updates Electron from 44.9.0 to 44.9.3 to address the certificate-validation advisory GHSA-jr5w-w6x2-84p9. The packaged and development Koios proxies now refuse redirects, including while forwarding an optional API token, and stop reading price, quote, and Koios responses at their configured byte limits; the packaged proxy also bounds request bodies and token icons. After submission, the app accepts a Koios transaction ID only if it exactly matches the ID computed locally from the submitted CBOR. A mismatched receipt does not prove the transaction failed; inspect the expected TXID on chain before retrying. The packager takes its Electron version from package.json to prevent a runtime/version mismatch. No address derivation, descriptor, signing policy, or transaction builder semantics changed. This build remains ad-hoc signed and is not an independently audited release; details are in SECURITY_AUDIT_2026-10-25.md.

## 0.3.14

Corrects the homepage estimate so it can include every held native asset with a Token Registry listing, known decimals, and a qualifying DEX Screener USD quote (at least $50,000 pool liquidity and $1,000 24-hour volume). The exact USDCx asset ID can be quoted even before registry metadata finishes loading. ADA and verified NIGHT retain their existing price sources; CNY token values use the available ADA USD/CNY cross-rate. The total and per-asset fiat values no longer show an approximate sign, while the text still identifies these as reference estimates and counts any unpriced assets. DEX requests use a fixed, validated local proxy route. Quotes never affect UTXOs, Send, transaction construction, or signing. No descriptor or derivation logic changed.

## 0.3.13

The homepage ADA balance and portfolio estimate now include claimable staking rewards once stake-account synchronization succeeds. The balance label and tooltip distinguish UTXO ADA from rewards, which only become spendable UTXOs after withdrawal. Wallet switching clears the previous wallet's stake state before rendering. Transaction construction and Send continue to use UTXOs only. No descriptor, derivation, or signing logic changed.

## 0.3.12

Adds an optional setting to hide assets without a Token Registry listing from the holdings table and visible asset count. Transactions, UTXOs, signing review, and the Send asset selector continue to show every asset. The exact USDCx asset ID uses the Cardano Token Registry PNG bundled with the app, so its icon no longer waits for a metadata request; lookalike tokens do not receive that icon. A registry listing is not issuer authentication. No address derivation, transaction construction, or signing logic changed. This build remains ad-hoc signed and is not independently audited.

## 0.3.11

Fixes Koios HTTP 413 for wallets with many derived addresses. Address discovery, exact UTXO pagination, and recent transaction history now use batches of at most 20 addresses; validated UTXOs are merged, and the newest 100 transactions are deduplicated across batches. This does not change address derivation, transaction construction, or Ledger signing. The app remains ad-hoc signed and is not independently audited.

## 0.3.10

Large-history synchronization fix. Used addresses are identified with Koios `/address_info?select=address` instead of downloading every historical output. The history list is limited to the latest 100 transactions with `count=planned`; UTXOs still use exact pagination with total checks, and every displayed transaction still requires validated details. This changes sync work and history depth only, not address derivation, transaction construction, or signing. The build remains ad-hoc signed and is not independently audited.

## 0.3.9

The home-screen asset-type count now includes ADA when the wallet holds ADA.
Previously it counted only native assets, so ADA plus NIGHT misleadingly read 1.

## 0.3.8

Visual refinement only: a unified SVG navigation set, calmer dark sidebar,
clearer card and form hierarchy, more legible portfolio summary, and restrained
feedback motion. Critical signing details do not animate; system Reduce Motion
is respected. No transaction, address derivation, signing, or storage logic changed.

## 0.3.7

The Signatures page now shows a pre-signing review decoded from the unsigned transaction CBOR: network, transaction ID, input count, fee, TTL slot, every output address and amount, native assets, and staking certificates or reward withdrawals. It also explicitly notes when no change output exists. The same review appears for locally built and imported signing packages; cancelling or expiring a draft clears it. Ledger confirmation remains authoritative: the computer display alone is not an independent verification of the device screen. Signing, wallet derivation, and transaction construction were not changed. This release remains ad-hoc signed and is not Apple-notarized or independently audited.

## 0.3.6

Adds optional USD/CNY portfolio estimates for ADA and verified NIGHT, with market prices fetched through fixed local proxy routes. Asset logos now appear in balances and transaction history. Transaction rows open an in-app detail view with the complete TXID, fee, per-asset net changes, and all recorded inputs and outputs; only the TXID link opens Cardanoscan. Asset icons remain neutral while signed amounts indicate incoming or outgoing value. Koios asset metadata is untrusted and never determines a coin's verified identity. No signing, descriptor, or address-derivation behavior changed. Price and chain data are informational, not independently verified; this remains an ad-hoc signed, non-notarized build.

## 0.3.5

Security follow-up to 0.3.4: wallet switching aborts and invalidates in-flight synchronization and cosmetic staking/asset responses; stale results cannot overwrite the newly selected wallet. Koios UTXO, historical-output, and transaction queries now use fixed-order pagination with exact `Content-Range` total checks and fail closed on missing pages or transaction details. Payment and staking fee estimation reserves space for all possible cosigner witnesses, so a 2-of-3 transaction remains adequately funded even if all three sign. No descriptor, address-derivation, wallet-storage, or private-key format changed. The desktop build still uses ad-hoc signing and is not Apple-notarized; this release is not an independent audit.

## 0.3.4

Fixes synchronization on Mainnet and Preprod. Koios currently returns `/tip`'s `abs_slot` as a JSON number; 0.3.3 mistakenly required a string and rejected otherwise valid chain context. The parser now accepts a nonnegative safe integer or decimal string while continuing to reject fractional, negative, oversized, or malformed slots. No address derivation, signing, or wallet-storage format changed.

## 0.3.3

Security follow-up: removes the Preprod web mnemonic signer from production builds (it remains available only in `npm run dev`), renders Koios transaction block heights as text, and fails closed on malformed or duplicated UTXOs and implausible protocol parameters. Corrects the CIP-1854 role-2 explanation: the standard defines role 2 as stake keys; the fixed index-0 M-of-N delegation template is this wallet's descriptor choice. This is still not an independent audit or Ledger hardware validation.

## 0.3.2

Follow-up to the 0.3.1 review: clears the Preprod mnemonic textarea whenever the app locks, and raises the PBKDF2-SHA256 passcode derivation for newly set passwords from 310k to 600k iterations (existing stored verifiers keep working at their recorded iteration count). Its role-2 wording was inaccurate and is corrected in 0.3.3.

## 0.3.1

Security and correctness review of 0.3.0: fixes the stake deregistration refund equation, validates imported change addresses against the current wallet, binds withdrawals to this wallet's stake script and network, renders untrusted token names as text, and limits remote token icons to fixed gateways. Token summaries now include the full asset fingerprint and raw unit count. Automated tests and build pass; token/staking Ledger paths still require a real-device Preprod exercise. This build is not independently audited or Apple notarized.

## 0.3.0

Adds M-of-N staking on top of 0.2.0. Addresses are now Base Addresses (payment script + a stake script derived from the same cosigners at `m/1854'/1815'/0'/2/0`, same threshold). A Staking page builds register+delegate, pool change, reward withdrawal, and undelegation with deposit refund; these operations require M-of-N signatures. Ledger requests include script-hash stake credentials in MULTISIG_TRANSACTION mode, but the certificate and token flows still need real-device verification. Signing packages carrying certificates/withdrawals use version 3; versions 1/2 remain importable. This version derives and scans Base Addresses only. Funds received at pre-0.3.0 enterprise addresses are not displayed or spent here; use 0.2.0 to view or move them before relying on 0.3.0. New Koios routes: `/account_info`, `/pool_info`. For test convenience the signature page includes a Preprod-only mnemonic signer (mainnet packages are refused in code, input is never persisted and is cleared after signing).

## 0.2.0

Adds native-asset (token) support on top of 0.1.2: balances are aggregated from Koios `address_utxos`, each asset displays a locally computed CIP-14 fingerprint, policy id, name/ticker/decimals metadata, and an icon loaded through a hardened local proxy (https/ipfs/ar only, private-range DNS blocked, no redirects, 512 KiB cap, raster image types only, 24 h cache). Send supports token transfers with greedy asset-first coin selection, automatic min-ADA padding, and change that returns leftover assets. Signing packages carry asset summaries as version 2; pure-ADA version 1 packages remain importable. Ledger requests now include the token bundle. Dev proxy and desktop shell both proxy the new `/api/v1/asset_info` endpoint.

## 0.1.2

The wallet now uses only the standard CIP-1854 role-0 sequential pool. Role 1 is not displayed, derived, scanned, accepted in signing packages, or used for receive/change outputs.

## 0.1.1

Superseded by 0.1.2. Do not use this test build.

## Security model

The macOS desktop build loads only packaged local assets through `cardano-sparrow://app`. It does not open a local HTTP port. The renderer is sandboxed, has no Node.js access, cannot open developer tools, and can only reach the exact Koios endpoints proxied by the main process. WebHID permission is restricted to Ledger vendor ID `0x2c97`.

From 0.3.3 onward, the production UI and desktop payload do not include the mnemonic signer. The source-tree development signer remains Preprod-only; never enter a mainnet recovery phrase. The separate source-tree CLI signer is not packaged in the desktop app.

## Build

```sh
npm ci
npm test
npm run security:fuzz
npm run repro:check
npm run desktop:build
```

`repro:check` compares the SHA-256 tree of two production web payload builds under a fixed timezone, locale and `SOURCE_DATE_EPOCH`. macOS code signatures and DMG filesystem metadata are intentionally not claimed to be byte-for-byte reproducible.

## Signatures

The current package is ad-hoc code-signed because no Apple Developer ID identity is installed on the build machine. It is not notarized by Apple, so Gatekeeper may require the user to explicitly open it. Do not present this build as an Apple-verified release.

Each current release has a versioned SHA-256 manifest authenticated by the pinned Ed25519 publisher key. Double-click `验证Cardano发布包.command`, or for version 0.3.26 verify the hash manifest manually with:

```sh
shasum -a 256 -c MANIFEST-0.3.26.sha256
```

For a public production release, use an offline or hardware-backed publisher key and publish its fingerprint through an independent channel. Replace ad-hoc signing with Developer ID signing and Apple notarization.
