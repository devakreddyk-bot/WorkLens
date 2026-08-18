output "state_bucket_name" {
  description = "Paste this into the `bucket` field of infra/backend.tf."
  value       = aws_s3_bucket.state.id
}

output "lock_table_name" {
  description = "Paste this into the `dynamodb_table` field of infra/backend.tf."
  value       = aws_dynamodb_table.locks.name
}

output "region" {
  description = "Paste this into the `region` field of infra/backend.tf."
  value       = var.aws_region
}

output "backend_block" {
  description = "The exact block to uncomment and fill in at infra/backend.tf, ready to copy."
  value       = <<-EOT

    terraform {
      backend "s3" {
        bucket         = "${aws_s3_bucket.state.id}"
        key            = "prod/terraform.tfstate"
        region         = "${var.aws_region}"
        dynamodb_table = "${aws_dynamodb_table.locks.name}"
        encrypt        = true
      }
    }

    Then, from infra/:   terraform init -migrate-state

  EOT
}
