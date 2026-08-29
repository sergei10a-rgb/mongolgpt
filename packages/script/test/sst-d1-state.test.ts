import { expect, test } from "bun:test"
import { extractSstD1DatabaseId, SstD1StateError } from "../src/sst-d1-state"

const databaseId = "123e4567-e89b-42d3-a456-426614174000"

test("SST CheckpointV3 latest.resources хэлбэрээс D1 UUID авна", () => {
  expect(
    extractSstD1DatabaseId({
      stack: "mongolgpt/dev",
      latest: {
        manifest: {},
        resources: [
          {
            type: "cloudflare:index/d1Database:D1Database",
            urn: "urn:pulumi:dev::mongolgpt::cloudflare:index/d1Database:D1Database::DatabaseDatabase",
            outputs: { uuid: databaseId },
          },
        ],
      },
    }),
  ).toBe(databaseId)
})

test("SST D1 state parser component болон provider resource-ийн ижил UUID-г нэгтгэнэ", () => {
  expect(
    extractSstD1DatabaseId({
      deployment: {
        resources: [
          {
            type: "sst:cloudflare:D1",
            urn: "urn:pulumi:dev::mongolgpt::sst:cloudflare:D1::Database",
            outputs: { databaseId },
          },
          {
            type: "cloudflare:index/d1Database:D1Database",
            urn: "urn:pulumi:dev::mongolgpt::sst:cloudflare:D1$cloudflare:index/d1Database:D1Database::DatabaseDatabase",
            id: `account/${databaseId}`,
            outputs: { uuid: databaseId.toUpperCase() },
          },
        ],
      },
    }),
  ).toBe(databaseId)
})

test("SST component output байхгүй үед provider resource-ийн UUID-г ашиглана", () => {
  expect(
    extractSstD1DatabaseId({
      latest: {
        resources: [
          {
            type: "sst:cloudflare:D1",
            urn: "urn:pulumi:dev::mongolgpt::sst:cloudflare:D1::Database",
            outputs: {},
          },
          {
            type: "cloudflare:index/d1Database:D1Database",
            urn: "urn:pulumi:dev::mongolgpt::sst:cloudflare:D1$cloudflare:index/d1Database:D1Database::DatabaseDatabase",
            id: databaseId,
            outputs: {},
          },
        ],
      },
    }),
  ).toBe(databaseId)
})

test("SST D1 state parser provider composite id-гаас UUID авна", () => {
  expect(
    extractSstD1DatabaseId({
      deployment: {
        resources: [
          {
            type: "cloudflare:index/d1Database:D1Database",
            urn: "urn:pulumi:dev::mongolgpt::cloudflare:index/d1Database:D1Database::DatabaseDatabase",
            id: `account/${databaseId}`,
            outputs: {},
          },
        ],
      },
    }),
  ).toBe(databaseId)
})

test("SST D1 state parser байхгүй, зөрүүтэй болон malformed database дээр fail-closed байна", () => {
  expect(() => extractSstD1DatabaseId({})).toThrow(SstD1StateError)
  expect(() =>
    extractSstD1DatabaseId({
      deployment: {
        resources: [
          {
            type: "sst:cloudflare:D1",
            urn: "urn:pulumi:dev::mongolgpt::sst:cloudflare:D1::Database",
            outputs: { databaseId: "not-a-uuid" },
          },
        ],
      },
    }),
  ).toThrow("UUID буруу")
  expect(() =>
    extractSstD1DatabaseId({
      deployment: {
        resources: [
          {
            type: "sst:cloudflare:D1",
            urn: "urn:pulumi:dev::mongolgpt::sst:cloudflare:D1::Database",
            outputs: { databaseId },
          },
          {
            type: "cloudflare:index/d1Database:D1Database",
            urn: "urn:pulumi:dev::mongolgpt::cloudflare:index/d1Database:D1Database::DatabaseReplica",
            outputs: { uuid: "123e4567-e89b-42d3-b456-426614174001" },
          },
        ],
      },
    }),
  ).toThrow("2 олдлоо")
})
