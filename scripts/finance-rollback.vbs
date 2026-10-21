Option Explicit
Dim shell, fileSystem, scriptDirectory, installRoot, appDirectory, currentVersion, previousVersion, nodePath, launcherPath, command, answer
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
installRoot = fileSystem.GetParentFolderName(scriptDirectory)
currentVersion = ReadVersion("CurrentVersion")
previousVersion = ReadVersion("PreviousVersion")
appDirectory = ResolveAppDirectory(installRoot, currentVersion)
If Not IsInstalledApp(appDirectory) Then appDirectory = ResolveAppDirectory(installRoot, previousVersion)
If Not IsInstalledApp(appDirectory) Then appDirectory = installRoot
answer = MsgBox("Переключить Finance на сохранённую предыдущую версию? Приложение штатно завершит текущие операции и перезапустится.", vbQuestion + vbYesNo, "Finance — откат версии")
If answer = vbYes Then
  nodePath = fileSystem.BuildPath(appDirectory, "runtime\node.exe")
  launcherPath = fileSystem.BuildPath(appDirectory, "scripts\desktop-launcher.mjs")
  command = """" & nodePath & """ """ & launcherPath & """ rollback"
  shell.Run command, 0, False
End If

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
