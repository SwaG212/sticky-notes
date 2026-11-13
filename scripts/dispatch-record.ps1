# dispatch-record.ps1
#
# 派活记录 PC 写入口（V1 基线，设计文档 §6.2/§6.2.1）。
# SSH 白名单唯一入口：JSON 从标准输入读，JSON 写标准输出；不接受任意路径、任意命令。
#
# 事务（一次远端命令完成，不拆多条 SSH 持锁往返）：
#   FileStream 独占句柄锁（10 秒单调计时超时、100ms 仅可恢复异常重试、最外层 try/finally）
#   → 锁内重读正式文件 → node dispatch-store.js transact 校验并应用补丁（单一事实来源）
#   → 同目录临时文件 + Flush(true) + 校验临时 JSON → File.Replace 原子替换 + 双版本备份
#   → 锁内回读核对 → 成功后尽力把最新正式文件同步到独立备份根（不影响事务成败）
#
# 备份：File.Replace 备份（<日期>.json.replace-bak，本次被替换的版本）+
#   .bak（<日期>.json.bak，上一次的版本），每个有历史的日期文件至少两个可验证旧版本。
#   首次创建尚无旧版本时明确没有历史备份，不伪造。
#   独立位置周期备份（默认 9B）的目标、频率、保留策略尚未配置：-BackupRoot 只是
#   每写必同步的最新副本位置，定时周期备份与恢复演练仍待配置（见报告）。
#
# 退出码：0 成功；1 请求/校验/IO 错误（JSON 含 code）；2 LOCK_TIMEOUT；
#   3 提交结果未确认（UNCONFIRMED，保留证据待核实）；4 node 不可用。
# 注意：本文件含中文，须保存为 UTF-8 with BOM（PowerShell 5.1）。

param(
  # 服务器端固定数据根（userData\dispatches）。部署时必须传与 Electron
  # app.getPath('userData') 一致的实际根，默认只作未配置时的回退。
  [string]$DataRoot = (Join-Path $env:APPDATA 'sticky-notes\dispatches'),
  # 独立备份根（userData 同级的可配置路径）：每次成功写入后同步最新正式文件。
  # 定时周期备份的频率/保留/恢复演练尚未配置，见报告。
  [string]$BackupRoot = (Join-Path $env:APPDATA 'sticky-notes-dispatch-backups'),
  [ValidateSet('Transact', 'Verify')][string]$Mode = 'Transact',
  [int]$LockTimeoutMs = 10000,
  [int]$LockRetryMs = 100,
  [string]$NodeExe = 'node',
  [string]$StoreJs = ''
)

$ErrorActionPreference = 'Stop'

$SCRIPT:WRITER_VERSION = '1.0.0'
$SCRIPT:REQUEST_MAX_BYTES = 16384
$SCRIPT:UUID_RE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
$SCRIPT:DATE_RE = '^\d{4}-\d{2}-\d{2}$'
$SCRIPT:DISPATCH_ID_RE = '^dispatch_(\d{4}-\d{2}-\d{2})_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

function Write-JsonResult {
  param([object]$Result, [int]$ExitCode = 0)
  $json = ConvertTo-Json -InputObject $Result -Depth 10 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
  exit $ExitCode
}

function New-ErrorResult {
  param([string]$Code, [string]$Message, [hashtable]$Extra)
  $r = @{ ok = $false; code = $Code; message = $Message }
  if ($Extra) {
    foreach ($k in $Extra.Keys) { $r[$k] = $Extra[$k] }
  }
  return $r
}

function Get-StoreJsPath {
  if ($StoreJs -ne '') { return $StoreJs }
  $repoRoot = Split-Path -Parent $PSScriptRoot
  return (Join-Path $repoRoot 'dispatch-store.js')
}

function Get-ShanghaiDate {
  param([DateTime]$Utc)
  $tz = [System.TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
  $local = [System.TimeZoneInfo]::ConvertTimeFromUtc($Utc, $tz)
  return $local.ToString('yyyy-MM-dd')
}

function Read-StdinBytes {
  $ms = New-Object System.IO.MemoryStream
  try {
    [Console]::OpenStandardInput().CopyTo($ms)
    return $ms.ToArray()
  } finally {
    $ms.Dispose()
  }
}

# 以“读取 + 删除共享”打开文件读全文；不拿写锁，不创建目录。
# 共享冲突/瞬时消失属于可恢复的瞬时错误（§6.3 第 3 条）：短暂重试 3 次再放弃，
# 不能把“别人正持有独占句柄”直接当成文件损坏。权限等不可恢复异常立即抛出。
function Read-FileShared {
  param([string]$Path)
  $attempt = 0
  while ($true) {
    $fs = $null
    $sr = $null
    try {
      $fs = [System.IO.FileStream]::new($Path, [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
      $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
      return $sr.ReadToEnd()
    } catch [System.IO.IOException] {
      $attempt++
      if ($attempt -ge 3) { throw }
      Start-Sleep -Milliseconds 100
    } finally {
      if ($sr) { $sr.Dispose() }
      if ($fs) { $fs.Dispose() }
    }
  }
}

function Find-DispatchFile {
  param([string]$RecordId, [string]$HintDate)
  # 先看提示日期文件，再全目录扫描（按日期降序）。返回 @{path; date} 或 $null。
  # 扫描用原文包含匹配定位，node 侧再做严格校验；读不到的文件记下来，
  # 找不到记录且有读不到的文件时不能断言不存在。
  # 区分两类读失败：IOException（共享冲突/瞬时消失，可退避重试）记入 busy，
  # 其余（权限、路径非法）记入 unreadable。两者都不能被当成“记录不存在”，
  # 但也不能把可恢复的瞬时冲突谎报成文件损坏。
  $unreadable = @()
  $busy = @()
  $candidates = @()
  $files = @()
  if (Test-Path -LiteralPath $DataRoot -PathType Container) {
    $files = Get-ChildItem -LiteralPath $DataRoot -Filter '*.json' -File |
      Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}\.json$' } |
      Sort-Object Name -Descending
  }
  if ($HintDate -and ($HintDate -match $SCRIPT:DATE_RE)) {
    $hint = Join-Path $DataRoot ($HintDate + '.json')
    if (Test-Path -LiteralPath $hint -PathType Leaf) {
      try {
        $text = Read-FileShared -Path $hint
        if ($text.Contains('"' + $RecordId + '"')) { $candidates += @{ path = $hint; date = $HintDate } }
      } catch [System.IO.IOException] { $busy += $hint } catch { $unreadable += $hint }
    }
  }
  if ($candidates.Count -eq 0) {
    foreach ($f in $files) {
      $date = $f.BaseName
      if ($HintDate -and $date -eq $HintDate) { continue }
      try {
        $text = Read-FileShared -Path $f.FullName
        if ($text.Contains('"' + $RecordId + '"')) {
          $candidates += @{ path = $f.FullName; date = $date }
          break
        }
      } catch [System.IO.IOException] { $busy += $f.FullName } catch { $unreadable += $f.FullName }
    }
  }
  return @{ candidates = $candidates; unreadable = $unreadable; busy = $busy }
}

# FileStream 独占句柄锁：只对可恢复共享冲突（IOException）每 100ms 重试，
# 10 秒单调计时超时；权限、非法路径等不可恢复异常立即失败。
function Acquire-DispatchLock {
  param([string]$LockPath)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    try {
      $fs = [System.IO.FileStream]::new($LockPath, [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      return $fs
    } catch [System.IO.IOException] {
      if ($sw.ElapsedMilliseconds -ge $LockTimeoutMs) {
        throw (New-Object System.Exception('LOCK_TIMEOUT'))
      }
      Start-Sleep -Milliseconds $LockRetryMs
    }
  }
}

# 调用 node dispatch-store.js 做业务校验与补丁应用（单一事实来源）。
# 输入 recordsJson 为正式文件原文（缺失文件时传 '[]'）。
function Invoke-StoreTransact {
  param([string]$RecordsJson, [hashtable]$Request, [hashtable]$Server, [string]$NowIso)
  $storeJs = Get-StoreJsPath
  if (-not (Test-Path -LiteralPath $storeJs -PathType Leaf)) {
    throw (New-Object System.Exception('NODE_STORE_MISSING'))
  }
  $payload = @{
    command = 'transact'
    recordsJson = $RecordsJson
    request = $Request
    server = $Server
    nowIso = $NowIso
  }
  $inputJson = ConvertTo-Json -InputObject $payload -Depth 10 -Compress
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $NodeExe
  $psi.Arguments = '"' + $storeJs + '"'
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  # 注意：不要用 ProcessStartInfo.StandardInputEncoding/StandardOutputEncoding——
  # 本机 .NET Framework 没有 StandardInputEncoding 属性（赋值抛错会连带跳过
  # StandardOutputEncoding 的赋值），且控制台默认编码是 GBK(936)，而 node 的
  # stdin/stdout 是 UTF-8；GBK 解码 UTF-8 中文时尾字节会吃掉 JSON 末尾的引号，
  # 导致 ConvertFrom-Json 失败（NODE_BAD_OUTPUT）。改走 BaseStream 直接读写 UTF-8 字节。
  #
  # 受限环境回退：在 Job 对象/无交互桌面下（例如自动化验收会话），
  # Process.Start 带匿名管道重定向会抛 Win32Exception 5（Access is denied），
  # 但 Start-Process 的文件重定向仍可用。此时改用临时文件传输入参/输出，
  # 保证同一条写入口在受限会话里也能真实跑通；正常环境仍走管道路径。
  $stdout = $null
  $stderr = ''
  $exitCode = $null
  $launched = $false
  try {
    $proc = [System.Diagnostics.Process]::Start($psi)
    $launched = $true
  } catch {
    $proc = $null
  }
  if ($launched) {
    try {
      $inBytes = [System.Text.Encoding]::UTF8.GetBytes($inputJson)
      $proc.StandardInput.BaseStream.Write($inBytes, 0, $inBytes.Length)
      $proc.StandardInput.BaseStream.Flush()
      $proc.StandardInput.Close()
      $msOut = New-Object System.IO.MemoryStream
      try {
        $proc.StandardOutput.BaseStream.CopyTo($msOut)
        $stdout = [System.Text.Encoding]::UTF8.GetString($msOut.ToArray())
      } finally {
        $msOut.Dispose()
      }
      $stderr = $proc.StandardError.ReadToEnd()
      $proc.WaitForExit()
      $exitCode = $proc.ExitCode
    } finally {
      if (-not $proc.HasExited) {
        try { $proc.Kill() } catch { }
      }
      $proc.Dispose()
    }
  } else {
    $transportDir = Join-Path ([System.IO.Path]::GetTempPath()) ('dispatch-store-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $transportDir -Force | Out-Null
    $inFile = Join-Path $transportDir 'in.json'
    $outFile = Join-Path $transportDir 'out.json'
    $errFile = Join-Path $transportDir 'err.txt'
    try {
      [System.IO.File]::WriteAllText($inFile, $inputJson, (New-Object System.Text.UTF8Encoding($false)))
      $fallback = $null
      try {
        $fallback = Start-Process -FilePath $NodeExe -ArgumentList ('"' + $storeJs + '"') `
          -RedirectStandardInput $inFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
          -NoNewWindow -PassThru -ErrorAction Stop
      } catch {
        throw (New-Object System.Exception('NODE_UNAVAILABLE'))
      }
      if ($null -eq $fallback) {
        throw (New-Object System.Exception('NODE_UNAVAILABLE'))
      }
      $fallback.WaitForExit()
      # PS 5.1 的 Start-Process -PassThru 在 WaitForExit() 后 ExitCode 常为空，
      # 这里不依赖退出码：stdout 能解析出 JSON 就按结果处理，否则视为不可用。
      if (Test-Path -LiteralPath $outFile -PathType Leaf) {
        $stdout = [System.IO.File]::ReadAllText($outFile, [System.Text.Encoding]::UTF8)
      }
      if (Test-Path -LiteralPath $errFile -PathType Leaf) {
        $stderr = [System.IO.File]::ReadAllText($errFile, [System.Text.Encoding]::UTF8)
      }
      $exitCode = $fallback.ExitCode
    } finally {
      Remove-Item -LiteralPath $transportDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  if (($exitCode -ne $null) -and ($exitCode -ne 0) -and ($stdout -eq '' -or $stdout -eq $null)) {
    throw (New-Object System.Exception('NODE_UNAVAILABLE'))
  }
  if ($stdout -eq '' -or $stdout -eq $null) {
    throw (New-Object System.Exception('NODE_UNAVAILABLE'))
  }
  try {
    $result = $stdout | ConvertFrom-Json
  } catch {
    throw (New-Object System.Exception('NODE_BAD_OUTPUT'))
  }
  if (-not $result.ok) {
    $err = New-Object System.Exception($result.message)
    $err | Add-Member -NotePropertyName 'StoreCode' -NotePropertyValue $result.code -Force
    throw $err
  }
  return $result
}

# 原子替换：优先 File.Replace（带备份），不可用时回退到 ReplaceFile 等价路径。
# 为什么需要回退：File.Replace 在部分卷/受限会话上会抛 UnauthorizedAccessException
# （实测 Win11 + 本机 NTFS 与 %TEMP% 都复现），此时正式文件与临时文件都还在原地，
# 属于“替换未发生”的确定状态，不是“结果未确认”。如果直接按 UNCONFIRMED 返回，
# 每次 update 都写不进去，写入口等于不可用。
# 回退顺序（每一步都保持“先备份旧版本、再换名、失败可核实”）：
#   1) 先把当前正式文件复制成 replace-bak（等价于 File.Replace 的 backup 参数）；
#   2) 用 MoveFileEx(REPLACE_EXISTING) 做同卷原子换名（NTFS 上等价 ReplaceFile 的核心动作）；
#   3) 若换名仍失败，才判定 UNCONFIRMED 并保留证据。
function Invoke-AtomicReplace {
  param([string]$TempPath, [string]$FormalPath, [string]$BackupPath, [string]$Date, [string]$DataRoot)
  $usedFallback = $false
  $fallbackReason = ''
  try {
    [System.IO.File]::Replace($TempPath, $FormalPath, $BackupPath)
    return @{ ok = $true; usedFallback = $false; fallbackReason = '' }
  } catch {
    $primary = $_.Exception
    if ($primary.InnerException) { $primary = $primary.InnerException }
    $fallbackReason = $primary.GetType().Name + ': ' + $primary.Message
  }

  # ---- 回退：复制旧版本做备份，再用 MoveFileEx 原子换名 ----
  if (-not ('DshAtomicReplaceNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshAtomicReplaceNative {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool MoveFileExW(string existingFileName, string newFileName, uint flags);
}
'@
  }
  try {
    # 1) 备份旧版本（先备份，失败就不换名，避免丢掉最后一个可恢复版本）
    if (Test-Path -LiteralPath $BackupPath -PathType Leaf) {
      $oldBak = Join-Path $DataRoot ($Date + '.json.bak')
      Copy-Item -LiteralPath $BackupPath -Destination $oldBak -Force
    }
    Copy-Item -LiteralPath $FormalPath -Destination $BackupPath -Force
    # 2) 同卷原子换名：MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH。
    #    换名会被“仍持有删除共享的读者”短暂拒绝（ERROR_SHARING_VIOLATION=32 /
    #    ERROR_ACCESS_DENIED=5）。这类冲突是瞬时的，读者读完即关句柄；按 §6.3 对
    #    可恢复共享冲突的约定做短暂重试（总预算 1 秒，不持锁等待退避、不无限重试）。
    #    重试期间临时文件与备份都保持原位，失败仍可核实。
    $flags = 0x1 -bor 0x8
    $deadline = [DateTime]::UtcNow.AddMilliseconds(1000)
    while ($true) {
      $ok = [DshAtomicReplaceNative]::MoveFileExW($TempPath, $FormalPath, [uint32]$flags)
      if ($ok) { break }
      $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if (($err -ne 32 -and $err -ne 5) -or [DateTime]::UtcNow -ge $deadline) {
        return @{ ok = $false; usedFallback = $true; fallbackReason = $fallbackReason; error = ('MoveFileEx err=' + $err) }
      }
      Start-Sleep -Milliseconds 20
    }
    $usedFallback = $true
    return @{ ok = $true; usedFallback = $true; fallbackReason = $fallbackReason }
  } catch {
    $secondary = $_.Exception
    if ($secondary.InnerException) { $secondary = $secondary.InnerException }
    return @{ ok = $false; usedFallback = $true; fallbackReason = $fallbackReason; error = ($secondary.GetType().Name + ': ' + $secondary.Message) }
  }
}

# 孤儿 .tmp 清理：仅持所属日期写锁时进行；只删内容与当前正式文件字节一致的
# 临时文件（其内容已是正式内容，不承载未确认提交）；其余一律保留待核实。
function Remove-OrphanTemps {
  param([string]$FormalPath, [string]$CurrentTemp)
  $dir = Split-Path -Parent $FormalPath
  $formalBytes = $null
  try { $formalBytes = [System.IO.File]::ReadAllBytes($FormalPath) } catch { return }
  foreach ($tmp in (Get-ChildItem -LiteralPath $dir -Filter '*.tmp' -File)) {
    if ($tmp.FullName -eq $CurrentTemp) { continue }
    try {
      $tmpBytes = [System.IO.File]::ReadAllBytes($tmp.FullName)
      if ($tmpBytes.Length -eq $formalBytes.Length) {
        $same = $true
        for ($i = 0; $i -lt $tmpBytes.Length; $i++) {
          if ($tmpBytes[$i] -ne $formalBytes[$i]) { $same = $false; break }
        }
        if ($same) { Remove-Item -LiteralPath $tmp.FullName -Force -ErrorAction SilentlyContinue }
      }
    } catch { }
  }
}

# 成功写入后，尽力把最新正式文件同步到独立备份根（不影响事务成败）。
function Sync-IndependentBackup {
  param([string]$FormalPath, [string]$Date)
  try {
    if (-not (Test-Path -LiteralPath $BackupRoot -PathType Container)) {
      New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
    }
    Copy-Item -LiteralPath $FormalPath -Destination (Join-Path $BackupRoot ($Date + '.json')) -Force
    return $true
  } catch {
    return $false
  }
}

# ---------------------------------------------------------------------------
# 主流程（包在函数里：用 return 提前退出时 finally 仍会释放锁；
# 唯一的 exit 在脚本末尾、锁已释放之后）
# ---------------------------------------------------------------------------
function Invoke-Main {
  $requestBytes = Read-StdinBytes
  if ($requestBytes.Length -gt $SCRIPT:REQUEST_MAX_BYTES) {
    return @{ result = (New-ErrorResult 'REQUEST_TOO_LARGE' '请求体超过 16KiB 上限'); exitCode = 1 }
  }
  $requestText = [System.Text.Encoding]::UTF8.GetString($requestBytes)
  $request = $null
  try {
    $request = $requestText | ConvertFrom-Json
  } catch {
    return @{ result = (New-ErrorResult 'INVALID_FIELD' '请求体不是合法 JSON'); exitCode = 1 }
  }
  if ($null -eq $request -or $request -isnot [PSCustomObject]) {
    return @{ result = (New-ErrorResult 'INVALID_FIELD' '请求体必须是 JSON 对象'); exitCode = 1 }
  }

  if ($Mode -eq 'Verify') {
    if (-not $request.recordId -or ($request.recordId -notmatch $SCRIPT:DISPATCH_ID_RE)) {
      return @{ result = (New-ErrorResult 'INVALID_FIELD' 'Verify 必须提供合法 recordId'); exitCode = 1 }
    }
    $found = Find-DispatchFile -RecordId $request.recordId -HintDate $request.fileDate
    if ($found.candidates.Count -eq 0) {
      if ($found.busy.Count -gt 0) {
        return @{ result = (New-ErrorResult 'UNCONFIRMED' '正式文件正被独占，暂时无法核实记录（可退避重试）' @{ retryable = $true }); exitCode = 3 }
      }
      if ($found.unreadable.Count -gt 0) {
        return @{ result = (New-ErrorResult 'FILE_INVALID' '部分文件无法读取，不能确认记录不存在'); exitCode = 1 }
      }
      return @{ result = (New-ErrorResult 'NOT_FOUND' '记录不存在'); exitCode = 1 }
    }
    $target = $found.candidates[0]
    try {
      $text = Read-FileShared -Path $target.path
      $parsed = $text | ConvertFrom-Json
      # ConvertFrom-Json 会把顶层 JSON 数组当成单个对象返回，@() 直接包会再包一层
      # （count=1，[0] 是整个数组），必须先判 [Array] 再展开，否则 Where-Object
      # 拿到的是整个数组，.id/-eq 的数组比较会误判。
      $arr = @(if ($parsed -is [Array]) { $parsed } else { @($parsed) })
    } catch {
      return @{ result = (New-ErrorResult 'FILE_INVALID' '目标文件损坏或无法读取'); exitCode = 1 }
    }
    $rec = $arr | Where-Object { $_.id -eq $request.recordId } | Select-Object -First 1
    if ($null -eq $rec) {
      return @{ result = (New-ErrorResult 'NOT_FOUND' '记录不存在'); exitCode = 1 }
    }
    $opConfirmed = $false
    if ($request.operationId) { $opConfirmed = ($rec.lastOperationId -eq $request.operationId) }
    return @{ result = @{ ok = $true; found = $true; record = $rec; fileDate = $target.date; revision = $rec.revision; operationConfirmed = $opConfirmed }; exitCode = 0 }
  }

  # ---- Transact ----
  $action = $request.action
  if ($action -ne 'create' -and $action -ne 'update') {
    return @{ result = (New-ErrorResult 'INVALID_FIELD' 'action 必须为 create 或 update'); exitCode = 1 }
  }
  if (-not $request.operationId -or ($request.operationId -notmatch $SCRIPT:UUID_RE)) {
    return @{ result = (New-ErrorResult 'INVALID_FIELD' 'operationId 必须为 UUID 字符串'); exitCode = 1 }
  }
  if ($action -eq 'update' -and ($request.recordId -notmatch $SCRIPT:DISPATCH_ID_RE)) {
    return @{ result = (New-ErrorResult 'INVALID_FIELD' 'update 必须提供合法 recordId'); exitCode = 1 }
  }

  $nowUtc = [DateTime]::UtcNow
  $nowIso = $nowUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  $server = @{ recordedAt = $nowIso; writerVersion = $SCRIPT:WRITER_VERSION; minimumReaderVersion = '1.0.0' }

  try {
    # 确定目标日期文件（锁外定位；锁内重读为准）。
    if ($action -eq 'create') {
      $date = Get-ShanghaiDate -Utc $nowUtc
      $formalPath = Join-Path $DataRoot ($date + '.json')
    } else {
      $found = Find-DispatchFile -RecordId $request.recordId -HintDate $request.fileDate
      if ($found.candidates.Count -eq 0) {
        if ($found.busy.Count -gt 0) {
          return @{ result = (New-ErrorResult 'UNCONFIRMED' '正式文件正被独占，暂时无法定位记录（可退避重试）' @{ retryable = $true }); exitCode = 3 }
        }
        if ($found.unreadable.Count -gt 0) {
          return @{ result = (New-ErrorResult 'FILE_INVALID' '部分文件无法读取，不能确认记录不存在'); exitCode = 1 }
        }
        return @{ result = (New-ErrorResult 'NOT_FOUND' '记录不存在'); exitCode = 1 }
      }
      $date = $found.candidates[0].date
      $formalPath = $found.candidates[0].path
    }

    if (-not (Test-Path -LiteralPath $DataRoot -PathType Container)) {
      New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
    }
    $lockPath = Join-Path $DataRoot ($date + '.json.lock')
    $lock = $null
    $tmpPath = Join-Path $DataRoot ($date + '.json.' + $request.operationId + '.tmp')
    try {
      $lock = Acquire-DispatchLock -LockPath $lockPath
      # 锁内重读正式文件；读失败绝不用 [] 继续。
      if (Test-Path -LiteralPath $formalPath -PathType Leaf) {
        $recordsJson = Read-FileShared -Path $formalPath
      } elseif ($action -eq 'update') {
        return @{ result = (New-ErrorResult 'NOT_FOUND' '记录不存在'); exitCode = 1 }
      } else {
        $recordsJson = '[]'
      }
      if ($null -eq $recordsJson -or $recordsJson.Trim() -eq '') {
        return @{ result = (New-ErrorResult 'FILE_INVALID' '正式文件为空或损坏，拒绝覆盖'); exitCode = 1 }
      }

      $nodeReq = @{
        action = $action
        recordId = $request.recordId
        intentId = $request.intentId
        operationId = $request.operationId
        expectedRevision = $request.expectedRevision
        patch = $request.patch
        payload = $request.payload
        successEvidence = ($request.successEvidence -eq $true)
      }
      $result = Invoke-StoreTransact -RecordsJson $recordsJson -Request $nodeReq -Server $server -NowIso $nowIso
      # 注意：PS 5.1 会把单元素 JSON 数组拍平，@() 强制保持数组形态。
      $recordsArray = @($result.records)
      $newJson = ConvertTo-Json -InputObject $recordsArray -Depth 10 -Compress
      # 注意：PS 5.1 的 ConvertTo-Json 会把 < > & ' 转义成 \u003c 等（JavaScriptSerializer
      # 的 XSS 转义），而 node 的 JSON.stringify 不转义；回写正式文件前把未被反斜杠转义的
      # \u003c/\u003e/\u0026/\u0027 还原成原文字符，保持文件字节与 node 序列化一致。
      # 只替换前面没有反斜杠的转义（前面有反斜杠的是原文里的字面 \u003c 序列，留着不动，
      # 解析后值相同，不会丢数据）；否则含 HTML 的任务在文件里是 \u003c 形式，原文检查会失败。
      $newJson = $newJson -replace '(?<!\\)\\u003c', '<' -replace '(?<!\\)\\u003e', '>' -replace '(?<!\\)\\u0026', '&' -replace '(?<!\\)\\u0027', "'"

      # 同目录临时文件 + Flush(true) + 校验临时 JSON。
      # 文件名带 operationId 便于核实归属，再加一次性随机后缀：同一 operationId 的
      # 重试必须能重新创建临时文件，否则上一次失败留下的证据会挡住本次重试
      #（CreateNew 遇到同名文件直接抛错，重试永远失败）。
      $tmpPath = Join-Path $DataRoot ($date + '.json.' + $request.operationId + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
      $tmpFs = [System.IO.FileStream]::new($tmpPath, [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write, [System.IO.FileShare]::None, 4096,
        [System.IO.FileOptions]::WriteThrough)
      try {
        $tmpBytes = [System.Text.Encoding]::UTF8.GetBytes($newJson)
        $tmpFs.Write($tmpBytes, 0, $tmpBytes.Length)
        $tmpFs.Flush($true)
      } finally {
        $tmpFs.Dispose()
      }
      $tmpText = Read-FileShared -Path $tmpPath
      $tmpParsed = $tmpText | ConvertFrom-Json
      $tmpArray = @(if ($tmpParsed -is [Array]) { $tmpParsed } else { @($tmpParsed) })
      if ($tmpArray.Count -eq 0) {
        return @{ result = (New-ErrorResult 'FILE_INVALID' '临时文件校验失败，未替换正式文件'); exitCode = 1 }
      }

      # 原子替换 + 双版本备份。
      $replaceBak = Join-Path $DataRoot ($date + '.json.replace-bak')
      $bak = Join-Path $DataRoot ($date + '.json.bak')
      $formalExisted = Test-Path -LiteralPath $formalPath -PathType Leaf
      $replaceUsedFallback = $false
      if ($formalExisted) {
        if (Test-Path -LiteralPath $replaceBak -PathType Leaf) {
          Copy-Item -LiteralPath $replaceBak -Destination $bak -Force
        }
        $replaceOutcome = Invoke-AtomicReplace -TempPath $tmpPath -FormalPath $formalPath `
          -BackupPath $replaceBak -Date $date -DataRoot $DataRoot
        if (-not $replaceOutcome.ok) {
          # 两条替换路径都失败：不能假设什么都没发生，按 operationId 核实。
          $verified = $false
          $verifyNote = ('替换失败（' + $replaceOutcome.fallbackReason + ' / ' + $replaceOutcome.error + '）且无法核实')
          try {
            if (Test-Path -LiteralPath $formalPath -PathType Leaf) {
              $checkText = Read-FileShared -Path $formalPath
              $checkParsed = $checkText | ConvertFrom-Json
              $checkArr = @(if ($checkParsed -is [Array]) { $checkParsed } else { @($checkParsed) })
              $checkRec = $checkArr | Where-Object { $_.id -eq $result.record.id } | Select-Object -First 1
              if ($null -ne $checkRec -and $checkRec.revision -eq $result.record.revision -and
                $checkRec.lastOperationId -eq $result.record.lastOperationId) {
                $verified = $true
                $verifyNote = '替换虽抛错但回读证实已提交'
              }
            }
          } catch { }
          if ($verified) {
            return @{ result = @{ ok = $true; record = $result.record; revision = $result.record.revision; operationId = $request.operationId; fileDate = $date; file = $formalPath; changed = $result.changed; replay = $result.replay; note = $verifyNote }; exitCode = 0 }
          }
          # 可重试：正式文件未被改动（回读未证实新内容），用同一 operationId 重发不会
          # 产生第二份业务变更。证据（本次 .tmp）保留，供人工核实。
          return @{ result = (New-ErrorResult 'UNCONFIRMED' ('提交结果未确认：' + $verifyNote) @{ file = $formalPath; operationId = $request.operationId; retryable = $true }); exitCode = 3 }
        }
        $replaceUsedFallback = $replaceOutcome.usedFallback
      } else {
        try {
          [System.IO.File]::Move($tmpPath, $formalPath)
        } catch {
          return @{ result = (New-ErrorResult 'UNCONFIRMED' ('提交结果未确认：首次创建换名失败 ' + $_.Exception.Message) @{ file = $formalPath; operationId = $request.operationId }); exitCode = 3 }
        }
      }

      # 锁内回读核对：文件内容与 node 返回的记录一致（id、revision、lastOperationId）。
      # 注意：不要拿回读记录的 lastOperationId 与本次请求的 operationId 比——幂等重放时
      # node 返回的记录 lastOperationId 是后续操作的 ID（记录已往前走），照旧比会对不上。
      # ConvertFrom-Json 会把顶层 JSON 数组当成单个对象返回，@() 直接包会再包一层，
      # 必须先判 [Array] 再展开，否则回读到的是整个数组，revision/lastOperationId
      # 的数组比较会误判 UNCONFIRMED。
      $verifyText = Read-FileShared -Path $formalPath
      $verifyParsed = $verifyText | ConvertFrom-Json
      $verifyArray = @(if ($verifyParsed -is [Array]) { $verifyParsed } else { @($verifyParsed) })
      $verifyRecord = $verifyArray | Where-Object { $_.id -eq $result.record.id } | Select-Object -First 1
      if ($null -eq $verifyRecord -or $verifyRecord.revision -ne $result.record.revision -or
        $verifyRecord.lastOperationId -ne $result.record.lastOperationId) {
        return @{ result = (New-ErrorResult 'UNCONFIRMED' '回读核对失败，提交结果未确认' @{ file = $formalPath; operationId = $request.operationId }); exitCode = 3 }
      }

      Remove-OrphanTemps -FormalPath $formalPath -CurrentTemp $tmpPath
      $backupOk = Sync-IndependentBackup -FormalPath $formalPath -Date $date
      $successResult = @{ ok = $true; record = $result.record; revision = $result.record.revision; operationId = $request.operationId; fileDate = $date; file = $formalPath; changed = $result.changed; replay = $result.replay; backupSynced = $backupOk }
      if ($replaceUsedFallback) {
        # 让调用方知道这次不是 File.Replace 原生路径，便于核实与排障（不影响成败）。
        $successResult.replaceFallback = $true
      }
      return @{ result = $successResult; exitCode = 0 }
    } finally {
      if ($lock) { $lock.Dispose() }
      # 临时文件残留一律保留（可能是未确认提交的证据），只由持锁的清理规则处理。
    }
  } catch {
    $ex = $_.Exception
    $code = $null
    if ($ex -and $ex.PSObject.Properties['StoreCode'] -and $ex.StoreCode) {
      $code = $ex.StoreCode
    } elseif ($ex -and $ex.PSObject.Properties['Code'] -and $ex.Code) {
      $code = $ex.Code
    } elseif ($ex -and $ex.Message) {
      switch -Wildcard ($ex.Message) {
        'LOCK_TIMEOUT*' { $code = 'LOCK_TIMEOUT' }
        'NODE_UNAVAILABLE*' { $code = 'NODE_UNAVAILABLE' }
        'NODE_STORE_MISSING*' { $code = 'NODE_UNAVAILABLE' }
        'NODE_BAD_OUTPUT*' { $code = 'NODE_UNAVAILABLE' }
        default { $code = 'ERROR' }
      }
    } else {
      $code = 'ERROR'
    }
    $exitCode = 1
    if ($code -eq 'LOCK_TIMEOUT') { $exitCode = 2 }
    if ($code -eq 'NODE_UNAVAILABLE') { $exitCode = 4 }
    $msg = if ($ex -and $ex.Message) { $ex.Message } else { [string]$_ }
    return @{ result = (New-ErrorResult $code $msg); exitCode = $exitCode }
  }
}

$out = $null
try {
  $out = Invoke-Main
} catch {
  $out = @{ result = (New-ErrorResult 'ERROR' ([string]$_)); exitCode = 1 }
}
Write-JsonResult $out.result $out.exitCode
