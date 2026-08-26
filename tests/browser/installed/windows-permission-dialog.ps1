param(
  [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$TargetProcessId,
  [Parameter(Mandatory = $true)][string]$ExpectedProcessPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-F0-9]{64}$')][string]$ExpectedProcessSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+$')][string]$ExpectedProcessStartTimeUtcTicks,
  [Parameter(Mandatory = $true)][ValidateSet('SMOKE-01.observe-none', 'SETTINGS-01.observe-none', 'PERM-01.allow', 'PERM-01.deny', 'PERM-01.dismiss', 'PERM-01.timeout-late-allow')][string]$ExpectedScheduleId,
  [Parameter(Mandatory = $true)][ValidateSet('brave', 'chrome')][string]$ExpectedBrowserName,
  [Parameter(Mandatory = $true)][string]$ExpectedBrowserVersion,
  [Parameter(Mandatory = $true)][ValidateSet('allow', 'deny', 'dismiss', 'observe-none')][string]$Action,
  [Parameter(Mandatory = $true)][string]$ExpectedExtensionName,
  [Parameter(Mandatory = $true)][string]$ExpectedDialogTitle,
  [Parameter(Mandatory = $true)][string]$ExpectedFragmentsJson,
  [Parameter(Mandatory = $true)][string]$ExpectedPermissionPatternsJson,
  [Parameter(Mandatory = $true)][string]$ExpectedUiaNamesJson,
  [Parameter(Mandatory = $true)][string]$ExpectedActionControlName,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-F0-9]{64}$')][string]$ExpectedHelperSha256,
  [ValidateRange(1, 420)][int]$TimeoutSeconds = 20,
  [ValidateRange(0, 360)][int]$ActionDelaySeconds = 0
)

$ErrorActionPreference = 'Stop'
$failurePhase = 'before_ready'
$failureStage = 'helper_identity'

function Get-ExactSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [System.IO.File]::Open(
    $Path,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::Read
  )
  try {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
    } finally {
      $algorithm.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Write-Evidence {
  param([Parameter(Mandatory = $true)][object]$Value)
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 8 -Compress))
}

function Get-ExactTargetProcess {
  $process = Get-Process -Id $TargetProcessId -ErrorAction Stop
  $path = [System.IO.Path]::GetFullPath([string]$process.Path)
  $startTicks = $process.StartTime.ToUniversalTime().Ticks.ToString()
  $hash = Get-ExactSha256 -Path $path
  if (-not [string]::Equals($path, $ExpectedProcessPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Target browser process path changed or differs from the approved path.'
  }
  if (-not [string]::Equals($hash, $ExpectedProcessSha256, [StringComparison]::Ordinal)) {
    throw 'Target browser executable SHA-256 changed or differs from the approved hash.'
  }
  if (-not [string]::Equals($startTicks, $ExpectedProcessStartTimeUtcTicks, [StringComparison]::Ordinal)) {
    throw 'Target browser process start identity changed or differs from the approved process.'
  }
  return [pscustomobject]@{
    processId = $process.Id
    path = $path
    sha256 = $hash
    startTimeUtcTicks = $startTicks
  }
}

function Get-MatchingDialog {
  $processCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
    $TargetProcessId
  )
  $topLevel = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    $processCondition
  )
  $matches = @()
  foreach ($candidate in $topLevel) {
    $current = $candidate.Current
    if (
      [string]::Equals($current.Name, $ExpectedDialogTitle, [StringComparison]::Ordinal) -and
      $current.ControlType -eq [System.Windows.Automation.ControlType]::Window -and
      $current.IsEnabled -and
      -not $current.IsOffscreen
    ) {
      $matches += $candidate
    }
  }
  return ,$matches
}

function Get-DialogNames {
  param([Parameter(Mandatory = $true)][System.Windows.Automation.AutomationElement]$Dialog)
  $elements = $Dialog.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $names = @()
  foreach ($element in $elements) {
    $name = [string]$element.Current.Name
    if (-not [string]::IsNullOrWhiteSpace($name)) {
      $names += (($name.Trim()) -replace '\s+', ' ')
    }
  }
  return ,($names | Sort-Object -CaseSensitive)
}

function Assert-ExpectedDialogContent {
  param([Parameter(Mandatory = $true)][System.Windows.Automation.AutomationElement]$Dialog)
  $names = Get-DialogNames -Dialog $Dialog
  if (($names -join "`n") -cne ($expectedUiaNames -join "`n")) {
    throw 'Exact normalized UIA snapshot differs from the reviewed pinned-browser snapshot.'
  }
  $combined = $names -join "`n"
  if ($ExpectedDialogTitle.IndexOf($ExpectedExtensionName, [StringComparison]::Ordinal) -lt 0) {
    throw 'Expected dialog title does not contain the exact extension name.'
  }
  foreach ($fragment in $expectedFragments) {
    if ($combined.IndexOf($fragment, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
      throw "Expected permission fragment was absent from the exact dialog: $fragment"
    }
  }
  return ,$names
}

function Get-ExactActionControl {
  param([Parameter(Mandatory = $true)][System.Windows.Automation.AutomationElement]$Dialog)
  $buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )
  $buttons = $Dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
  $matches = @()
  foreach ($button in $buttons) {
    $current = $button.Current
    if (
      [string]::Equals($current.Name, $ExpectedActionControlName, [StringComparison]::Ordinal) -and
      $current.IsEnabled -and
      -not $current.IsOffscreen
    ) {
      $matches += $button
    }
  }
  if ($matches.Count -ne 1) {
    throw "Expected exactly one enabled visible action control; observed $($matches.Count)."
  }
  return $matches[0]
}

try {
  $canonicalHelper = [System.IO.Path]::GetFullPath($PSCommandPath)
  if (-not [string]::Equals((Get-ExactSha256 -Path $canonicalHelper), $ExpectedHelperSha256, [StringComparison]::Ordinal)) {
    throw 'Native permission helper bytes differ from the approved helper SHA-256.'
  }
  $failureStage = 'request_json_decode'
  # Windows PowerShell 5.1 returns a top-level JSON array as one Object[] pipeline
  # value. Wrapping that pipeline in @() nests the array and changes its Count/join
  # semantics. The explicit cast preserves the decoded array elements themselves.
  $expectedFragments = [object[]]($ExpectedFragmentsJson | ConvertFrom-Json)
  $expectedUiaNames = [object[]]($ExpectedUiaNamesJson | ConvertFrom-Json)
  $permissionPatterns = [object[]]($ExpectedPermissionPatternsJson | ConvertFrom-Json)
  $failureStage = 'request_policy'
  $reviewedPermissionPatterns = @(
    'http://*.example.com/*',
    'http://example.com/*',
    'https://*.example.com/*',
    'https://example.com/*'
  )
  if (($permissionPatterns -join "`n") -cne ($reviewedPermissionPatterns -join "`n")) {
    throw 'Permission patterns differ from the exact four-pattern example.com review boundary.'
  }
  $reviewedSchedule = switch ($ExpectedScheduleId) {
    'SMOKE-01.observe-none' { @{ scenarioId = 'SMOKE-01'; action = 'observe-none'; timeout = 420; delay = 0 } }
    'SETTINGS-01.observe-none' { @{ scenarioId = 'SETTINGS-01'; action = 'observe-none'; timeout = 420; delay = 0 } }
    'PERM-01.allow' { @{ scenarioId = 'PERM-01'; action = 'allow'; timeout = 20; delay = 0 } }
    'PERM-01.deny' { @{ scenarioId = 'PERM-01'; action = 'deny'; timeout = 20; delay = 0 } }
    'PERM-01.dismiss' { @{ scenarioId = 'PERM-01'; action = 'dismiss'; timeout = 20; delay = 0 } }
    'PERM-01.timeout-late-allow' { @{ scenarioId = 'PERM-01'; action = 'allow'; timeout = 420; delay = 360 } }
    default { throw 'Unknown native prompt scenario schedule.' }
  }
  if (
    $Action -cne $reviewedSchedule.action -or
    $TimeoutSeconds -ne $reviewedSchedule.timeout -or
    $ActionDelaySeconds -ne $reviewedSchedule.delay
  ) {
    throw 'Native prompt action or timing differs from the exact reviewed scenario schedule.'
  }
  if (
    $expectedFragments.Count -lt 1 -or
    $expectedFragments.Count -gt 8 -or
    @($expectedFragments | Where-Object { $_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_) }).Count -ne 0 -or
    @($expectedFragments | Select-Object -Unique).Count -ne $expectedFragments.Count
  ) {
    throw 'Expected permission fragments are empty, duplicated, or outside the bounded count.'
  }

  $failureStage = 'uia_assembly_load'
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $failureStage = 'target_process_identity'
  $initialProcess = Get-ExactTargetProcess
  $readyAt = [DateTimeOffset]::UtcNow.ToString('o')
  $failureStage = 'readiness_emit'
  Write-Evidence ([pscustomobject]@{
    schema = 'sitewipe.native-permission-helper-ready.v1'
    status = 'ready'
    scheduleId = $ExpectedScheduleId
    scenarioId = $reviewedSchedule.scenarioId
    browserName = $ExpectedBrowserName
    browserVersion = $ExpectedBrowserVersion
    action = $Action
    helperProcessId = $PID
    targetProcess = $initialProcess
    readyAt = $readyAt
  })
  $failurePhase = 'after_ready'
  $failureStage = 'runtime_observation'
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $matchingDialog = $null

  if ($Action -eq 'observe-none') {
    $stopReader = [Console]::In.ReadLineAsync()
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
      $dialogs = @(Get-MatchingDialog)
      if ($dialogs.Count -gt 1) {
        throw "Expected at most one exact permission dialog; observed $($dialogs.Count)."
      }
      if ($dialogs.Count -eq 1) {
        $names = Assert-ExpectedDialogContent -Dialog $dialogs[0]
        Write-Evidence ([pscustomobject]@{
          schema = 'sitewipe.native-permission-dialog-evidence.v1'
          status = 'unexpected_prompt_observed'
          scheduleId = $ExpectedScheduleId
          scenarioId = $reviewedSchedule.scenarioId
          browserName = $ExpectedBrowserName
          browserVersion = $ExpectedBrowserVersion
          action = $Action
          targetProcess = $initialProcess
          dialogTitle = $ExpectedDialogTitle
          expectedFragments = $expectedFragments
          permissionPatterns = $permissionPatterns
          observedNames = $names
          observationStartedAt = $readyAt
          observedAt = [DateTimeOffset]::UtcNow.ToString('o')
        })
        exit 8
      }
      if ($stopReader.IsCompleted) {
        $stopLine = $stopReader.GetAwaiter().GetResult()
        if ([string]::IsNullOrWhiteSpace($stopLine)) {
          throw 'Native no-prompt observer stop channel closed without its exact command.'
        }
        $stopControl = $stopLine | ConvertFrom-Json
        $actualStopKeys = @($stopControl.PSObject.Properties.Name | Sort-Object -CaseSensitive)
        $expectedStopKeys = @('command', 'scheduleId', 'schema')
        if (
          ($actualStopKeys -join "`n") -cne ($expectedStopKeys -join "`n") -or
          $stopControl.schema -cne 'sitewipe.native-permission-helper-control.v1' -or
          $stopControl.command -cne 'stop-observation' -or
          $stopControl.scheduleId -cne $ExpectedScheduleId
        ) {
          throw 'Native no-prompt observer received an inexact controlled-stop command.'
        }
        $stopRequestedAt = [DateTimeOffset]::UtcNow.ToString('o')
        $finalDialogs = @(Get-MatchingDialog)
        if ($finalDialogs.Count -ne 0) {
          throw 'An exact permission dialog appeared while the no-prompt observer was settling.'
        }
        $finalProcess = Get-ExactTargetProcess
        Write-Evidence ([pscustomobject]@{
          schema = 'sitewipe.native-permission-dialog-evidence.v1'
          status = 'no_prompt_observed'
          scheduleId = $ExpectedScheduleId
          scenarioId = $reviewedSchedule.scenarioId
          browserName = $ExpectedBrowserName
          browserVersion = $ExpectedBrowserVersion
          action = $Action
          targetProcess = $finalProcess
          dialogTitle = $ExpectedDialogTitle
          expectedFragments = $expectedFragments
          permissionPatterns = $permissionPatterns
          observedNames = @()
          observationStartedAt = $readyAt
          stopRequestedAt = $stopRequestedAt
          observedAt = [DateTimeOffset]::UtcNow.ToString('o')
        })
        exit 0
      }
      Start-Sleep -Milliseconds 50
    }
    Write-Evidence ([pscustomobject]@{
      schema = 'sitewipe.native-permission-dialog-evidence.v1'
      status = 'observation_watchdog_expired'
      scheduleId = $ExpectedScheduleId
      scenarioId = $reviewedSchedule.scenarioId
      browserName = $ExpectedBrowserName
      browserVersion = $ExpectedBrowserVersion
      action = $Action
      targetProcess = $initialProcess
      dialogTitle = $ExpectedDialogTitle
      expectedFragments = $expectedFragments
      permissionPatterns = $permissionPatterns
      observedNames = @()
      observationStartedAt = $readyAt
      observedAt = [DateTimeOffset]::UtcNow.ToString('o')
    })
    exit 10
  }

  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    $dialogs = @(Get-MatchingDialog)
    if ($dialogs.Count -gt 1) {
      throw "Expected at most one exact permission dialog; observed $($dialogs.Count)."
    }
    if ($dialogs.Count -eq 1) {
      $matchingDialog = $dialogs[0]
      break
    }
    Start-Sleep -Milliseconds 50
  }

  if ($null -eq $matchingDialog) {
    Write-Evidence ([pscustomobject]@{
      schema = 'sitewipe.native-permission-dialog-evidence.v1'
      status = 'prompt_timeout'
      scheduleId = $ExpectedScheduleId
      scenarioId = $reviewedSchedule.scenarioId
      browserName = $ExpectedBrowserName
      browserVersion = $ExpectedBrowserVersion
      action = $Action
      targetProcess = $initialProcess
      dialogTitle = $ExpectedDialogTitle
      expectedFragments = $expectedFragments
      permissionPatterns = $permissionPatterns
      observedNames = @()
      observedAt = [DateTimeOffset]::UtcNow.ToString('o')
    })
    exit 7
  }

  $observedNames = Assert-ExpectedDialogContent -Dialog $matchingDialog
  $actionControl = Get-ExactActionControl -Dialog $matchingDialog
  if ($ActionDelaySeconds -gt 0) {
    Start-Sleep -Seconds $ActionDelaySeconds
  }
  $finalProcess = Get-ExactTargetProcess
  $dialogsBeforeInvoke = @(Get-MatchingDialog)
  $originalRuntimeId = ($matchingDialog.GetRuntimeId() -join ',')
  $finalRuntimeId = if ($dialogsBeforeInvoke.Count -eq 1) { $dialogsBeforeInvoke[0].GetRuntimeId() -join ',' } else { '' }
  if ($dialogsBeforeInvoke.Count -ne 1 -or -not [string]::Equals($originalRuntimeId, $finalRuntimeId, [StringComparison]::Ordinal)) {
    throw 'Exact permission dialog identity changed before invocation.'
  }
  $actionControl = Get-ExactActionControl -Dialog $dialogsBeforeInvoke[0]
  $invokePattern = $actionControl.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  if ($null -eq $invokePattern) {
    throw 'Exact permission action control does not expose UIA InvokePattern.'
  }
  $invokePattern.Invoke()

  Write-Evidence ([pscustomobject]@{
    schema = 'sitewipe.native-permission-dialog-evidence.v1'
    status = 'invoked'
    scheduleId = $ExpectedScheduleId
    scenarioId = $reviewedSchedule.scenarioId
    browserName = $ExpectedBrowserName
    browserVersion = $ExpectedBrowserVersion
    action = $Action
    actionControlName = $ExpectedActionControlName
    targetProcess = $finalProcess
    dialogTitle = $ExpectedDialogTitle
    expectedFragments = $expectedFragments
    permissionPatterns = $permissionPatterns
    observedNames = $observedNames
    observedAt = [DateTimeOffset]::UtcNow.ToString('o')
  })
  exit 0
} catch {
  Write-Evidence ([pscustomobject]@{
    schema = 'sitewipe.native-permission-helper-failure.v1'
    status = 'failed'
    phase = $failurePhase
    stage = $failureStage
    scheduleId = $ExpectedScheduleId
    browserName = $ExpectedBrowserName
    action = $Action
    helperProcessId = $PID
    targetProcessId = $TargetProcessId
  })
  exit 9
}
