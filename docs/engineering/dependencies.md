# Dependency policy

Add a dependency only when it provides maintained, security-relevant, or complex
behavior that Gantry should not own and when an existing dependency cannot serve
the same role. Record why a small local implementation is insufficient.

Runtime dependencies affect the shipped package and threat surface; development
dependencies must not leak into runtime paths. Follow the repository's existing
exact/ranged-version policy and lockfile. Evaluate maintenance activity, license,
release maturity, transitive risk, browser/Node support, and bundle/runtime cost.
Experimental or alpha packages need a contained adapter and an exit plan.

Provider SDKs remain behind Gantry-owned interfaces. Their request/response types
must not become domain or public API contracts accidentally. Remove unused
packages and duplicate libraries in the same change that makes them unnecessary.

**Mechanical:** lockfile consistency, package build, package-content checks,
SBOM/package security scripts, and dependency automation detect reproducible
drift.

**Review:** Reviewers require a justification, isolation boundary, security and
maintenance assessment, and tests at the owned interface.

**Recommendation:** Prefer platform APIs or an already-adopted library when they
meet the contract without weakening clarity or security.
