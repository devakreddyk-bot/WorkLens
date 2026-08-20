# ---------------------------------------------------------------------------
# Remote state.
#
# Deliberately commented out, because a fresh clone cannot use it: the bucket and lock
# table do not exist yet, and `terraform init` against a non-existent backend fails
# before it can create anything. So the first apply uses local state, and the state is
# then migrated. Two steps, in this order:
#
#   1. Create the backend infrastructure. This is its own root module with its own local
#      state. That file is NOT in the repository: .gitignore's blanket *.tfstate matches it and
#      there is no negation. The reasoning below still holds — it holds no secret and nothing
#      expensive — but it is your responsibility to keep, not git's. Back it up, or reconcile a
#      prevent_destroy bucket and lock table by hand. Formerly this comment said 'committed', which
#      was wrong; verify with: git check-ignore -v infra/bootstrap/terraform.tfstate
#      The original reasoning, unchanged: safe to keep in the open, because it
#      describes nothing but an empty bucket and an empty table.
#
#          cd infra/bootstrap
#          terraform init
#          terraform apply
#
#      It prints the exact bucket and table names to paste below.
#
#   2. Uncomment this block, fill in the three values, and migrate:
#
#          cd infra
#          terraform init -migrate-state
#
#      Terraform copies the existing local state into S3 and confirms. From then on
#      `terraform init` is enough, and infra/terraform.tfstate can be deleted (it is
#      gitignored either way).
#
# Why bother, on a single-company deployment with one operator?
#
#   * State contains resource identifiers and, for some resources, generated values. It
#     belongs somewhere encrypted and versioned, not in a working directory that gets
#     copied between laptops.
#   * The lock table is what stops a second apply — a colleague, or CI — running against
#     half-applied state. That failure mode is silent and expensive.
#   * S3 versioning is the only realistic recovery from a corrupted or truncated state
#     file, and it has to be in place *before* the corruption, not after.
#
# The database password is not a concern here: RDS manages the master credential in
# Secrets Manager, so it never enters state at all.
# ---------------------------------------------------------------------------

# terraform {
#   backend "s3" {
#     # From the bootstrap module's `state_bucket_name` output.
#     bucket = "worklens-tfstate-REPLACE_ME"
#
#     # One key per environment. Changing this points at different state, which is how
#     # prod and staging coexist in one bucket.
#     key = "prod/terraform.tfstate"
#
#     region = "ap-south-1"
#
#     # From the bootstrap module's `lock_table_name` output.
#     dynamodb_table = "worklens-tfstate-locks"
#
#     # Server-side encryption with the bucket's default CMK.
#     encrypt = true
#   }
# }
