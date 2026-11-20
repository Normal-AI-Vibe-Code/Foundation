#requires -Version 7.0
<#
Run in PowerShell 7 on the host, from Foundation. Diagnose changes nothing.
RepairWsl enables missing WSL prerequisites and updates WSL; never unregisters
a distribution, deletes a disk, shuts down running distributions, or reboots.
BuildIso runs upstream's Docker builder. StartVm boots the ISO in native QEMU.
All changing actions support -WhatIf. See docs/wildos.md.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('Diagnose', 'RepairWsl', 'BuildIso', 'StartVm')]
    [string]$Action = 'Diagnose',
    [string]$Checkout = (Join-Path $PSScriptRoot '../work/wildos/source'),
    [string]$Iso,
    [switch]$Installed,
    [ValidateRange(4, 64)][int]$MemoryGB = 8,
    [ValidateRange(1, 16)][int]$Cpus = 4,
    [switch]$Software
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$projectRoot = Split-Path $PSScriptRoot -Parent

function Find-Tool([string]$Name, [string[]]$Candidates = @()) {
    $cmd = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    foreach ($candidate in $Candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

# WSL can hang before it has a distribution. Bound diagnostics and preserve
# the exit code and UTF-16 text; a denied query is unknown, never 'not installed'.
function Read-Native([string]$File, [string[]]$Arguments, [int]$TimeoutSeconds = 20) {
    if (-not $File) { return '[command not found]' }
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $File
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($arg in $Arguments) { $start.ArgumentList.Add($arg) }
    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $start
    try {
        [void]$proc.Start()
        $stdout = $proc.StandardOutput.ReadToEndAsync()
        $stderr = $proc.StandardError.ReadToEndAsync()
        if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
            $proc.Kill($true)
            return "[timed out after ${TimeoutSeconds}s; this diagnostic process was stopped]"
        }
        $result = (($stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult()) -replace "`0", '').Trim()
        return "exit $($proc.ExitCode)`n$result"
    } catch { return "[query failed: $($_.Exception.Message)]" }
    finally { $proc.Dispose() }
}

function Invoke-Checked([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed (exit $LASTEXITCODE). Read the error above before continuing." }
}

function Is-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not $IsWindows) { throw 'This helper is for the Windows host. Use WildOS build-iso.sh on Linux/macOS.' }
$wsl = Find-Tool 'wsl.exe'
$docker = Find-Tool 'docker.exe' @(
    "$env:ProgramFiles/Docker/Docker/resources/bin/docker.exe",
    "$env:LOCALAPPDATA/Programs/DockerDesktop/resources/bin/docker.exe"
)
$qemu = Find-Tool 'qemu-system-x86_64.exe' @("$env:ProgramFiles/qemu/qemu-system-x86_64.exe")

switch ($Action) {
    'Diagnose' {
        Write-Output "Foundation / WildOS host diagnostics (read only)`nPowerShell: $($PSVersionTable.PSVersion)`nElevated: $(Is-Admin)"
        Write-Output "`n--- WSL version ---`n$(Read-Native $wsl @('--version'))"
        Write-Output "`n--- WSL status ---`n$(Read-Native $wsl @('--status'))"
        Write-Output "`n--- WSL distributions ---`n$(Read-Native $wsl @('--list', '--verbose'))"
        Write-Output "`n--- Windows / virtualization ---"
        try {
            Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber | Format-List
            Get-CimInstance Win32_ComputerSystem | Select-Object HypervisorPresent, TotalPhysicalMemory | Format-List
            Get-CimInstance Win32_Processor | Select-Object Name, VirtualizationFirmwareEnabled, SecondLevelAddressTranslationExtensions | Format-List
        } catch { Write-Output "Unknown: $($_.Exception.Message)" }
        Write-Output "`n--- Services ---"
        foreach ($name in @('WslService', 'LxssManager', 'vmcompute', 'com.docker.service', 'LanmanServer')) {
            try { Get-Service -Name $name -ErrorAction Stop | Select-Object Name, Status, StartType | Format-Table }
            catch { Write-Output "${name}: unavailable ($($_.Exception.Message))" }
        }
        Write-Output "`n--- Windows features (requires administrator) ---"
        foreach ($name in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform', 'HypervisorPlatform')) {
            try { Get-WindowsOptionalFeature -Online -FeatureName $name | Select-Object FeatureName, State | Format-Table }
            catch { Write-Output "${name}: unknown ($($_.Exception.Message))" }
        }
        Write-Output "`n--- Hypervisor boot setting (requires administrator) ---`n$(Read-Native (Find-Tool 'bcdedit.exe') @('/enum', '{current}'))"
        Write-Output "`n--- Docker ---`nCLI: $docker`n$(Read-Native $docker @('version'))"
        Write-Output "`n--- Docker context ---`n$(Read-Native $docker @('context', 'show'))"
        Write-Output "`n--- Kiri ---"
        Write-Output (Read-Native (Find-Tool 'node.exe') @((Join-Path $PSScriptRoot 'kiri.mjs'), 'status'))
        Write-Output "`nQEMU: $qemu`nIf a query says access denied, its state is UNKNOWN. Run this in host PowerShell, outside an agent sandbox."
    }
    'RepairWsl' {
        if (-not $PSCmdlet.ShouldProcess('Windows WSL prerequisites and installed WSL', 'Enable missing features, start its service, update WSL and select version 2')) { return }
        if (-not (Is-Admin)) { throw 'Open PowerShell 7 as Administrator for RepairWsl. Diagnose works without elevation.' }
        $restart = $false
        foreach ($name in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
            $feature = Get-WindowsOptionalFeature -Online -FeatureName $name
            if ($feature.State -eq 'EnablePending') { $restart = $true; continue }
            if ($feature.State -ne 'Enabled') {
                $enabled = Enable-WindowsOptionalFeature -Online -FeatureName $name -All -NoRestart
                if ($enabled.RestartNeeded) { $restart = $true }
            }
        }
        if ($restart) { Write-Output 'Windows needs a restart. Save your work, restart yourself, then run RepairWsl again.'; return }
        if (-not $wsl) { throw 'WSL executable is unavailable. Install WSL from Microsoft, restart if requested, and run Diagnose again.' }
        $boot = Read-Native (Find-Tool 'bcdedit.exe') @('/enum', '{current}')
        if ($boot -match '(?im)^hypervisorlaunchtype\s+Off\s*$') {
            Write-Output 'The Windows hypervisor is disabled at boot. Run bcdedit /set hypervisorlaunchtype auto as Administrator, then restart and run Diagnose again.'
            return
        }
        Invoke-Checked $wsl @('--update', '--web-download')
        Invoke-Checked $wsl @('--set-default-version', '2')
        foreach ($name in @('WslService', 'LxssManager')) {
            $service = Get-Service $name -ErrorAction SilentlyContinue
            if ($service -and $service.Status -eq 'Stopped') { Start-Service $name }
        }
        Invoke-Checked $wsl @('--status')
        Write-Output 'Run Diagnose again. This does not test booting a distribution or reset any data. Firmware virtualization must also be enabled; the helper cannot change BIOS settings.'
    }
    'BuildIso' {
        # Use upstream's Windows entry point, not a reconstructed Docker recipe.
        # Its privileged builder is kept OUTSIDE Foundation's ordinary machines.
        if (-not $PSCmdlet.ShouldProcess($Checkout, 'Clone WildOS if absent and execute its privileged Docker ISO builder')) { return }
        if (-not $docker) { throw 'Docker CLI missing. Start/install Docker Desktop from Docker, then rerun Diagnose. Kiri alone is not verified for the privileged ISO builder.' }
        Invoke-Checked $docker @('info', '--format', '{{.OSType}}')
        $os = Read-Native $docker @('info', '--format', '{{.OSType}}')
        if ($os -notmatch '(?m)^linux\s*$') { throw 'Docker must be serving Linux containers. Read Diagnose before building.' }
        $git = Find-Tool 'git.exe'
        if (-not $git) { throw 'Git is required to fetch WildOS.' }
        if (-not (Test-Path -LiteralPath $Checkout)) {
            New-Item -ItemType Directory -Path (Split-Path ([IO.Path]::GetFullPath($Checkout)) -Parent) -Force | Out-Null
            Invoke-Checked $git @('clone', '--', 'https://github.com/wildorigins/wildos.git', $Checkout)
        }
        $entry = Join-Path $Checkout 'build-iso.ps1'
        if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw "No upstream build-iso.ps1 in $Checkout. Existing folders are never overwritten." }
        Invoke-Checked $git @('-C', $Checkout, 'rev-parse', 'HEAD')
        $oldPath = $env:PATH
        try {
            $env:PATH = "$(Split-Path $docker -Parent);$oldPath"
            Invoke-Checked (Find-Tool 'pwsh.exe') @('-NoProfile', '-File', $entry)
        } finally { $env:PATH = $oldPath }
        $images = @(Get-ChildItem -LiteralPath (Join-Path $Checkout 'out') -Filter '*.iso' -File)
        if (-not $images.Count) { throw 'The builder returned success but no ISO was found in out/. Read the build log.' }
        $images | Select-Object FullName, Length | Format-Table
        Write-Output 'ISO built. It is not a running desktop. Use StartVm with the ISO path.'
    }
    'StartVm' {
        # Native QEMU avoids depending on a working WSL installation. No nested
        # virtualization, forwarded ports, shared folders, or raw host disks.
        $disk = Join-Path $projectRoot 'work/wildos/wildos.qcow2'
        if (-not $PSCmdlet.ShouldProcess($disk, 'Create a 64 GB sparse VM disk if absent and boot WildOS in QEMU')) { return }
        if (-not $qemu) { throw 'Install QEMU from https://www.qemu.org/download/#windows first. QEMU is not downloaded or installed by this helper.' }
        $bootArgs = @('-boot', 'order=c,menu=on')
        if ($Installed) {
            if (-not (Test-Path -LiteralPath $disk -PathType Leaf)) { throw 'No VM disk exists yet. Boot an ISO and install WildOS first.' }
        } else {
            if (-not $Iso -or -not (Test-Path -LiteralPath $Iso -PathType Leaf)) { throw 'Supply -Iso with a downloaded, verified or locally built WildOS ISO.' }
            $isoPath = (Resolve-Path -LiteralPath $Iso).Path
            if ([IO.Path]::GetExtension($isoPath) -ne '.iso') { throw 'The boot image must be an .iso file.' }
            if ($isoPath.Contains(',')) { throw 'QEMU ISO paths must not contain commas.' }
            $bootArgs = @('-cdrom', $isoPath, '-boot', 'order=c,once=d,menu=on')
        }
        if ($disk.Contains(',')) { throw 'The Foundation checkout path must not contain commas.' }
        $imageTool = Join-Path (Split-Path $qemu -Parent) 'qemu-img.exe'
        if (-not (Test-Path -LiteralPath $imageTool)) { throw "Missing $imageTool" }
        New-Item -ItemType Directory -Path (Split-Path $disk -Parent) -Force | Out-Null
        if (-not (Test-Path -LiteralPath $disk)) { Invoke-Checked $imageTool @('create', '-f', 'qcow2', $disk, '64G') }
        $accel = if ($Software) { 'tcg' } else { 'whpx' }
        Write-Output "Starting WildOS ($accel). The VM disk is $disk. Shut down inside WildOS to stop safely."
        Write-Output 'Choose Try WildOS for a live session. Installing writes only the VM disk; live-session changes otherwise disappear. This native window is not yet embedded in Foundation.'
        $vmArgs = @(
            '-name', 'WildOS', '-machine', 'q35', '-accel', $accel,
            '-m', "$($MemoryGB * 1024)", '-smp', "$Cpus",
            '-drive', "file=$disk,format=qcow2,if=virtio",
            '-vga', 'std', '-device', 'qemu-xhci', '-device', 'usb-tablet',
            '-nic', 'user,model=virtio-net-pci', '-rtc', 'base=utc', '-monitor', 'none'
        )
        Invoke-Checked $qemu ($vmArgs + $bootArgs)
    }
}
