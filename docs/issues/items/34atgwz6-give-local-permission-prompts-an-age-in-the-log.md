# Give local permission prompts an age in the log

## Goal
Local agent permission prompts are in memory only, so their age is not derivable from the log.

## Notes
Every other interrupt has a creation time in the log. Local prompts do not.

## Done when
- A local permission request has a created time in the log.
