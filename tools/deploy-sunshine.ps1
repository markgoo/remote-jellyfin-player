# 部署 Jellyfin 手势播放器到 Sunshine(需要管理员权限运行)
# 用法: powershell -ExecutionPolicy Bypass -File deploy-sunshine.ps1

$ErrorActionPreference = 'Stop'
$log = 'C:\AI\jellyfinplayer\deploy-result.txt'
function W($m) { $m | Tee-Object -FilePath $log -Append }

try {
    W "=== 开始部署 $(Get-Date) ==="
    W "管理员: $(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"

    # ---------- 1. 部署产物 ----------
    $src = 'C:\AI\jellyfinplayer\dist\win-unpacked'
    $dst = 'C:\Program Files\JellyfinPlayer'
    if (-not (Test-Path "$src\jellyfin-player.exe")) { throw "源产物不存在: $src" }

    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP | Out-Null
    W "产物已复制 -> $dst"
    W "exe: $(Test-Path "$dst\jellyfin-player.exe")  config: $(Test-Path "$dst\config.json")"

    # ---------- 2. 生成图标 ----------
    $png = "$dst\jellyfin.png"
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap 256, 256
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $g.Clear([System.Drawing.Color]::FromArgb(255, 16, 24, 32))
    # Jellyfin 紫蓝圆角块
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 170, 92, 208))
    $g.FillEllipse($brush, 18, 18, 220, 220)
    $font = New-Object System.Drawing.Font('Segoe UI', 132, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $tb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
    $g.DrawString('J', $font, $tb, (New-Object System.Drawing.RectangleF(0, 0, 256, 256)), $fmt)
    $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    W "图标已生成: $png"

    # ---------- 3. 改 apps.json ----------
    $cfg = 'C:\Program Files\Sunshine\config\apps.json'
    Copy-Item $cfg "$cfg.bak-$(Get-Date -f yyyyMMdd-HHmmss)" -Force
    $json = Get-Content $cfg -Raw | ConvertFrom-Json

    $entry = [PSCustomObject]@{
        name        = 'Jellyfin'
        cmd         = '"C:\Program Files\JellyfinPlayer\jellyfin-player.exe"'
        'auto-detach' = $true
        'wait-all'  = $true
        'image-path' = 'jellyfin.png'
    }
    # 移除同名旧条目后追加
    $apps = @($json.apps | Where-Object { $_.name -ne 'Jellyfin' })
    $apps += $entry
    $json.apps = $apps
    ($json | ConvertTo-Json -Depth 20) | Set-Content $cfg -Encoding UTF8
    W "apps.json 已更新,当前应用: $($json.apps.name -join ', ')"

    # ---------- 4. 重启 Sunshine 服务 ----------
    Restart-Service -Name 'SunshineService' -Force
    Start-Sleep -Seconds 3
    $svc = Get-Service -Name 'SunshineService'
    W "SunshineService: $($svc.Status)"

    # ---------- 5. 验证 ----------
    Start-Sleep -Seconds 2
    $port = Test-NetConnection -ComputerName 127.0.0.1 -Port 47989 -InformationLevel Quiet -WarningAction SilentlyContinue
    W "端口 47989: $port"
    W "=== 部署完成 ==="
} catch {
    W "ERROR: $($_.Exception.Message)"
    W $_.ScriptStackTrace
    exit 1
}
