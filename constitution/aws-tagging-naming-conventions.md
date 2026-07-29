# AWS Tagging & Naming Conventions Standard v1.0

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

At KnackLabs, we develop many apps. We like to follow common best practices across all the apps we develop. This playbook describes an opinionated scaffolding that jump-starts projects. This came about due to many commonalities between several of our projects. This document will cover AWS Resource Naming conventions, Tagging standards for AWS resources, and implementation & enforcement approaches from a governance point of view. A standard naming convention aims to identify the ownership/identity of the resources easily. The tags' objectives are multifold, i.e., from attaching relevant metadata to the AWS services to using mandatory Tags such as Cost Allocations Tags in AWS Cost Explorer, AWS CUR, etc., to filter resources based on clients/projects, etc.
Note the best practices are just recommendations and not unbreakable rules. Context is the King; So always tweak the below recommendations as applicable to your product.
_[diagram omitted]_

## AWS Resources Naming Conventions:
Each resource created in AWS or any other cloud environment should follow the below naming convention.
*<Mandatory Attributes>-<Optional Attributes>
*
**Note**: Resources created and managed by AWS or Kubernetes might **NOT** be able to follow the naming convention. Eg: autoscaling groups created by Managed group and EBS created by Kubernetes are a few such examples.

### Mandatory Attributes in the Naming Convention:

| **Attribute** | **Possible Values** | **Mandatory** |
| --- | --- | --- |
| **Parent Org. Name** | KnackLabs, hBits, Flipspaces, etc. | YES |
| **Cloud  Provider** | AWS, GCP, AZURE | YES |
| **Region** | aps1, aps2, usw1, usw2 | YES |
| **Client/Customer Name** | hBits, Flipspaces, etc. | NO |
| **Environment** | Prod, UAT, Stage, Dev | YES |
| **Resource Type** | S3, EKS, ECS, RDS, etc. | YES |
| **Team / Project Name** | Team Name, Project Name, etc. | YES |
| **Name Prefix** | Resource Name | YES |
| **Name Suffix / Optional Attribute** | Resource, Service, Role Name, Purpose, or any other attribute. | NO / Optional |

### Optional Attributes in the Naming Convention:
The optional attributes are applied based on the requirement and resource type provisioned.

| **Attribute** | **Possible Value** |
| --- | --- |
| **Service Name** | Any string |
| **Role Name** | Master, Slave, Replica, Snapshot, etc. |
| **Accessibility** | Public, Private |
| **Any other attribute** | Any string |

#### Examples : 
- Let’s assume the organization name is `acme`, the project name is `example`, and the resource name is `rsc`. 
- *ECS*
  - acme-aws-aps1-prod-ecs-example-rsc-*testing (Denotes a testing instance)*
  - *acme-aws-aps1-prod-ecs-examplelanding_pages*
  - *acme-aws-aps1-hbitsprod-ecs-examplebackend (Denotes KnackLabs account ílhosting acme infra)*
  - *acme-aws-aps1-prod-ecs-hbitsv2-strapi*
- *RDS*
  - acme-aws-aps1-stage-rds-example-RdsName-*01-replica* (Denotes role is replica)
  - *acme-aws-aps1-prod-rds-examplemaster*
  - *acme-aws-aps1-prod-rds-examplersc-master*
- *ACCOUNT NAME*
  - acme-aws-aps1-prod-example
- *S3*:
  - acme-aws-usw2-prod-s3-example-rds_logs-*private* (Denotes bucket is private)
- *KINESIS:*
  - acme-aws-aps1-traceable-uat-kinesis-<Team Or Project>-metrics-<optional Name suffix> (Denotes traceable as client of KnackLabs)

**Attribute Standards:**
1. **Use all lowercase** and not Camel or Pascal Case in attribute names.
1. **Use underscores to separate words**, Ex: *rds_logs*.
1. **Use dashes to separate attributes** to visually identify distinct attributes.
1. **Don’t use Resource Naming for metadata**: Use Tags to add relevant metadata to an AWS resource, don’t use the Name for this.

## AWS Resources Tagging Convention:

### Objectives of Tagging:
- Ability to filter resources based on team, cost center, business unit, or client in AWS Console, especially under **AWS Resource Groups**.
- Ability to identify resources per client/customer if the account is a multi-tenant account hosting infra for different clients/customers.
- Ability to generate Cost Reports using AWS CostExplorer or AWS CUR based on a set of **Cost Allocation Tags. **Of many tags, only a few will be considered CA tags.** **Cost reports can be generated based on Cost Center, Org, Bu, Team or Client, etc.
- **Use Tags to add relevant metadata like OS version, Kernel, Role (Ex: master/slave), or if the resource was created manually or via automation like Terraform.**
- **Use Tags to control access to AWS resource IAM policy. IAM policies support Tag based conditions.**

### General AWS Tagging Best Practices:
- Have a concise set of tags to convey the purpose & clarity. Tags shouldn’t be abstract.
- Tags are case sensitive, i.e., costCenter and cost-center are 2 different sets of tags.
- Tagging standard should have version no. Change the version if the tagging standard has been amended.
- Use AWS Tag Policies (Aws Organizations) to maintain org-wide tag policies/standards. The approach to the **Enforcement** of tags and taking corrective action for resources not following Org wide tagging structure is equally important as the approach to the **implementation** of Tags. Refer Enforcement section.
- Use IaaC tools like Terraform to implement Tags. **Refer to the Implementation section.**
- Consider tag dimensions that support the ability to manage resource access control, cost tracking, automation, and organization. Refer to the section on **Tagging Categories.**
- Err on the side of using too many rather than too few tags.
- Implement automated tools to help manage resource tags. The AWS **Resource Groups Tagging API **enables programmatic control of tags, making it easier to automatically manage, search, and filter tags and resources. It also simplifies backups of tag data across all supported services with a single API call per AWS Region.
- Don’t use tags data as a single source of truth for AWS Resources or as an inventory source.
- Every Resource must have a Name Tag.
- Remember that it is easy to modify tags to accommodate changing business requirements. However, consider the ramifications of future changes, especially in relation to tag-based access control, automation, or upstream billing reports.
- Use Tag NameSpaces (separated by a colon), bringing purpose & clarity to Tags.
- Use Multivalue/Compound tag values for shared resources. Use ; (semicolon as a separator for values) Ex: *info:CreatedBy = John Doe;johndoe@johndoe.com*
- Use multi-valued tags for shared resources only as opposed to single-value tags.
- Leverage IAM Policies with Tags making tags mandatory during provisioning/deployment.

### Tagging Categories:
To use tags most effectively, typically create business-relevant tag groupings to organize resources along technical, business, cost, and security dimensions. Also, add tags stating automation as one of the dimensions. Tags can be categorized into the following categories:

B**usiness Tags:**

| **KEY** | **VALUES** | **MANDATORY** | **CA TAG** |
| --- | --- | --- | --- |
| org (parent) | KnackLabs, hBits, Flipspaces, etc. | YES | YES |
| org:cost-center | Specific to KnackLabs if any | YES | YES |
| org:team | Software-engg, devops. QA etc. | YES | YES |
| org:owner | user1;user1@example.com | YES | NO |
| Org:client (relevant for multi-tenant setup) | hBits, traceable, etc. | YES | YES |
| org:<custom> | Custom values |  |  |
**Technical Tags:**

| **KEY** | **VALUES** | **MANDATORY** | **CA TAG** |
| --- | --- | --- | --- |
| app:role | Master,slave, web-frontend,backend, | YES | NO |
| app:name | Name of the application / resource | NO | NO |
| app:environment | Prod,stage, uat | YES | YES |
| app:resource | ELB,EBS,SG etc | YES | YES |
| app:<custom> | Custom values |  |  |
**Security Tags:**

| **KEY** | **VALUE** | **MANDATORY** | **CA TAG** |
| --- | --- | --- | --- |
| security:accessibility | Public, private etc | YES | NO |
| security:compliance (if applicable) | Pci.non-pci etc | YES | NO |
| security:<custom> |  |  |  |
**Automation / Info Tags:**

| **KEY** | **VALUE** | **MANDATORY** | **CA TAG** |
| --- | --- | --- | --- |
| info:terraform | Boolean | YES | NO |
| info:created-by | Name of the user creating the resource. Different from the owner of the resource. | YES | NO |
| info:created-on | date/time | YES | NO |
| info:purpose | Production, testing etc | YES | NO |
| info:<custom> |  |  |  |
**Examples:**
![image](https://s3-us-west-2.amazonaws.com/secure.notion-static.com/16a74a21-6428-496d-a646-ac1876008825/Screenshot_from_2023-04-19_16-25-42.png)
_[diagram omitted]_
**NOTE:**
- A combination of tags from any of these categories will be considered **Cost Allocation Tags** to identify resources, owner, purpose & the associated costs in billing & cost usage reports.
- Implementation of these tags will be done via Terraform.

## Tagging Governance and Enforcement (Later phases):
An effective tagging strategy uses standardized tags and implements them consistently and programmatically across AWS resources. Defining the Tagging standard alone won’t suffice; The Enforcement & Governance of tags are mandatory. Steps that can be taken for governance are:
1. Make tags mandatory as a part of the IaaC / CI pipeline etc.
1. Leverage Tags governance tools like AWS Resource Tagging APIs, AWS Config rules, and custom scripts; Or AWS Tag Editor
1. Makes tags mandatory for AWS resources using IAM Policy Tags: Refer#
- [https://aws.amazon.com/premiumsupport/knowledge-center/iam-policy-tags-restrict/](https://aws.amazon.com/premiumsupport/knowledge-center/iam-policy-tags-restrict/)
- [https://aws.amazon.com/blogs/aws/new-tag-ec2-instances-ebs-volumes-on-creation/](https://aws.amazon.com/blogs/aws/new-tag-ec2-instances-ebs-volumes-on-creation/) (Enforce Tag Usage section)
1. Explore AWS Tagging Policies, part of AWS Organizations, to enforce org-wide tagging policies and standards. AWS Tag policy to define rules to create/assign tags to resources:
Refer:
- [https://docs.aws.amazon.com/organizations/latest/userguide/tag-policies-getting-started.html](https://docs.aws.amazon.com/organizations/latest/userguide/tag-policies-getting-started.html)
- [https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_tag-policies-enforcement.html](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_tag-policies-enforcement.html)
- [https://docs.aws.amazon.com/config/latest/developerguide/required-tags.html](https://docs.aws.amazon.com/config/latest/developerguide/required-tags.html)
_[diagram omitted]_
1. Use automation like lambda to delete untagged resources after the grace period expires.

## References:
1. [https://docs.google.com/document/d/1ZngQGMQZZprsUb0p0UyeATq4KjE1LaprgDB9_MTjoPo/edit#heading=h.pbi6aqy012tf](https://docs.google.com/document/d/1ZngQGMQZZprsUb0p0UyeATq4KjE1LaprgDB9_MTjoPo/edit#heading=h.pbi6aqy012tf)
1. [https://d1.awsstatic.com/whitepapers/aws-tagging-best-practices.pdf](https://d1.awsstatic.com/whitepapers/aws-tagging-best-practices.pdf)
1. [https://d0.awsstatic.com/aws-answers/AWS_Tagging_Strategies.pdf](https://d0.awsstatic.com/aws-answers/AWS_Tagging_Strategies.pdf)
1. [https://medium.com/@staxmarketing/a-guide-to-tagging-resources-in-aws-8f4311afeb46](https://medium.com/@staxmarketing/a-guide-to-tagging-resources-in-aws-8f4311afeb46)
1. [https://www.metricly.com/aws-tagging-best-practices/](https://www.metricly.com/aws-tagging-best-practices/)
1. [https://aws.amazon.com/blogs/security/working-backward-from-iam-policies-and-principal-tags-to-standardized-names-and-tags-for-your-aws-resources/](https://aws.amazon.com/blogs/security/working-backward-from-iam-policies-and-principal-tags-to-standardized-names-and-tags-for-your-aws-resources/)
1. [https://stackoverflow.com/questions/48426761/aws-iam-policy-to-enforce-tagging](https://stackoverflow.com/questions/48426761/aws-iam-policy-to-enforce-tagging)
.
[https://www.jdrf.org/wp-content/uploads/2020/12/AWS-logo-2.jpg](https://www.jdrf.org/wp-content/uploads/2020/12/AWS-logo-2.jpg)
