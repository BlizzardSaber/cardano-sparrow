# Cardano Sparrow

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **Security notice:** This is self-custody software, not an independently audited financial product. Review the source, verify release signatures, test on Preprod and with small amounts, and confirm every output and fee on the hardware-wallet screen before using Mainnet.

## Release verification

Do not rely on the filename alone. The current macOS `0.3.26` release has:

```text
Publisher Ed25519 public-key fingerprint
7579b1ba72cb31cd893040deba3301e03de7c7e27bf2df763ab75c8bfece7ea7

Cardano-Sparrow-0.3.26-arm64.dmg SHA-256
3cf395c5535b67c032efbb8d0d7c31f69b254e59a6eef8870934daa3ac927cc1
```

Download the DMG together with `MANIFEST-0.3.26.sha256`, `MANIFEST-0.3.26.sig`,
`RELEASE-PUBLIC-KEY.pem` and the verifier from the GitHub release. Prefer the
Ed25519 signature check over comparing only the SHA-256 text shown on this page:
an attacker who can replace both a download and this page can also replace a
plain hash. Record the publisher fingerprint independently before relying on it.
Full offline verification instructions are in
[`OFFLINE_RELEASE_SIGNING.md`](./OFFLINE_RELEASE_SIGNING.md).

极简、本地优先的 Cardano CIP-1854 M-of-N HD 多签原型。支持 **Mainnet / Preprod、watch-only、ADA 与原生资产余额显示/转账、M-of-N 质押委托**，新钱包默认 Mainnet。

## 已实现

- 创建时配置 1–10 个签名人和任意有效的 M-of-N 阈值
- 钱包创建后锁定网络、M-of-N、cosigner 公钥及顺序；这些字段的任何变化都会形成不同钱包，只能通过“新建钱包”创建
- 导入多个 `acct_shared_xvk`，按 CIP-1854 的 `.../0/index` 顺序地址池派生；收款与找零均使用 role 0
- 为主网或 Preprod 的每个 index 生成支付与质押脚本组成的 Base Address
- 独立 Receive 页展示当前收款地址和二维码，Addresses 页展示完整的 role-0 顺序地址池
- 自动查询历史输出：用过的收款地址永久标记为 `Used`，Receive 自动前进到最高已用序号的下一个地址
- 自动维持 descriptor 的 gap limit；已用地址接近扫描末端时继续派生并扫描
- 中文 / English 界面即时切换，语言偏好保存在浏览器本机
- 可选支付密码（PBKDF2 本地校验）：打开应用需解锁、广播前需重新输入；遗忘时只能重置本机数据并重新导入 descriptor
- 地址为 Base Address（支付脚本 + 质押脚本），质押脚本同样按钱包 M-of-N 阈值从各 cosigner 的 `m/1854'/1815'/0'/2/0` 派生
- 质押页：注册+委托、更换质押池、提取奖励、解除质押并退回押金；四种操作全部需要 M-of-N 签名。Ledger 对 Token 与质押证书的真机显示仍待逐项验证
- 0.3.0 只派生与扫描 Base Address；之前版本企业地址的资金不在本版本显示，请用 0.2.0 查看或转移
- 多钱包本机列表：新建、导入、保存和切换不同 descriptor 钱包
- 可从本机移除已保存钱包；删除前连续两次确认，移除只影响本机观察资料，不影响链上资金
- descriptor-style JSON 备份、恢复和浏览器本机保存
- 设置页展示 M-of-N、账户来源路径和全部 cosigner `acct_shared_xvk`，并可导出完整 descriptor 备份
- 通过对应网络的 Koios 扫描地址 UTXO、ADA 与原生资产余额；主页 ADA 总余额和估值另计已同步的可领取质押奖励，发送仍以可花费 UTXO 为准
- 通过 Koios 加载钱包交易历史（ADA/CNT 净变化、币种图标、确认时间和区块高度）；点交易先查看应用内详情，完整 TXID 可点开 Cardanoscan
- 可切换 USD/CNY 显示 ADA、已验证 NIGHT，以及有 Token Registry 登记/已固定身份且有合格报价的 CNT 参考估值；USDCx 优先使用 Minswap 官方资产指标并严格核对完整资产 ID、认证状态、小数位、流动性和成交量，DEX Screener 作为回退。无报价资产会计数提示。报价只影响展示，不进入交易构造与签名。
- 纯 ADA coin selection、手续费估算、找零和 unsigned transaction；“最大”会使用全部可花费纯 ADA UTXO、扣除精确手续费并生成无找零交易
- 发送页可点“扫码”主动请求 macOS 摄像头授权，放行后用 MacBook 摄像头读取收款地址二维码；仅接受当前网络有效的 Cardano 支付地址，填入后仍需人工核对完整地址再构建交易。摄像头画面仅在本机内存中解码，关闭窗口或切换页面即停止摄像头。系统设置的摄像头列表不支持手动添加应用，首次点击“扫码”才会触发系统弹窗；若曾拒绝，需要在系统设置更改授权后重启应用。
- 原生资产余额列表：本地计算 CIP-14 指纹、显示名称/ticker/小数位（来自 Koios 资产元数据）与图标；USDCx 的固定资产 ID 使用本地打包的 Token Registry PNG，其余图标经本机代理加载。设置可隐藏未登记资产，仅影响余额列表；交易、UTXO、发送与签名仍显示全部资产。Token Registry 登记不等于发行方认证。
- 原生资产转账：先选足资产、再补纯 ADA UTXO 的贪心选币；输出自动满足链上 min-ADA，剩余资产与 ADA 原路找零，签名包 version 2 携带资产摘要（version 1 纯 ADA 包仍可导入）
- CNT“最大”会将资产全部余额以无千位分隔符的精确数值写入发送数量框，并复核输入值与链上最小单位完全一致后才提示成功；输入框步长按资产小数位设置。
- 默认导出 Eternl 可直接导入的 `Tx ConwayEra` text-envelope；导入同时兼容 Eternl envelope、原 Cardano Sparrow 签名包和原始交易 CBOR
- 签名页在连接 Ledger 前直接从待签 CBOR 展示完整收款/找零地址、金额、资产、手续费、TXID、网络及质押操作，方便对照设备屏幕
- 校验 transaction body 后合并多个 signed transaction 的 vkey witnesses
- witness 合并后从最终 CBOR 重新解析 TXID、收款地址、金额、找零和手续费，并要求二次确认后广播
- 向 Mainnet 或 Preprod 广播已合并交易；Mainnet 额外要求输入 `MAINNET` 确认
- Ledger WebHID 直连并读取 `m/1854'/1815'/0'` 的 `acct_shared_xvk`
- Ledger WebHID 原生 `MULTISIG_TRANSACTION` 签名，支持一个设备对交易涉及的多个 CIP-1854 地址路径签名
- Ledger 返回后校验 transaction ID、签名路径、公钥归属与 Ed25519 signature，再写入签名槽位
- 签名页默认只显示签名进度；原始 signed CBOR 收进折叠的高级视图，外部签名优先通过文件导入
- 构建或导入 unsigned transaction 后，“签名”导航显示待办红点；10 分钟内未收到有效签名会自动丢弃，也可在签名页手动取消
- 自动丢弃和取消只清除本机草稿；已导出且达到阈值的签名交易在链上 TTL 到期前仍可能被广播
- 网页助记词签名器只在 `npm run dev` 的 Preprod 开发页面提供；生产构建和桌面安装包不包含签名入口及代码。主网只允许 Ledger 或外部离线签名
- 导入签名包时校验网络、M-of-N 策略、派生地址、原生脚本、实时 UTXO、金额平衡和签名路径
- 合并时逐个验证 witness 的脚本归属与 Ed25519 签名，拒绝额外或无效 witness
- 发布包附带固定公钥的 Ed25519 清单签名和原生一键验证器；验证器先确认发布者身份，再核对 DMG、源码包、验证工具本身以及独立地址核对器的可执行文件、启动脚本、源码和测试向量，拒绝未列入清单的额外发布包。私钥不进入发行物；完成真正离线迁移的步骤见 `OFFLINE_RELEASE_SIGNING.md`。

## 运行

要求 Node.js 20.19+ 或 22.12+。

macOS 可直接双击 `Start Cardano Sparrow.command`。脚本会使用锁定的依赖构建应用，只在 `127.0.0.1:4173` 启动服务并打开浏览器。使用完双击 `Stop Cardano Sparrow.command`，它只会停止由当前副本启动的进程。首次运行若尚无 `node_modules`，会执行一次 `npm ci`。

命令行方式：

```bash
npm ci
npm run dev
```

打开终端显示的本机地址。生产构建与测试：

```bash
npm test
npm run build
npm start
```

Koios 公共额度受限。本地代理会自动合并相同的并发请求、缓存只读查询，并在 `429` 时遵守 `Retry-After` 退避重试。长期使用建议申请 Koios 免费 API Token，然后仅配置在本地代理中：

```bash
cp .env.example .env.local
# 编辑 .env.local：KOIOS_API_TOKEN=你的令牌
npm start
```

令牌不会打包进浏览器代码。修改 `.env.local` 后必须重启本地服务。

## Blockfrost 备用源与双源核验

设置 → 链上数据源，可分别填写 Mainnet / Preprod 的 Blockfrost Project ID（在 https://blockfrost.io 创建对应网络项目）。支持自动备用、仅 Koios、仅 Blockfrost。自动模式记住最近可用源，只在网络故障、429、413 或 5xx 时切换；数据格式/资产数量校验失败和用户取消不会触发切换。

默认勾选“签名与广播前双源核验”。填入当前网络的 Project ID 后，Ledger 签名、完成交易和广播前会分别从 Koios 与 Blockfrost 重新核对选中输入的 ADA/CNT 原始余额、未花费状态、四项构造参数及最新 slot（最多相差 180 slot）；质押交易额外核对注册状态、池、可领取奖励总额与实际注册押金。任一源不可用或不一致都会停止操作，需要重试/重新同步。备用同步仍可在单源故障时观察余额；严格双源核验并不以单源结果降级通过。

未配置当前网络 ID 或关闭该选项时，界面会明确提示单一数据源。双源一致不能替代全节点验证、descriptor 独立核对与 Ledger 屏幕确认。Project ID 明文保存在本机观察数据区，不进入 descriptor 备份；查询会把有关地址暴露给服务商。全部请求经固定域名/路径代理，拒绝重定向并限制大小与超时。广播使用当前数据源提交一次，失败时不会自动换源重发；如结果不确定，先查本地 TXID 的链上状态。

## 钱包描述文件

备份是普通 JSON，不含私钥：

```json
{
  "format": "cardano-hd-multisig",
  "version": 1,
  "network": "mainnet",
  "threshold": 2,
  "account": 0,
  "gapLimit": 20,
  "cosigners": [
    { "name": "Signer 1", "accountXpub": "acct_shared_xvk1..." },
    { "name": "Signer 2", "accountXpub": "acct_shared_xvk1..." },
    { "name": "Signer 3", "accountXpub": "acct_shared_xvk1..." }
  ]
}
```

公钥不能直接花费资金，但会暴露完整地址集合和财务活动。备份仍应私密保存。

CIP-1854 没有单一的“多签账户 xpub”。恢复同一个观察钱包需要相同的 M-of-N 模板、cosigner 顺序、全部 `acct_shared_xvk`、网络和账户索引。本版本固定账户来源为 `m/1854'/1815'/0'`；收款与找零都从 `m/1854'/1815'/0'/0/index` 顺序地址池选择，不派生或扫描 role 1。Bitcoin 描述符中的 master fingerprint 不是 CIP-1854 定义的恢复字段；本版本不伪造一个非标准 Cardano fingerprint。

当前交易签名会验证 transaction ID、网络、活动钱包、实时 UTXO、金额平衡、签名路径、native script 归属及 Ed25519 签名。当前审查与剩余风险见 [SECURITY_AUDIT_2026-10-25.md](./SECURITY_AUDIT_2026-10-25.md) 和 [SECURITY.md](./SECURITY.md)。支持主网不等于已经达到 Sparrow 的生产安全等级；当前发布物具备独立 Ed25519 发布者签名，但 macOS App 本身仍为 ad-hoc 签名、未做 Apple Developer ID 公证，且发布私钥需要迁移到离线介质后才完成信任根隔离。

Ledger 签名成功后，已签名交易 CBOR 会自动进入一个签名槽。三台 Ledger 若依次连接同一台电脑，可以直接重复点击“使用 Ledger 签名”，直到签名数达标，再点“完成交易”。若需把一份签名传到另一台电脑，在对应的已验证签名槽点击“导出已签名 CBOR”，对方先导入相同的未签名交易包，再用“导入已签名 CBOR”载入 `.cbor.txt` 文件。导出的文件不含私钥，但应妥善保管交易详情；达到阈值的签名可在链上有效期内被任何持有者广播。

## Ledger 边界

`LedgerSigner` 是当前唯一硬件钱包边界：

```ts
interface LedgerSigner {
  isSupported(): boolean;
  getAccountXpub(account: number): Promise<string>;
  signTransaction(request: UnsignedPackage): Promise<string>;
}
```

`LedgerWebHidSigner` 已能通过官方 WebHID transport 和 Cardano Foundation Ledger 库读取 CIP-1854 扩展账户公钥。使用 Chrome/Edge，解锁 Ledger 并打开 Cardano App，然后在目标密钥库点击“从 Ledger 导入”；浏览器会显示设备选择框。此操作只读取公钥和 chain code，不会读取私钥或助记词。

Ledger 交易签名流程：

1. 用网页中的“从 Ledger 导入”读取 `m/1854'/1815'/0'` 公钥，或粘贴其他兼容工具导出的 `acct_shared_xvk`。
2. 在本应用创建交易；默认导出的 `*-eternl.json` 可直接交给 Eternl，原 Cardano Sparrow unsigned JSON 签名包仍可导入。
3. 在签名页点击“使用 Ledger 签名”，在设备屏幕核对交易并批准。
4. 应用验证并自动把 signed transaction CBOR 写入下一个签名槽位；更换 Ledger 重复操作直到满足阈值。
5. 点击“完成交易”合并并去重 vkey witnesses，然后广播。

### 隔离的 Preprod 开发测试签名

开发源码保留了一个命令行测试工具，用于无价值的 Preprod 回归测试。它不进入生产网页 bundle，也不进入桌面安装包：

```bash
npm run sign:test -- /完整路径/下载的签名包.json
```

签名器会先显示从 CBOR 实际解析出的交易 ID、手续费、全部输出和派生路径。输入 `SIGN` 后，它才会在终端隐藏读取该测试钱包的英文恢复词，按签名包派生 `m/1854'/1815'/0'/0/index` 的支付密钥及必要时的 `m/1854'/1815'/0'/2/0` 质押密钥，并确认派生公钥确实存在于 native script 中。恢复词只存在于进程内存，不写入文件、日志或命令历史。

输出的 `.signed.txt` 包含一行 signed transaction CBOR。使用其他测试钱包重复，直到满足当前阈值，再通过“导入已签名 CBOR”载入。

此工具只为开发者打通 Preprod 回归测试。不要输入存有主网资产的钱包恢复词；发布版应由 Ledger 等硬件钱包在设备屏幕核对后签名。

Ledger 请求使用 Cardano App 的 `MULTISIG_TRANSACTION` 模式。多签模式不允许把脚本找零标记成 device-owned output，因此设备会把普通交易的收款与找零输出都作为明确地址展示；“最大”交易只有一个收款输出。请在设备屏幕核对全部输出和手续费。Token 与质押交易的真机显示和签名仍需逐项实测。

## 明确限制

- 不支持 governance、DRep 投票或 minting；质押仅支持委托/换池/提奖/解押，不支持注册矿池或 DRep 证书。
- 交易仍然最多两个输出（收款 + 找零）、拒绝 Datum、reference script 与 mint；普通付款交易不接受证书或提款，质押交易只接受本钱包已实现的证书和奖励提款；单笔交易资产单元上限 64。
- 资产名称/ticker/图标仅用于展示；小数位用于输入与显示数量的换算，链上校验始终使用原始整数。远程元数据可能有误，核对时以指纹（CIP-14）、Policy ID 和签名摘要中的 raw 数量为准。
- USDCx 和 NIGHT 图标内置；其余代币的图标与元数据来自远程服务器。远程图标仅允许固定 IPFS/Arweave 网关、拒绝私网地址、不跟随重定向、限 512 KiB、仅栅格图片格式。其他来源回退为字母图标。
- 地址发现最多扫描 1000 个派生索引，超过时会停止并提示，不会猜测可用地址。
- Koios 是默认公共索引器与提交端点；Vite 本机服务仅做代理以避开浏览器 CORS，不保存数据。应用没有数据库、账号或云同步。
- 未集成 Eternl 或 Lace 的网页直连签名。桌面端可与 Eternl 通过 `Tx ConwayEra` JSON 文件交换 unsigned/partially-signed 交易；签名前仍要求 Eternl 当前 Ledger/钱包确实持有对应的 CIP-1854 签名密钥。
- 当前安全加固是内部代码审查，不是独立第三方审计。主网仅建议小额试用，风险边界见 `SECURITY.md`。

## 目录

```text
src/cardano.ts   CIP-1854、native script、多资产交易和 witness 逻辑
src/assets.ts    资产元数据解析、数量格式化与图标来源归一化
src/fingerprint.ts / src/blake2b.ts   本地 CIP-14 资产指纹
src/ledger.ts    Ledger WebHID 与 CIP-1854 账户公钥导入（含质押证书签名）
src/provider.ts  Koios Mainnet / Preprod 读取与广播
src/main.ts      无框架本地 UI
src/types.ts     descriptor 与签名包格式
```
