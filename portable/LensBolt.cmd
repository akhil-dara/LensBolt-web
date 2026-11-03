@echo off
rem LensBolt portable sender: opens the single-file sender in the default Chromium browser in app mode
rem (no tabs or address bar), falling back to the default browser. Nothing is installed.
setlocal
set "HTML=%~dp0lensbolt.html"
for %%B in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%LocalAppData%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe") do (
  if exist %%B (
    start "" %%B --app="file:///%HTML:\=/%" --window-size=960,760
    exit /b 0
  )
)
start "" "%HTML%"
