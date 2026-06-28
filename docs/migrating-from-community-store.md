# Migrating from the community store version

> **Audience:** anyone currently running **Hashrate Autopilot from the community app store** (Umbrel app id `rdouma-hashrate-autopilot`) who wants to switch to the **official Umbrel App Store** version (app id `hashrate-autopilot`).
>
> If you installed Hashrate Autopilot only after it appeared in the official store, this page does not apply to you.

## TL;DR

1. **Stop** the community version.
2. **Install** the official version from the App Store, then **stop** it too.
3. **Copy** `state.db` from the community version's data folder to the official version's data folder.
4. **Start** the official version. Your full history is there.
5. Once verified, **uninstall** the community version.

Every step can be done from the umbrelOS UI: right-click an app icon on the home screen for **Stop** / **Start** / **Uninstall**, and use the built-in **Files** app for the copy. If you prefer a terminal, every step also has an SSH one-liner - both variants are spelled out below.

## Why is this even necessary?

Umbrel community app stores are required to prefix every app id with the store's own prefix. My community store ([rdouma/hashrate-autopilot](https://github.com/rdouma/hashrate-autopilot)) calls the app `rdouma-hashrate-autopilot`. The official Umbrel App Store has no prefix convention - there it's just `hashrate-autopilot`.

Umbrel stores every app's persistent data under `~/umbrel/app-data/<app-id>/`. Because the two app ids differ, **Umbrel treats the two installs as two different apps**:

| What you have | App id | Data lives in |
|---|---|---|
| Community store install | `rdouma-hashrate-autopilot` | `~/umbrel/app-data/rdouma-hashrate-autopilot/data/` |
| Official store install | `hashrate-autopilot` | `~/umbrel/app-data/hashrate-autopilot/data/` |

If you just click **Install** in the official store while keeping the community version, you end up with two instances running side by side, the new one with an empty database. If you uninstall the community version after installing the official one without migrating, your history goes with it.

The Docker image is identical (at the time of writing, both installs pull `ghcr.io/rdouma/hashrate-autopilot:1.13.0`),
so the only thing that has to move between the two on-host directories is the SQLite database. That's what the steps below do.

## Step by step

> **Back up `state.db` first if you have anything more than a few weeks of history.** Nothing in these steps is destructive, but a copy is cheap insurance. The easiest way: open the **Files** app on your umbrelOS home screen, navigate to the `rdouma-hashrate-autopilot` app-data folder, and copy `data/state.db` into your Home folder (or download it to your computer from there). From a laptop, `scp umbrel@umbrel.local:~/umbrel/app-data/rdouma-hashrate-autopilot/data/state.db ~/state.db.backup` works too.

### 1. Stop the community version

Right-click the Hashrate Autopilot icon (the community-store one) on your umbrelOS home screen and choose **Stop**.

Terminal alternative:

```bash
umbreld client apps.stop.mutate --appId rdouma-hashrate-autopilot
```

This brings the container down cleanly. Your data stays put under `~/umbrel/app-data/rdouma-hashrate-autopilot/`
(stopping is not uninstalling).

### 2. Install the official version

Open Umbrel's App Store, find **Hashrate Autopilot**, and install it. Wait for the install to complete and the app to boot once. This is what creates the fresh `~/umbrel/app-data/hashrate-autopilot/data/` directory with the correct ownership for the daemon to write to.

You will see the setup wizard instead of the dashboard if you open it. That's expected, since you haven't migrated yet.

### 3. Stop the official version

Right-click the newly installed icon and choose **Stop**.

Terminal alternative:

```bash
umbreld client apps.stop.mutate --appId hashrate-autopilot
```

SQLite likes the database file not to be open by another process when copied. Stopping the app guarantees that.

### 4. Copy `state.db` over

Two ways to do this; pick whichever you prefer. Both require the apps to be stopped (steps 1 and 3).

**Option A - umbrelOS Files app.** Open **Files** on your umbrelOS home screen, navigate into the app-data folder for `rdouma-hashrate-autopilot`, open its `data` folder, and copy `state.db`. Then navigate to the `hashrate-autopilot` app-data folder, open its `data` folder, and paste (replacing the empty `state.db` the official version created on first boot). The Files app runs with the right permissions, so there is no ownership issue to think about.

**Option B - terminal:**

```bash
sudo cp ~/umbrel/app-data/rdouma-hashrate-autopilot/data/state.db \
        ~/umbrel/app-data/hashrate-autopilot/data/state.db
```

`sudo` is required here because the daemon container runs as root, so the on-host data directory and its files are root-owned. The new file ends up root-owned too, which is exactly what the next container start expects.

> **Why both apps must be stopped for the copy, whichever option you use:** the daemon keeps its SQLite database in WAL mode, which means the most recent writes live in a separate `state.db-wal` file until a checkpoint folds them in. Copying `state.db` while the community version is running can silently miss those writes, and pasting over a `state.db` that the official version has open is worse. Stopping an app checkpoints everything into the single `state.db` file and closes it cleanly - after a stop, that one file is the complete database.

### 5. Start the official version

Right-click the official version's icon and choose **Start**.

Terminal alternative:

```bash
umbreld client apps.start.mutate --appId hashrate-autopilot
```

Open the dashboard. You should see your full history - bids, ticks, alerts, config - exactly as it was on the community version.

### 6. Verify, then uninstall the community version (optional)

Spend a few minutes on the dashboard confirming everything is there. Once you're satisfied all went well, the community 
version is just taking up disk space and can be uninstalled: right-click its icon and choose **Uninstall**, or:

```bash
umbreld client apps.uninstall.mutate --appId rdouma-hashrate-autopilot
```

This wipes `~/umbrel/app-data/rdouma-hashrate-autopilot/` and removes the community-store entry from your installed apps list.

## If something goes wrong

The community version's data stays where it was throughout this whole flow. Even if step 4 or 5 fails for any reason, you can always go back: right-click the community version's icon and choose **Start** (or `umbreld client apps.start.mutate --appId rdouma-hashrate-autopilot`),
and you're back where you started, on the community version, with all your data intact. The official version's empty data dir under `~/umbrel/app-data/hashrate-autopilot/data/` is harmless; you can uninstall the official version through the Umbrel UI if you want a clean slate before trying again.

If you run into issues, the [Migration discussion thread](https://github.com/rdouma/hashrate-autopilot/discussions/286)
is the place to post what you ran and what you saw. 
Include the output of `ls -la ~/umbrel/app-data/rdouma-hashrate-autopilot/data/` 
and `ls -la ~/umbrel/app-data/hashrate-autopilot/data/` please.
