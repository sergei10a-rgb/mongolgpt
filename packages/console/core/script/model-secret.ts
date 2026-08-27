export const MODEL_SECRET_PARTS = 30

export function modelSecretName(index: number) {
  return `MONGOLGPT_GATEWAY_MODELS${index + 1}`
}

function legacyModelSecretName(index: number) {
  return `ZEN_MODELS${index + 1}`
}

function readParts(lines: string[], name: (index: number) => string) {
  return Array.from({ length: MODEL_SECRET_PARTS }, (_, index) => {
    const key = name(index)
    return lines
      .find((line) => line.startsWith(`${key}=`))
      ?.split("=")
      .slice(1)
      .join("=")
  })
}

export function readModelSecretParts(output: string) {
  const lines = output.split("\n")
  const canonical = readParts(lines, modelSecretName)
  if (
    canonical
      .map((value) => value ?? "")
      .join("")
      .trim()
  )
    return canonical.map((value) => value ?? "")

  const legacy = readParts(lines, legacyModelSecretName)
  if (legacy[0] === undefined) {
    throw new Error(`${modelSecretName(0)} болон ${legacyModelSecretName(0)} олдсонгүй`)
  }
  return legacy.map((value) => value ?? "")
}

export function serializeModelSecretEnv(values: string[]) {
  return values.map((value, index) => `${modelSecretName(index)}="${value.replace(/"/g, '\\"')}"`).join("\n")
}
