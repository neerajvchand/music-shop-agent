# Windows 11 24H2 Upgrade Launcher

A seamless, one-click in-place upgrade from Windows 11 23H2 to 24H2, designed
for an ISS to run during a remote session and for the end user to be kept
informed. Keeps the proven **"run Setup as SYSTEM via Task Scheduler"** design
so the upgrade survives the ISS disconnecting, and adds pre-flight safety
checks, a user notification, a warned reboot, and automatic success/rollback
verification.

---

## Files

| File | Runs as | Purpose |
|------|---------|---------|
| `RunUpgrade.cmd` | ISS (self-elevates) | One-click bootstrap. Double-click it; it requests admin via UAC and calls the orchestrator. |
| `RunUpgrade.ps1` | Administrator | Orchestrator: pre-checks, user notification, registers the SYSTEM worker + verifier, confirms Setup started. |
| `Invoke-Upgrade.ps1` | SYSTEM | Worker: runs Windows Setup with `/noreboot`, then triggers the coordinated warned reboot. Collects logs on failure. |
| `Verify-Upgrade.ps1` | SYSTEM (at boot) | Confirms the machine reached 24H2, or flags a rollback and collects logs. Self-cleans when done. |

Everything lives next to `setup.exe`. Logs and the machine-side copies of the
worker/verifier go to `C:\ProgramData\Win11_24H2_Logs\`.

---

## ISS Steps (the short version)

1. Copy and extract the approved Windows 11 24H2 ISO to a **local** folder,
   e.g. `C:\Temp\Win1124H2`. (Local, not a network/mapped path — the SYSTEM
   account must be able to read it.)
2. Copy the four files above into that same folder (next to `setup.exe`).
3. **Double-click `RunUpgrade.cmd`** and approve the UAC prompt.
   *(No need to open an admin prompt or `cd` anywhere.)*
4. Watch for **`RESULT: UPGRADE STARTED`**.
5. Tell the user it's running in the background and the PC will restart on its
   own to finish (~30–45 min total). Then disconnect.

That's it. The user gets an on-screen notice up front and a **~5-minute
warning before the restart**, so nobody is surprised.

---

## What changed vs. the original `RunUpgrade.cmd`

The original was solid; these changes close the gaps that broke "seamless":

| Improvement | Why it matters |
|-------------|----------------|
| **One-click, self-elevating** `.cmd` | ISS no longer opens an admin prompt / `cd` / types the command. |
| **User notification** (`msg`) at start | The user knows an upgrade is happening instead of a silent surprise. |
| **Coordinated, warned reboot** (`/noreboot` + `shutdown /r /t`) | Setup no longer yanks the machine mid-work; the user gets a countdown to save. |
| **Post-reboot verification** | Records **SUCCESS** or **ROLLBACK** in the log — so a silent revert after the ISS leaves is caught, not missed. |
| **Real poll loop** (up to 90 s) | Replaces the fixed 8-second wait that produced false "WARNING" messages. |
| **Disk-space pre-check** (~25 GB) | Stops upgrades that would roll back late for lack of space. |
| **AC-power pre-check** | Blocks risky battery-only upgrades on laptops (override with `-AllowOnBattery`). |
| **Pending-reboot pre-check** | Warns (or blocks) when a prior update would make Setup fail. |
| **Setup log collection** | Panther logs are gathered automatically on failure/rollback for diagnosis. |
| **Structured logging** | Clear `INFO/WARN/ERROR/OK` lines across `RunUpgrade.log`, `Setup_Worker.log`, `Verify.log`. |

---

## Options / tuning

Pass these to `RunUpgrade.ps1` (edit the call inside `RunUpgrade.cmd` if you
want a permanent change):

| Parameter | Default | Notes |
|-----------|---------|-------|
| `-MinFreeGB` | `25` | Required free space on the system drive. |
| `-RebootCountdownSeconds` | `300` | User-visible warning before the restart. |
| `-DynamicUpdate` | `enable` | `enable` pulls Setup/compat fixes during the upgrade (fewer rollbacks, needs internet). Use `disable` only for offline/air-gapped runs. |
| `-AllowOnBattery` | off | Permit the upgrade on battery power. |
| `-BlockOnPendingReboot` | off | Make a pending reboot a hard stop instead of a warning. |

---

## Verifying by hand

```bat
:: Is Setup running?
tasklist | findstr /i "setup setuphost setupprep"

:: What version did it land on?
reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v DisplayVersion
```

Logs: `C:\ProgramData\Win11_24H2_Logs\` (`RunUpgrade.log`, `Setup_Worker.log`,
`Verify.log`, plus any collected `SetupLogs_*` / `RollbackLogs_*` folders).

---

## Exit codes (`RunUpgrade.ps1`)

| Code | Meaning |
|------|---------|
| 0 | Upgrade started (or already on 24H2) |
| 1 | Not elevated |
| 2 | `setup.exe` missing |
| 3 | `sources` folder missing |
| 4 | Windows Setup already running |
| 10 | Not enough free disk space |
| 11 | On battery power (and `-AllowOnBattery` not set) |
| 12 | Pending reboot (only with `-BlockOnPendingReboot`) |
| 20 | Registry change failed |
| 21 | Scheduled-task registration failed |
| 22 | Scheduled-task start failed |
| 23 | Setup not confirmed within 90 s (may still be initializing) |

---

## ⚠️ Pilot validation (do this once before fleet use)

Windows 11 **24H2 changed some Setup behavior** (Setup now uses
`SetupHost.exe`; a few switches behave differently, and there are field
reports of `/auto` erroring on certain 24H2 media). Before rolling this out:

1. Run it on **one representative machine**.
2. Confirm `Setup_Worker.log` shows the down-level phase exiting with **code 0**
   (or 3010). If your media returns a different success code, add it to the
   success check in `Invoke-Upgrade.ps1`.
3. Confirm the machine reboots on the warned countdown and `Verify.log`
   records **SUCCESS**.

The 24H2 **CPU requirements (PopCnt / SSE4.2) are not bypassable** — not a
concern for existing Win11 23H2 hardware, but relevant if any older machine
slips into scope.

---

## Not covered (intentionally)

This launcher is tuned for **manual, per-machine ISS use**. If you later move
to at-scale deployment, the same scripts drop cleanly into an RMM (NinjaOne,
PDQ, ConnectWise) as a payload, or the upgrade can be handed to Intune /
ConfigMgr Windows Update for Business feature-update rings. Ask and we can add
an RMM-friendly variant (exit-code contract + status file already make this easy).
