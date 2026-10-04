@echo off
rem Remove the scheduled tasks created by install-autostart.bat.
rem Does not stop an already running gateway (close it yourself or reboot).
schtasks /Delete /F /TN "ComfyUI Mobile Gateway" 2>nul
schtasks /Delete /F /TN "ComfyUI Mobile Gateway KeepAlive" 2>nul
echo Done. Tasks removed.
