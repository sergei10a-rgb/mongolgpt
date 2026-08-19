export * as TuiKeybind from "./keybind"

import type { KeyEvent, Renderable } from "@opentui/core"
import type { Binding } from "@opentui/keymap"
import type { BindingCommandMap, BindingConfig, BindingDefaults } from "@opentui/keymap/extras"
import { Schema } from "effect"

const KeyStroke = Schema.Struct({
  name: Schema.String,
  ctrl: Schema.optional(Schema.Boolean),
  shift: Schema.optional(Schema.Boolean),
  meta: Schema.optional(Schema.Boolean),
  super: Schema.optional(Schema.Boolean),
  hyper: Schema.optional(Schema.Boolean),
})

const BindingObject = Schema.StructWithRest(
  Schema.Struct({
    key: Schema.Union([Schema.String, KeyStroke]),
    event: Schema.optional(Schema.Literals(["press", "release"])),
    preventDefault: Schema.optional(Schema.Boolean),
    fallthrough: Schema.optional(Schema.Boolean),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

const BindingItem = Schema.Union([Schema.String, KeyStroke, BindingObject])
export const BindingValueSchema = Schema.Union([
  Schema.Literal(false),
  Schema.Literal("none"),
  BindingItem,
  Schema.Array(BindingItem),
])
export type BindingValueSchema = Schema.Schema.Type<typeof BindingValueSchema>

type Definition = {
  default: BindingValueSchema
  description: string
}

export const LeaderDefault = "ctrl+x"

const keybind = (value: Definition["default"], description: string): Definition => ({ default: value, description })

export const Definitions = {
  leader: keybind(LeaderDefault, "Товчны хослолын удирдах товч"),

  app_exit: keybind("ctrl+c,ctrl+d,<leader>q", "Аппаас гарах"),
  app_debug: keybind("none", "Дибагийн самбарыг асаах/унтраах"),
  app_console: keybind("none", "Консолыг асаах/унтраах"),
  app_heap_snapshot: keybind("none", "Овоолгын агшны зургийг бичих"),
  app_toggle_animations: keybind("none", "Анимацыг асаах/унтраах"),
  app_toggle_file_context: keybind("none", "Файлын контекстийг асаах/унтраах"),
  app_toggle_diffwrap: keybind("none", "Өөрчлөлтийн мөр хуваалтыг асаах/унтраах"),
  app_toggle_paste_summary: keybind("none", "Наалтын товчлолын хураангуйг асаах/унтраах"),
  app_toggle_session_directory_filter: keybind("none", "Сешний хавтасны шүүлтүүрийг асаах/унтраах"),
  command_list: keybind("ctrl+p", "Боломжит командуудыг жагсаах"),
  help_show: keybind("none", "Тусламжийн харилцах цонх нээх"),
  docs_open: keybind("none", "Баримт нээх"),
  diff_open: keybind("none", "Өөрчлөлт харагч нээх"),
  diff_close: keybind("escape,q", "Өөрчлөлт харагч хаах"),
  diff_toggle: keybind("enter,space", "Өөрчлөлт харагчийн мөрийг нээх/хаах"),
  diff_expand: keybind("right", "Өөрчлөлт харагчийн мөрийг дэлгэх"),
  diff_expand_all: keybind("E", "Өөрчлөлт харагчийн бүх хавтсыг дэлгэх"),
  diff_collapse: keybind("left", "Өөрчлөлт харагчийн мөрийг хураах"),
  diff_switch_focus: keybind("tab", "Өөрчлөлт харагчийн идэвхтэй хэсгийг солих"),
  diff_next_hunk: keybind("]", "Дараагийн өөрчлөлтийн хэсэг рүү очих"),
  diff_previous_hunk: keybind("[", "Өмнөх өөрчлөлтийн хэсэг рүү очих"),
  diff_next_file: keybind("n", "Дараагийн өөрчлөлтийн файл руу очих"),
  diff_previous_file: keybind("p", "Өмнөх өөрчлөлтийн файл руу очих"),
  diff_toggle_file_tree: keybind("b", "Өөрчлөлт харагчийн файлын модыг асаах/унтраах"),
  diff_single_patch: keybind("s", "Нэг өөрчлөлтийн хэсгийн харагдацыг асаах/унтраах"),
  diff_switch_source: keybind("d", "Өөрчлөлтийн эх сурвалж солих"),
  diff_toggle_view: keybind("v", "Өөрчлөлтийг хувааж/нэгтгэж харах горимыг солих"),
  diff_help: keybind("?", "Өөрчлөлт харагчийн нэмэлт товчны хослолыг харуулах"),

  editor_open: keybind("<leader>e", "Гадаад засварлагч нээх"),
  theme_list: keybind("<leader>t", "Боломжит өнгөний сэдвүүдийг жагсаах"),
  theme_switch_mode: keybind("none", "Гэрэл/бараан өнгөний сэдэв солих"),
  theme_mode_lock: keybind("none", "Өнгөний сэдвийн горимыг түгжих эсвэл тайлах"),
  sidebar_toggle: keybind("<leader>b", "Хажуу самбарыг асаах/унтраах"),
  scrollbar_toggle: keybind("none", "Сешний гүйлгүүрийг асаах/унтраах"),
  status_view: keybind("<leader>s", "Төлөв харах"),

  session_export: keybind("<leader>x", "Сешнийг засварлагч руу экспортлох"),
  session_copy: keybind("none", "Сешний бичлэгийг хуулах"),
  session_move: keybind("none", "Сешн зөөх"),
  session_new: keybind("<leader>n", "Шинэ сешн үүсгэх"),
  session_list: keybind("<leader>l", "Бүх сешнийг жагсаах"),
  session_timeline: keybind("<leader>g", "Сешний цагийн шугам харуулах"),
  session_fork: keybind("none", "Зурвасаас сешн салаалах"),
  session_rename: keybind("ctrl+r", "Сешний нэр өөрчлөх"),
  session_delete: keybind("ctrl+d", "Сешн устгах"),
  session_share: keybind("none", "Одоогийн сешнийг хуваалцах"),
  session_unshare: keybind("none", "Одоогийн сешний хуваалцалтыг болиулах"),
  session_interrupt: keybind("escape", "Одоогийн сешнийг таслах"),
  session_background: keybind("ctrl+b", "Синхрон дэд агентуудыг арын горимд шилжүүлэх"),
  session_compact: keybind("<leader>c", "Сешнийг хураангуйлах"),
  session_toggle_timestamps: keybind("none", "Зурвасын цагийн тэмдэглэгээг асаах/унтраах"),
  session_toggle_generic_tool_output: keybind("none", "Ерөнхий хэрэгслийн гаралтыг асаах/унтраах"),
  session_queued_prompts: keybind("<leader>q", "Дараалалд буй хүсэлтүүдийг удирдах"),
  session_child_first: keybind("<leader>down", "Эхний дэд сешн рүү очих"),
  session_child_cycle: keybind("right", "Дараагийн дэд сешн рүү очих"),
  session_child_cycle_reverse: keybind("left", "Өмнөх дэд сешн рүү очих"),
  session_parent: keybind("up", "Эцэг сешн рүү очих"),
  session_pin_toggle: keybind("ctrl+f", "Сешний жагсаалтад сешнийг тогтоох/чөлөөлөх"),
  session_quick_switch_1: keybind("<leader>1", "Шуурхай байрлал 1-ийн сешн рүү шилжих"),
  session_quick_switch_2: keybind("<leader>2", "Шуурхай байрлал 2-ын сешн рүү шилжих"),
  session_quick_switch_3: keybind("<leader>3", "Шуурхай байрлал 3-ын сешн рүү шилжих"),
  session_quick_switch_4: keybind("<leader>4", "Шуурхай байрлал 4-ийн сешн рүү шилжих"),
  session_quick_switch_5: keybind("<leader>5", "Шуурхай байрлал 5-ын сешн рүү шилжих"),
  session_quick_switch_6: keybind("<leader>6", "Шуурхай байрлал 6-ын сешн рүү шилжих"),
  session_quick_switch_7: keybind("<leader>7", "Шуурхай байрлал 7-ын сешн рүү шилжих"),
  session_quick_switch_8: keybind("<leader>8", "Шуурхай байрлал 8-ын сешн рүү шилжих"),
  session_quick_switch_9: keybind("<leader>9", "Шуурхай байрлал 9-ийн сешн рүү шилжих"),

  stash_delete: keybind("ctrl+d", "Хадгалсан хүсэлтийн бичлэг устгах"),
  model_provider_list: keybind("ctrl+a", "Загварын харилцах цонхноос үйлчилгээ үзүүлэгчдийн жагсаалт нээх"),
  model_favorite_toggle: keybind("ctrl+f", "Загварын дуртай төлөвийг солих"),
  model_list: keybind("<leader>m", "Боломжит загваруудыг жагсаах"),
  model_cycle_recent: keybind("f2", "Сүүлд ашигласан дараагийн загвар"),
  model_cycle_recent_reverse: keybind("shift+f2", "Сүүлд ашигласан өмнөх загвар"),
  model_cycle_favorite: keybind("none", "Дараагийн дуртай загвар"),
  model_cycle_favorite_reverse: keybind("none", "Өмнөх дуртай загвар"),
  mcp_list: keybind("none", "MCP серверүүдийг жагсаах"),
  provider_connect: keybind("none", "Үйлчилгээ үзүүлэгч холбох"),
  console_org_switch: keybind("none", "Консолын байгууллага солих"),
  agent_list: keybind("<leader>a", "Агентуудыг жагсаах"),
  agent_cycle: keybind("tab", "Дараагийн агент"),
  agent_cycle_reverse: keybind("shift+tab", "Өмнөх агент"),
  variant_cycle: keybind("ctrl+t", "Загварын хувилбаруудаар эргүүлэх"),
  variant_list: keybind("none", "Загварын хувилбаруудыг жагсаах"),

  messages_page_up: keybind("pageup,ctrl+alt+b", "Зурвасуудыг нэг хуудсаар дээш гүйлгэх"),
  messages_page_down: keybind("pagedown,ctrl+alt+f", "Зурвасуудыг нэг хуудсаар доош гүйлгэх"),
  messages_line_up: keybind("ctrl+alt+y", "Зурвасуудыг нэг мөрөөр дээш гүйлгэх"),
  messages_line_down: keybind("ctrl+alt+e", "Зурвасуудыг нэг мөрөөр доош гүйлгэх"),
  messages_half_page_up: keybind("ctrl+alt+u", "Зурвасуудыг хагас хуудсаар дээш гүйлгэх"),
  messages_half_page_down: keybind("ctrl+alt+d", "Зурвасуудыг хагас хуудсаар доош гүйлгэх"),
  messages_first: keybind("ctrl+g,home", "Эхний зурвас руу очих"),
  messages_last: keybind("ctrl+alt+g,end", "Сүүлийн зурвас руу очих"),
  messages_next: keybind("none", "Дараагийн зурвас руу очих"),
  messages_previous: keybind("none", "Өмнөх зурвас руу очих"),
  messages_last_user: keybind("none", "Хэрэглэгчийн сүүлийн зурвас руу очих"),
  messages_copy: keybind("<leader>y", "Зурвас хуулах"),
  messages_undo: keybind("<leader>u", "Зурвасыг буцаах"),
  messages_redo: keybind("<leader>r", "Зурвасыг дахин хийх"),
  messages_toggle_conceal: keybind("<leader>h", "Зурвас дахь кодын хэсэг нуух горимыг асаах/унтраах"),
  tool_details: keybind("none", "Хэрэгслийн дэлгэрэнгүй харагдацыг асаах/унтраах"),
  display_thinking: keybind("none", "Бодолтын хэсгийн харагдацыг асаах/унтраах"),

  prompt_submit: keybind("none", "Хүсэлт илгээх"),
  prompt_editor_context_clear: keybind("none", "Засварлагчийн агуулгыг цэвэрлэх"),
  prompt_skills: keybind("none", "Ур чадвар сонгогч нээх"),
  prompt_stash: keybind("none", "Хүсэлтийг хадгалах"),
  prompt_stash_pop: keybind("none", "Хадгалсан хүсэлтийг сэргээх"),
  prompt_stash_list: keybind("none", "Хадгалсан хүсэлтүүдийг жагсаах"),
  workspace_set: keybind("none", "Ажлын орчин тохируулах"),

  input_clear: keybind("ctrl+c", "Оролтын талбарыг цэвэрлэх"),
  input_paste: keybind({ key: "ctrl+v", preventDefault: false }, "Түр санах ойгоос наах"),
  input_submit: keybind("return", "Оролт илгээх"),
  input_newline: keybind("shift+return,ctrl+return,alt+return,ctrl+j", "Оролтод шинэ мөр оруулах"),
  input_move_left: keybind("left,ctrl+b", "Оролт дахь заагчийг зүүн тийш хөдөлгөх"),
  input_move_right: keybind("right,ctrl+f", "Оролт дахь заагчийг баруун тийш хөдөлгөх"),
  input_move_up: keybind("up", "Оролт дахь заагчийг дээш хөдөлгөх"),
  input_move_down: keybind("down", "Оролт дахь заагчийг доош хөдөлгөх"),
  input_select_left: keybind("shift+left", "Оролтод зүүн тийш сонгох"),
  input_select_right: keybind("shift+right", "Оролтод баруун тийш сонгох"),
  input_select_up: keybind("shift+up", "Оролтод дээш сонгох"),
  input_select_down: keybind("shift+down", "Оролтод доош сонгох"),
  input_line_home: keybind("ctrl+a", "Оролтын мөрийн эхэнд очих"),
  input_line_end: keybind("ctrl+e", "Оролтын мөрийн төгсгөлд очих"),
  input_select_line_home: keybind("ctrl+shift+a", "Оролтын мөрийн эхлэл хүртэл сонгох"),
  input_select_line_end: keybind("ctrl+shift+e", "Оролтын мөрийн төгсгөл хүртэл сонгох"),
  input_visual_line_home: keybind("alt+a", "Оролтын харагдах мөрийн эхэнд очих"),
  input_visual_line_end: keybind("alt+e", "Оролтын харагдах мөрийн төгсгөлд очих"),
  input_select_visual_line_home: keybind("alt+shift+a", "Оролтын харагдах мөрийн эхлэл хүртэл сонгох"),
  input_select_visual_line_end: keybind("alt+shift+e", "Оролтын харагдах мөрийн төгсгөл хүртэл сонгох"),
  input_buffer_home: keybind("home", "Оролтын түр санах ойн эхэнд очих"),
  input_buffer_end: keybind("end", "Оролтын түр санах ойн төгсгөлд очих"),
  input_select_buffer_home: keybind("shift+home", "Оролтын түр санах ойн эхлэл хүртэл сонгох"),
  input_select_buffer_end: keybind("shift+end", "Оролтын түр санах ойн төгсгөл хүртэл сонгох"),
  input_delete_line: keybind("ctrl+shift+d", "Оролт дахь мөр устгах"),
  input_delete_to_line_end: keybind("ctrl+k", "Оролтын мөрийн төгсгөл хүртэл устгах"),
  input_delete_to_line_start: keybind("ctrl+u", "Оролтын мөрийн эхлэл хүртэл устгах"),
  input_backspace: keybind("backspace,shift+backspace", "Оролтын өмнөх тэмдэгтийг устгах"),
  input_delete: keybind("ctrl+d,delete,shift+delete", "Оролт дахь тэмдэгт устгах"),
  input_undo: keybind("ctrl+-,super+z", "Оролт дахь үйлдлийг буцаах"),
  input_redo: keybind("ctrl+.,super+shift+z", "Оролт дахь үйлдлийг дахин хийх"),
  input_word_forward: keybind("alt+f,alt+right,ctrl+right", "Оролтод нэг үгээр урагш шилжих"),
  input_word_backward: keybind("alt+b,alt+left,ctrl+left", "Оролтод нэг үгээр хойш шилжих"),
  input_select_word_forward: keybind("alt+shift+f,alt+shift+right", "Оролтод нэг үгээр урагш сонгох"),
  input_select_word_backward: keybind("alt+shift+b,alt+shift+left", "Оролтод нэг үгээр хойш сонгох"),
  input_delete_word_forward: keybind("alt+d,alt+delete,ctrl+delete", "Оролтод дараагийн үгийг устгах"),
  input_delete_word_backward: keybind("ctrl+w,ctrl+backspace,alt+backspace", "Оролтод өмнөх үгийг устгах"),
  input_select_all: keybind("super+a", "Оролт дахь бүгдийг сонгох"),
  history_previous: keybind("up", "Түүхийн өмнөх бичлэг"),
  history_next: keybind("down", "Түүхийн дараагийн бичлэг"),

  "dialog.select.prev": keybind("up,ctrl+p", "Харилцах цонхны өмнөх мөр рүү шилжих"),
  "dialog.select.next": keybind("down,ctrl+n", "Харилцах цонхны дараагийн мөр рүү шилжих"),
  "dialog.select.page_up": keybind("pageup", "Харилцах цонхонд нэг хуудсаар дээш шилжих"),
  "dialog.select.page_down": keybind("pagedown", "Харилцах цонхонд нэг хуудсаар доош шилжих"),
  "dialog.select.home": keybind("home", "Харилцах цонхны эхний мөр рүү очих"),
  "dialog.select.end": keybind("end", "Харилцах цонхны сүүлийн мөр рүү очих"),
  "dialog.select.submit": keybind("return", "Сонгосон харилцах цонхны мөрийг илгээх"),
  "dialog.prompt.submit": keybind("return", "Харилцах цонхны хүсэлтийг илгээх"),
  "dialog.mcp.toggle": keybind("space", "MCP харилцах цонхонд MCP асаах/унтраах"),
  "dialog.move_session.new": keybind("ctrl+m", "Шинэ төслийн хуулбар үүсгэх"),
  "dialog.move_session.delete": keybind("ctrl+d", "Төслийн хуулбарыг устгах"),
  "dialog.move_session.refresh": keybind("ctrl+r", "Төслийн хуулбаруудыг шинэчлэх"),
  "prompt.autocomplete.prev": keybind("up,ctrl+p", "Автоматаар бөглөх жагсаалтын өмнөх мөр рүү шилжих"),
  "prompt.autocomplete.next": keybind("down,ctrl+n", "Автоматаар бөглөх жагсаалтын дараагийн мөр рүү шилжих"),
  "prompt.autocomplete.hide": keybind("escape", "Автоматаар бөглөх жагсаалтыг нуух"),
  "prompt.autocomplete.select": keybind("return", "Автоматаар бөглөх мөр сонгох"),
  "prompt.autocomplete.complete": keybind("tab", "Автоматаар бөглөх мөрийг гүйцээх"),
  "permission.prompt.fullscreen": keybind("ctrl+f", "Зөвшөөрлийн хүсэлтийг бүтэн дэлгэцээр харуулах/болих"),
  "plugins.toggle": keybind("space", "Нэмэлтийг асаах/унтраах"),
  "dialog.plugins.install": keybind("shift+i", "Нэмэлтийн харилцах цонхноос нэмэлт суулгах"),

  terminal_suspend: keybind("ctrl+z", "Терминалыг түр зогсоох"),
  terminal_title_toggle: keybind("none", "Терминалын гарчгийг асаах/унтраах"),
  tips_toggle: keybind("<leader>h", "Нүүр дэлгэцийн зөвлөмжийг асаах/унтраах"),
  plugin_manager: keybind("none", "Нэмэлтийн удирдлагын харилцах цонх нээх"),
  plugin_install: keybind("none", "Нэмэлт суулгах"),

  which_key_toggle: keybind("ctrl+alt+k", "Which-key самбарыг асаах/унтраах"),
  which_key_layout_toggle: keybind("ctrl+alt+shift+k", "Which-key байрлал солих"),
  which_key_pending_toggle: keybind("ctrl+alt+shift+p", "Which-key хүлээгдэж буй урьдчилан харахыг асаах/унтраах"),
  which_key_group_previous: keybind("ctrl+alt+left,ctrl+alt+[", "Өмнөх which-key бүлэг"),
  which_key_group_next: keybind("ctrl+alt+right,ctrl+alt+]", "Дараагийн which-key бүлэг"),
  which_key_scroll_up: keybind("ctrl+alt+up,ctrl+alt+p", "Which-key-г дээш гүйлгэх"),
  which_key_scroll_down: keybind("ctrl+alt+down,ctrl+alt+n", "Which-key-г доош гүйлгэх"),
  which_key_page_up: keybind("ctrl+alt+pageup", "Which-key-г нэг хуудсаар дээш гүйлгэх"),
  which_key_page_down: keybind("ctrl+alt+pagedown", "Which-key-г нэг хуудсаар доош гүйлгэх"),
  which_key_home: keybind("ctrl+alt+home", "Эхний which-key товчны хослол руу очих"),
  which_key_end: keybind("ctrl+alt+end", "Сүүлийн which-key товчны хослол руу очих"),
} satisfies Record<string, Definition>

type KeybindName = keyof typeof Definitions
const KeybindNames = new Set<string>(Object.keys(Definitions))

export const KeybindOverrides = Schema.Struct(
  Object.fromEntries(
    Object.entries(Definitions).map(([name, item]) => [
      name,
      Schema.optional(BindingValueSchema).annotate({ description: item.description }),
    ]),
  ),
).annotate({ description: "TUI товчны хослолын өөрчлөлтүүд" })
export const Descriptions = Object.fromEntries(
  Object.entries(Definitions).map(([name, item]) => [name, item.description]),
) as Record<KeybindName, string>
export const CommandMap = {
  app_exit: "app.exit",
  app_debug: "app.debug",
  app_console: "app.console",
  app_heap_snapshot: "app.heap_snapshot",
  app_toggle_animations: "app.toggle.animations",
  app_toggle_file_context: "app.toggle.file_context",
  app_toggle_diffwrap: "app.toggle.diffwrap",
  app_toggle_paste_summary: "app.toggle.paste_summary",
  app_toggle_session_directory_filter: "app.toggle.session_directory_filter",
  command_list: "command.palette.show",
  help_show: "help.show",
  docs_open: "docs.open",
  diff_open: "diff.open",
  diff_close: "diff.close",
  diff_toggle: "diff.toggle",
  diff_expand: "diff.expand",
  diff_expand_all: "diff.expand_all",
  diff_collapse: "diff.collapse",
  diff_switch_focus: "diff.switch_focus",
  diff_next_hunk: "diff.next_hunk",
  diff_previous_hunk: "diff.previous_hunk",
  diff_next_file: "diff.next_file",
  diff_previous_file: "diff.previous_file",
  diff_toggle_file_tree: "diff.toggle_file_tree",
  diff_single_patch: "diff.single_patch",
  diff_switch_source: "diff.switch_source",
  diff_toggle_view: "diff.toggle_view",
  diff_help: "diff.help",
  editor_open: "prompt.editor",
  theme_list: "theme.switch",
  theme_switch_mode: "theme.switch_mode",
  theme_mode_lock: "theme.mode.lock",
  sidebar_toggle: "session.sidebar.toggle",
  scrollbar_toggle: "session.toggle.scrollbar",
  status_view: "mongolgpt.status",
  session_export: "session.export",
  session_copy: "session.copy",
  session_move: "session.move",
  session_new: "session.new",
  session_list: "session.list",
  session_timeline: "session.timeline",
  session_fork: "session.fork",
  session_rename: "session.rename",
  session_delete: "session.delete",
  session_share: "session.share",
  session_unshare: "session.unshare",
  session_interrupt: "session.interrupt",
  session_background: "session.background",
  session_compact: "session.compact",
  session_toggle_timestamps: "session.toggle.timestamps",
  session_toggle_generic_tool_output: "session.toggle.generic_tool_output",
  session_queued_prompts: "session.queued_prompts",
  session_child_first: "session.child.first",
  session_child_cycle: "session.child.next",
  session_child_cycle_reverse: "session.child.previous",
  session_parent: "session.parent",
  session_pin_toggle: "session.pin.toggle",
  session_quick_switch_1: "session.quick_switch.1",
  session_quick_switch_2: "session.quick_switch.2",
  session_quick_switch_3: "session.quick_switch.3",
  session_quick_switch_4: "session.quick_switch.4",
  session_quick_switch_5: "session.quick_switch.5",
  session_quick_switch_6: "session.quick_switch.6",
  session_quick_switch_7: "session.quick_switch.7",
  session_quick_switch_8: "session.quick_switch.8",
  session_quick_switch_9: "session.quick_switch.9",
  stash_delete: "stash.delete",
  model_provider_list: "model.dialog.provider",
  model_favorite_toggle: "model.dialog.favorite",
  model_list: "model.list",
  model_cycle_recent: "model.cycle_recent",
  model_cycle_recent_reverse: "model.cycle_recent_reverse",
  model_cycle_favorite: "model.cycle_favorite",
  model_cycle_favorite_reverse: "model.cycle_favorite_reverse",
  mcp_list: "mcp.list",
  provider_connect: "provider.connect",
  console_org_switch: "console.org.switch",
  agent_list: "agent.list",
  agent_cycle: "agent.cycle",
  agent_cycle_reverse: "agent.cycle.reverse",
  variant_cycle: "variant.cycle",
  variant_list: "variant.list",
  messages_page_up: "session.page.up",
  messages_page_down: "session.page.down",
  messages_line_up: "session.line.up",
  messages_line_down: "session.line.down",
  messages_half_page_up: "session.half.page.up",
  messages_half_page_down: "session.half.page.down",
  messages_first: "session.first",
  messages_last: "session.last",
  messages_next: "session.message.next",
  messages_previous: "session.message.previous",
  messages_last_user: "session.messages_last_user",
  messages_copy: "messages.copy",
  messages_undo: "session.undo",
  messages_redo: "session.redo",
  messages_toggle_conceal: "session.toggle.conceal",
  tool_details: "session.toggle.actions",
  display_thinking: "session.toggle.thinking",
  prompt_submit: "prompt.submit",
  prompt_editor_context_clear: "prompt.editor_context.clear",
  prompt_skills: "prompt.skills",
  prompt_stash: "prompt.stash",
  prompt_stash_pop: "prompt.stash.pop",
  prompt_stash_list: "prompt.stash.list",
  workspace_set: "workspace.set",
  input_clear: "prompt.clear",
  input_paste: "prompt.paste",
  input_submit: "input.submit",
  input_newline: "input.newline",
  input_move_left: "input.move.left",
  input_move_right: "input.move.right",
  input_move_up: "input.move.up",
  input_move_down: "input.move.down",
  input_select_left: "input.select.left",
  input_select_right: "input.select.right",
  input_select_up: "input.select.up",
  input_select_down: "input.select.down",
  input_line_home: "input.line.home",
  input_line_end: "input.line.end",
  input_select_line_home: "input.select.line.home",
  input_select_line_end: "input.select.line.end",
  input_visual_line_home: "input.visual.line.home",
  input_visual_line_end: "input.visual.line.end",
  input_select_visual_line_home: "input.select.visual.line.home",
  input_select_visual_line_end: "input.select.visual.line.end",
  input_buffer_home: "input.buffer.home",
  input_buffer_end: "input.buffer.end",
  input_select_buffer_home: "input.select.buffer.home",
  input_select_buffer_end: "input.select.buffer.end",
  input_delete_line: "input.delete.line",
  input_delete_to_line_end: "input.delete.to.line.end",
  input_delete_to_line_start: "input.delete.to.line.start",
  input_backspace: "input.backspace",
  input_delete: "input.delete",
  input_undo: "input.undo",
  input_redo: "input.redo",
  input_word_forward: "input.word.forward",
  input_word_backward: "input.word.backward",
  input_select_word_forward: "input.select.word.forward",
  input_select_word_backward: "input.select.word.backward",
  input_delete_word_forward: "input.delete.word.forward",
  input_delete_word_backward: "input.delete.word.backward",
  input_select_all: "input.select.all",
  history_previous: "prompt.history.previous",
  history_next: "prompt.history.next",
  terminal_suspend: "terminal.suspend",
  terminal_title_toggle: "terminal.title.toggle",
  tips_toggle: "tips.toggle",
  plugin_manager: "plugins.list",
  plugin_install: "plugins.install",
  which_key_toggle: "which-key.toggle",
  which_key_layout_toggle: "which-key.layout.toggle",
  which_key_pending_toggle: "which-key.pending.toggle",
  which_key_group_previous: "which-key.group.previous",
  which_key_group_next: "which-key.group.next",
  which_key_scroll_up: "which-key.scroll.up",
  which_key_scroll_down: "which-key.scroll.down",
  which_key_page_up: "which-key.page.up",
  which_key_page_down: "which-key.page.down",
  which_key_home: "which-key.home",
  which_key_end: "which-key.end",
} satisfies BindingCommandMap
const CommandDescriptions = Object.fromEntries(
  Object.entries(Definitions).map(([name, item]) => [
    CommandMap[name as keyof typeof CommandMap] ?? name,
    item.description,
  ]),
) as Record<string, string>

export type Keybinds = { [K in KeybindName]: BindingValueSchema }
export type KeybindOverrides = Partial<Keybinds>
export type BindingLookupView = {
  readonly bindings: readonly Binding<Renderable, KeyEvent>[]
  get(command: string): readonly Binding<Renderable, KeyEvent>[]
  has(command: string): boolean
  gather(name: string, commands: readonly string[]): readonly Binding<Renderable, KeyEvent>[]
  pick(name: string, commands: readonly string[]): Binding<Renderable, KeyEvent>[]
  omit(name: string, commands: readonly string[]): Binding<Renderable, KeyEvent>[]
}

export function toBindingConfig(keybinds: Keybinds): BindingConfig<Renderable, KeyEvent> {
  return Object.fromEntries(Object.entries(keybinds)) as BindingConfig<Renderable, KeyEvent>
}

const decodeBindingValue = Schema.decodeUnknownSync(BindingValueSchema)

export function defaultValue(name: KeybindName) {
  return Definitions[name].default
}

export function parse(keybinds: KeybindOverrides): Keybinds {
  const invalid = unknownKeys(keybinds)
  if (invalid.length) throw new Error(`Танигдаагүй keybind${invalid.length === 1 ? "" : "-үүд"}: ${invalid.join(", ")}`)
  return Object.fromEntries(
    Object.entries(Definitions).map(([name, item]) => [
      name,
      decodeBindingValue(keybinds[name as KeybindName] ?? item.default),
    ]),
  ) as Keybinds
}

export const Keybinds = { parse }

export function unknownKeys(input: object) {
  return Object.keys(input).filter((key) => !KeybindNames.has(key))
}

export function bindingDefaults(): BindingDefaults<Renderable, KeyEvent> {
  return ({ command, binding }) => {
    if (binding.desc !== undefined) return
    return { desc: CommandDescriptions[command] }
  }
}
