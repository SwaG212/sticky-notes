# lock-holder.ps1
#
# 测试辅助：在独立进程里以 FileShare.None 独占打开日期锁文件并持有 N 秒。
# 只用于 tests/test_dispatch_record_ps1.ps1 的 K03/K04/K05 故障注入。
# 注意：本文件含中文，须保存为 UTF-8 with BOM。

param(
  [Parameter(Mandatory=$true)][string]$LockPath,
  [int]$Seconds = 20
)

$fs = $null
try {
  $fs = [System.IO.FileStream]::new($LockPath, [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  # 写一行标记，让调用方能确认“已经真正拿到句柄”，而不是只看到进程存在。
  $bytes = [System.Text.Encoding]::UTF8.GetBytes('LOCKED ' + $PID + "`n")
  $fs.Write($bytes, 0, $bytes.Length)
  $fs.Flush($true)
  Start-Sleep -Seconds $Seconds
} finally {
  if ($fs) { $fs.Dispose() }
}
