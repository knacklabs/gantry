# Remote state backend. PLACEHOLDERS — create the bucket and lock table once per
# account before `terraform init` (see docs/deployment/aws-terraform.md). No
# secret values live in state, but state still describes infrastructure, so keep
# the bucket private, encrypted, and versioned.
#
# Initialize with these values (do not commit real ones into the block if you
# prefer): terraform init \
#   -backend-config="bucket=YOUR_TF_STATE_BUCKET" \
#   -backend-config="key=gantry/fleet/terraform.tfstate" \
#   -backend-config="region=YOUR_REGION" \
#   -backend-config="dynamodb_table=YOUR_TF_LOCK_TABLE" \
#   -backend-config="encrypt=true"
#
# `terraform ... validate` and CI use `-backend=false`, which ignores this block.
terraform {
  backend "s3" {
    # bucket         = "REPLACE_ME-tf-state"
    # key            = "gantry/fleet/terraform.tfstate"
    # region         = "REPLACE_ME"
    # dynamodb_table = "REPLACE_ME-tf-locks"
    # encrypt        = true
  }
}
