resource "aws_lightsail_container_service" "api" {
  name        = "paymyrent-${var.env}-api"
  power       = var.container_power
  scale       = var.container_scale
  is_disabled = false
  # Custom domain + managed TLS certificate are attached after DNS validation:
  #   aws lightsail create-certificate --certificate-name paymyrent-api --domain-name ${var.api_hostname}
  # then add public_domain_names here. Lightsail terminates TLS; plain HTTP to the service is redirected.
}

resource "aws_lightsail_database" "pg" {
  relational_database_name     = "paymyrent-${var.env}-pg"
  availability_zone            = "${var.region}a"
  master_database_name         = "paymyrent"
  master_username              = "pmr_admin"
  master_password              = random_password.db.result
  blueprint_id                 = var.db_blueprint
  bundle_id                    = var.db_bundle
  publicly_accessible          = false            # reachable only from Lightsail resources in this region
  backup_retention_enabled     = true             # daily automatic snapshots (7-day point-in-time)
  preferred_backup_window      = "20:30-21:00"    # 02:00–02:30 IST
  preferred_maintenance_window = "Sun:21:30-Sun:22:00"
  apply_immediately            = false
  final_snapshot_name          = "paymyrent-${var.env}-pg-final"
  skip_final_snapshot          = false
  # Lightsail managed databases are encrypted at rest by default and require TLS (sslmode=require).
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "database_url" {
  name  = "/paymyrent/${var.env}/RG_DATABASE_URL"
  type  = "SecureString"
  value = "postgresql+psycopg://pmr_admin:${random_password.db.result}@${aws_lightsail_database.pg.master_endpoint_address}:${aws_lightsail_database.pg.master_endpoint_port}/paymyrent?sslmode=require"
}
