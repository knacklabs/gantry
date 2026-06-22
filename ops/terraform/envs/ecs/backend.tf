# Remote state backend for the ECS stack. PLACEHOLDERS — create the bucket and
# lock table once per account before `terraform init`. Use a distinct key from
# fleet/support so ECS experiments do not share state with ASG deployments.
#
# terraform init \
#   -backend-config="bucket=YOUR_TF_STATE_BUCKET" \
#   -backend-config="key=gantry/ecs/terraform.tfstate" \
#   -backend-config="region=YOUR_REGION" \
#   -backend-config="dynamodb_table=YOUR_TF_LOCK_TABLE" \
#   -backend-config="encrypt=true"
terraform {
  backend "s3" {
    # bucket         = "REPLACE_ME-tf-state"
    # key            = "gantry/ecs/terraform.tfstate"
    # region         = "REPLACE_ME"
    # dynamodb_table = "REPLACE_ME-tf-locks"
    # encrypt        = true
  }
}
