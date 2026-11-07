#!/usr/bin/env bash
# Build the API image, push it to the Lightsail container service and deploy with secrets from SSM.
# Used by .github/workflows/deploy.yml (OIDC credentials) or by hand with an admin profile.
set -euo pipefail
ENV=${ENV:-prod}; REGION=${AWS_REGION:-ap-south-1}; SERVICE="paymyrent-${ENV}-api"; TAG=${GITHUB_SHA:-$(git rev-parse --short HEAD)}
docker build -t "paymyrent-api:${TAG}" api
aws lightsail push-container-image --region "$REGION" --service-name "$SERVICE" --label api --image "paymyrent-api:${TAG}"
IMAGE=$(aws lightsail get-container-images --region "$REGION" --service-name "$SERVICE" --query 'containerImages[0].image' --output text)
param() { aws ssm get-parameter --region "$REGION" --with-decryption --name "/paymyrent/${ENV}/$1" --query Parameter.Value --output text; }
ENVJSON=$(jq -n \
  --arg db "$(param RG_DATABASE_URL)" --arg job "$(param RG_JOB_TRIGGER_SECRET)" --arg fb "$(param RG_FIREBASE_PROJECT_ID)" \
  --arg otp "$(param RG_OTP_HASH_SECRET)" --arg devjwt "$(param RG_DEV_JWT_SECRET)" \
  --arg subkey "$(param RG_SUBSCRIPTION_KEY_ID)" --arg subsec "$(param RG_SUBSCRIPTION_KEY_SECRET)" --arg subwh "$(param RG_SUBSCRIPTION_WEBHOOK_SECRET)" \
  --arg rentkey "$(param RG_RENT_KEY_ID)" --arg rentsec "$(param RG_RENT_KEY_SECRET)" --arg rentwh "$(param RG_RENT_WEBHOOK_SECRET)" \
  --arg akid "$(param AWS_ACCESS_KEY_ID)" --arg asec "$(param AWS_SECRET_ACCESS_KEY)" --arg bucket "$(param RG_S3_BUCKET)" \
  --arg base "$(param RG_PUBLIC_BASE_URL)" \
  '{RG_APP_ENV:"production", RG_DEV_AUTH_ENABLED:"false", RG_DATABASE_URL:$db, RG_JOB_TRIGGER_SECRET:$job, RG_FIREBASE_PROJECT_ID:$fb,
    RG_OTP_HASH_SECRET:$otp, RG_DEV_JWT_SECRET:$devjwt, RG_SUBSCRIPTION_PROVIDER:"razorpay", RG_SUBSCRIPTION_KEY_ID:$subkey,
    RG_SUBSCRIPTION_KEY_SECRET:$subsec, RG_SUBSCRIPTION_WEBHOOK_SECRET:$subwh, RG_RENT_PROVIDER:"razorpay", RG_RENT_KEY_ID:$rentkey,
    RG_RENT_KEY_SECRET:$rentsec, RG_RENT_WEBHOOK_SECRET:$rentwh, RG_EMAIL_PROVIDER:"ses", RG_STORAGE_BACKEND:"s3", RG_S3_BUCKET:$bucket,
    RG_AI_PROVIDER:"bedrock", RG_PUBLIC_BASE_URL:$base, AWS_ACCESS_KEY_ID:$akid, AWS_SECRET_ACCESS_KEY:$asec, AWS_DEFAULT_REGION:"ap-south-1"}')
aws lightsail create-container-service-deployment --region "$REGION" --service-name "$SERVICE" \
  --containers "$(jq -n --arg img "$IMAGE" --argjson env "$ENVJSON" '{api:{image:$img, environment:$env, ports:{"8000":"HTTP"}}}')" \
  --public-endpoint '{"containerName":"api","containerPort":8000,"healthCheck":{"path":"/api/v1/health","intervalSeconds":15,"healthyThreshold":2,"unhealthyThreshold":3}}'
echo "Deployment started for ${SERVICE} (${TAG}). Migrations run on container start (alembic upgrade head)."
