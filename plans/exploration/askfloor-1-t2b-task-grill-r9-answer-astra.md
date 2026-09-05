1. **The objective still over-broadens malformed-input handling.** It says “malformed shapes are ambiguous,” while AC1 and accepted Decision 0155 limit validation to the `file` and browser file-action argument-shaped rows; other registered rows are name-keyed. Following the objective could introduce validation across every tool and violate default-LOW behavior. [decomposition.json:344](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/decomposition.json:344), [decomposition.json:346](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/decomposition.json:346), [Decision 0155:26](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/docs/decisions/0155-default-allow-gantry-tools-interactive-auto.md:26). **Minimal fix:** replace that phrase with “malformed file/browser file-action argument-shaped rows are ambiguous.”

Non-blocking notes:

- All six ACs match their `plan_contracts` and saved task-plan counterparts.
- Confirmed 23 unique scoped paths, 15 unique test titles with paths inside scope, and budget 25 files/2100 lines.
- The r8 `capability_run` and existing-expectation fixes are present.
- No files written; no tests run.
