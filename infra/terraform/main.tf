# PayMyRent — AWS ap-south-1 (Mumbai). Low-cost start: Lightsail container service + Lightsail managed
# PostgreSQL (private, encrypted, automatic backups) + private S3 + SES + EventBridge schedules.
# See ../../docs/AWS_DEPLOYMENT.md for the ECS Fargate + RDS upgrade path.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.60" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "s3" {
    # Fill in once: an encrypted, versioned state bucket + DynamoDB lock table you create by hand.
    bucket         = "CHANGE-ME-paymyrent-tfstate"
    key            = "paymyrent/terraform.tfstate"
    region         = "ap-south-1"
    dynamodb_table = "paymyrent-tf-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { app = "paymyrent", env = var.env } }
}

data "aws_caller_identity" "me" {}
