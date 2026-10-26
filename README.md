# Finance

Finance is a local Windows app for managing personal finances in an Excel workbook. It can receive transactions from your phone through Obsidian and Syncthing.

Current version: **1.2.2**. The desktop app and first-run setup are available in English and Russian; choose a language in Settings. In 1.2.2, transaction time appears above the date, the update notice aligns with the selected navigation tab, and dates fit in the Overview table.

## Installation

1. Download the latest stable `Finance-Setup-...-x64.exe` installer from the [releases page](https://github.com/gmdveast/finance-desktop/releases).
2. Run the installer. You do not need to install Node.js or other dependencies.
3. Open Finance from the Windows Start menu.
4. On first launch, create a new workbook or import an existing Finance `.xlsx` workbook. The original file is not modified during import.

To import a workbook, it must contain the sheets `Операции` (Transactions), `Списки` (Lists), `Баланс` (Balance), and `Сводка` (Summary). The workbook must be no larger than 50 MB.

The installer is not signed yet, so Windows may show a SmartScreen warning. Compare the installer's SHA-256 hash with the `.sha256` file published beside it. In PowerShell, get the hash with `Get-FileHash "path\to\Finance-Setup.exe" -Algorithm SHA256`. Run the installer only if the hashes match.

## Data and backups

- Application: `%LOCALAPPDATA%\Programs\Finance`
- Workbook, settings, and other data: `%LOCALAPPDATA%\Finance\data`
- Default workbook: `%LOCALAPPDATA%\Finance\data\uchet_povsednevnyh_finansov.xlsx`
- Phone sync folder: `%LOCALAPPDATA%\Finance\Finance Sync`

Uninstalling Finance does not remove your workbook or user data. Finance keeps the 30 most recent local workbook backups; you can review and restore them in Settings. These backups are stored on the same drive and will not protect your data if that drive fails.

To save a copy to another storage device, open Finance and choose **Settings → Copy on another drive**. The recovery ZIP contains the entire workbook and is not encrypted. Store it on a separate physical drive and verify that it can be restored.

Finance must be the only app writing to your active workbook. Do not edit it in Excel while Finance is running, store it on a network drive or synced folder, or run two Finance instances against the same workbook.

## Optional phone setup

Mobile capture requires Obsidian Mobile and Syncthing. In Finance, open **Connect phone** for setup steps and the `Finance Sync` folder. In Obsidian, install BRAT, add the [Finance Capture plugin repository](https://github.com/gmdveast/finance-capture), install the latest available version, and enable the plugin. When your computer is on and the folders are synced, Finance imports queued transactions into the workbook.

The installed desktop app checks for updates on startup. View the status or check manually under **Settings → Finance updates**. Downloads and installation begin only after you confirm. The Obsidian plugin is updated separately through BRAT. You can roll back the desktop app from Settings.

## Privacy and support

Your workbook and transactions are not sent to Finance servers. The desktop app fetches exchange rates from the Central Bank of Russia. The installed app contacts GitHub on startup and when you manually check for releases. Finance supports Windows x64.

When reporting an issue, include your Finance version and the steps to reproduce it. Do not send your workbook, recovery ZIP, or screenshots containing financial data.
