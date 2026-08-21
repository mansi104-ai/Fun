@echo off
REM ---------------------------------------------------------------------------
REM SCL Watcher
REM
REM Copy this file into the folder that holds your SCL screenshots, then
REM double-click it. It watches whichever folder it is sitting in, and opens
REM the interface in your browser.
REM
REM If you ever move the scl_tool folder, update TOOL_DIR below to match.
REM ---------------------------------------------------------------------------

set "TOOL_DIR=c:\Users\mansi\Fun-clone\Fun\Bex\scl_tool"

REM %~dp0 always ends in a backslash, which would escape the closing quote and
REM hand Python a broken path. Trim it before use.
set "FOLDER=%~dp0"
if "%FOLDER:~-1%"=="\" set "FOLDER=%FOLDER:~0,-1%"

if not exist "%TOOL_DIR%\watch_server.py" (
    echo.
    echo Cannot find the tool at:
    echo   %TOOL_DIR%
    echo.
    echo Edit this file and set TOOL_DIR to wherever scl_tool lives.
    echo.
    pause
    exit /b 1
)

python "%TOOL_DIR%\watch_server.py" --folder "%FOLDER%"

if errorlevel 1 (
    echo.
    echo The watcher exited with an error. If Python was not found, install it
    echo from https://www.python.org/downloads/ with "Add Python to PATH" ticked.
    echo.
)
pause
