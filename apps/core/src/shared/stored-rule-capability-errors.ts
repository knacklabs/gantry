// Stored RunCommand grants are machine-minted (Allow for future), so a later,
// stricter validator can retroactively reject entries that were legal when
// granted. That must never make settings unloadable (it crash-loops startup);
// the rules stay in settings and remain subject to decision-time rails and
// guards. Hand-authored capability ids keep strict rejection. String-keyed on
// the two per-entry error shapes because both validators emit flat strings.
export function partitionStoredRuleCapabilityErrors(errors: string[]): {
  hardErrors: string[];
  warnings: string[];
} {
  const storedRulePattern =
    /contains (?:invalid|unavailable) capability "?RunCommand\(/;
  const hardErrors: string[] = [];
  const warnings: string[] = [];
  for (const error of errors) {
    (storedRulePattern.test(error) ? warnings : hardErrors).push(error);
  }
  return { hardErrors, warnings };
}
