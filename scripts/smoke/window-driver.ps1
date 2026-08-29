param(
    [ValidateSet('Query', 'DragFromMaximized')]
    [string]$Action = 'Query',
    [double]$StartXRatio = 0.35,
    [double]$StartYRatio = 0.04,
    [int]$DeltaX = 220,
    [int]$DeltaY = 160
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class ShaderLabSmokeWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
}
'@

function Get-ShaderLabWindow {
    $script:candidates = @()
    $callback = [ShaderLabSmokeWin32+EnumWindowsProc]{
        param([IntPtr]$hWnd, [IntPtr]$lParam)
        if (-not [ShaderLabSmokeWin32]::IsWindowVisible($hWnd)) { return $true }
        $text = New-Object System.Text.StringBuilder 256
        [ShaderLabSmokeWin32]::GetWindowText($hWnd, $text, $text.Capacity) | Out-Null
        if ($text.ToString() -notlike 'ShaderLab Pro*') { return $true }
        [uint32]$processId = 0
        [ShaderLabSmokeWin32]::GetWindowThreadProcessId($hWnd, [ref]$processId) | Out-Null
        try {
            $process = Get-Process -Id $processId -ErrorAction Stop
            $script:candidates += [pscustomobject]@{
                Handle = $hWnd
                ProcessId = $processId
                Started = $process.StartTime
            }
        } catch {}
        return $true
    }
    [ShaderLabSmokeWin32]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
    $target = $script:candidates | Sort-Object Started -Descending | Select-Object -First 1
    if (-not $target) { throw 'Could not find a visible ShaderLab Pro window' }
    return $target
}

function Get-WindowState([IntPtr]$Handle, [uint32]$ProcessId) {
    $rect = New-Object ShaderLabSmokeWin32+RECT
    $clientRect = New-Object ShaderLabSmokeWin32+RECT
    $clientOrigin = New-Object ShaderLabSmokeWin32+POINT
    if (-not [ShaderLabSmokeWin32]::GetWindowRect($Handle, [ref]$rect)) {
        throw 'GetWindowRect failed'
    }
    if (-not [ShaderLabSmokeWin32]::GetClientRect($Handle, [ref]$clientRect)) {
        throw 'GetClientRect failed'
    }
    if (-not [ShaderLabSmokeWin32]::ClientToScreen($Handle, [ref]$clientOrigin)) {
        throw 'ClientToScreen failed'
    }
    return [pscustomobject]@{
        processId = $ProcessId
        maximized = [ShaderLabSmokeWin32]::IsZoomed($Handle)
        left = $rect.Left
        top = $rect.Top
        width = $rect.Right - $rect.Left
        height = $rect.Bottom - $rect.Top
        clientLeft = $clientOrigin.X
        clientTop = $clientOrigin.Y
        clientWidth = $clientRect.Right - $clientRect.Left
        clientHeight = $clientRect.Bottom - $clientRect.Top
    }
}

$target = Get-ShaderLabWindow
$handle = [IntPtr]$target.Handle
[ShaderLabSmokeWin32]::SetForegroundWindow($handle) | Out-Null

if ($Action -eq 'Query') {
    Get-WindowState $handle $target.ProcessId | ConvertTo-Json -Compress
    exit 0
}

# Capture stable restored geometry, maximize, then physically drag from an empty top-bar point.
[ShaderLabSmokeWin32]::ShowWindow($handle, 9) | Out-Null
Start-Sleep -Milliseconds 500
$normal = Get-WindowState $handle $target.ProcessId
[ShaderLabSmokeWin32]::ShowWindow($handle, 3) | Out-Null
Start-Sleep -Milliseconds 650
$maximized = Get-WindowState $handle $target.ProcessId
if (-not $maximized.maximized) { throw 'Window did not enter the maximized state' }

$startX = $maximized.clientLeft + [Math]::Round($maximized.clientWidth * $StartXRatio)
$startY = $maximized.clientTop + [Math]::Round($maximized.clientHeight * $StartYRatio)
[ShaderLabSmokeWin32]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Milliseconds 100
[ShaderLabSmokeWin32]::SetCursorPos($startX, $startY) | Out-Null
[ShaderLabSmokeWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 100
for ($step = 1; $step -le 14; $step += 1) {
    $x = $startX + [Math]::Round($DeltaX * $step / 14)
    $y = $startY + [Math]::Round($DeltaY * $step / 14)
    [ShaderLabSmokeWin32]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 35
}
[ShaderLabSmokeWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 700
$after = Get-WindowState $handle $target.ProcessId

[pscustomobject]@{
    normalBefore = $normal
    maximized = $maximized
    afterDrag = $after
    restored = -not $after.maximized
    moved = [Math]::Abs($after.left - $normal.left) -gt 20 -or [Math]::Abs($after.top - $normal.top) -gt 20
    sizePreserved = [Math]::Abs($after.width - $normal.width) -le 24 -and [Math]::Abs($after.height - $normal.height) -le 24
    start = [pscustomobject]@{ x = $startX; y = $startY; xRatio = $StartXRatio; yRatio = $StartYRatio }
} | ConvertTo-Json -Compress -Depth 4
