#!/usr/bin/env bash
# One-time setup of the Oracle VM (Ubuntu 22.04 / 24.04, ARM or x86). Run it ON THE SERVER as the normal user:
#   bash server-setup.sh
# It installs Docker, opens ports 80 and 443 in the VM's own firewall, and creates /opt/paymyrent.
# (You must ALSO open 80 and 443 in the Oracle console: VCN -> Security List -> Ingress Rules. Never open 5432 or 8000.)
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl git
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
fi

# Oracle's Ubuntu images ship iptables rules that only allow SSH. Insert 80/443 ahead of the final REJECT rule.
# The position is looked up (not hard-coded): a rule BELOW the REJECT row is never used.
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    pos=$(sudo iptables -L INPUT --line-numbers -n | awk '$2=="REJECT"{print $1; exit}')
    sudo iptables -I INPUT "${pos:-1}" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  fi
done
sudo apt-get install -y iptables-persistent >/dev/null
sudo netfilter-persistent save

sudo mkdir -p /opt/paymyrent && sudo chown "$USER":"$USER" /opt/paymyrent
echo
echo "Done. Log out and back in once so the docker group applies, then follow docs/ORACLE_DEPLOYMENT.md (step 4 onwards)."
