# Jenkins: push to git, the server updates itself

```
You push to main
   └─ Jenkins (on the Oracle server) checks GitHub every 3 minutes
        1. backend tests        (throwaway Postgres, whole suite)
        2. mobile checks        (types, translations, Jest)
        3. build the API image  (ARM, built natively on the server)
        4. copy the deploy files, restart the app, wait until it is healthy
        5. check https://<API_DOMAIN>/api/v1/health
```

## Where Jenkins runs
**Now: on the same Oracle server as the app** (free tier, one machine). The Jenkinsfile has `APP_HOST = '127.0.0.1'`.
Be aware of what that means:
- Jenkins can run Docker, which is root-equivalent on this machine, and it can read the app's deploy files. **Anyone who gets into Jenkins gets the app server.** So Jenkins is never exposed: it listens on `127.0.0.1` only and you reach it through an SSH tunnel. Use a strong admin password and install no extra plugins.
- Builds and tests use CPU, memory and disk on the machine that also serves users. Builds take a few minutes and may slow the API briefly. Jenkins' own memory is capped at 1 GB. Deploy at quiet times when you can.
- Docker images pile up: the deploy script removes unused images older than two weeks. Watch the disk (`df -h`).

**Later (paid tier): its own server.** Create a second instance, run `jenkins/server-setup.sh` there, and set `APP_HOST` in the `Jenkinsfile` to the app server's IP. Nothing else changes: the image is then sent over SSH.

## 1. Install Jenkins
```powershell
# on your PC
scp -i "<app-server-key-file>" C:\paymyrent\PayMyRent\jenkins\server-setup.sh ubuntu@161.153.65.47:~/
ssh -i "<app-server-key-file>" ubuntu@161.153.65.47
```
```bash
# on the server
bash server-setup.sh        # installs Java and Jenkins, starts it on 127.0.0.1:8080 only
```
Do **not** open port 8080 in the Oracle security list.

## 2. Let Jenkins log in to the server's `ubuntu` user over SSH
Jenkins deploys by running `ssh ubuntu@127.0.0.1` with the deploy key (its public half is already in `~/.ssh/authorized_keys`). Collect the one line Jenkins needs to trust the host:
```bash
ssh-keyscan -t ed25519 127.0.0.1 2>/dev/null | grep ssh-ed25519
```
Save that line in a text file named `known_hosts.txt` on your PC (you upload it in step 4).

## 3. Open Jenkins through the SSH tunnel
```powershell
ssh -i "<app-server-key-file>" -L 8080:localhost:8080 ubuntu@161.153.65.47
```
Leave that window open and browse to **http://localhost:8080**. In that SSH window run `sudo cat /var/lib/jenkins/secrets/initialAdminPassword` and paste it. Choose **Install suggested plugins**, then create your admin user with a strong password.

## 4. Add the three credentials
**Manage Jenkins → Credentials → System → Global credentials → Add Credentials**

| Kind | ID (exactly) | Content |
|---|---|---|
| Username with password | `github` | your GitHub username + a personal access token that can read the repository (`repo` scope for a classic token) |
| SSH Username with private key | `oracle-app-ssh` | Username `ubuntu`; *Enter directly* the private key (PC: `Get-Content $env:USERPROFILE\.ssh\paymyrent_deploy -Raw \| Set-Clipboard`, then paste) |
| Secret file | `oracle-app-known-hosts` | upload `known_hosts.txt` from step 2 |

Treat the GitHub token like a password. Anyone who can use it can also push code.

## 5. Create the job
**New Item → name `paymyrent` → Pipeline**
- *Build Triggers*: leave empty (the `Jenkinsfile` already polls GitHub).
- *Pipeline → Definition*: **Pipeline script from SCM**, SCM **Git**.
- Repository URL `https://github.com/Gopi-Portfolio/PayMyRent.git`, credentials `github`, branch `*/main`, script path `Jenkinsfile`.
- Save, then **Build Now** once. After that every push to `main` is picked up within about 3 minutes.

## 6. Day to day
- A build is green only if the tests pass **and** the app answers its health check.
- **A failed build never replaces a working app**: the old containers keep running until the new image is ready.
- **Rollback**: list the old images with `docker images paymyrent-api`, then
  `cd /opt/paymyrent/app && API_IMAGE=paymyrent-api:<older tag> scripts/deploy-backend.sh`.
- When the domain is added, edit `HEALTH_URL` at the top of the `Jenkinsfile`.

## 7. Keep Jenkins safe
- Never open port 8080 to the internet. Use the tunnel.
- Update monthly: `sudo apt-get update && sudo apt-get upgrade`, and plugins under **Manage Jenkins → Plugins**.
- Back up `/var/lib/jenkins` (jobs and credentials) now and then.
- Only people you trust may have a Jenkins login: whoever can edit the job or push to `main` can run commands on the server.
