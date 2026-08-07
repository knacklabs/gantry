# Workshop Dispatch

## Summary

Workshop Dispatch helps a small repair workshop move customer jobs from intake
to a clear, scheduled handoff.

## Users

Service coordinators plan the work, and technicians complete the scheduled
jobs.

## Target Outcome

Every accepted job has an owner, a visible dependency state, and a dependable
path to customer handoff.

## Key Flows

A coordinator accepts a repair, schedules the required work, and prepares the
customer handoff once the repair is complete.

## Domain Concepts

A repair job describes the requested work. A workshop slot assigns time and a
technician. A handoff returns a completed job to its customer.

## Constraints

The first release uses one workshop calendar and keeps the job state readable
without external services.

## Out of Scope

Parts purchasing, invoicing, and multi-site scheduling are not part of this
example.
