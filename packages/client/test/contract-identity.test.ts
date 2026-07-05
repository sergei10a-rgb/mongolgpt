import { expect, test } from "bun:test"
import { Schema } from "effect"
import { AgentV2 } from "@mongolgpt/core/agent"
import { Location as CoreLocation } from "@mongolgpt/core/location"
import { ModelV2 } from "@mongolgpt/core/model"
import { SessionV2 } from "@mongolgpt/core/session"
import { SessionInput as CoreSessionInput } from "@mongolgpt/core/session/input"
import { SessionMessage as CoreSessionMessage } from "@mongolgpt/core/session/message"
import { Prompt as CorePrompt } from "@mongolgpt/core/session/prompt"
import { Agent } from "@mongolgpt/schema/agent"
import { Location } from "@mongolgpt/schema/location"
import { Model } from "@mongolgpt/schema/model"
import { Project } from "@mongolgpt/schema/project"
import { Provider } from "@mongolgpt/schema/provider"
import { Prompt } from "@mongolgpt/schema/prompt"
import { Session } from "@mongolgpt/schema/session"
import { SessionInput } from "@mongolgpt/schema/session-input"
import { SessionMessage } from "@mongolgpt/schema/session-message"
import { Workspace } from "@mongolgpt/schema/workspace"
import { Api } from "@mongolgpt/server/api"
import { compile, emitPromise } from "@mongolgpt/httpapi-codegen"
import { HttpApi } from "effect/unstable/httpapi"
import { EventGroup, SessionGroup } from "../src/contract"

test("Core and Server reuse the authoritative Schema and Protocol values", () => {
  expect(AgentV2.ID).toBe(Agent.ID)
  expect(CoreLocation.Ref).toBe(Location.Ref)
  expect(ModelV2.Ref).toBe(Model.Ref)
  expect(SessionV2.Info).toBe(Session.Info)
  expect(CoreSessionInput.Admitted).toBe(SessionInput.Admitted)
  expect(CoreSessionMessage.Message).toBe(SessionMessage.Message)
  expect(CorePrompt).toBe(Prompt)
  expect(Api.groups["server.session"].identifier).toBe("server.session")
  expect(SessionGroup.identifier).toBe(Api.groups["server.session"].identifier)
  expect(EventGroup.identifier).toBe(Api.groups["server.event"].identifier)
  expect(Session.ID.create()).toStartWith("ses_")
  expect(Project.ID.global).toBe("global")
  expect(Provider.ID.anthropic).toBe("anthropic")
  expect(Workspace.ID.create()).toStartWith("wrk_")
})

test("client and Server Session contracts generate identically", () => {
  const options = { groupNames: { "server.session": "sessions" } }
  const server = compile(HttpApi.make("server").add(Api.groups["server.session"]), options)
  const client = compile(HttpApi.make("client").add(SessionGroup), options)

  expect(emitPromise(client)).toEqual(emitPromise(server))
})

test("shared DTO schemas construct and decode plain objects", () => {
  const made = Prompt.make({ text: "hello" })
  const decoded = Schema.decodeUnknownSync(Prompt)({ text: "hello" })
  const content = Schema.decodeUnknownSync(SessionMessage.AssistantText)({ type: "text", id: "part_1", text: "hi" })

  expect(Object.getPrototypeOf(made)).toBe(Object.prototype)
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype)
  expect(Object.getPrototypeOf(content)).toBe(Object.prototype)
  expect(Prompt.ast.annotations?.identifier).toBe("Prompt")
  expect(SessionMessage.AssistantText.ast.annotations?.identifier).toBe("Session.Message.Assistant.Text")
  expect(CoreSessionMessage.AssistantText).toBe(SessionMessage.AssistantText)
})
