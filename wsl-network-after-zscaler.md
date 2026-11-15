# WSL has no internet after switching from zScaler to Cisco VPN

**Symptom:** WSL (Ubuntu) has no internet connection after the VPN changed from zScaler to Cisco AnyConnect. DNS may still resolve, but `ping 1.1.1.1` and `curl` fail.

**Cause:** The zScaler workaround (the `wsl-vpnkit` helper distro) is no longer needed and breaks the network with Cisco. Cisco AnyConnect also routes the WSL subnet `172.29.160.0/20` into the VPN, so replies never reach WSL. Switching WSL to _mirrored_ networking avoids this.

**Fix:** Use WSL's mirrored networking mode and remove the old zScaler helper.

## Requirements

- WSL 2.0 or newer. Check with `wsl --version` in PowerShell.

## Steps

1. **Remove the old zScaler workaround (if present).**
   Open PowerShell and run:

   ```powershell
   wsl --list --verbose
   ```

   If a distro named `wsl-vpnkit` is listed, remove it:

   ```powershell
   wsl --unregister wsl-vpnkit
   ```

2. **Enable mirrored networking.**
   Open `%USERPROFILE%\.wslconfig` in a text editor (create it if it doesn't exist) and add:

   ```ini
   [wsl2]
   networkingMode=mirrored
   ```

   If the file already has a `[wsl2]` section, add only the `networkingMode=mirrored` line to it.

3. **Restart WSL.**
   Close all WSL terminals, then run in PowerShell:

   ```powershell
   wsl --shutdown
   ```

   This also stops running Docker containers inside WSL. Start them again afterwards.

4. **Test.** Open a WSL terminal and run:

   ```bash
   ping -c 3 1.1.1.1
   getent hosts heise.de
   curl -I https://heise.de
   ```

   All three should succeed.

## If it still doesn't work

- Make sure the `.wslconfig` file was saved with `networkingMode=mirrored` and that `wsl --shutdown` ran after the change.
- If a Docker container publishes port `2222` on the host, it can stop the WSL network helper from starting. Change that port mapping if you still have the old helper installed.
- Check with IT whether the Cisco AnyConnect setup blocks traffic from the WSL network adapter.

## Background

- The `wsl-vpnkit` helper was the workaround for zScaler (https://github.com/sakai135/wsl-vpnkit). After switching from zScaler to Cisco AnyConnect, mirrored mode was the fix that worked on this machine.
