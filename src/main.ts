import "./polyfills";
import "./style.css";
import QRCode from "qrcode";
import { parseScannedAddress } from "./scan-address";
import { nextReceiveAddress, requiredDiscoverySize } from "./addressing";
import { currentLocale, localizeError, setLocale, t } from "./i18n";
import {
  buildStakingTransaction,
  buildUnsignedTransaction,
  deriveAddresses,
  inspectFinalTransaction,
  mergeSignedTransactions,
  poolIdToKeyHashHex,
  rewardAddressOf,
  transactionCborFromImport,
  transactionId,
  transactionTextEnvelope,
  unsignedPackageFromTransaction,
  validateUnsignedPackage,
  validatePackageForWallet,
  validateDescriptor,
  validateSignedTransaction,
  type StakingContext,
} from "./cardano";
import { LedgerWebHidSigner } from "./ledger";
import { broadcast, verifyPackageSources, fetchAssetInfo, fetchChainContext, fetchPoolInfo, fetchStakingState, fetchWallet, type AssetBalance, type PoolInfo, type StakingState } from "./provider";
import { assetDecimals, formatTokenInput, formatTokenQuantity, iconProxyUrl, isListedAsset, isUsdcx, parseTokenAmount, resolveAssetMeta } from "./assets";
import { assetFingerprint, assetNameText, shortFingerprint } from "./fingerprint";
import type { AssetMeta, AssetUnit, DerivedAddress, Descriptor, TransactionSide, UnsignedPackage, Utxo, WalletTransaction } from "./types";
import { networkConfig, type CardanoNetwork } from "./network";
import { estimate, estimateDexValue, formatFiat, freshPrices, isVerifiedNight, loadDexQuotes, loadPrices, type DexQuote, type FiatPrices } from "./prices";
import { activeSource, saveSourceSettings, sourceSettings, type SourceMode } from "./data-source";
import { changePasscode, hasPasscode, removePasscode, resetLocalData, setupPasscode, verifyPasscode } from "./passcode";

declare global {
  interface Window {
    cardanoCamera?: { requestPermission(): Promise<"granted" | "denied" | "blocked"> };
  }
}

const LEGACY_STORAGE_KEY = "cardano-sparrow:descriptor:v1";
const WALLETS_STORAGE_KEY = "cardano-sparrow:wallets:v1";
const ACTIVE_WALLET_KEY = "cardano-sparrow:active-wallet:v1";
const UNSIGNED_EXPIRY_MS = 10 * 60 * 1000;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_META_ASSETS = 300;
type StoredWallet = { id: string; name: string; descriptor: Descriptor };
const ledger = new LedgerWebHidSigner();
let wallets: StoredWallet[] = [];
let activeWalletId: string | null = null;
let walletName = "Cardano Multisig";
let descriptor: Descriptor | null = null;
let addresses: DerivedAddress[] = [];
let utxos: Utxo[] = [];
let assetBalances: AssetBalance[] = [];
let assetMetaByUnit = new Map<string, AssetMeta>();
let assetQuotes: Record<string, DexQuote> = {};
let stakeState: StakingState | null = null;
let poolPreview: PoolInfo | null = null;
let keyDepositLovelace = 2_000_000n;
let transactions: WalletTransaction[] = [];
let fiatCurrency: "usd" | "cny" = localStorage.getItem("cardano-sparrow-fiat-currency") === "cny" ? "cny" : "usd";
let hideUnlistedAssets = localStorage.getItem("cardano-sparrow-hide-unlisted-assets") === "on";
let unsigned: UnsignedPackage | null = null;
let unsignedImported = false;
let unsignedHasSignature = false;
let unsignedExpiryTimer: number | null = null;
let sendMaxMode = false;
let sendAssetKey = "";
let mergedTx = "";
let broadcastHash = "";
let usedAddressIndexes = new Set<number>();
let walletSynced = false;
let syncedTipSlot: bigint | null = null;
let networkState: "unsynced" | "syncing" | "synced" | "failed" = "unsynced";
let syncRun = 0;
let syncAbort: AbortController | null = null;
let draftCosigners = Array.from({ length: 3 }, (_, index) => ({ name: `Signer ${index + 1}`, accountXpub: "" }));
let activeKeystoreIndex = 0;
let cameraStream: MediaStream | null = null;
let cameraTimer: number | null = null;
let cameraGeneration = 0;

const assetKey = (policyId: string, assetNameHex: string) => `${policyId}.${assetNameHex}`;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
function assetMetaFor(key: string): AssetMeta | undefined {
  return assetMetaByUnit.get(key);
}
function decimalsForAssetKey(key: string): number | null {
  const [policyId, assetNameHex] = key.split(".");
  return assetDecimals(policyId, assetNameHex, assetMetaFor(key));
}
function assetFallbackName(key: string): string {
  const [policyId, assetNameHex] = key.split(".");
  return assetNameText(assetNameHex) || shortFingerprint(assetFingerprint(policyId, assetNameHex), 8);
}
function assetDisplayLines(key: string): { name: string; fingerprint: string } {
  const meta = assetMetaFor(key);
  const [policyId, assetNameHex] = key.split(".");
  return {
    name: isVerifiedNight(policyId, assetNameHex) ? "NIGHT" : isUsdcx(policyId, assetNameHex) ? "USDCx" : meta?.name || assetFallbackName(key),
    fingerprint: meta?.fingerprint ?? assetFingerprint(policyId, assetNameHex),
  };
}
function describeAssetQuantity(policyId: string, assetNameHex: string, quantity: string): string {
  const key = assetKey(policyId, assetNameHex);
  const meta = assetMetaFor(key);
  const display = assetDisplayLines(key);
  return `${formatTokenQuantity(BigInt(quantity), assetDecimals(policyId, assetNameHex, meta))} ${display.name} · ${display.fingerprint} · raw ${quantity}`;
}

const navIcons = {
  wallet: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18M7 15h4"/>',
  send: '<path d="m4 17 16-13M10 4h10v10M4 8v9h9"/>',
  receive: '<path d="m4 7 16 13M20 11v9h-9M20 4v4"/>',
  addressbook: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  utxos: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  staking: '<path d="m12 2 8 10-8 10L4 12 12 2Z"/><path d="m12 6 4 6-4 6-4-6 4-6Z"/>',
  sign: '<path d="M4 20h16M7 16l9-9 3 3-9 9H7v-3ZM14 9l3 3"/>',
  setup: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="currentColor"/><circle cx="15" cy="17" r="2" fill="currentColor"/>',
} as const;
const navIcon = (name: keyof typeof navIcons) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${navIcons[name]}</svg>`;

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div class="app-shell">
    <header class="menu-bar"><div class="brand"><img src="/cardano.svg" alt=""><b>Cardano Sparrow</b></div><div class="header-right"><button id="lock-app" class="hidden" data-i18n-title="lock.lockTitle" title="锁定应用">🔒</button><button id="locale-toggle">中文</button><div class="status"><i></i><span id="network-status">未同步</span></div></div></header>
    <div class="wallet-tabs"><div id="wallet-list" class="wallet-list"></div><div class="wallet-actions"><button id="remove-wallet" class="wallet-remove" data-i18n="wallet.remove" disabled>Remove wallet</button><button id="new-wallet" data-i18n="wallet.new">New wallet</button><label class="button"><span data-i18n="wallet.import">Import wallet</span><input id="top-import" type="file" accept="application/json,.json" hidden></label></div></div>
    <div class="workbench">
      <aside class="sidebar">
        <div class="side-wallet"><span data-i18n="wallet.watchOnly">WATCH-ONLY WALLET</span><strong id="side-balance">0.000000 ADA</strong></div>
        <nav aria-label="钱包功能">
          <button data-view="wallet" disabled><span>${navIcon("wallet")}</span><b data-i18n="nav.transactions">Transactions</b></button>
          <button data-view="send" disabled><span>${navIcon("send")}</span><b data-i18n="nav.send">Send</b></button>
          <button data-view="receive" disabled><span>${navIcon("receive")}</span><b data-i18n="nav.receive">Receive</b></button>
          <button data-view="addressbook" disabled><span>${navIcon("addressbook")}</span><b data-i18n="nav.addresses">Addresses</b></button>
          <button data-view="utxos" disabled><span>${navIcon("utxos")}</span><b data-i18n="nav.utxos">UTXOs</b></button>
          <button data-view="staking" disabled><span>${navIcon("staking")}</span><b data-i18n="nav.staking">Staking</b></button>
          <button data-view="sign" disabled><span>${navIcon("sign")}</span><b data-i18n="nav.signatures">Signatures</b><i id="signature-pending-dot" class="pending-dot hidden" aria-hidden="true"></i></button>
          <button data-view="setup" class="active"><span>${navIcon("setup")}</span><b data-i18n="nav.settings">Settings</b></button>
        </nav>
        <div class="network-card"><span data-i18n="network.label">Network</span><strong id="network-name">Cardano Mainnet</strong><small>CIP-1854 · account 0</small></div>
      </aside>
      <main class="content">
        <section class="view panel" id="setup">
          <div class="page-title"><div><h1 data-i18n="settings.title">Settings</h1><p data-i18n="settings.subtitle">Wallet policy and keystores</p></div><span class="badge" id="policy-badge">— of 3</span></div>
          <div class="settings-block policy-settings"><h2 data-i18n="settings.policy">Policy</h2><div class="sparrow-policy-grid"><div class="policy-column"><label><span data-i18n="settings.walletName">Wallet name</span><input id="wallet-name" value="Cardano Multisig" maxlength="60"></label><div class="readonly-row policy-type"><span data-i18n="settings.policyType">Policy type</span><strong>Multi Signature HD</strong></div><div class="readonly-row script-type"><span data-i18n="settings.script">Script type</span><strong id="script-policy">Native Script · choose threshold</strong></div></div><div class="policy-column"><label><span data-i18n="settings.network">Network</span><select id="wallet-network"><option value="mainnet" selected>Mainnet</option><option value="preprod">Preprod</option></select></label><label><span data-i18n="settings.required">Required signatures</span><input id="threshold" type="number" min="1" max="3" inputmode="numeric" aria-describedby="threshold-error"><small id="threshold-error" class="field-error hidden" data-i18n="settings.requiredMissing">Choose the number of required signatures.</small></label><div class="readonly-row"><span data-i18n="settings.total">Total keystores</span><strong id="signer-total">3</strong></div><div class="readonly-row"><span data-i18n="settings.derivation">Account derivation</span><code>m/1854'/1815'/0'</code></div></div></div><div class="descriptor-row"><span data-i18n="settings.descriptor">Script policy</span><code id="policy-descriptor">at_least(—, Keystore 1, Keystore 2, Keystore 3)</code></div><p id="policy-locked" class="policy-locked hidden" data-i18n="settings.policyLocked">The signing policy is locked because changing it creates a different wallet and different addresses. Use New wallet to create another policy.</p><p id="mainnet-warning" class="mainnet-warning" data-i18n="settings.mainnetWarning">Mainnet uses real ADA. Verify every address and amount on the Ledger screen before approving.</p></div>
          <div class="settings-block passcode-block"><div class="block-title"><h2 data-i18n="passcode.title">Payment password</h2></div>
            <div class="passcode-grid">
              <label id="passcode-current-row" class="hidden"><span data-i18n="passcode.current">Current password</span><input id="passcode-current" type="password" autocomplete="off" spellcheck="false"></label>
              <label><span data-i18n="passcode.new">New password (min 6 chars)</span><input id="passcode-new" type="password" autocomplete="off" spellcheck="false"></label>
              <label><span data-i18n="passcode.confirm">Confirm new password</span><input id="passcode-confirm" type="password" autocomplete="off" spellcheck="false"></label>
            </div>
            <div class="row actions"><button id="passcode-save" data-i18n="passcode.save">Set password</button><button id="passcode-remove" class="hidden" data-i18n="passcode.remove">Remove password</button></div>
            <p class="notice" data-i18n="passcode.notice">支付密码用于打开应用时解锁和广播前复核，是本地隐私锁；钱包数据本身不加密。忘记密码只能重置本机数据并重新导入 descriptor。</p>
          </div>
          <div class="settings-block"><h2 data-i18n="source.title">链上数据源</h2>
            <div class="passcode-grid">
              <label><span data-i18n="source.mode">数据源模式</span><select id="source-mode"><option value="auto" data-i18n="source.auto">自动备用</option><option value="koios">Koios</option><option value="blockfrost">Blockfrost</option></select></label>
              <label><span>Blockfrost Mainnet Project ID</span><input id="bf-mainnet" type="password" autocomplete="off" spellcheck="false" maxlength="64"></label>
              <label><span>Blockfrost Preprod Project ID</span><input id="bf-preprod" type="password" autocomplete="off" spellcheck="false" maxlength="64"></label>
            </div>
            <label class="asset-filter-setting"><input id="source-verify" type="checkbox"><span data-i18n="source.verify">签名与广播前双源核验</span></label>
            <p class="notice" data-i18n="source.hint">自动模式在请求故障时切换备用源，不会因数据校验失败而切换。双源核验需配置当前网络的 Project ID；开启后，任一源失败或结果不一致都会停止签名/广播。API Key 只保存在本机，不进入钱包备份；查询会向两家服务暴露相关地址。</p>
            <button id="source-save" data-i18n="source.save">保存数据源设置</button>
          </div>
          <div class="settings-block"><h2 data-i18n="settings.display">显示</h2><label class="asset-filter-setting"><input id="hide-unlisted-assets" type="checkbox"><span data-i18n="settings.hideUnlisted">隐藏未登记资产</span></label><p class="notice" data-i18n="settings.hideUnlistedHint">仅影响资产列表；交易、UTXO 和发送仍显示全部资产。Token Registry 登记不等于发行方认证。</p></div>
          <div class="settings-block keystore-block"><div class="block-title"><h2 data-i18n="settings.keystores">Keystores</h2><div><button id="remove-signer" type="button" data-i18n="settings.remove">− Remove</button><button id="add-signer" type="button" data-i18n="settings.add">＋ Add</button></div></div><div class="keystore-tabs" id="keystore-tabs" role="tablist"></div><div class="keystore-pane" id="keystores"></div></div>
          <div class="row actions"><label class="compact"><span data-i18n="settings.gap">Gap limit</span><input id="gap" type="number" min="1" max="100" value="20"></label><button class="primary" id="create" data-i18n="settings.apply">Apply</button><button id="save" data-i18n="settings.save">Save Wallet</button><button id="export" data-i18n="settings.export">Export</button><label class="button"><span data-i18n="settings.import">Import</span><input id="import" type="file" accept="application/json,.json" hidden></label></div>
          <p class="notice" data-i18n="settings.notice">本机保存使用 localStorage。账户公钥不能花费资金，但会暴露地址和余额。</p>
        </section>

        <section class="view panel hidden" id="wallet">
          <div class="page-title"><div><h1 data-i18n="transactions.title">Transactions</h1><p data-i18n="transactions.subtitle">Wallet activity and balance</p></div><button class="primary" id="refresh" data-i18n="common.refresh">Refresh</button></div>
          <div class="portfolio-summary"><div><span id="portfolio-label"></span><strong id="portfolio-value">—</strong><small id="portfolio-note"></small></div><button id="fiat-currency" type="button">USD</button></div>
          <div class="balance"><div><span id="balance-label" data-i18n="balance.available">Available balance</span><strong id="balance">0.000000 <small>ADA</small></strong></div><div><span data-i18n="balance.spendable">Spendable UTXOs</span><strong id="utxo-count">0</strong></div><div><span data-i18n="balance.assets">Assets</span><strong id="asset-count">0</strong></div></div>
          <section class="asset-section" id="asset-section">
            <div class="address-section-title"><div><h2 data-i18n="assets.title">Assets</h2><p data-i18n="assets.subtitle">Native tokens held by this wallet</p></div></div>
            <div class="table asset-table">
              <div class="tr head"><span data-i18n="assets.asset">Asset</span><span data-i18n="assets.fingerprint">Fingerprint</span><span data-i18n="assets.policyId">Policy ID</span><span data-i18n="assets.quantity">Balance</span><span></span></div>
              <div id="asset-rows"></div>
            </div>
          </section>
          <div id="transaction-history"></div>
          <dialog id="transaction-detail" class="transaction-detail"><div id="transaction-detail-content"></div><button id="transaction-detail-close" type="button" data-i18n="transactions.close">Close</button></dialog>
        </section>

        <section class="view panel hidden" id="receive">
          <div class="page-title"><div><h1 data-i18n="receive.title">Receive</h1><p data-i18n="receive.subtitle">Share this address to receive ADA</p></div><span class="badge" id="receive-state">Not synced</span></div>
          <div class="receive-only"><div class="qr-frame"><canvas id="receive-qr" aria-label="Receive address QR code" data-i18n-aria="receive.qrLabel"></canvas></div><div><span id="receive-index">Receive address</span><code id="next-address">Create or restore a wallet first</code><p id="receive-hint">Used addresses are skipped automatically after chain sync.</p><button class="primary" id="copy-next" disabled data-i18n="receive.copy">Copy Address</button></div></div>
        </section>

        <section class="view panel hidden" id="addressbook">
          <div class="page-title"><div><h1 data-i18n="addresses.title">Addresses</h1><p data-i18n="addresses.subtitle">All derived native-script addresses</p></div><span class="badge" id="address-count">0 addresses</span></div>
          <section class="address-section"><div class="address-section-title"><div><h2 data-i18n="addresses.receive">Receive addresses</h2><p data-i18n="addresses.receiveHint">External chain · role 0</p></div><code>m/1854'/1815'/0'/0/index</code></div><div class="table address-table"><div class="tr head"><span data-i18n="table.index">Index</span><span data-i18n="table.address">Address</span><span data-i18n="table.balance">Balance</span><span data-i18n="table.status">Status</span><span></span></div><div id="addresses"></div></div></section>
        </section>

        <section class="view panel hidden" id="utxos">
          <div class="page-title"><div><h1 data-i18n="utxos.title">UTXOs</h1><p data-i18n="utxos.subtitle">Coin control · pure ADA only</p></div><span class="badge" id="utxo-badge">0 outputs</span></div>
          <div class="table utxo-table"><div class="tr head"><span data-i18n="table.outpoint">Outpoint</span><span data-i18n="table.addressIndex">Address / Index</span><span data-i18n="table.amount">Amount</span></div><div id="utxo-rows"><div class="empty-row" data-i18n="utxos.empty">No spendable UTXOs</div></div></div>
        </section>

        <section class="view panel hidden" id="send">
          <div class="page-title"><div><h1 data-i18n="send.title">Send</h1><p data-i18n="send.subtitle">Create a Cardano transaction</p></div><span class="badge" data-i18n="send.adaAssets">ADA &amp; native assets</span></div>
          <div class="form-card"><div class="send-grid">
            <div class="recipient-field"><label for="destination" data-i18n="send.payTo">Pay to</label><div class="recipient-control"><input id="destination" spellcheck="false" autocomplete="off" placeholder="addr_test1…"><button id="scan-destination" type="button" data-i18n="send.scan">Scan QR</button></div></div>
            <label><span data-i18n="send.asset">Asset</span><select id="send-asset"></select></label>
            <label><span id="amount-label" data-i18n="send.amount">Amount</span><div class="amount-control"><div class="amount-entry"><input id="amount" type="number" min="0.000001" step="0.000001" autocomplete="off" placeholder="10"><small id="amount-unit">ADA</small></div><button id="max-amount" type="button" data-i18n="send.max">Max</button></div></label>
            <label id="attached-ada-row" class="hidden"><span data-i18n="send.attachedAda">Attached ADA (optional)</span><div class="amount-entry"><input id="attached-ada" type="number" min="0" step="0.000001" autocomplete="off" placeholder="0"><small>ADA</small></div></label>
          </div>
          <div class="row actions"><button class="primary" id="build" data-i18n="send.create">Create Transaction</button><button id="download-tx" disabled data-i18n="send.export">Export for Signing</button></div></div>
          <div class="tx-editor"><h2 data-i18n="send.editor">Transaction editor</h2><pre id="tx-summary" class="summary">No transaction created</pre></div>
        </section>

        <section class="view panel hidden" id="staking">
          <div class="page-title"><div><h1 data-i18n="staking.title">Staking</h1><p data-i18n="staking.subtitle">Delegate with the same M-of-N policy</p></div><span class="badge" id="staking-status-badge">—</span></div>
          <div class="staking-grid">
            <section class="staking-card">
              <h2 data-i18n="staking.account">Stake account</h2>
              <dl class="staking-details">
                <div class="wide"><dt data-i18n="staking.rewardAddress">Reward address</dt><dd><code id="staking-reward-address"></code><button class="copy" id="copy-reward-address" data-i18n="common.copy">Copy</button></dd></div>
                <div><dt data-i18n="staking.state">State</dt><dd id="staking-state">—</dd></div>
                <div><dt data-i18n="staking.delegatedPool">Delegated pool</dt><dd id="staking-pool">—</dd></div>
                <div><dt data-i18n="staking.rewards">Available rewards</dt><dd id="staking-rewards">—</dd></div>
                <div><dt data-i18n="staking.rewardsTotal">Lifetime rewards</dt><dd id="staking-rewards-total">—</dd></div>
                <div><dt data-i18n="staking.withdrawalsTotal">Withdrawn rewards</dt><dd id="staking-withdrawals-total">—</dd></div>
                <div><dt data-i18n="staking.stakedBalance">Balance counting toward stake</dt><dd id="staking-balance">—</dd></div>
              </dl>
              <div class="row actions">
                <button id="withdraw-rewards" class="primary" data-i18n="staking.withdraw" disabled>Withdraw Rewards</button>
                <button id="deregister-stake" data-i18n="staking.deregister" disabled>Undelegate &amp; Refund Deposit</button>
              </div>
              <p class="notice" data-i18n="staking.notice">注册质押凭证需要 2 ADA 押金；解除质押时押金与奖励一起退回。委托、更换质押池、提取奖励和解除质押都需要 M-of-N 签名。</p>
            </section>
            <section class="staking-card">
              <h2 id="staking-form-title" data-i18n="staking.delegateTitle">Delegate to a stake pool</h2>
              <label><span data-i18n="staking.poolId">Pool ID (pool1…)</span><input id="pool-id" spellcheck="false" autocomplete="off" placeholder="pool1…"></label>
              <div class="row actions"><button id="lookup-pool" data-i18n="staking.lookup">Look Up</button></div>
              <div id="pool-preview" class="pool-preview hidden"></div>
              <div class="row actions"><button id="delegate-stake" class="primary" data-i18n="staking.delegate" disabled>Delegate</button></div>
              <p class="notice" data-i18n="staking.poolNotice">粘贴质押池 ID（pool1…）查询费用与饱和度后确认。设备屏幕上会显示质押池公钥哈希，请与质押池官网核对。</p>
            </section>
          </div>
        </section>

        <section class="view panel hidden" id="sign">
          <div class="page-title"><div><h1 data-i18n="sign.title">Signatures</h1><p data-i18n="sign.subtitle">Review, sign and broadcast</p></div><p id="ledger-status">Ledger interface skeleton</p></div>
          <section id="signing-review" class="signing-review hidden" aria-live="polite">
            <div class="signing-review-heading"><div><span data-i18n="review.eyebrow">UNSIGNED TRANSACTION · CBOR</span><h2 data-i18n="review.title">Review before signing</h2></div><span id="review-network"></span></div>
            <div class="signing-review-meta"><div><span data-i18n="review.txid">Transaction ID</span><code id="review-txid"></code></div><div><span data-i18n="review.inputs">Inputs</span><strong id="review-inputs"></strong></div><div><span data-i18n="review.fee">Network fee</span><strong id="review-fee"></strong></div><div><span data-i18n="review.ttl">Valid until slot</span><strong id="review-ttl"></strong></div></div>
            <div id="review-outputs"></div><div id="review-staking" class="signing-review-staking hidden"></div>
            <p id="review-source-status" class="notice"></p>
            <p id="imported-unsigned-warning" class="signing-review-warning hidden"></p>
            <p class="signing-review-warning" data-i18n="review.warning">The computer is not an independent verifier. Compare addresses and amounts with what the Ledger itself displays; reject the signature if a critical detail cannot be verified on the device.</p>
          </section>
          <div class="boundary"><strong id="ledger-name">${ledger.name}</strong><span data-i18n="sign.boundary">Review the transaction on the signing device, then approve it.</span><button id="ledger-sign" data-i18n="sign.ledgerSign">Sign with Ledger</button><label class="button"><span data-i18n="sign.import">Import Transaction</span><input id="import-tx" type="file" accept="application/json,text/plain,.json,.txt,.cbor" hidden></label><label class="button"><span data-i18n="sign.importSigned">Import Signed CBOR</span><input id="import-signed" type="file" accept="text/plain,.txt,.cbor,.json" hidden></label></div>
          <div class="signature-progress"><span class="filled" data-i18n="sign.stepTransaction">1 Transaction</span><i></i><span id="signature-requirement">2 of 3 Signatures</span><i></i><span data-i18n="sign.stepBroadcast">3 Broadcast</span></div>
          <p id="unsigned-expiry-notice" class="unsigned-expiry hidden" data-i18n="sign.expiryNotice">An unsigned transaction is discarded automatically if it receives no valid signature within 10 minutes.</p>
          <div class="sign-grid" id="signature-slots"></div>
          <div class="row actions"><button class="primary" id="merge" data-i18n="sign.finalize">Finalize Transaction</button><button class="cancel-transaction" id="cancel-transaction" disabled data-i18n="sign.cancel">Cancel Transaction</button></div>
          <pre id="merge-summary" class="summary">Waiting for signatures</pre>
          <section id="final-review" class="final-review hidden" aria-live="polite">
            <div class="final-review-heading"><div><span data-i18n="final.eyebrow">FINAL TRANSACTION</span><h2 data-i18n="final.title">Confirm before broadcast</h2></div><span class="verified" data-i18n="final.verified">✓ Witnesses verified</span></div>
            <dl class="final-details">
              <div class="wide"><dt data-i18n="final.txid">Transaction ID</dt><dd><code id="final-txid"></code></dd></div>
              <div class="wide"><dt data-i18n="final.recipient">Receiving address</dt><dd><code id="final-recipient"></code></dd></div>
              <div><dt data-i18n="final.amount">Amount</dt><dd id="final-amount"></dd></div>
              <div id="final-assets-row" class="hidden"><dt data-i18n="final.assets">Assets</dt><dd id="final-assets"></dd></div>
              <div><dt data-i18n="final.fee">Network fee</dt><dd id="final-fee"></dd></div>
              <div id="final-change-address-row" class="wide"><dt data-i18n="final.changeAddress">Change address</dt><dd><code id="final-change-address"></code></dd></div>
              <div id="final-change-row"><dt data-i18n="final.change">Change</dt><dd id="final-change"></dd></div>
              <div id="final-change-assets-row" class="hidden"><dt data-i18n="final.changeAssets">Change assets</dt><dd id="final-change-assets"></dd></div>
              <div id="final-certs-row" class="wide hidden"><dt data-i18n="final.certificates">Certificates</dt><dd id="final-certs"></dd></div>
              <div id="final-withdrawal-row" class="hidden"><dt data-i18n="final.withdrawal">Reward withdrawal</dt><dd id="final-withdrawal"></dd></div>
              <div><dt data-i18n="final.witnesses">VKey witnesses</dt><dd id="final-witnesses"></dd></div>
              <div><dt data-i18n="final.inputs">Inputs</dt><dd id="final-inputs"></dd></div>
              <div><dt data-i18n="final.network">Network</dt><dd id="final-network">Cardano Mainnet</dd></div>
            </dl>
            <label class="confirm-check"><input id="final-confirmed" type="checkbox"><span data-i18n="final.confirm">I verified the transaction ID, receiving address, amount and fee.</span></label>
            <label class="mainnet-confirm hidden" id="mainnet-confirm"><span data-i18n="final.typeMainnet">For Mainnet, type MAINNET to enable broadcast.</span><input id="mainnet-confirm-text" autocomplete="off" spellcheck="false" placeholder="MAINNET"></label>
            <label class="mainnet-confirm hidden" id="passcode-confirm-row"><span data-i18n="final.passcode">Enter the payment password to enable broadcast.</span><input id="final-passcode-text" type="password" autocomplete="off" spellcheck="false" data-i18n-placeholder="final.passcodePlaceholder" placeholder="支付密码"></label>
            <p id="final-source-status" class="notice"></p>
            <div class="final-actions"><button class="primary" id="broadcast" disabled data-i18n="sign.broadcast">Broadcast Transaction</button><span data-i18n="final.warning">Broadcasting is irreversible.</span></div>
          </section>
        </section>
        <footer id="footer">Cardano Sparrow · Local only · Mainnet</footer>
      </main>
    </div>
  </div>
  <dialog id="scan-dialog" class="scan-dialog"><h2 data-i18n="scan.title">Scan receiving address</h2><p data-i18n="scan.hint">Show a Cardano address QR code to your MacBook camera.</p><video id="scan-video" autoplay muted playsinline></video><p id="scan-status" role="status"></p><button id="scan-cancel" type="button" data-i18n="scan.cancel">Cancel</button></dialog>
  <div id="lock-screen" class="lock-screen hidden">
    <div class="lock-card">
      <div class="lock-icon">🔒</div>
      <h1 data-i18n="lock.title">Application locked</h1>
      <p data-i18n="lock.subtitle">Enter the payment password to unlock</p>
      <input id="lock-passcode" type="password" autocomplete="off" spellcheck="false" data-i18n-placeholder="lock.placeholder" placeholder="支付密码">
      <button class="primary" id="unlock" data-i18n="lock.unlock">Unlock</button>
      <p id="lock-error" class="hidden" data-i18n="lock.wrong">Incorrect payment password</p>
      <button id="lock-forgot" class="lock-forgot" data-i18n="lock.forgot">Forgot password? Reset app data</button>
    </div>
  </div>
  <div id="toast" role="status"></div>
`;

if (import.meta.env.DEV) {
  document.querySelector("#sign .boundary")!.insertAdjacentHTML("afterend", `
    <section id="mnemonic-signer" class="boundary mnemonic-boundary hidden">
      <strong data-i18n="mnemonic.title">Preprod mnemonic signer</strong>
      <span data-i18n="mnemonic.notice">仅供无价值的 Preprod 测试使用。绝不要输入存有主网资产的恢复词；输入只留在内存，签名后立即清空。</span>
      <textarea id="mnemonic-input" rows="3" spellcheck="false" autocomplete="off" data-i18n-placeholder="mnemonic.placeholder" placeholder="word1 word2 … word12"></textarea>
      <button id="mnemonic-sign" data-i18n="mnemonic.sign">Sign with Mnemonic</button>
    </section>`);
}

const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
function setNetworkState(next: typeof networkState) {
  networkState = next;
  document.querySelector(".status")!.setAttribute("data-state", next);
  $("network-status").textContent = next === "synced" ? `${activeSource(activeNetwork()) === "koios" ? "Koios" : "Blockfrost"} · ${t("source.synced")}` : t(`network.${next}`);
  $<HTMLButtonElement>("refresh").disabled = next === "syncing";
}
function selectedNetwork(): CardanoNetwork {
  return $<HTMLSelectElement>("wallet-network").value as CardanoNetwork;
}
function activeNetwork(): CardanoNetwork {
  return descriptor?.network ?? selectedNetwork();
}
function updateNetworkUi() {
  const network = activeNetwork();
  const label = `Cardano ${networkConfig(network).label}`;
  $("network-name").textContent = label;
  $("final-network").textContent = label;
  $("footer").textContent = `Cardano Sparrow · ${currentLocale() === "zh" ? "仅本机" : "Local only"} · ${networkConfig(network).label}`;
  $<HTMLInputElement>("destination").placeholder = network === "mainnet" ? "addr1…" : "addr_test1…";
  $("mainnet-confirm").classList.toggle("hidden", network !== "mainnet");
  document.getElementById("mnemonic-signer")?.classList.toggle("hidden", network !== "preprod");
  $("mainnet-warning").classList.toggle("hidden", selectedNetwork() !== "mainnet");
  updateBroadcastEnabled();
}
function updateBroadcastEnabled() {
  const confirmed = $<HTMLInputElement>("final-confirmed").checked;
  const typed = activeNetwork() !== "mainnet" || $<HTMLInputElement>("mainnet-confirm-text").value === "MAINNET";
  const passcodeReady = !hasPasscode() || $<HTMLInputElement>("final-passcode-text").value.length > 0;
  $<HTMLButtonElement>("broadcast").disabled = !confirmed || !typed || !passcodeReady || !mergedTx || !!broadcastHash;
}

// Refresh every passcode-dependent surface (header lock button, settings
// block, broadcast gate) after the record changes.
let sourceProof: { hash: string; run: number; time: string } | null = null;
function renderSourceProof() {
  const config = sourceSettings();
  const checked = sourceProof?.hash === unsigned?.txBodyHashHex && sourceProof?.run === syncRun;
  const message = !config.verify || !config[activeNetwork()] ? t("source.single")
    : checked ? t("source.checked", { time: sourceProof!.time }) : t("source.pending");
  for (const id of ["review-source-status", "final-source-status"]) $(id).textContent = message;
}
async function verifyBeforeAction(pkg: UnsignedPackage) {
  if (!descriptor) throw new Error("请先打开对应钱包");
  const current = descriptor, run = syncRun;
  sourceProof = null;
  renderSourceProof();
  if (sourceSettings().verify && sourceSettings()[pkg.network]) toast(t("source.checking"));
  const verified = await verifyPackageSources(pkg, current, utxos, stakingContext());
  assertSyncedWallet(current, run);
  if (unsigned !== pkg) throw new Error("待签交易已变化，请重新核对");
  validateForActiveWallet(pkg);
  if (verified) sourceProof = { hash: pkg.txBodyHashHex, run, time: new Date().toLocaleTimeString() };
  renderSourceProof();
}
function renderSourceSettings() {
  const config = sourceSettings();
  $<HTMLSelectElement>("source-mode").value = config.mode;
  $<HTMLInputElement>("bf-mainnet").value = config.mainnet;
  $<HTMLInputElement>("bf-preprod").value = config.preprod;
  $<HTMLInputElement>("source-verify").checked = config.verify;
}

function renderPasscodeUi() {
  const enabled = hasPasscode();
  $("lock-app").classList.toggle("hidden", !enabled);
  $("passcode-current-row").classList.toggle("hidden", !enabled);
  $("passcode-remove").classList.toggle("hidden", !enabled);
  $("passcode-save").textContent = t(enabled ? "passcode.change" : "passcode.save");
  $("passcode-confirm-row").classList.toggle("hidden", !enabled);
  if (!enabled) $<HTMLInputElement>("final-passcode-text").value = "";
  updateBroadcastEnabled();
}

function showLockScreen() {
  stopAddressScanner();
  $<HTMLInputElement>("final-passcode-text").value = "";
  $<HTMLInputElement>("final-confirmed").checked = false;
  updateBroadcastEnabled();
  // Never leave a half-typed recovery phrase behind the lock overlay.
  const mnemonic = document.querySelector<HTMLTextAreaElement>("#mnemonic-input");
  if (mnemonic) mnemonic.value = "";
  $<HTMLInputElement>("lock-passcode").value = "";
  $("lock-error").classList.add("hidden");
  $("lock-screen").classList.remove("hidden");
  $<HTMLInputElement>("lock-passcode").focus();
}

async function attemptUnlock() {
  const value = $<HTMLInputElement>("lock-passcode").value;
  if (!value) return;
  if (await verifyPasscode(value)) {
    $("lock-screen").classList.add("hidden");
    $<HTMLInputElement>("lock-passcode").value = "";
    $("lock-error").classList.add("hidden");
  } else {
    $<HTMLInputElement>("lock-passcode").value = "";
    $("lock-error").classList.remove("hidden");
    $<HTMLInputElement>("lock-passcode").focus();
  }
}
function applyLocale() {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => { element.textContent = t(element.dataset.i18n!); });
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((element) => { element.title = t(element.dataset.i18nTitle!); });
  document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((element) => { element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder!)); });
  document.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((element) => { element.setAttribute("aria-label", t(element.dataset.i18nAria!)); });
  document.querySelector("nav")?.setAttribute("aria-label", t("nav.label"));
  $("locale-toggle").textContent = currentLocale() === "zh" ? "English" : "中文";
  setNetworkState(networkState);
  $("ledger-name").textContent = t("ledger.name");
  $("ledger-status").textContent = ledger.isSupported() ? t("ledger.available") : t("ledger.unavailable");
if (hasPasscode()) showLockScreen();
  const total = descriptor?.cosigners.length ?? draftCosigners.length;
  const thresholdValue = $<HTMLInputElement>("threshold").value.trim();
  const required = descriptor?.threshold ?? (thresholdValue || "—");
  $("signature-requirement").textContent = t("sign.requirement", { threshold: required, total });
  updatePolicyUi();
  renderWalletTabs();
  renderAddresses();
  renderUtxos();
  renderAssets();
  renderSendAssetOptions();
  renderPasscodeUi();
  renderStaking();
  renderPoolPreview();
  renderTransactions();
  renderPortfolio();
  renderTransactionSummary();
  renderSigningReview();
  renderMergeSummary();
  renderFinalReview(false);
  updateNetworkUi();
}
function switchView(id: string, selected?: HTMLButtonElement) {
  if (id !== "send") stopAddressScanner();
  document.querySelectorAll<HTMLElement>(".view").forEach((view) => view.classList.toggle("hidden", view.id !== id));
  const addressbookMode = id === "addressbook";
  document.querySelector<HTMLElement>(".workbench")?.classList.toggle("addressbook-mode", addressbookMode);
  document.querySelector<HTMLElement>(".content")?.classList.toggle("addressbook-mode", addressbookMode);
  let matched = false;
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    const active = selected ? button === selected : !matched && button.dataset.view === id;
    button.classList.toggle("active", active);
    if (active) matched = true;
  });
}
function setVisible(visible: boolean) {
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => { if (button.dataset.view !== "setup") button.disabled = !visible; });
}

function renderWalletTabs() {
  const root = $("wallet-list");
  const items = wallets.map((wallet) => {
    const shownDescriptor = wallet.id === activeWalletId && descriptor ? descriptor : wallet.descriptor;
    const button = document.createElement("button");
    button.className = `wallet-tab${wallet.id === activeWalletId ? " active" : ""}`;
    const policy = currentLocale() === "zh"
      ? `${shownDescriptor.threshold} / ${shownDescriptor.cosigners.length}`
      : `${shownDescriptor.threshold} of ${shownDescriptor.cosigners.length}`;
    button.innerHTML = `<span class="wallet-icon"><img src="/cardano.svg" alt="Cardano"></span><span></span>`;
    const text = button.lastElementChild as HTMLSpanElement;
    text.textContent = wallet.name;
    const small = document.createElement("small");
    small.textContent = `${policy} · ${networkConfig(shownDescriptor.network).label}`;
    text.append(small);
    button.addEventListener("click", () => loadDescriptor(shownDescriptor, wallet));
    return button;
  });
  if (!activeWalletId) {
    const draft = document.createElement("button");
    draft.className = "wallet-tab active";
    draft.innerHTML = `<span class="wallet-icon"><img src="/cardano.svg" alt="Cardano"></span><span></span>`;
    const text = draft.lastElementChild as HTMLSpanElement;
    text.textContent = walletName || t("wallet.untitled");
    const small = document.createElement("small");
    small.textContent = `${t("wallet.unsaved")} · ${networkConfig(selectedNetwork()).label}`;
    text.append(small);
    draft.addEventListener("click", () => switchView("setup"));
    items.push(draft);
  }
  root.replaceChildren(...items);
  $<HTMLButtonElement>("remove-wallet").disabled = !activeWalletId || !wallets.some((wallet) => wallet.id === activeWalletId);
}

function saveWallets() {
  localStorage.setItem(WALLETS_STORAGE_KEY, JSON.stringify(wallets));
  if (activeWalletId) localStorage.setItem(ACTIVE_WALLET_KEY, activeWalletId);
  else localStorage.removeItem(ACTIVE_WALLET_KEY);
  renderWalletTabs();
}

// Browsers restore previous form values when a tab or app session comes back;
// the send form and mnemonic box must never survive a restart or wallet switch.
function clearTransientInputs() {
  for (const id of ["destination", "amount", "attached-ada", "mnemonic-input", "pool-id"]) {
    const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
    if (field) field.value = "";
  }
  sendAssetKey = "";
  poolPreview = null;
  sendMaxMode = false;
}

function clearWalletState() {
  clearUnsignedExpiry();
  syncAbort?.abort();
  syncRun++;
  descriptor = null;
  addresses = [];
  utxos = [];
  assetBalances = [];
  stakeState = null;
  assetMetaByUnit = new Map();
  assetQuotes = {};
  sendAssetKey = "";
  transactions = [];
  $<HTMLDialogElement>("transaction-detail").close();
  usedAddressIndexes = new Set();
  walletSynced = false;
  syncedTipSlot = null;
  unsigned = null;
  unsignedImported = false;
  unsignedHasSignature = false;
  sendMaxMode = false;
  clearTransientInputs();
  resetFinalized();
  setNetworkState("unsynced");
  setVisible(false);
  renderBalance();
  renderSendAssetOptions();
  renderSignatureSlots(draftCosigners.length, false);
  $("tx-summary").textContent = t("send.none");
  renderSigningReview();
  $<HTMLButtonElement>("download-tx").disabled = true;
}

function newWallet() {
  activeWalletId = null;
  walletName = t("wallet.defaultName");
  draftCosigners = Array.from({ length: 3 }, (_, index) => ({ name: `Signer ${index + 1}`, accountXpub: "" }));
  activeKeystoreIndex = 0;
  $<HTMLInputElement>("wallet-name").value = walletName;
  $<HTMLInputElement>("threshold").value = "";
  clearThresholdError();
  $<HTMLInputElement>("gap").value = "20";
  $<HTMLSelectElement>("wallet-network").value = "mainnet";
  clearWalletState();
  renderKeystores();
  renderWalletTabs();
  updateNetworkUi();
  switchView("setup");
}

function removeActiveWallet() {
  const index = wallets.findIndex((wallet) => wallet.id === activeWalletId);
  if (index < 0) return;
  const removing = wallets[index];
  if (!window.confirm(t("wallet.removeConfirm", { name: removing.name }))) return;
  if (!window.confirm(t("wallet.removeConfirmAgain", { name: removing.name }))) return;

  wallets.splice(index, 1);
  activeWalletId = null;
  descriptor = null;
  const next = wallets[Math.min(index, wallets.length - 1)];
  if (next) {
    activeWalletId = next.id;
    saveWallets();
    loadDescriptor(next.descriptor, next);
  } else {
    saveWallets();
    newWallet();
  }
  toast(t("toast.walletRemoved", { name: removing.name }));
}

function updatePolicyUi() {
  const locked = descriptor !== null;
  const threshold = $<HTMLInputElement>("threshold");
  threshold.max = String(draftCosigners.length);
  const raw = threshold.value.trim();
  if (raw && Number(raw) > draftCosigners.length) threshold.value = String(draftCosigners.length);
  const selected = threshold.value.trim() || "—";
  const policy = currentLocale() === "zh" ? `${selected} / ${draftCosigners.length}` : `${selected} of ${draftCosigners.length}`;
  $("policy-badge").textContent = policy;
  $("signer-total").textContent = String(draftCosigners.length);
  $("script-policy").textContent = threshold.value.trim()
    ? (currentLocale() === "zh" ? `原生脚本 · 至少 ${threshold.value}` : `Native Script · atLeast ${threshold.value}`)
    : t("settings.chooseThreshold");
  $("policy-descriptor").textContent = `at_least(${selected}, ${draftCosigners.map((_, index) => `Keystore ${index + 1}`).join(", ")})`;
  threshold.disabled = locked;
  $<HTMLSelectElement>("wallet-network").disabled = locked;
  $<HTMLButtonElement>("remove-signer").disabled = locked || draftCosigners.length === 1;
  $<HTMLButtonElement>("add-signer").disabled = locked || draftCosigners.length === 10;
  $("policy-locked").classList.toggle("hidden", !locked);
  $<HTMLButtonElement>("create").textContent = t(locked ? "settings.applyGap" : "settings.createWallet");
}

function clearThresholdError() {
  const input = $<HTMLInputElement>("threshold");
  input.classList.remove("input-error", "shake");
  input.removeAttribute("aria-invalid");
  $("threshold-error").classList.add("hidden");
}

function requireThreshold() {
  const input = $<HTMLInputElement>("threshold");
  const value = Number(input.value);
  if (input.value.trim() && Number.isInteger(value) && value >= 1 && value <= draftCosigners.length) {
    clearThresholdError();
    return true;
  }
  input.classList.add("input-error");
  input.setAttribute("aria-invalid", "true");
  $("threshold-error").classList.remove("hidden");
  input.classList.remove("shake");
  void input.offsetWidth;
  input.classList.add("shake");
  input.focus();
  return false;
}

function renderKeystores() {
  const root = $("keystores");
  const tabs = $("keystore-tabs");
  activeKeystoreIndex = Math.min(activeKeystoreIndex, draftCosigners.length - 1);
  tabs.replaceChildren(...draftCosigners.map((_, index) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.role = "tab";
    tab.className = index === activeKeystoreIndex ? "active" : "";
    tab.setAttribute("aria-selected", String(index === activeKeystoreIndex));
    tab.textContent = t("settings.keystore", { index: index + 1 });
    tab.addEventListener("click", () => { activeKeystoreIndex = index; renderKeystores(); });
    return tab;
  }));
  const signer = draftCosigners[activeKeystoreIndex];
  const index = activeKeystoreIndex;
  const panel = document.createElement("div");
  panel.className = "keystore-editor";
  panel.setAttribute("role", "tabpanel");
  {
    const label = document.createElement("div");
    const heading = document.createElement("div");
    heading.className = "keystore-heading";
    const title = document.createElement("span");
    const ledgerButton = document.createElement("button");
    const name = document.createElement("input");
    const key = document.createElement("textarea");
    title.textContent = t("settings.keystore", { index: index + 1 });
    ledgerButton.type = "button";
    ledgerButton.textContent = t("ledger.importKey");
    ledgerButton.disabled = !!descriptor || !ledger.isSupported();
    ledgerButton.addEventListener("click", () => action(async () => {
      const draft = draftCosigners;
      const currentSigner = signer;
      ledgerButton.disabled = true;
      ledgerButton.textContent = t("ledger.connecting");
      try {
        const accountXpub = await ledger.getAccountXpub(0);
        if (descriptor || draftCosigners !== draft || draftCosigners[index] !== currentSigner)
          throw new Error("钱包配置已变化，请重新导入 Ledger 公钥");
        currentSigner.accountXpub = accountXpub;
        renderKeystores();
        toast(t("toast.ledgerImported", { index: index + 1 }));
      } finally {
        ledgerButton.disabled = !!descriptor || !ledger.isSupported();
        ledgerButton.textContent = t("ledger.importKey");
      }
    }));
    name.value = signer.name;
    name.setAttribute("aria-label", t("settings.cosignerName", { index: index + 1 }));
    key.value = signer.accountXpub;
    key.rows = 4;
    key.spellcheck = false;
    key.disabled = !!descriptor;
    key.placeholder = "acct_shared_xvk1…";
    name.addEventListener("input", () => { draftCosigners[index].name = name.value; });
    key.addEventListener("input", () => { draftCosigners[index].accountXpub = key.value; });
    heading.append(title, ledgerButton);
    const type = document.createElement("div");
    type.className = "keystore-type";
    type.innerHTML = `<span>${t("settings.type")}</span><strong>${t("wallet.watchOnly")}</strong>`;
    const nameRow = document.createElement("label");
    nameRow.className = "keystore-field";
    nameRow.innerHTML = `<span>${t("settings.label")}</span>`;
    nameRow.append(name);
    const keyRow = document.createElement("label");
    keyRow.className = "keystore-field wide";
    keyRow.innerHTML = `<span>${t("settings.accountXpub")}</span>`;
    keyRow.append(key);
    label.append(heading, type, nameRow, keyRow);
    panel.append(label);
  }
  root.replaceChildren(panel);
  updatePolicyUi();
}

function renderSignatureSlots(count: number, preserve = true) {
  const previous = preserve ? [...document.querySelectorAll<HTMLTextAreaElement>("[data-signature]")].map((field) => field.value) : [];
  $("signature-slots").replaceChildren(...Array.from({ length: count }, (_, index) => {
    const card = document.createElement("section");
    card.className = "signature-card";
    const heading = document.createElement("div");
    heading.className = "signature-card-heading";
    const title = document.createElement("strong");
    const status = document.createElement("span");
    title.textContent = t("sign.signature", { index: index + 1 });
    status.dataset.signatureStatus = "";
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = t("sign.advancedCbor");
    const field = document.createElement("textarea");
    field.dataset.signature = "";
    field.rows = 6;
    field.spellcheck = false;
    field.placeholder = t("sign.signedPlaceholder");
    field.value = previous[index] ?? "";
    field.addEventListener("input", () => { resetFinalized(); updateSignatureStatus(); });
    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "signed-cbor-export";
    exportButton.dataset.exportSignature = "";
    exportButton.textContent = t("sign.exportSigned");
    exportButton.disabled = true;
    exportButton.addEventListener("click", () => action(() => {
      if (!unsigned) throw new Error("请先构造或导入签名包");
      const signedHex = field.value.trim();
      validateSignedTransaction(unsigned.txCborHex, signedHex);
      download(`${unsigned.txBodyHashHex}-signature-${index + 1}.cbor.txt`, `${signedHex}\n`, "text/plain;charset=utf-8");
    }));
    heading.append(title, status);
    details.append(summary, field);
    card.append(heading, details, exportButton);
    return card;
  }));
  updateSignatureStatus();
}

function updateSignatureStatus() {
  const fields = [...document.querySelectorAll<HTMLTextAreaElement>("[data-signature]")];
  const states = [...document.querySelectorAll<HTMLElement>("[data-signature-status]")];
  const exportButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-export-signature]")];
  let validSignatures = 0;
  fields.forEach((field, index) => {
    const filled = !!field.value.trim();
    let state: "empty" | "signed" | "invalid" = filled ? "invalid" : "empty";
    if (filled && unsigned) {
      try { validateSignedTransaction(unsigned.txCborHex, field.value); state = "signed"; validSignatures++; }
      catch { state = "invalid"; }
    }
    states[index].textContent = t(`sign.signature${state[0].toUpperCase()}${state.slice(1)}`);
    states[index].classList.toggle("signed", state === "signed");
    states[index].classList.toggle("invalid", state === "invalid");
    exportButtons[index].disabled = state !== "signed";
  });
  if (validSignatures > 0 && !unsignedHasSignature) {
    unsignedHasSignature = true;
    clearUnsignedExpiry();
    updatePendingTransactionUi();
  }
}

function clearUnsignedExpiry() {
  if (unsignedExpiryTimer !== null) window.clearTimeout(unsignedExpiryTimer);
  unsignedExpiryTimer = null;
}

function updatePendingTransactionUi() {
  const pending = !!unsigned && !mergedTx;
  $("signature-pending-dot").classList.toggle("hidden", !pending);
  $("unsigned-expiry-notice").classList.toggle("hidden", !pending || unsignedHasSignature);
  $<HTMLButtonElement>("cancel-transaction").disabled = !unsigned || !!broadcastHash;
}

function armUnsignedExpiry() {
  clearUnsignedExpiry();
  unsignedHasSignature = false;
  updatePendingTransactionUi();
  unsignedExpiryTimer = window.setTimeout(() => {
    if (unsigned && !unsignedHasSignature) discardTransaction(true);
  }, UNSIGNED_EXPIRY_MS);
}

function discardTransaction(expired = false) {
  clearUnsignedExpiry();
  unsigned = null;
  unsignedImported = false;
  unsignedHasSignature = false;
  resetFinalized();
  renderSignatureSlots(descriptor?.cosigners.length ?? draftCosigners.length, false);
  renderTransactionSummary();
  $<HTMLButtonElement>("download-tx").disabled = true;
  updatePendingTransactionUi();
  if (!$("sign").classList.contains("hidden")) switchView("send");
  toast(t(expired ? "toast.txExpired" : "toast.txCancelled"), expired);
}

function addSignedCbor(value: string) {
  if (!unsigned) throw new Error("请先构造或导入签名包");
  const clean = value.trim();
  const incoming = validateSignedTransaction(unsigned.txCborHex, clean);
  const slots = [...document.querySelectorAll<HTMLTextAreaElement>("[data-signature]")];
  if (slots.some((item) => item.value.trim() === clean)) throw new Error("这个签名交易已经导入");
  const existingHashes = new Set(slots.flatMap((item) => {
    if (!item.value.trim()) return [];
    try { return validateSignedTransaction(unsigned!.txCborHex, item.value).signerHashes; }
    catch { return []; }
  }));
  if (incoming.signerHashes.every((hash) => existingHashes.has(hash)))
    throw new Error("该 Ledger 或签名人的签名已经载入，请使用其他签名设备");
  const target = slots.find((item) => !item.value.trim());
  if (!target) throw new Error("所有签名位都已有内容，请先清空一个");
  target.value = clean;
  resetFinalized();
  updateSignatureStatus();
}

function formDescriptor(): Descriptor {
  return validateDescriptor({
    format: "cardano-hd-multisig",
    version: 1,
    network: selectedNetwork(),
    threshold: Number($<HTMLInputElement>("threshold").value),
    account: 0,
    gapLimit: Number($<HTMLInputElement>("gap").value),
    cosigners: draftCosigners.map((signer) => ({ name: signer.name.trim(), accountXpub: signer.accountXpub.trim() })),
  });
}

function loadDescriptor(next: Descriptor, identity?: Pick<StoredWallet, "id" | "name">) {
  clearUnsignedExpiry();
  syncAbort?.abort();
  syncRun++;
  descriptor = validateDescriptor(next);
  activeWalletId = identity?.id ?? activeWalletId;
  walletName = identity?.name ?? walletName;
  if (identity) localStorage.setItem(ACTIVE_WALLET_KEY, identity.id);
  $<HTMLInputElement>("wallet-name").value = walletName;
  draftCosigners = descriptor.cosigners.map((signer) => ({ ...signer }));
  activeKeystoreIndex = 0;
  renderKeystores();
  $<HTMLInputElement>("threshold").value = String(descriptor.threshold);
  updatePolicyUi();
  $<HTMLInputElement>("gap").value = String(descriptor.gapLimit);
  $<HTMLSelectElement>("wallet-network").value = descriptor.network;
  addresses = deriveAddresses(descriptor);
  utxos = [];
  assetBalances = [];
  assetMetaByUnit = new Map();
  sendAssetKey = "";
  transactions = [];
  $<HTMLDialogElement>("transaction-detail").close();
  usedAddressIndexes = new Set();
  walletSynced = false;
  syncedTipSlot = null;
  setNetworkState("unsynced");
  unsigned = null;
  unsignedImported = false;
  unsignedHasSignature = false;
  sendMaxMode = false;
  clearTransientInputs();
  resetFinalized();
  setVisible(true);
  renderWalletTabs();
  renderSignatureSlots(descriptor.cosigners.length, false);
  $("signature-requirement").textContent = t("sign.requirement", { threshold: descriptor.threshold, total: descriptor.cosigners.length });
  renderAddresses();
  renderBalance();
  renderSendAssetOptions();
  updateNetworkUi();
  switchView("wallet");
  $("tx-summary").textContent = t("send.none");
  renderSigningReview();
  $<HTMLButtonElement>("download-tx").disabled = true;
  toast(t("toast.derived", { count: addresses.length }));
  void action(() => syncWallet(false));
}

function renderAddresses() {
  const root = $("addresses");
  const receive = walletSynced ? nextReceiveAddress(addresses, usedAddressIndexes) : undefined;
  const receiveAddress = receive?.address;
  $("next-address").textContent = receiveAddress ?? (addresses.length ? t("receive.waiting") : t("receive.createFirst"));
  $("receive-index").textContent = receive ? `${t("receive.address")} #${receive.index}` : t("receive.address");
  $("receive-state").textContent = walletSynced ? t("receive.nextUnused") : t("receive.unsynced");
  $("receive-hint").textContent = walletSynced ? t("receive.syncedHint") : t("receive.unsyncedHint");
  $<HTMLButtonElement>("copy-next").disabled = !receive;
  const totalAddresses = addresses.length;
  $("address-count").textContent = currentLocale() === "zh" ? `${totalAddresses} ${t("common.addresses")}` : `${totalAddresses} address${totalAddresses === 1 ? "" : "es"}`;
  const canvas = $<HTMLCanvasElement>("receive-qr");
  if (receiveAddress) {
    void QRCode.toCanvas(canvas, receiveAddress, { width: 220, margin: 1, color: { dark: "#17243b", light: "#ffffff" } });
  } else {
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }
  const rows = (items: DerivedAddress[], used: Set<number>, next?: DerivedAddress) => items.map((item) => {
    const row = document.createElement("div");
    row.className = "tr";
    const value = utxos.filter((u) => u.derivationIndex === item.index).reduce((sum, u) => sum + u.lovelace, 0n);
    const status = !walletSynced ? "unknown" : used.has(item.index) ? "used" : item.index === next?.index ? "next" : "unused";
    row.innerHTML = `<span>#${item.index}</span><code></code><span>${ada(value)} ADA</span><span class="address-status ${status}">${t(`status.${status}`)}</span><button class="copy">${t("common.copy")}</button>`;
    row.querySelector("code")!.textContent = item.address;
    row.querySelector("button")!.addEventListener("click", () => action(async () => { await copyText(item.address); toast(t("toast.addressCopied")); }));
    return row;
  });
  root.replaceChildren(...rows(addresses, usedAddressIndexes, receive));
}

function renderBalance() {
  const utxoAda = utxos.reduce((sum, u) => sum + u.lovelace, 0n);
  const rewards = stakeState?.rewardsLovelace ?? 0n;
  const total = utxoAda + rewards;
  $("balance-label").textContent = t(stakeState ? "balance.total" : "balance.available");
  $("balance").innerHTML = `<img class="balance-coin-icon" src="/ada.svg" alt=""> ${ada(total)} <small>ADA</small>`;
  $("balance").title = stakeState ? t("balance.breakdown", { utxo: ada(utxoAda), rewards: ada(rewards) }) : "";
  $("side-balance").textContent = `${ada(total)} ADA`;
  $("utxo-count").textContent = String(utxos.length);
  $("asset-count").textContent = String(visibleAssets().length + (total > 0n ? 1 : 0));
  renderPortfolio();
  renderAddresses();
  renderUtxos();
  renderAssets();
  renderTransactions();
}

function renderPortfolio() {
  $("portfolio-label").textContent = t("portfolio.total");
  $("fiat-currency").textContent = fiatCurrency === "usd" ? "USD" : "RMB";
  if (!descriptor || descriptor.network !== "mainnet") {
    $("portfolio-value").textContent = "—";
    $("portfolio-note").textContent = t("portfolio.preprod");
    return;
  }
  const prices = freshPrices();
  const rate = prices?.[fiatCurrency === "usd" ? "adaUsd" : "adaCny"] ?? null;
  const adaAmount = utxos.reduce((sum, u) => sum + u.lovelace, 0n) + (stakeState?.rewardsLovelace ?? 0n);
  let total = estimate(adaAmount, 6, rate);
  let partial = total === null;
  let unpriced = 0;
  const tokenSources = new Set<string>();
  for (const asset of assetBalances) {
    const value = assetFiatValue(asset, prices);
    if (value === null) { partial = true; unpriced++; }
    else {
      total = (total ?? 0) + value;
      if (!isVerifiedNight(asset.policyId, asset.assetNameHex)) {
        const quote = assetQuotes[`${asset.policyId}${asset.assetNameHex}`];
        if (quote) tokenSources.add(quote.source);
      }
    }
  }
  $("portfolio-value").textContent = formatFiat(total, fiatCurrency);
  const sources = [prices?.source, ...tokenSources].filter(Boolean).join(" + ");
  $("portfolio-note").textContent = `${sources || t("portfolio.unavailable")} · ${unpriced ? t("portfolio.unpriced", { count: unpriced }) : t(partial ? "portfolio.partial" : "portfolio.reference")}`;
}

function assetFiatValue(asset: AssetBalance, prices: FiatPrices | null): number | null {
  if (isVerifiedNight(asset.policyId, asset.assetNameHex))
    return estimate(asset.quantity, 6, prices?.[fiatCurrency === "usd" ? "nightUsd" : "nightCny"] ?? null);
  const meta = assetMetaFor(assetKey(asset.policyId, asset.assetNameHex));
  if (!isListedAsset(asset.policyId, asset.assetNameHex, meta)) return null;
  const decimals = assetDecimals(asset.policyId, asset.assetNameHex, meta);
  return decimals === null ? null : estimateDexValue(asset.quantity, decimals,
    assetQuotes[`${asset.policyId}${asset.assetNameHex}`], fiatCurrency, prices);
}

async function refreshPrices(run: number) {
  if (descriptor?.network !== "mainnet") return;
  await loadPrices();
  if (run !== syncRun) return;
  renderPortfolio();
  renderAssets();
}

function monogram(key: string): string {
  const name = assetDisplayLines(key).name;
  const character = /[a-z0-9]/i.exec(name)?.[0] ?? "◆";
  const hue = [...key].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
  const element = document.createElement("span");
  element.className = "asset-monogram";
  element.style.background = `linear-gradient(135deg, hsl(${hue} 55% 46%), hsl(${(hue + 40) % 360} 55% 38%))`;
  element.textContent = character.toUpperCase();
  return element.outerHTML;
}

function visibleAssets() {
  return assetBalances.filter((asset) => !hideUnlistedAssets ||
    isListedAsset(asset.policyId, asset.assetNameHex, assetMetaFor(assetKey(asset.policyId, asset.assetNameHex))));
}

function renderAssets() {
  const section = $("asset-section");
  const root = $("asset-rows");
  const shown = visibleAssets();
  $("asset-count").textContent = String(shown.length + (utxos.some((utxo) => utxo.lovelace > 0n) ? 1 : 0));
  if (!shown.length) {
    section.classList.add("hidden");
    root.replaceChildren();
    return;
  }
  section.classList.remove("hidden");
  const rows = shown.map((asset) => {
    const key = assetKey(asset.policyId, asset.assetNameHex);
    const meta = assetMetaFor(key);
    const display = assetDisplayLines(key);
    const row = document.createElement("div");
    row.className = "tr asset-row";
    const iconSrc = isVerifiedNight(asset.policyId, asset.assetNameHex) ? "/night.png" :
      isUsdcx(asset.policyId, asset.assetNameHex) ? "/usdcx.png" : meta?.logo ? iconProxyUrl(meta.logo) : null;
    row.innerHTML = `<span class="asset-name-cell"><span class="asset-icon-wrap"></span><span></span></span><code class="asset-fingerprint" title="${display.fingerprint}">${shortFingerprint(display.fingerprint)}</code><code class="asset-policy" title="${asset.policyId}">${asset.policyId.slice(0, 12)}…${asset.policyId.slice(-6)}</code><strong class="asset-quantity">${formatTokenQuantity(asset.quantity, assetDecimals(asset.policyId, asset.assetNameHex, meta))}</strong><span class="asset-actions"></span>`;
    const assetValue = assetFiatValue(asset, freshPrices());
    if (assetValue !== null) {
      const fiat = document.createElement("small");
      fiat.className = "asset-fiat";
      fiat.textContent = formatFiat(assetValue, fiatCurrency);
      row.querySelector(".asset-quantity")?.append(fiat);
    }
    const iconWrap = row.querySelector<HTMLElement>(".asset-icon-wrap")!;
    iconWrap.innerHTML = monogram(key);
    if (iconSrc) {
      const icon = document.createElement("img");
      icon.className = "asset-icon";
      icon.alt = "";
      icon.decoding = "async";
      // The monogram stays until the remote icon loads successfully.
      icon.addEventListener("load", () => iconWrap.replaceChildren(icon));
      icon.src = iconSrc;
    }
    const nameSpan = row.querySelector<HTMLElement>(".asset-name-cell span:last-child")!;
    const nameLine = document.createElement("b");
    nameLine.textContent = display.name;
    nameSpan.append(nameLine);
    if (meta?.ticker) {
      const ticker = document.createElement("small");
      ticker.textContent = meta.ticker;
      nameSpan.append(ticker);
    }
    if (meta?.decimals !== null && meta?.decimals !== undefined) {
      const decimals = document.createElement("small");
      decimals.textContent = `${meta.decimals} dp`;
      nameSpan.append(decimals);
    }
    const actions = row.querySelector<HTMLElement>(".asset-actions")!;
    const copyButton = document.createElement("button");
    copyButton.className = "copy";
    copyButton.textContent = t("common.copy");
    copyButton.addEventListener("click", () => action(async () => {
      await copyText(`${display.fingerprint}\n${asset.policyId}`);
      toast(t("toast.assetCopied", { name: display.name }));
    }));
    const sendButton = document.createElement("button");
    sendButton.textContent = t("assets.send");
    sendButton.addEventListener("click", () => {
      sendAssetKey = key;
      renderSendAssetOptions();
      $<HTMLInputElement>("amount").value = "";
      sendMaxMode = false;
      switchView("send");
    });
    actions.append(sendButton, copyButton);
    return row;
  });
  root.replaceChildren(...rows);
}

async function refreshAssetMeta(run: number) {
  if (!descriptor || !assetBalances.length) return;
  let selectedKey = "";
  let previousDecimals: number | null = null;
  const missing = assetBalances
    .filter((asset) => !assetMetaByUnit.has(assetKey(asset.policyId, asset.assetNameHex)))
    .slice(0, MAX_META_ASSETS);
  if (!missing.length) return;
  try {
    const rows = await fetchAssetInfo(descriptor.network, missing);
    if (run !== syncRun) return;
    selectedKey = sendAssetKey;
    previousDecimals = selectedKey ? decimalsForAssetKey(selectedKey) : null;
    const rowByUnit = new Map(rows.map((row) => [
      `${String(row.policy_id ?? "").toLowerCase()}.${String(row.asset_name ?? "").toLowerCase()}`,
      row,
    ]));
    for (const asset of missing) {
      const key = assetKey(asset.policyId, asset.assetNameHex);
      assetMetaByUnit.set(key, resolveAssetMeta(asset.policyId, asset.assetNameHex, rowByUnit.get(key)));
    }
  } catch {
    if (run !== syncRun) return;
    selectedKey = sendAssetKey;
    previousDecimals = selectedKey ? decimalsForAssetKey(selectedKey) : null;
    // Names/icons are cosmetic; failures leave fingerprints in place.
    for (const asset of missing) {
      const key = assetKey(asset.policyId, asset.assetNameHex);
      assetMetaByUnit.set(key, resolveAssetMeta(asset.policyId, asset.assetNameHex, undefined));
    }
  }
  if (selectedKey && selectedKey === sendAssetKey && previousDecimals !== decimalsForAssetKey(selectedKey)) {
    $<HTMLInputElement>("amount").value = "";
    sendMaxMode = false;
    toast(currentLocale() === "zh" ? "资产小数位已更新，请重新输入发送数量" : "Token decimals changed. Re-enter the send amount.");
  }
  renderAssets();
  renderTransactions();
  renderSendAssetOptions();
}

async function refreshAssetQuotes(run: number) {
  if (descriptor?.network !== "mainnet") return;
  const ids = assetBalances.filter((asset) => !isVerifiedNight(asset.policyId, asset.assetNameHex) &&
    isListedAsset(asset.policyId, asset.assetNameHex, assetMetaFor(assetKey(asset.policyId, asset.assetNameHex))) &&
    (isUsdcx(asset.policyId, asset.assetNameHex) || assetMetaFor(assetKey(asset.policyId, asset.assetNameHex))?.decimals != null))
    .map((asset) => `${asset.policyId}${asset.assetNameHex}`);
  const quotes = await loadDexQuotes(ids);
  if (run !== syncRun) return;
  assetQuotes = quotes;
  renderPortfolio();
  renderAssets();
}

function txAssetName(asset: AssetUnit): string {
  const name = assetDisplayLines(assetKey(asset.policyId, asset.assetNameHex)).name;
  return !isVerifiedNight(asset.policyId, asset.assetNameHex) && (name === "ADA" || name === "NIGHT")
    ? `${name} (CNT)` : name;
}

function txIcon(asset: AssetUnit | null): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "tx-coin-icon";
  const source = asset === null ? "/ada.svg" : isVerifiedNight(asset.policyId, asset.assetNameHex) ? "/night.png" :
    isUsdcx(asset.policyId, asset.assetNameHex) ? "/usdcx.png" :
    assetMetaFor(assetKey(asset.policyId, asset.assetNameHex))?.logo;
  const url = typeof source === "string" ? source : source ? iconProxyUrl(source) : null;
  const fallback = () => { wrap.textContent = asset === null ? "₳" : "◆"; };
  if (url) {
    const img = document.createElement("img");
    img.alt = "";
    img.addEventListener("error", fallback, { once: true });
    img.src = url;
    wrap.append(img);
  } else fallback();
  return wrap;
}

function txAmount(asset: AssetUnit | null, quantity: bigint): HTMLElement {
  const amount = document.createElement("span");
  amount.className = `tx-amount ${quantity < 0n ? "sent" : "received"}`;
  const positive = quantity < 0n ? -quantity : quantity;
  const decimals = asset === null ? 6 : assetDecimals(asset.policyId, asset.assetNameHex, assetMetaFor(assetKey(asset.policyId, asset.assetNameHex)));
  const value = formatTokenQuantity(positive, decimals);
  const label = asset === null ? "ADA" : txAssetName(asset);
  amount.append(txIcon(asset), document.createTextNode(`${quantity < 0n ? "−" : "+"}${value} ${label}`));
  if (asset) amount.title = `${asset.policyId}.${asset.assetNameHex}`;
  return amount;
}

function openTransactionDetail(transaction: WalletTransaction) {
  const root = $("transaction-detail-content");
  const sideHtml = (items: TransactionSide[]) => items.map((side, index) => {
    const assets = side.assets.map((asset) => `<small>${formatTokenQuantity(asset.quantity, assetDecimals(asset.policyId, asset.assetNameHex, assetMetaFor(assetKey(asset.policyId, asset.assetNameHex))))} ${escapeHtml(txAssetName(asset))}</small>`).join("");
    return `<div class="tx-detail-side"><div><b>#${index + 1}</b><span>${t(side.owned ? "transactions.owned" : "transactions.external")}</span></div><code>${side.address ? escapeHtml(side.address) : t("transactions.addressUnknown")}</code><p>${ada(side.lovelace)} ADA ${assets}</p></div>`;
  }).join("");
  root.innerHTML = `<h2>${t("transactions.details")}</h2><p class="tx-detail-status">${t("transactions.confirmed")} · ${new Date(transaction.blockTime * 1000).toLocaleString(currentLocale() === "zh" ? "zh-CN" : "en-US")}</p><div class="tx-detail-amounts"></div><div class="tx-detail-meta"><div><span>${t("transactions.network")}</span><strong>${activeNetwork() === "mainnet" ? "Cardano Mainnet" : "Preprod"}</strong></div><div><span>${t("transactions.block")}</span><strong>#${transaction.blockHeight}</strong></div><div><span>${t("transactions.fee")}</span><strong>${transaction.feeLovelace === null ? "—" : `${ada(transaction.feeLovelace)} ADA`}</strong></div></div><div class="tx-detail-hash"><span>${t("transactions.openExplorer")}</span><a target="_blank" rel="noopener noreferrer" href="${networkConfig(activeNetwork()).explorer}/transaction/${transaction.txHash}">${transaction.txHash} ↗</a></div><p class="tx-detail-note">${t("transactions.note")}</p><h3>${t("transactions.outputs")}</h3>${sideHtml(transaction.outputs)}<h3>${t("transactions.inputs")}</h3>${sideHtml(transaction.inputs)}`;
  const amounts = root.querySelector(".tx-detail-amounts")!;
  for (const asset of transaction.assets) amounts.append(txAmount(asset, asset.quantity));
  if (transaction.netLovelace !== 0n || !transaction.assets.length) amounts.append(txAmount(null, transaction.netLovelace));
  $<HTMLDialogElement>("transaction-detail").showModal();
}

function renderTransactions() {
  const root = $("transaction-history");
  if (!transactions.length) {
    root.innerHTML = `<div class="empty-state"><span>▤</span><strong>${t("transactions.empty")}</strong><p>${t("transactions.emptyHint")}</p></div>`;
    return;
  }
  const table = document.createElement("div");
  table.className = "table transaction-table";
  table.innerHTML = `<div class="tr head"><span>${t("transactions.date")}</span><span>${t("transactions.type")}</span><span>${t("transactions.hash")}</span><span>${t("transactions.amount")}</span><span>${t("transactions.block")}</span><span>${t("transactions.status")}</span></div>`;
  for (const transaction of transactions) {
    const row = document.createElement("div");
    row.className = "tr";
    const date = new Intl.DateTimeFormat(currentLocale() === "zh" ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(transaction.blockTime * 1000));
    row.classList.add("tx-clickable");
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.innerHTML = `<span></span><span class="tx-type"><span class="tx-type-icon"></span><span class="tx-direction ${transaction.direction}">${t(`transactions.${transaction.direction}`)}</span></span><span class="tx-hash-preview"></span><span class="tx-amount-list"></span><span></span><span class="tx-confirmed">${t("transactions.confirmed")}</span>`;
    row.children[0].textContent = date;
    row.children[4].textContent = `#${transaction.blockHeight}`;
    row.querySelector(".tx-type-icon")!.append(txIcon(transaction.assets[0] ?? null));
    row.querySelector(".tx-hash-preview")!.textContent = `${transaction.txHash.slice(0, 14)}…`;
    const amounts = row.querySelector(".tx-amount-list")!;
    for (const asset of transaction.assets) amounts.append(txAmount(asset, asset.quantity));
    if (transaction.netLovelace !== 0n || !transaction.assets.length) amounts.append(txAmount(null, transaction.netLovelace));
    row.addEventListener("click", () => openTransactionDetail(transaction));
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openTransactionDetail(transaction); } });
    row.title = transaction.txHash;
    table.append(row);
  }
  root.replaceChildren(table);
}

async function syncWallet(showToast = true) {
  if (!descriptor) throw new Error("请先创建钱包");
  if (networkState === "syncing") return;
  const currentDescriptor = descriptor;
  const run = ++syncRun;
  syncAbort?.abort();
  const controller = new AbortController();
  syncAbort = controller;
  setNetworkState("syncing");
  walletSynced = false;
  syncedTipSlot = null;
  stakeState = null;
  poolPreview = null;
  renderAddresses();
  try {
    let scanSize = currentDescriptor.gapLimit;
    let scanned: DerivedAddress[];
    let used: Set<number>;
    let result: Awaited<ReturnType<typeof fetchWallet>>;
    while (true) {
      scanned = deriveAddresses({ ...currentDescriptor, gapLimit: scanSize });
      result = await fetchWallet(scanned, currentDescriptor.network, controller.signal);
      if (run !== syncRun || descriptor !== currentDescriptor) return;
      const receiveByAddress = new Map(scanned.map((address) => [address.address, address.index]));
      used = new Set(result.usedAddresses.flatMap((address) => {
        const index = receiveByAddress.get(address);
        return index === undefined ? [] : [index];
      }));
      const required = requiredDiscoverySize(currentDescriptor.gapLimit, used);
      if (required <= scanSize) break;
      if (required > 1000) throw new Error("地址发现超过 1000 个索引，请增大原型扫描上限后重试");
      scanSize = required;
    }
    const chainContext = await fetchChainContext(currentDescriptor.network, controller.signal);
    if (run !== syncRun || descriptor !== currentDescriptor) return;
    addresses = scanned!;
    usedAddressIndexes = used!;
    utxos = result!.utxos;
    assetBalances = result!.assetBalances;
    transactions = result!.transactions;
    keyDepositLovelace = BigInt(chainContext.protocol.stakeAddressDeposit);
    syncedTipSlot = chainContext.tipSlot;
    if (sendMaxMode) {
      sendMaxMode = false;
      $<HTMLInputElement>("amount").value = "";
    }
    walletSynced = true;
    renderBalance();
    setNetworkState("synced");
    void refreshPrices(run).catch(() => { /* Fiat quotes never affect wallet sync. */ });
    void refreshStakingState(run);
    void refreshAssetMeta(run).then(() => {
      if (run !== syncRun) return;
      renderTransactionSummary();
      void refreshAssetQuotes(run);
    });
    if (showToast) toast(t("toast.synced", { index: nextReceiveAddress(addresses, usedAddressIndexes)?.index ?? "-" }));
  } catch (error) {
    if (run !== syncRun || descriptor !== currentDescriptor) return;
    setNetworkState("failed");
    throw error;
  } finally {
    if (run === syncRun) syncAbort = null;
  }
}

async function refreshStakingState(run: number) {
  if (!descriptor || !walletSynced) return;
  const rewardAddress = rewardAddressOf(descriptor);
  $("staking-reward-address").textContent = rewardAddress;
  try {
    const state = await fetchStakingState(descriptor.network, rewardAddress);
    if (run !== syncRun) return;
    stakeState = state;
  } catch {
    if (run !== syncRun) return;
    stakeState = null;
  }
  renderStaking();
  renderBalance();
}

function stakingContext(): StakingContext | undefined {
  if (!stakeState) return undefined;
  return {
    rewardsLovelace: stakeState.rewardsLovelace,
    keyDeposit: stakeState.registered ? (stakeState.depositLovelace ?? keyDepositLovelace) : keyDepositLovelace,
    registered: stakeState.registered,
  };
}
function assertSyncedWallet(expectedDescriptor: Descriptor, expectedRun: number) {
  if (descriptor !== expectedDescriptor || syncRun !== expectedRun || !walletSynced)
    throw new Error("钱包或链上数据已变化，请重新检查并构造交易");
}

function renderStaking() {
  const badge = $("staking-status-badge");
  const stateLabel = $("staking-state");
  const poolLabel = $("staking-pool");
  const rewardsLabel = $("staking-rewards");
  const rewardsTotalLabel = $("staking-rewards-total");
  const withdrawalsTotalLabel = $("staking-withdrawals-total");
  if (!descriptor || !walletSynced) {
    badge.textContent = t("staking.unsynced");
    stateLabel.textContent = "—";
    poolLabel.textContent = "—";
    rewardsLabel.textContent = "—";
    rewardsTotalLabel.textContent = "—";
    withdrawalsTotalLabel.textContent = "—";
    return;
  }
  if (!stakeState) {
    badge.textContent = t("staking.unknown");
    stateLabel.textContent = t("staking.unknown");
    poolLabel.textContent = "—";
    rewardsLabel.textContent = "—";
    rewardsTotalLabel.textContent = "—";
    withdrawalsTotalLabel.textContent = "—";
  } else {
    const delegated = !!stakeState.delegatedPool;
    badge.textContent = stakeState.registered
      ? (delegated ? t("staking.delegated") : t("staking.registered"))
      : t("staking.notRegistered");
    stateLabel.textContent = stakeState.registered
      ? (delegated ? t("staking.stateDelegated") : t("staking.stateRegistered"))
      : t("staking.stateNotRegistered");
    poolLabel.textContent = stakeState.delegatedPool ?? "—";
    rewardsLabel.textContent = `${ada(stakeState.rewardsLovelace)} ADA`;
    rewardsTotalLabel.textContent = stakeState.rewardsTotalLovelace === null
      ? t("staking.unavailable") : `${ada(stakeState.rewardsTotalLovelace)} ADA`;
    withdrawalsTotalLabel.textContent = stakeState.withdrawalsTotalLovelace === null
      ? t("staking.unavailable") : stakeState.withdrawalsTotalLovelace > 0n
        ? `${ada(stakeState.withdrawalsTotalLovelace)} ADA` : t("staking.neverWithdrawn");
  }
  $("staking-balance").textContent = `${ada(utxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n))} ADA`;
  $<HTMLButtonElement>("withdraw-rewards").disabled = !stakeState?.registered || stakeState.rewardsLovelace <= 0n;
  $<HTMLButtonElement>("deregister-stake").disabled = !stakeState?.registered;
  $<HTMLButtonElement>("delegate-stake").disabled = !poolPreview;
  $("staking-form-title").textContent = t(stakeState?.registered ? "staking.changeTitle" : "staking.delegateTitle");
}

function renderPoolPreview() {
  const root = $("pool-preview");
  if (!poolPreview) {
    root.classList.add("hidden");
    root.replaceChildren();
    $<HTMLButtonElement>("delegate-stake").disabled = true;
    return;
  }
  root.classList.remove("hidden");
  const margin = poolPreview.margin !== null ? `${(poolPreview.margin * 100).toFixed(2)}%` : "—";
  const saturation = poolPreview.saturation !== null ? `${(poolPreview.saturation * 100).toFixed(0)}%` : "—";
  root.replaceChildren(...[
    `${t("staking.poolTicker")}: ${poolPreview.ticker ?? "—"}`,
    `${t("staking.poolName")}: ${poolPreview.name ?? "—"}`,
    `${t("staking.poolMargin")}: ${margin}`,
    `${t("staking.poolFixed")}: ${poolPreview.fixedCostLovelace ? ada(BigInt(poolPreview.fixedCostLovelace)) + " ADA" : "—"}`,
    `${t("staking.poolSaturation")}: ${saturation}`,
    poolPreview.retiringEpoch !== null ? t("staking.poolRetiring", { epoch: poolPreview.retiringEpoch }) : "",
  ].filter(Boolean).map((line) => {
    const element = document.createElement("p");
    element.textContent = line;
    return element;
  }));
  $<HTMLButtonElement>("delegate-stake").disabled = false;
}

async function buildStakingPackage(action: Parameters<typeof buildStakingTransaction>[0]["action"]) {
  if (!descriptor) throw new Error("请先创建钱包");
  if (!stakeState) throw new Error("质押状态尚未同步，请刷新后重试");
  const currentDescriptor = descriptor;
  const currentStakeState = stakeState;
  const run = syncRun;
  if (action.type === "deregister" && stakeState.depositLovelace === null)
    throw new Error("无法核对链上质押押金，暂不能安全构建解除质押交易");
  const receive = nextReceiveAddress(addresses, usedAddressIndexes);
  if (!walletSynced || !receive) throw new Error("请先同步钱包，以生成未使用的收款地址");
  const chain = await fetchChainContext(currentDescriptor.network);
  assertSyncedWallet(currentDescriptor, run);
  if (stakeState !== currentStakeState) throw new Error("质押状态已变化，请重新检查交易");
  syncedTipSlot = chain.tipSlot;
  const pkg = buildStakingTransaction({
    descriptor: currentDescriptor,
    addresses,
    utxos,
    receiveAddress: receive.address,
    action,
    rewardsLovelace: currentStakeState.rewardsLovelace,
    keyDeposit: action.type === "deregister" ? currentStakeState.depositLovelace! : keyDepositLovelace,
    protocol: chain.protocol,
    tipSlot: chain.tipSlot,
  });
  unsigned = pkg;
  unsignedImported = false;
  renderSignatureSlots(currentDescriptor.cosigners.length, false);
  resetFinalized();
  armUnsignedExpiry();
  renderTransactionSummary();
  $<HTMLButtonElement>("download-tx").disabled = false;
  toast(t("toast.txBuilt"));
  switchView("sign");
}

function renderUtxos() {
  $("utxo-badge").textContent = currentLocale() === "zh" ? `${utxos.length} ${t("common.outputs")}` : `${utxos.length} output${utxos.length === 1 ? "" : "s"}`;
  const root = $("utxo-rows");
  if (!utxos.length) {
    root.innerHTML = `<div class="empty-row">${t("utxos.empty")}</div>`;
    return;
  }
  root.replaceChildren(...utxos.map((utxo) => {
    const row = document.createElement("div");
    row.className = "tr";
    const assets = utxo.assets ?? [];
    const reference = document.createElement("code");
    reference.textContent = `${utxo.txHash.slice(0, 12)}…#${utxo.txIndex}`;
    const path = document.createElement("span");
    path.textContent = `0/#${utxo.derivationIndex} · ${utxo.address.slice(0, 18)}…`;
    const value = document.createElement("strong");
    value.textContent = `${ada(utxo.lovelace)} ADA`;
    if (assets.length) {
      const chip = document.createElement("span");
      chip.className = "utxo-assets";
      chip.title = assets.map((asset) => describeAssetQuantity(asset.policyId, asset.assetNameHex, asset.quantity.toString())).join(", ");
      chip.textContent = `+${assets.length} ${t("utxos.assetChip")}`;
      value.append(" ", chip);
    }
    row.append(reference, path, value);
    return row;
  }));
}

function ada(value: bigint) { return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0")}`; }
function certificateLabel(certificate: { type: string; poolId?: string }): string {
  if (certificate.type === "register") return t("staking.certRegister");
  if (certificate.type === "deregister") return t("staking.certDeregister");
  return t("staking.certDelegate", { pool: certificate.poolId ?? "" });
}
function parseAdaAmount(text: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new Error("ADA 金额最多 6 位小数");
  const [whole, decimal = ""] = text.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(decimal.padEnd(6, "0"));
}

function renderSendAssetOptions() {
  const select = $<HTMLSelectElement>("send-asset");
  const previous = sendAssetKey;
  const held = assetBalances.map((asset) => assetKey(asset.policyId, asset.assetNameHex));
  if (previous && !held.includes(previous)) sendAssetKey = "";
  const options = [new Option(t("send.assetAda"), ""), ...held.map((key) => {
    const display = assetDisplayLines(key);
    const balance = assetBalances.find((asset) => assetKey(asset.policyId, asset.assetNameHex) === key)!;
    return new Option(`${display.name} · ${shortFingerprint(display.fingerprint, 6)} · ${formatTokenQuantity(balance.quantity, decimalsForAssetKey(key))}`, key);
  })];
  select.replaceChildren(...options);
  select.value = sendAssetKey;
  updateSendAssetUi();
}

function updateSendAssetUi() {
  const tokenMode = !!sendAssetKey;
  const display = tokenMode ? assetDisplayLines(sendAssetKey) : undefined;
  $("attached-ada-row").classList.toggle("hidden", !tokenMode);
  $("amount-label").textContent = tokenMode ? t("send.tokenAmount") : t("send.amount");
  $("amount-unit").textContent = tokenMode ? (display?.name.slice(0, 12) ?? "") : "ADA";
  const amount = $<HTMLInputElement>("amount");
  const tokenDecimals = tokenMode ? decimalsForAssetKey(sendAssetKey) ?? 0 : 0;
  if (tokenMode && tokenDecimals === 0) {
    amount.min = "1";
    amount.step = "1";
    amount.placeholder = "1000";
  } else {
    const unit = tokenMode ? `0.${"0".repeat(tokenDecimals - 1)}1` : "0.000001";
    amount.min = unit;
    amount.step = unit;
    amount.placeholder = "10";
  }
}

function selectedAssetRequest(): { policyId: string; assetNameHex: string; quantity: bigint } | null {
  if (!sendAssetKey) return null;
  const [policyId, assetNameHex] = sendAssetKey.split(".");
  const quantity = parseTokenAmount($<HTMLInputElement>("amount").value, decimalsForAssetKey(sendAssetKey));
  return { policyId, assetNameHex, quantity };
}
function renderTransactionSummary() {
  if (!unsigned) { $("tx-summary").textContent = t("send.none"); renderSigningReview(); return; }
  const assetLines = (output: UnsignedPackage["outputs"][number], label: string) =>
    (output.assets ?? []).map((asset) => `${label.padEnd(16)}${describeAssetQuantity(asset.policyId, asset.assetNameHex, asset.quantity)}`);
  const lines = [
    `Transaction ID  ${unsigned.txBodyHashHex}`,
    `${t("summary.inputs").padEnd(16)}${unsigned.inputs.length} UTXO`,
    `${t("summary.send").padEnd(16)}${ada(BigInt(unsigned.outputs[0].lovelace))} ADA`,
    ...assetLines(unsigned.outputs[0], t("summary.send")),
  ];
  if (unsigned.outputs[1]) {
    lines.push(`${t("summary.change").padEnd(16)}${ada(BigInt(unsigned.outputs[1].lovelace))} ADA`);
    lines.push(...assetLines(unsigned.outputs[1], t("summary.change")));
  }
  if (unsigned.certificates?.length) {
    for (const certificate of unsigned.certificates) {
      lines.push(`${t("summary.certificate").padEnd(16)}${certificateLabel(certificate)}`);
    }
  }
  if (unsigned.withdrawalLovelace) lines.push(`${t("summary.withdrawal").padEnd(16)}${ada(BigInt(unsigned.withdrawalLovelace))} ADA`);
  lines.push(`${t("summary.fee").padEnd(16)}${ada(BigInt(unsigned.feeLovelace))} ADA`,
    `${t("summary.paths").padEnd(16)}${unsigned.signingPaths.join(", ")}`);
  $("tx-summary").textContent = lines.join("\n");
  renderSigningReview();
}
function renderSigningReview() {
  renderSourceProof();
  const root = $("signing-review");
  if (!unsigned) { root.classList.add("hidden"); $("review-outputs").replaceChildren(); $("review-staking").replaceChildren(); return; }
  const importedWarning = $("imported-unsigned-warning");
  importedWarning.classList.toggle("hidden", !unsignedImported);
  importedWarning.textContent = currentLocale() === "zh"
    ? "外部签名包尚无签名来源证明。请在 Ledger 屏幕逐项核对收款地址、金额、找零地址和手续费；无法核对就拒绝签名。"
    : "This imported unsigned package has no signed proof of origin. Check the recipient, amount, change address and fee on the Ledger screen; reject it if you cannot verify them.";
  const pkg = validateUnsignedPackage(unsigned);
  const tx = inspectFinalTransaction(pkg.txCborHex);
  if (tx.txId !== pkg.txBodyHashHex) throw new Error("待签交易 ID 与 CBOR 不一致");
  root.classList.remove("hidden");
  $("review-network").textContent = pkg.network === "mainnet" ? "Mainnet" : "Preprod";
  $("review-txid").textContent = tx.txId;
  $("review-inputs").textContent = String(tx.inputCount);
  $("review-fee").textContent = `${ada(BigInt(tx.feeLovelace))} ADA`;
  $("review-ttl").textContent = tx.ttl ?? "—";
  const outputs = tx.outputs.map((output, index) => {
    const card = document.createElement("article");
    card.className = "signing-review-output";
    const title = document.createElement("strong");
    title.textContent = `${t(index === 0 ? "review.destination" : "review.change")} · #${index + 1}`;
    const address = document.createElement("code");
    address.textContent = output.address;
    const amount = document.createElement("span");
    amount.textContent = `${ada(BigInt(output.lovelace))} ADA`;
    card.append(title, address, amount);
    for (const asset of output.assets) {
      const token = document.createElement("span");
      token.className = "signing-review-token";
      token.textContent = describeAssetQuantity(asset.policyId, asset.assetNameHex, asset.quantity);
      card.append(token);
    }
    return card;
  });
  if (tx.outputs.length === 1) {
    const noChange = document.createElement("p");
    noChange.className = "signing-review-no-change";
    noChange.textContent = t("review.noChange");
    outputs.push(noChange);
  }
  $("review-outputs").replaceChildren(...outputs);
  const staking = $("review-staking");
  const lines = tx.certificates.map(certificateLabel);
  if (tx.withdrawalLovelace) lines.push(`${t("summary.withdrawal")}: ${ada(BigInt(tx.withdrawalLovelace))} ADA`);
  staking.textContent = lines.join("\n");
  staking.classList.toggle("hidden", !lines.length);
}
function renderMergeSummary() {
  if (!mergedTx) { $("merge-summary").textContent = t("sign.waiting"); return; }
  const lines = [
    `Transaction ID  ${transactionId(mergedTx)}`,
    `CBOR bytes      ${mergedTx.length / 2}`,
    `${t("summary.status").padEnd(16)}${t("summary.finalized")}`,
  ];
  if (broadcastHash) lines.push(`${t("summary.broadcast").padEnd(16)}${broadcastHash}`);
  $("merge-summary").textContent = lines.join("\n");
}
function resetFinalized() {
  mergedTx = "";
  broadcastHash = "";
  $("final-review").classList.add("hidden");
  $<HTMLInputElement>("final-confirmed").checked = false;
  $<HTMLInputElement>("final-confirmed").disabled = false;
  $<HTMLInputElement>("mainnet-confirm-text").value = "";
  $<HTMLInputElement>("mainnet-confirm-text").disabled = false;
  $<HTMLInputElement>("final-passcode-text").value = "";
  $<HTMLButtonElement>("broadcast").disabled = true;
  $<HTMLButtonElement>("broadcast").textContent = t("sign.broadcast");
  renderMergeSummary();
  updatePendingTransactionUi();
}
function renderFinalReview(scroll = true) {
  if (!mergedTx) { $("final-review").classList.add("hidden"); return; }
  const final = inspectFinalTransaction(mergedTx);
  if (final.outputs.length < 1 || final.outputs.length > 2) throw new Error("最终交易必须包含一个收款输出和可选找零输出");
  $("final-txid").textContent = final.txId;
  $("final-recipient").textContent = final.outputs[0].address;
  $("final-amount").textContent = `${ada(BigInt(final.outputs[0].lovelace))} ADA`;
  const certificates = final.certificates ?? [];
  $("final-certs-row").classList.toggle("hidden", !certificates.length);
  $("final-certs").textContent = certificates.map(certificateLabel).join("\n");
  $("final-withdrawal-row").classList.toggle("hidden", !final.withdrawalLovelace);
  $("final-withdrawal").textContent = final.withdrawalLovelace ? `${ada(BigInt(final.withdrawalLovelace))} ADA` : "";
  const paymentAssets = final.outputs[0].assets ?? [];
  $("final-assets-row").classList.toggle("hidden", !paymentAssets.length);
  $("final-assets").textContent = paymentAssets.map((asset) => describeAssetQuantity(asset.policyId, asset.assetNameHex, asset.quantity)).join("\n");
  $("final-fee").textContent = `${ada(BigInt(final.feeLovelace))} ADA`;
  const change = final.outputs[1];
  $("final-change-address-row").classList.toggle("hidden", !change);
  $("final-change-row").classList.toggle("hidden", !change);
  $("final-change-address").textContent = change?.address ?? "";
  $("final-change").textContent = change ? `${ada(BigInt(change.lovelace))} ADA` : "";
  const changeAssets = change?.assets ?? [];
  $("final-change-assets-row").classList.toggle("hidden", !changeAssets.length);
  $("final-change-assets").textContent = changeAssets.map((asset) => describeAssetQuantity(asset.policyId, asset.assetNameHex, asset.quantity)).join("\n");
  $("final-witnesses").textContent = String(final.witnessCount);
  $("final-inputs").textContent = String(final.inputCount);
  $("final-network").textContent = `Cardano ${networkConfig(activeNetwork()).label}`;
  $<HTMLInputElement>("final-confirmed").checked = !!broadcastHash;
  $<HTMLInputElement>("final-confirmed").disabled = !!broadcastHash;
  $<HTMLInputElement>("mainnet-confirm-text").disabled = !!broadcastHash;
  $<HTMLButtonElement>("broadcast").textContent = t(broadcastHash ? "sign.broadcasted" : "sign.broadcast");
  $("final-review").classList.remove("hidden");
  updateNetworkUi();
  if (scroll) $("final-review").scrollIntoView({ behavior: "smooth", block: "start" });
}
function download(name: string, value: unknown, contentType = "application/json") {
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([typeof value === "string" ? value : JSON.stringify(value, null, 2)], { type: contentType }));
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// Clipboard writes go through the async API first and fall back to a
// selection-based copy, so buttons work in the sandboxed desktop shell and in
// browsers that withhold the clipboard permission.
async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch { /* fall through to the legacy path */ }
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("复制失败，请长按或手动选中复制");
}

function toast(message: string, error = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = error ? "show error" : "show";
  window.setTimeout(() => el.className = "", 3500);
}
function stopAddressScanner() {
  cameraGeneration++;
  if (cameraTimer !== null) window.clearInterval(cameraTimer);
  cameraTimer = null;
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  $<HTMLVideoElement>("scan-video").srcObject = null;
  const dialog = $<HTMLDialogElement>("scan-dialog");
  if (dialog.open) dialog.close();
}
async function startAddressScanner() {
  stopAddressScanner();
  const generation = cameraGeneration;
  const dialog = $<HTMLDialogElement>("scan-dialog");
  const video = $<HTMLVideoElement>("scan-video");
  const status = $("scan-status");
  status.textContent = t("scan.scanning");
  dialog.showModal();
  try {
    if (window.cardanoCamera) {
      const permission = await window.cardanoCamera.requestPermission();
      if (generation !== cameraGeneration) return;
      if (permission !== "granted") {
        status.textContent = t(permission === "denied" ? "scan.denied" : "scan.blocked");
        return;
      }
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("unavailable");
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    if (generation !== cameraGeneration) { stream.getTracks().forEach((track) => track.stop()); return; }
    cameraStream = stream;
    video.srcObject = stream;
    await video.play();
    const { default: jsQR } = await import("jsqr");
    if (generation !== cameraGeneration) return;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("unavailable");
    cameraTimer = window.setInterval(() => {
      if (!dialog.open || generation !== cameraGeneration) return stopAddressScanner();
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return;
      canvas.width = Math.min(video.videoWidth, 720);
      canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(frame.data, frame.width, frame.height);
      if (!result) return;
      try {
        const address = parseScannedAddress(result.data, activeNetwork());
        stopAddressScanner();
        const input = $<HTMLInputElement>("destination");
        input.value = address;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
        toast(t("scan.filled"));
      } catch {
        status.textContent = t("scan.invalid");
      }
    }, 160);
  } catch (error) {
    if (generation !== cameraGeneration) return;
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    status.textContent = t(error instanceof DOMException && error.name === "NotAllowedError" ? "scan.blocked" : "scan.unavailable");
  }
}
$<HTMLButtonElement>("scan-destination").addEventListener("click", () => void startAddressScanner());
$<HTMLButtonElement>("scan-cancel").addEventListener("click", stopAddressScanner);
$<HTMLDialogElement>("scan-dialog").addEventListener("close", stopAddressScanner);
document.addEventListener("visibilitychange", () => { if (document.hidden) stopAddressScanner(); });
window.addEventListener("pagehide", stopAddressScanner);
async function action(run: () => void | Promise<void>) { try { await run(); } catch (error) { toast(localizeError(error instanceof Error ? error.message : String(error)), true); } }

function validateForActiveWallet(pkgValue: unknown) {
  if (!descriptor) throw new Error("请先打开对应钱包");
  if (!walletSynced) throw new Error("签名前必须先同步当前钱包");
  if (syncedTipSlot === null) throw new Error("缺少可信的链上时隙，请重新同步钱包");
  return validatePackageForWallet(pkgValue, descriptor, addresses, utxos, stakingContext(), syncedTipSlot);
}

async function importWalletFile(file: File) {
  const imported = validateDescriptor(JSON.parse(await readImportFile(file)));
  const id = crypto.randomUUID();
  const name = file.name.replace(/\.json$/i, "") || t("wallet.defaultName");
  const stored = { id, name, descriptor: imported };
  wallets.push(stored);
  activeWalletId = id;
  saveWallets();
  loadDescriptor(imported, stored);
  toast(t("toast.walletImported"));
}

async function readImportFile(file: File) {
  if (file.size > MAX_IMPORT_BYTES) throw new Error("导入文件超过 2 MiB 安全限制");
  return file.text();
}

function parseJsonOrRawCbor(text: string): unknown {
  try { return JSON.parse(text); }
  catch { return text.trim(); }
}

function unsignedPackageFromImportText(text: string) {
  const value = parseJsonOrRawCbor(text);
  if (value && typeof value === "object" && (value as { format?: unknown }).format === "cardano-hd-multisig-tx")
    return validateUnsignedPackage(value);
  if (!descriptor) throw new Error("请先打开对应钱包");
  return unsignedPackageFromTransaction(transactionCborFromImport(value), descriptor, addresses, utxos);
}

renderSourceSettings();
setLocale(currentLocale());
applyLocale();
renderKeystores();
renderSignatureSlots(draftCosigners.length);
$<HTMLButtonElement>("locale-toggle").addEventListener("click", () => {
  setLocale(currentLocale() === "zh" ? "en" : "zh");
  $("toast").className = "";
  renderKeystores();
  if (descriptor) renderSignatureSlots(descriptor.cosigners.length);
  else renderSignatureSlots(draftCosigners.length);
  applyLocale();
});
$<HTMLInputElement>("threshold").addEventListener("input", () => {
  if ($<HTMLInputElement>("threshold").value.trim()) clearThresholdError();
  updatePolicyUi();
});
$<HTMLSelectElement>("wallet-network").addEventListener("change", () => {
  updateNetworkUi();
  renderWalletTabs();
  if (descriptor && selectedNetwork() !== descriptor.network) toast(t("toast.networkChanged"));
});
$<HTMLInputElement>("wallet-name").addEventListener("input", (event) => {
  walletName = (event.target as HTMLInputElement).value;
  renderWalletTabs();
});
$("add-signer").addEventListener("click", () => {
  if (draftCosigners.length >= 10) return;
  draftCosigners.push({ name: `Signer ${draftCosigners.length + 1}`, accountXpub: "" });
  activeKeystoreIndex = draftCosigners.length - 1;
  renderKeystores();
});
$("remove-signer").addEventListener("click", () => {
  if (draftCosigners.length <= 1) return;
  draftCosigners.pop();
  activeKeystoreIndex = Math.min(activeKeystoreIndex, draftCosigners.length - 1);
  renderKeystores();
});
$("create").addEventListener("click", () => {
  if (!descriptor && !requireThreshold()) return;
  action(() => loadDescriptor(formDescriptor()));
});
$("copy-next").addEventListener("click", () => action(async () => {
  const receive = nextReceiveAddress(addresses, usedAddressIndexes);
  if (!walletSynced || !receive) throw new Error("请先完成链上同步");
  await copyText(receive.address);
  toast(t("toast.receiveCopied", { index: receive.index }));
}));
$("save").addEventListener("click", () => action(() => {
  const value = formDescriptor();
  const previous = descriptor;
  walletName = $<HTMLInputElement>("wallet-name").value.trim() || t("wallet.defaultName");
  let stored = wallets.find((item) => item.id === activeWalletId);
  if (!stored) {
    stored = { id: crypto.randomUUID(), name: walletName, descriptor: value };
    wallets.push(stored);
    activeWalletId = stored.id;
  } else {
    stored.name = walletName;
    stored.descriptor = value;
  }
  saveWallets();
  const policy = (item: Descriptor) => JSON.stringify({
    network: item.network, threshold: item.threshold, account: item.account,
    gapLimit: item.gapLimit, cosigners: item.cosigners.map((signer) => signer.accountXpub),
  });
  if (!previous || policy(previous) !== policy(value)) loadDescriptor(value, stored);
  else previous.cosigners.forEach((signer, index) => { signer.name = value.cosigners[index].name; });
  toast(t("toast.saved"));
}));
$("export").addEventListener("click", () => action(() => {
  const value = descriptor ?? formDescriptor();
  download(`cardano-sparrow-${value.network}.json`, value);
}));
$<HTMLInputElement>("import").addEventListener("change", (event) => action(async () => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await importWalletFile(file);
  (event.target as HTMLInputElement).value = "";
}));
$<HTMLInputElement>("top-import").addEventListener("change", (event) => action(async () => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await importWalletFile(file);
  (event.target as HTMLInputElement).value = "";
}));
$("copy-reward-address").addEventListener("click", () => action(async () => {
  const value = $("staking-reward-address").textContent?.trim();
  if (!value) throw new Error("请先完成链上同步");
  await copyText(value);
  toast(t("toast.addressCopied"));
}));
$("lookup-pool").addEventListener("click", () => action(async () => {
  if (!descriptor) throw new Error("请先创建钱包");
  const currentDescriptor = descriptor;
  const run = syncRun;
  poolPreview = null;
  renderPoolPreview();
  const poolId = $<HTMLInputElement>("pool-id").value.trim();
  if (!poolId.startsWith("pool1")) throw new Error("质押池 ID 必须是 pool1 开头的 bech32 格式");
  poolIdToKeyHashHex(poolId);
  const info = await fetchPoolInfo(currentDescriptor.network, poolId);
  if (descriptor !== currentDescriptor || syncRun !== run || $<HTMLInputElement>("pool-id").value.trim() !== poolId)
    throw new Error("钱包或矿池 ID 已变化，请重新查询矿池");
  poolPreview = info;
  if (!poolPreview) throw new Error("未找到该质押池，请核对 ID");
  renderPoolPreview();
}));
$("delegate-stake").addEventListener("click", () => action(async () => {
  if (!descriptor) throw new Error("请先创建钱包");
  if (!walletSynced) throw new Error("请先完成链上同步");
  const poolId = $<HTMLInputElement>("pool-id").value.trim();
  if (!poolPreview || poolPreview.poolId !== poolId) throw new Error("请先查询并确认质押池");
  const registered = stakeState?.registered ?? false;
  if (registered && stakeState?.delegatedPool === poolId) throw new Error("当前已委托该质押池");
  await buildStakingPackage({ type: "delegate", poolId, register: !registered });
}));
$("withdraw-rewards").addEventListener("click", () => action(async () => {
  await buildStakingPackage({ type: "withdraw" });
}));
$("deregister-stake").addEventListener("click", () => action(async () => {
  if (!window.confirm(t("staking.deregisterConfirm"))) return;
  await buildStakingPackage({ type: "deregister" });
}));
$("new-wallet").addEventListener("click", newWallet);
$("remove-wallet").addEventListener("click", removeActiveWallet);
$("refresh").addEventListener("click", () => action(async () => {
  await syncWallet();
}));
$<HTMLInputElement>("amount").addEventListener("input", () => { sendMaxMode = false; });
$<HTMLSelectElement>("send-asset").addEventListener("change", (event) => {
  sendAssetKey = (event.target as HTMLSelectElement).value;
  $<HTMLInputElement>("amount").value = "";
  sendMaxMode = false;
  updateSendAssetUi();
});
$<HTMLInputElement>("destination").addEventListener("input", () => {
  if (!sendMaxMode) return;
  sendMaxMode = false;
  $<HTMLInputElement>("amount").value = "";
});
$("max-amount").addEventListener("click", () => action(async () => {
  if (!descriptor) throw new Error("请先创建钱包");
  if (!walletSynced) throw new Error("请先完成链上同步");
  const destination = $<HTMLInputElement>("destination").value.trim();
  if (!destination) throw new Error("请先输入收款地址");
  if (sendAssetKey) {
    const balance = assetBalances.find((asset) => assetKey(asset.policyId, asset.assetNameHex) === sendAssetKey);
    if (!balance) throw new Error("资产余额不足");
    const amount = $<HTMLInputElement>("amount");
    const decimals = decimalsForAssetKey(sendAssetKey);
    amount.value = formatTokenInput(balance.quantity, decimals);
    if (parseTokenAmount(amount.value, decimals) !== balance.quantity) throw new Error("资产数量写入失败");
    toast(t("toast.maxToken", { quantity: amount.value }));
    return;
  }
  const button = $<HTMLButtonElement>("max-amount");
  const currentDescriptor = descriptor;
  const run = syncRun;
  button.disabled = true;
  try {
    const chain = await fetchChainContext(currentDescriptor.network);
    assertSyncedWallet(currentDescriptor, run);
    if (sendAssetKey || $<HTMLInputElement>("destination").value.trim() !== destination)
      throw new Error("发送内容已变化，请重新计算最大金额");
    const preview = buildUnsignedTransaction({ descriptor: currentDescriptor, addresses, utxos, destination, amountLovelace: 0n, sendMax: true, ...chain });
    $<HTMLInputElement>("amount").value = ada(BigInt(preview.outputs[0].lovelace));
    sendMaxMode = true;
    toast(t("toast.maxCalculated", { amount: ada(BigInt(preview.outputs[0].lovelace)) }));
  } finally {
    button.disabled = false;
  }
}));
$("build").addEventListener("click", () => action(async () => {
  if (!descriptor) throw new Error("请先创建钱包");
  const currentDescriptor = descriptor;
  const run = syncRun;
  const change = nextReceiveAddress(addresses, usedAddressIndexes);
  if (!walletSynced || (!sendMaxMode && !sendAssetKey && !change)) throw new Error("请先同步钱包，以生成未使用的找零地址");
  const asset = sendAssetKey;
  const destination = $<HTMLInputElement>("destination").value.trim();
  const amountText = $<HTMLInputElement>("amount").value;
  const attachedText = $<HTMLInputElement>("attached-ada").value.trim();
  const sendMax = sendMaxMode;
  const assetRequest = asset ? selectedAssetRequest() : null;
  const amountLovelace = asset ? attachedText ? parseAdaAmount(attachedText) : 0n : parseAdaAmount(amountText);
  const button = $<HTMLButtonElement>("build");
  button.disabled = true;
  try {
    const chain = await fetchChainContext(currentDescriptor.network);
    assertSyncedWallet(currentDescriptor, run);
    if (sendAssetKey !== asset || $<HTMLInputElement>("destination").value.trim() !== destination ||
        $<HTMLInputElement>("amount").value !== amountText ||
        $<HTMLInputElement>("attached-ada").value.trim() !== attachedText || sendMaxMode !== sendMax)
      throw new Error("发送内容已变化，请重新构造交易");
    syncedTipSlot = chain.tipSlot;
    const pkg = buildUnsignedTransaction({
      descriptor: currentDescriptor, addresses, utxos, destination, amountLovelace,
      changeAddress: change?.address, sendMax: !asset && sendMax,
      assetRequests: assetRequest ? [assetRequest] : undefined, ...chain,
    });
    resetFinalized();
    unsigned = pkg;
    unsignedImported = false;
    if (!asset) $<HTMLInputElement>("amount").value = ada(BigInt(pkg.outputs[0].lovelace));
    renderSignatureSlots(currentDescriptor.cosigners.length, false);
    armUnsignedExpiry();
    renderTransactionSummary();
    $<HTMLButtonElement>("download-tx").disabled = false;
    toast(t("toast.txBuilt"));
    switchView("sign");
  } finally {
    button.disabled = false;
  }
}));
$("download-tx").addEventListener("click", () => unsigned && download(
  `${unsigned.txBodyHashHex}-eternl.json`,
  transactionTextEnvelope(unsigned),
));
if (import.meta.env.DEV) $("mnemonic-sign").addEventListener("click", () => action(async () => {
  if (!unsigned) throw new Error("请先构造交易");
  if (activeNetwork() !== "preprod") throw new Error("助记词签名仅支持 Preprod 测试网");
  const input = $<HTMLTextAreaElement>("mnemonic-input");
  if (!input.value.trim()) throw new Error("请输入测试钱包的英文恢复词");
  try {
    const { signWithTestMnemonic } = await import("./test-signing");
    const signed = signWithTestMnemonic(unsigned, input.value);
    addSignedCbor(signed.signedTxHex);
    toast(t("toast.mnemonicSigned", { count: signed.signerHashes.length }));
  } finally {
    input.value = "";
  }
}));
$("ledger-sign").addEventListener("click", () => action(async () => {
  if (!unsigned) throw new Error("请先构造交易");
  unsigned = validateForActiveWallet(unsigned);
  const button = $<HTMLButtonElement>("ledger-sign");
  button.disabled = true;
  button.textContent = t("sign.ledgerSigning");
  try {
    const pkg = unsigned;
    await verifyBeforeAction(pkg);
    const signedTxHex = await ledger.signTransaction(pkg);
    addSignedCbor(signedTxHex);
    toast(t("toast.ledgerSigned"));
  } finally {
    button.disabled = false;
    button.textContent = t("sign.ledgerSign");
  }
}));
$<HTMLInputElement>("import-tx").addEventListener("change", (event) => action(async () => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const imported = validateForActiveWallet(unsignedPackageFromImportText(await readImportFile(file)));
  input.value = "";
  if (unsigned?.txCborHex === imported.txCborHex && unsigned.txBodyHashHex === imported.txBodyHashHex) {
    toast(t("toast.packageImported"));
    switchView("sign");
    return;
  }
  const hasSignatures = [...document.querySelectorAll<HTMLTextAreaElement>("[data-signature]")]
    .some((field) => field.value.trim());
  if ((hasSignatures || mergedTx) && !window.confirm(t("sign.replaceTransactionConfirm"))) return;
  unsigned = imported;
  unsignedImported = true;
  renderSignatureSlots(descriptor!.cosigners.length, false);
  resetFinalized();
  armUnsignedExpiry();
  renderTransactionSummary();
  $<HTMLButtonElement>("download-tx").disabled = false;
  toast(t("toast.packageImported"));
  switchView("sign");
}));
$<HTMLInputElement>("import-signed").addEventListener("change", (event) => action(async () => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const text = await readImportFile(file);
  const signedTxHex = transactionCborFromImport(parseJsonOrRawCbor(text));
  addSignedCbor(signedTxHex);
  input.value = "";
  toast(t("toast.signedImported"));
}));
$("merge").addEventListener("click", () => action(async () => {
  if (!unsigned) throw new Error("请先构造交易");
  const pkg = validateForActiveWallet(unsigned);
  const button = $<HTMLButtonElement>("merge");
  button.disabled = true;
  try {
  await verifyBeforeAction(pkg);
  mergedTx = mergeSignedTransactions(unsigned.txCborHex, [...document.querySelectorAll<HTMLTextAreaElement>("[data-signature]")].map((field) => field.value));
  broadcastHash = "";
  renderMergeSummary();
  renderFinalReview();
  updatePendingTransactionUi();
  toast(t("toast.merged"));
  } finally { button.disabled = false; }
}));
$("cancel-transaction").addEventListener("click", () => {
  if (!unsigned || !window.confirm(t("sign.cancelConfirm"))) return;
  discardTransaction(false);
});
$<HTMLInputElement>("final-confirmed").addEventListener("change", (event) => {
  void event;
  updateBroadcastEnabled();
});
$<HTMLInputElement>("mainnet-confirm-text").addEventListener("input", updateBroadcastEnabled);
$<HTMLInputElement>("final-passcode-text").addEventListener("input", updateBroadcastEnabled);
$("lock-app").addEventListener("click", showLockScreen);
$("unlock").addEventListener("click", () => action(attemptUnlock));
$<HTMLInputElement>("lock-passcode").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void action(() => attemptUnlock());
  }
});
$("lock-forgot").addEventListener("click", () => action(() => {
  if (!window.confirm(t("lock.forgotConfirm1"))) return;
  if (!window.confirm(t("lock.forgotConfirm2"))) return;
  resetLocalData();
  window.location.reload();
}));
$("passcode-save").addEventListener("click", () => action(async () => {
  const current = $<HTMLInputElement>("passcode-current").value;
  const next = $<HTMLInputElement>("passcode-new").value;
  const confirm = $<HTMLInputElement>("passcode-confirm").value;
  if (next !== confirm) throw new Error("两次输入的新密码不一致");
  const changing = hasPasscode();
  if (changing) {
    if (!current) throw new Error("请输入当前支付密码");
    await changePasscode(current, next);
  } else {
    await setupPasscode(next);
  }
  for (const id of ["passcode-current", "passcode-new", "passcode-confirm"]) $<HTMLInputElement>(id).value = "";
  renderPasscodeUi();
  toast(t(changing ? "toast.passcodeChanged" : "toast.passcodeSet"));
}));
$("passcode-remove").addEventListener("click", () => action(async () => {
  const current = $<HTMLInputElement>("passcode-current").value;
  if (!current) throw new Error("请输入当前支付密码");
  await removePasscode(current);
  for (const id of ["passcode-current", "passcode-new", "passcode-confirm"]) $<HTMLInputElement>(id).value = "";
  renderPasscodeUi();
  toast(t("toast.passcodeRemoved"));
}));
$("source-save").addEventListener("click", () => action(() => {
  saveSourceSettings({ mode: $<HTMLSelectElement>("source-mode").value as SourceMode,
    mainnet: $<HTMLInputElement>("bf-mainnet").value.trim(), preprod: $<HTMLInputElement>("bf-preprod").value.trim(),
    verify: $<HTMLInputElement>("source-verify").checked });
  syncAbort?.abort(); syncRun++; walletSynced = false; syncedTipSlot = null; stakeState = null; sourceProof = null;
  $<HTMLInputElement>("final-confirmed").checked = false;
  setNetworkState("unsynced"); renderBalance(); renderAddresses(); renderStaking(); renderSourceProof(); updateBroadcastEnabled();
  toast(t("source.saved"));
}));
$("broadcast").addEventListener("click", () => action(async () => {
  if (!mergedTx) throw new Error("请先合并签名");
  if (!$<HTMLInputElement>("final-confirmed").checked) throw new Error("请先确认最终交易信息");
  if (activeNetwork() === "mainnet" && $<HTMLInputElement>("mainnet-confirm-text").value !== "MAINNET") throw new Error("请输入 MAINNET 确认主网广播");
  if (!descriptor || !unsigned) throw new Error("请先打开对应钱包并载入交易");
  const currentDescriptor = descriptor;
  const currentUnsigned = unsigned;
  const currentMerged = mergedTx;
  const run = syncRun;
  if (hasPasscode()) {
    const attempt = $<HTMLInputElement>("final-passcode-text").value;
    if (!attempt) throw new Error("请输入支付密码");
    if (!(await verifyPasscode(attempt))) {
      $<HTMLInputElement>("final-passcode-text").value = "";
      updateBroadcastEnabled();
      throw new Error("支付密码不正确");
    }
  }
  if (descriptor !== currentDescriptor || unsigned !== currentUnsigned || mergedTx !== currentMerged)
    throw new Error("待广播交易已变化，请重新核对最终交易");
  const button = $<HTMLButtonElement>("broadcast");
  button.disabled = true;
  try {
    const chain = await fetchChainContext(currentDescriptor.network);
    assertSyncedWallet(currentDescriptor, run);
    if (unsigned !== currentUnsigned || mergedTx !== currentMerged)
      throw new Error("待广播交易已变化，请重新核对最终交易");
    if (!$<HTMLInputElement>("final-confirmed").checked ||
        (currentDescriptor.network === "mainnet" && $<HTMLInputElement>("mainnet-confirm-text").value !== "MAINNET"))
      throw new Error("请重新确认最终交易信息");
    syncedTipSlot = chain.tipSlot;
    validatePackageForWallet(currentUnsigned, currentDescriptor, addresses, utxos, stakingContext(), chain.tipSlot);
    if (transactionId(currentMerged) !== currentUnsigned.txBodyHashHex) throw new Error("最终交易 ID 与签名包不一致");
    await verifyBeforeAction(currentUnsigned);
    if (mergedTx !== currentMerged || !$<HTMLInputElement>("final-confirmed").checked ||
        (currentDescriptor.network === "mainnet" && $<HTMLInputElement>("mainnet-confirm-text").value !== "MAINNET"))
      throw new Error("请重新确认最终交易信息");
    const hash = await broadcast(currentMerged, currentDescriptor.network);
    if (descriptor !== currentDescriptor || unsigned !== currentUnsigned || mergedTx !== currentMerged) return;
    broadcastHash = hash;
    toast(t("toast.broadcast", { hash }));
    renderMergeSummary();
    renderFinalReview(false);
    updatePendingTransactionUi();
  } finally {
    updateBroadcastEnabled();
  }
}));
document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => button.addEventListener("click", () => { if (!button.disabled) switchView(button.dataset.view!, button); }));
$('transaction-detail-close').addEventListener('click', () => $<HTMLDialogElement>('transaction-detail').close());
$('fiat-currency').addEventListener('click', () => {
  fiatCurrency = fiatCurrency === 'usd' ? 'cny' : 'usd';
  localStorage.setItem('cardano-sparrow-fiat-currency', fiatCurrency);
  renderPortfolio(); renderAssets();
});
$<HTMLInputElement>("hide-unlisted-assets").checked = hideUnlistedAssets;
$<HTMLInputElement>("hide-unlisted-assets").addEventListener("change", (event) => {
  hideUnlistedAssets = (event.currentTarget as HTMLInputElement).checked;
  localStorage.setItem("cardano-sparrow-hide-unlisted-assets", hideUnlistedAssets ? "on" : "off");
  renderBalance();
});

$("ledger-status").textContent = ledger.isSupported() ? t("ledger.available") : t("ledger.unavailable");
void action(() => {
  const savedWallets = localStorage.getItem(WALLETS_STORAGE_KEY);
  if (savedWallets) {
    const parsed = JSON.parse(savedWallets) as StoredWallet[];
    wallets = parsed.map((item) => ({ id: String(item.id), name: String(item.name), descriptor: validateDescriptor(item.descriptor) }));
  } else {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const migrated = { id: crypto.randomUUID(), name: t("wallet.defaultName"), descriptor: validateDescriptor(JSON.parse(legacy)) };
      wallets = [migrated];
      activeWalletId = migrated.id;
      saveWallets();
    }
  }
  if (!wallets.length) { newWallet(); return; }
  const preferred = localStorage.getItem(ACTIVE_WALLET_KEY);
  const selected = wallets.find((item) => item.id === preferred) ?? wallets[0];
  activeWalletId = selected.id;
  loadDescriptor(selected.descriptor, selected);
});
