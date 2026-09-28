# DevEye agent installer for Windows: downloads the agent built for this
# machine, then links it to the server that served this script.
#
#   & ([scriptblock]::Create((irm '<server>/install.ps1'))) <CODE> [link options]
#
# The options after the code go to `deveye-agent link` (see its --help):
# --autostart, --deny 'terminal,power' (quoted: a comma makes an array in
# PowerShell), --monitor-only, --shuffle-id, --name. Without a code,
# DEVEYE_LINK_CODE is used. From an administrator PowerShell, the agent goes
# to Program Files and a system task; otherwise to the user's AppData.
#
# Everything runs from Install-DevEyeAgent, called on the last line: a
# download cut short runs nothing.

function Install-DevEyeAgent([string[]] $Arguments) {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $server = '__DEVEYE_SERVER__'

    $linkArgs = @($Arguments | Where-Object { $_ })
    $code = $env:DEVEYE_LINK_CODE
    if ($linkArgs.Count -gt 0 -and -not $linkArgs[0].StartsWith('-')) {
        $code = $linkArgs[0]
        $linkArgs = @($linkArgs | Select-Object -Skip 1)
    }
    if (-not $code) {
        throw "No link code: & ([scriptblock]::Create((irm '$server/install.ps1'))) <CODE>"
    }

    # Win32_Processor tells the processor itself: PROCESSOR_ARCHITECTURE tells
    # the process, wrong for a 32-bit PowerShell or an emulated one on ARM64.
    $arch = (Get-CimInstance Win32_Processor | Select-Object -First 1).Architecture
    $target = switch ($arch) {
        9 { 'windows-x86_64' }
        12 { 'windows-arm64' }
        0 { 'windows-x86' }
        default { throw "Unsupported processor (architecture $arch)" }
    }

    $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    $admin = $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    # A system task runs as SYSTEM: its binary must sit where only
    # administrators write.
    $dir = if ($admin) { Join-Path $env:ProgramFiles 'DevEye' } else { Join-Path $env:LOCALAPPDATA 'Programs\DevEye' }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $dest = Join-Path $dir 'deveye-agent.exe'
    $staged = Join-Path $dir ".deveye-agent.$PID.exe"

    Write-Host "Downloading the DevEye agent ($target)..."
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$server/api/agent/install/$target" `
            -Headers @{ 'X-DevEye-Link-Code' = $code } -OutFile $staged
    } catch {
        Remove-Item -Force -ErrorAction SilentlyContinue $staged
        $status = 0
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        switch ($status) {
            401 { throw 'The link code is invalid, expired or used up: generate a new one in DevEye.' }
            404 { throw "This server has no agent for $target yet." }
            429 { throw 'Too many attempts from this address: try again in a few minutes.' }
            default { throw "Download failed: $($_.Exception.Message)" }
        }
    }
    & $staged --version | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -Force -ErrorAction SilentlyContinue $staged
        throw "The downloaded agent does not run on this machine ($target)."
    }
    # A running agent locks its file but lets it be moved: aside as `.old`,
    # which the agent removes when it next starts.
    if (Test-Path $dest) {
        $old = Join-Path $dir 'deveye-agent.old'
        Remove-Item -Force -ErrorAction SilentlyContinue $old
        Move-Item $dest $old
    }
    Move-Item $staged $dest
    Write-Host "Installed $dest"

    $scope = if ($admin) { 'Machine' } else { 'User' }
    $path = [Environment]::GetEnvironmentVariable('Path', $scope)
    if (($path -split ';') -notcontains $dir) {
        [Environment]::SetEnvironmentVariable('Path', "$path;$dir", $scope)
        Write-Host "Added $dir to the PATH of new terminals."
    }

    if (-not ($linkArgs | Where-Object { $_ -eq '--server' -or $_ -like '--server=*' })) {
        $linkArgs = @('--server', $server) + $linkArgs
    }
    # Through the environment rather than the command line, which every user
    # of the machine can read.
    $env:DEVEYE_LINK_CODE = $code
    try {
        & $dest link @linkArgs
        $exit = $LASTEXITCODE
    } finally {
        Remove-Item Env:DEVEYE_LINK_CODE -ErrorAction SilentlyContinue
    }
    if ($exit -ne 0) { throw "deveye-agent link failed (exit code $exit)." }
}

Install-DevEyeAgent -Arguments $args
