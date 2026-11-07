output "container_service_url" { value = aws_lightsail_container_service.api.url }
output "files_bucket"          { value = aws_s3_bucket.files.bucket }
output "deploy_role_arn"       { value = aws_iam_role.deploy.arn }
output "ses_dkim_tokens"       { value = aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens }
output "db_endpoint"           { value = aws_lightsail_database.pg.master_endpoint_address }
