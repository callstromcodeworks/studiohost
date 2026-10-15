# Downloads the Node.js runtime that Studio Host bundles into data\node\ (Windows x64).
# The version comes from build-aux\node-version; the download is verified against the
# SHASUMS256.txt published alongside the release on nodejs.org.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSScriptRoot
$Version = (Get-Content -Path (Join-Path $Root 'build-aux/node-version') -Raw).Trim()
$Base = "https://nodejs.org/dist/v$Version"
$Name = "node-v$Version-win-x64.zip"
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
$Out = Join-Path $Root 'data/node'

New-Item -ItemType Directory -Path $Work | Out-Null
try {
    Invoke-WebRequest -Uri "$Base/SHASUMS256.txt" -OutFile (Join-Path $Work 'SHASUMS256.txt')
    Invoke-WebRequest -Uri "$Base/$Name" -OutFile (Join-Path $Work $Name)

    $Expected = (Get-Content (Join-Path $Work 'SHASUMS256.txt') |
        Where-Object { $_ -match "^\S+\s+$([regex]::Escape($Name))$" } |
        ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
    $Actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Work $Name)).Hash.ToLower()
    if (-not $Expected -or $Expected -ne $Actual) { throw "Checksum mismatch for $Name" }

    Expand-Archive -Path (Join-Path $Work $Name) -DestinationPath $Work
    if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
    New-Item -ItemType Directory -Path $Out | Out-Null
    Copy-Item (Join-Path $Work "node-v$Version-win-x64/node.exe") $Out
    Copy-Item (Join-Path $Work "node-v$Version-win-x64/LICENSE") $Out
    Write-Output "Node.js v$Version for win-x64 -> $Out"
    & (Join-Path $Out 'node.exe') --version
} finally {
    Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
