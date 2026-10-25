import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const installerScript = await readFile(new URL('../installer/finance.iss', import.meta.url), 'utf8');
const packageScript = await readFile(new URL('../scripts/package-windows.ps1', import.meta.url), 'utf8');
const taskSection = installerScript.match(/\[Tasks\]\s*([\s\S]*?)\s*\[Files\]/)?.[1];
const codeSection = installerScript.match(/\[Code\]\s*([\s\S]*)$/)?.[1];
assert.ok(taskSection, 'Inno Setup task section should exist');
assert.ok(codeSection, 'Inno Setup code section should exist');
const taskLines = taskSection.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const desktopTaskIndex = taskLines.findIndex((line) => line.startsWith('Name: "desktopicon";'));
const desktopTask = taskLines[desktopTaskIndex];
const autostartTask = taskLines.find((line) => line.startsWith('Name: "autostart";'));

test('desktop shortcut is selected by default on fresh installs and updates', () => {
  assert.equal(desktopTaskIndex, 0, 'desktopicon must remain the first task used by the setup callback');
  assert.doesNotMatch(desktopTask, /Flags:\s*[^;]*\bunchecked\b/i);
  assert.doesNotMatch(installerScript, /UsePreviousTasks\s*=\s*no/i, 'keep restoring unrelated task choices such as autostart');
});

test('desktop default remains user-changeable and autostart remains opt-in', () => {
  assert.match(desktopTask, /Description: "Создать ярлык на рабочем столе"/);
  assert.match(installerScript, /if \(CurPageID = wpSelectTasks\) and not DesktopIconTaskDefaultApplied then[\s\S]*?WizardForm\.TasksList\.Checked\[0\] := True;/);
  assert.match(autostartTask, /Flags: unchecked/);
  assert.match(installerScript, /Name: "\{userstartup\}\\Finance";[^\r\n]*Tasks: autostart/);
});

test('uninstall stops Finance, clears version state and keeps user data outside the app folder', () => {
  assert.match(installerScript, /DefaultDirName=\{localappdata\}\\Programs\\Finance/);
  assert.match(installerScript, /Uninstallable=yes/);
  assert.match(codeSection, /function InitializeUninstall\(\): Boolean;\s*begin\s*Result := StopActiveFinance\(\);\s*end;/);
  assert.match(codeSection, /if CurUninstallStep = usPostUninstall then[\s\S]*?RegDeleteValue\(HKCU, 'Software\\FinanceDesktop', 'CurrentVersion'\);[\s\S]*?RegDeleteValue\(HKCU, 'Software\\FinanceDesktop', 'PreviousVersion'\);[\s\S]*?RegDeleteKeyIfEmpty\(HKCU, 'Software\\FinanceDesktop'\);/);
  assert.doesNotMatch(installerScript, /\[UninstallDelete\]/i, 'regular uninstall must not recursively remove local user data');
  assert.doesNotMatch(installerScript, /(?:\{localappdata\}|%LOCALAPPDATA%)[\\/]Finance[\\/](?:data|Finance Sync)/i);
});

test('Windows package output can use a dedicated directory confined to .release', () => {
  assert.match(packageScript, /\[string\]\$ReleaseDirectory = ''/);
  assert.match(packageScript, /if \(-not \$ReleaseDirectory\) \{ \$ReleaseDirectory = "\.release\\windows-\$Architecture" \}/);
  assert.match(packageScript, /\$allowedReleaseRoot = [^\r\n]*Join-Path \$repoRoot '\.release'/);
  assert.match(packageScript, /ReleaseDirectory must point to a dedicated directory inside \.release\./);
  assert.match(packageScript, /Refusing to clean a path outside the generated release directory/);
});
