# process-file-io.ps1
#
# 测试专用启动器：用原生 CreateProcessW + 文件句柄做 stdin/stdout/stderr 重定向，
# 同时拿得到真实退出码。用于受限会话（Job 对象 / 无交互桌面）下运行
# scripts/dispatch-record.ps1 的完整故障注入测试——这些会话里
# System.Diagnostics.Process.Start 带匿名管道会抛 Win32Exception 5，
# Start-Process -Wait 也会被拒，但文件句柄重定向可用。
#
# 生产代码不使用本文件；它只替换测试进程的启动方式，不改任何断言。
# 注意：本文件含中文，须保存为 UTF-8 with BOM。

if (-not ('DshFileIoLauncher' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DshFileIoLauncher {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }

  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);

  public static IntPtr Start(string exe, string cmdline, string inFile, string outFile, string errFile, string cwd, out int pid, out int err) {
    err = 0; pid = 0;
    SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
    sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
    sa.bInheritHandle = 1;
    IntPtr hIn = CreateFileW(inFile, 0x80000000, 1, ref sa, 3, 0x80, IntPtr.Zero);
    if (hIn == new IntPtr(-1)) { err = Marshal.GetLastWin32Error(); return IntPtr.Zero; }
    IntPtr hOut = CreateFileW(outFile, 0x40000000, 1, ref sa, 2, 0x80, IntPtr.Zero);
    if (hOut == new IntPtr(-1)) { err = Marshal.GetLastWin32Error(); CloseHandle(hIn); return IntPtr.Zero; }
    IntPtr hErr = CreateFileW(errFile, 0x40000000, 1, ref sa, 2, 0x80, IntPtr.Zero);
    if (hErr == new IntPtr(-1)) { err = Marshal.GetLastWin32Error(); CloseHandle(hIn); CloseHandle(hOut); return IntPtr.Zero; }
    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.dwFlags = 0x100;
    si.hStdInput = hIn; si.hStdOutput = hOut; si.hStdError = hErr;
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    bool ok = CreateProcessW(exe, cmdline, IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, cwd, ref si, out pi);
    err = Marshal.GetLastWin32Error();
    CloseHandle(hIn); CloseHandle(hOut); CloseHandle(hErr);
    if (!ok) return IntPtr.Zero;
    CloseHandle(pi.hThread);
    pid = pi.dwProcessId;
    return pi.hProcess;
  }

  public static int Wait(IntPtr proc, int timeoutMs) {
    WaitForSingleObject(proc, (uint)timeoutMs);
    uint code = 0;
    GetExitCodeProcess(proc, out code);
    CloseHandle(proc);
    return unchecked((int)code);
  }

  public static bool Kill(IntPtr proc) {
    return TerminateProcess(proc, 1);
  }
}
'@
}

# 启动一个带文件重定向的进程。返回 @{ handle; pid; exitCodeGetter }。
function Resolve-LaunchExecutable {
  param([Parameter(Mandatory=$true)][string]$FilePath)
  # CreateProcessW 不会像 shell 那样查 PATH 里的 powershell.exe（它在
  # %SystemRoot%\System32\WindowsPowerShell\v1.0，且不一定在 PATH 上），
  # 这里显式解析成绝对路径，避免 START_FAILED err=2。
  if ([System.IO.Path]::IsPathRooted($FilePath)) {
    if (Test-Path -LiteralPath $FilePath -PathType Leaf) { return $FilePath }
  }
  $cmd = Get-Command $FilePath -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  # Get-Command 对 node.exe 之类可能只返回 ApplicationInfo 而无 Source；
  # 再按 PATHEXT 组合逐个探测，避免“启动成功但实际什么都没跑”的静默失败。
  $exts = @('', '.exe', '.cmd', '.bat')
  foreach ($dir in ($env:PATH -split ';')) {
    if (-not $dir) { continue }
    foreach ($ext in $exts) {
      $candidate = Join-Path $dir ($FilePath + $ext)
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
  }
  $candidates = @(
    (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'),
    (Join-Path $env:SystemRoot 'System32\cmd.exe')
  )
  foreach ($c in $candidates) {
    if ((Test-Path -LiteralPath $c) -and ([System.IO.Path]::GetFileName($c) -ieq $FilePath)) { return $c }
  }
  return $FilePath
}

function Start-FileIoProcess {
  param(
    [Parameter(Mandatory=$true)][string]$FilePath,
    [Parameter(Mandatory=$true)][string]$Arguments,
    [Parameter(Mandatory=$true)][string]$InputFile,
    [Parameter(Mandatory=$true)][string]$OutputFile,
    [Parameter(Mandatory=$true)][string]$ErrorFile,
    [string]$WorkingDirectory = (Get-Location).Path,
    [int]$TimeoutMs = 120000
  )
  $exe = Resolve-LaunchExecutable -FilePath $FilePath
  # Windows 约定：lpCommandLine 的第一段是 argv[0]（程序自身）。CreateProcessW
  # 不会替调用方补上它，而 node.exe 严格按 argv[0] 解析后续参数——少了它，
  # node 会把第一个参数当成 argv[0]，看起来“启动成功、退出 0”，实际只是
  # 因为没有脚本参数而从空 stdin 起了个 REPL。这里显式补上，powershell 同样兼容。
  $commandLine = $Arguments
  if ($commandLine.TrimStart() -notmatch ('^"' + [regex]::Escape($exe) + '"')) {
    $commandLine = '"' + $exe + '" ' + $Arguments
  }
  $pid2 = 0; $err = 0
  $h = [DshFileIoLauncher]::Start($exe, $commandLine, $InputFile, $OutputFile, $ErrorFile, $WorkingDirectory, [ref]$pid2, [ref]$err)
  if ($h -eq [IntPtr]::Zero) {
    throw ("START_FAILED err=" + $err + " exe=" + $exe)
  }
  return [pscustomobject]@{
    Handle = $h
    Pid = $pid2
    TimeoutMs = $TimeoutMs
    Waited = $false
    ExitCode = $null
  }
}

function Wait-FileIoProcess {
  param([Parameter(Mandatory=$true)]$Process)
  if (-not $Process.Waited) {
    $Process.ExitCode = [DshFileIoLauncher]::Wait($Process.Handle, $Process.TimeoutMs)
    $Process.Waited = $true
  }
  return $Process.ExitCode
}

# 强杀：直接 TerminateProcess，模拟 K04「强杀持锁进程」，不经过 Stop-Process
# （受限会话里 Stop-Process 对跨 job 进程可能被拒）。
function Stop-FileIoProcess {
  param([Parameter(Mandatory=$true)]$Process)
  if ($Process.Waited) { return }
  [void][DshFileIoLauncher]::Kill($Process.Handle)
  [void][DshFileIoLauncher]::Wait($Process.Handle, 10000)
  $Process.Waited = $true
  $Process.ExitCode = 'KILLED'
}
