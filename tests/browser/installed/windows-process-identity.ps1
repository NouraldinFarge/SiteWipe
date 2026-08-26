param(
  [Parameter(Mandatory = $true)][ValidateSet('Identity', 'ProfileResidue', 'TerminateTree')][string]$Mode,
  [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$TargetProcessId,
  [Parameter(Mandatory = $true)][string]$ExpectedProcessPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-F0-9]{64}$')][string]$ExpectedProcessSha256,
  [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ExpectedProcessStartTimeUtcTicks,
  [Parameter(Mandatory = $true)][string]$ExpectedProfilePath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-F0-9]{64}$')][string]$ExpectedHelperSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class SiteWipeWindowsCommandLine {
    [DllImport("shell32.dll", SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int argumentCount);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static string[] Split(string commandLine) {
        if (String.IsNullOrWhiteSpace(commandLine)) return Array.Empty<string>();
        int count;
        IntPtr address = CommandLineToArgvW(commandLine, out count);
        if (address == IntPtr.Zero) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
            var values = new List<string>(count);
            for (int index = 0; index < count; index++) {
                IntPtr valueAddress = Marshal.ReadIntPtr(address, index * IntPtr.Size);
                values.Add(Marshal.PtrToStringUni(valueAddress) ?? String.Empty);
            }
            return values.ToArray();
        } finally {
            LocalFree(address);
        }
    }
}
'@

function Assert-ExactLocalDrivePath {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (
    $Value.Length -eq 0 -or
    -not [string]::Equals($Value, $Value.Trim(), [StringComparison]::Ordinal) -or
    $Value.IndexOf([char]0) -ge 0 -or
    $Value -notmatch '^[A-Za-z]:[\\/]'
  ) {
    throw "$Label must be one exact local drive-qualified path."
  }
  return [System.IO.Path]::GetFullPath($Value)
}

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

function Get-TextSha256 {
  param([Parameter(Mandatory = $true)][string]$Value)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    return ([System.BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '')
  } finally {
    $algorithm.Dispose()
  }
}

function Get-CommandLineArguments {
  param([AllowNull()][string]$CommandLine)
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return @() }
  return @([SiteWipeWindowsCommandLine]::Split($CommandLine))
}

function Test-ExactProfileArgument {
  param(
    [AllowNull()][string]$CommandLine,
    [Parameter(Mandatory = $true)][string]$ProfilePath
  )
  $arguments = @(Get-CommandLineArguments -CommandLine $CommandLine)
  for ($index = 0; $index -lt $arguments.Count; $index += 1) {
    $candidate = $null
    if ($arguments[$index].StartsWith('--user-data-dir=', [StringComparison]::OrdinalIgnoreCase)) {
      $candidate = $arguments[$index].Substring('--user-data-dir='.Length)
    } elseif (
      [string]::Equals($arguments[$index], '--user-data-dir', [StringComparison]::OrdinalIgnoreCase) -and
      $index + 1 -lt $arguments.Count
    ) {
      $candidate = $arguments[$index + 1]
    }
    if ($null -ne $candidate) {
      try {
        $exactCandidate = Assert-ExactLocalDrivePath -Value $candidate -Label 'Observed browser profile argument'
        if ([string]::Equals($exactCandidate, $ProfilePath, [StringComparison]::OrdinalIgnoreCase)) {
          return $true
        }
      } catch {
        continue
      }
    }
  }
  return $false
}

function Get-ProcessStartTimeUtcTicks {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $process = Get-Process -Id $ProcessId -ErrorAction Stop
  try {
    return $process.StartTime.ToUniversalTime().Ticks.ToString()
  } finally {
    $process.Dispose()
  }
}

function Get-ExactProcessPath {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $process = Get-Process -Id $ProcessId -ErrorAction Stop
  try {
    return [System.IO.Path]::GetFullPath([string]$process.Path)
  } finally {
    $process.Dispose()
  }
}

function Get-SingleProcessRecord {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $records = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId")
  if ($records.Count -ne 1) {
    throw "Expected exactly one local process record for PID $ProcessId."
  }
  return $records[0]
}

function Write-Evidence {
  param([Parameter(Mandatory = $true)][object]$Value)
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 8 -Compress))
}

$helperPath = Assert-ExactLocalDrivePath -Value $MyInvocation.MyCommand.Path -Label 'Process helper path'
$expectedPath = Assert-ExactLocalDrivePath -Value $ExpectedProcessPath -Label 'Expected browser path'
$expectedProfile = Assert-ExactLocalDrivePath -Value $ExpectedProfilePath -Label 'Expected profile path'
$helperHash = Get-ExactSha256 -Path $helperPath
if (-not [string]::Equals($helperHash, $ExpectedHelperSha256, [StringComparison]::Ordinal)) {
  throw 'Process-observation helper bytes differ from the invoking runtime contract.'
}

if ($Mode -eq 'Identity') {
  if ($ExpectedProcessStartTimeUtcTicks.Length -ne 0) {
    throw 'Identity observation must discover, not accept, the browser start-time identity.'
  }
  $record = Get-SingleProcessRecord -ProcessId $TargetProcessId
  $path = Get-ExactProcessPath -ProcessId $TargetProcessId
  $startTicks = Get-ProcessStartTimeUtcTicks -ProcessId $TargetProcessId
  $hash = Get-ExactSha256 -Path $path
  if (-not [string]::Equals($path, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Target browser process path differs from the approved executable path.'
  }
  if (-not [string]::Equals($hash, $ExpectedProcessSha256, [StringComparison]::Ordinal)) {
    throw 'Target browser executable hash differs from the approved executable hash.'
  }
  if (-not (Test-ExactProfileArgument -CommandLine $record.CommandLine -ProfilePath $expectedProfile)) {
    throw 'Target browser command line is not bound to the exact disposable profile.'
  }
  Write-Evidence -Value ([ordered]@{
      schema = 'sitewipe.windows-process-observation.v1'
      mode = 'identity'
      targetProcess = [ordered]@{
        processId = $TargetProcessId
        parentProcessId = [int]$record.ParentProcessId
        path = $path
        sha256 = $hash
        startTimeUtcTicks = $startTicks
        profilePath = $expectedProfile
        commandLineSha256 = Get-TextSha256 -Value ([string]$record.CommandLine)
      }
      observedAt = [DateTimeOffset]::UtcNow.ToString('o')
    })
  exit 0
}

if ($ExpectedProcessStartTimeUtcTicks -notmatch '^\d+$') {
  throw 'Post-launch process handling requires the exact original browser start-time identity.'
}

$records = @(Get-CimInstance -ClassName Win32_Process)
if ($records.Count -gt 16384) {
  throw 'Local process inventory exceeds the bounded residue-observation limit.'
}
$recordById = @{}
foreach ($record in $records) {
  $recordById[[int]$record.ProcessId] = $record
}

$rootPresent = $recordById.ContainsKey($TargetProcessId)
if ($rootPresent) {
  try {
    $rootPath = Get-ExactProcessPath -ProcessId $TargetProcessId
    $rootStartTicks = Get-ProcessStartTimeUtcTicks -ProcessId $TargetProcessId
    $rootHash = Get-ExactSha256 -Path $rootPath
    if (
      -not [string]::Equals($rootPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals($rootHash, $ExpectedProcessSha256, [StringComparison]::Ordinal) -or
      -not [string]::Equals($rootStartTicks, $ExpectedProcessStartTimeUtcTicks, [StringComparison]::Ordinal)
    ) {
      throw 'Root browser PID was reused or changed before profile-residue observation.'
    }
  } catch {
    $rootRecheck = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $TargetProcessId")
    if ($rootRecheck.Count -ne 0) { throw }
    $rootPresent = $false
  }
}

$treeIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$treeIds.Add($TargetProcessId)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($record in $records) {
    $processId = [int]$record.ProcessId
    $parentId = [int]$record.ParentProcessId
    if (-not $treeIds.Contains($processId) -and $treeIds.Contains($parentId)) {
      [void]$treeIds.Add($processId)
      $changed = $true
    }
  }
}

if ($Mode -eq 'TerminateTree') {
  if (-not $rootPresent) {
    Write-Evidence -Value ([ordered]@{
        schema = 'sitewipe.windows-process-termination.v1'
        mode = 'terminate-tree'
        rootIdentity = [ordered]@{
          processId = $TargetProcessId
          path = $expectedPath
          sha256 = $ExpectedProcessSha256
          startTimeUtcTicks = $ExpectedProcessStartTimeUtcTicks
          present = $false
        }
        terminatedProcesses = @()
        observedAt = [DateTimeOffset]::UtcNow.ToString('o')
      })
    exit 0
  }

  $targets = @()
  foreach ($processId in $treeIds) {
    if (-not $recordById.ContainsKey($processId)) { continue }
    $record = $recordById[$processId]
    $path = Get-ExactProcessPath -ProcessId $processId
    $hash = Get-ExactSha256 -Path $path
    $startTicks = Get-ProcessStartTimeUtcTicks -ProcessId $processId
    if (
      -not [string]::Equals($path, $expectedPath, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals($hash, $ExpectedProcessSha256, [StringComparison]::Ordinal)
    ) {
      throw "Disposable browser tree PID $processId differs from the exact approved browser executable."
    }
    if (
      $processId -eq $TargetProcessId -and
      (
        -not [string]::Equals($startTicks, $ExpectedProcessStartTimeUtcTicks, [StringComparison]::Ordinal) -or
        -not (Test-ExactProfileArgument -CommandLine $record.CommandLine -ProfilePath $expectedProfile)
      )
    ) {
      throw 'Root browser identity or disposable-profile binding changed before tree termination.'
    }

    $depth = 0
    $cursor = $record
    $visited = [System.Collections.Generic.HashSet[int]]::new()
    while ([int]$cursor.ProcessId -ne $TargetProcessId) {
      $cursorId = [int]$cursor.ProcessId
      if (-not $visited.Add($cursorId)) {
        throw 'Disposable browser process tree contains a parent cycle.'
      }
      $parentId = [int]$cursor.ParentProcessId
      if (-not $recordById.ContainsKey($parentId)) {
        throw "Disposable browser tree PID $processId lost its exact root ancestry."
      }
      $cursor = $recordById[$parentId]
      $depth += 1
      if ($depth -gt 64) {
        throw 'Disposable browser process tree exceeds the bounded ancestry depth.'
      }
    }
    $targets += [pscustomobject][ordered]@{
      processId = $processId
      parentProcessId = [int]$record.ParentProcessId
      depth = $depth
      path = $path
      sha256 = $hash
      startTimeUtcTicks = $startTicks
    }
  }
  if ($targets.Count -gt 512) {
    throw 'Disposable browser process tree exceeds the bounded termination count.'
  }
  $targets = @($targets | Sort-Object -Property @{ Expression = 'depth'; Descending = $true }, @{ Expression = 'processId'; Descending = $true })
  $terminated = @()
  foreach ($target in $targets) {
    $current = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($target.processId)")
    if ($current.Count -eq 0) { continue }
    if ($current.Count -ne 1) {
      throw "Could not re-establish one exact process record for termination PID $($target.processId)."
    }
    $currentPath = Get-ExactProcessPath -ProcessId $target.processId
    $currentHash = Get-ExactSha256 -Path $currentPath
    $currentStartTicks = Get-ProcessStartTimeUtcTicks -ProcessId $target.processId
    if (
      [int]$current[0].ParentProcessId -ne $target.parentProcessId -or
      -not [string]::Equals($currentPath, $target.path, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals($currentHash, $target.sha256, [StringComparison]::Ordinal) -or
      -not [string]::Equals($currentStartTicks, $target.startTimeUtcTicks, [StringComparison]::Ordinal)
    ) {
      throw "Disposable browser tree PID $($target.processId) changed immediately before termination."
    }
    Stop-Process -Id $target.processId -Force -ErrorAction Stop
    $terminated += $target
  }

  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
  do {
    $remaining = @($targets | Where-Object {
        @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($_.processId)").Count -ne 0
      })
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 50
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  if ($remaining.Count -ne 0) {
    throw 'Disposable browser tree did not terminate within the fixed settlement bound.'
  }

  Write-Evidence -Value ([ordered]@{
      schema = 'sitewipe.windows-process-termination.v1'
      mode = 'terminate-tree'
      rootIdentity = [ordered]@{
        processId = $TargetProcessId
        path = $expectedPath
        sha256 = $ExpectedProcessSha256
        startTimeUtcTicks = $ExpectedProcessStartTimeUtcTicks
        present = $true
      }
      terminatedProcesses = @($terminated)
      observedAt = [DateTimeOffset]::UtcNow.ToString('o')
    })
  exit 0
}

$residues = @()
foreach ($record in $records) {
  $processId = [int]$record.ProcessId
  $profileMatch = Test-ExactProfileArgument -CommandLine $record.CommandLine -ProfilePath $expectedProfile
  $treeMatch = $treeIds.Contains($processId)
  if (-not $profileMatch -and -not $treeMatch) { continue }

  try {
    $startTicks = Get-ProcessStartTimeUtcTicks -ProcessId $processId
  } catch {
    $processRecheck = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $processId")
    if ($processRecheck.Count -ne 0) {
      throw "Could not establish exact start-time identity for live residue PID $processId."
    }
    continue
  }
  $path = $null
  $hash = $null
  try {
    $path = Get-ExactProcessPath -ProcessId $processId
    $hash = Get-ExactSha256 -Path $path
  } catch {
    $path = $null
    $hash = $null
  }
  $matchedBy = @()
  if ($treeMatch) { $matchedBy += 'process-tree' }
  if ($profileMatch) { $matchedBy += 'profile-argument' }
  $commandLineHash = $null
  if ($null -ne $record.CommandLine) {
    $commandLineHash = Get-TextSha256 -Value ([string]$record.CommandLine)
  }
  $residues += [pscustomobject][ordered]@{
    processId = $processId
    parentProcessId = [int]$record.ParentProcessId
    path = $path
    sha256 = $hash
    startTimeUtcTicks = $startTicks
    commandLineSha256 = $commandLineHash
    matchedBy = @($matchedBy)
  }
}

$residues = @($residues | Sort-Object -Property processId)
Write-Evidence -Value ([ordered]@{
    schema = 'sitewipe.windows-process-observation.v1'
    mode = 'profile-residue'
    rootIdentity = [ordered]@{
      processId = $TargetProcessId
      path = $expectedPath
      sha256 = $ExpectedProcessSha256
      startTimeUtcTicks = $ExpectedProcessStartTimeUtcTicks
      present = $rootPresent
    }
    profilePath = $expectedProfile
    residues = @($residues)
    observedAt = [DateTimeOffset]::UtcNow.ToString('o')
  })
