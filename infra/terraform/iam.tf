# Lightsail container services cannot assume IAM roles, so the app uses a dedicated IAM user with a
# minimal policy. Its access key lives only in SSM (SecureString) and is injected at deploy time.
# Rotate every 90 days (infra/scripts/rotate_app_key.sh). On ECS this becomes a task role (no keys).
resource "aws_iam_user" "app" { name = "paymyrent-${var.env}-app" }

resource "aws_iam_user_policy" "app" {
  user = aws_iam_user.app.name
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject"], Resource = "${aws_s3_bucket.files.arn}/*" },
    { Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = aws_kms_key.files.arn },
    { Effect = "Allow", Action = ["ses:SendEmail"], Resource = aws_sesv2_email_identity.domain.arn },
    { Effect = "Allow", Action = ["bedrock:InvokeModel", "bedrock:Converse"],
      Resource = ["arn:aws:bedrock:${var.region}::foundation-model/*", "arn:aws:bedrock:*:${data.aws_caller_identity.me.account_id}:inference-profile/*"] },
  ] })
}

# GitHub Actions deploys with short-lived OIDC credentials — no AWS keys in GitHub.
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

resource "aws_iam_role" "deploy" {
  name = "paymyrent-${var.env}-github-deploy"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Federated = aws_iam_openid_connect_provider.github.arn }, Action = "sts:AssumeRoleWithWebIdentity",
    Condition = { StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com",
                                   "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:environment:${var.env}" } } }] })
}

resource "aws_iam_role_policy" "deploy" {
  role = aws_iam_role.deploy.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["lightsail:PushContainerImage", "lightsail:RegisterContainerImage", "lightsail:CreateContainerServiceDeployment",
                                  "lightsail:GetContainerServices", "lightsail:GetContainerServiceDeployments", "lightsail:GetContainerImages"],
      Resource = "*" },
    { Effect = "Allow", Action = ["ssm:GetParameter", "ssm:GetParametersByPath"], Resource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.me.account_id}:parameter/paymyrent/${var.env}/*" },
  ] })
}
