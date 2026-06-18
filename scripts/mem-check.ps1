$procs = Get-Process -Name 'electron' -ErrorAction SilentlyContinue
if (-not $procs) {
    Write-Host "No electron processes running"
    exit 0
}
$total = ($procs | Measure-Object -Property WorkingSet64 -Sum).Sum
Write-Host "=== Electron Process Memory Baseline ==="
foreach ($p in $procs) {
    $ws = [math]::Round($p.WorkingSet64 / 1MB, 1)
    $pm = [math]::Round($p.PrivateMemorySize64 / 1MB, 1)
    Write-Host "PID $($p.Id): WS=${ws}MB Private=${pm}MB Name=$($p.ProcessName)"
}
Write-Host "Total WorkingSet: $([math]::Round($total / 1MB, 1)) MB"
Write-Host "Process count: $(@($procs).Count)"
