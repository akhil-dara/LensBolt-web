# LensBolt one-line sender for Windows. Nothing is installed: the single-file sender is saved to the
# temporary folder and opened in the browser in app mode. Later, when the page is hosted:
#     irm https://lensbolt.com/send | iex
# Until then, from a local copy of the repository:
#     powershell -ExecutionPolicy Bypass -File web\send.ps1 [-Html path\to\lensbolt.html]
param(
    [string]$Html = "",
    [string]$Url = "https://lensbolt.com/lensbolt.html"
)
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:TEMP "LensBolt"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$target = Join-Path $dir "lensbolt.html"
if ($Html -ne "" -and (Test-Path $Html)) {
    Copy-Item -Force $Html $target
} elseif (-not (Test-Path $target)) {
    Write-Host "Downloading the LensBolt sender..."
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $target
}
$fileUrl = "file:///" + ($target -replace '\\', '/')
$browsers = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$exe = $browsers | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($exe) {
    Start-Process -FilePath $exe -ArgumentList "--app=$fileUrl", "--window-size=960,760"
} else {
    Start-Process $target
}
Write-Host "LensBolt sender opened. Point the phone at this screen and press Start."
