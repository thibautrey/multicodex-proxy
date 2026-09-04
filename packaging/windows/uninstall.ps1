#Requires -Version 5.1

[CmdletBinding()]
param(
    [switch]$Purge
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgramName = "MultiVibe Host uninstaller"
$TaskName = "MultiVibe Host Update"
$RunSubKey = "Software\Microsoft\Windows\CurrentVersion\Run"
$RunValueName = "MultiVibe Host"
$StateSubKey = "Software\MultiVibe Host"
$ProtocolSubKey = "Software\Classes\multivibe"
$ProtocolCommandSubKey = "$ProtocolSubKey\shell\open\command"
$ProtocolDefaultName = "(default)"
$CurrentUserSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$PathComparison = [System.StringComparison]::OrdinalIgnoreCase
$ManagedProcessNames = @(
    "multivibe-host", "multivibe-host-menu", "multivibe-host-updater", "multivibe-provider-agent",
    "node", "ollama", "llama-server", "llama-quantize", "ollama_llama_server"
)

function Fail([string]$Message) {
    throw "$ProgramName`: $Message"
}

function Normalize-Path([string]$Candidate, [string]$Description) {
    if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate.IndexOf([char]0) -ge 0) { Fail "$Description is unavailable" }
    if (-not [System.IO.Path]::IsPathRooted($Candidate)) { Fail "$Description must be an absolute path" }
    try { $full = [System.IO.Path]::GetFullPath($Candidate) } catch { Fail "$Description is invalid" }
    while ($full.Length -gt 3 -and ($full.EndsWith("\") -or $full.EndsWith("/"))) { $full = $full.Substring(0, $full.Length - 1) }
    if ($full -match '[*?\[\]]') { Fail "$Description contains wildcard characters" }
    return $full
}

function Test-PathWithin([string]$Candidate, [string]$Parent) {
    try {
        $child = Normalize-Path $Candidate "the path"
        $root = Normalize-Path $Parent "the parent path"
    } catch { return $false }
    return $child.Equals($root, $PathComparison) -or $child.StartsWith($root + "\", $PathComparison)
}

function Test-DirectChild([string]$Candidate, [string]$Parent) {
    if (-not (Test-PathWithin $Candidate $Parent)) { return $false }
    try {
        return ([System.IO.Path]::GetDirectoryName((Normalize-Path $Candidate "the candidate path"))).Equals(
            (Normalize-Path $Parent "the parent path"), $PathComparison)
    } catch { return $false }
}

function Assert-ManagedInstallationContainer([string]$InstallBase, [string]$VersionsRoot) {
    $baseItem = Get-Item -LiteralPath $InstallBase -Force -ErrorAction Stop
    if (-not $baseItem.PSIsContainer -or ($baseItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail "the MultiVibe installation directory is unsafe"
    }
    foreach ($child in @(Get-ChildItem -LiteralPath $InstallBase -Force -ErrorAction Stop)) {
        if ($child.Name -ne "versions" -or -not $child.PSIsContainer -or
            ($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Fail "the MultiVibe installation directory contains an unmanaged entry"
        }
    }
    $versionsItem = Get-Item -LiteralPath $VersionsRoot -Force -ErrorAction Stop
    if (-not $versionsItem.PSIsContainer -or ($versionsItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail "the MultiVibe version directory is unsafe"
    }
    foreach ($child in @(Get-ChildItem -LiteralPath $VersionsRoot -Force -ErrorAction Stop)) {
        if (-not $child.PSIsContainer -or ($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            ($child.Name -notmatch '^(?:[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?|\.(?:install|rollback)-[0-9a-f]{32})$')) {
            Fail "the MultiVibe version directory contains an unmanaged entry"
        }
    }
}

function Assert-NoReparseTree([string]$Root, [string]$Description) {
    $item = Get-Item -LiteralPath $Root -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail "$Description is not a safe directory"
    }
    foreach ($child in @(Get-ChildItem -LiteralPath $Root -Force -Recurse -ErrorAction Stop)) {
        if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Fail "$Description contains a reparse point"
        }
    }
}

function Read-UserRegistryValue([string]$SubKey, [string]$Name) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey, $false)
    if ($null -eq $key) { return [pscustomobject]@{ Exists = $false; Value = $null } }
    try {
        $valueName = if ($Name -eq $ProtocolDefaultName) { "" } else { $Name }
        if (-not (@($key.GetValueNames()) -contains $valueName)) {
            return [pscustomobject]@{ Exists = $false; Value = $null }
        }
        return [pscustomobject]@{ Exists = $true; Value = $key.GetValue($valueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    } finally { $key.Close() }
}

function Remove-UserRegistryValue([string]$SubKey, [string]$Name) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey, $true)
    if ($null -eq $key) { return }
    try {
        $valueName = if ($Name -eq $ProtocolDefaultName) { "" } else { $Name }
        if (@($key.GetValueNames()) -contains $valueName) { $key.DeleteValue($valueName, $false) }
    } finally { $key.Close() }
}

function Remove-UserRegistryTree([string]$SubKey) {
    try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($SubKey, $false) } catch [ArgumentException] { }
}

function Get-ShortcutTarget([string]$Path) {
    $shell = New-Object -ComObject WScript.Shell
    try { return [string]$shell.CreateShortcut($Path).TargetPath }
    finally { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
}

function Get-ManagedTask([string]$VersionsRoot) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) { return $null }
    $actions = @($task.Actions)
    if ($actions.Count -ne 1) { Fail "the MultiVibe update task is not managed by MultiVibe Host" }
    $execute = ([string]$actions[0].Execute).Trim('"')
    if (-not (Test-PathWithin $execute $VersionsRoot) -or
        -not ([System.IO.Path]::GetFileName($execute)).Equals("multivibe-host-updater.exe", $PathComparison) -or
        ([string]$actions[0].Arguments).Trim() -ne "auto") {
        Fail "the MultiVibe update task is not managed by MultiVibe Host"
    }
    return $task
}

function Get-ManagedProcesses([string]$VersionsRoot) {
    $result = @()
    foreach ($name in $ManagedProcessNames) {
        foreach ($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
            $processPath = $null
            try { $processPath = $process.Path } catch { }
            if ([string]::IsNullOrWhiteSpace($processPath)) { continue }
            if ((Test-PathWithin $processPath $VersionsRoot) -and
                ([System.IO.Path]::GetFileName($processPath)).Equals("$name.exe", $PathComparison)) {
                $result += [pscustomobject]@{ Process = $process; Role = $name }
            }
        }
    }
    return $result
}

function Stop-ManagedProcesses([string]$VersionsRoot) {
    $processes = @(Get-ManagedProcesses $VersionsRoot)
    $stopOrder = @{
        "multivibe-host-menu" = 0
        "multivibe-host" = 1
        "node" = 2
        "multivibe-provider-agent" = 3
        "ollama" = 4
        "ollama_llama_server" = 5
        "llama-server" = 5
        "llama-quantize" = 6
        "multivibe-host-updater" = 7
    }
    foreach ($entry in @($processes | Sort-Object { $stopOrder[$_.Role] })) {
        Stop-Process -Id $entry.Process.Id -Force -ErrorAction Stop
    }
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (@(Get-ManagedProcesses $VersionsRoot).Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    }
    Fail "a managed MultiVibe Host process could not be stopped"
}

try {
    if (-not [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows) -or
        [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
        Fail "this uninstaller supports Windows amd64 only"
    }
    $localAppData = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($localAppData)) { $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData) }
    $localAppData = Normalize-Path $localAppData "LOCALAPPDATA"
    $appData = $env:APPDATA
    if ([string]::IsNullOrWhiteSpace($appData)) { $appData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData) }
    $appData = Normalize-Path $appData "APPDATA"
    $installBase = Join-Path $localAppData "Programs\MultiVibe Host"
    $versionsRoot = Join-Path $installBase "versions"
    $dataDirectory = Join-Path $localAppData "MultiVibe"
    $startMenuDirectory = Join-Path $appData "Microsoft\Windows\Start Menu\Programs"
    $shortcutPath = Join-Path $startMenuDirectory "MultiVibe Host.lnk"

    $state = Read-UserRegistryValue $StateSubKey "InstallDirectory"
    if (-not $state.Exists) {
        if (Test-Path -LiteralPath $installBase) {
            $children = @(Get-ChildItem -LiteralPath $installBase -Force)
            if ($children.Count -gt 0) { Fail "the MultiVibe installation directory is not managed by MultiVibe Host" }
            Remove-Item -LiteralPath $installBase -Force -ErrorAction Stop
        }
        Write-Output "MultiVibe Host is not installed; application data was preserved."
        exit 0
    }
    $installedRoot = Normalize-Path ([string]$state.Value) "the installed application directory"
    if (-not (Test-DirectChild $installedRoot $versionsRoot) -or -not (Test-Path -LiteralPath $installedRoot -PathType Container)) {
        Fail "the installed application directory is invalid"
    }
    Assert-NoReparseTree $installedRoot "the installed MultiVibe application"
    $node = Join-Path $installedRoot "bin\node.exe"
    $verifier = Join-Path $installedRoot "verify-provider-host.mjs"
    if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $verifier -PathType Leaf)) {
        Fail "the installed release verifier is unavailable"
    }
    & $node $verifier --directory $installedRoot *> $null
    if ($LASTEXITCODE -ne 0) { Fail "the installed application failed integrity verification; refusing automatic removal" }

    $version = [string](Read-UserRegistryValue $StateSubKey "Version").Value
    if ([string]::IsNullOrWhiteSpace($version)) { Fail "the installed application state is invalid" }
    $menuPath = Join-Path $installedRoot "bin\multivibe-host-menu.exe"
    $expectedRun = '"' + $menuPath + '"'
    $run = Read-UserRegistryValue $RunSubKey $RunValueName
    if ($run.Exists -and [string]$run.Value -ne $expectedRun) { Fail "the existing startup entry is not managed by MultiVibe Host" }
    $protocol = Read-UserRegistryValue $ProtocolSubKey $ProtocolDefaultName
    $urlProtocol = Read-UserRegistryValue $ProtocolSubKey "URL Protocol"
    $protocolCommand = Read-UserRegistryValue $ProtocolCommandSubKey $ProtocolDefaultName
    $expectedCommand = '"' + $menuPath + '" "%1"'
    if (($protocol.Exists -or $urlProtocol.Exists -or $protocolCommand.Exists) -and
        (-not $protocol.Exists -or [string]$protocol.Value -ne "MultiVibe Host Protocol" -or
         -not $urlProtocol.Exists -or [string]$urlProtocol.Value -ne "" -or
         -not $protocolCommand.Exists -or [string]$protocolCommand.Value -ne $expectedCommand)) {
        Fail "the existing multivibe:// registration is not managed by MultiVibe Host"
    }
    if (Test-Path -LiteralPath $shortcutPath) {
        $shortcutItem = Get-Item -LiteralPath $shortcutPath -Force
        if (($shortcutItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            -not (Normalize-Path (Get-ShortcutTarget $shortcutPath) "the shortcut target").Equals($menuPath, $PathComparison)) {
            Fail "the existing Start Menu shortcut is not managed by MultiVibe Host"
        }
    }
    $task = Get-ManagedTask $versionsRoot
    if ($null -ne $task -and $task.State -eq "Running") { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
    Stop-ManagedProcesses $versionsRoot

    if ($null -ne $task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop }
    if ($run.Exists) { Remove-UserRegistryValue $RunSubKey $RunValueName }
    if ($protocol.Exists -or $urlProtocol.Exists -or $protocolCommand.Exists) { Remove-UserRegistryTree $ProtocolSubKey }
    if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction Stop }
    Remove-UserRegistryTree $StateSubKey
    if (Test-Path -LiteralPath $installBase) {
        Assert-NoReparseTree $installBase "the MultiVibe installation"
        Assert-ManagedInstallationContainer $installBase $versionsRoot
        Remove-Item -LiteralPath $installBase -Recurse -Force -ErrorAction Stop
    }
    if ($Purge -and (Test-Path -LiteralPath $dataDirectory)) {
        Assert-NoReparseTree $dataDirectory "the MultiVibe application data"
        Remove-Item -LiteralPath $dataDirectory -Recurse -Force -ErrorAction Stop
        Write-Output "MultiVibe Host, its application data and its logs were removed."
    } else {
        Write-Output "MultiVibe Host was removed. Application data was preserved in $dataDirectory"
    }
} catch {
    Write-Error ("{0}: {1}" -f $ProgramName, $_.Exception.Message)
    exit 1
}
