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

. (Join-Path $PSScriptRoot 'process-file-io.ps1')

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
    Write-Host ("  [PASS] " + $Message)
  } else {
    $script:failed++
    # 失败行加 ASCII 前缀，便于在 GBK/UTF-8 混杂的控制台输出里稳定 grep。
    Write-Host ("  [FAIL] " + $Message)
  }
}

function Test-Equal {
  param($Actual, $Expected, [string]$Message)
  Test-Ok ($Actual -eq $Expected) ($Message + '（实际：' + $Actual + '，期望：' + $Expected + '）')
}

# 用带文件重定向的启动器跑一次 dispatch-record.ps1，stdin 从临时文件读 JSON。
# 受限会话（Job 对象/无交互桌面）里 Start-Process -Wait 与匿名管道会被拒，
# 所以统一走 tests/process-file-io.ps1（原生 CreateProcessW + 文件句柄），
# 它同时给出真实退出码；正常会话下也是同一条写入口，不改断言。
function Invoke-DispatchPs1 {
  param([string]$Json, [string]$Mode = 'Transact')
  $inFile = Join-Path $script:Root ('in-' + [Guid]::NewGuid().ToString('N') + '.json')
  $outFile = Join-Path $script:Root ('out-' + [Guid]::NewGuid().ToString('N') + '.json')
  $errFile = Join-Path $script:Root ('err-' + [Guid]::NewGuid().ToString('N') + '.json')
  [System.IO.File]::WriteAllText($inFile, $Json, (New-Object System.Text.UTF8Encoding($false)))
  $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $script:Ps1 + '" -DataRoot "' + $script:DataRoot + '" -BackupRoot "' + $script:BackupRoot + '" -Mode ' + $Mode
  $proc = Start-FileIoProcess -FilePath 'powershell.exe' -Arguments $argLine `
    -InputFile $inFile -OutputFile $outFile -ErrorFile $errFile -WorkingDirectory $RepoRoot
  $exitCode = Wait-FileIoProcess -Process $proc
  $out = ''
  if (Test-Path -LiteralPath $outFile) { $out = [System.IO.File]::ReadAllText($outFile) }
  $parsed = $null
  try { $parsed = $out | ConvertFrom-Json } catch { }
  return @{ exitCode = $exitCode; raw = $out; result = $parsed }
}

function New-OpId { return [Guid]::NewGuid().ToString() }

# 并发场景：同样走文件重定向启动器（原生 CreateProcessW），返回可并发等待的句柄对象。
# 调用方先各自 Wait-FileIoProcess 再读自己的 out 文件，保证真并发且退出码可靠。
function Start-DispatchProc {
  param([string]$Json)
  $inFile = Join-Path $script:Root ('cin-' + [Guid]::NewGuid().ToString('N') + '.json')
  $outFile = Join-Path $script:Root ('cout-' + [Guid]::NewGuid().ToString('N') + '.json')
  $errFile = Join-Path $script:Root ('cerr-' + [Guid]::NewGuid().ToString('N') + '.json')
  [System.IO.File]::WriteAllText($inFile, $Json, (New-Object System.Text.UTF8Encoding($false)))
  $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $script:Ps1 + '" -DataRoot "' + $script:DataRoot + '" -BackupRoot "' + $script:BackupRoot + '"'
  $proc = Start-FileIoProcess -FilePath 'powershell.exe' -Arguments $argLine `
    -InputFile $inFile -OutputFile $outFile -ErrorFile $errFile -WorkingDirectory $RepoRoot
  $proc | Add-Member -NotePropertyName OutFile -NotePropertyValue $outFile -Force
  $proc | Add-Member -NotePropertyName ErrFile -NotePropertyValue $errFile -Force
  return $proc
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

# 后台持锁进程：独占打开指定 .lock 文件并睡 N 秒。返回启动器对象。
# 用独立脚本 + 文件重定向启动，受限会话里也能真实持有 FileShare.None 句柄；
# 启动后轮询锁文件里的 "LOCKED <pid>" 标记，确认句柄真的拿到再继续。
function Start-LockHolder {
  param([string]$LockPath, [int]$Seconds)
  $holderScript = Join-Path $PSScriptRoot 'lock-holder.ps1'
  $outFile = Join-Path $script:Root ('holder-out-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $errFile = Join-Path $script:Root ('holder-err-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $emptyIn = Join-Path $script:Root ('holder-in-' + [Guid]::NewGuid().ToString('N') + '.txt')
  [System.IO.File]::WriteAllText($emptyIn, '', (New-Object System.Text.UTF8Encoding($false)))
  $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $holderScript + '" -LockPath "' + $LockPath + '" -Seconds ' + $Seconds
  $proc = Start-FileIoProcess -FilePath 'powershell.exe' -Arguments $argLine `
    -InputFile $emptyIn -OutputFile $outFile -ErrorFile $errFile -WorkingDirectory $RepoRoot -TimeoutMs 120000
  # 判定“句柄真的被持有”：holder 以 FileShare.None 打开锁文件，任何读取/再次独占
  # 打开都会失败。所以这里不能读文件内容（读必然抛共享冲突，永远确认不了），
  # 而是主动以 FileShare.None 探测一次：抛 IOException = 已被别人独占 = 持有成功。
  $deadline = (Get-Date).AddSeconds(15)
  $locked = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 150
    if (Test-Path -LiteralPath $LockPath) {
      try {
        $probe = [System.IO.FileStream]::new($LockPath, [System.IO.FileMode]::Open,
          [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $probe.Dispose()
      } catch [System.IO.IOException] {
        $locked = $true
        break
      }
    }
  }
  if (-not $locked) {
    throw ('持锁进程未确认取得句柄：' + $LockPath + ' err=' + (Get-Content $errFile -Raw -ErrorAction SilentlyContinue))
  }
  $proc | Add-Member -NotePropertyName HolderOutFile -NotePropertyValue $outFile -Force
  return $proc
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
  $c1 = Wait-FileIoProcess -Process $p1
  $c2 = Wait-FileIoProcess -Process $p2
  $o1 = if (Test-Path -LiteralPath $p1.OutFile) { [System.IO.File]::ReadAllText($p1.OutFile) } else { '' }
  $o2 = if (Test-Path -LiteralPath $p2.OutFile) { [System.IO.File]::ReadAllText($p2.OutFile) } else { '' }
  Test-Equal $c1 0 ('K01 并发写 A 退出 0（stdout：' + $o1.Trim() + '）')
  Test-Equal $c2 0 ('K01 并发写 B 退出 0（stdout：' + $o2.Trim() + '）')
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
    if ($holder) { Stop-FileIoProcess -Process $holder }
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

  # 跨午夜补报：文件归属取 PC 首次成功持久化的 recordedAt（今天），
  # ID 前缀取 Muse 冻结的派发日期（旧日期）。二者不同是合法的（§2.1 / §6.3）。
  # 关键是：后续 update 必须回到 create 时的原文件，不能在“今天”再新建一份。
  Write-Host 'K02b：跨午夜补报仍写原日期文件（ID 前缀≠文件日期）'
  $oldDate = '2026-01-05'
  $oldId = 'dispatch_' + $oldDate + '_' + [Guid]::NewGuid().ToString()
  $oldOp = New-OpId
  $oldCreate = (@{
    action = 'create'; operationId = $oldOp
    payload = @{
      id = $oldId; task = 'K02b 跨午夜补报'; model = 'GLM'; intentId = 'intent-k02b'
      dispatchedAt = ($oldDate + 'T15:50:00.000Z')
    }
  } | ConvertTo-Json -Depth 10 -Compress)
  $oldRes = Invoke-DispatchPs1 -Json $oldCreate
  Test-Equal $oldRes.exitCode 0 'K02b 旧派发日期 create 成功'
  $createdDate = $oldRes.result.fileDate
  $createdFile = $oldRes.result.file
  Test-Ok ($createdDate -match '^\d{4}-\d{2}-\d{2}$') ('K02b create 返回已确认文件归属（' + $createdDate + '）')
  Test-Ok ($oldId.StartsWith('dispatch_' + $oldDate + '_')) 'K02b ID 前缀保留冻结的派发日期'
  Test-Ok ($createdDate -ne $oldDate) 'K02b 文件日期按 recordedAt（今天）而非 ID 前缀日期（二者可不同）'
  $createdHashBefore = (Get-FileHash -LiteralPath $createdFile -Algorithm SHA256).Hash
  $oldFile = Join-Path $script:DataRoot ($oldDate + '.json')
  Test-Ok (-not (Test-Path -LiteralPath $oldFile)) 'K02b 未按 ID 前缀另建旧日期文件'
  # 补报：只带 recordId（不带 fileDate 提示），服务端必须自己定位回 create 时的原文件。
  $oldUpdate = (@{
    action = 'update'; recordId = $oldId; operationId = (New-OpId); expectedRevision = 1
    patch = @{ status = 'completed'; progress = 100; finishedAt = '2026-01-06T01:10:00.000Z' }
    successEvidence = $true
  } | ConvertTo-Json -Depth 10 -Compress)
  $oldUpd = Invoke-DispatchPs1 -Json $oldUpdate
  Test-Equal $oldUpd.exitCode 0 'K02b 跨午夜补报退出 0'
  Test-Equal $oldUpd.result.fileDate $createdDate 'K02b 补报回到 create 时的原文件日期'
  Test-Equal $oldUpd.result.file $createdFile 'K02b 补报写到同一个文件'
  $createdHashAfter = (Get-FileHash -LiteralPath $createdFile -Algorithm SHA256).Hash
  Test-Ok ($createdHashAfter -ne $createdHashBefore) 'K02b 原文件确实被更新'
  $dateFileCount = @(Get-ChildItem -LiteralPath $script:DataRoot -Filter '*.json' -File | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}\.json$' }).Count
  Test-Equal $dateFileCount 1 'K02b 全程只有一个日期文件（一次只改一个日期）'
  $oldParsed = [System.IO.File]::ReadAllText($createdFile) | ConvertFrom-Json
  $oldArr = @(if ($oldParsed -is [Array]) { $oldParsed } else { @($oldParsed) })
  $oldRec = $oldArr | Where-Object { $_.id -eq $oldId } | Select-Object -First 1
  Test-Equal $oldRec.status 'completed' 'K02b 原文件记录已是 completed'
  Test-Equal $oldRec.revision 2 'K02b 原文件记录 revision=2'
  Test-Equal $oldRec.recordedAt $oldUpd.result.record.recordedAt 'K02b recordedAt 未被补报重置'

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
    if ($holder3) { Stop-FileIoProcess -Process $holder3 }
  }

  Write-Host 'K04：强杀持锁进程后锁释放、数据完好'
  $holder4 = Start-LockHolder -LockPath $todayLock -Seconds 60
  Stop-FileIoProcess -Process $holder4
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
    if ($holder5) { Stop-FileIoProcess -Process $holder5 }
  }

  # 休眠/唤醒：句柄生命周期由操作系统管理，唤醒后未失效的活句柄仍必须互斥，
  # 且不能因为“挂起超过 30 秒”被当成残留锁抢走。用 40 秒挂起 + 唤醒后立即抢锁验证。
  Write-Host 'K05b：长时间挂起（模拟休眠）后活句柄仍互斥、唤醒不双写'
  # 用一个独立的日期锁，避免与前一条 K05 的 holder 释放时序互相影响。
  $sleepLockDate = '2099-03-04'
  $sleepLock = Join-Path $script:DataRoot ($sleepLockDate + '.json.lock')
  $holder5b = Start-LockHolder -LockPath $sleepLock -Seconds 60
  try {
    Start-Sleep -Seconds 40
    $sw5b = [System.Diagnostics.Stopwatch]::StartNew()
    # 直接打同一个日期锁，才能验证“这个活句柄”是否仍互斥。
    $sleepReq = (@{
      action = 'create'; operationId = (New-OpId)
      payload = @{ task = 'K05b 唤醒后抢锁'; model = 'GLM'; intentId = 'intent-k05b'; dispatchedAt = ([DateTime]::UtcNow).ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
    } | ConvertTo-Json -Depth 10 -Compress)
    # create 走“今天”的锁，所以这里改用 update 指向该日期文件的记录不可行；
    # 改为直接对同一锁文件做一次 Acquire 语义验证：用 holder 之外的新进程尝试独占。
    $probeScript = Join-Path $script:Root ('sleep-probe-' + [Guid]::NewGuid().ToString('N') + '.ps1')
    $probeOut = Join-Path $script:Root ('sleep-probe-out-' + [Guid]::NewGuid().ToString('N') + '.txt')
    $probeCode = @'
param([string]$LockPath)
try {
  $fs = [System.IO.FileStream]::new($LockPath, [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  $fs.Dispose()
  Write-Output 'ACQUIRED'
} catch [System.IO.IOException] {
  Write-Output 'BLOCKED'
}
'@
    [System.IO.File]::WriteAllText($probeScript, $probeCode, (New-Object System.Text.UTF8Encoding($true)))
    $probeArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + $probeScript + '" -LockPath "' + $sleepLock + '"'
    $probeIn = Join-Path $script:Root ('sleep-in-' + [Guid]::NewGuid().ToString('N') + '.txt')
    [System.IO.File]::WriteAllText($probeIn, '', (New-Object System.Text.UTF8Encoding($false)))
    $probeErr = Join-Path $script:Root ('sleep-err-' + [Guid]::NewGuid().ToString('N') + '.txt')
    $probeProc = Start-FileIoProcess -FilePath 'powershell.exe' -Arguments $probeArgs -InputFile $probeIn -OutputFile $probeOut -ErrorFile $probeErr -WorkingDirectory $RepoRoot -TimeoutMs 60000
    $probeExit = Wait-FileIoProcess -Process $probeProc
    $sw5b.Stop()
    $probeResult = ''
    if (Test-Path -LiteralPath $probeOut) { $probeResult = ([System.IO.File]::ReadAllText($probeOut)).Trim() }
    Test-Equal $probeExit 0 'K05b 探测进程正常退出'
    Test-Equal $probeResult 'BLOCKED' 'K05b 挂起 40 秒后活句柄仍互斥（未被当成残留锁抢走）'
  } finally {
    if ($holder5b) { Stop-FileIoProcess -Process $holder5b }
  }
  # 句柄释放后同一锁立即可得，且只产生一份业务变更（唤醒不双写）。
  $afterRelease = Join-Path $script:Root ('sleep-after-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $afterArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + $probeScript + '" -LockPath "' + $sleepLock + '"'
  $afterIn = Join-Path $script:Root ('sleep-after-in-' + [Guid]::NewGuid().ToString('N') + '.txt')
  [System.IO.File]::WriteAllText($afterIn, '', (New-Object System.Text.UTF8Encoding($false)))
  $afterErr = Join-Path $script:Root ('sleep-after-err-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $afterProc = Start-FileIoProcess -FilePath 'powershell.exe' -Arguments $afterArgs -InputFile $afterIn -OutputFile $afterRelease -ErrorFile $afterErr -WorkingDirectory $RepoRoot -TimeoutMs 60000
  $afterExit = Wait-FileIoProcess -Process $afterProc
  $afterResult = ''
  if (Test-Path -LiteralPath $afterRelease) { $afterResult = ([System.IO.File]::ReadAllText($afterRelease)).Trim() }
  Test-Equal $afterResult 'ACQUIRED' 'K05b 句柄释放后锁立即可得（唤醒不卡死）'
  $k05c = Invoke-DispatchPs1 -Json (New-CreateRequest -Task 'K05b 唤醒后写入' -IntentId 'intent-k05c')
  Test-Equal $k05c.exitCode 0 'K05b 唤醒后正常写入成功（不双写）'

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

  # 磁盘满 / 目录不可写：写入必须明确失败并保留证据，不能静默成功。
  Write-Host 'B：目录不可写时明确失败（磁盘/权限故障）'
  $roRoot = Join-Path $script:Root ('ro-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $roRoot -Force | Out-Null
  $roDisp = Join-Path $roRoot 'dispatches'
  New-Item -ItemType Directory -Path $roDisp -Force | Out-Null
  # 用 ACL 拒绝当前用户写入来模拟磁盘/权限故障（失败则退化为只读属性标记并记 NOTE）。
  $roBlocked = $false
  try {
    $acl = Get-Acl -LiteralPath $roDisp
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
      'CreateFiles,WriteData', 'Deny')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $roDisp -AclObject $acl
    $roBlocked = $true
  } catch { $roBlocked = $false }
  try {
    $roArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + $script:Ps1 + '" -DataRoot "' + $roDisp + '" -BackupRoot "' + (Join-Path $roRoot 'bak') + '"'
    $roIn = Join-Path $script:Root ('ro-in-' + [Guid]::NewGuid().ToString('N') + '.json')
    $roOut = Join-Path $script:Root ('ro-out-' + [Guid]::NewGuid().ToString('N') + '.json')
    $roErr = Join-Path $script:Root ('ro-err-' + [Guid]::NewGuid().ToString('N') + '.txt')
    [System.IO.File]::WriteAllText($roIn, (New-CreateRequest -Task 'B 只读目录' -IntentId 'intent-ro'), (New-Object System.Text.UTF8Encoding($false)))
    $roProc = Start-FileIoProcess -FilePath 'powershell.exe' -Arguments $roArgs -InputFile $roIn -OutputFile $roOut -ErrorFile $roErr -WorkingDirectory $RepoRoot
    $roCode = Wait-FileIoProcess -Process $roProc
    $roRes = $null
    if (Test-Path -LiteralPath $roOut) { try { $roRes = [System.IO.File]::ReadAllText($roOut) | ConvertFrom-Json } catch { } }
    if ($roBlocked) {
      Test-Ok ($roCode -ne 0) 'B 目录不可写时写入失败（非静默成功）'
      Test-Ok ($roRes -and $roRes.ok -ne $true) 'B 目录不可写时返回 ok=false'
      $roFiles = @(Get-ChildItem -LiteralPath $roDisp -File -ErrorAction SilentlyContinue)
      Test-Equal $roFiles.Count 0 'B 目录不可写时未留下半成品正式文件'
    } else {
      Write-Host '  [NOTE] 无法设置 Deny ACL（受限会话），跳过目录不可写断言'
    }
  } finally {
    if ($roBlocked) {
      try {
        $acl2 = Get-Acl -LiteralPath $roDisp
        $acl2.Access | Where-Object { $_.AccessControlType -eq 'Deny' } | ForEach-Object { $acl2.RemoveAccessRule($_) | Out-Null }
        Set-Acl -LiteralPath $roDisp -AclObject $acl2
      } catch { }
    }
  }

  Write-Host 'B：孤儿 .tmp 清理边界（只删与正式文件一致的，其余保留为证据）'
  $dateB = '2099-02-03'
  $fileB = Join-Path $script:DataRoot ($dateB + '.json')
  $createB = Invoke-DispatchPs1 -Json (New-CreateRequest -Task 'B 临时文件' -IntentId 'intent-btmp')
  Test-Equal $createB.exitCode 0 'B 基线写入成功'
  $formalNow = $createB.result.file
  # 清理只在“持锁成功写入后”执行，且只删“内容与当前正式文件完全一致”的孤儿 .tmp。
  # 因此必须用一次不改动正式文件字节的写入来触发：同状态 no-op update（业务无变化
  # 时不更新时间、不改内容），这样 formal 字节保持与预置 tmp 相同。
  $finalTmp = Invoke-DispatchPs1 -Json (New-CreateRequest -Task 'B 触发清理' -IntentId 'intent-btmp2')
  Test-Equal $finalTmp.exitCode 0 'B 清理触发写入成功'
  $formalBytes = [System.IO.File]::ReadAllBytes($formalNow)
  # 与正式文件字节一致的孤儿 tmp：内容已是正式内容，可安全清理。
  $sameTmp = Join-Path $script:DataRoot ((Split-Path -Leaf $formalNow) + '.deadbeef-0000-4000-8000-000000000000.tmp')
  [System.IO.File]::WriteAllBytes($sameTmp, $formalBytes)
  # 承载未确认提交的 tmp：内容与正式文件不同，必须保留。
  $diffTmp = Join-Path $script:DataRoot ((Split-Path -Leaf $formalNow) + '.deadbeef-0000-4000-8000-000000000001.tmp')
  [System.IO.File]::WriteAllText($diffTmp, '[{"id":"unconfirmed"}]', (New-Object System.Text.UTF8Encoding($false)))
  # no-op update：状态不变，正式文件字节不变，因此 sameTmp 仍与正式文件一致 → 应被清理；
  # diffTmp 始终不一致 → 必须保留。
  $parsedNoop = [System.IO.File]::ReadAllText($formalNow) | ConvertFrom-Json
  $arrNoop = @(if ($parsedNoop -is [Array]) { $parsedNoop } else { @($parsedNoop) })
  $recNoop = $arrNoop | Where-Object { $_.id -eq $createB.result.record.id } | Select-Object -First 1
  $noopJson = (@{
    action = 'update'; recordId = $recNoop.id; operationId = (New-OpId); expectedRevision = $recNoop.revision
    patch = @{ status = $recNoop.status }
  } | ConvertTo-Json -Depth 10 -Compress)
  $afterTmpWrite = Invoke-DispatchPs1 -Json $noopJson
  Test-Equal $afterTmpWrite.exitCode 0 'B 清理触发写入成功（no-op update）'
  Test-Ok (-not (Test-Path -LiteralPath $sameTmp)) 'B 与正式文件一致的孤儿 .tmp 被清理'
  Test-Ok (Test-Path -LiteralPath $diffTmp) 'B 内容不同的 .tmp 保留为未确认证据（不按年龄删除）'
  Remove-Item -LiteralPath $diffTmp -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $sameTmp -Force -ErrorAction SilentlyContinue

  # 磁盘/回读失败：正式文件被外部只读共享句柄占住时，替换/回读必须明确报
  # UNCONFIRMED（可核实），不能当成“提交成功”，也不能把正式文件读成空集合继续覆盖。
  Write-Host 'B：回读失败时明确 UNCONFIRMED，不谎报成功、不空集合覆盖'
  $readFailFormal = $formalNow
  $readFailBytesBefore = (Get-FileHash -LiteralPath $readFailFormal -Algorithm SHA256).Hash
  $readFailHold = Join-Path $script:Root ('rf-in-' + [Guid]::NewGuid().ToString('N') + '.txt')
  [System.IO.File]::WriteAllText($readFailHold, '', (New-Object System.Text.UTF8Encoding($false)))
  $readFailOut = Join-Path $script:Root ('rf-out-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $readFailErr = Join-Path $script:Root ('rf-err-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $readFailArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'hold-file.ps1') + '" -Path "' + $readFailFormal + '" -Seconds 25 -Mode ReadOnly'
  $rfHolder = Start-FileIoProcess -FilePath 'powershell.exe' -Arguments $readFailArgs -InputFile $readFailHold -OutputFile $readFailOut -ErrorFile $readFailErr -WorkingDirectory $RepoRoot -TimeoutMs 120000
  try {
    Start-Sleep -Seconds 2
    $rfCurText = [System.IO.File]::ReadAllText($readFailFormal)
    $rfCurParsed = $rfCurText | ConvertFrom-Json
    $rfCurArr = @(if ($rfCurParsed -is [Array]) { $rfCurParsed } else { @($rfCurParsed) })
    # 取正式文件里第一条记录做目标（不依赖后面才定义的 $recB）。
    $rfRec = $rfCurArr | Select-Object -First 1
    $rfRecId = $rfRec.id
    $rfJson = (@{
      action = 'update'; recordId = $rfRecId; operationId = (New-OpId); expectedRevision = $rfRec.revision
      patch = @{ status = 'running'; statusDetail = 'readback-fail-probe' }
    } | ConvertTo-Json -Depth 10 -Compress)
    $rf = Invoke-DispatchPs1 -Json $rfJson
    Test-Ok ($rf.exitCode -ne 0) ('B 回读失败不返回成功（exit=' + $rf.exitCode + ' code=' + $rf.result.code + '）')
    Test-Equal $rf.exitCode 3 'B 回读/替换失败退出 3（UNCONFIRMED）'
    Test-Equal $rf.result.code 'UNCONFIRMED' 'B 回读失败错误码 UNCONFIRMED'
    Test-Ok ($rf.result.retryable -eq $true) 'B 回读失败标记可退避重试'
  } finally {
    if ($rfHolder) { Stop-FileIoProcess -Process $rfHolder }
  }
  Start-Sleep -Milliseconds 500
  $rfAfterText = [System.IO.File]::ReadAllText($readFailFormal)
  Test-Ok ($rfAfterText.Length -gt 2 -and $rfAfterText.TrimStart().StartsWith('[')) 'B 回读失败后正式文件仍是完整 JSON 数组（未被空集合覆盖）'
  $rfParsedAfter = $rfAfterText | ConvertFrom-Json
  $rfArrAfter = @(if ($rfParsedAfter -is [Array]) { $rfParsedAfter } else { @($rfParsedAfter) })
  $rfRecAfter = $rfArrAfter | Where-Object { $_.id -eq $rfRecId } | Select-Object -First 1
  Test-Ok ($null -ne $rfRecAfter) 'B 回读失败后原记录仍在'
  Test-Ok ($rfRecAfter.statusDetail -ne 'readback-fail-probe') 'B 回读失败未把未确认变更写进正式文件'

  Write-Host 'B：替换失败时按 operationId 核实，不盲重试、不删证据'
  # 用只读共享句柄占住正式文件：定位与读取仍可成功（Read-FileShared 要 ReadWrite|Delete
  # 共享，会被拒；但 Find-DispatchFile 的短暂重试后仍会失败——所以这里改用
  # “ReadOnly 持有 + 写入方已能定位”的路径：holder 只读共享，写入方读取可用，
  # 但 File.Replace/MoveFileEx 需要删除/替换权限而失败，从而精确落在替换阶段。
  $holdIn = Join-Path $script:Root ('hold-in-' + [Guid]::NewGuid().ToString('N') + '.txt')
  [System.IO.File]::WriteAllText($holdIn, '', (New-Object System.Text.UTF8Encoding($false)))
  $holdOut = Join-Path $script:Root ('hold-out-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $holdErr = Join-Path $script:Root ('hold-err-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $holdArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'hold-file.ps1') + '" -Path "' + $formalNow + '" -Seconds 30 -Mode ReadOnly'
  $holderB = Start-FileIoProcess -FilePath 'powershell.exe' -Arguments $holdArgs -InputFile $holdIn -OutputFile $holdOut -ErrorFile $holdErr -WorkingDirectory $RepoRoot -TimeoutMs 120000
  $held = $false
  $holdDeadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $holdDeadline) {
    Start-Sleep -Milliseconds 150
    # ReadOnly 共享句柄的特征：以 Read 打开仍成功，但 File.Replace 会因
    # “being used by another process”失败。用一次真实 Replace 试探确认句柄已生效；
    # 若 Replace 意外成功，就把原字节写回并继续等。
    $probeTmp = Join-Path $script:Root ('probe-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $probeBak = Join-Path $script:Root ('probe-' + [Guid]::NewGuid().ToString('N') + '.bak')
    try {
      $orig = [System.IO.File]::ReadAllBytes($formalNow)
      [System.IO.File]::WriteAllBytes($probeTmp, $orig)
      try {
        [System.IO.File]::Replace($probeTmp, $formalNow, $probeBak)
        [System.IO.File]::WriteAllBytes($formalNow, $orig)
      } catch [System.IO.IOException] {
        $held = $true
      }
    } catch {
    } finally {
      Remove-Item -LiteralPath $probeTmp -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $probeBak -Force -ErrorAction SilentlyContinue
    }
    if ($held) { break }
  }
  try {
    Test-Ok $held 'B 已确认正式文件被外部只读共享句柄占住（替换会被拒）'
    $recB = $afterTmpWrite.result.record.id
    $revB = $afterTmpWrite.result.revision
    $opBlocked = New-OpId
    $blockedJson = (@{
      action = 'update'; recordId = $recB; operationId = $opBlocked; expectedRevision = $revB
      patch = @{ status = 'running'; executorRef = 'exec-replace-fail' }
    } | ConvertTo-Json -Depth 10 -Compress)
    $tmpBefore = @(Get-ChildItem -LiteralPath $script:DataRoot -Filter '*.tmp' -File).Count
    $blocked = Invoke-DispatchPs1 -Json $blockedJson
    Test-Equal $blocked.exitCode 3 'B 替换失败退出 3（UNCONFIRMED）'
    Test-Equal $blocked.result.code 'UNCONFIRMED' 'B 错误码 UNCONFIRMED（不是 FILE_INVALID 永久损坏）'
    Test-Ok ($blocked.result.retryable -eq $true) 'B 明确标记可退避重试'
    # 独占期间本测试自己也不能读正式文件（会抛共享冲突），改由释放后再核对证据。
    Stop-FileIoProcess -Process $holderB
    $holderB = $null
    Start-Sleep -Milliseconds 500
    $tmpAfter = @(Get-ChildItem -LiteralPath $script:DataRoot -Filter '*.tmp' -File).Count
    Test-Ok ($tmpAfter -gt $tmpBefore) 'B 替换失败后保留本次 .tmp 证据（恢复前不删）'
    $stillOld = [System.IO.File]::ReadAllText($formalNow)
    Test-Ok (-not $stillOld.Contains('exec-replace-fail')) 'B 替换失败未污染正式文件'
    # 用同一 operationId 重试：应当幂等成功，不产生第二份业务变更。
    $retry = Invoke-DispatchPs1 -Json $blockedJson
    Test-Equal $retry.exitCode 0 'B 释放后同 operationId 重试成功'
    $recovered = [System.IO.File]::ReadAllText($formalNow)
    Test-Ok ($recovered.Contains('exec-replace-fail')) 'B 重试后补丁真正落盘'
    $parsedR = $recovered | ConvertFrom-Json
    $arrR = @(if ($parsedR -is [Array]) { $parsedR } else { @($parsedR) })
    $recR = $arrR | Where-Object { $_.id -eq $recB } | Select-Object -First 1
    Test-Equal $recR.revision ($revB + 1) 'B 重试只递增一次 revision（未重复变更）'
  } finally {
    if ($holderB) { Stop-FileIoProcess -Process $holderB }
  }

  Write-Host 'B：Electron 风格读者并发不阻塞替换、不把瞬时错误当空集合'
  $readerOut = Join-Path $script:Root 'reader-out.json'
  $readerOutFd = Join-Path $script:Root 'reader-stdout.json'
  $readerErr = Join-Path $script:Root 'reader-stderr.txt'
  $readerScript = Join-Path $RepoRoot 'tests\dispatch-reader-loop.js'
  $readerArgs = '"' + $readerScript + '" "' + $formalNow + '" 5000 "' + $readerOut + '"'
  $readerIn = Join-Path $script:Root ('reader-in-' + [Guid]::NewGuid().ToString('N') + '.txt')
  [System.IO.File]::WriteAllText($readerIn, '', (New-Object System.Text.UTF8Encoding($false)))
  $readerProc = Start-FileIoProcess -FilePath 'node' -Arguments $readerArgs -InputFile $readerIn -OutputFile $readerOutFd -ErrorFile $readerErr -WorkingDirectory $RepoRoot -TimeoutMs 120000
  try {
    Start-Sleep -Milliseconds 400
    $writeFailures = 0
    for ($w = 0; $w -lt 6; $w++) {
      $opW = New-OpId
      $curText = [System.IO.File]::ReadAllText($formalNow)
      $curParsed = $curText | ConvertFrom-Json
      $curArr = @(if ($curParsed -is [Array]) { $curParsed } else { @($curParsed) })
      $curRec = $curArr | Where-Object { $_.id -eq $recB } | Select-Object -First 1
      $wJson = (@{
        action = 'update'; recordId = $recB; operationId = $opW; expectedRevision = $curRec.revision
        patch = @{ status = 'running'; statusDetail = ('reader-concurrent-' + $w) }
      } | ConvertTo-Json -Depth 10 -Compress)
      $wRes = Invoke-DispatchPs1 -Json $wJson
      if ($wRes.exitCode -ne 0) { $writeFailures++ }
    }
    Test-Equal $writeFailures 0 'B 读者并发时 6 次写入全部成功（读者不阻塞正确替换）'
    $readerCode = Wait-FileIoProcess -Process $readerProc
    Test-Equal $readerCode 0 'B 读者进程正常退出'
    $stats = $null
    if (Test-Path -LiteralPath $readerOut) {
      try { $stats = [System.IO.File]::ReadAllText($readerOut) | ConvertFrom-Json } catch { }
    }
    Test-Ok ($null -ne $stats) ('B 读者产出统计（out=' + $readerOut + '）')
    if ($stats) {
      Test-Ok ($stats.reads -gt 0) ('B 读者实际读到文件（reads=' + $stats.reads + '）')
      Test-Equal $stats.emptyArrays 0 'B 读者从未把文件读成空集合'
      Test-Equal $stats.invalidArrays 0 'B 读者从未读到非数组'
      # 读者与写入口并发：写入方在替换前会先写完整临时文件再原子换名，
      # 因此读者要么读到旧完整版本、要么读到新完整版本，不应看到半文件。
      # 读取失败只允许是共享冲突（openErrors，可重试），不允许解析失败。
      Test-Ok ($stats.parseErrors -eq 0) ('B 读者零解析失败（parseErrors=' + $stats.parseErrors + '，partial=' + $stats.partialReads + '）')
      Test-Ok ($stats.minBytes -gt 0) ('B 读者读到的最小文件非空（minBytes=' + $stats.minBytes + '）')
    }
  } finally {
    if (-not $readerProc.Waited) { Stop-FileIoProcess -Process $readerProc }
  }

  Write-Host ''
  Write-Host ('通过 ' + $script:passed + ' 失败 ' + $script:failed)
  if ($script:failed -gt 0) { exit 1 }
} finally {
  try { Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}
