# Say where a thread stands in one word

## Goal
A thread's stub, and every list of threads, says needs you, running, answered, shipped or resolved, with needs you first.

## Notes
- Design: docs/model.md, "Threads". Answered is not resolved: nothing waits on the person, but what the thread produced hasn't closed. Relates to closing on production use (8g9f7vqh).

## Done when
- Each word is derived from the log by one function, tested for every state of the thread machine.
- A thread whose agent answered and whose pull request is still open reads answered, not resolved.
- Lists of threads put needs you first.
