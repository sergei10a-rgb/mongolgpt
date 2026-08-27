import { release } from "node:os"
import { InstallationVersion } from "@mongolgpt/core/installation/version"
import { productSupportUrl } from "@mongolgpt/core/product"

const MAX_REPORT_LENGTH = 5000
const MAX_MESSAGE_LENGTH = 1000
const TRUNCATION_MARKER = "\n... (таслав)"

export function buildSupportReport(message: string, stack: string) {
  const summary = truncate(message.trim() || "Тодорхойгүй алдаа гарлаа.", MAX_MESSAGE_LENGTH)
  const header = [
    "MongolGPT TUI алдааны тайлан",
    "",
    `Хувилбар: ${InstallationVersion}`,
    `Үйлдлийн систем: ${describeOS()}`,
    `Терминал: ${truncate(describeTerminal(), 200)}`,
    `Алдаа: ${summary}`,
    "",
    "Стек мөр:",
    "```",
  ].join("\n")
  const footer = ["```", "", `Тусламж: ${supportUrl()}`].join("\n")
  const stackBudget = Math.max(0, MAX_REPORT_LENGTH - header.length - footer.length - 2)
  const trace = truncate(stack.trim() || "Стек мөр алга.", stackBudget)
  return `${header}\n${trace}\n${footer}`
}

function supportUrl() {
  const configured = process.env.MONGOLGPT_SUPPORT_URL?.trim()
  if (configured) return configured
  const consoleUrl = process.env.MONGOLGPT_CONSOLE_URL?.trim()
  if (consoleUrl) return `${consoleUrl.replace(/\/+$/, "")}/support`
  return productSupportUrl
}

function truncate(value: string, limit: number) {
  if (value.length <= limit) return value
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, limit)
  return value.slice(0, limit - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
}

function describeOS() {
  const name =
    process.platform === "darwin"
      ? "macOS"
      : process.platform === "win32"
        ? "Windows"
        : process.platform === "linux"
          ? "Linux"
          : process.platform
  return `${name} ${release()} (${process.arch})`
}

function describeTerminal() {
  const program = process.env.TERM_PROGRAM || process.env.TERM || "unknown"
  const version = process.env.TERM_PROGRAM_VERSION ? ` ${process.env.TERM_PROGRAM_VERSION}` : ""
  const multiplexer = process.env.TMUX ? " in tmux" : process.env.STY ? " in screen" : ""
  return `${program}${version}${multiplexer}`
}
