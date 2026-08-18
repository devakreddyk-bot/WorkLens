terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }

  # Intentionally no backend block. This module *creates* the remote backend, so it
  # cannot use it — the chicken-and-egg problem every Terraform setup hits once. Its
  # state stays local and is safe to commit: it describes an empty bucket and an empty
  # table, and contains no secret, no identifier that is not already public in the
  # account, and nothing that is expensive to recreate.
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Component = "terraform-state"
    }
  }
}
