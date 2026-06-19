@echo off
setlocal
title SpoLocal webapp
cd /d "%~dp0webapp"

if not exist ".venv\Scripts\python.exe" (
    echo [SpoLocal] No virtualenv found at webapp\.venv
    echo Create it with:
    echo   cd /d "%~dp0webapp"
    echo   python -m venv .venv
    echo   .venv\Scripts\pip install -r requirements.txt
    echo.
    echo Falling back to current Python on PATH...
    echo.
    python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
    goto :eof
)

".venv\Scripts\python.exe" -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
endlocal
