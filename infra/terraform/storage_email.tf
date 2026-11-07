resource "aws_s3_bucket" "files" {
  bucket = "paymyrent-${var.env}-files-${data.aws_caller_identity.me.account_id}"
}
resource "aws_s3_bucket_public_access_block" "files" {
  bucket                  = aws_s3_bucket.files.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "files" {
  bucket = aws_s3_bucket.files.id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_kms_key" "files" {
  description         = "PayMyRent file encryption"
  enable_key_rotation = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.files.arn
    }
    bucket_key_enabled = true
  }
}
resource "aws_s3_bucket_versioning" "files" {
  bucket = aws_s3_bucket.files.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_policy" "tls_only" {
  bucket = aws_s3_bucket.files.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Sid = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*",
    Resource = [aws_s3_bucket.files.arn, "${aws_s3_bucket.files.arn}/*"],
    Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
}

resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain   # publish the DKIM CNAMEs it outputs; request production access (SES sandbox) for ap-south-1
}
