# Motor insurance data setup and verification

This guide covers the motor-insurance MCP server **in this checkout** and the
checks needed before using a separate Postgres-backed version with MotoBuddy.
Do not seed Gantry's Postgres database as a substitute for seeding the MCP
server's own store: Gantry stores the MCP connection and agent permissions, not
the insurance policies served by `get_motor_policy`.

## Data in this checkout

`server.mjs` already defines these policy fixtures in its `policies` array. No
SQL import or first-run seed command is needed for policy lookup:

| Policy       | Customer    | Vehicle       | Plan             | Validity                      | Deductible     |
| ------------ | ----------- | ------------- | ---------------- | ----------------------------- | -------------- |
| `MOTOR-1001` | Aarav Demo  | Maruti Baleno | Comprehensive    | 2026-01-01 through 2026-12-31 | ₹1,000         |
| `MOTOR-1002` | Meera Demo  | Hyundai i20   | Third-party only | 2026-04-01 through 2027-03-31 | Not applicable |
| `MOTOR-1003` | Kabir Demo  | Tata Nexon    | Comprehensive    | 2025-09-01 through 2026-08-31 | ₹1,000         |
| `MOTOR-1004` | Nisha Demo  | Honda City    | Comprehensive    | 2026-07-01 through 2027-06-30 | ₹2,000         |
| `MOTOR-1005` | Vikram Demo | Toyota Glanza | Comprehensive    | 2026-03-15 through 2027-03-14 | ₹1,000         |

The server also defines four garage fixtures. On a fresh start, it creates a
sample claim `CLM-DEMO-001` in memory. New claims, evidence metadata and review
decisions are persisted to `demo-state.json`; original uploads go in
`claim-evidence/`. These files are gitignored and must be backed up together if
you need the same claim history elsewhere. Set `STATE_FILE` and `EVIDENCE_DIR`
to the existing store before starting the server if those files live elsewhere.

To install, test and start this server from a fresh checkout:

```bash
cd examples/motor-insurance-mcp
npm ci --ignore-scripts
npm test
npm start
```

`npm test` uses isolated temporary state. It verifies all five policy fixtures
are listed, retrieves the added policies, and checks their distinct cover; it
does not write to a live claim store. With the server running, `curl http://127.0.0.1:14319/health`
checks HTTP health. The MCP endpoint is `http://127.0.0.1:14319/mcp`.

## If MotoBuddy uses a different, Postgres-backed MCP server

That server's schema and seed code are **not present in this checkout**. Do not
guess table names or run SQL written for Gantry's database. On the machine
running that server:

1. Identify its exact source checkout, revision, database URL setting,
   migrations and existing seed script. Run the server's migrations against a
   fresh database, then run its documented seed command. If it has no seed
   command, add an idempotent seed to **that server** using its real schema and
   the policy values above. Do not insert claim or evidence rows as a shortcut
   for testing policy lookup.
2. In the server's database, confirm `MOTOR-1001` exists using a read-only
   query against the actual policy table. The exact SQL depends on that
   server's schema. Confirm the server process points to the same database;
   a populated database at another URL does not help MotoBuddy.
3. Call the server's `get_motor_policy` tool for `MOTOR-1001`, then
   `check_motor_coverage` for a `collision` on `2026-07-24`. An HTTP health
   check alone does not prove the data or tools are available.
4. In Gantry, verify that this MCP source is connected, attached to MotoBuddy,
   and its reviewed tool capabilities are selected. Source attachment does not
   itself grant the agent permission to call its tools. Start a new MotoBuddy
   turn only after those checks.

Interpret the result before changing data:

| Observation                                                       | What to check                                                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `POLICY_NOT_FOUND` from `get_motor_policy`                        | Policy ID, seed rows, and the server's active database URL.                                                    |
| Tool unavailable, connection error, or zero connected MCP sources | Server reachability and MotoBuddy's MCP attachment/capability selection; adding policy rows will not fix this. |
| Policy lookup succeeds but coverage fails                         | Incident argument names, incident type/date rules, and the coverage tool result.                               |

The quoted MotoBuddy reply (“I can’t verify your coverage right now”) is a
customer-facing fallback, not proof that the policy row is absent. The earlier
run log supplied with this task reported `connectedMcpSources: 0`, but that
log predates the quoted turn; inspect the latest run/tool result before naming
its cause. Do not claim successful verification until the tool returns it.

To turn this into a runnable Postgres seed guide, add the separate server's
repository/path and schema-specific migration, seed and verification commands.
