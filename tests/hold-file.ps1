# hold-file.ps1
#
# 测试辅助：在独立进程里独占/半独占打开文件并持有 N 秒，用于 B 组故障注入。
#   -Mode Exclusive（默认）：FileShare.None。任何读取与替换都失败，
#       用来验证“定位阶段就遇到共享冲突”应返回可重试 UNCONFIRMED，而不是文件损坏。
#   -Mode ReadOnly：FileAccess.Read + FileShare.Read。读者仍能读，
#       但写入口的 File.Replace/MoveFileEx 需要写/删除权限而失败，
#       用来精确注入“已定位记录、临时文件已写好、替换阶段失败”。
# 注意：本文件含中文，须保存为 UTF-8 with BOM。

param(
  [Parameter(Mandatory=$true)][string]$Path,
  [int]$Seconds = 20,
  [ValidateSet('Exclusive', 'ReadOnly')][string]$Mode = 'Exclusive'
)

$fs = $null
try {
  if ($Mode -eq 'ReadOnly') {
    $fs = [System.IO.FileStream]::new($Path, [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  } else {
    $fs = [System.IO.FileStream]::new($Path, [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  }
  Start-Sleep -Seconds $Seconds
} finally {
  if ($fs) { $fs.Dispose() }
}
