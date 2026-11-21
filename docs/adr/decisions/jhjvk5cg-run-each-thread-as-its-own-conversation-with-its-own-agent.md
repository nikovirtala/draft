# Run each thread as its own conversation with its own agent session, switched by a logged event

## Context
A thread is a conversation with a parent message. Threads run concurrently, may run on different configured agents, and may switch agent midway. ADR h89hcrk6 makes every session start from one projection of the log.

## Decision
A Workspace opens the main conversation and every thread over one log, one projection and one write order. Each conversation has its own ConversationService (turns, prompts, interrupts) and, through the AcpRuntime of its agent, its own ACP session keyed by conversation address. A new event type agent.selected records the agent chosen when a thread starts and any later switch, by a person. A switch ends the old session and the next turn starts a new one from buildAgentContext; the person sees its size (counts and characters) first. Interrupts are computed per conversation, so they land in the thread they belong to.

## Scope
packages/core/src/workspace.ts, packages/core/src/conversation.ts, packages/core/src/projection.ts, apps/desktop/src/main/acp/registry.ts

## Consequences
One agent process per configured agent, shared by its conversations. A thread's state is open only for now; closing a thread adds states. A thread whose chosen agent is removed from config fails its turns with a clear message rather than falling back silently. Projection version rises to 3 and rebuilds from the log.
