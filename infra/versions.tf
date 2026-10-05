terraform {
  # 1.9 is the floor because the configuration uses variable validation blocks that
  # reference other variables, which earlier versions reject at parse time.
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Pinned to the v5 major. v6 changed provider-level defaults around default tags
      # and S3 bucket resources; moving to it is a deliberate upgrade with a plan review,
      # not something a fresh `terraform init` should do on its own.
      version = "~> 6.67"
    }

    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # Applied to every resource the provider creates, including ones this configuration
  # does not tag explicitly. Resource-level tags in the modules merge on top.
  default_tags {
    tags = local.common_tags
  }
}
