' ComfyUI Mobile gateway keepalive launcher.
' Task Scheduler runs this hidden (window style 0, no console flash); it starts
' scripts\autostart-check.js, which exits immediately when the gateway is healthy
' and spawns it detached when it is down. Nothing is downloaded or installed here.
' Usage: wscript.exe gateway-keepalive.vbs ["C:\path\to\node.exe"]
Option Explicit
Dim fso, shell, nodeExe, scriptDir, rootDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
If WScript.Arguments.Count >= 1 Then
  nodeExe = WScript.Arguments(0)
Else
  nodeExe = "node.exe"
End If
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir = fso.GetParentFolderName(scriptDir)
shell.Run """" & nodeExe & """ """ & rootDir & "\scripts\autostart-check.js""", 0, False
