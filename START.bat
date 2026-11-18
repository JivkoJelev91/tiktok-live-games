@echo off
if not "%~1"=="run" (
  cmd /k ""%~f0" run"
  exit /b
)
cd /d "%~dp0"
title Dumomania

where node >nul 2>nul
if not errorlevel 1 goto havenode
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
where node >nul 2>nul
if not errorlevel 1 goto havenode
echo.
echo  Node.js ne e nameren! Instaliraj go ot https://nodejs.org (LTS) i restartiraj kompyutara.
echo.
start "" https://nodejs.org
goto end

:havenode
echo Node.js:
node -v
if exist node_modules goto run
echo Instalirane na paketite (samo parviya pat, tryabva internet)...
call npm install

:run
echo.
set "TTUSER=user6390480461367"
echo Svarzvane s lajva na @%TTUSER%...
echo.
echo  NE ZATVARYAY TOZI PROZORETS, dokato igraesh!
echo.
node server.js %TTUSER% --open

:end
echo.
echo  Igrata sprya. Mozhesh da zatvorish prozoretsa.
