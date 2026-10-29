# Cardano Sparrow 完整本地版

当前桌面版为 **0.3.26**。发布物使用独立 Ed25519 发布密钥签署清单；双击 `验证Cardano发布包.command` 会用原生验证器核对发布者签名以及 DMG、源码包、验证工具和独立地址核对器的完整性。发布公钥指纹为 `7579b1ba72cb31cd893040deba3301e03de7c7e27bf2df763ab75c8bfece7ea7`。构建交易及签名前仍要核对完整地址和金额。

## 启动与停止

1. 需要 macOS 和 Node.js 20.19+ 或 22.12+。
2. 双击 `Start Cardano Sparrow.command`；浏览器会打开 `http://127.0.0.1:4173/`。
3. 使用完双击 `Stop Cardano Sparrow.command`。

本包包含完整源代码、锁定依赖清单、生产构建、测试、启停脚本与安全审查。为避免把特定机器生成的第三方目录当成发布物，未打包 `node_modules`；首次启动会按 `package-lock.json` 执行一次干净安装，之后可直接使用。启动时会重新构建一次，以确认源码与产物一致。

## 隐私与配置

打包时有意排除了 `.env.local`、运行日志、临时文件和研究资料。若需要 Koios API Token，请复制 `.env.example` 为 `.env.local` 并填写；不要公开或提交该文件。

本项目未经独立第三方审计。若用于大额资产，务必独立核对 descriptor、收款地址和 Ledger 屏幕上的交易内容；本地界面本身不能证明安装包未被替换。当前版本的安全检查与剩余风险见 `SECURITY_AUDIT_2026-10-25.md`，长期边界见 `SECURITY.md`。
