@echo off
REM Double-click this to start the tool. It opens in your browser at
REM http://localhost:8501 and keeps running until you close this window.

cd /d "%~dp0"

python --version >nul 2>&1
if errorlevel 1 (
    echo Python was not found on this machine.
    echo Install it from https://www.python.org/downloads/ and tick
    echo "Add Python to PATH" during setup, then run this file again.
    pause
    exit /b 1
)

REM Only pay the install cost the first time, or after a dependency is added.
python -c "import streamlit, openpyxl, PIL, numpy, pytesseract" >nul 2>&1
if errorlevel 1 (
    echo Installing what the tool needs, one moment...
    python -m pip install --quiet --disable-pip-version-check -r requirements.txt
    if errorlevel 1 (
        echo.
        echo The install failed. Run this by hand to see why:
        echo     python -m pip install -r requirements.txt
        pause
        exit /b 1
    )
)

REM Tesseract is only a fallback, for cells that do not match the ANSYS font.
REM Screenshots taken straight from ANSYS are read without it.
if not exist "C:\Program Files\Tesseract-OCR\tesseract.exe" (
    where tesseract >nul 2>&1
    if errorlevel 1 (
        echo Note: Tesseract OCR is not installed. The tool works without it, but
        echo cells that do not match the ANSYS font will be left for you to type in.
        echo Optional install: https://github.com/UB-Mannheim/tesseract/wiki
        echo.
    )
)

python -m streamlit run app.py
pause
