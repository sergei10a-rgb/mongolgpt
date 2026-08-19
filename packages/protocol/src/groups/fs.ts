import { FileSystem } from "@mongolgpt/schema/filesystem"
import { Location } from "@mongolgpt/schema/location"
import { PositiveInt, RelativePath } from "@mongolgpt/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

const ListQuery = Schema.Struct({
  ...LocationQuery.fields,
  path: RelativePath.pipe(Schema.optional),
})

const FindQuery = Schema.Struct({
  ...LocationQuery.fields,
  query: FileSystem.FindInput.fields.query,
  type: FileSystem.FindInput.fields.type,
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
})

export const FileSystemGroup = HttpApiGroup.make("server.fs")
  .add(
    HttpApiEndpoint.get("fs.read", "/api/fs/read/*", {
      query: LocationQuery,
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.read",
          summary: "Файл унших",
          description: "Хүссэн байршилтай харьцуулсан замаар нэг файлыг дамжуулна.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.list", "/api/fs/list", {
      query: ListQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.list",
          summary: "Хавтас жагсаах",
          description: "Хүссэн байршилтай харьцуулсан замаар нэг хавтасны шууд доторх зүйлсийг жагсаана.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.find", "/api/fs/find", {
      query: FindQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.find",
          summary: "Файл хайх",
          description: "Хүссэн байршилтай харьцуулсан замаар файлын системийн зүйлсийг рекурсивээр хайж эрэмбэлнэ.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "файлын систем",
      description: "Байршлаар хязгаарласан туршилтын файлын системийн маршрутууд.",
    }),
  )
