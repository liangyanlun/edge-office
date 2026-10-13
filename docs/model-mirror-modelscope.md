# 国内模型镜像（ModelScope）

应用支持把固定模型文件放在魔搭 ModelScope，作为 GitHub Releases 的国内下载源。镜像不是代理转发：仓库中的文件必须与 GitHub Release 字节完全一致。客户端仅在对应模型的文件已核验后显示“可用”；仅创建空仓库不会开放下载。

2026-09-30 已通过公开 ModelScope 文件 API 核对：0.8B GGUF 为 811,843,264 字节，SHA-256 为 `d64517eb198e0c0ebc1f717b9de02f52b476fa3bede99e7af2ac4eace1d3abd3`；4B 两分片分别为 1,800,000,000 / 908,804,288 字节，SHA-256 与下文固定值一致。三个公开下载地址均返回 HTTP 200，字节范围请求返回 HTTP 206 和正确的文件总长；0.8B 与 4B 第一片的文件头为 `GGUF`。应用默认开放这两个国内镜像入口，并在**下载完整文件后**重新计算固定 SHA-256；校验失败不会安装。此次远程核对使用平台公布的完整文件哈希与实际字节范围，不代表我们独立下载了约 3.5 GB 并重算远程全量哈希。

## 建仓与上传

1. 已创建两个独立仓库：[0.8B](https://modelscope.cn/models/liangyl233/edge_model_0.8b) 与 [4B](https://modelscope.cn/models/liangyl233/edge_model_4b)。确认两者均为公开可读。
2. 在各自仓库根目录上传对应文件（不要改名）：

   - `liangyl233/edge_model_0.8b`：`Qwen3.5-0.8B-office.Q8_0.gguf`
   - `liangyl233/edge_model_4b`：`Qwen3.5-4B-PPT.Q4_K_M.gguf.part-00` 和 `Qwen3.5-4B-PPT.Q4_K_M.gguf.part-01`

3. 4B 不要上传未经验证的合并文件。应用会在手机或 Windows 本机按顺序下载两个分片、验证分片哈希，再合并并验证完整哈希。
4. 上传后在本地逐个计算 SHA-256，与 GitHub Release 记录核对：

   ```powershell
   Get-FileHash .\Qwen3.5-0.8B-office.Q8_0.gguf -Algorithm SHA256
   Get-FileHash .\Qwen3.5-4B-PPT.Q4_K_M.gguf.part-00 -Algorithm SHA256
   Get-FileHash .\Qwen3.5-4B-PPT.Q4_K_M.gguf.part-01 -Algorithm SHA256
   ```

   0.8B 固定哈希是 `d64517eb198e0c0ebc1f717b9de02f52b476fa3bede99e7af2ac4eace1d3abd3`。4B 两片分别应为 1,800,000,000 字节、908,804,288 字节；SHA-256 分别为 `103363136f7c6dd3024cabf7db6cf1e1fdf28a6d4ddb199c5336ec3b31e409d2`、`5259c12d930c00ddef8808f34360b3aa38915c0145756c357e76e9ea699fd463`。合并后的固定哈希是 `31af22f3791eefaef07c431378b9e417d45895458b36e81063289892bb037f38`。

   发布前至少核对公开仓库的完整文件哈希、大小与下载字节；客户端还必须对完整下载重新计算 SHA-256，不能仅依赖平台元数据。

## 启用入口

当前源码的 Windows 与 Android 构建均已默认启用两个固定镜像。若镜像需要临时下线，可在 Windows 启动前设置：

```powershell
$env:MODEL_MODELSCOPE_0P8_REPOSITORY = "liangyl233/edge_model_0.8b"
$env:MODEL_MODELSCOPE_4B_REPOSITORY = "liangyl233/edge_model_4b"
$env:MODEL_MODELSCOPE_0P8_VERIFIED = "false"
$env:MODEL_MODELSCOPE_4B_VERIFIED = "false"
```

Android 已内置这两个仓库 ID，重新构建的 APK 默认开放镜像。若需临时关闭：

```powershell
cd android
.\gradlew.bat assembleDebug `
  -PedgeOfficeModelScope0p8Verified=false `
  -PedgeOfficeModelScope4bVerified=false
```

未配置或未核验时，入口仍会显示“国内镜像”，但按钮不可用；这是一项完整性保护，不是下载故障。下载完成后推理全过程仍在本机执行，不需要持续联网。

访问令牌只用于上传，不写入源码、APK、日志或聊天消息。上传完成后可撤销令牌。
