// PayMyRent pipeline for Jenkins: test -> build the ARM image -> send it to the app server -> restart -> check health.
// Runs on the Oracle ARM server itself (Jenkins and the app share one machine for now), so the image is built natively and nothing
// needs a registry. If Jenkins moves to its own server, set APP_HOST to the app server's IP and the image is sent over SSH. See docs/JENKINS.md.
//
// Credentials this file expects (Manage Jenkins > Credentials):
//   oracle-app-ssh         SSH Username with private key   (user "ubuntu" + the deploy key; its public half is on the app server)
//   oracle-app-known-hosts Secret file                      (one line: the app server's host key, from ssh-keyscan -t ed25519 <APP_HOST>)
pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()                      // two deploys at the same time would fight over the server
    timeout(time: 60, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  // Jenkins looks at GitHub every 3 minutes (no webhook needed, so Jenkins never has to be reachable from the internet).
  triggers { pollSCM('H/3 * * * *') }

  environment {
    APP_HOST   = '127.0.0.1'                                           // where the app runs: 127.0.0.1 = this same server; otherwise its IP
    APP_USER   = 'ubuntu'
    HEALTH_URL = 'https://161-153-65-47.sslip.io/api/v1/health'        // the public address (a domain later)
  }

  stages {
    stage('Backend tests') {
      steps {
        // starts a throwaway Postgres 16, runs the whole suite, removes it
        sh 'bash scripts/build-backend.sh --test-only'
      }
    }

    stage('Mobile checks') {
      steps {
        // type check, translations, Jest, in a clean Node container
        sh '''#!/bin/bash
          set -euo pipefail
          # runs as the Jenkins user (not root) so the workspace can be cleaned up afterwards
          docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/.npm \
            -v "$WORKSPACE/mobile:/app" -w /app node:22 sh -c \
            "npm ci --legacy-peer-deps && npx tsc --noEmit && node scripts/check-i18n.mjs && npx jest --ci --forceExit"
        '''
      }
    }

    stage('Build image') {
      steps {
        script {
          env.IMAGE = 'paymyrent-api:' + sh(script: 'git rev-parse --short=12 HEAD', returnStdout: true).trim()
        }
        sh 'docker build -t "$IMAGE" -t paymyrent-api:latest api'
      }
    }

    stage('Deploy') {
      when { expression { env.GIT_BRANCH in ['origin/main', 'main'] } }      // only the main branch reaches the server
      steps {
        withCredentials([
          sshUserPrivateKey(credentialsId: 'oracle-app-ssh', keyFileVariable: 'KEY'),
          file(credentialsId: 'oracle-app-known-hosts', variable: 'KNOWN')
        ]) {
          sh '''#!/bin/bash
            set -euo pipefail
            SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o UserKnownHostsFile="$KNOWN" -o StrictHostKeyChecking=yes "$APP_USER@$APP_HOST")
            # 1. the deploy files (compose file, Caddy config, scripts)
            tar -czf - docker-compose.prod.yml deploy scripts | "${SSH[@]}" "mkdir -p /opt/paymyrent/app && tar -xzf - -C /opt/paymyrent/app"
            # 2. the image, straight to the server (no registry). Not needed when Jenkins and the app share one server: it is already there.
            if [ "$APP_HOST" != "127.0.0.1" ]; then
              docker save "$IMAGE" | gzip | "${SSH[@]}" "gunzip | docker load"
            fi
            # 3. restart on the new image; the script waits until the API is healthy
            "${SSH[@]}" "cd /opt/paymyrent/app && API_IMAGE='$IMAGE' bash scripts/deploy-backend.sh"   # bash: the file has no executable flag (made on Windows)
          '''
        }
      }
    }

    stage('Check the live API') {
      when { expression { env.GIT_BRANCH in ['origin/main', 'main'] } }
      steps {
        sh 'curl --fail --silent --show-error --retry 10 --retry-delay 6 --retry-connrefused "$HEALTH_URL"'
      }
    }
  }

  post {
    success { echo "Deployed ${env.IMAGE ?: ''} - rollback: ssh to the app server and run API_IMAGE=<older paymyrent-api tag> scripts/deploy-backend.sh" }
    failure { echo 'Build failed. Open the failed stage above; the app server keeps running the previous version.' }
  }
}
