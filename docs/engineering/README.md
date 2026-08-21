# Gantry engineering standards

This directory is the tool-agnostic engineering contract for Gantry. It defines
what a correct, maintainable change looks like. CI, repository scripts, review,
and the optional factory workflow enforce or assist with this contract; they do
not replace it.

## Authority

When sources conflict, use this order:

1. current implementation and executable tests;
2. accepted, non-superseded [architecture decisions](../decisions/README.md);
3. current architecture and implementation documentation;
4. current feature documentation;
5. active implementation plans;
6. historical and archived material.

A discrepancy between source and an accepted decision is a defect to reconcile,
not permission to silently choose either side.

## Policy index

- [Source organization](source-organization.md)
- [Coding standards](coding-standards.md)
- [Architecture rules](architecture-rules.md)
- [Testing](testing.md)
- [Dependencies](dependencies.md)
- [API and contracts](api-and-contracts.md)
- [Errors and observability](errors-and-observability.md)
- [Configuration and secrets](configuration-and-secrets.md)
- [Persistence and migrations](persistence-and-migrations.md)
- [Performance](performance.md)
- [Documentation governance](documentation.md)

Each policy labels rules as **Mechanical**, **Review**, or **Recommendation**.
Mechanical rules name an executable owner where one exists. Review rules require
engineering judgment. Recommendations are defaults that may be changed with an
explicit reason.

## Applying the contract

Start with [source organization](source-organization.md) and the policy closest
to the surface you are changing. Use [testing](testing.md) to choose proof and
[documentation governance](documentation.md) to update the authoritative record
in the same change. The contributor workflow and change-specific command matrix
live in [CONTRIBUTING.md](../../CONTRIBUTING.md).
