import { docsUrl, supportUrl } from "@/product"

export type DesktopMenuPlatform = "macos" | "windows"

export type DesktopMenuAction =
  | "app.checkForUpdates"
  | "app.relaunch"
  | "edit.undo"
  | "edit.redo"
  | "edit.cut"
  | "edit.copy"
  | "edit.paste"
  | "edit.delete"
  | "edit.selectAll"
  | "view.reload"
  | "view.toggleDevTools"
  | "view.resetZoom"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.toggleFullscreen"
  | "window.new"
  | "window.close"
  | "window.minimize"
  | "window.toggleMaximize"

export type DesktopMenuRole =
  | "about"
  | "close"
  | "copy"
  | "cut"
  | "hide"
  | "hideOthers"
  | "paste"
  | "quit"
  | "redo"
  | "reload"
  | "resetZoom"
  | "selectAll"
  | "toggleDevTools"
  | "togglefullscreen"
  | "undo"
  | "unhide"
  | "windowMenu"
  | "zoomIn"
  | "zoomOut"

export type DesktopMenuItem = {
  type: "item"
  label?: string
  command?: string
  action?: DesktopMenuAction
  role?: DesktopMenuRole
  href?: string
  accelerator?: Partial<Record<DesktopMenuPlatform, string>>
  enabled?: "updater"
  platforms?: DesktopMenuPlatform[]
}

export type DesktopMenuSeparator = {
  type: "separator"
  platforms?: DesktopMenuPlatform[]
}

export type DesktopMenuEntry = DesktopMenuItem | DesktopMenuSeparator

export type DesktopMenu = {
  id: string
  label: string
  role?: DesktopMenuRole
  items?: DesktopMenuEntry[]
  platforms?: DesktopMenuPlatform[]
}

export const DESKTOP_MENU: DesktopMenu[] = [
  {
    id: "app",
    label: "MongolGPT",
    platforms: ["macos"],
    items: [
      { type: "item", role: "about" },
      { type: "item", label: "Шинэчлэл шалгах...", action: "app.checkForUpdates", enabled: "updater" },
      { type: "item", label: "Тохиргоо", command: "settings.open", accelerator: { macos: "Cmd+," } },
      { type: "item", label: "Webview дахин ачаалах", action: "view.reload" },
      { type: "item", label: "Дахин эхлүүлэх", action: "app.relaunch" },
      { type: "item", label: "Лог экспортлох...", command: "logs.export" },
      { type: "separator" },
      { type: "item", role: "hide" },
      { type: "item", role: "hideOthers" },
      { type: "item", role: "unhide" },
      { type: "separator" },
      { type: "item", role: "quit" },
    ],
  },
  {
    id: "file",
    label: "Файл",
    items: [
      {
        type: "item",
        label: "Шинэ session",
        command: "session.new",
        accelerator: { macos: "Shift+Cmd+S" },
      },
      { type: "item", label: "Төсөл нээх...", command: "project.open", accelerator: { macos: "Cmd+O" } },
      {
        type: "item",
        label: "Тохиргоо",
        command: "settings.open",
        accelerator: { windows: "Ctrl+," },
        platforms: ["windows"],
      },
      {
        type: "item",
        label: "Шинэ цонх",
        action: "window.new",
        accelerator: { macos: "Cmd+Shift+N", windows: "Ctrl+Shift+N" },
      },
      { type: "separator" },
      { type: "item", label: "Цонх хаах", action: "window.close", role: "close" },
    ],
  },
  {
    id: "edit",
    label: "Засвар",
    items: [
      { type: "item", label: "Буцаах", action: "edit.undo", role: "undo", accelerator: { windows: "Ctrl+Z" } },
      { type: "item", label: "Дахин хийх", action: "edit.redo", role: "redo", accelerator: { windows: "Ctrl+Y" } },
      { type: "separator" },
      { type: "item", label: "Хайчлах", action: "edit.cut", role: "cut", accelerator: { windows: "Ctrl+X" } },
      { type: "item", label: "Хуулах", action: "edit.copy", role: "copy", accelerator: { windows: "Ctrl+C" } },
      { type: "item", label: "Буулгах", action: "edit.paste", role: "paste", accelerator: { windows: "Ctrl+V" } },
      { type: "item", label: "Устгах", action: "edit.delete" },
      {
        type: "item",
        label: "Бүгдийг сонгох",
        action: "edit.selectAll",
        role: "selectAll",
        accelerator: { windows: "Ctrl+A" },
      },
    ],
  },
  {
    id: "view",
    label: "Харагдац",
    items: [
      { type: "item", label: "Хажуу самбар асаах/унтраах", command: "sidebar.toggle" },
      { type: "item", label: "Терминал асаах/унтраах", command: "terminal.toggle", accelerator: { macos: "Ctrl+`" } },
      { type: "item", label: "Файлын мод асаах/унтраах", command: "fileTree.toggle" },
      { type: "separator" },
      { type: "item", label: "Дахин ачаалах", action: "view.reload", role: "reload" },
      { type: "item", label: "Developer tools асаах/унтраах", action: "view.toggleDevTools", role: "toggleDevTools" },
      { type: "separator" },
      {
        type: "item",
        label: "Бодит хэмжээ",
        action: "view.resetZoom",
        role: "resetZoom",
        accelerator: { windows: "Ctrl+0" },
      },
      { type: "item", label: "Томруулах", action: "view.zoomIn", role: "zoomIn", accelerator: { windows: "Ctrl++" } },
      {
        type: "item",
        label: "Жижигрүүлэх",
        action: "view.zoomOut",
        role: "zoomOut",
        accelerator: { windows: "Ctrl+-" },
      },
      { type: "separator" },
      { type: "item", label: "Бүтэн дэлгэц асаах/унтраах", action: "view.toggleFullscreen", role: "togglefullscreen" },
    ],
  },
  {
    id: "go",
    label: "Шилжих",
    items: [
      { type: "item", label: "Буцах", command: "common.goBack", accelerator: { macos: "Cmd+[" } },
      { type: "item", label: "Урагшлах", command: "common.goForward", accelerator: { macos: "Cmd+]" } },
      { type: "separator" },
      { type: "item", label: "Өмнөх session", command: "session.previous", accelerator: { macos: "Option+Up" } },
      { type: "item", label: "Дараагийн session", command: "session.next", accelerator: { macos: "Option+Down" } },
      { type: "separator" },
      {
        type: "item",
        label: "Өмнөх төсөл",
        command: "project.previous",
        accelerator: { macos: "Cmd+Option+Up" },
      },
      {
        type: "item",
        label: "Дараагийн төсөл",
        command: "project.next",
        accelerator: { macos: "Cmd+Option+Down" },
      },
    ],
  },
  {
    id: "window",
    label: "Цонх",
    role: "windowMenu",
    items: [
      { type: "item", label: "Хураах", action: "window.minimize" },
      { type: "item", label: "Томруулах", action: "window.toggleMaximize" },
      { type: "separator" },
      { type: "item", label: "Цонх хаах", action: "window.close" },
    ],
  },
  {
    id: "help",
    label: "Тусламж",
    items: [
      { type: "item", label: "MongolGPT баримт", href: docsUrl },
      { type: "item", label: "Тусламж ба асуудал мэдээлэх", href: supportUrl },
      { type: "item", label: "Лог экспортлох...", command: "logs.export" },
      { type: "separator" },
      {
        type: "item",
        label: "Санал хүсэлт илгээх",
        href: "https://github.com/sergei10a-rgb/mongolgpt/issues/new?template=feature_request.yml",
      },
      {
        type: "item",
        label: "Алдаа мэдээлэх",
        href: "https://github.com/sergei10a-rgb/mongolgpt/issues/new?template=bug_report.yml",
      },
    ],
  },
]

export function desktopMenuVisible(item: { platforms?: DesktopMenuPlatform[] }, platform: DesktopMenuPlatform) {
  return !item.platforms || item.platforms.includes(platform)
}
