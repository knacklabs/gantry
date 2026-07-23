# Terraform Playbook for Infrastructure as Code - v1.0

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

## Introduction
Welcome to the Terraform Playbook for Infrastructure as Code. This playbook is split into 2 parts, covering the following:
- Enforce and Ensure TF Coding best practices are followed:.
  - Via KnackLabs Terraform Coding Standard v1.0 Document.
  - VsCode TF extension
- Terraform CI / Automation best practices covering the following:
  - TF Fmt
  - TFSec
  - TFCost
![image](https://s3-us-west-2.amazonaws.com/secure.notion-static.com/36ec8667-f627-48bc-a1db-7b8105b3e787/Terraform_CICD_Pipeline_-_Page_2.png)
In this playbook, we'll cover the standards to be followed while setting up your Terraform environment, writing Terraform code, managing costs & security with Terraform, and deploying and managing infrastructure with Terraform. We'll also introduce best practices for organizing your Terraform code, using Terraform modules to manage complex infrastructure, and using Terraform Lint to ensure code quality.

### Setting Up Terraform Environment
To Download and install Terraform, please follow the official guide - [link](https://developer.hashicorp.com/terraform/downloads)

#### General Terraform Best Practices:
- Terraform code should be organized by environment, for example `infra/dev`, `infra/uat`, or `infra/prod`.
- We no longer create project infrastructure primarily through reusable custom modules. The current standard is to keep Terraform resources in the environment directory and split them into clear, resource/domain-specific `.tf` files.
- Do not create ad hoc standalone Terraform scripts outside the approved infrastructure directory. All resources for an environment should live together so the plan, state, variables, and dependencies are reviewed as one unit.
- Use separate files for each major resource area, for example:
  - `backend.tf` for backend configuration and required providers
  - `variables.tf` for input variables
  - `locals.tf` for shared naming and computed values
  - `data.tf` for data sources
  - `vpc.tf` for VPC, subnets, route tables, and gateway resources
  - `security_groups.tf` for security groups and rules
  - `iamrole.tf` for IAM roles, policies, and attachments
  - `ecr.tf` for ECR repositories and lifecycle policies
  - `ecs.tf`, `ecs_*.tf`, and `ecs-capacity-*.tf` for ECS clusters, services, tasks, and capacity providers
  - `alb-*.tf` for load balancers, listeners, and target groups
  - `cloudfront_*.tf` for CloudFront distributions
  - `ssm.tf` for SSM parameters
  - `alerts.tf`, `alert-setup.tf`, and `autoscaling.tf` for monitoring, alerts, and scaling
- Resource naming should follow the shared naming convention built from `locals.tf`, using values such as parent organization, cloud provider, region, environment, and project.
- Environment-specific values should be passed through `terraform.tfvars` or the relevant environment variable mechanism. Sensitive values must be handled as sensitive variables and should not be hardcoded into resource files.
- Terraform code must go through quality gates before provisioning actual infrastructure, including formatting, validation, security review, cost review where applicable, and pull request review.
- Any team or person outside KnackLabs’s DevOps team wanting to contribute to the Terraform codebase should submit a pull request to the DevOps team for review.
- Do not copy Terraform examples directly from the Terraform Registry, Stack Overflow, or other external sources without adapting them to KnackLabs’s standards, naming conventions, backend setup, tagging model, and review process.
- External/community modules should only be used when there is a clear reason and the module is explicitly reviewed and pinned to a version. Do not introduce new custom module trees for normal project resource
```markdown
## Current Folder Structure

The current Terraform layout keeps each environment self-contained:

infra/
└── dev/
    ├── backend.tf
    ├── variables.tf
    ├── locals.tf
    ├── data.tf
    ├── terraform.tfvars
    ├── vpc.tf
    ├── security_groups.tf
    ├── iamrole.tf
    ├── ecr.tf
    ├── ecs.tf
    ├── ecs_*.tf
    ├── alb-*.tf
    ├── cloudfront_*.tf
    ├── ssm.tf
    ├── alerts.tf
    ├── alert-setup.tf
    └── autoscaling.tf
```
This structure keeps all resources for an environment in one Terraform root module while still separating files by responsibility. It makes plans easier to review because related resources are close together and all environment dependencies are visible in the same directory.

### Resource Creation
Terraform resources should be written directly in the environment’s Terraform root module and grouped into the appropriate file by resource/domain.
Example:
```plain text
resource "aws_vpc" "vpc" {
  cidr_block           = var.aws_vpc_cidr_block
  enable_dns_support   = var.enable_dns_support
  enable_dns_hostnames = var.enable_dns_hostnames

  tags = {
    Name = "${local.parent_org_name}-${local.cloud_provider}-${local.region}-${local.environment}-vpc-${local.project}"
  }
}
```
Related resources should stay in the same resource file. For example, VPC, subnets, route tables, route table associations, and internet gateway resources belong in `vpc.tf`; security groups and security group rules belong in `security_groups.tf`.
Inputs should be declared in `variables.tf`:
```plain text
variable "aws_vpc_cidr_block" {
  type = string
}
```
Environment values should be provided through `terraform.tfvars`:
```plain text
aws_region           = "ap-south-1"
aws_vpc_cidr_block   = "10.0.0.0/16"
enable_dns_support   = true
enable_dns_hostnames = true

parent_org_name = "knacklabs"
cloud_provider  = "aws"
region          = "aps1"
environment     = "dev"
project         = "ats"
```
Shared naming and derived values should be defined in `locals.tf` and reused across resource files.
By using this single-root, resource-file-based layout, the Terraform code remains easy to review, avoids unnecessary module indirection, and keeps environment-specific infrastructure changes explicit

### Module Creation
Here at KnackLabs, we use a combination of community and custom modules to help speed up the development and provide accessibility to the developers. Creating Terraform modules involves defining reusable infrastructure components that can be easily reused across different Terraform projects. Modules allow for the creation of self-contained pieces of infrastructure code that can be easily tested, maintained, and versioned. We have developed a host of custom modules, including a module for [VPC, RDS, ALB](https://github.com/knacklabs-ai/aws-terraform-modules), etc.
In the case of community modules being used, these are never fetched from the registry, a custom version compatible with the infrastructure is made available offline as part of the project, and any changes needed for the module are made and pushed as part of the same project so that any version updates do not break existing functionality.
```json
module "vpc" {
  source = "../aws-terraform-modules/terraform-aws-vpc-master"

  name  = "Example-vpc"
  cidr  = "10.0.0.0/16"
}
```
In the example above, `terraform-aws-vpc-master` module is referenced using the module block, which specifies the source as the path to the module's files. The name and cidr variable is passed to the module to specify a different name than the default value in the module.
When you run terraform apply, Terraform will use the module to create a VPC with the specified name.
By using offline module creation and referencing in Terraform, you can create reusable Terraform configurations as separate modules and reference them in your main configuration, which can help you simplify and organize your infrastructure code.

## Terraform Coding Best Practices at KnackLabs

### Terraform Syntax and Configuration Files
Terraform uses declarative language designed to be easy to read and understand. Terraform code is written in HashiCorp Configuration Language (HCL), similar to JSON or YAML. In HCL, resources are defined using blocks, and each contains one or more arguments configuring the resource. For example, here is a simple resource block that defines an AWS EC2 instance:
```javascript
resource "aws_instance" "example" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t2.micro"
}
```
- Descriptive names: Use descriptive and meaningful names for resources, variables, and outputs. This makes it easier to understand what each resource does and how it relates to other resources. For more information on naming and tagging, refer to the naming and tagging convention playbook here.
```javascript
resource "aws_cloudfront_distribution" "this-landing-pages-cdn-portal" {
 origin {
   domain_name = data.aws_s3_bucket.this-landing-pages-s3-bucket.bucket_domain_name
   origin_id   = data.aws_s3_bucket.this-landing-pages-s3-bucket.bucket_domain_name
 }
}
```
- Use of modules: Modularize your Terraform code to make it more reusable and easier to maintain. Use separate modules for each part of your infrastructure, and pass variables between modules to configure them. Please refer to this repository for more information on the modules being used.
- Version Control: Use a version control system such as Git to manage changes to your Terraform code. This makes it easier to track changes and roll back to previous versions if necessary. Using git also helps the DevOps team have a single origin of truth for the infrastructure being deployed, and any changes are documented and can be rolled back.
- Terraform Lint(TFLint): Use Terraform Lint to ensure your code follows best practices and avoids common mistakes. Terraform Lint is a tool that checks your Terraform code for errors, formatting, and style issues.

### Practices for Writing Clean, Maintainable Terraform Code
Writing Terraform code that is easy to read, maintain, and update is critical for any IAAC implementation. In this section, we will cover best practices being used for writing clean Terraform code:

#### Organize Terraform code using modules
Breaking down Terraform code into smaller, reusable modules helps to keep the code organized and maintainable. Each module should focus on a specific set of resources or functionality and have clearly defined inputs and outputs. For example:
```json
module "my_s3_module" {
  source = "./my-s3-module.zip"

  bucket_name = "my-other-bucket"
}
```

#### Use version control to manage Terraform code.
Version control allows you to track changes to your Terraform code and collaborate with others. Using Git is a common way to manage Terraform code and can help you keep track of changes, roll back to previous versions, and collaborate with others.

#### Implementing naming conventions for resources and variables
Consistent naming conventions make it easier to understand and maintain Terraform code. Use descriptive names for resources and variables that are easy to understand and follow a consistent naming convention defined in the [naming conventions playbook](/553bbdbedb9246148f81e340f37e6898).
ECS
- knacklabs-aws-aps1-prod-ecs-acme-strapi-*testing (Denotes a testing instance)*
- *acme-aws-aps1-prod-ecs-acmev2-landing_pages*
- *knacklabs-aws-aps1-acme-prod-ecs-acmev2-backend (Denotes KnackLabs account ílhosting acme infra)*
- *knacklabs-aws-aps1-prod-ecs-acmev2-strapi*
RDS
- acme-aws-aps1-stage-rds-calibrate-RdsName-*01-replica* (Denotes role is replica)
- *acme-aws-aps1-prod-rds-acmev2-master*
- *acme-aws-aps1-prod-rds-acmev2-strapi-master*
ACCOUNT NAME
- acme-aws-aps1-prod-acmev2
S3:
- acme-aws-usw2-prod-s3-acmev2-rds_logs-*private* (Denotes bucket is private)

#### Always use the remote state.
The remote state allows you to share data between different Terraform projects. This can be helpful when multiple projects need to reference the same data. 
By using remote state with S3 and DynamoDB in Terraform, you can store the state of your infrastructure in a shared remote backend that can be used by multiple Terraform configurations, which can help you maintain a consistent and up-to-date state of your infrastructure.
DynamoDB is a popular remote backend for storing Terraform state because it provides locking to prevent concurrent modifications and can handle high concurrency.
```javascript
terraform {
  backend "s3" {
    bucket = "knacklabs-aws-aps1-dev-s3-acme-main-tfstate-bucket"
    key    = "s3-backend-acme-core-infra-module.tfstate"
    region = "ap-south-1"
		dynamodb_table = "knacklabs-aws-aps1-dev-dynamo_db-acme-stateLock-db"
  }
}
```

#### Use of Default Values
In Terraform, you can set default values for variables in your Terraform module so that the default value will be used instead if a value is not provided when the module is called. Here's an example of how to use default values in Terraform variables:
Define your variables: In your module, define your variables as usual, and set the default value using the default parameter.
```json
variable "region" {
  type        = string
  description = "The AWS region to use for resources."
  default     = "us-east-1"
}

variable "instance_type" {
  type        = string
  description = "The EC2 instance type to use."
  default     = "t2.micro"
}
```
The example above defines the region and instance_type variables with a default value of "us-east-1" and "t2.micro", respectively.

#### Use Variables Instead of Hardcoding values.
Hardcoding values in Terraform are generally not recommended because it makes your code less flexible and harder to maintain. If you hardcode values, you'll need to manually update your code every time you want to change the value, which can be time-consuming and error-prone. Here are some ways to avoid using hardcoded values in Terraform:
Use variables: In Terraform, you can use variables to pass values into your modules. Instead of hardcoding values, you can define variables in your module and then use those variables in your resources. For example:
```json
variable "instance_type" {
  description = "The EC2 instance type"
  default = "t2.micro"
}

resource "aws_instance" "example" {
  ami = "ami-0c55b159cbfafe1f0"
  instance_type = var.instance_type
  subnet_id = "subnet-123456"
}
```
In the example above, the instance_type value is passed in as a variable instead of hardcoded. This makes the code more flexible and easier to maintain.

#### Always Use Maps instead of Lists.
When defining your resources in Terraform, you have the option to define them using either a list or a map. Here are some reasons why you might want to use maps instead of lists in Terraform:
1. Accessing resources by name: Maps allow you to access them by name, which can be helpful when you have many resources and need to reference them individually. With a list, you would need to use an index to access a specific resource, which can be more difficult to manage.
1. Adding and removing resources: When you add or remove a resource in a map, you only need to modify the resource itself, whereas, with a list, you would need to update the index of all subsequent resources. This can be time-consuming and error-prone.
1. Handling variable sizes: Maps can handle variable sizes more easily than lists. If you have a resource requiring multiple parameters, you can define them in a map and add or remove them as needed. With a list, you need to define all the parameters upfront, which can be challenging if you're unsure how many you will need.
1. Reusability: Maps can be more reusable than lists. If you have a resource that requires a set of parameters, you can define them once in a map and reuse it for other resources requiring the same set of parameters. With a list, you need to define the parameters for each resource individually, which can be repetitive and error-prone.
Overall, maps can provide more flexibility and easier management when defining your resources in Terraform, particularly when you have many or variable-sized resource configurations.
```json
variable "instances" {
  type = map(object({
    instance_type = string
    ami           = string
  }))
  default = {
    "web" = {
      instance_type = "t2.micro"
      ami           = "ami-0c55b159cbfafe1f0"
    }
    "database" = {
      instance_type = "t2.medium"
      ami           = "ami-0c55b159cbfafe1f0"
    }
  }
}

resource "aws_instance" "ec2" {
  for_each = var.instances

  ami           = each.value.ami
  instance_type = each.value.instance_type
  // ...
}
```

#### Use Dynamic Blocks
Dynamic blocks in Terraform allow you to dynamically generate multiple nested blocks within a resource based on a dynamic input. This can be very useful when you have a resource that requires a variable number of nested blocks, such as multiple subnets within a VPC or multiple ingress rules within a security group.
Dynamic blocks use a `for_each` or a dynamic block to iterate over a set of values, which can be a list, a map, or a set. Here is an example of how you can use dynamic blocks to create multiple AWS subnets within a VPC:
```json
resource "aws_subnet" "example" {
  vpc_id = aws_vpc.example.id
  dynamic "subnet" {
    for_each = var.subnet_cidr_blocks
    content {
      cidr_block = subnet.value
      availability_zone = subnet.key
    }
  }
}
```
In this example, the resource `**aws_subnet.example**` is created with a dynamic block that iterates over a map variable `**subnet_cidr_blocks**`, which contains the CIDR blocks and availability zones for each subnet. The `**subnet**` variable in the content block represents each element of the `**subnet_cidr_blocks**` map, with `**subnet.key**` and `**subnet.value**` representing the key-value pairs of the map.
When you apply this Terraform configuration, Terraform will generate a subnet block for each element in the `**subnet_cidr_blocks**` map, resulting in multiple subnets being created within the VPC.
Dynamic blocks can also be used to simplify the configuration of resources that require multiple nested blocks, such as AWS security groups with multiple ingress rules or egress rules.
Overall, dynamic blocks provide a flexible and powerful way to dynamically generate nested blocks within a resource in Terraform, based on a dynamic input.

#### Data Sources
Data sources in Terraform are used to fetch information from a third-party service or an existing infrastructure component and use that information in the Terraform configuration. Here's how to use data sources in Terraform:
Define the Data Source: Define the data source using the data block in the Terraform configuration. The data block defines the provider, resource type, and any necessary configuration options.
```json
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-focal-20.04-amd64-server-*"]
  }
}
```
In the example above, the `aws_ami` data source is defined with the most_recent and owners arguments, as well as a filter to select the most recent Ubuntu AMI.
Use the Data Source: Once the data source is defined, it can be used in the Terraform configuration using interpolation syntax. In the following example, the `aws_ami` data source is used to create an EC2 instance with the latest Ubuntu AMI.
```json
resource "aws_instance" "web" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = "t2.micro"

  // ...
}
```
In the example above, the `data.aws_ami.ubuntu.id` interpolation syntax is used to reference the id attribute of the `aws_ami` data source. This id attribute contains the unique identifier of the latest Ubuntu AMI, which is then used to launch an EC2 instance with that AMI.
Data sources can also be used with modules to pass information between modules or to combine information from multiple sources. By using data sources in Terraform, you can fetch information from a third-party service or an existing infrastructure component and use that information in your infrastructure code to create more dynamic and flexible configurations.

#### Use for_each meta-argument
The `for_each` meta-argument is used in Terraform to create multiple instances of a resource, where each instance has its own unique set of attributes based on a map or a set of strings. Here's how to use `for_each` in Terraform:
```json
resource "aws_instance" "example" {
  for_each = var.instance_names

  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t2.micro"
  tags = {
    Name = each.key
  }
}
```
In the example above, the `aws_instance` resource is defined with the `for_each` meta-argument, which specifies that three instances should be created based on the elements of the instance_names variable. The `each.key` interpolation syntax is used to specify the name of each instance based on the keys in the instance_names set.
When you run `terraform apply`, Terraform will create three instances with unique names or identifiers based on the instance_names set. You can modify or delete instances by updating or deleting the corresponding elements in the set.
By using `for_each` in Terraform, you can create multiple instances of a resource with unique names or identifiers based on a map or a set, which can help you create more flexible and dynamic infrastructure configurations.

#### Outputs
In Terraform, outputs allow you to export specific values from your infrastructure as a result of the apply operation. Outputs can be useful when you need to use information from your infrastructure in other parts of your code or in other Terraform configurations. Here's an example of how to use outputs in Terraform:
```json
resource "aws_instance" "example" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t2.micro"
}

output "instance_ip" {
  value = aws_instance.example.public_ip
}

output "instance_id" {
  value = aws_instance.example.id
}
```
In this example, an AWS EC2 instance is created using the `aws_instance` resource. Two outputs are defined using the output block, which exports the instance's public IP and instance ID. These values can then be used in other parts of your Terraform code or in other Terraform configurations.

## Terraform Automation Standards Playbook
KnackLabs' infrastructure deployment and management is done via CI/CD pipelines.  At a high level, ensure the following principles are followed:
- NO Operator/DevOps personnel will pull TF code to the local laptop and execute the `terraform appl`ication locally.
- Although it’s okay to run `terraform plan` locally, `terraform apply` needs to be run via CI Job only to maintain an audit trail of who has done what.
- Additionally, `terraform plan` should never be run with the `-target` flag can lead to unintended consequences, such as missing dependencies or not taking into account the full picture of the infrastructure. When a resource is targeted, Terraform may not consider other resources that depend on it, which can result in incomplete plans that don't accurately reflect the overall state of the infrastructure.
- All TF jobs should be subjected to the Quality gates mentioned earlier concerning cost, security, lining, etc. 
- The final `terraform apply` which provisions the Cloud Infrastructure is reviewed and approved manually via Slack notification or an Email, with the output of the entire plan attached. Do NOT AUTO APPLY. 

#### High-level overview of Infra Provisioning Via Terraform
![image](https://s3-us-west-2.amazonaws.com/secure.notion-static.com/db03a75f-4444-4b7a-a878-fa6cc1d4b3c6/Terraform_CICD_Pipeline_(1).png)
The above diagram represents how other Infrastructure is provisioned via Terraform and Github Actions.
The above flowchart uses the following workflow file.
```yaml
name: Plan using Terraform
on:
  pull_request:
jobs:
  terraform_workflow:
    name: Terraform Workflow
		runs-on: ubuntu-20.04
    env:
      GITHUB_TOKEN: ${{ secrets.TOKEN_GITHUB }}
      TF_VAR_access_key_id: ${{ secrets.AWS_ACCESS_KEY_ID }}
      TF_VAR_access_key_secret: ${{ secrets.AWS_SECRET_ACCESS_KEY}}
      TF_IN_AUTOMATION: true
      TF_ROOT: /
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Clone repo
        uses: actions/checkout@master
        
      - name: tfsec
        id: tfsec
        uses: aquasecurity/tfsec-action@v1.0.0
        with:
          soft_fail: true
          
      - name: Check out code
        uses: actions/checkout@v2

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v2
        with:
          terraform_version: 1.3.7

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v1
        with:
          aws-region: ap-south-1
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}

      - name: Terraform fmt
        id: fmt
        run: terraform fmt
        continue-on-error: true

      - name: Initialize Terraform
        id: init
        run: |
          terraform init \
          -backend-config="access_key="${{ secrets.AWS_ACCESS_KEY_ID }}" \
          -backend-config="secret_key="${{ secrets.AWS_SECRET_ACCESS_KEY }}"

      - name: Plan Terraform
        id: plan
        continue-on-error: true
        run: |
          terraform plan -no-color

      - uses: actions/github-script@v6
        if: github.event_name == 'pull_request'
        env:
          PLAN: "terraform\n${{ steps.plan.outputs.stdout }}"
        with:
          script: |
            const output = `#### Terraform Tfsec 🤖\`${{ steps.tfsec.outcome }}\'
            #### Terraform Format and Style 🖌\`${{ steps.fmt.outcome }}\`
            #### Terraform Initialization ⚙️\`${{ steps.init.outcome }}\`

            #### Terraform Plan 📖\`${{ steps.plan.outcome }}\`

            <details><summary>Show Plan</summary>

            \`\`\`\n
            ${process.env.PLAN}
            \`\`\`

            </details>

            *Pusher: @${{ github.actor }}, Action: \`${{ github.event_name }}\`, Working Directory: \`${{ env.tf_actions_working_dir }}\`, Workflow: \`${{ github.workflow }}\`*`;

            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: output
            })
```

#### Playbook for GitHub Terraform Workflow:

This is a GitHub Actions workflow file that creates a pipeline for planning Terraform infrastructure changes whenever a pull request is opened. Here are the steps of the workflow file:
1. The workflow is triggered on pull_request events.
1. Permissions are set for the workflow to read contents and write pull requests.
1. The [tfsec action](https://github.com/aquasecurity/tfsec-action) is used to check for security issues in the Terraform code.
1. The [hashicorp/setup-terraform ](https://github.com/hashicorp/setup-terraform)action is used to set up Terraform.
1. The [aws-actions/configure-aws-credentials](https://github.com/aws-actions/configure-aws-credentials) action is used to configure AWS credentials for the Terraform provider.
1. The `terraform fmt` command is run to format the Terraform code.
1. The `terraform init` command is run to initialize the Terraform working directory.
1. The `terraform plan` command is run to generate an execution plan for Terraform.
1. If the workflow is triggered by a pull request event, the [actions/github-script ](https://github.com/actions/github-script)action creates a comment on the pull request with the results of the tfsec check, formatting, initialization, and planning steps.
