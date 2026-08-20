// @refresh reload
import { mount, StartClient } from "@solidjs/start/client"

const root = document.getElementById("app")
if (!root) throw new Error("#app үндсэн элемент олдсонгүй")

mount(() => <StartClient />, root)
