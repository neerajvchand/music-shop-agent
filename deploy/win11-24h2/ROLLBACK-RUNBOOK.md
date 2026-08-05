# Rollback Runbook — "24H2 rolls back after the first reboot"

This is the outstanding blocker from the project log. The pattern (upgrade
copies files fine, then reverts on the **first boot into the new OS**) almost
always means a **kernel-mode driver or filter driver crashes on first boot**,
so Setup rolls back to keep the machine bootable. This runbook names the cause
and fixes it.

---

## 1. Read the failure signature first (don't guess)

The launcher already collects logs and runs **SetupDiag** on rollback; the
result is in the registry and logs:

- `HKLM\SOFTWARE\Win11_24H2_Upgrade` → `FailureRule`, `FailingItem`
- `C:\ProgramData\Win11_24H2_Logs\RollbackLogs_*\SetupDiagResults.log`
- `HKLM\SYSTEM\Setup\SetupDiag\Results`

If you're diagnosing by hand, the canonical command is:

```
SetupDiag.exe /Output:C:\Temp\SetupDiag.log /Format:xml
```

(Run on the rolled-back machine — it auto-scans `C:\$WINDOWS.~BT\Sources\
Panther`, `…\Sources\Rollback`, and `C:\Windows\Panther`.) Put `SetupDiag.exe`
in the media's `tools\` folder so the scripts pick it up automatically.

**What the codes mean**

| Signature | Meaning | Where to look next |
|-----------|---------|--------------------|
| `0xC1900101 - 0x40017` (SECOND_BOOT / "Post First Boot") | Generic **driver crash on first boot** — the #1 cause of this exact symptom | `setuperr.log`, `setupact.log` in `…\Rollback`; the driver named nearest the failure |
| `0x800705B4` (your log — MOUPG timeout) | An operation (often the compat appraiser / driver enumeration) **timed out** | driver enumeration hangs; a bad/hung filter driver |
| `MIGRATE_DATA` / SAFE_OS failures | Third-party AV / filter driver blocking migration | AV / security agents |

The specific failing driver is usually in `setuperr.log` right before the
rollback, and in the SetupDiag `FailureData`.

---

## 2. The three most likely culprits on YOUR fleet

Based on the project log (Dell Latitude 5450, Zscaler 4.5, driver-migration
warnings, `/dynamicupdate disable`), work these in order:

### A. `/dynamicupdate disable` — flip it to **enable** (quick, high impact)
Disabling Dynamic Update means Setup uses the **stale SafeOS + compat modules
baked into the ISO** and downloads none of Microsoft's post-release fixes — the
very fixes that resolve first-boot driver rollbacks. The new launcher defaults
to `-DynamicUpdate enable`. **Re-pilot with it enabled first** — this alone
resolves a large share of `0x40017` rollbacks. Only use `disable` for truly
offline machines.

### B. Dell drivers/firmware — update BEFORE upgrading
- Microsoft shipped **KB5121767** (out-of-band) specifically for a **Dell +
  Intel driver** problem that caused 24H2 to be *blocked* on some Dell systems;
  Dell/Intel storage & audio drivers are common first-boot crashers.
- On the Latitude 5450: run **Dell Command | Update** (or push the current
  driver pack) to update **BIOS, Intel chipset/ME, storage (RST/NVMe), and
  audio** drivers, then reboot, then upgrade.
- Ensure the machine has the **latest 23H2 cumulative update** installed before
  starting (an up-to-date servicing stack reduces migration failures).

### C. Zscaler 4.5 filter driver — clear it on the pilot
Zscaler Client Connector installs **network filter/callout drivers**, a classic
first-boot rollback trigger. It is *not* auto-removed by the scripts (doing so
would cut a remote user's connectivity). On the **pilot only**, test an upgrade
with **Zscaler Client Connector exited/disabled** (or temporarily uninstalled).
If that upgrade succeeds where it previously rolled back, you've found it — then:
- Check for a **Zscaler build newer than 4.5** certified for 24H2, and/or
- Coordinate with the Zscaler admin to **suspend the client during the upgrade
  window** (some tenants support a maintenance/logout policy), and/or
- Add the upgrade endpoints to the Zscaler SSL-inspection **bypass** so media/
  CDN traffic isn't broken.

> Microsoft Print to PDF (`oem0.inf`) showing in **CompatData** is almost always
> a **benign** informational flag, not the rollback cause — don't chase it
> ahead of A/B/C.

---

## 3. Fast diagnostic loop

1. Reproduce on one machine → let it roll back.
2. Read `FailureRule` / `FailingItem` from the status key (or SetupDiag log).
3. Map the named driver/device to a vendor (Dell/Intel/Zscaler/AV).
4. Update or remove that component; ensure `-DynamicUpdate enable`.
5. Re-run. Repeat until `Result=Success`.

Keep the `RollbackLogs_*` folder — it's exactly what Microsoft's NSD case
(0x800705B4) will ask for: `setuperr.log`, `setupact.log`, the `Rollback`
folder, `CompatData*.xml`, and `SetupDiagResults.log`.

---

## 4. Manual verification commands

```bat
:: Which build are we on now?
reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v DisplayVersion

:: Read the recorded outcome (Success / Rollback / …)
reg query "HKLM\SOFTWARE\Win11_24H2_Upgrade"

:: Enumerate third-party drivers (spot the filter/storage/network drivers)
pnputil /enum-drivers
dism /online /get-drivers /format:table
```

Sources: Microsoft SetupDiag; Microsoft Q&A on `0xC1900101-0x40017` first-boot
rollback; WindowsForum KB5121767 (Dell/Intel driver block on 24H2/25H2);
Microsoft guidance on Dynamic Update during feature updates.
