import CryptoKit
import Foundation

private let publisherKeyHex = "23e3bc2ce8fd961d13253b1193311e1f2df9d7ab7d261532c36178b8008e40e4"
private let publisherFingerprint = "7579b1ba72cb31cd893040deba3301e03de7c7e27bf2df763ab75c8bfece7ea7"

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\n❌ 验证失败：\(message)\n\n".utf8))
    exit(1)
}

private func hexBytes(_ value: String) -> Data? {
    guard value.count % 2 == 0 else { return nil }
    var result = Data(capacity: value.count / 2)
    var index = value.startIndex
    while index < value.endIndex {
        let end = value.index(index, offsetBy: 2)
        guard let byte = UInt8(value[index..<end], radix: 16) else { return nil }
        result.append(byte)
        index = end
    }
    return result
}

private func regularFile(_ url: URL) -> Bool {
    guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]) else { return false }
    return values.isRegularFile == true && values.isSymbolicLink != true
}

private func sha256(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
        let data = try handle.read(upToCount: 1024 * 1024) ?? Data()
        if data.isEmpty { break }
        hasher.update(data: data)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

let releaseDirectory = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? FileManager.default.currentDirectoryPath,
                           isDirectory: true).standardizedFileURL
guard let keyData = hexBytes(publisherKeyHex),
      let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData) else {
    fail("验证器内置发布公钥无效")
}

let files: [URL]
do {
    files = try FileManager.default.contentsOfDirectory(at: releaseDirectory, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey])
} catch {
    fail("无法读取发布目录：\(releaseDirectory.path)")
}
let manifests = files.filter { $0.lastPathComponent.hasPrefix("MANIFEST-") && $0.pathExtension == "sha256" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
if manifests.isEmpty { fail("没有找到 MANIFEST-*.sha256") }

var verifiedNames = Set<String>()
for manifest in manifests {
    var manifestNames = Set<String>()
    guard regularFile(manifest), let manifestData = try? Data(contentsOf: manifest) else { fail("清单不可读或不是普通文件：\(manifest.lastPathComponent)") }
    let signature = manifest.deletingPathExtension().appendingPathExtension("sig")
    guard regularFile(signature), let signatureData = try? Data(contentsOf: signature), signatureData.count == 64 else {
        fail("缺少有效的发布签名：\(signature.lastPathComponent)")
    }
    guard publicKey.isValidSignature(signatureData, for: manifestData) else { fail("发布签名无效：\(manifest.lastPathComponent)") }
    guard let text = String(data: manifestData, encoding: .utf8), text.hasSuffix("\n") else { fail("清单编码无效：\(manifest.lastPathComponent)") }
    let lines = text.dropLast().split(separator: "\n", omittingEmptySubsequences: false)
    if lines.isEmpty { fail("空清单：\(manifest.lastPathComponent)") }
    for line in lines {
        let parts = line.split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[1].isEmpty, parts[0].count == 64,
              parts[0].allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { fail("清单格式无效：\(manifest.lastPathComponent)") }
        let name = String(parts[2])
        let components = name.split(separator: "/", omittingEmptySubsequences: false)
        guard !name.isEmpty, !name.hasPrefix("/"), !name.contains("\\"),
              components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            fail("清单包含不安全路径：\(name)")
        }
        guard manifestNames.insert(name).inserted else { fail("清单重复列出文件：\(name)") }
        verifiedNames.insert(name)
        let target = releaseDirectory.appendingPathComponent(name, isDirectory: false).standardizedFileURL
        let releasePrefix = releaseDirectory.path.hasSuffix("/") ? releaseDirectory.path : releaseDirectory.path + "/"
        guard target.path.hasPrefix(releasePrefix) else { fail("清单路径越出发布目录：\(name)") }
        guard regularFile(target) else { fail("文件缺失、不是普通文件或是符号链接：\(name)") }
        do {
            guard try sha256(target) == String(parts[0]) else { fail("文件已被修改：\(name)") }
        } catch { fail("无法读取文件：\(name)") }
        print("  ✓ \(name)")
    }
    print("  ✓ \(manifest.lastPathComponent) 的 Ed25519 发布签名有效")
}

let releaseLike = files.filter { ["dmg", "zip"].contains($0.pathExtension.lowercased()) }.map(\.lastPathComponent)
for name in releaseLike where !verifiedNames.contains(name) { fail("发现未列入签名清单的发布包：\(name)") }

print("\n✅ 发布者身份和所有发布文件均验证通过")
print("发布公钥指纹：\(publisherFingerprint)")
print("目录：\(releaseDirectory.path)\n")
