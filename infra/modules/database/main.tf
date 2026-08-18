# ---------------------------------------------------------------------------
# RDS PostgreSQL 16, single instance, private subnets, IAM authentication.
#
# There is no master password in this configuration or in state:
# manage_master_user_password hands generation and rotation to RDS, which
# stores the credential in Secrets Manager under the rds CMK. The application
# does not use it at all - the Lambdas authenticate with rds-db:connect tokens.
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

resource "aws_db_subnet_group" "this" {
  name        = "${var.name_prefix}-db"
  description = "${var.name_prefix} private DB subnet group"
  subnet_ids  = var.subnet_ids

  tags = merge(var.tags, { Name = "${var.name_prefix}-db-subnet-group" })
}

resource "aws_db_parameter_group" "this" {
  name        = "${var.name_prefix}-pg16"
  family      = var.parameter_group_family
  description = "${var.name_prefix} PostgreSQL parameters: TLS enforced, slow queries and DDL logged"

  # Reject any non-TLS connection at the engine level, not just at the SG.
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = tostring(var.log_min_duration_statement_ms)
  }

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  # DDL only. Statement text is never logged for DML, so no employee data
  # reaches CloudWatch through the query log.
  parameter {
    name  = "log_statement"
    value = "ddl"
  }

  parameter {
    name  = "log_lock_waits"
    value = "1"
  }

  tags = var.tags

  lifecycle {
    create_before_destroy = true
  }
}

# Pre-created so the exported PostgreSQL log is encrypted with our CMK and has
# a bounded retention. RDS writes into this group instead of creating its own.
resource "aws_cloudwatch_log_group" "postgresql" {
  name              = "/aws/rds/instance/${var.name_prefix}-pg/postgresql"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn

  tags = var.tags
}

resource "aws_db_instance" "this" {
  identifier = "${var.name_prefix}-pg"

  engine                      = "postgres"
  engine_version              = var.engine_version
  allow_major_version_upgrade = false
  auto_minor_version_upgrade  = var.auto_minor_version_upgrade
  instance_class              = var.instance_class

  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage == var.allocated_storage ? null : var.max_allocated_storage
  storage_type          = var.storage_type
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  db_name  = var.db_name
  username = var.master_username
  port     = var.database_port

  # RDS generates, stores and rotates the master password in Secrets Manager.
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_arn

  iam_database_authentication_enabled = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = var.vpc_security_group_ids
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false
  multi_az               = var.multi_az
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  backup_retention_period   = var.backup_retention_period
  backup_window             = var.backup_window
  maintenance_window        = var.maintenance_window
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name_prefix}-pg-final"

  deletion_protection = var.deletion_protection
  apply_immediately   = var.apply_immediately

  enabled_cloudwatch_logs_exports = ["postgresql"]

  performance_insights_enabled = var.performance_insights_enabled
  # Enhanced monitoring off: the standard CloudWatch metrics carry the alarms
  # defined in the observability module, at no extra cost.
  monitoring_interval = 0

  tags = merge(var.tags, { Name = "${var.name_prefix}-pg" })

  depends_on = [aws_cloudwatch_log_group.postgresql]

  lifecycle {
    # Deliberately false, despite this being the production database. `prevent_destroy`
    # cannot be driven by a variable, so setting it true would make a legitimate teardown
    # of a staging stack require editing this module — and someone editing a shared module
    # to delete their own environment is worse than the protection is worth.
    #
    # The guard is `deletion_protection` (var.deletion_protection, default true) instead:
    # it is enforced by RDS itself rather than by Terraform, so it also blocks a deletion
    # attempted from the console or the CLI, and it can be turned off per environment
    # without touching code.
    prevent_destroy = false
  }
}
