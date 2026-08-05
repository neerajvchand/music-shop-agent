# Windows 11 24H2 — Deployment Architecture (local + remote)

How to move from "a tech runs it per machine" to a scalable rollout for both
**onsite/LAN** and **remote/roaming** users, using the KACE SMA you already
have — while keeping the same launcher as the engine and keeping user
disruption low.

> The scripts (`RunUpgrade.ps1` + helpers) are the payload for **every** path
> below. The only thing that changes is *how they're delivered and when they
> run*.

---

## 1. Pick the delivery path by population

| Population | Recommended path | Why |
|-----------|------------------|-----|
| **Onsite / LAN** | **KACE Managed Installation** with an **Alternate Download Location** on a LAN file server | The ~8 GB media stages fast over LAN; no tech per machine; schedule off-hours. |
| **Remote / roaming** | **Windows Update for Business (WUfB) feature-update ring** — *or* KACE MI with a **resumable HTTP/cloud** alternate download | Avoids pushing 8 GB over VPN/Zscaler. WUfB streams 24H2 from Microsoft's CDN (delta, resumable) and needs no media replication. |
| **One-off / pilot / VIP** | The attended **`RunUpgrade.cmd`** one-click | Full tech control, immediate feedback, log-in-hand. |

The single biggest remote-user win is **not shipping the 8 GB at all** for
roaming machines. Your project log already hit the pain (empty download
folders, replication-share timing). WUfB sidesteps media replication entirely;
KACE-with-cloud-download keeps it in KACE but makes the transfer resumable.

---

## 2. KACE Managed Installation (onsite)

1. **Build the package.** Zip the extracted 24H2 media **plus** these launcher
   files together so `setup.exe`, `\sources`, and the scripts share one root.
   Optionally drop `SetupDiag.exe` into a `tools\` subfolder (enables automatic
   rollback analysis — see ROLLBACK-RUNBOOK.md).
2. **Upload as a KACE Software item.** Because it's > 2 GB, distribute it with a
   **Managed Installation → Alternate Download Location** pointing at an
   internal file server (Quest KB 4313295). This is the supported way to move
   large packages and avoids bloating the SMA.
   Ref: Quest *"Windows 11 24H2/25H2 Upgrade Deployment Walkthrough"* (KB 4377615).
3. **Full command line** (unattended, no prompts, reboots after hours):
   ```
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File RunUpgrade.ps1 -Unattended
   ```
   The script auto-detects the non-interactive session, suppresses all
   prompts/pauses, and writes status to the registry instead.
4. **Schedule** the MI for an off-hours or maintenance window and let KACE's
   deploy windows stagger it. The worker still defers the actual restart until
   after active hours (default 08:00–18:00) as a second safety net.
5. **Don't** tick "alert user before run" if you want it silent; the script
   handles user messaging itself.

### Tuning the command line

| You want… | Add to the command line |
|-----------|------------------------|
| Restart on a 5-min countdown instead of after-hours | `-RebootPolicy countdown` |
| Different quiet hours | `-ActiveHoursStart 7 -ActiveHoursEnd 19` |
| Offline media (no internet at run time) | `-DynamicUpdate disable` *(raises rollback risk — see runbook)* |
| Allow battery / smaller disk threshold | `-AllowOnBattery` / `-MinFreeGB 20` |

---

## 3. Remote / roaming users

**Option R1 — WUfB feature-update ring (recommended).**
Point remote devices at a **Feature Update** policy targeting **Windows 11,
version 24H2** (Intune, or Group Policy `TargetReleaseVersion`). Microsoft's CDN
delivers the upgrade directly — delta-sized, resumable, bandwidth-throttled,
and it applies the latest SafeOS/compat fixes automatically (fewer rollbacks).
No 8 GB push, no replication share, works anywhere the device has internet.
Use KACE only to **report** state (below), not to move bits.

**Option R2 — KACE MI with resumable cloud download.**
If policy requires KACE to own the deployment, host the media zip on an
HTTP(S)/cloud location and use it as the Alternate Download Location so the
transfer resumes instead of restarting on a dropped VPN link. Add a KACE
**deploy window + "run at next check-in"** so it only fires when the agent is
actually connected. Expect this to be heavier on the link than R1.

> Zscaler note: whichever remote path you pick, confirm the media/CDN endpoints
> aren't being inspected/blocked by Zscaler, and see the runbook — Zscaler's
> filter driver is a rollback suspect worth clearing on the pilot.

---

## 4. Fleet reporting (so techs stop checking machines one-by-one)

Every script writes outcome to **`HKLM\SOFTWARE\Win11_24H2_Upgrade`**:

| Value | Meaning |
|-------|---------|
| `Result` | `InProgress` / `Success` / `Rollback` / `Failed` / `NotStarted` |
| `Stage` | fine-grained step (e.g. `DownlevelComplete`, `RebootScheduled`, `RolledBack`) |
| `DisplayVersion` | current OS version |
| `FailureRule` / `FailingItem` | SetupDiag cause on a rollback |
| `ExitCode`, `LogPath`, `LastUpdated` | diagnostics |

Create a KACE **Custom Inventory Rule** to pull `Result` into inventory:

```
RegistryValueReturn(HKLM\SOFTWARE\Win11_24H2_Upgrade, Result, TEXT)
```

Then build **Smart Labels** — `Result = Success`, `Result = Rollback`,
`Result = InProgress` — for a live rollout dashboard and to auto-target retries
at only the machines that rolled back. That single rule turns "remote into each
PC to check `winver`" into one filterable column.

---

## 5. Reducing user disruption (built in)

- **Runs in the background** as SYSTEM; the user keeps working during the
  down-level phase.
- **After-hours reboot by default** for unattended/KACE runs — the disruptive
  restart + online phase happen when the user isn't at the keyboard.
- **On-screen notifications** at start and before the restart (`msg`), plus a
  warned `shutdown` countdown.
- **Pre-checks** (disk / AC power / pending reboot) stop doomed attempts before
  they waste the user's time on a 40-minute rollback.

Optional next step (not built): a true user **snooze** dialog in the logged-on
session requires a user-context toast helper (e.g. BurntToast via a per-user
scheduled task, or ServiceUI). Ask if you want it — for most fleets, off-hours
scheduling + the after-hours reboot covers it without extra moving parts.

---

## 6. Rollout sequence (suggested)

1. **Pilot (5–10 machines, incl. a Dell Latitude 5450 with Zscaler).** Attended
   `RunUpgrade.cmd`. Confirm success code, after-hours reboot, and a clean
   `Result=Success`. If any roll back, the runbook + SetupDiag output name the
   cause.
2. **Fix the rollback root cause** (drivers/Zscaler/dynamic-update — see
   runbook) and re-pilot until green.
3. **Ring 1 (onsite):** KACE MI + LAN alternate download, off-hours, watch the
   Smart Labels.
4. **Ring 2 (remote):** WUfB feature-update ring; KACE reports state.
5. **Widen** ring by ring, driven by the `Result` dashboard.

Sources: Quest KB 4313295 (Alternate Download Location), Quest KB 4377615
(24H2/25H2 KACE walkthrough), Microsoft WUfB feature-update deployment,
Microsoft SetupDiag.
