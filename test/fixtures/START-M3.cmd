@echo off
rem Opens the nextlevel menu for this project: setup, the hub, workers and the orchestrator.
rem The nextlevel tool is installed once per PC; this file only starts it in this folder.
setlocal
cd /d "%~dp0"
where nextlevel >nul 2>nul
if not errorlevel 1 (
  call nextlevel %*
) else if exist "%USERPROFILE%\.nextlevel\tool\bin\nextlevel.mjs" (
  node "%USERPROFILE%\.nextlevel\tool\bin\nextlevel.mjs" %*
) else (
  echo The nextlevel tool is not installed on this PC yet. To install it, type this in PowerShell:
  echo   gh api repos/DYevseyev/nextlevelorc/contents/install.ps1 -H "Accept: application/vnd.github.raw" ^| Out-String ^| iex
  echo ^(It needs the GitHub CLI, signed in: gh auth login.^) Then run START.cmd again.
  pause
  exit /b 1
)
if errorlevel 1 pause
