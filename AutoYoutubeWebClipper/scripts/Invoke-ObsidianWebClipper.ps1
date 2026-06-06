<#
.SYNOPSIS
Open video URLs in Chrome and save each page with Obsidian Web Clipper.

.DESCRIPTION
This script automates the UI workflow used by the chrome-obsidian-web-clipper
skill:

1. Open a URL in Chrome.
2. Pause the video with the YouTube "k" shortcut.
3. Right-click a blank area.
4. Open Obsidian Web Clipper -> Save this page.
5. In the extension popup, choose Save file...
6. Verify the Markdown file in Downloads.

The Obsidian Web Clipper extension popup and Chrome native context menu are UI
surfaces, so the workflow depends on screen coordinates. The context menu clicks
use offsets from the right-click point by default, which is more stable across
maximized and 1080p full-screen layouts. Override the coordinate parameters if
your layout is different.

.EXAMPLE
.\scripts\Invoke-ObsidianWebClipper.ps1 -Urls `
  'https://www.youtube.com/watch?v=JZ9GRFD-mSc', `
  'https://www.youtube.com/watch?v=XtQMytORBmM'

.EXAMPLE
.\scripts\Invoke-ObsidianWebClipper.ps1 -InputFile .\video-links.txt
#>

[CmdletBinding(DefaultParameterSetName = 'Urls')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Urls')]
  [string[]] $Urls,

  [Parameter(Mandatory = $true, ParameterSetName = 'InputFile')]
  [string] $InputFile,

  [string] $ChromePath,
  [string] $DownloadDir = (Join-Path $HOME 'Downloads'),

  [int] $PageLoadSeconds = 6,
  [int] $AfterPauseMilliseconds = 800,
  [int] $AfterContextMenuMilliseconds = 700,
  [int] $AfterSubmenuMilliseconds = 900,
  [int] $PopupSeconds = 2,
  [int] $SaveSeconds = 4,
  [int] $BetweenUrlsSeconds = 1,

  [int] $RightClickX = 52,
  [int] $RightClickY = 320,

  [int] $ClipperMenuOffsetX = 135,
  [int] $ClipperMenuOffsetY = 461,
  [int] $SaveThisPageOffsetX = 371,
  [int] $SaveThisPageOffsetY = 460,

  [int] $ClipperMenuX = 187,
  [int] $ClipperMenuY = 886,
  [int] $SaveThisPageX = 423,
  [int] $SaveThisPageY = 885,
  [int] $DropdownX = 1693,
  [int] $DropdownY = 597,
  [int] $SaveFileX = 1615,
  [int] $SaveFileY = 558,

  [switch] $UseAbsoluteContextMenuCoordinates,
  [switch] $Fullscreen1080p,
  [switch] $TakeDebugScreenshots,
  [string] $DebugDir = (Join-Path $env:TEMP 'obsidian-webclipper-debug'),

  [switch] $SkipPause,
  [switch] $AcceptNativeSaveDialog,
  [switch] $CloseTabAfterSave,
  [string] $LogPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WebClipperNative {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008;
  public const uint RIGHTUP = 0x0010;
  public const int SW_MAXIMIZE = 3;
}
'@

function Write-Step {
  param([string] $Message)
  $line = '[{0:yyyy-MM-dd HH:mm:ss}] {1}' -f (Get-Date), $Message
  Write-Host $line
  if ($LogPath) {
    Add-Content -LiteralPath $LogPath -Value $line
  }
}

function Save-DebugScreenshot {
  param([string] $Name)

  if (-not $TakeDebugScreenshots) { return }

  if (-not (Test-Path -LiteralPath $DebugDir)) {
    New-Item -ItemType Directory -Path $DebugDir -Force | Out-Null
  }

  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $path = Join-Path $DebugDir ('{0:yyyyMMdd-HHmmssfff}-{1}.png' -f (Get-Date), $Name)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Step ('Debug screenshot: {0}' -f $path)
  } finally {
    $g.Dispose()
    $bmp.Dispose()
  }
}

function Resolve-ChromePath {
  if ($ChromePath) {
    if (Test-Path -LiteralPath $ChromePath) { return $ChromePath }
    return $ChromePath
  }

  $candidates = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LocalAppData 'Google\Chrome\Application\chrome.exe'),
    'chrome.exe'
  )

  foreach ($candidate in $candidates) {
    if ($candidate -eq 'chrome.exe' -or (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }
}

function Get-InputUrls {
  if ($PSCmdlet.ParameterSetName -eq 'InputFile') {
    return Get-Content -LiteralPath $InputFile |
      ForEach-Object { $_.Trim() } |
      Where-Object { $_ -and -not $_.StartsWith('#') }
  }

  return $Urls |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ }
}

function Focus-Chrome {
  $chrome = Get-Process chrome -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Sort-Object StartTime -Descending |
    Select-Object -First 1

  if ($chrome) {
    [WebClipperNative]::ShowWindow($chrome.MainWindowHandle, [WebClipperNative]::SW_MAXIMIZE) | Out-Null
    Start-Sleep -Milliseconds 300
    [WebClipperNative]::SetForegroundWindow($chrome.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 500
  }
}

function Click-At {
  param(
    [int] $X,
    [int] $Y,
    [ValidateSet('Left', 'Right')]
    [string] $Button = 'Left'
  )

  [WebClipperNative]::SetCursorPos($X, $Y) | Out-Null
  Start-Sleep -Milliseconds 80

  if ($Button -eq 'Right') {
    [WebClipperNative]::mouse_event([WebClipperNative]::RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [WebClipperNative]::mouse_event([WebClipperNative]::RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
  } else {
    [WebClipperNative]::mouse_event([WebClipperNative]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [WebClipperNative]::mouse_event([WebClipperNative]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  }
}

function Move-To {
  param([int] $X, [int] $Y)
  [WebClipperNative]::SetCursorPos($X, $Y) | Out-Null
}

function Get-NewMarkdownDownloads {
  param([datetime] $After)

  if (-not (Test-Path -LiteralPath $DownloadDir)) {
    return @()
  }

  return Get-ChildItem -LiteralPath $DownloadDir -Filter '*.md' |
    Where-Object { $_.LastWriteTime -gt $After } |
    Sort-Object LastWriteTime -Descending
}

if ($Fullscreen1080p) {
  $RightClickX = 52
  $RightClickY = 320
  $ClipperMenuOffsetX = 135
  $ClipperMenuOffsetY = 461
  $SaveThisPageOffsetX = 371
  $SaveThisPageOffsetY = 460
  $DropdownX = 1693
  $DropdownY = 597
  $SaveFileX = 1615
  $SaveFileY = 558
}

$allUrls = @(Get-InputUrls)
if ($allUrls.Count -eq 0) {
  throw 'No URLs were provided.'
}

$resolvedChromePath = Resolve-ChromePath
$results = New-Object System.Collections.Generic.List[object]
$effectiveClipperMenuX = $ClipperMenuX
$effectiveClipperMenuY = $ClipperMenuY
$effectiveSaveThisPageX = $SaveThisPageX
$effectiveSaveThisPageY = $SaveThisPageY

if (-not $UseAbsoluteContextMenuCoordinates) {
  $effectiveClipperMenuX = $RightClickX + $ClipperMenuOffsetX
  $effectiveClipperMenuY = $RightClickY + $ClipperMenuOffsetY
  $effectiveSaveThisPageX = $RightClickX + $SaveThisPageOffsetX
  $effectiveSaveThisPageY = $RightClickY + $SaveThisPageOffsetY
}

Write-Step ('Using Chrome: {0}' -f $resolvedChromePath)
Write-Step ('Using Downloads: {0}' -f $DownloadDir)
Write-Step ('Right-click point: {0},{1}' -f $RightClickX, $RightClickY)
Write-Step ('Clipper menu point: {0},{1}' -f $effectiveClipperMenuX, $effectiveClipperMenuY)
Write-Step ('Save this page point: {0},{1}' -f $effectiveSaveThisPageX, $effectiveSaveThisPageY)
Write-Step ('Popup dropdown point: {0},{1}' -f $DropdownX, $DropdownY)
Write-Step ('Save file point: {0},{1}' -f $SaveFileX, $SaveFileY)

foreach ($url in $allUrls) {
  $startedAt = Get-Date
  $savedFile = $null
  $status = 'Failed'
  $message = ''

  try {
    Write-Step ('Opening: {0}' -f $url)
    Start-Process -FilePath $resolvedChromePath -ArgumentList @('--new-tab', $url)
    Start-Sleep -Seconds $PageLoadSeconds
    Focus-Chrome
    Save-DebugScreenshot -Name 'page-loaded'

    if (-not $SkipPause) {
      Write-Step 'Pausing page video with the YouTube k shortcut.'
      [System.Windows.Forms.SendKeys]::SendWait('k')
      Start-Sleep -Milliseconds $AfterPauseMilliseconds
      Save-DebugScreenshot -Name 'after-pause'
    }

    Write-Step 'Opening Chrome context menu.'
    Click-At -X $RightClickX -Y $RightClickY -Button Right
    Start-Sleep -Milliseconds $AfterContextMenuMilliseconds
    Save-DebugScreenshot -Name 'context-menu'

    Write-Step 'Opening Obsidian Web Clipper submenu.'
    Move-To -X $effectiveClipperMenuX -Y $effectiveClipperMenuY
    Start-Sleep -Milliseconds $AfterSubmenuMilliseconds
    Save-DebugScreenshot -Name 'clipper-submenu'

    Write-Step 'Choosing Save this page.'
    Click-At -X $effectiveSaveThisPageX -Y $effectiveSaveThisPageY
    Start-Sleep -Seconds $PopupSeconds
    Save-DebugScreenshot -Name 'clipper-popup'

    Write-Step 'Opening Web Clipper save target menu.'
    Click-At -X $DropdownX -Y $DropdownY
    Start-Sleep -Milliseconds 700
    Save-DebugScreenshot -Name 'save-target-menu'

    Write-Step 'Choosing Save file...'
    Click-At -X $SaveFileX -Y $SaveFileY
    Start-Sleep -Seconds $SaveSeconds
    Save-DebugScreenshot -Name 'after-save-file'

    $downloads = @(Get-NewMarkdownDownloads -After $startedAt)
    if ($downloads.Count -eq 0 -and $AcceptNativeSaveDialog) {
      Write-Step 'No Markdown file yet; accepting a possible native save dialog.'
      [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
      Start-Sleep -Seconds $SaveSeconds
      $downloads = @(Get-NewMarkdownDownloads -After $startedAt)
    }

    if ($downloads.Count -gt 0) {
      $savedFile = $downloads[0].FullName
      $status = 'Saved'
      $message = 'Saved Markdown file.'
      Write-Step ('Saved: {0}' -f $savedFile)
    } else {
      $status = 'NeedsCheck'
      $message = 'No recent Markdown download was found. Check the extension popup or save dialog.'
      Write-Step $message
    }

    if ($CloseTabAfterSave) {
      [System.Windows.Forms.SendKeys]::SendWait('^w')
      Start-Sleep -Milliseconds 500
    }
  } catch {
    $message = $_.Exception.Message
    Write-Step ('Error: {0}' -f $message)
  }

  $results.Add([PSCustomObject]@{
    Url = $url
    Status = $status
    File = $savedFile
    Message = $message
    StartedAt = $startedAt
    FinishedAt = Get-Date
  })

  if ($BetweenUrlsSeconds -gt 0) {
    Start-Sleep -Seconds $BetweenUrlsSeconds
  }
}

$results | Format-Table -AutoSize
