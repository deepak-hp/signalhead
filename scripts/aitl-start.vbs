' Starts the traffic light with no console window.
' Drop a shortcut to this file into shell:startup to run it at login.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
CreateObject("WScript.Shell").Run "node """ & root & "\src\cli.js"" start", 0, False
