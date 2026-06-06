---
name: chrome-obsidian-web-clipper
description: Save web pages from the user's existing Chrome browser with Obsidian Web Clipper extension, especially when the user asks to right-click a page, choose Obsidian Web Clipper, select "Save this page", and use the popup's "Save file..."  / savefile option. Use for Chrome-extension workflows that depend on the user's installed Obsidian Web Clipper, YouTube/video pages, current Chrome tabs, or downloaded Markdown clip files.
---

# Chrome Obsidian Web Clipper

## Overview

Use this skill to drive the user's Chrome UI through the Obsidian Web Clipper extension and save a page as a local Markdown file. The fragile parts are Chrome's native right-click menu and the extension popup, so rely on visual confirmation and desktop-coordinate fallback when ordinary tab screenshots do not show the menu.

## Workflow

1. Use the `chrome:control-chrome` skill and its required bootstrap flow. Reuse the user's existing Chrome profile; do not inspect cookies, local storage, passwords, or session stores.
2. Open or claim the target tab:
   - If the user gives a URL, create a Chrome tab or reuse an already-open matching tab, then navigate only if needed.
   - If the user says "current page", claim the visible/current Chrome tab from `browser.user.openTabs()` or `browser.tabs.selected()`.
3. Pause any currently playing page video before clipping:
   - On YouTube or other video pages, pause the video after navigation and before opening the right-click menu.
   - Prefer pressing `k` or clicking the visible player pause control, then verify the player is paused with a screenshot or a targeted page/player state check.
   - If no playable video is present, already paused, or the player cannot be safely targeted, continue without blocking the clipping workflow.
4. Take a screenshot to locate a blank page area for the right-click. Prefer a left margin or page background outside controls; on YouTube, avoid the video player controls and recommendation menu.
5. Right-click the blank area. Chrome native menus usually do not appear in `tab.screenshot()`, so if the menu is not visible there, capture the Windows desktop with PowerShell and inspect it with `view_image`.
6. In the context menu, expand `Obsidian Web Clipper` and select `Save this page`.
7. In the Obsidian Web Clipper popup, click the bottom button's right-side dropdown arrow and choose `Save file...` / `Savefile`.
8. If Chrome saves automatically, verify the recent download in `~/Downloads`. If a native save dialog appears, accept the default filename/location unless the user specified otherwise.
9. Finalize Chrome control. Keep the tab only when it is useful for user handoff or the user explicitly asked to keep the page open.

## Native Menu Fallback

Use this fallback when Chrome's right-click menu, submenu, extension popup menu, or save dialog is visible on the desktop but not visible through the tab API.

Capture the full desktop:

```powershell
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size)
$path = Join-Path $env:TEMP 'chrome-webclipper-state.png'
$bmp.Save($path,[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output $path
```

Move/click with desktop coordinates after inspecting the screenshot:

```powershell
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class MouseNative {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
}
'@
[MouseNative]::SetCursorPos(420,798) | Out-Null
[MouseNative]::mouse_event([MouseNative]::LEFTDOWN,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 80
[MouseNative]::mouse_event([MouseNative]::LEFTUP,0,0,0,[UIntPtr]::Zero)
```

Coordinates from `tab.cua` are often viewport-relative, while native Chrome menus require desktop coordinates. Calibrate from the desktop screenshot whenever the pointer lands too high or low.

## Verification

After `Save file...`, check recent downloads:

```powershell
$dl = Join-Path $HOME 'Downloads'
Get-ChildItem -LiteralPath $dl |
  Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-5) } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 10 FullName,Length,LastWriteTime
```

Report the saved file path when found. If no file appears, inspect the popup for an error, permission prompt, or a still-open save dialog before retrying.
