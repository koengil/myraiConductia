#!/bin/bash
# First-boot setup of a CI runner host (cloud-init runcmd, as root). Installs the
# toolchain, the CloudWatch agent and the GitHub Actions runner, then hands
# registration to ci-runner-register.service. Holds no secret.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

log() { echo "ci-runner setup: $*"; }

mkdir -p /var/lib/ci-runner /opt/hostedtoolcache /opt/actions-runner
date +%s > /var/lib/ci-runner/last-activity

log "apt packages"
apt-get update -q
apt-get install -y -q --no-install-recommends \
  docker.io docker-compose-v2 git jq unzip curl postgresql-client build-essential \
  ca-certificates psmisc xz-utils

log "gh from GitHub's apt repository"
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
apt-get update -q
apt-get install -y -q gh

log "aws cli (snap) for the PAT read"
snap install aws-cli --classic

log "runner user"
id runner >/dev/null 2>&1 || useradd --create-home --shell /bin/bash runner
usermod -aG docker runner
echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-ci-runner
chmod 0440 /etc/sudoers.d/90-ci-runner
touch /var/log/ci-runner-hooks.log
chown runner:runner /var/log/ci-runner-hooks.log /var/lib/ci-runner /var/lib/ci-runner/last-activity /opt/hostedtoolcache /opt/actions-runner
systemctl enable --now docker

log "CloudWatch agent"
curl -fsSL -o /tmp/amazon-cloudwatch-agent.deb https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb
dpkg -i -E /tmp/amazon-cloudwatch-agent.deb
rm -f /tmp/amazon-cloudwatch-agent.deb
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/ci-runner.json

# Node 22 on the PATH, as on GitHub's images: jobs such as `changes` run plain
# `node` without setup-node. Checksum-verified, installed into /usr/local.
log "Node.js 22"
node_tmp=$(mktemp -d)
base=https://nodejs.org/dist/latest-v22.x
line=$(curl -fsSL "$base/SHASUMS256.txt" | grep -E ' node-v[0-9.]+-linux-x64\.tar\.xz$')
file=${line##* }
curl -fsSL -o "$node_tmp/$file" "$base/$file"
(cd "$node_tmp" && echo "$line" | sha256sum -c --quiet -)
tar -xJf "$node_tmp/$file" -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE
rm -rf "$node_tmp"

# Playwright's chromium system packages, so `playwright install --with-deps` in a
# job only fetches the browser. A failure here only makes those jobs slower.
log "Playwright chromium system dependencies"
if npx -y playwright@1 install-deps chromium; then log "playwright deps installed"; else log "WARNING: playwright install-deps failed"; fi
rm -rf /root/.npm

log "GitHub Actions runner"
release=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)
version=$(jq -r '.tag_name | ltrimstr("v")' <<<"$release")
asset="actions-runner-linux-x64-$version.tar.gz"
digest=$(jq -r --arg n "$asset" '.assets[] | select(.name == $n) | .digest // empty' <<<"$release")
curl -fsSL -o "/tmp/$asset" "https://github.com/actions/runner/releases/download/v$version/$asset"
if [ -n "$digest" ]; then
  echo "${digest#sha256:}  /tmp/$asset" | sha256sum -c --quiet -
fi
tar -xzf "/tmp/$asset" -C /opt/actions-runner
rm -f "/tmp/$asset"
/opt/actions-runner/bin/installdependencies.sh
chown -R runner:runner /opt/actions-runner
log "runner $version unpacked"

# Job hooks: both names point at clean.sh, which logs the name it was called by.
ln -sf /opt/ci-runner/clean.sh /opt/ci-runner/job-started.sh
ln -sf /opt/ci-runner/clean.sh /opt/ci-runner/job-completed.sh

systemctl daemon-reload
systemctl enable ci-runner-idle-stop.timer ci-runner-register.service
systemctl start ci-runner-idle-stop.timer
systemctl start --no-block ci-runner-register.service
log "done"
