# @mongolgpt/client

Private generation target for clients derived directly from MongolGPT's authoritative Effect `HttpApi`.

## Entrypoints

- `@mongolgpt/client`: zero-Effect Promise client using `fetch`.
- `@mongolgpt/client/effect`: rich Effect network client using an environment-provided `HttpClient`.

The generated surface starts with the Session group from Server's concrete API. The build compiler reads `@mongolgpt/server/api`; the generated Effect runtime imports a client-local projection built from Protocol, with a generation-equivalence test preventing transport drift. Run `bun run generate` after changing the contract and `bun run check:generated` to detect committed-output drift.

The Effect entrypoint uses canonical decoded values such as `Session.ID`, `Location.Ref`, and `Prompt`. These datatypes come from the lightweight `@mongolgpt/schema` package and are re-exported so callers depend only on the client surface. Protocol owns endpoint construction and middleware placement; Server supplies the concrete middleware keys used by the build-time API.

The Promise root remains structural and has no Core or Effect runtime dependency. `/effect` depends only on Effect, Schema, and Protocol and is browser-bundle safe. Bundle-boundary tests enforce both import graphs.

Effect consumers construct canonical decoded inputs:

```ts
import { AbsolutePath, Location, MongolGPT, Prompt } from "@mongolgpt/client/effect"

const client = yield * MongolGPT.make({ baseUrl: "https://mongolgpt.example" })
yield *
  client.sessions.create({
    location: Location.Ref.make({ directory: AbsolutePath.make("/workspace") }),
  })
yield * client.sessions.prompt({ sessionID, prompt: Prompt.make({ text: "Hello" }) })
```
