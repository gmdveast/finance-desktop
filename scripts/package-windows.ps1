param(
  [ValidateSet('x64')]
  [string]$Architecture = 'x64',
  [string]$ReleaseDirectory = '',
  [string]$NodeVersion = '24.15.0',
  [string]$AppVersion = '',
  [string]$UpdateChannel = '',
  [string]$InnoCompilerPath = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $ReleaseDirectory) { $ReleaseDirectory = ".release\windows-$Architecture" }
if ([IO.Path]::IsPathRooted($ReleaseDirectory)) {
  $releaseRoot = [IO.Path]::GetFullPath($ReleaseDirectory)
} else {
  $releaseRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $ReleaseDirectory))
}
$allowedReleaseRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot '.release')).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $releaseRoot.StartsWith($allowedReleaseRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'ReleaseDirectory must point to a dedicated directory inside .release.'
}
$cacheDirectory = Join-Path $releaseRoot 'cache'
$buildDirectory = Join-Path $releaseRoot 'build'
$stageDirectory = Join-Path $releaseRoot 'stage'
$appStage = $stageDirectory
$runtimeStage = Join-Path $appStage 'runtime'
$outputDirectory = Join-Path $releaseRoot 'output'
$iconSourcePath = Join-Path $repoRoot 'installer\assets\finance-icon.png'
$archiveName = "node-v$NodeVersion-win-$Architecture.zip"
$archivePath = Join-Path $cacheDirectory $archiveName
$checksumsPath = Join-Path $cacheDirectory 'SHASUMS256.txt'
$archiveUrl = "https://nodejs.org/dist/v$NodeVersion/$archiveName"
$checksumsUrl = "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt"
$installerDefinition = Join-Path $repoRoot 'installer\finance.iss'

if (-not $InnoCompilerPath) {
  $candidatePaths = @(
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
    (Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
  )
  $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($command) { $InnoCompilerPath = $command.Source }
  else { $InnoCompilerPath = $candidatePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1 }
}
if (-not $InnoCompilerPath -or -not (Test-Path -LiteralPath $InnoCompilerPath)) {
  throw 'Inno Setup 6 is required to compile the installer. Install it, then rerun this script.'
}
if (-not (Test-Path -LiteralPath $iconSourcePath -PathType Leaf)) {
  throw 'The Finance icon source is missing: installer\assets\finance-icon.png.'
}

$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
if (-not $AppVersion) { $AppVersion = "$($package.version)-beta.1" }
if ($AppVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
  throw 'AppVersion must be a semantic version, optionally followed by a prerelease suffix.'
}
if (-not $UpdateChannel) { $UpdateChannel = if ($AppVersion.Contains('-')) { 'beta' } else { 'stable' } }
if ($UpdateChannel -notin @('beta', 'stable')) { throw 'UpdateChannel must be beta or stable.' }
if (($UpdateChannel -eq 'stable') -and $AppVersion.Contains('-')) { throw 'Stable builds must not use a prerelease version.' }
if (($UpdateChannel -eq 'beta') -and -not $AppVersion.Contains('-')) { throw 'Beta builds must use a prerelease version such as 1.0.0-beta.1.' }
New-Item -ItemType Directory -Path $cacheDirectory, $buildDirectory, $stageDirectory, $outputDirectory -Force | Out-Null

if (-not (Test-Path -LiteralPath $checksumsPath)) {
  Invoke-WebRequest -Uri $checksumsUrl -OutFile $checksumsPath
}
if (-not (Test-Path -LiteralPath $archivePath)) {
  Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath
}
$checksumLine = Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match "\s+$([regex]::Escape($archiveName))$" } | Select-Object -First 1
if (-not $checksumLine) { throw "Node.js checksum for $archiveName was not found in the official checksum file." }
$expectedHash = ($checksumLine -split '\s+')[0].ToLowerInvariant()
$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) { throw 'Node.js archive checksum does not match the official checksum.' }

foreach ($target in @($buildDirectory, $stageDirectory, $outputDirectory)) {
  $resolvedTarget = [IO.Path]::GetFullPath($target)
  $resolvedRelease = [IO.Path]::GetFullPath($releaseRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedTarget.StartsWith($resolvedRelease, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a path outside the generated release directory: $resolvedTarget"
  }
  if (Test-Path -LiteralPath $resolvedTarget) { Remove-Item -LiteralPath $resolvedTarget -Recurse -Force }
}
New-Item -ItemType Directory -Path $buildDirectory, $appStage, $runtimeStage, $outputDirectory -Force | Out-Null
& (Join-Path $PSScriptRoot 'prepare-windows-icon.ps1') -SourcePath $iconSourcePath -DestinationPath (Join-Path $appStage 'finance.ico')
Expand-Archive -LiteralPath $archivePath -DestinationPath $buildDirectory -Force
$nodeRoot = Join-Path $buildDirectory "node-v$NodeVersion-win-$Architecture"
if (-not (Test-Path -LiteralPath (Join-Path $nodeRoot 'node.exe'))) { throw 'The official Node.js archive did not contain node.exe.' }
Copy-Item -LiteralPath (Join-Path $nodeRoot 'node.exe') -Destination $runtimeStage -Force
Copy-Item -LiteralPath (Join-Path $nodeRoot 'LICENSE') -Destination $runtimeStage -Force

foreach ($entry in @('server.js', 'package.json', 'package-lock.json', 'LICENSE')) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $entry) -Destination $appStage -Force
}
$runtimeFiles = @(
  'public\app.js', 'public\index.html', 'public\presence.js', 'public\setup.css', 'public\setup.html', 'public\setup.js', 'public\styles.css', 'public\i18n.js',
  'lib\client-presence.mjs', 'lib\first-run.mjs', 'lib\identity-state.mjs', 'lib\input-boundary.mjs', 'lib\recovery-bundle.mjs', 'lib\runtime-control.mjs', 'lib\update-service.mjs', 'lib\workbook-store.mjs',
  'templates\finance-template.xlsx'
)
$runtimeFiles += @('public\assets\finance-icon.png', 'public\locales\en.json', 'public\locales\ru.json')
foreach ($relativePath in $runtimeFiles) {
  $sourcePath = Join-Path $repoRoot $relativePath
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "Required runtime file is missing: $relativePath" }
  $targetPath = Join-Path $appStage $relativePath
  $targetDirectory = Split-Path -Parent $targetPath
  New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
  Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
}
New-Item -ItemType Directory -Path (Join-Path $appStage 'scripts') -Force | Out-Null
foreach ($script in @('desktop-launcher.mjs', 'finance-start.vbs', 'finance-stop.vbs', 'finance-rollback.vbs')) {
  Copy-Item -LiteralPath (Join-Path $repoRoot "scripts\$script") -Destination (Join-Path $appStage 'scripts') -Force
}
$releaseInfo = [ordered]@{
  version = $AppVersion
  channel = $UpdateChannel
  repository = 'gmdveast/finance-desktop'
}
$releaseInfoPath = Join-Path $appStage 'release-info.json'
[System.IO.File]::WriteAllText($releaseInfoPath, ($releaseInfo | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
Push-Location $appStage
try {
  npm ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}

$compilerArguments = @(
  "/DStageDir=`"$stageDirectory`"",
  "/DOutputDir=`"$outputDirectory`"",
  "/DAppVersion=`"$AppVersion`"",
  "/DAppChannel=`"$UpdateChannel`"",
  "/DAppArch=`"$Architecture`"",
  $installerDefinition
)
& $InnoCompilerPath @compilerArguments
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compiler failed with exit code $LASTEXITCODE." }
$installer = Get-ChildItem -LiteralPath $outputDirectory -Filter 'Finance-Setup-*.exe' | Select-Object -First 1
if (-not $installer) { throw 'Inno Setup completed without creating the installer.' }
$installerHash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$($installer.FullName).sha256" -Value "$installerHash  $($installer.Name)" -Encoding ascii
Write-Output "Created $($installer.FullName)"
Write-Output "SHA-256: $installerHash"
