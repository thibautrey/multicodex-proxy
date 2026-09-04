#Requires -Version 5.1

[CmdletBinding()]
param(
    [switch]$AutomaticUpdate,
    [string]$SourceDirectory,
    [int]$UpdaterProcessId = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgramName = "MultiVibe Host installer"
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
    if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate.IndexOf([char]0) -ge 0) {
        Fail "$Description is unavailable"
    }
    if (-not [System.IO.Path]::IsPathRooted($Candidate)) {
        Fail "$Description must be an absolute path"
    }
    try {
        $full = [System.IO.Path]::GetFullPath($Candidate)
    } catch {
        Fail "$Description is invalid"
    }
    while ($full.Length -gt 3 -and ($full.EndsWith("\") -or $full.EndsWith("/"))) {
        $full = $full.Substring(0, $full.Length - 1)
    }
    if ($full -match '[*?\[\]]') {
        Fail "$Description contains wildcard characters"
    }
    return $full
}

function Test-PathWithin([string]$Candidate, [string]$Parent) {
    try {
        $child = Normalize-Path $Candidate "the path"
        $root = Normalize-Path $Parent "the parent path"
    } catch {
        return $false
    }
    return $child.Equals($root, $PathComparison) -or $child.StartsWith($root + "\", $PathComparison)
}

function Test-DirectChild([string]$Candidate, [string]$Parent) {
    if (-not (Test-PathWithin $Candidate $Parent)) { return $false }
    try {
        $child = Normalize-Path $Candidate "the candidate path"
        $root = Normalize-Path $Parent "the parent path"
        return ([System.IO.Path]::GetDirectoryName($child)).Equals($root, $PathComparison)
    } catch {
        return $false
    }
}

function Assert-ManagedInstallationContainer([string]$InstallBase, [string]$VersionsRoot) {
    if (-not (Test-Path -LiteralPath $InstallBase)) { return }
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
    if (-not (Test-Path -LiteralPath $VersionsRoot)) { return }
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

function Get-RequiredDirectory([string]$Path, [string]$Description) {
    $normalized = Normalize-Path $Path $Description
    if (Test-Path -LiteralPath $normalized) {
        $item = Get-Item -LiteralPath $normalized -Force
        if (-not $item.PSIsContainer) { Fail "$Description is not a directory" }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Fail "$Description must not be a reparse point"
        }
    } else {
        New-Item -ItemType Directory -Path $normalized -Force | Out-Null
    }
    return $normalized
}

function Assert-NoReparseTree([string]$Root, [string]$Description) {
    $item = Get-Item -LiteralPath $Root -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail "$Description contains a reparse point"
    }
    if (-not $item.PSIsContainer) { Fail "$Description is not a directory" }
    foreach ($child in @(Get-ChildItem -LiteralPath $Root -Force -Recurse -ErrorAction Stop)) {
        if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Fail "$Description contains a reparse point"
        }
    }
}

function Set-PrivateAcl([string]$Path, [bool]$Directory) {
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) {
        [void]$acl.RemoveAccessRule($rule)
    }
    if ($Directory) {
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $accessRule = New-Object -TypeName System.Security.AccessControl.FileSystemAccessRule -ArgumentList @(
        ([System.Security.Principal.SecurityIdentifier]$CurrentUserSid),
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.SetOwner([System.Security.Principal.SecurityIdentifier]$CurrentUserSid)
    $acl.SetAccessRule($accessRule)
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}

function Assert-PrivateAcl([string]$Path, [bool]$Directory, [string]$Description) {
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if (-not $owner.Equals($CurrentUserSid, $PathComparison) -or -not $acl.AreAccessRulesProtected) {
        Fail "$Description does not have a protected current-user-only DACL"
    }
    $rules = @($acl.Access | Where-Object { -not $_.IsInherited })
    if ($rules.Count -ne 1) { Fail "$Description does not have a current-user-only DACL" }
    $rule = $rules[0]
    $identity = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if (-not $identity.Equals($CurrentUserSid, $PathComparison) -or
        $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
        $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
        Fail "$Description does not have a current-user-only DACL"
    }
    if ($Directory) {
        $requiredInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
        if (($rule.InheritanceFlags -band $requiredInheritance) -ne $requiredInheritance) {
            Fail "$Description has an invalid directory DACL"
        }
    } elseif ($rule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None) {
        Fail "$Description has an invalid file DACL"
    }
}

function Set-PrivateAclTree([string]$Root, [string]$Description) {
    Assert-NoReparseTree $Root $Description
    Set-PrivateAcl $Root $true
    foreach ($child in @(Get-ChildItem -LiteralPath $Root -Force -Recurse -ErrorAction Stop |
        Sort-Object { $_.FullName.Length })) {
        if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Fail "$Description contains a reparse point"
        }
        Set-PrivateAcl $child.FullName $child.PSIsContainer
    }
}

function Assert-PrivateAclTree([string]$Root, [string]$Description) {
    Assert-PrivateAcl $Root $true $Description
    foreach ($child in @(Get-ChildItem -LiteralPath $Root -Force -Recurse -ErrorAction Stop)) {
        Assert-PrivateAcl $child.FullName $child.PSIsContainer "$Description entry $($child.FullName)"
    }
}

function Copy-ReleaseTree([string]$Source, [string]$Destination) {
    foreach ($item in @(Get-ChildItem -LiteralPath $Source -Force -ErrorAction Stop)) {
        Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse -Force -ErrorAction Stop
    }
}

function Read-UserRegistryValue([string]$SubKey, [string]$Name) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey, $false)
    if ($null -eq $key) {
        return [pscustomobject]@{ Exists = $false; Value = $null }
    }
    try {
        $valueName = if ($Name -eq $ProtocolDefaultName) { "" } else { $Name }
        if (-not (@($key.GetValueNames()) -contains $valueName)) {
            return [pscustomobject]@{ Exists = $false; Value = $null }
        }
        return [pscustomobject]@{
            Exists = $true
            Value = $key.GetValue($valueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        }
    } finally {
        $key.Close()
    }
}

function Set-UserRegistryValue([string]$SubKey, [string]$Name, [string]$Value) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($SubKey)
    if ($null -eq $key) { Fail "the per-user registry key could not be created: $SubKey" }
    try {
        $valueName = if ($Name -eq $ProtocolDefaultName) { "" } else { $Name }
        $key.SetValue($valueName, $Value, [Microsoft.Win32.RegistryValueKind]::String)
    } finally {
        $key.Close()
    }
}

function Remove-UserRegistryValue([string]$SubKey, [string]$Name) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey, $true)
    if ($null -eq $key) { return }
    try {
        $valueName = if ($Name -eq $ProtocolDefaultName) { "" } else { $Name }
        if (@($key.GetValueNames()) -contains $valueName) { $key.DeleteValue($valueName, $false) }
    } finally {
        $key.Close()
    }
}

function Remove-UserRegistryTree([string]$SubKey) {
    $root = [Microsoft.Win32.Registry]::CurrentUser
    try { $root.DeleteSubKeyTree($SubKey, $false) } catch [ArgumentException] { }
}

function Snapshot-UserRegistry([string]$SubKey, [string[]]$Names) {
    return @($Names | ForEach-Object {
        $value = Read-UserRegistryValue $SubKey $_
        [pscustomobject]@{ SubKey = $SubKey; Name = $_; Exists = $value.Exists; Value = $value.Value }
    })
}

function Restore-UserRegistrySnapshot($Snapshots) {
    foreach ($snapshot in @($Snapshots)) {
        if ($snapshot.Exists) { Set-UserRegistryValue $snapshot.SubKey $snapshot.Name ([string]$snapshot.Value) }
        else { Remove-UserRegistryValue $snapshot.SubKey $snapshot.Name }
    }
}

function Get-Manifest([string]$Root) {
    $manifestPath = Join-Path $Root "manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { Fail "the release manifest is unavailable" }
    try { $manifest = Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop | ConvertFrom-Json } catch { Fail "the release manifest is invalid" }
    if ($manifest.product -ne "multivibe-host" -or $manifest.platform -ne "windows" -or
        $manifest.architecture -ne "amd64" -or $manifest.sourceTreeDirty -ne $false -or
        $manifest.releaseReady -ne $true -or $manifest.version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
        Fail "the release manifest is not a release-ready Windows amd64 bundle"
    }
    return $manifest
}

function Invoke-BundleVerifier([string]$Root, [switch]$RequireRuntime) {
    $node = Join-Path $Root "bin\node.exe"
    $verifier = Join-Path $Root "verify-provider-host.mjs"
    if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $verifier -PathType Leaf)) {
        Fail "the release verifier or bundled Node executable is unavailable"
    }
    $arguments = @($verifier, "--directory", $Root)
    if ($RequireRuntime) { $arguments += "--require-runtime" }
    & $node @arguments *> $null
    if ($LASTEXITCODE -ne 0) { Fail "the signed release verifier rejected the bundle or this host" }
}

function Invoke-HostInit([string]$Root) {
    & (Join-Path $Root "bin\multivibe-host.exe") "init" *> $null
    if ($LASTEXITCODE -ne 0) { Fail "the application state could not be initialized" }
}

function Test-HostHealth([string]$Root, [string]$Version) {
    $node = Join-Path $Root "bin\node.exe"
    $script = "fetch('http://127.0.0.1:'+(process.env.MULTIVIBE_HOST_PORT||'1455')+'/health').then(async response=>{const body=await response.json();if(!response.ok||body.version!==process.argv[1])process.exit(1)}).catch(()=>process.exit(1))"
    & $node --eval $script $Version *> $null
    return $LASTEXITCODE -eq 0
}

function Get-ManagedProcesses([string]$VersionsRoot, [switch]$IncludeUpdater, [int]$ExcludeProcessId = 0) {
    $result = @()
    foreach ($name in $ManagedProcessNames) {
        if (-not $IncludeUpdater -and $name -eq "multivibe-host-updater") { continue }
        foreach ($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
            if ($ExcludeProcessId -gt 0 -and $process.Id -eq $ExcludeProcessId) { continue }
            $processPath = $null
            try { $processPath = $process.Path } catch { }
            if ([string]::IsNullOrWhiteSpace($processPath)) { continue }
            $fileName = [System.IO.Path]::GetFileName($processPath)
            if ((Test-PathWithin $processPath $VersionsRoot) -and
                $fileName.Equals("$name.exe", $PathComparison)) {
                $result += [pscustomobject]@{ Process = $process; Role = $name; Path = $processPath }
            }
        }
    }
    return $result
}

function Stop-ManagedProcesses([string]$VersionsRoot, [switch]$IncludeUpdater, [int]$ExcludeProcessId = 0) {
    $processes = @(Get-ManagedProcesses $VersionsRoot -IncludeUpdater:$IncludeUpdater -ExcludeProcessId $ExcludeProcessId)
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
        if (@(Get-ManagedProcesses $VersionsRoot -IncludeUpdater:$IncludeUpdater -ExcludeProcessId $ExcludeProcessId).Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    }
    Fail "a managed MultiVibe Host process could not be stopped"
}

function Get-ManagedTask([string]$VersionsRoot) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) { return $null }
    $actions = @($task.Actions)
    if ($actions.Count -ne 1) { Fail "the existing MultiVibe update task is not managed by MultiVibe Host" }
    $execute = ([string]$actions[0].Execute).Trim('"')
    if (-not (Test-PathWithin $execute $VersionsRoot) -or
        -not ([System.IO.Path]::GetFileName($execute)).Equals("multivibe-host-updater.exe", $PathComparison) -or
        ([string]$actions[0].Arguments).Trim() -ne "auto") {
        Fail "the existing MultiVibe update task is not managed by MultiVibe Host"
    }
    return $task
}

function Export-ManagedTaskSnapshot($Task) {
    if ($null -eq $Task) { return $null }
    $xml = [string](Export-ScheduledTask -TaskName $TaskName -ErrorAction Stop)
    if ([string]::IsNullOrWhiteSpace($xml)) { Fail "the existing MultiVibe update task could not be backed up" }
    return [pscustomobject]@{
        Xml = $xml
        WasRunning = $Task.State -eq "Running"
    }
}

function Restore-ManagedTaskSnapshot($Snapshot, [string]$VersionsRoot) {
    $current = Get-ManagedTask $VersionsRoot
    if ($null -ne $current) {
        if ($current.State -eq "Running") { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    }
    if ($null -eq $Snapshot) {
        return
    }
    Register-ScheduledTask -TaskName $TaskName -Xml $Snapshot.Xml -Force -ErrorAction Stop | Out-Null
    if ($Snapshot.WasRunning) { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
}

function Register-ManagedTask([string]$Updater, [string]$WorkingDirectory) {
    $action = New-ScheduledTaskAction -Execute $Updater -Argument "auto" -WorkingDirectory $WorkingDirectory
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
}

function Get-ShortcutTarget([string]$Path) {
    $shell = New-Object -ComObject WScript.Shell
    try {
        $shortcut = $shell.CreateShortcut($Path)
        return [string]$shortcut.TargetPath
    } finally {
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
    }
}

function Write-Shortcut([string]$Path, [string]$Target, [string]$WorkingDirectory, [string]$Icon) {
    $shell = New-Object -ComObject WScript.Shell
    try {
        $shortcut = $shell.CreateShortcut($Path)
        $shortcut.TargetPath = $Target
        $shortcut.WorkingDirectory = $WorkingDirectory
        $shortcut.Description = "MultiVibe Host"
        $shortcut.IconLocation = "$Icon,0"
        $shortcut.Save()
    } finally {
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
    }
}

$stagingDirectory = $null
$shortcutStaging = $null

try {
    if (-not [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows) -or
        [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
        Fail "this installer supports Windows amd64 only"
    }
    if ($UpdaterProcessId -lt 0) { Fail "the updater process identifier is invalid" }
    $localAppData = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($localAppData)) { $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData) }
    $localAppData = Normalize-Path $localAppData "LOCALAPPDATA"
    $appData = $env:APPDATA
    if ([string]::IsNullOrWhiteSpace($appData)) { $appData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData) }
    $appData = Normalize-Path $appData "APPDATA"
    $installBase = Join-Path $localAppData "Programs\MultiVibe Host"
    $versionsRoot = Join-Path $installBase "versions"
    $startMenuDirectory = Get-RequiredDirectory (Join-Path $appData "Microsoft\Windows\Start Menu\Programs") "the per-user Start Menu directory"
    $shortcutPath = Join-Path $startMenuDirectory "MultiVibe Host.lnk"

    $sourceRoot = if ([string]::IsNullOrWhiteSpace($SourceDirectory)) { $PSScriptRoot } else { $SourceDirectory }
    $sourceRoot = Normalize-Path $sourceRoot "the release directory"
    if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) { Fail "the release directory is unavailable" }
    Assert-NoReparseTree $sourceRoot "the release directory"
    if (Test-PathWithin $sourceRoot $installBase) { Fail "the release directory cannot be inside the installation directory" }
    $manifest = Get-Manifest $sourceRoot
    $version = [string]$manifest.version
    Invoke-BundleVerifier $sourceRoot -RequireRuntime

    if (Test-Path -LiteralPath $installBase) {
        $baseItem = Get-Item -LiteralPath $installBase -Force
        if (-not $baseItem.PSIsContainer -or ($baseItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Fail "the MultiVibe installation directory is unsafe"
        }
        Assert-NoReparseTree $installBase "the existing MultiVibe installation directory"
        Assert-ManagedInstallationContainer $installBase $versionsRoot
    }
    $stateKey = Read-UserRegistryValue $StateSubKey "InstallDirectory"
    $oldRoot = $null
    $oldVersion = $null
    $stateExists = $stateKey.Exists
    if ($stateExists) {
        $oldRoot = Normalize-Path ([string]$stateKey.Value) "the existing installation directory"
        if (-not (Test-DirectChild $oldRoot $versionsRoot) -or -not (Test-Path -LiteralPath $oldRoot -PathType Container)) {
            Fail "the existing MultiVibe installation directory is invalid"
        }
        $oldVersion = [string](Read-UserRegistryValue $StateSubKey "Version").Value
        if ([string]::IsNullOrWhiteSpace($oldVersion) -or
            -not ([System.IO.Path]::GetFileName($oldRoot)).Equals($oldVersion, $PathComparison)) {
            Fail "the existing MultiVibe installation state is invalid"
        }
        Assert-NoReparseTree $oldRoot "the existing MultiVibe installation"
        Invoke-BundleVerifier $oldRoot
    } elseif (Test-Path -LiteralPath $installBase) {
        if (@(Get-ChildItem -LiteralPath $installBase -Force).Count -gt 0) {
            Fail "the existing MultiVibe installation directory is not managed by MultiVibe Host"
        }
    }

    $menuPath = Join-Path (Join-Path $versionsRoot $version) "bin\multivibe-host-menu.exe"
    $hostPath = Join-Path (Join-Path $versionsRoot $version) "bin\multivibe-host.exe"
    $updaterPath = Join-Path (Join-Path $versionsRoot $version) "bin\multivibe-host-updater.exe"
    $iconPath = Join-Path (Join-Path $versionsRoot $version) "resources\provider\multivibe-host.ico"
    $versionRoot = Join-Path $versionsRoot $version
    if ($AutomaticUpdate -and $stateExists -and $oldRoot.Equals($versionRoot, $PathComparison)) {
        Fail "automatic updates cannot reinstall the same version while the updater is running"
    }
    $stagingDirectory = Join-Path $versionsRoot (".install-" + [guid]::NewGuid().ToString("N"))
    $backupDirectory = Join-Path $versionsRoot (".rollback-" + [guid]::NewGuid().ToString("N"))
    $shortcutStaging = Join-Path $startMenuDirectory (".MultiVibe Host." + [guid]::NewGuid().ToString("N") + ".lnk")
    $shortcutBackup = Join-Path $startMenuDirectory (".MultiVibe Host.previous." + [guid]::NewGuid().ToString("N") + ".lnk")

    $runSnapshot = Snapshot-UserRegistry $RunSubKey @($RunValueName)
    $stateSnapshots = Snapshot-UserRegistry $StateSubKey @("Version", "InstallDirectory", "HostPath", "MenuPath", "UpdaterPath", "IconPath")
    $protocolSnapshots = Snapshot-UserRegistry $ProtocolSubKey @($ProtocolDefaultName, "URL Protocol")
    $commandSnapshots = Snapshot-UserRegistry $ProtocolCommandSubKey @($ProtocolDefaultName)
    $existingRun = $runSnapshot[0]
    if ($existingRun.Exists -and $stateExists -and ([string]$existingRun.Value) -ne ('"' + (Join-Path $oldRoot "bin\multivibe-host-menu.exe") + '"')) {
        Fail "the existing MultiVibe startup entry is not managed by MultiVibe Host"
    } elseif ($existingRun.Exists -and -not $stateExists) {
        Fail "the existing MultiVibe startup entry is not managed by MultiVibe Host"
    }
    if ($protocolSnapshots[0].Exists -or $protocolSnapshots[1].Exists -or $commandSnapshots[0].Exists) {
        $expectedCommand = if ($stateExists) { '"' + (Join-Path $oldRoot "bin\multivibe-host-menu.exe") + '" "%1"' } else { $null }
        if (-not $stateExists -or [string]$protocolSnapshots[0].Value -ne "MultiVibe Host Protocol" -or
            [string]$protocolSnapshots[1].Value -ne "" -or [string]$commandSnapshots[0].Value -ne $expectedCommand) {
            Fail "the existing multivibe:// protocol registration is not managed by MultiVibe Host"
        }
    }
    if (Test-Path -LiteralPath $shortcutPath) {
        $shortcutItem = Get-Item -LiteralPath $shortcutPath -Force
        if (($shortcutItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $stateExists) {
            Fail "the existing MultiVibe Start Menu shortcut is not managed by MultiVibe Host"
        }
        $oldShortcutTarget = Normalize-Path (Get-ShortcutTarget $shortcutPath) "the existing shortcut target"
        if (-not $oldShortcutTarget.Equals((Join-Path $oldRoot "bin\multivibe-host-menu.exe"), $PathComparison)) {
            Fail "the existing MultiVibe Start Menu shortcut is not managed by MultiVibe Host"
        }
    }
    $existingTask = Get-ManagedTask $versionsRoot
    $taskSnapshot = Export-ManagedTaskSnapshot $existingTask
    $processExclusion = if ($AutomaticUpdate) { $UpdaterProcessId } else { 0 }
    if ($null -ne $existingTask -and -not $stateExists) { Fail "the existing MultiVibe update task is not managed by MultiVibe Host" }
    $oldMenuRunning = @(Get-ManagedProcesses $versionsRoot | Where-Object { $_.Role -eq "multivibe-host-menu" }).Count -gt 0
    $oldHostRunning = @(Get-ManagedProcesses $versionsRoot | Where-Object { $_.Role -eq "multivibe-host" }).Count -gt 0

    Get-RequiredDirectory $installBase "the per-user MultiVibe Programs directory" | Out-Null
    Get-RequiredDirectory $versionsRoot "the MultiVibe version directory" | Out-Null
    Set-PrivateAcl $installBase $true
    Set-PrivateAcl $versionsRoot $true
    Assert-PrivateAcl $installBase $true "the per-user MultiVibe Programs directory"
    Assert-PrivateAcl $versionsRoot $true "the MultiVibe version directory"
    New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null
    Set-PrivateAclTree $stagingDirectory "the staged MultiVibe installation"
    Copy-ReleaseTree $sourceRoot $stagingDirectory
    Assert-NoReparseTree $stagingDirectory "the staged MultiVibe installation"
    Set-PrivateAclTree $stagingDirectory "the staged MultiVibe installation"
    Assert-PrivateAclTree $stagingDirectory "the staged MultiVibe installation"
    Invoke-BundleVerifier $stagingDirectory -RequireRuntime

    $taskChanged = $false
    $versionCommitted = $false
    $backupMoved = $false
    $shortcutCommitted = $false
    $registryCreatedState = -not (Test-Path -LiteralPath ("Registry::HKEY_CURRENT_USER\" + $StateSubKey))
    $registryCreatedProtocol = -not (Test-Path -LiteralPath ("Registry::HKEY_CURRENT_USER\" + $ProtocolSubKey))
    $installSucceeded = $false
    try {
        Invoke-HostInit $stagingDirectory
        if ($null -ne $existingTask) {
            $taskChanged = $true
            if (-not $AutomaticUpdate -and $existingTask.State -eq "Running") { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
            Disable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
        }
        Stop-ManagedProcesses $versionsRoot -IncludeUpdater:$true -ExcludeProcessId $processExclusion
        if (Test-Path -LiteralPath $versionRoot) {
            $existingVersionItem = Get-Item -LiteralPath $versionRoot -Force
            if (-not $existingVersionItem.PSIsContainer -or ($existingVersionItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                Fail "the target version directory is unsafe"
            }
            Move-Item -LiteralPath $versionRoot -Destination $backupDirectory -Force -ErrorAction Stop
            $backupMoved = $true
        }
        Move-Item -LiteralPath $stagingDirectory -Destination $versionRoot -ErrorAction Stop
        $versionCommitted = $true
        Set-PrivateAclTree $versionRoot "the installed MultiVibe version"
        Assert-PrivateAclTree $versionRoot "the installed MultiVibe version"

        Set-UserRegistryValue $RunSubKey $RunValueName ('"' + $menuPath + '"')
        Set-UserRegistryValue $StateSubKey "Version" $version
        Set-UserRegistryValue $StateSubKey "InstallDirectory" $versionRoot
        Set-UserRegistryValue $StateSubKey "HostPath" $hostPath
        Set-UserRegistryValue $StateSubKey "MenuPath" $menuPath
        Set-UserRegistryValue $StateSubKey "UpdaterPath" $updaterPath
        Set-UserRegistryValue $StateSubKey "IconPath" $iconPath
        Set-UserRegistryValue $ProtocolSubKey $ProtocolDefaultName "MultiVibe Host Protocol"
        Set-UserRegistryValue $ProtocolSubKey "URL Protocol" ""
        Set-UserRegistryValue $ProtocolCommandSubKey $ProtocolDefaultName ('"' + $menuPath + '" "%1"')
        $taskChanged = $true
        Register-ManagedTask $updaterPath $versionRoot

        if (Test-Path -LiteralPath $shortcutPath) {
            Move-Item -LiteralPath $shortcutPath -Destination $shortcutBackup -Force -ErrorAction Stop
        }
        Write-Shortcut $shortcutStaging $menuPath $versionRoot $iconPath
        Move-Item -LiteralPath $shortcutStaging -Destination $shortcutPath -ErrorAction Stop
        $shortcutCommitted = $true

        Start-Process -FilePath $menuPath -WorkingDirectory $versionRoot | Out-Null
        $healthReady = $false
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            if (Test-HostHealth $versionRoot $version) { $healthReady = $true; break }
            Start-Sleep -Seconds 2
        }
        if (-not $healthReady) { Fail "the updated MultiVibe Host did not pass its post-start health check" }
        $installSucceeded = $true
    } catch {
        $installationError = $_
        $rollbackErrors = New-Object 'System.Collections.Generic.List[string]'
        try { Stop-ManagedProcesses $versionsRoot -IncludeUpdater:$true -ExcludeProcessId $processExclusion } catch { [void]$rollbackErrors.Add("managed processes could not be stopped") }
        if ($shortcutCommitted) {
            try { Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction Stop } catch { [void]$rollbackErrors.Add("the new Start Menu shortcut could not be removed") }
        }
        if ($versionCommitted) {
            try { Remove-Item -LiteralPath $versionRoot -Recurse -Force -ErrorAction Stop } catch { [void]$rollbackErrors.Add("the new application directory could not be removed") }
        }
        if ($backupMoved -and (Test-Path -LiteralPath $backupDirectory)) {
            try { Move-Item -LiteralPath $backupDirectory -Destination $versionRoot -Force -ErrorAction Stop } catch { [void]$rollbackErrors.Add("the previous application directory could not be restored") }
        }
        if (Test-Path -LiteralPath $shortcutBackup) {
            try { Move-Item -LiteralPath $shortcutBackup -Destination $shortcutPath -Force -ErrorAction Stop } catch { [void]$rollbackErrors.Add("the previous Start Menu shortcut could not be restored") }
        }
        if ($taskChanged) {
            try { Restore-ManagedTaskSnapshot $taskSnapshot $versionsRoot } catch { [void]$rollbackErrors.Add("the previous scheduled-task registration could not be restored") }
        }
        try {
            Restore-UserRegistrySnapshot $commandSnapshots
            Restore-UserRegistrySnapshot $protocolSnapshots
            Restore-UserRegistrySnapshot $stateSnapshots
            Restore-UserRegistrySnapshot $runSnapshot
        } catch { [void]$rollbackErrors.Add("the previous per-user registry state could not be restored") }
        if ($registryCreatedProtocol) { try { Remove-UserRegistryTree $ProtocolSubKey } catch { [void]$rollbackErrors.Add("the temporary protocol registry key could not be removed") } }
        if ($registryCreatedState) { try { Remove-UserRegistryTree $StateSubKey } catch { [void]$rollbackErrors.Add("the temporary state registry key could not be removed") } }
        if ($oldMenuRunning -and (Test-Path -LiteralPath (Join-Path $oldRoot "bin\multivibe-host-menu.exe"))) {
            try { Start-Process -FilePath (Join-Path $oldRoot "bin\multivibe-host-menu.exe") -WorkingDirectory $oldRoot | Out-Null } catch { [void]$rollbackErrors.Add("the previous Host menu could not be restarted") }
        } elseif ($oldHostRunning -and (Test-Path -LiteralPath (Join-Path $oldRoot "bin\multivibe-host.exe"))) {
            try { Start-Process -FilePath (Join-Path $oldRoot "bin\multivibe-host.exe") -ArgumentList "run" -WorkingDirectory $oldRoot | Out-Null } catch { [void]$rollbackErrors.Add("the previous Host could not be restarted") }
        }
        if ($rollbackErrors.Count -gt 0) {
            throw "$ProgramName`: installation failed and rollback was incomplete: $($rollbackErrors -join '; '). Original error: $($installationError.Exception.Message)"
        }
        throw $installationError
    } finally {
        if (Test-Path -LiteralPath $stagingDirectory) { Remove-Item -LiteralPath $stagingDirectory -Recurse -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $shortcutStaging) { Remove-Item -LiteralPath $shortcutStaging -Force -ErrorAction SilentlyContinue }
        if ($installSucceeded -and (Test-Path -LiteralPath $shortcutBackup)) { Remove-Item -LiteralPath $shortcutBackup -Force -ErrorAction SilentlyContinue }
    }
    Write-Output "MultiVibe Host $version is installed and running from $versionRoot"
} catch {
    if ($null -ne $stagingDirectory -and (Test-Path -LiteralPath $stagingDirectory)) {
        Remove-Item -LiteralPath $stagingDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $shortcutStaging -and (Test-Path -LiteralPath $shortcutStaging)) {
        Remove-Item -LiteralPath $shortcutStaging -Force -ErrorAction SilentlyContinue
    }
    Write-Error ("{0}: {1}" -f $ProgramName, $_.Exception.Message)
    exit 1
}
