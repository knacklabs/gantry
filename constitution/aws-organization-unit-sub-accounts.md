# Playbook for AWS Organization Unit & Sub Accounts

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

_[diagram omitted]_
This playbook explains the account hierarchy to be followed under AWS organizations & account naming conventions leveraging AWS organization Units, AWS accounts & SCPs, etc. Please ensure the standards mentioned in this document are followed for any AWS accounts created at KnackLabs.

### What is AWS Organization? 
AWS Organizations is a service that allows you to manage and govern multiple AWS accounts centrally. Some of the terminologies used in AWS Organizations include:
- ***AWS Organization: ***It is the top-level container for all the AWS accounts you want to manage using AWS Organizations.
- ***Account: ***An AWS account is a container for resources, such as EC2 instances, S3 buckets, and Lambda functions, used to run your applications and services.
- ***Organizational unit (OU): ***An OU is a container within an organization that groups account together based on business function or application.
- ***Root: ***The root is the highest level of an organization and is created automatically when you create an organization.
- ***Service control policies (SCPs): ***SCPs allow you to control actions performed in an account or OU.
- ***Policy: ***A policy is a document that defines the rules and regulations used to govern the use of resources within an organization.
- ***Tag: ***You can assign a label to AWS resources, such as EC2 instances, S3 buckets, and Lambda functions, to help you organize and manage them.
- ***Master account: ***The master account is the account that is used to create and manage an organization.
- ***Member account: ***A member account is an AWS account associated with an organization.
- ***Cross-account access: ***Cross-account access allows you to grant access to resources in one account to users or resources in another account.

### What are AWS SCPs (Service Control Policies)?
Service control policies (SCPs) are a type of organizational policy you can use to manage permissions in your organization. SCPs offer central control over the maximum available permissions for all accounts in your organization. SCPs help you to ensure your accounts stay within your organization’s access control guidelines

### **Workflow Diagram :**
![image](https://s3-us-west-2.amazonaws.com/secure.notion-static.com/3c081a7e-05c3-4758-a582-02980d61e64e/Screenshot_from_2023-04-20_18-51-19.png)
_[diagram omitted]_

### **Standards for AWS Organization Units and Sub-accounts.**
- For every new AWS Account being created under a project, use a mailing list as the root username instead of individual users’ email IDs; if the user leaves the org, the root creds are lost since it’s mapped to the user's email id. Please create new AWS Accounts with the following DL. Ex: <client>-<projectName>-<environment>@knacklabs.ai	Ex: ems-calibrate-prod@knacklabs.ai
- In KnackLabs, we use the above model to manage our accounts into distinct units. We begin with a root account for the organization and then create separate organization units for each project. Within each organization unit, we create sub-accounts for each environment associated with that project.
- An entire AWS Organization, with its root account and subaccount, belongs to a specific customer or client. This is a single tenancy model. The same structure is replicated for another client or customer.
- You may apply corresponding SCPs for best practices at an OU level so that all the accounts within that OU / Project inherit the same policies.
- Under the root account, create a separate OU called Shared-Services, which will have an AWS account to host shared services across multiple projects for a given Client/Customer. The purpose of this shared account is to host CI/CD services (GitHub Self hosted runner, ArgoCD, etc) or common security services like GuardDuty, which can leverage AWS Organization and source events across multiple AWS accounts. Shared Services account access is limited to administrators only.
- When using Terraform to create AWS organizations or accounts, use forgot password to get the root password.
- Use a mailing list as opposed to a single user's email address to create an AWS account.
