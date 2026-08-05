# Windows 11 24H2 Upgrade Launcher

A seamless in-place upgrade from Windows 11 23H2 to 24H2 that runs **attended**
(a tech double-clicks) or **unattended** (KACE Managed Installation / scheduled
job). Keeps the proven **"run Setup as SYSTEM via Task Scheduler"** design so
the upgrade survives a tech disconnecting, and adds pre-flight safety checks, a
user notification, an active-hours-aware warned reboot, automatic
success/**rollback** verification with **SetupDiag** analysis, and
**fleet-reportable status** in the registry.

> **Companion docs**
> - **`DEPLOYMENT.md`** — scaling to local + remote users via KACE (alternate
>   download / WUfB), and fleet reporting with a Custom Inventory Rule.
> - **`ROLLBACK-RUNBOOK.md`** — fixing the "rolls back after first reboot"
>   blocker (dynamic update, Dell drivers, Zscaler, SetupDiag).

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

## How to run it

**Attended (tech, one machine):**

1. Extract the approved 24H2 ISO to a **local** folder, e.g. `C:\Temp\Win1124H2`
   (local, not a mapped/network path — SYSTEM must read it).
2. Copy the launcher files there, next to `setup.exe`. *(Optional: drop
   `SetupDiag.exe` in a `tools\` subfolder to enable automatic rollback
   analysis.)*
3. **Double-click `RunUpgrade.cmd`** and approve UAC. *(No admin prompt / `cd`.)*
4. Watch for **`RESULT: UPGRADE STARTED`**, tell the user, and disconnect.

The user gets an on-screen notice up front and a warning before the restart.

**Unattended (KACE Managed Installation / scheduled job):**

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File RunUpgrade.ps1 -Unattended
```

Auto-detects the non-interactive session, suppresses all prompts, defers the
restart until **after active hours**, and reports state to the registry. Full
local + remote rollout guidance is in **`DEPLOYMENT.md`**.

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
| **Unattended / KACE mode** | Same scripts run as a Managed Installation with no prompts — one payload for attended and unattended. |
| **Active-hours-aware reboot** | Unattended runs defer the restart until after hours so users aren't interrupted mid-day. |
| **SetupDiag on rollback** | The failing rule/driver is captured automatically instead of hand-read from `setuperr.log`. |
| **Fleet reporting** | Outcome written to `HKLM\SOFTWARE\Win11_24H2_Upgrade` for a KACE Custom Inventory Rule + Smart Labels. |
| **Structured logging** | Clear `INFO/WARN/ERROR/OK` lines across `RunUpgrade.log`, `Setup_Worker.log`, `Verify.log`. |

---

## Options / tuning

Pass these to `RunUpgrade.ps1` (edit the call inside `RunUpgrade.cmd` if you
want a permanent change):

| Parameter | Default | Notes |
|-----------|---------|-------|
| `-Unattended` | auto | Force unattended mode (auto-detected when there's no interactive desktop). |
| `-RebootPolicy` | `afterhours` (unattended) / `countdown` (attended) | `afterhours` waits for `ActiveHoursEnd`; `countdown` warns then restarts. |
| `-ActiveHoursStart` / `-ActiveHoursEnd` | `8` / `18` | Hours the user is considered "working"; restart is held until after. |
| `-RebootCountdownSeconds` | `300` | Countdown warning (when `RebootPolicy = countdown`). |
| `-DynamicUpdate` | `enable` | `enable` pulls Setup/compat/SafeOS fixes (fewer rollbacks, needs internet). `disable` only for offline. See runbook. |
| `-MinFreeGB` | `25` | Required free space on the system drive. |
| `-AllowOnBattery` | off | Permit the upgrade on battery power. |
| `-BlockOnPendingReboot` | off | Make a pending reboot a hard stop instead of a warning. |

---

## Verifying by hand

```bat
:: Is Setup running?
tasklist | findstr /i "setup setuphost setupprep"

:: What version did it land on?
reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v DisplayVersion

:: Recorded outcome: Success / Rollback / InProgress / Failed (+ cause)
reg query "HKLM\SOFTWARE\Win11_24H2_Upgrade"
```

Logs: `C:\ProgramData\Win11_24H2_Logs\` (`RunUpgrade.log`, `Setup_Worker.log`,
`Verify.log`, plus any collected `SetupLogs_*` / `RollbackLogs_*` folders with
`SetupDiagResults.log`).

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
