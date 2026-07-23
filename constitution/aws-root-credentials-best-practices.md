# AWS Account Root Credentials Best Practices v1.0

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

The following document dictates the process to be followed in managing/storing AWS accounts ROOT credentials. There is never a reason to use ROOT credentials unless required under certain use cases described below.
_[diagram omitted]_

### Terminology:
- ***AWS Master Account:***** **Parent AWS Account in which other AWS accounts are created as child accounts. The master account will have its root user.
- ***AWS Child Accounts*****: **AWS Accounts are created directly under the Master account or OUs.
- ***Root User*****: **When you create an AWS account, you begin with one sign-in identity with complete access to all AWS services and resources. This identity is called the AWS account *root user* and is accessed by signing in with the email address and password you used to create the account. The Root user is the Super User of an account. The Root User is different from an IAM User. You cannot use IAM policies with Root User, while SCPs can be used to restrict Root User actions.
- ***OU:***** **You can use organizational units (OUs) to group AWS accounts together to administer as a single unit. Every account under the OU has different root users.
- ***IAM User:***** **An AWS Identity and Access Management (IAM) *user* is an entity you create in AWS. The IAM user represents the human user or workload who uses the IAM user to interact with AWS.

### When Do I need to use AWS Root Credentials?
Only the task mentioned in this document is when Root credentials should be used. Otherwise, **DO NOT** Use Root credentials to perform any activity like Login to AWS Console or Using Root Users Access key/Secret Key for programmatic access, etc. Refer to the following:  [https://docs.aws.amazon.com/accounts/latest/reference/root-user-tasks.html](https://docs.aws.amazon.com/accounts/latest/reference/root-user-tasks.html).

### 
AWS Root User Do’s & Don'ts:
- Anyone with root user credentials for your AWS account has unrestricted access to all the resources in your account, including billing information. The Root User can perform any action and create any number of AWS resources.
- After creating a new AWS account, create a separate IAM user for billing concerns; don’t log in with root users to perform billing actions like changing CC details, etc.
- Protect Root Creds as though it’s your Credit card numbers. Do not store Root credentials in emails, chat messages, etc.
- **IMPORTANT: **Enable MFA for Root credentials. Also, backup or store the MFA backup codes securely.
- **If required, use hardware MFA like Yubikey. Refer# **[**https://aws.amazon.com/blogs/security/use-yubikey-security-key-sign-into-aws-management-console/**](https://aws.amazon.com/blogs/security/use-yubikey-security-key-sign-into-aws-management-console/)
- Do NOT use Root user to login to AWS Console or root user credentials like Access Key / Secret Key to perform any API / Programmatic Operation.
- Never share your AWS account root user password or access keys with anyone.
- When using Terraform for Automation, better allow the administrator to create the AWS account manually (and the OU if required) and have him/her hand over the IAM user to perform any future operations via automation. Ensure the required IAM policy is associated with the IAM user. The preferred way is to use AWS IAM Identify Center (AWS SSO) and create an administrative user with the required permission Set. If not, create a standalone IAM user with a defined IAM policy associated with the IAM user.
- Do not create an access key / secret key for the Root User for programmatic access. If you do have one,** DELETE IT.**
- **IMPORTANT: **Do not embed or use Root credentials in your applications to provide access to AWS Services. In general, do not use the access key / secret key approach for Applications. Use IAM Roles or IAM OIDC for workloads running on EKS. A separate document will cover the best practices for IAM.
- **IMPORTANT: **Use AWS Service Control Policies to restrict any actions Root User (only for member accounts) can take at an account level or apply the SCPs at an OU level. For example, refer to the SCP policy:** **[**https://asecure.cloud/a/scp_root_account/**](https://asecure.cloud/a/scp_root_account/)
- **IMPORTANT: **Use AWS Guardduty to detect any suspicious activities performed with the Root credentials. Refer# [**https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_finding-types-iam.html#policy-iam-rootcredentialusage**](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_finding-types-iam.html#policy-iam-rootcredentialusage)
- If possible, use a DL as the root username as opposed to a single user's email, as the email may get deactivated when an employee leaves the org. Ensure recoverability of root credentials of an AWS account if required.

### Storing AWS Credentials:
- Do not store the root credentials in the laptop, chat messages, emails, etc. If required to be stored or pass the creds across an organization, ensure the file which has the credentials is GPG encrypted with a passphrase. DO NOT Share the pass-pharse on chat or email, communicate the passphrase to decrypt the GPG file verbally. Please note this is not a best practice as it lacks auditability.
- You may use services like 1password for storing the credentials OR services like Vault can as well be used for storing credentials.
- It’s generally advisable to split the root password between 2 people and MFA with the third person. All 3 users should come together when required to use Root credentials. Please change the credentials after a single usage.
- For other approaches recommended by devops community Refer# [https://www.reddit.com/r/aws/comments/mk50l3/tip_securing_your_aws_root_account/](https://www.reddit.com/r/aws/comments/mk50l3/tip_securing_your_aws_root_account/)
