# Review brief — lite window Q-0106 (Telegram card humanizer keeps the command text)

Facts: Q-0104 made the shared card rows read `Run command: <command>`. The Telegram humanizer still rewrote `RunCommand(...)` to "run command access" (erasing the command) and `RunCommand` to "Run command" (now redundant).

Contract for this diff: keep only the header replacement and HTML escaping; delete the two RunCommand replacements. No other change. Ignore style.
