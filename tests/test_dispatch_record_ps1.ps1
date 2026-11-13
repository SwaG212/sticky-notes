# test_dispatch_record_ps1.ps1
#
# 派活写入口故障注入测试（设计文档 §7.3：K01-K05、K09 + 基本 round-trip）。
# 只在 Windows PowerShell 5.1 上跑，使用临时数据根，不碰真实 userData。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tests/test_dispatch_record_ps1.ps1
#   可选：-RepoRoot <仓库根目录>（默认本文件上一级）。
# 注意：本文件含中文，须保存为 UTF-8 with BOM。

param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

$script:passed = 0
$script:failed = 0
$script:Ps1 = Join-Path $RepoRoot 'scripts\dispatch-record.ps1'
$script:StoreJs = Join-Path $RepoRoot 'dispatch-store.js'
$script:Root = Join-Path ([System.IO.Path]::GetTempPath()) ('dispatch-test-' + [Guid]::NewGuid().ToString('N'))
$script:DataRoot = Join-Path $script:Root 'dispatches'
$script:BackupRoot = Join-Path $script:Root 'dispatch-backups'

function Test-Ok {
  param([bool]$Condition, [string]$Message)
  if ($Condition) {
    $script:passed++
    Write-Host ("  ✓ " + $Message)
  } else {
    $script:failed++
    Write-Host ("  ✗ " + $Message)
  }
}

function Test-Equal {
  param($Actual, $Expected, [string]$Message)
  Test-Ok ($Actual -eq $Expected) ($Message + '（实际：' + $Actual + '，期望：' + $Expected + '）')
}

# 用 Start-Process 跑一次 dispatch-record.ps1，stdin 从临时文件读 JSON。
function Invoke-DispatchPs1 {
  param([string]$Json, [string]$Mode = 'Transact')
  $inFile = Join-Path $script:Root ('in-' + [Guid]::NewGuid().ToString('N') + '.json')
  $outFile = Join-Path $script:Root ('out-' + [Guid]::NewGuid().ToString('N') + '.json')
  [System.IO.File]::WriteAllText($inFile, $Json, (New-Object System.Text.UTF8Encoding($false)))
  $p = Start-Process -FilePath 'powershell' -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:Ps1,
    '-DataRoot', $script:DataRoot, '-BackupRoot', $script:BackupRoot, '-Mode', $Mode
  ) -RedirectStandardInput $inFile -RedirectStandardOutput $outFile -NoNewWindow -PassThru -Wait
  $out = ''
  if (Test-Path -LiteralPath $outFile) { $out = [System.IO.File]::ReadAllText($outFile) }
  $parsed = $null
  try { $parsed = $out | ConvertFrom-Json } catch { }
  return @{ exitCode = $p.ExitCode; raw = $out; result = $parsed }
}

function New-OpId { return [Guid]::NewGuid().ToString() }

# 用 .NET Process 直接启动 dispatch-record.ps1（并发场景）：
# Start-Process -PassThru 在 PS 5.1 里手动 WaitForExit() 后 ExitCode 仍为空
# （实测 Refresh 也无用），只有 -Wait 才能取到，但 -Wait 会串行；这里返回进程对象，
# 调用方自行读 stdout 再 WaitForExit()，ExitCode 可靠。stdin 用 UTF-8 字节写 BaseStream。
function Start-DispatchProc {
  param([string]$Json)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'powershell'
  $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $script:Ps1 + '" -DataRoot "' + $script:DataRoot + '" -BackupRoot "' + $script:BackupRoot + '"'
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $b = [System.Text.Encoding]::UTF8.GetBytes($Json)
  $p.StandardInput.BaseStream.Write($b, 0, $b.Length)
  $p.StandardInput.BaseStream.Flush()
  $p.StandardInput.Close()
  return $p
}

function New-CreateRequest {
  param([string]$Task = '测试派活', [string]$Model = 'GLM', [string]$IntentId = 'intent-test-1', [string]$Id = '')
  $payload = @{
    task = $Task; model = $Model; intentId = $IntentId
    dispatchedAt = ([DateTime]::UtcNow).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
  if ($Id -ne '') { $payload.id = $Id }
  return (@{ action = 'create'; operationId = (New-OpId); payload = $payload } | ConvertTo-Json -Depth 10 -Compress)
}

# 后台持锁进程：独占打开指定 .lock 文件并睡 N 秒。返回 Process 对象。
function Start-LockHolder {
  param([string]$LockPath, [int]$Seconds)
  $code = '$fs = [System.IO.FileStream]::new(''' + $LockPath + ''', [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); Start-Sleep -Seconds ' + $Seconds + '; $fs.Dispose()'
  $p = Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile', '-Command', $code) -NoNewWindow -PassThru
  Start-Sleep -Milliseconds 800
  return $p
}

try {
  if (-not (Test-Path -LiteralPath $script:Ps1 -PathType Leaf)) { throw '找不到 dispatch-record.ps1：' + $script:Ps1 }
  if (-not (Test-Path -LiteralPath $script:StoreJs -PathType Leaf)) { throw '找不到 dispatch-store.js：' + $script:StoreJs }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node 不在 PATH 上，无法测试' }
  New-Item -ItemType Directory -Path $script:DataRoot -Force | Out-Null

  Write-Host '基本 round-trip（create → verify → update → 重复 create → revision 冲突）'
  $basicId = 'dispatch_2026-11-12_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  $createJson = New-CreateRequest -Task '基本 round-trip' -IntentId 'intent-basic' -Id $basicId
  $create = Invoke-DispatchPs1 -Json $createJson
  Test-Equal $create.exitCode 0 'create 退出 0'
  Test-Ok ($create.result -and $create.result.ok -eq $true) 'create 返回 ok'
  $recordId = $create.result.record.id
  $fileDate = $create.result.fileDate
  Test-Ok ($recordId -match '^dispatch_\d{4}-\d{2}-\d{2}_') 'create 返回合法派活 ID'
  Test-Equal $create.result.record.revision 1 'create revision=1'
  $formal = Join-Path $script:DataRoot ($fileDate + '.json')
  Test-Ok (Test-Path -LiteralPath $formal -PathType Leaf) '正式日期文件已创建'
  $backupCopy = Join-Path $script:BackupRoot ($fileDate + '.json')
  Test-Ok (Test-Path -LiteralPath $backupCopy -PathType Leaf) '独立备份根已同步最新正式文件'

  $verifyJson = (@{ recordId = $recordId; operationId = $create.result.operationId } | ConvertTo-Json -Compress)
  $verify = Invoke-DispatchPs1 -Json $verifyJson -Mode 'Verify'
  Test-Equal $verify.exitCode 0 'verify 退出 0'
  Test-Ok ($verify.result.operationConfirmed -eq $true) 'verify 按 operationId 核实通过'

  $op2 = New-OpId
  $updateJson = (@{
    action = 'update'; recordId = $recordId; operationId = $op2; expectedRevision = 1
    patch = @{ status = 'running'; executorRef = 'exec-test-1' }
  } | ConvertTo-Json -Depth 10 -Compress)
  $update = Invoke-DispatchPs1 -Json $updateJson
  Test-Equal $update.exitCode 0 'update 退出 0'
  Test-Equal $update.result.record.revision 2 'update 后 revision=2'
  Test-Equal $update.result.record.status 'running' 'update 后状态 running'

  # 原样重发同一 create 请求（同一 operationId、同一 id、同一 dispatchedAt）→ 幂等重放。
  $dup = Invoke-DispatchPs1 -Json $createJson
  Test-Equal $dup.exitCode 0 '重复 create 退出 0'
  Test-Ok ($dup.result.replay -eq $true) '重复 create 识别为重放'
  Test-Equal $dup.result.record.revision 2 '重复 create 不重置 revision'
  Test-Equal $dup.result.record.status 'running' '重复 create 不重置状态'

  $staleJson = (@{
    action = 'update'; recordId = $recordId; operationId = (New-OpId); expectedRevision = 1
    patch = @{ status = 'blocked'; statusDetail = '旧版本重试' }
  } | ConvertTo-Json -Depth 10 -Compress)
  $stale = Invoke-DispatchPs1 -Json $staleJson
  Test-Equal $stale.exitCode 1 '旧 revision 更新退出 1'
  Test-Equal $stale.result.code 'REVISION_CONFLICT' '旧 revision 错误码 REVISION_CONFLICT'

  Write-Host 'K01：同日并发写不同 ID'
  $job1Json = New-CreateRequest -Task '并发 A' -IntentId 'intent-k01a'
  $job2Json = New-CreateRequest -Task '并发 B' -IntentId 'intent-k01b'
  $p1 = Start-DispatchProc -Json $job1Json
  $p2 = Start-DispatchProc -Json $job2Json
  $o1 = $p1.StandardOutput.ReadToEnd(); $p1.WaitForExit(); $null = $p1.StandardError.ReadToEnd()
  $o2 = $p2.StandardOutput.ReadToEnd(); $p2.WaitForExit(); $null = $p2.StandardError.ReadToEnd()
  Test-Equal $p1.ExitCode 0 'K01 并发写 A 退出 0'
  Test-Equal $p2.ExitCode 0 'K01 并发写 B 退出 0'
  $finalText = [System.IO.File]::ReadAllText($formal)
  $finalParsed = $finalText | ConvertFrom-Json
  # 同 ps1 的坑：ConvertFrom-Json 把顶层数组当单个对象返回，@() 直接包会再包一层，
  # Where-Object 拿到的就是整个数组，.Count 是文件总记录数不是匹配数。
  $finalArr = @(if ($finalParsed -is [Array]) { $finalParsed } else { @($finalParsed) })
  Test-Ok ((@($finalArr | Where-Object { $_.intentId -eq 'intent-k01a' })).Count -eq 1) 'K01 并发 A 记录在文件内'
  Test-Ok ((@($finalArr | Where-Object { $_.intentId -eq 'intent-k01b' })).Count -eq 1) 'K01 并发 B 记录在文件内'

  Write-Host 'K02：不同日期锁独立 + 跨日补报回原文件'
  $otherDate = '2099-01-02'
  $otherLock = Join-Path $script:DataRoot ($otherDate + '.json.lock')
  $holder = Start-LockHolder -LockPath $otherLock -Seconds 20
  try {
    $k02 = Invoke-DispatchPs1 -Json (New-CreateRequest -Task 'K02 不同日期' -IntentId 'intent-k02')
    Test-Equal $k02.exitCode 0 'K02 他日锁被占时今日写入仍成功'
  } finally {
    if ($holder -and -not $holder.HasExited) { Stop-Process -Id $holder.Id -Force -ErrorAction SilentlyContinue }
  }
  $filesBefore = @(Get-ChildItem -LiteralPath $script:DataRoot -Filter '*.json' -File | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}\.json$' }).Count
  $opK02 = New-OpId
  $k02Update = (@{
    action = 'update'; recordId = $recordId; operationId = $opK02; expectedRevision = 2
    patch = @{ status = 'blocked'; statusDetail = 'K02 跨日补报' }
  } | ConvertTo-Json -Depth 10 -Compress)
  $k02u = Invoke-DispatchPs1 -Json $k02Update
  Test-Equal $k02u.exitCode 0 'K02 同 ID 更新退出 0'
  $filesAfter = @(Get-ChildItem -LiteralPath $script:DataRoot -Filter '*.json' -File | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}\.json$' }).Count
  Test-Equal $filesAfter $filesBefore 'K02 更新未新建日期文件（一次只写一日期）'

  Write-Host 'K03：永久 .lock 文件 + 10 秒超时'
  $todayLock = Join-Path $script:DataRoot ($fileDate + '.json.lock')
  if (Test-Path -LiteralPath $todayLock) { Remove-Item -LiteralPath $todayLock -Force }
  New-Item -ItemType File -Path $todayLock -Force | Out-Null
  $k03a = Invoke-DispatchPs1 -Json (New-CreateRequest -Task 'K03 空锁文件' -IntentId 'intent-k03a')
  Test-Equal $k03a.exitCode 0 'K03 无活句柄的 .lock 文件不阻塞写入'
  $holder3 = Start-LockHolder -LockPath $todayLock -Seconds 25
  try {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $k03b = Invoke-DispatchPs1 -Json (New-CreateRequest -Task 'K03 抢锁超时' -IntentId 'intent-k03b')
    $sw.Stop()
    Test-Equal $k03b.exitCode 2 'K03 活锁被占时退出 2（LOCK_TIMEOUT）'
    Test-Equal $k03b.result.code 'LOCK_TIMEOUT' 'K03 错误码 LOCK_TIMEOUT'
    Test-Ok ($sw.ElapsedMilliseconds -ge 9000 -and $sw.ElapsedMilliseconds -le 20000) ('K03 超时约 10 秒（实际 ' + $sw.ElapsedMilliseconds + 'ms）')
  } finally {
    if ($holder3 -and -not $holder3.HasExited) { Stop-Process -Id $holder3.Id -Force -ErrorAction SilentlyContinue }
  }

  Write-Host 'K04：强杀持锁进程后锁释放、数据完好'
  $holder4 = Start-LockHolder -LockPath $todayLock -Seconds 60
  Stop-Process -Id $holder4.Id -Force
  Start-Sleep -Seconds 2
  $k04 = Invoke-DispatchPs1 -Json (New-CreateRequest -Task 'K04 强杀后写入' -IntentId 'intent-k04')
  Test-Equal $k04.exitCode 0 'K04 强杀持锁进程后写入成功'
  $afterKillParsed = [System.IO.File]::ReadAllText($formal) | ConvertFrom-Json
  $afterKill = @(if ($afterKillParsed -is [Array]) { $afterKillParsed } else { @($afterKillParsed) })
  Test-Ok ((@($afterKill | Where-Object { $_.id -eq $recordId })).Count -eq 1) 'K04 强杀后旧记录仍在'

  Write-Host 'K05：活事务暂停超 30 秒仍互斥、读取共享可用'
  $holder5 = Start-LockHolder -LockPath $todayLock -Seconds 35
  try {
    $sw5 = [System.Diagnostics.Stopwatch]::StartNew()
    $k05 = Invoke-DispatchPs1 -Json (New-CreateRequest -Task 'K05 长暂停' -IntentId 'intent-k05')
    $sw5.Stop()
    Test-Equal $k05.exitCode 2 'K05 锁被占 35 秒时写入仍超时（未被 30 秒规则抢走）'
    Test-Ok ($sw5.ElapsedMilliseconds -ge 9000) 'K05 超时等待约 10 秒'
    $readOk = $false
    try {
      $fs = [System.IO.FileStream]::new($formal, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
      $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
      $t = $sr.ReadToEnd()
      $sr.Dispose(); $fs.Dispose()
      $readOk = $t.Contains($recordId)
    } catch { $readOk = $false }
    Test-Ok $readOk 'K05 持锁期间读取共享仍可读正式文件'
  } finally {
    if ($holder5 -and -not $holder5.HasExited) { Stop-Process -Id $holder5.Id -Force -ErrorAction SilentlyContinue }
  }

  Write-Host 'K09：越权与非法输入'
  $bigTask = 'x' * 20000
  $bigJson = (@{ action = 'create'; operationId = (New-OpId); payload = @{ task = $bigTask; model = 'GLM'; intentId = 'intent-k09'; dispatchedAt = ([DateTime]::UtcNow).ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } } | ConvertTo-Json -Depth 10 -Compress)
  $big = Invoke-DispatchPs1 -Json $bigJson
  Test-Equal $big.result.code 'REQUEST_TOO_LARGE' 'K09 超 16KiB 请求拒绝'
  $travJson = (@{
    action = 'update'; recordId = 'dispatch_2026-11-12_11111111-1111-4111-8111-111111111111/../../evil'; operationId = (New-OpId); expectedRevision = 1; patch = @{ status = 'running' }
  } | ConvertTo-Json -Depth 10 -Compress)
  $trav = Invoke-DispatchPs1 -Json $travJson
  Test-Equal $trav.result.code 'INVALID_FIELD' 'K09 目录穿越式 recordId 拒绝'
  $badModelJson = New-CreateRequest -Task 'K09 非法模型' -Model 'Claude' -IntentId 'intent-k09m'
  $badModel = Invoke-DispatchPs1 -Json $badModelJson
  Test-Equal $badModel.result.code 'INVALID_FIELD' 'K09 白名单外模型拒绝'
  $htmlTask = '<script>alert(1)</script> 测试'
  $htmlJson = New-CreateRequest -Task $htmlTask -IntentId 'intent-k09h'
  $html = Invoke-DispatchPs1 -Json $htmlJson
  Test-Equal $html.exitCode 0 'K09 含 HTML 的任务可写入'
  $htmlText = [System.IO.File]::ReadAllText($formal)
  Test-Ok $htmlText.Contains('<script>alert(1)</script>') 'K09 HTML 内容按纯文本原文保存（不执行、不转义丢失）'
  $evilFile = Join-Path $script:Root 'evil.json'
  Test-Ok (-not (Test-Path -LiteralPath $evilFile)) 'K09 未在数据根外写出文件'

  Write-Host ''
  Write-Host ('通过 ' + $script:passed + ' 失败 ' + $script:failed)
  if ($script:failed -gt 0) { exit 1 }
} finally {
  try { Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}
