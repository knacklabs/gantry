# Remote state backend for the locked support stack. PLACEHOLDERS — create the
# bucket and lock table once per account before `terraform init`. Use a DISTINCT
# state key from the fleet env so the support stack is isolated.
#
# terraform init \
#   -backend-config="bucket=YOUR_TF_STATE_BUCKET" \
#   -backend-config="key=gantry/support/terraform.tfstate" \
#   -backend-config="region=YOUR_REGION" \
#   -backend-config="dynamodb_table=YOUR_TF_LOCK_TABLE" \
#   -backend-config="encrypt=true"
terraform {
  backend "s3" {
    # bucket         = "REPLACE_ME-tf-state"
    # key            = "gantry/support/terraform.tfstate"
    # region         = "REPLACE_ME"
    # dynamodb_table = "REPLACE_ME-tf-locks"
    # encrypt        = true
  }
}
