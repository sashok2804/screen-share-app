#Requires -Version 5.0
<#
.SYNOPSIS
    Resolve a Win32 window handle (HWND) to the owning process id (PID).

.DESCRIPTION
    Called by the Electron main process (`audio:getPidFromSourceId` IPC handler)
    to authoritatively resolve the PID behind a desktopCapturer window source.

    Electron's desktopCapturer source.id for a window looks like
    "window:<HWND>:<something>"; the HWND is the Win32 handle of the captured
    window. The only reliable way to go HWND -> PID is user32!GetWindowThreadProcessId
    (the name-matching heuristic in useProcessAudio is brittle: source.name is
    usually the window title, which often differs from PowerShell's
    MainWindowTitle). This script is the authoritative fallback.

    Returns the PID as a single decimal integer on stdout, or 0 when the HWND
    is invalid / null (GetWindowThreadProcessId leaves the out-param at 0 in
    that case). The caller treats `<= 0` as "could not resolve".

.PARAMETER Hwnd
    The Win32 window handle as a 64-bit integer. Pass the value parsed from
    the source.id. A value of 0 is valid input (returns 0).

.NOTES
    Has to be invoked with `-ExecutionPolicy Bypass` because we ship it as an
    `extraResource` outside the app's signed context. Bundled via electron-builder
    `extraResources` so it lands at `<resources>/get-pid.ps1` in the installed
    app (Electron can't read inside app.asar reliably for spawned processes).
#>

param(
    [long]$Hwnd = 0
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Pid {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@

$procId = [uint32]0
[void][Win32Pid]::GetWindowThreadProcessId([IntPtr]$Hwnd, [ref]$procId)
Write-Output $procId
