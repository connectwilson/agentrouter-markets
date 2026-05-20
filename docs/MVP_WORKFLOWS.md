# MVP Workflows

## Provider Flow

1. Start the server with `npm start` or `PORT=8800 npm start`.
2. Open `/studio`.
3. Create a service manually or import an OpenAPI URL.
4. Review discovered endpoint cards.
5. Select the endpoints to publish.
6. Create/register/validate the services from the confirmation panel.
7. Confirm each service appears in registry search.

## Demand Agent Flow

1. The user asks a main agent for data.
2. The main agent calls AgentRouter with the original task.
3. AgentRouter searches registered services using task-derived search queries.
4. AgentRouter selects a service and builds input.
5. The connector invokes the selected service with a max-price budget.
6. The provider returns an agent-friendly result envelope.
7. The caller receives answer, selected service, input, result, and feedback metadata.

## Claude Integration Flow

Hosted Claude environments usually cannot access `/Users/...` local paths. Use HTTP instead:

1. Run the local ADN server.
2. Expose it with a tunnel if Claude is remote.
3. Install a Claude Skill that calls `POST /agent-router/ask`.
4. Ask Claude: `用AgentRouter查询...`

The Skill should be generic. It should not mention one fixed provider or one fixed Matrixport query.
