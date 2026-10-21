Option Explicit
Dim shell, fileSystem, scriptDirectory, installRoot, appDirectory, currentVersion, previousVersion, nodePath, launcherPath, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
installRoot = fileSystem.GetParentFolderName(scriptDirectory)
currentVersion = ReadVersion("CurrentVersion")
previousVersion = ReadVersion("PreviousVersion")
appDirectory = ResolveAppDirectory(installRoot, currentVersion)
If Not IsInstalledApp(appDirectory) Then
  appDirectory = ResolveAppDirectory(installRoot, previousVersion)
  If IsInstalledApp(appDirectory) And previousVersion <> "" Then
    On Error Resume Next
    shell.RegWrite "HKCU\Software\FinanceDesktop\PreviousVersion", currentVersion, "REG_SZ"
    shell.RegWrite "HKCU\Software\FinanceDesktop\CurrentVersion", previousVersion, "REG_SZ"
    On Error GoTo 0
  End If
End If
If Not IsInstalledApp(appDirectory) Then appDirectory = installRoot
nodePath = fileSystem.BuildPath(appDirectory, "runtime\node.exe")
launcherPath = fileSystem.BuildPath(appDirectory, "scripts\desktop-launcher.mjs")
command = """" & nodePath & """ """ & launcherPath & """ start"
shell.Run command, 0, False

Function ReadVersion(name)
  On Error Resume Next
  ReadVersion = shell.RegRead("HKCU\Software\FinanceDesktop\" & name)
  If Err.Number <> 0 Then ReadVersion = ""
  Err.Clear
  On Error GoTo 0
End Function

Function ResolveAppDirectory(root, version)
  If version = "" Or LCase(version) = "legacy" Then
    ResolveAppDirectory = root
  ElseIf IsSafeVersion(version) Then
    ResolveAppDirectory = fileSystem.BuildPath(fileSystem.BuildPath(root, "versions"), version)
  Else
    ResolveAppDirectory = ""
  End If
End Function

Function IsSafeVersion(version)
  Dim expression
  Set expression = New RegExp
  expression.Pattern = "^[A-Za-z0-9][A-Za-z0-9.-]{0,79}$"
  expression.Global = False
  IsSafeVersion = expression.Test(version)
End Function

Function IsInstalledApp(directory)
  If directory = "" Then
    IsInstalledApp = False
  Else
    IsInstalledApp = fileSystem.FileExists(fileSystem.BuildPath(directory, "server.js")) And _
      fileSystem.FileExists(fileSystem.BuildPath(directory, "runtime\node.exe")) And _
      fileSystem.FileExists(fileSystem.BuildPath(directory, "scripts\desktop-launcher.mjs"))
  End If
End Function
