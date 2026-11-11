# 更新已部署的 JellyfinPlayer(仅替换 app.asar 与 config.json)
# 用法: powershell -ExecutionPolicy Bypass -File update-deployed.ps1

$ErrorActionPreference = 'Stop'
$log = 'C:\AI\jellyfinplayer\update-result.txt'
function W($m) { $m | Tee-Object -FilePath $log -Append }

$src = 'C:\AI\jellyfinplayer\dist\win-unpacked'
$dst = 'C:\Program Files\JellyfinPlayer'

try {
    W "=== 更新部署 $(Get-Date) ==="
    W "管理员: $(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"

    Get-Process -Name 'jellyfin-player' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1

    Copy-Item "$src\resources\app.asar" "$dst\resources\app.asar" -Force
    Copy-Item "$src\config.json"        "$dst\config.json"        -Force
    W "已更新 app.asar + config.json"

    # 清掉旧的运行时日志,便于下次排查
    Remove-Item "$dst\jellyfin-player.log" -Force -ErrorAction SilentlyContinue
    Remove-Item "$dst\jellyfin-player.log.old" -Force -ErrorAction SilentlyContinue
    Remove-Item "$dst\debug.log" -Force -ErrorAction SilentlyContinue

    # 校验
    W "app.asar 大小: $((Get-Item "$dst\resources\app.asar").Length)"
    W "config seekMode: $((Get-Content "$dst\config.json" -Raw | ConvertFrom-Json).seekMode)"
    W "config backGesture: $((Get-Content "$dst\config.json" -Raw | ConvertFrom-Json).enableBackGesture)"
    W "=== 更新完成 ==="
} catch {
    W "ERROR: $($_.Exception.Message)"
    exit 1
}
