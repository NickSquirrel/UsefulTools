<#
.SYNOPSIS
Open video URLs in Chrome and save each page with Obsidian Web Clipper.

.DESCRIPTION
This script automates the UI workflow used by the chrome-obsidian-web-clipper
skill:

1. Open the first URL in Chrome, then reuse the current tab for later URLs.
2. Right-click a blank area.
3. Open Obsidian Web Clipper -> Save this page.
4. In the extension popup, click the bottom "Add to Obsidian" button.
5. Keep each URL's processing window to a random 8-10 seconds by default.

The Obsidian Web Clipper extension popup and Chrome native context menu are UI
surfaces. The default workflow uses coordinates derived from the current Chrome
window, which avoids hard-coded 1080p positions. UI Automation lookup is
available as an opt-in fallback, but it is disabled by default because Chrome's
accessibility tree can block while native menus or extension popups are open.
Override the coordinate parameters if your layout is different.

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

  [int] $PageLoadSeconds = 4,
  [int] $AfterPauseMilliseconds = 800,
  [int] $AfterContextMenuMilliseconds = 700,
  [int] $AfterSubmenuMilliseconds = 900,
  [int] $PopupSeconds = 1,
  [int] $AfterAddToObsidianSeconds = 0,
  [int] $BetweenUrlsSeconds = 0,
  [int] $MinLinkSeconds = 8,
  [int] $MaxLinkSeconds = 10,
  [int] $MouseClickDelayMilliseconds = 1000,

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
  [int] $AddToObsidianX = 1563,
  [int] $AddToObsidianY = 597,

  [switch] $MaximizeChrome,
  [switch] $UseFixedCoordinates,
  [switch] $UseUiAutomation,
  [switch] $UseAbsoluteContextMenuCoordinates,
  [switch] $Fullscreen1080p,
  [switch] $TakeDebugScreenshots,
  [string] $DebugDir = (Join-Path $env:TEMP 'obsidian-webclipper-debug'),

  [switch] $PauseVideo,
  [switch] $SkipPause,
  [switch] $AcceptNativeSaveDialog,
  [switch] $CloseTabAfterSave,
  [string] $LogPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script:ProvidedParameterNames = @{}
foreach ($parameterName in $PSBoundParameters.Keys) {
  $script:ProvidedParameterNames[$parameterName] = $true
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WebClipperNative {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008;
  public const uint RIGHTUP = 0x0010;
  public const int SW_MAXIMIZE = 3;
}
public struct RECT {
  public int Left;
  public int Top;
  public int Right;
  public int Bottom;
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

  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
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

function Limit-Int {
  param(
    [double] $Value,
    [int] $Minimum,
    [int] $Maximum
  )

  if ($Minimum -gt $Maximum) {
    return [int] [Math]::Round($Value)
  }

  return [Math]::Max($Minimum, [Math]::Min($Maximum, [int] [Math]::Round($Value)))
}

function Get-ChromeProcess {
  $foregroundWindow = [WebClipperNative]::GetForegroundWindow()
  if ($foregroundWindow -ne [IntPtr]::Zero) {
    $processId = 0
    [WebClipperNative]::GetWindowThreadProcessId($foregroundWindow, [ref] $processId) | Out-Null
    if ($processId -gt 0) {
      $foregroundProcess = Get-Process -Id $processId -ErrorAction SilentlyContinue
      if ($foregroundProcess -and $foregroundProcess.ProcessName -eq 'chrome' -and $foregroundProcess.MainWindowHandle -ne 0) {
        return $foregroundProcess
      }
    }
  }

  return Get-Process chrome -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Sort-Object StartTime -Descending |
    Select-Object -First 1
}

function Get-WindowRect {
  param([System.Diagnostics.Process] $Process)

  if (-not $Process -or $Process.MainWindowHandle -eq 0) {
    return $null
  }

  $nativeRect = New-Object RECT
  if (-not [WebClipperNative]::GetWindowRect($Process.MainWindowHandle, [ref] $nativeRect)) {
    return $null
  }

  return [PSCustomObject]@{
    Left = $nativeRect.Left
    Top = $nativeRect.Top
    Right = $nativeRect.Right
    Bottom = $nativeRect.Bottom
    Width = $nativeRect.Right - $nativeRect.Left
    Height = $nativeRect.Bottom - $nativeRect.Top
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
  $chrome = Get-ChromeProcess

  if ($chrome) {
    if ($MaximizeChrome) {
      [WebClipperNative]::ShowWindow($chrome.MainWindowHandle, [WebClipperNative]::SW_MAXIMIZE) | Out-Null
      Start-Sleep -Milliseconds 300
    }

    [WebClipperNative]::SetForegroundWindow($chrome.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 500
  }

  return $chrome
}

function Open-Or-NavigateUrl {
  param(
    [string] $Url,
    [bool] $OpenNewTab
  )

  if ($OpenNewTab) {
    Start-Process -FilePath $resolvedChromePath -ArgumentList @('--new-tab', $Url)
    return
  }

  Focus-Chrome | Out-Null
  [System.Windows.Forms.SendKeys]::SendWait('^l')
  Start-Sleep -Milliseconds 150
  Set-Clipboard -Value $Url
  Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 100
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}

function Get-RemainingMilliseconds {
  param([datetime] $Deadline)

  return [int] [Math]::Floor(($Deadline - (Get-Date)).TotalMilliseconds)
}

function Assert-LinkTimeRemaining {
  param(
    [datetime] $Deadline,
    [string] $Step
  )

  if ((Get-RemainingMilliseconds -Deadline $Deadline) -le 0) {
    throw (New-Object System.TimeoutException("Time budget exceeded before $Step."))
  }
}

function Sleep-WithinLinkBudget {
  param(
    [datetime] $Deadline,
    [int] $Milliseconds,
    [string] $Step
  )

  Assert-LinkTimeRemaining -Deadline $Deadline -Step $Step
  $remainingMilliseconds = Get-RemainingMilliseconds -Deadline $Deadline
  $sleepMilliseconds = [Math]::Min($Milliseconds, $remainingMilliseconds)
  if ($sleepMilliseconds -gt 0) {
    Start-Sleep -Milliseconds $sleepMilliseconds
  }

  if ($Milliseconds -gt $remainingMilliseconds) {
    throw (New-Object System.TimeoutException("Time budget exceeded during $Step."))
  }
}

function Wait-UntilLinkBudgetComplete {
  param([datetime] $Deadline)

  while ($true) {
    $remainingMilliseconds = Get-RemainingMilliseconds -Deadline $Deadline
    if ($remainingMilliseconds -le 0) {
      return
    }

    Start-Sleep -Milliseconds ([Math]::Min($remainingMilliseconds, 250))
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

  if ($MouseClickDelayMilliseconds -gt 0) {
    Start-Sleep -Milliseconds $MouseClickDelayMilliseconds
  }
}

function Move-To {
  param([int] $X, [int] $Y)
  [WebClipperNative]::SetCursorPos($X, $Y) | Out-Null
}

function Get-ElementCenter {
  param([System.Windows.Automation.AutomationElement] $Element)

  $rect = $Element.Current.BoundingRectangle
  if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) {
    return $null
  }

  return [PSCustomObject]@{
    X = [int] [Math]::Round($rect.Left + ($rect.Width / 2))
    Y = [int] [Math]::Round($rect.Top + ($rect.Height / 2))
  }
}

function Find-NamedUiElement {
  param(
    [string[]] $Names,
    [object[]] $ControlTypes,
    [int] $TimeoutMilliseconds = 2500
  )

  $deadline = (Get-Date).AddMilliseconds($TimeoutMilliseconds)
  do {
    foreach ($name in $Names) {
      foreach ($controlType in $ControlTypes) {
        $nameCondition = New-Object -TypeName System.Windows.Automation.PropertyCondition -ArgumentList @(
          [System.Windows.Automation.AutomationElement]::NameProperty,
          $name
        )
        $typeCondition = New-Object -TypeName System.Windows.Automation.PropertyCondition -ArgumentList @(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          $controlType
        )
        $condition = New-Object -TypeName System.Windows.Automation.AndCondition -ArgumentList @($nameCondition, $typeCondition)

        try {
          $element = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
            [System.Windows.Automation.TreeScope]::Subtree,
            $condition
          )
          if ($element) { return $element }
        } catch {
          Start-Sleep -Milliseconds 100
        }
      }
    }

    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)

  return $null
}

function Click-UiElement {
  param([System.Windows.Automation.AutomationElement] $Element)

  $center = Get-ElementCenter -Element $Element
  if (-not $center) { return $false }

  Click-At -X $center.X -Y $center.Y
  return $true
}

function Move-ToUiElement {
  param([System.Windows.Automation.AutomationElement] $Element)

  $center = Get-ElementCenter -Element $Element
  if (-not $center) { return $false }

  Move-To -X $center.X -Y $center.Y
  return $true
}

function Resolve-AutomationLayout {
  param([object] $WindowRect)

  if (-not $WindowRect) {
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $WindowRect = [PSCustomObject]@{
      Left = $screen.Left
      Top = $screen.Top
      Right = $screen.Right
      Bottom = $screen.Bottom
      Width = $screen.Width
      Height = $screen.Height
    }
  }

  $dynamicCoordinates = -not $UseFixedCoordinates

  $resolvedRightClickX = $RightClickX
  $resolvedRightClickY = $RightClickY
  $resolvedDropdownX = $DropdownX
  $resolvedDropdownY = $DropdownY
  $resolvedSaveFileX = $SaveFileX
  $resolvedSaveFileY = $SaveFileY
  $resolvedAddToObsidianX = $AddToObsidianX
  $resolvedAddToObsidianY = $AddToObsidianY

  if ($dynamicCoordinates -and -not $script:ProvidedParameterNames.ContainsKey('RightClickX')) {
    $resolvedRightClickX = $WindowRect.Left + (Limit-Int -Value ($WindowRect.Width * 0.035) -Minimum 24 -Maximum 72)
  }
  if ($dynamicCoordinates -and -not $script:ProvidedParameterNames.ContainsKey('RightClickY')) {
    $resolvedRightClickY = $WindowRect.Top + (Limit-Int -Value ($WindowRect.Height * 0.30) -Minimum 180 -Maximum 360)
  }
  if ($dynamicCoordinates -and -not $script:ProvidedParameterNames.ContainsKey('DropdownX')) {
    $resolvedDropdownX = $WindowRect.Right - 227
  }
  if ($dynamicCoordinates -and -not $script:ProvidedParameterNames.ContainsKey('DropdownY')) {
    $resolvedDropdownY = $WindowRect.Top + (Limit-Int -Value ($WindowRect.Height * 0.55) -Minimum 430 -Maximum 597)
  }
  if ($dynamicCoordinates -and -not $script:ProvidedParameterNames.ContainsKey('SaveFileX')) {
    $resolvedSaveFileX = $resolvedDropdownX - 78
  }
  if ($dynamicCoordinates -and -not $script:ProvidedParameterNames.ContainsKey('SaveFileY')) {
    $resolvedSaveFileY = $resolvedDropdownY - 39
  }
  if ($dynamicCoordinates -and -not $script:ProvidedParameterNames.ContainsKey('AddToObsidianX')) {
    $resolvedAddToObsidianX = $WindowRect.Right - 357
  }
  if ($dynamicCoordinates -and -not $script:ProvidedParameterNames.ContainsKey('AddToObsidianY')) {
    $resolvedAddToObsidianY = $WindowRect.Top + (Limit-Int -Value ($WindowRect.Height * 0.55) -Minimum 430 -Maximum 597)
  }

  if ($dynamicCoordinates) {
    $resolvedRightClickX = Limit-Int -Value $resolvedRightClickX -Minimum ($WindowRect.Left + 8) -Maximum ($WindowRect.Right - 8)
    $resolvedRightClickY = Limit-Int -Value $resolvedRightClickY -Minimum ($WindowRect.Top + 80) -Maximum ($WindowRect.Bottom - 8)
    $resolvedDropdownX = Limit-Int -Value $resolvedDropdownX -Minimum ($WindowRect.Left + 8) -Maximum ($WindowRect.Right - 8)
    $resolvedDropdownY = Limit-Int -Value $resolvedDropdownY -Minimum ($WindowRect.Top + 80) -Maximum ($WindowRect.Bottom - 8)
    $resolvedSaveFileX = Limit-Int -Value $resolvedSaveFileX -Minimum ($WindowRect.Left + 8) -Maximum ($WindowRect.Right - 8)
    $resolvedSaveFileY = Limit-Int -Value $resolvedSaveFileY -Minimum ($WindowRect.Top + 80) -Maximum ($WindowRect.Bottom - 8)
    $resolvedAddToObsidianX = Limit-Int -Value $resolvedAddToObsidianX -Minimum ($WindowRect.Left + 8) -Maximum ($WindowRect.Right - 8)
    $resolvedAddToObsidianY = Limit-Int -Value $resolvedAddToObsidianY -Minimum ($WindowRect.Top + 80) -Maximum ($WindowRect.Bottom - 8)
  }

  $resolvedClipperMenuX = $ClipperMenuX
  $resolvedClipperMenuY = $ClipperMenuY
  $resolvedSaveThisPageX = $SaveThisPageX
  $resolvedSaveThisPageY = $SaveThisPageY

  if (-not $UseAbsoluteContextMenuCoordinates) {
    $resolvedClipperMenuX = $resolvedRightClickX + $ClipperMenuOffsetX
    $resolvedClipperMenuY = $resolvedRightClickY + $ClipperMenuOffsetY
    $resolvedSaveThisPageX = $resolvedRightClickX + $SaveThisPageOffsetX
    $resolvedSaveThisPageY = $resolvedRightClickY + $SaveThisPageOffsetY
  }

  return [PSCustomObject]@{
    RightClickX = $resolvedRightClickX
    RightClickY = $resolvedRightClickY
    ClipperMenuX = $resolvedClipperMenuX
    ClipperMenuY = $resolvedClipperMenuY
    SaveThisPageX = $resolvedSaveThisPageX
    SaveThisPageY = $resolvedSaveThisPageY
    DropdownX = $resolvedDropdownX
    DropdownY = $resolvedDropdownY
    SaveFileX = $resolvedSaveFileX
    SaveFileY = $resolvedSaveFileY
    AddToObsidianX = $resolvedAddToObsidianX
    AddToObsidianY = $resolvedAddToObsidianY
    DynamicCoordinates = $dynamicCoordinates
  }
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
  $MaximizeChrome = $true
  $UseFixedCoordinates = $true
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
  $AddToObsidianX = 1563
  $AddToObsidianY = 597
}

$allUrls = @(Get-InputUrls)
if ($allUrls.Count -eq 0) {
  throw 'No URLs were provided.'
}

if ($MinLinkSeconds -le 0 -or $MaxLinkSeconds -lt $MinLinkSeconds) {
  throw 'MinLinkSeconds must be greater than 0 and MaxLinkSeconds must be greater than or equal to MinLinkSeconds.'
}
if ($MouseClickDelayMilliseconds -lt 0) {
  throw 'MouseClickDelayMilliseconds must be greater than or equal to 0.'
}

$resolvedChromePath = Resolve-ChromePath
$results = New-Object System.Collections.Generic.List[object]

Write-Step ('Using Chrome: {0}' -f $resolvedChromePath)
Write-Step ('Using Downloads: {0}' -f $DownloadDir)
Write-Step ('Coordinate mode: {0}' -f $(if ($UseFixedCoordinates) { 'fixed' } else { 'dynamic window-relative fallback' }))
Write-Step ('UI Automation lookup: {0}' -f $(if ($UseUiAutomation) { 'enabled' } else { 'disabled' }))
Write-Step ('Per-link random time budget: {0}-{1} seconds' -f $MinLinkSeconds, $MaxLinkSeconds)
Write-Step 'Per-link skip threshold: 3x the random time budget.'
Write-Step ('Extra delay after each mouse click: {0}ms' -f $MouseClickDelayMilliseconds)

for ($urlIndex = 0; $urlIndex -lt $allUrls.Count; $urlIndex++) {
  $url = $allUrls[$urlIndex]
  $startedAt = Get-Date
  $linkBudgetSeconds = Get-Random -Minimum $MinLinkSeconds -Maximum ($MaxLinkSeconds + 1)
  $linkTargetDeadline = $startedAt.AddSeconds($linkBudgetSeconds)
  $linkSkipSeconds = $linkBudgetSeconds * 3
  $linkSkipDeadline = $startedAt.AddSeconds($linkSkipSeconds)
  $savedFile = $null
  $status = 'Failed'
  $message = ''

  try {
    Write-Step ('Processing URL {0}/{1} with target={2}s skipAfter={3}s: {4}' -f ($urlIndex + 1), $allUrls.Count, $linkBudgetSeconds, $linkSkipSeconds, $url)
    Open-Or-NavigateUrl -Url $url -OpenNewTab ($urlIndex -eq 0)
    Sleep-WithinLinkBudget -Deadline $linkSkipDeadline -Milliseconds ($PageLoadSeconds * 1000) -Step 'page load'

    Assert-LinkTimeRemaining -Deadline $linkSkipDeadline -Step 'Chrome focus'
    $chrome = Focus-Chrome
    $windowRect = Get-WindowRect -Process $chrome
    $layout = Resolve-AutomationLayout -WindowRect $windowRect
    if ($windowRect) {
      Write-Step ('Chrome window: left={0}, top={1}, width={2}, height={3}' -f $windowRect.Left, $windowRect.Top, $windowRect.Width, $windowRect.Height)
    } else {
      Write-Step 'Chrome window bounds were unavailable; using primary screen bounds.'
    }
    Write-Step ('Right-click point: {0},{1}' -f $layout.RightClickX, $layout.RightClickY)
    Write-Step ('Clipper menu fallback point: {0},{1}' -f $layout.ClipperMenuX, $layout.ClipperMenuY)
    Write-Step ('Save this page fallback point: {0},{1}' -f $layout.SaveThisPageX, $layout.SaveThisPageY)
    Write-Step ('Add to Obsidian fallback point: {0},{1}' -f $layout.AddToObsidianX, $layout.AddToObsidianY)
    Save-DebugScreenshot -Name 'page-loaded'

    if ($PauseVideo -and -not $SkipPause) {
      Assert-LinkTimeRemaining -Deadline $linkSkipDeadline -Step 'video pause'
      Write-Step 'Pausing page video with the YouTube k shortcut.'
      [System.Windows.Forms.SendKeys]::SendWait('k')
      Sleep-WithinLinkBudget -Deadline $linkSkipDeadline -Milliseconds $AfterPauseMilliseconds -Step 'after video pause'
      Save-DebugScreenshot -Name 'after-pause'
    }

    Assert-LinkTimeRemaining -Deadline $linkSkipDeadline -Step 'context menu'
    Write-Step 'Opening Chrome context menu.'
    Click-At -X $layout.RightClickX -Y $layout.RightClickY -Button Right
    Sleep-WithinLinkBudget -Deadline $linkSkipDeadline -Milliseconds $AfterContextMenuMilliseconds -Step 'context menu wait'
    Save-DebugScreenshot -Name 'context-menu'

    Assert-LinkTimeRemaining -Deadline $linkSkipDeadline -Step 'Obsidian Web Clipper submenu'
    Write-Step 'Opening Obsidian Web Clipper submenu.'
    $usedUiAutomation = $false
    if ($UseUiAutomation) {
      $clipperMenu = Find-NamedUiElement -Names @('Obsidian Web Clipper') -ControlTypes @([System.Windows.Automation.ControlType]::MenuItem)
      if ($clipperMenu -and (Move-ToUiElement -Element $clipperMenu)) {
        $usedUiAutomation = $true
        Write-Step 'Located Obsidian Web Clipper context-menu item by UI Automation.'
      }
    }
    if (-not $usedUiAutomation) {
      if ($UseUiAutomation) {
        Write-Step 'Could not locate Obsidian Web Clipper by UI Automation; using fallback coordinates.'
      }
      Move-To -X $layout.ClipperMenuX -Y $layout.ClipperMenuY
    }
    Sleep-WithinLinkBudget -Deadline $linkSkipDeadline -Milliseconds $AfterSubmenuMilliseconds -Step 'clipper submenu wait'
    Save-DebugScreenshot -Name 'clipper-submenu'

    Assert-LinkTimeRemaining -Deadline $linkSkipDeadline -Step 'Save this page'
    Write-Step 'Choosing Save this page.'
    $usedUiAutomation = $false
    if ($UseUiAutomation) {
      $saveThisPage = Find-NamedUiElement -Names @('Save this page', 'Save This Page') -ControlTypes @([System.Windows.Automation.ControlType]::MenuItem)
      if ($saveThisPage -and (Click-UiElement -Element $saveThisPage)) {
        $usedUiAutomation = $true
        Write-Step 'Located Save this page submenu item by UI Automation.'
      }
    }
    if (-not $usedUiAutomation) {
      if ($UseUiAutomation) {
        Write-Step 'Could not locate Save this page by UI Automation; using fallback coordinates.'
      }
      Click-At -X $layout.SaveThisPageX -Y $layout.SaveThisPageY
    }
    Sleep-WithinLinkBudget -Deadline $linkSkipDeadline -Milliseconds ($PopupSeconds * 1000) -Step 'clipper popup wait'
    Save-DebugScreenshot -Name 'clipper-popup'

    Assert-LinkTimeRemaining -Deadline $linkSkipDeadline -Step 'Add to Obsidian'
    Write-Step 'Clicking Add to Obsidian.'
    $usedUiAutomation = $false
    if ($UseUiAutomation) {
      $addToObsidian = Find-NamedUiElement -Names @('添加到 Obsidian', '添加到obsidian', 'Add to Obsidian') -ControlTypes @(
        [System.Windows.Automation.ControlType]::Button
      )
      if ($addToObsidian -and (Click-UiElement -Element $addToObsidian)) {
        $usedUiAutomation = $true
        Write-Step 'Located Add to Obsidian button by UI Automation.'
      }
    }
    if (-not $usedUiAutomation) {
      if ($UseUiAutomation) {
        Write-Step 'Could not locate Add to Obsidian by UI Automation; using fallback coordinates.'
      }
      Click-At -X $layout.AddToObsidianX -Y $layout.AddToObsidianY
    }
    if ($AfterAddToObsidianSeconds -gt 0) {
      Sleep-WithinLinkBudget -Deadline $linkSkipDeadline -Milliseconds ($AfterAddToObsidianSeconds * 1000) -Step 'after Add to Obsidian'
    }
    Save-DebugScreenshot -Name 'after-add-to-obsidian'

    $status = 'AddedToObsidian'
    $message = 'Clicked Add to Obsidian in the Web Clipper popup.'
    Write-Step $message

    if ($AcceptNativeSaveDialog) {
      Write-Step 'AcceptNativeSaveDialog is ignored when using Add to Obsidian.'
    }

    $downloads = @(Get-NewMarkdownDownloads -After $startedAt)
    if ($downloads.Count -gt 0) {
      $savedFile = $downloads[0].FullName
      Write-Step ('Also detected a Markdown download: {0}' -f $savedFile)
    } else {
      $savedFile = $null
    }

    if ($CloseTabAfterSave -and $urlIndex -eq ($allUrls.Count - 1)) {
      [System.Windows.Forms.SendKeys]::SendWait('^w')
      Start-Sleep -Milliseconds 500
    } elseif ($CloseTabAfterSave) {
      Write-Step 'CloseTabAfterSave is deferred because the current tab is reused for the next URL.'
    }
  } catch [System.TimeoutException] {
    $message = $_.Exception.Message
    $status = 'SkippedTimeout'
    Write-Step ('Skipped due to time budget: {0}' -f $message)
  } catch {
    $message = $_.Exception.Message
    Write-Step ('Error: {0}' -f $message)
  }

  $remainingMilliseconds = Get-RemainingMilliseconds -Deadline $linkTargetDeadline
  if ($remainingMilliseconds -gt 0) {
    Write-Step ('Waiting {0:N1}s to finish this link target time.' -f ($remainingMilliseconds / 1000))
    Wait-UntilLinkBudgetComplete -Deadline $linkTargetDeadline
  }

  $finishedAt = Get-Date
  $actualSeconds = ($finishedAt - $startedAt).TotalSeconds
  Write-Step ('Finished URL {0}/{1}: target={2}s skipAfter={3}s actual={4:N2}s status={5}' -f ($urlIndex + 1), $allUrls.Count, $linkBudgetSeconds, $linkSkipSeconds, $actualSeconds, $status)

  $results.Add([PSCustomObject]@{
    Url = $url
    Status = $status
    File = $savedFile
    Message = $message
    BudgetSeconds = $linkBudgetSeconds
    SkipAfterSeconds = $linkSkipSeconds
    ActualSeconds = [Math]::Round($actualSeconds, 2)
    StartedAt = $startedAt
    FinishedAt = $finishedAt
  })

  if ($BetweenUrlsSeconds -gt 0) {
    Start-Sleep -Seconds $BetweenUrlsSeconds
  }
}

$results | Format-Table -AutoSize
