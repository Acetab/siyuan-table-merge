$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$distPath = Join-Path $projectRoot "dist"
$zipPath = Join-Path $projectRoot "package.zip"
$releaseRoot = Join-Path $projectRoot "release"
$installFolder = Join-Path $releaseRoot "siyuan-table-merge"
$resolvedProjectRoot = [System.IO.Path]::GetFullPath($projectRoot)
$resolvedInstallFolder = [System.IO.Path]::GetFullPath($installFolder)

if (-not $resolvedInstallFolder.StartsWith($resolvedProjectRoot + [System.IO.Path]::DirectorySeparatorChar)) {
    throw "Install folder escaped project root: $resolvedInstallFolder"
}

Push-Location $projectRoot
try {
    npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "npm run build failed with exit code $LASTEXITCODE"
    }

    $requiredSourceFiles = @(
        "plugin.json",
        "README.md",
        "README.zh-CN.md",
        "README-install.zh-CN.md",
        "CONTRIBUTING.md",
        "SECURITY.md",
        "LICENSE",
        "icon.png",
        "preview.png"
    )
    foreach ($relativePath in $requiredSourceFiles) {
        $sourcePath = Join-Path $projectRoot $relativePath
        if (-not (Test-Path -LiteralPath $sourcePath)) {
            throw "Missing package source file: $relativePath"
        }
        Copy-Item -LiteralPath $sourcePath -Destination $distPath -Force
    }

    if (Test-Path -LiteralPath $installFolder) {
        Remove-Item -LiteralPath $installFolder -Recurse -Force
    }
    New-Item -ItemType Directory -Path $installFolder -Force | Out-Null
    Copy-Item -Path (Join-Path $distPath "*") -Destination $installFolder -Recurse -Force

    if (Test-Path -LiteralPath $zipPath) {
        Remove-Item -LiteralPath $zipPath -Force
    }
    Compress-Archive -Path (Join-Path $installFolder "*") -DestinationPath $zipPath -CompressionLevel Optimal

    $requiredPackageFiles = @(
        "plugin.json",
        "index.js",
        "README.md",
        "README.zh-CN.md",
        "README-install.zh-CN.md",
        "CONTRIBUTING.md",
        "SECURITY.md",
        "LICENSE",
        "icon.png",
        "preview.png"
    )
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        $entryNames = $archive.Entries | ForEach-Object { $_.FullName.Replace("\", "/") }
        foreach ($requiredFile in $requiredPackageFiles) {
            if ($entryNames -notcontains $requiredFile) {
                throw "Package missing required file: $requiredFile"
            }
            if (-not (Test-Path -LiteralPath (Join-Path $installFolder $requiredFile))) {
                throw "Install folder missing required file: $requiredFile"
            }
        }
        Write-Output ("Package verified: " + ($entryNames -join ", "))
        Write-Output ("Install folder verified: " + $installFolder)
    }
    finally {
        $archive.Dispose()
    }

    node scripts/validate-marketplace.mjs
    if ($LASTEXITCODE -ne 0) {
        throw "Marketplace validation failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
