<#
.SYNOPSIS
Muse 侧任务文件锁脚本（与 Node task-file-lock.js 使用同一协议）。

.NOTES
Muse 使用流程：
1. Acquire 抢锁（成功时标准输出最后一行打印 token）。
2. 写任务文件（Muse 原来的写文件方式不变）。
3. Release 释放（传回同一 token）。

Acquire 失败（10 秒超时）时不要写文件，等一会儿再试。
任何异常路径都要尽力释放锁（Release 传回同一 token）。

诚实限制：
锁只约束遵守协议的写入方；绕过锁直接改文件的一方不受约束。
#>

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Acquire', 'Release')]
    [string]$Action,

    [Parameter(Mandatory = $true)]
    [string]$Date,

    [string]$TasksDir = $(if ($env:STICKY_NOTES_TASKS_DIR) { $env:STICKY_NOTES_TASKS_DIR } else { Join-Path $env:APPDATA 'sticky-notes\tasks' }),

    [string]$Owner = 'muse',

    [int]$TimeoutSec = 10,

    [string]$Token
)

chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false

function Write-ErrorLine {
    param([string]$Message)
    [Console]::Error.WriteLine($Message)
}

function Read-LockInfo {
    param([string]$Path)
    try {
        $text = [System.IO.File]::ReadAllText($Path, $utf8NoBom)
        if ([string]::IsNullOrWhiteSpace($text)) { return $null }
        $obj = $text | ConvertFrom-Json
        if ($null -eq $obj) { return $null }
        if (-not ($obj.PSObject.Properties.Name -contains 'acquiredAt')) { return $null }
        if ([string]::IsNullOrWhiteSpace([string]$obj.acquiredAt)) { return $null }
        return $obj
    } catch {
        return $null
    }
}

function New-LockToken {
    $bytes = New-Object -TypeName 'byte[]' -ArgumentList 8
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        if ($null -ne $rng) { $rng.Dispose() }
    }
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

# 日期校验：必须 YYYY-MM-DD 且真实存在
if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') {
    Write-ErrorLine 'INVALID_DATE'
    exit 1
}
$parsedDate = [datetime]::MinValue
if (-not [datetime]::TryParseExact($Date, 'yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$parsedDate)) {
    Write-ErrorLine 'INVALID_DATE'
    exit 1
}

# 确保 tasks 目录存在
if (-not (Test-Path -LiteralPath $TasksDir -PathType Container)) {
    try {
        New-Item -ItemType Directory -Path $TasksDir -Force -ErrorAction Stop | Out-Null
    } catch {
        Write-ErrorLine 'TASKS_DIR_ERROR'
        exit 1
    }
}

$lockPath = Join-Path -Path $TasksDir -ChildPath ($Date + '.json.lock')

if ($Action -eq 'Acquire') {
    $startTime = Get-Date
    while ($true) {
        if (((Get-Date) - $startTime).TotalSeconds -ge $TimeoutSec) {
            Write-ErrorLine 'LOCK_TIMEOUT'
            exit 2
        }

        $stream = $null
        $createdLock = $false
        $createdToken = $null
        try {
            $stream = [System.IO.File]::Open(
                $lockPath,
                [System.IO.FileMode]::CreateNew,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None
            )
            $createdLock = $true
            $createdToken = New-LockToken

            $lockObject = [pscustomobject][ordered]@{
                owner = $Owner
                pid = $PID
                host = $env:COMPUTERNAME
                acquiredAt = (Get-Date).ToUniversalTime().ToString('o')
                token = $createdToken
            }
            $json = $lockObject | ConvertTo-Json -Compress
            $bytes = $utf8NoBom.GetBytes($json)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush()
            $stream.Close()
            $stream = $null

            [Console]::Out.WriteLine($createdToken)
            exit 0
        } catch [System.IO.IOException] {
            # 锁已存在或暂时无法创建，下方按协议读取现有锁
        } catch {
            # 非预期异常：不直接写，尽力清理自己创建的未完成锁
        } finally {
            if ($null -ne $stream) {
                try { $stream.Close() } catch { }
            }
        }

        # 自己已创建锁但写入/输出过程异常时，尽力释放
        if ($createdLock) {
            $cleaned = $false
            try {
                if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
                    $info = Read-LockInfo $lockPath
                    $canRemove = $false
                    if ($null -eq $info) {
                        $canRemove = $true
                    } elseif ([string]::IsNullOrEmpty($createdToken)) {
                        $canRemove = $true
                    } elseif (-not ($info.PSObject.Properties.Name -contains 'token')) {
                        $canRemove = $true
                    } elseif ([string]::IsNullOrEmpty([string]$info.token)) {
                        $canRemove = $true
                    } elseif ([string]$info.token -ceq $createdToken) {
                        $canRemove = $true
                    }

                    if ($canRemove) {
                        Remove-Item -LiteralPath $lockPath -Force -ErrorAction Stop
                        $cleaned = $true
                    }
                }
            } catch { }
            if ($cleaned) { continue }
        }

        # 没抢到：检查现有锁是否为残留锁
        if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
            $lockInfo = Read-LockInfo $lockPath
            if ($null -ne $lockInfo) {
                $hasToken = ($lockInfo.PSObject.Properties.Name -contains 'token') -and (-not [string]::IsNullOrEmpty([string]$lockInfo.token))
                if ($hasToken) {
                    $acquiredAtValue = $lockInfo.acquiredAt
                    $acquiredAt = [datetime]::MinValue
                    $parsed = $false
                    if ($acquiredAtValue -is [datetime]) {
                        $acquiredAt = [datetime]$acquiredAtValue
                        $parsed = $true
                    } else {
                        $parsed = [datetime]::TryParse(
                            [string]$acquiredAtValue,
                            [System.Globalization.CultureInfo]::InvariantCulture,
                            [System.Globalization.DateTimeStyles]::RoundtripKind,
                            [ref]$acquiredAt
                        )
                    }

                    if ($parsed) {
                        $ageSeconds = ((Get-Date).ToUniversalTime() - $acquiredAt.ToUniversalTime()).TotalSeconds
                        if ($ageSeconds -gt 30) {
                            $token1 = [string]$lockInfo.token
                            Start-Sleep -Milliseconds 100
                            $lockInfo2 = Read-LockInfo $lockPath
                            if ($null -ne $lockInfo2 -and ([string]$lockInfo2.token -ceq $token1)) {
                                try {
                                    Remove-Item -LiteralPath $lockPath -Force -ErrorAction Stop
                                    continue
                                } catch {
                                    # 删除失败，继续等待重试
                                }
                            }
                        }
                    }
                }
            }
        }

        Start-Sleep -Milliseconds 100
    }
} else {
    # Release
    if ([string]::IsNullOrWhiteSpace($Token)) {
        Write-ErrorLine 'TOKEN_REQUIRED'
        exit 1
    }

    if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
        exit 0
    }

    $lockInfo = $null
    try {
        $text = [System.IO.File]::ReadAllText($lockPath, $utf8NoBom)
        if (-not [string]::IsNullOrWhiteSpace($text)) {
            $lockInfo = $text | ConvertFrom-Json
        }
    } catch {
        $lockInfo = $null
    }

    if ($null -eq $lockInfo -or -not ($lockInfo.PSObject.Properties.Name -contains 'token')) {
        Write-ErrorLine 'TOKEN_MISMATCH'
        exit 3
    }

    $lockToken = [string]$lockInfo.token
    if ($lockToken -cne $Token) {
        Write-ErrorLine 'TOKEN_MISMATCH'
        exit 3
    }

    try {
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction Stop
        exit 0
    } catch {
        if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
            exit 0
        }
        Write-ErrorLine 'RELEASE_FAILED'
        exit 4
    }
}
