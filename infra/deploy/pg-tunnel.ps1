# 建立到服务器 PostgreSQL 的 SSH 隧道（本地开发用）
#
# 原理：本地 55432 端口 ←→ 服务器 127.0.0.1:5432
# 数据库本身只监听服务器本机，公网无法直连，必须经隧道访问。
#
# 用法：在仓库根目录执行
#   powershell -ExecutionPolicy Bypass -File infra/deploy/pg-tunnel.ps1
# 保持这个窗口不关闭，另开一个终端跑 pnpm dev / prisma 命令。
#
# 保活参数：服务器会断开闲置连接，ServerAliveInterval 定期发心跳。

$ErrorActionPreference = "Stop"

$Server = "ubuntu@118.89.166.194"
$LocalPort = 55432
$Remote = "127.0.0.1:5432"

Write-Host "正在建立隧道：127.0.0.1:$LocalPort -> $Remote（Ctrl+C 停止）" -ForegroundColor Cyan

ssh -N `
  -o ServerAliveInterval=30 `
  -o ServerAliveCountMax=3 `
  -o ExitOnForwardFailure=yes `
  -L "${LocalPort}:${Remote}" `
  $Server
