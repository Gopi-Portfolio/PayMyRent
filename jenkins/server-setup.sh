#!/usr/bin/env bash
# One-time setup of Jenkins. Run it on the app server itself (the free tier, one machine) or on a separate VM. Ubuntu 22.04 / 24.04, ARM or x86.
# Run it ON THAT VM as the normal user:   bash server-setup.sh
# Installs Docker, Java and Jenkins. Jenkins listens on 127.0.0.1 only: you reach it through an SSH tunnel (docs/JENKINS.md),
# so it is never exposed to the internet. Do NOT open port 8080 in the Oracle security list.
set -euo pipefail

sudo apt-get update
sudo apt-get install -y ca-certificates curl git gnupg fontconfig openjdk-17-jre

# Docker (the pipeline runs tests and builds the image with it)
if ! command -v docker >/dev/null 2>&1; then
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
fi

# Jenkins (long-term-support line)
sudo curl -fsSL https://pkg.jenkins.io/debian-stable/jenkins.io-2023.key -o /usr/share/keyrings/jenkins-keyring.asc
echo "deb [signed-by=/usr/share/keyrings/jenkins-keyring.asc] https://pkg.jenkins.io/debian-stable binary/" \
  | sudo tee /etc/apt/sources.list.d/jenkins.list >/dev/null
sudo apt-get update
sudo apt-get install -y jenkins
sudo usermod -aG docker jenkins

# listen on localhost only, and cap Jenkins' own memory at 1 GB so it cannot starve the API and database
sudo mkdir -p /etc/systemd/system/jenkins.service.d
printf '[Service]\nEnvironment="JENKINS_LISTEN_ADDRESS=127.0.0.1"\nEnvironment="JAVA_OPTS=-Xmx1g -Djava.awt.headless=true"\n' | sudo tee /etc/systemd/system/jenkins.service.d/override.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable jenkins
sudo systemctl restart jenkins

echo
echo "Done. Jenkins is starting (about a minute). Next: docs/JENKINS.md, step 4 (open it through the SSH tunnel)."
echo "First-login password:  sudo cat /var/lib/jenkins/secrets/initialAdminPassword"
